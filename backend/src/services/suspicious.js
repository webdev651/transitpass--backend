'use strict';
/*
  Suspicious transaction monitoring. detect() reads recent scans and raises flags; every flag has a dedupe_key so running
  detection again never duplicates one. Rules (thresholds are in Settings -> Security monitoring):
    repeated_scan          one student scanned >= N times within M minutes
    duplicate_transaction  the same student scanned twice by the same driver within D seconds
    unusual_activity       one driver scanned >= B times within BM minutes, or scanned during off-hours
    multi_device           one driver account scanned from 2+ different devices within H hours
  Nothing is blocked automatically. An administrator reviews a flag (with an investigation note) FIRST; only a reviewed flag
  can be acted on (flag the student, deactivate their QR code, or deactivate the driver).
*/
const crypto = require('crypto');
const { notFound, conflict, badRequest } = require('../lib/httpError');
const { escapeLike } = require('../lib/sql');
const { toDate, localParts } = require('../lib/time');
const settings = require('./settings');
const students = require('./students');
const drivers = require('./drivers');

const TYPES = { repeated_scan: 'Repeated QR scans', duplicate_transaction: 'Duplicate transaction', unusual_activity: 'Unusual scanning activity', multi_device: 'Multiple devices on one driver account' };
const iso = (v) => (v ? toDate(v).toISOString() : null);
const pad = (n) => String(n).padStart(2, '0');

async function raise(pool, f) {
  const [res] = await pool.query(
    'INSERT IGNORE INTO suspicious_flags (flag_type, severity, student_id, driver_id, scan_id, summary, details, dedupe_key, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [f.type, f.severity, f.studentId || null, f.driverId || null, f.scanId || null, f.summary.slice(0, 255), JSON.stringify(f.details || {}), f.key.slice(0, 160), f.at || new Date()]);
  return res.affectedRows;
}

/** Looks back `hours` (default 24) and raises any flags not raised before. Returns how many NEW flags were created. */
async function detect(pool, { hours = 24, now = new Date() } = {}) {
  const cfg = {};
  for (const k of ['repeatCount', 'repeatMinutes', 'duplicateSeconds', 'burstCount', 'burstMinutes', 'offHoursStart', 'offHoursEnd', 'multiDeviceHours']) {
    cfg[k] = Number(await settings.get(pool, `suspicious.${k}`));
  }
  const since = new Date(now.getTime() - hours * 3600000);
  const [scans] = await pool.query(
    `SELECT id, student_id, student_name, school_id, scanned_by, driver_name, scanned_at, result, device_identifier FROM scans
      WHERE scanned_at >= ? ORDER BY scanned_at, id LIMIT 50000`, [since]);
  const made = { repeated_scan: 0, duplicate_transaction: 0, unusual_activity: 0, multi_device: 0 };
  const t = (r) => toDate(r.scanned_at).getTime();

  // repeated scans: sliding window per student
  const byStudent = new Map();
  scans.filter((s) => s.student_id).forEach((s) => { if (!byStudent.has(s.student_id)) byStudent.set(s.student_id, []); byStudent.get(s.student_id).push(s); });
  for (const [sid, list] of byStudent) {
    const w = cfg.repeatMinutes * 60000;
    for (let i = 0; i < list.length;) {
      let j = i;
      while (j + 1 < list.length && t(list[j + 1]) - t(list[i]) <= w) j++;
      const n = j - i + 1;
      if (n >= cfg.repeatCount) {
        made.repeated_scan += await raise(pool, {
          type: 'repeated_scan', severity: n >= cfg.repeatCount * 2 ? 'high' : 'medium', studentId: sid, scanId: list[j].id, key: `rep:${sid}:${list[i].id}`, at: toDate(list[j].scanned_at),
          summary: `${list[i].student_name || sid} was scanned ${n} times within ${cfg.repeatMinutes} minutes`, details: { count: n, windowMinutes: cfg.repeatMinutes, scanIds: list.slice(i, j + 1).map((x) => x.id) }
        });
        i = j + 1;
      } else i++;
    }
    // duplicate transactions: same student + same driver back to back
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]; const b = list[i];
      if (a.scanned_by && a.scanned_by === b.scanned_by && t(b) - t(a) <= cfg.duplicateSeconds * 1000 && a.result !== 'denied' && b.result !== 'denied') {
        made.duplicate_transaction += await raise(pool, {
          type: 'duplicate_transaction', severity: 'medium', studentId: sid, driverId: b.scanned_by, scanId: b.id, key: `dup:${b.id}`, at: toDate(b.scanned_at),
          summary: `${b.student_name || sid} was charged twice by ${b.driver_name || 'a driver'} within ${Math.round((t(b) - t(a)) / 1000)} seconds`, details: { scanIds: [a.id, b.id], seconds: Math.round((t(b) - t(a)) / 1000) }
        });
      }
    }
  }

  // per driver: bursts, off-hours, devices
  const byDriver = new Map();
  scans.filter((s) => s.scanned_by).forEach((s) => { if (!byDriver.has(s.scanned_by)) byDriver.set(s.scanned_by, []); byDriver.get(s.scanned_by).push(s); });
  // start === end is an empty window (used in tests / Settings to turn off-hours detection off).
  // Otherwise both ends are inclusive so 00:00–23:00 covers every hour of the day.
  const inOff = (h) => {
    const start = cfg.offHoursStart, end = cfg.offHoursEnd;
    if (start === end) return false;
    return start < end ? (h >= start && h <= end) : (h >= start || h <= end);
  };
  for (const [did, list] of byDriver) {
    const name = list[0].driver_name || `driver #${did}`;
    const w = cfg.burstMinutes * 60000;
    for (let i = 0; i < list.length;) {
      let j = i;
      while (j + 1 < list.length && t(list[j + 1]) - t(list[i]) <= w) j++;
      if (j - i + 1 >= cfg.burstCount) {
        made.unusual_activity += await raise(pool, {
          type: 'unusual_activity', severity: 'medium', driverId: did, scanId: list[j].id, key: `burst:${did}:${list[i].id}`, at: toDate(list[j].scanned_at),
          summary: `${name} scanned ${j - i + 1} passes within ${cfg.burstMinutes} minutes`, details: { count: j - i + 1, windowMinutes: cfg.burstMinutes, scanIds: list.slice(i, j + 1).map((x) => x.id).slice(0, 50) }
        });
        i = j + 1;
      } else i++;
    }
    const off = new Map();
    list.forEach((s) => { const p = localParts(toDate(s.scanned_at)); if (inOff(p.hour)) { const k = `${p.year}-${pad(p.month)}-${pad(p.day)}`; if (!off.has(k)) off.set(k, []); off.get(k).push(s); } });
    for (const [day, l] of off) {
      made.unusual_activity += await raise(pool, {
        type: 'unusual_activity', severity: 'low', driverId: did, scanId: l[0].id, key: `off:${did}:${day}`, at: toDate(l[0].scanned_at),
        summary: `${name} scanned ${l.length} pass(es) during off-hours (${pad(cfg.offHoursStart)}:00-${pad(cfg.offHoursEnd)}:00) on ${day}`, details: { day, count: l.length, scanIds: l.map((x) => x.id).slice(0, 50) }
      });
    }
    // several devices inside the configured window
    const w2 = cfg.multiDeviceHours * 3600000;
    const withDev = list.filter((s) => s.device_identifier);
    for (let i = 0; i < withDev.length; i++) {
      const set = new Set([withDev[i].device_identifier]);
      let j = i;
      while (j + 1 < withDev.length && t(withDev[j + 1]) - t(withDev[i]) <= w2) { j++; set.add(withDev[j].device_identifier); }
      if (set.size >= 2) {
        const ids = [...set].sort();
        const key = `multi:${did}:${crypto.createHash('md5').update(ids.join('|')).digest('hex').slice(0, 12)}:${toDate(withDev[i].scanned_at).toISOString().slice(0, 10)}`;
        made.multi_device += await raise(pool, {
          type: 'multi_device', severity: 'high', driverId: did, scanId: withDev[j].id, key, at: toDate(withDev[j].scanned_at),
          summary: `${name}'s account scanned from ${set.size} different devices within ${cfg.multiDeviceHours} hours`, details: { devices: ids, windowHours: cfg.multiDeviceHours }
        });
        break; // one flag per device set per day is enough
      }
    }
  }
  const total = Object.values(made).reduce((a, b) => a + b, 0);
  return { newFlags: total, byType: made, scansChecked: scans.length };
}

const item = (r) => ({
  id: r.id, type: r.flag_type, typeLabel: TYPES[r.flag_type], severity: r.severity, status: r.status, summary: r.summary, studentId: r.student_id, student: r.student_name || null,
  schoolId: r.school_id || null, driverId: r.driver_id, driver: r.driver_name || null, scanId: r.scan_id, detectedAt: iso(r.detected_at),
  reviewedBy: r.reviewed_by_name || null, reviewedAt: iso(r.reviewed_at), actionTaken: r.action_taken
});
const BASE = 'SELECT f.*, s.name AS student_name, s.school_id, a.name AS driver_name FROM suspicious_flags f LEFT JOIN students s ON s.id = f.student_id LEFT JOIN admins a ON a.id = f.driver_id';

async function list(pool, { status, type, severity, q, limit, offset }) {
  const where = [];
  const args = [];
  if (status && status !== 'all') { where.push('f.status = ?'); args.push(status); }
  if (type && type !== 'all') { where.push('f.flag_type = ?'); args.push(type); }
  if (severity && severity !== 'all') { where.push('f.severity = ?'); args.push(severity); }
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(f.summary LIKE ? OR s.name LIKE ? OR s.school_id LIKE ? OR a.name LIKE ?)'); args.push(like, like, like, like); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM suspicious_flags f LEFT JOIN students s ON s.id = f.student_id LEFT JOIN admins a ON a.id = f.driver_id ${clause}`, args);
  const [rows] = await pool.query(`${BASE} ${clause} ORDER BY (f.status = 'open') DESC, FIELD(f.severity, 'high', 'medium', 'low'), f.detected_at DESC, f.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const [[c]] = await pool.query("SELECT COALESCE(SUM(status = 'open'),0) AS open, COALESCE(SUM(status = 'reviewed'),0) AS reviewed, COALESCE(SUM(status = 'dismissed'),0) AS dismissed, COALESCE(SUM(status = 'actioned'),0) AS actioned FROM suspicious_flags");
  return { total: Number(total), items: rows.map(item), counts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])) };
}

async function getRow(db, id) {
  const [rows] = await db.query(`${BASE} WHERE f.id = ?`, [id]);
  if (!rows[0]) throw notFound('Flag not found');
  return rows[0];
}

/** Everything about one flag: the evidence (the scans involved) and the investigation notes. */
async function detail(pool, id) {
  const r = await getRow(pool, id);
  let details = {};
  try { details = JSON.parse(r.details || '{}'); } catch (_) { /* ignore */ }
  const ids = Array.isArray(details.scanIds) ? details.scanIds.slice(0, 50) : r.scan_id ? [r.scan_id] : [];
  const [scans] = ids.length ? await pool.query('SELECT id, student_name, school_id, driver_name, scanned_at, result, verification_result, scan_method, device_identifier, fare FROM scans WHERE id IN (?) ORDER BY scanned_at', [ids]) : [[]];
  const [notes] = await pool.query('SELECT * FROM suspicious_notes WHERE flag_id = ? ORDER BY created_at, id', [id]);
  return {
    flag: item(r), details,
    evidence: scans.map((s) => ({ id: s.id, student: s.student_name, schoolId: s.school_id, driver: s.driver_name, at: iso(s.scanned_at), result: s.result, code: s.verification_result, method: s.scan_method, device: s.device_identifier, fare: s.fare })),
    notes: notes.map((n) => ({ id: n.id, admin: n.admin_name, note: n.note, at: iso(n.created_at) }))
  };
}

async function addNote(pool, admin, id, note) {
  await getRow(pool, id);
  await pool.query('INSERT INTO suspicious_notes (flag_id, admin_id, admin_name, note) VALUES (?, ?, ?, ?)', [id, admin.id, admin.name, note]);
  return detail(pool, id);
}

/** Marks a flag reviewed (or dismissed as a false alarm). An investigation note is mandatory, so every review leaves a written trace. */
async function review(pool, admin, id, { decision, note }) {
  const r = await getRow(pool, id);
  if (r.status === 'actioned') throw conflict('Action was already taken on this flag.');
  await pool.query('INSERT INTO suspicious_notes (flag_id, admin_id, admin_name, note) VALUES (?, ?, ?, ?)', [id, admin.id, admin.name, note]);
  await pool.query('UPDATE suspicious_flags SET status = ?, reviewed_by = ?, reviewed_by_name = ?, reviewed_at = ? WHERE id = ?', [decision, admin.id, admin.name, new Date(), id]);
  return detail(pool, id);
}

const ACTIONS = { flag_student: 'Flagged the student for review', deactivate_qr: "Deactivated the student's QR code", deactivate_driver: 'Deactivated the driver account' };

async function takeAction(pool, admin, id, { action, note }) {
  const r = await getRow(pool, id);
  if (r.status !== 'reviewed') throw conflict('Review this flag and record your investigation notes before taking action.');
  if (action === 'deactivate_driver') {
    if (!r.driver_id) throw badRequest('This flag is not linked to a driver.');
    await drivers.act(pool, r.driver_id, 'deactivate');
  } else {
    if (!r.student_id) throw badRequest('This flag is not linked to a student.');
    await students.act(pool, r.student_id, action === 'flag_student' ? 'flag' : 'deactivate-qr', { reason: note }, admin);
  }
  await pool.query('INSERT INTO suspicious_notes (flag_id, admin_id, admin_name, note) VALUES (?, ?, ?, ?)', [id, admin.id, admin.name, `ACTION: ${ACTIONS[action]}. ${note}`]);
  await pool.query("UPDATE suspicious_flags SET status = 'actioned', action_taken = ? WHERE id = ?", [ACTIONS[action], id]);
  return detail(pool, id);
}

module.exports = { TYPES, ACTIONS, detect, list, detail, addNote, review, takeAction };
