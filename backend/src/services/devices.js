'use strict';
/*
  Driver device registration. A device identifies itself with the X-Device-Id header that the TransitPass web app sends
  (a random id created once per browser). An administrator registers it to a driver account; from then on it is "authorized".
  Enforcement is a setting (Settings -> Devices): OFF (default) only records activity and warns; ON refuses scanner requests
  from any device that is not active and linked to the signed-in driver.
*/
const { notFound, conflict, badRequest } = require('../lib/httpError');
const { escapeLike } = require('../lib/sql');
const { toDate } = require('../lib/time');
const settings = require('./settings');

const iso = (v) => (v ? toDate(v).toISOString() : null);
const ID_RE = /^[A-Za-z0-9._:-]{6,100}$/;

async function event(db, { deviceId = null, driverId = null, identifier = null, event: name, detail = null, adminName = null }) {
  try { await db.query('INSERT INTO device_events (device_id, driver_id, identifier, event, detail, admin_name) VALUES (?, ?, ?, ?, ?, ?)', [deviceId, driverId, identifier, name, detail ? String(detail).slice(0, 255) : null, adminName]); }
  catch (e) { console.error('[devices] could not log event:', e.message); }
}

const BASE = `SELECT d.*, a.name AS driver_name, a.status AS driver_status,
                     (SELECT COUNT(*) FROM scans s WHERE s.device_identifier = d.device_identifier) AS scan_count,
                     (SELECT COUNT(*) FROM scans s WHERE s.device_identifier = d.device_identifier AND s.scanned_at >= (UTC_TIMESTAMP(3) - INTERVAL 24 HOUR)) AS scans_24h
                FROM driver_devices d JOIN admins a ON a.id = d.driver_id`;
const present = (r) => ({
  id: r.id, driverId: r.driver_id, driver: r.driver_name, identifier: r.device_identifier, name: r.device_name, platform: r.platform, status: r.status,
  registeredBy: r.registered_by_name, registeredAt: iso(r.registered_at), lastSeenAt: iso(r.last_seen_at), lastSeenIp: r.last_seen_ip,
  scanCount: Number(r.scan_count || 0), scansLast24h: Number(r.scans_24h || 0)
});
async function getRow(db, id) {
  const [rows] = await db.query(`${BASE} WHERE d.id = ?`, [id]);
  if (!rows[0]) throw notFound('Device not found');
  return rows[0];
}

async function register(pool, admin, { driverId, identifier, name, platform }) {
  if (!ID_RE.test(identifier)) throw badRequest('The device identifier must be 6-100 letters, numbers or . _ : -');
  const [dr] = await pool.query("SELECT * FROM admins WHERE id = ? AND role = 'driver'", [driverId]);
  if (!dr[0]) throw notFound('Driver not found');
  if (dr[0].status !== 'active') throw conflict('Devices can only be linked to active driver accounts.');
  const [ex] = await pool.query('SELECT * FROM driver_devices WHERE device_identifier = ?', [identifier]);
  if (ex[0]) {
    if (ex[0].status !== 'removed') {
      const [o] = await pool.query('SELECT name FROM admins WHERE id = ?', [ex[0].driver_id]);
      throw conflict(`That device is already registered to ${o[0] ? o[0].name : 'another driver'} (${ex[0].status}). Remove it there first.`);
    }
    await pool.query("UPDATE driver_devices SET driver_id = ?, device_name = ?, platform = ?, status = 'active', registered_by = ?, registered_by_name = ?, registered_at = ? WHERE id = ?",
      [driverId, name, platform || null, admin.id, admin.name, new Date(), ex[0].id]);
    await event(pool, { deviceId: ex[0].id, driverId, identifier, event: 'relinked', detail: `Linked again to ${dr[0].name}`, adminName: admin.name });
    return present(await getRow(pool, ex[0].id));
  }
  const [res] = await pool.query('INSERT INTO driver_devices (driver_id, device_identifier, device_name, platform, registered_by, registered_by_name) VALUES (?, ?, ?, ?, ?, ?)',
    [driverId, identifier, name, platform || null, admin.id, admin.name]);
  await event(pool, { deviceId: res.insertId, driverId, identifier, event: 'registered', detail: `Registered to ${dr[0].name}`, adminName: admin.name });
  return present(await getRow(pool, res.insertId));
}

async function list(pool, { driverId, status, q, limit, offset }) {
  const where = [];
  const args = [];
  if (driverId) { where.push('d.driver_id = ?'); args.push(driverId); }
  if (status && status !== 'all') { where.push('d.status = ?'); args.push(status); } else where.push("d.status <> 'removed'");
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(d.device_name LIKE ? OR d.device_identifier LIKE ? OR a.name LIKE ?)'); args.push(like, like, like); }
  const clause = `WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM driver_devices d JOIN admins a ON a.id = d.driver_id ${clause}`, args);
  const [rows] = await pool.query(`${BASE} ${clause} ORDER BY d.last_seen_at IS NULL, d.last_seen_at DESC, d.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { total: Number(total), items: rows.map(present) };
}

async function setStatus(pool, admin, id, status) {
  const d = await getRow(pool, id);
  if (d.status === 'removed') throw conflict('This device was removed. Register it again to use it.');
  if (d.status === status) throw conflict(`This device is already ${status}.`);
  await pool.query('UPDATE driver_devices SET status = ? WHERE id = ?', [status, id]);
  await event(pool, { deviceId: id, driverId: d.driver_id, identifier: d.device_identifier, event: status === 'active' ? 'activated' : 'deactivated', adminName: admin.name });
  return present(await getRow(pool, id));
}

/** "Remove unauthorized device": the row is kept (status removed) so the history stays complete. */
async function remove(pool, admin, id, reason) {
  const d = await getRow(pool, id);
  if (d.status === 'removed') throw conflict('This device was already removed.');
  await pool.query("UPDATE driver_devices SET status = 'removed' WHERE id = ?", [id]);
  await event(pool, { deviceId: id, driverId: d.driver_id, identifier: d.device_identifier, event: 'removed', detail: reason, adminName: admin.name });
  return present(await getRow(pool, id));
}

async function history(pool, { deviceId, driverId, limit, offset }) {
  const where = [];
  const args = [];
  if (deviceId) { where.push('e.device_id = ?'); args.push(deviceId); }
  if (driverId) { where.push('e.driver_id = ?'); args.push(driverId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM device_events e ${clause}`, args);
  const [rows] = await pool.query(
    `SELECT e.*, a.name AS driver_name, d.device_name FROM device_events e LEFT JOIN admins a ON a.id = e.driver_id LEFT JOIN driver_devices d ON d.id = e.device_id ${clause}
      ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { total: Number(total), items: rows.map((r) => ({ id: r.id, event: r.event, detail: r.detail, identifier: r.identifier, device: r.device_name || null, driver: r.driver_name || null, driverId: r.driver_id, by: r.admin_name || 'System', at: iso(r.created_at) })) };
}

/** Devices that scanned but are not registered to the driver who used them (candidates to register, or to investigate). */
async function unregisteredActivity(pool, hours = 72) {
  const [rows] = await pool.query(
    `SELECT s.device_identifier AS identifier, s.scanned_by AS driver_id, a.name AS driver_name, COUNT(*) AS scans, MAX(s.scanned_at) AS last_seen
       FROM scans s JOIN admins a ON a.id = s.scanned_by
      WHERE s.device_identifier IS NOT NULL AND s.scanned_at >= (UTC_TIMESTAMP(3) - INTERVAL ? HOUR)
        AND NOT EXISTS (SELECT 1 FROM driver_devices d WHERE d.device_identifier = s.device_identifier AND d.driver_id = s.scanned_by AND d.status = 'active')
      GROUP BY s.device_identifier, s.scanned_by, a.name ORDER BY last_seen DESC LIMIT 50`, [hours]);
  const [blocked] = await pool.query(
    `SELECT e.identifier, e.driver_id, a.name AS driver_name, COUNT(*) AS attempts, MAX(e.created_at) AS last_seen FROM device_events e LEFT JOIN admins a ON a.id = e.driver_id
      WHERE e.event = 'blocked' AND e.created_at >= (UTC_TIMESTAMP(3) - INTERVAL ? HOUR) GROUP BY e.identifier, e.driver_id, a.name ORDER BY last_seen DESC LIMIT 50`, [hours]);
  return {
    hours,
    unregistered: rows.map((r) => ({ identifier: r.identifier, driverId: r.driver_id, driver: r.driver_name, scans: Number(r.scans), lastSeenAt: iso(r.last_seen) })),
    blocked: blocked.map((r) => ({ identifier: r.identifier, driverId: r.driver_id, driver: r.driver_name, attempts: Number(r.attempts), lastSeenAt: iso(r.last_seen) }))
  };
}

async function summary(pool) {
  const [[s]] = await pool.query("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'inactive'), 0) AS inactive FROM driver_devices WHERE status <> 'removed'");
  const [[u]] = await pool.query("SELECT COUNT(DISTINCT device_identifier) AS n FROM scans s WHERE device_identifier IS NOT NULL AND scanned_at >= (UTC_TIMESTAMP(3) - INTERVAL 72 HOUR) AND NOT EXISTS (SELECT 1 FROM driver_devices d WHERE d.device_identifier = s.device_identifier AND d.driver_id = s.scanned_by AND d.status = 'active')");
  return { total: Number(s.total), active: Number(s.active), inactive: Number(s.inactive), unregisteredSeen: Number(u.n), enforcement: await settings.get(pool, 'devices.enforce') };
}

/** Scanner middleware (drivers only). Always records which device scanned; refuses unauthorized devices only when enforcement is on. */
const gate = (pool) => async (req, res, next) => {
  const admin = req.admin;
  if (!admin || admin.role !== 'driver') return next();
  const raw = req.get('x-device-id');
  const id = raw && ID_RE.test(raw) ? raw : null;
  if (id) admin.deviceIdentifier = id;
  const enforce = await settings.get(pool, 'devices.enforce');
  let dev = null;
  if (id) { const [rows] = await pool.query('SELECT * FROM driver_devices WHERE device_identifier = ?', [id]); dev = rows[0] || null; }
  const authorized = !!dev && dev.driver_id === admin.id && dev.status === 'active';
  if (authorized) {
    await pool.query('UPDATE driver_devices SET last_seen_at = ?, last_seen_ip = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)', [new Date(), (req.ip || '').slice(0, 45), dev.id, new Date(Date.now() - 30000)]);
    return next();
  }
  // Not authorized: leave a trace (at most one per device and hour, so a busy driver does not flood the log).
  const kind = enforce ? 'blocked' : 'unregistered_use';
  const [recent] = await pool.query('SELECT 1 FROM device_events WHERE event = ? AND driver_id = ? AND identifier <=> ? AND created_at >= ? LIMIT 1', [kind, admin.id, id, new Date(Date.now() - 3600000)]);
  if (!recent.length) await event(pool, { deviceId: dev ? dev.id : null, driverId: admin.id, identifier: id, event: kind, detail: id ? (dev ? `Device is ${dev.status}${dev.driver_id !== admin.id ? ' and linked to another driver' : ''}` : 'Device is not registered') : 'The request carried no device id' });
  if (enforce) return res.status(403).json({ error: 'This device is not authorized for your account. Ask the administrator to register it.', code: 'DEVICE_NOT_AUTHORIZED' });
  next();
};

module.exports = { ID_RE, register, list, setStatus, remove, history, unregisteredActivity, summary, gate };
