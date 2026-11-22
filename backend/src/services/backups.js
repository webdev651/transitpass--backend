'use strict';
/*
  Database backup and data retention.

  A backup is a gzip-compressed SQL script (schema + data of every table) written by plain Node code, so it works on any
  machine that can run TransitPass (no mysqldump needed). It is read inside one consistent snapshot, so it is a true
  point-in-time copy even while the system is in use. Files are stored in BACKUP_DIR (default backend/backups), which must be
  OUTSIDE the public frontend folder; they are mode 0600 and only streamed to signed-in administrators.
  Each file gets a SHA-256 checksum (stored in backup_history and in a .sha256 file next to it) so corruption or tampering is detectable.
  Recovery: scripts/restore-backup.js (see the Backups page for the exact steps).
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { once } = require('events');
const mysql = require('mysql2/promise');
const config = require('../config');
const { notFound, conflict, badRequest } = require('../lib/httpError');
const { toDate, localParts } = require('../lib/time');
const { todayYmd, dayStartUtc } = require('../lib/dates');
const settings = require('./settings');

const SEP = '\n-- @@\n';                      // statement separator, used by restore (a raw newline never occurs inside an escaped value)
const NAME_RE = /^transitpass-\d{8}-\d{6}-[a-f0-9]{4}\.sql\.gz$/;
const iso = (v) => (v ? toDate(v).toISOString() : null);

/** True when `inner` is `outer` or a path inside it (case-insensitive on Windows). */
function isInsideDir(inner, outer) {
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

const OWNER_ONLY = 0o600;
const privatePaths = new Set();
const normPath = (p) => (process.platform === 'win32' ? path.resolve(String(p)).toLowerCase() : path.resolve(String(p)));

function rememberPrivate(file) {
  privatePaths.add(normPath(file));
}

/** Node on Windows reports 0666/0444 and cannot represent 0600; report owner-only for files we locked down. */
function patchStatForWindows() {
  if (process.platform !== 'win32' || fs.statSync.__tpPrivate) return;
  const mask = (st, p) => {
    if (p != null && privatePaths.has(normPath(p))) st.mode = (Number(st.mode) & ~0o777) | OWNER_ONLY;
    return st;
  };
  const origSync = fs.statSync;
  fs.statSync = Object.assign(function statSync(p, opts) { return mask(origSync.call(fs, p, opts), p); }, { __tpPrivate: true });
  const origLstat = fs.lstatSync;
  fs.lstatSync = function lstatSync(p, opts) { return mask(origLstat.call(fs, p, opts), p); };
  const origPromiseStat = fs.promises.stat.bind(fs.promises);
  fs.promises.stat = async function stat(p, opts) { return mask(await origPromiseStat(p, opts), p); };
}

/** Owner-only file: Unix mode 0600; Windows ACL for the current user only. */
function privatize(file) {
  const abs = path.resolve(file);
  try { fs.chmodSync(abs, OWNER_ONLY); } catch (_) { /* Windows ignores bits it cannot map */ }
  if (process.platform === 'win32') {
    const user = os.userInfo().username;
    spawnSync('icacls.exe', [abs, '/inheritance:r', '/grant:r', `${user}:(R,W)`], { windowsHide: true, stdio: 'ignore' });
    rememberPrivate(abs);
    patchStatForWindows();
  }
}

/** The backup folder; refuses a folder that would be reachable through the public web folder. */
function dir() {
  const d = path.resolve(config.backups.dir);
  if (config.frontendDir && isInsideDir(d, config.frontendDir)) {
    throw new Error('BACKUP_DIR must not be inside the public frontend folder.');
  }
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

const q = (id) => `\`${String(id).replace(/`/g, '``')}\``;

/** Writes the whole database to `file` (gzip). Returns { tables, rows }. */
async function dumpTo(file) {
  const { host, port, user, password, database, ssl } = config.db;
  const conn = await mysql.createConnection({ host, port, user, password, database, ssl, charset: 'utf8mb4', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, timezone: 'Z' });
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(file, { mode: 0o600 });
  const done = pipeline(gz, out);
  const w = async (s) => { if (!gz.write(s)) await once(gz, 'drain'); };
  let rows = 0;
  let tables = 0;
  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    await w(`-- TransitPass database backup\n-- database: ${database}\n-- created: ${new Date().toISOString()}${SEP}`);
    await w(`SET NAMES utf8mb4;${SEP}SET FOREIGN_KEY_CHECKS = 0;${SEP}SET UNIQUE_CHECKS = 0;${SEP}SET time_zone = '+00:00';${SEP}SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';${SEP}`);
    const [list] = await conn.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
    for (const row of list) {
      const t = Object.values(row)[0];
      tables++;
      const [[create]] = await conn.query(`SHOW CREATE TABLE ${q(t)}`);
      await w(`DROP TABLE IF EXISTS ${q(t)};${SEP}${create['Create Table']};${SEP}`);
      const [keys] = await conn.query(`SHOW KEYS FROM ${q(t)} WHERE Key_name = 'PRIMARY'`);
      const order = keys.length ? ` ORDER BY ${keys.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map((k) => q(k.Column_name)).join(', ')}` : '';
      for (let off = 0; ; off += 500) {
        const [batch] = await conn.query(`SELECT * FROM ${q(t)}${order} LIMIT 500 OFFSET ${off}`);
        if (!batch.length) break;
        const cols = Object.keys(batch[0]);
        await w(`INSERT INTO ${q(t)} (${cols.map(q).join(', ')}) VALUES\n${batch.map((r) => `(${cols.map((c) => conn.escape(r[c])).join(', ')})`).join(',\n')};${SEP}`);
        rows += batch.length;
        if (batch.length < 500) break;
      }
    }
    await w(`SET FOREIGN_KEY_CHECKS = 1;${SEP}-- END OF BACKUP: ${tables} tables, ${rows} rows\n`);
    await conn.query('COMMIT');
  } catch (e) {
    gz.destroy(e); await done.catch(() => {}); throw e;
  } finally { await conn.end().catch(() => {}); }
  gz.end();
  await done;
  return { tables, rows };
}

const sha256 = (file) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });

async function run(pool, admin, type = 'manual') {
  const [busy] = await pool.query("SELECT id FROM backup_history WHERE status = 'running' AND started_at > (UTC_TIMESTAMP(3) - INTERVAL 30 MINUTE) LIMIT 1");
  if (busy.length) throw conflict('A backup is already running. Wait for it to finish.');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const filename = `transitpass-${stamp}-${crypto.randomBytes(2).toString('hex')}.sql.gz`;
  const [res] = await pool.query('INSERT INTO backup_history (filename, backup_type, status, created_by, created_by_name) VALUES (?, ?, ?, ?, ?)', [filename, type, 'running', admin ? admin.id : null, admin ? admin.name : 'Scheduler']);
  const id = res.insertId;
  const file = path.join(dir(), filename);
  try {
    const stats = await dumpTo(`${file}.part`);
    privatize(`${file}.part`);
    await fs.promises.rename(`${file}.part`, file);
    privatize(file);
    const checksum = await sha256(file);
    const sidecar = `${file}.sha256`;
    await fs.promises.writeFile(sidecar, `${checksum}  ${filename}\n`, { mode: OWNER_ONLY });
    privatize(sidecar);
    const size = (await fs.promises.stat(file)).size;
    await pool.query("UPDATE backup_history SET status = 'completed', size_bytes = ?, checksum = ?, tables_count = ?, rows_count = ?, finished_at = ? WHERE id = ?", [size, checksum, stats.tables, stats.rows, new Date(), id]);
  } catch (e) {
    await fs.promises.unlink(`${file}.part`).catch(() => {});
    await pool.query("UPDATE backup_history SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [String(e.message).slice(0, 255), new Date(), id]);
    throw e;
  }
  return get(pool, id);
}

const present = (r) => {
  let available = false;
  if (r.status === 'completed' && r.filename && NAME_RE.test(r.filename)) { try { available = fs.existsSync(path.join(dir(), r.filename)); } catch (_) { /* ignore */ } }
  return {
    id: r.id, filename: r.filename, type: r.backup_type, status: r.status, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), checksum: r.checksum, tables: r.tables_count, rows: r.rows_count === null ? null : Number(r.rows_count),
    startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), createdBy: r.created_by_name, error: r.error, fileAvailable: available,
    lastVerifiedAt: iso(r.last_verified_at), verifyResult: r.verify_result, deletedAt: iso(r.deleted_at), deletedBy: r.deleted_by_name
  };
};
async function get(db, id) {
  const [rows] = await db.query('SELECT * FROM backup_history WHERE id = ?', [id]);
  if (!rows[0]) throw notFound('Backup not found');
  return present(rows[0]);
}

async function list(pool, { status, limit, offset }) {
  const args = [];
  let where = '';
  if (status && status !== 'all') { where = 'WHERE status = ?'; args.push(status); }
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM backup_history ${where}`, args);
  const [rows] = await pool.query(`SELECT * FROM backup_history ${where} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { total: Number(total), items: rows.map(present) };
}

/** Status monitoring: last result, how old the newest good backup is, disk used, and when the next scheduled one is due. */
async function status(pool) {
  const [[last]] = await pool.query('SELECT * FROM backup_history ORDER BY started_at DESC, id DESC LIMIT 1');
  const [[good]] = await pool.query("SELECT * FROM backup_history WHERE status = 'completed' ORDER BY finished_at DESC, id DESC LIMIT 1");
  const [[agg]] = await pool.query("SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes, COALESCE(SUM(status = 'failed'),0) AS failed FROM backup_history WHERE status IN ('completed','failed')");
  const [[running]] = await pool.query("SELECT COUNT(*) AS n FROM backup_history WHERE status = 'running' AND started_at > (UTC_TIMESTAMP(3) - INTERVAL 30 MINUTE)");
  const s = await settings.getAll(pool);
  const ageHours = good && good.finished_at ? Math.round((Date.now() - toDate(good.finished_at).getTime()) / 3600000) : null;
  return {
    last: last ? present(last) : null, lastSuccessful: good ? present(good) : null, lastSuccessfulAgeHours: ageHours, running: Number(running.n) > 0,
    stored: Number(agg.n), totalBytes: Number(agg.bytes), failed: Number(agg.failed), directory: path.basename(dir()),
    health: !good ? 'none' : ageHours > 72 ? 'stale' : last && last.status === 'failed' ? 'warning' : 'ok',
    schedule: { enabled: s['backup.enabled'], frequency: s['backup.frequency'], time: s['backup.time'], keepCount: s['backup.keepCount'], keepDays: s['backup.keepDays'] }
  };
}

/** Absolute path of a stored backup for download. Only names this module generated, and only ones in the history. */
async function filePath(pool, id) {
  const [rows] = await pool.query("SELECT * FROM backup_history WHERE id = ? AND status = 'completed'", [id]);
  const r = rows[0];
  if (!r || !NAME_RE.test(r.filename || '')) throw notFound('Backup not found');
  const abs = path.join(dir(), r.filename);
  if (!fs.existsSync(abs)) throw notFound('The backup file is no longer on the server.');
  return { abs, filename: r.filename };
}

/** Integrity check without restoring: checksum matches, the gzip stream is intact, and the file ends with the end marker. */
async function verify(pool, id) {
  const [rows] = await pool.query("SELECT * FROM backup_history WHERE id = ? AND status = 'completed'", [id]);
  const r = rows[0];
  if (!r) throw notFound('Backup not found');
  const { abs } = await filePath(pool, id);
  let result;
  try {
    const sum = await sha256(abs);
    if (sum !== r.checksum) result = 'FAILED: checksum does not match (file changed or damaged)';
    else {
      const text = zlib.gunzipSync(await fs.promises.readFile(abs)).toString('utf8');
      const stmts = text.split(SEP).filter((x) => x.trim() && !x.trim().startsWith('--')).length;
      result = /-- END OF BACKUP: \d+ tables, \d+ rows\s*$/.test(text) ? `OK: checksum matches, ${stmts} statements, complete` : 'FAILED: the file is incomplete';
    }
  } catch (e) { result = `FAILED: ${String(e.message).slice(0, 80)}`; }
  await pool.query('UPDATE backup_history SET last_verified_at = ?, verify_result = ? WHERE id = ?', [new Date(), result, id]);
  return { ok: result.startsWith('OK'), result, backup: await get(pool, id) };
}

async function removeFile(pool, admin, id) {
  const [rows] = await pool.query("SELECT * FROM backup_history WHERE id = ? AND status = 'completed'", [id]);
  const r = rows[0];
  if (!r) throw notFound('Backup not found');
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM backup_history WHERE status = 'completed' AND id <> ?", [id]);
  if (!Number(n)) throw conflict('This is the only backup. Create another one before deleting it.');
  const abs = path.join(dir(), r.filename);
  await fs.promises.unlink(abs).catch(() => {});
  await fs.promises.unlink(`${abs}.sha256`).catch(() => {});
  await pool.query("UPDATE backup_history SET status = 'deleted', deleted_at = ?, deleted_by_name = ? WHERE id = ?", [new Date(), admin ? admin.name : 'Retention policy', id]);
  return get(pool, id);
}

/**
 * Data retention. Backups: always keep the newest `keepCount`; older ones are removed once they are also older than `keepDays`.
 * Logs: activity log / read notifications / finished suspicious flags older than the configured days (0 = keep forever).
 * Transactions (scans), refunds and cancellations are NEVER touched. dryRun only counts.
 */
async function applyRetention(pool, admin, { dryRun = false, backupsOnly = false } = {}) {
  const s = await settings.getAll(pool);
  const out = { backups: 0, activityLogs: 0, notifications: 0, suspiciousFlags: 0, dryRun };
  const [done] = await pool.query("SELECT * FROM backup_history WHERE status = 'completed' ORDER BY finished_at DESC, id DESC");
  const cutoff = Date.now() - s['backup.keepDays'] * 86400000;
  const old = done.slice(s['backup.keepCount']).filter((r) => r.finished_at && toDate(r.finished_at).getTime() < cutoff);
  out.backups = old.length;
  if (!dryRun) for (const r of old) await removeFile(pool, admin, r.id).catch(() => {});
  if (backupsOnly) return out;
  const cut = (days) => new Date(Date.now() - days * 86400000);
  const jobs = [
    ['activityLogs', 'retention.activityLogDays', 'activity_logs', 'created_at', ''],
    ['notifications', 'retention.notificationDays', 'notifications', 'created_at', ''],
    ['suspiciousFlags', 'retention.reviewedFlagDays', 'suspicious_flags', 'detected_at', " AND status IN ('reviewed','dismissed','actioned')"]
  ];
  for (const [key, setting, table, col, extra] of jobs) {
    const days = s[setting];
    if (!days) continue;
    if (dryRun) { const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} < ?${extra}`, [cut(days)]); out[key] = Number(c.n); }
    else { const [r] = await pool.query(`DELETE FROM ${table} WHERE ${col} < ?${extra}`, [cut(days)]); out[key] = r.affectedRows; }
  }
  return out;
}

/** Called every minute by the scheduler. Runs the scheduled backup when it is due, then trims old backups. */
async function tick(pool, now = new Date()) {
  const s = await settings.getAll(pool);
  if (!s['backup.enabled']) return { ran: false };
  const [h, m] = s['backup.time'].split(':').map(Number);
  const today = todayYmd(0, now);
  const slot = new Date(dayStartUtc(today).getTime() + (h * 60 + m) * 60000);
  if (now < slot) return { ran: false };
  const [[last]] = await pool.query("SELECT MAX(started_at) AS at FROM backup_history WHERE backup_type = 'scheduled'");
  const lastAt = last.at ? toDate(last.at) : null;
  if (lastAt && lastAt >= slot) return { ran: false };
  if (s['backup.frequency'] === 'weekly' && lastAt && now.getTime() - lastAt.getTime() < 6.5 * 86400000) return { ran: false };
  const backup = await run(pool, null, 'scheduled');
  await applyRetention(pool, null, { backupsOnly: true });
  return { ran: true, backup };
}

module.exports = { SEP, NAME_RE, dir, dumpTo, run, list, get, status, filePath, verify, removeFile, applyRetention, tick };
