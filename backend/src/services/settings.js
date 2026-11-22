'use strict';
/*
  System settings: one row per key in system_settings (JSON text). Every key has a default and a validator, so the app
  works with an empty table and a bad value can never be stored. Reads are cached for a few seconds.
*/
const os = require('os');
const { z } = require('zod');
const config = require('../config');
const { badRequest } = require('../lib/httpError');
const uploads = require('../lib/uploads');
const pkg = require('../../package.json');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the time format HH:MM (24-hour)');
const days = (min = 0, max = 3650) => z.number().int().min(min).max(max);
const retentionDays = z.number().int().refine((n) => n === 0 || (n >= 30 && n <= 3650), 'Use 0 (keep forever) or at least 30 days');

// key -> [default, validator]
const DEFS = {
  'system.name': ['TransitPass', z.string().trim().min(1).max(60)],
  'system.organization': ['', z.string().trim().max(120)],
  'system.contactEmail': ['', z.string().trim().max(190).refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email address')],
  'system.logo': ['', z.string().max(400000)],
  'session.idleMinutes': [30, z.number().int().min(5).max(240)],
  'notifications.accountStatus': [true, z.boolean()],
  'notifications.announcements': [true, z.boolean()],
  'notifications.eligibilityDays': [30, days(1, 120)],
  'notifications.qrDays': [7, days(1, 60)],
  'maintenance.enabled': [false, z.boolean()],
  'maintenance.message': ['TransitPass is undergoing scheduled maintenance. Please try again shortly.', z.string().trim().min(1).max(300)],
  'maintenance.window': ['', z.string().trim().max(160)],
  'backup.enabled': [false, z.boolean()],
  'backup.frequency': ['daily', z.enum(['daily', 'weekly'])],
  'backup.time': ['02:00', hhmm],
  'backup.keepCount': [14, days(1, 365)],
  'backup.keepDays': [30, days(1, 3650)],
  'retention.activityLogDays': [0, retentionDays],
  'retention.notificationDays': [0, retentionDays],
  'retention.reviewedFlagDays': [0, retentionDays],
  'devices.enforce': [false, z.boolean()],
  'suspicious.repeatCount': [3, days(2, 50)],
  'suspicious.repeatMinutes': [10, days(1, 240)],
  'suspicious.duplicateSeconds': [60, days(5, 3600)],
  'suspicious.burstCount': [15, days(3, 500)],
  'suspicious.burstMinutes': [5, days(1, 120)],
  'suspicious.offHoursStart': [23, days(0, 23)],
  'suspicious.offHoursEnd': [4, days(0, 23)],
  'suspicious.multiDeviceHours': [4, days(1, 72)]
};
const KEYS = Object.keys(DEFS);
const defaults = () => Object.fromEntries(KEYS.map((k) => [k, DEFS[k][0]]));

const cache = new Map();           // pool -> { at, values }
const TTL_MS = 10_000;
const clearCache = () => cache.clear();

async function load(pool) {
  const hit = cache.get(pool);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.values;
  const [rows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
  const values = defaults();
  for (const r of rows) {
    if (!DEFS[r.setting_key]) continue;
    try { const v = JSON.parse(r.setting_value); if (DEFS[r.setting_key][1].safeParse(v).success) values[r.setting_key] = v; } catch (_) { /* keep the default */ }
  }
  cache.set(pool, { at: Date.now(), values });
  return values;
}

const get = async (pool, key) => (await load(pool))[key];
/** Everything except the logo image itself (it can be large): the settings screen asks for it separately. */
async function getAll(pool) { const v = { ...(await load(pool)) }; v['system.hasLogo'] = !!v['system.logo']; delete v['system.logo']; return v; }

async function update(pool, admin, patch) {
  const entries = Object.entries(patch || {});
  if (!entries.length) throw badRequest('Nothing to update');
  const clean = [];
  const problems = [];
  for (const [k, v] of entries) {
    if (!DEFS[k] || k === 'system.logo') { problems.push({ path: k, message: `Unknown setting: ${k}` }); continue; }
    const r = DEFS[k][1].safeParse(v);
    if (!r.success) problems.push({ path: k, message: r.error.issues[0].message });
    else clean.push([k, r.data]);
  }
  if (problems.length) throw badRequest('Validation failed', problems);
  for (const [k, v] of clean) {
    await pool.query(
      'INSERT INTO system_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)',
      [k, JSON.stringify(v), admin.id]);
  }
  clearCache();
  return { changed: clean.map(([k]) => k) };
}

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
async function setLogo(pool, admin, file) {
  if (!file) throw badRequest('Choose a logo image.');
  const type = uploads.sniff(file.buffer);
  if (!MIME[type]) throw badRequest('The logo must be a PNG, JPG or WEBP image.');
  if (file.buffer.length > 250 * 1024) throw badRequest('The logo must be under 250 KB.');
  await pool.query(
    "INSERT INTO system_settings (setting_key, setting_value, updated_by) VALUES ('system.logo', ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)",
    [JSON.stringify(`data:${MIME[type]};base64,${file.buffer.toString('base64')}`), admin.id]);
  clearCache();
}
async function clearLogo(pool) { await pool.query("DELETE FROM system_settings WHERE setting_key = 'system.logo'"); clearCache(); }

/** What every administrator page needs on load: branding, idle timeout, maintenance banner. */
async function runtime(pool) {
  const v = await load(pool);
  return { name: v['system.name'], logo: v['system.logo'] || null, idleMinutes: v['session.idleMinutes'], maintenance: { enabled: v['maintenance.enabled'], message: v['maintenance.message'], window: v['maintenance.window'] } };
}

async function systemInfo(pool) {
  const [[db]] = await pool.query('SELECT VERSION() AS version, NOW() AS now');
  const [[counts]] = await pool.query(
    "SELECT (SELECT COUNT(*) FROM students) AS students, (SELECT COUNT(*) FROM admins WHERE role = 'driver') AS drivers, (SELECT COUNT(*) FROM scans) AS scans");
  return {
    application: `${pkg.name} ${pkg.version}`, node: process.version, platform: `${os.type()} ${os.release()}`, environment: config.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()), database: db.version, timezone: config.timezone, emailMode: config.email.mode, serverTime: new Date().toISOString(),
    counts: { students: Number(counts.students), drivers: Number(counts.drivers), scans: Number(counts.scans) }
  };
}

/** Express gate: while maintenance mode is on, students and drivers get 503 + the message. Administrators are never blocked. */
const maintenanceGate = (pool) => async (req, res, next) => {
  if (req.admin && req.admin.role === 'admin') return next();
  const v = await load(pool);
  if (!v['maintenance.enabled']) return next();
  res.status(503).json({ error: v['maintenance.message'], maintenance: true });
};

module.exports = { DEFS, KEYS, defaults, get, getAll, update, setLogo, clearLogo, runtime, systemInfo, maintenanceGate, clearCache };
