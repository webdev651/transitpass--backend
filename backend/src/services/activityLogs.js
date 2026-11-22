'use strict';
/*
  Activity Log Management (read only). Everything shown here already exists:
   - activity_logs                      what staff did, every sign-in / failed sign-in, every change an administrator made
   - students / qr_codes / admins / scans   what happened without an administrator (online registrations, students generating a QR,
                                        drivers registering, and every QR scan / transaction)
  Nothing is copied or stored again and nothing here can change a log: this module only SELECTs. The rows of all sources are merged by one
  UNION query so search, filters and paging are done by the database, not in memory.

  "Type" (what the filter offers) is derived from the log's action first, so rows written before this module existed are grouped correctly:
    fare.*  -> fare,  transaction.*  -> transaction,  refund.*  -> refund,  report.* / activitylog.* -> report,  otherwise the log's own category.
*/
const { toDate, displayParts, localParts } = require('../lib/time');
const { dayStartUtc } = require('../lib/dates');
const { txnReference } = require('../lib/studentStatus');
const { escapeLike } = require('../lib/sql');
const { notFound } = require('../lib/httpError');
const csv = require('../lib/csv');

const REPORT_MAX = 5000;
const EXPORT_MAX = 50000;

const TYPES = {
  auth: 'Sign-in / sign-out', student: 'Student', verification: 'Verification', qr: 'QR code', driver: 'Driver', fare: 'Fare & discount',
  transaction: 'Transaction', refund: 'Refund', account: 'Profile / account', report: 'Report', vehicle: 'Vehicle', route: 'Route', trip: 'Trip',
  device: 'Device', announcement: 'Announcement', notification: 'Notification', settings: 'Settings', backup: 'Backup', security: 'Security', system: 'System'
};
const STATUS_LABEL = { success: 'Success', failed: 'Failed' };

// the type of an activity_logs row (see the comment above)
const LOG_TYPE = `CASE WHEN a.action LIKE 'fare.%' THEN 'fare' WHEN a.action LIKE 'transaction.%' THEN 'transaction' WHEN a.action LIKE 'refund.%' THEN 'refund'
  WHEN a.action LIKE 'report.%' OR a.action LIKE 'activitylog.%' THEN 'report' ELSE a.category END`;

// Every text column of every branch is given the tables' own collation, otherwise MySQL refuses to UNION literals with columns ("Illegal mix of collations").
const CI = 'COLLATE utf8mb4_unicode_ci';
/** One SELECT per source; every one returns the same columns, in the same order. */
const pick = (c) => `SELECT ${c.uid} ${CI} AS uid, ${c.at} AS at, ${c.type} ${CI} AS type, ${c.action} ${CI} AS action, ${c.description} ${CI} AS description, ${c.user} ${CI} AS user,
    ${c.role} ${CI} AS role, ${c.status} ${CI} AS status, ${c.ip} ${CI} AS ip, CAST(${c.target} AS CHAR) ${CI} AS target`;
const BRANCHES = [
  { key: 'log', idCol: 'a.id', time: 'a.created_at',
    sql: `${pick({ uid: "CONCAT('log-', a.id)", at: 'a.created_at', type: LOG_TYPE, action: 'a.action', description: 'a.description', user: 'a.actor_name', role: 'a.actor_role', status: 'a.status', ip: 'a.ip_address', target: 'a.target_id' })} FROM activity_logs a` },
  { key: 'reg', idCol: 's.id', time: 's.created_at', where: 's.password_hash IS NOT NULL',
    sql: `${pick({ uid: "CONCAT('reg-', s.id)", at: 's.created_at', type: "'student'", action: "'student.register'", description: "CONCAT('Student registered online: ', s.name, ' (', s.school_id, ')')", user: 's.name', role: "'student'", status: "'success'", ip: 'CAST(NULL AS CHAR)', target: 's.id' })} FROM students s` },
  { key: 'qrg', idCol: 'q.id', time: 'q.generated_at', where: "q.generated_by_type = 'student'",
    sql: `${pick({ uid: "CONCAT('qrg-', q.id)", at: 'q.generated_at', type: "'qr'", action: "'qr.generate'", description: "CONCAT('QR code generated for ', q.generated_by_name, ' (', s.school_id, ')')", user: 'q.generated_by_name', role: "'student'", status: "'success'", ip: 'CAST(NULL AS CHAR)', target: 'q.student_id' })} FROM qr_codes q JOIN students s ON s.id = q.student_id` },
  { key: 'drv', idCol: 'd.id', time: 'd.created_at', where: "d.role = 'driver' AND d.created_by IS NULL",
    sql: `${pick({ uid: "CONCAT('drv-', d.id)", at: 'd.created_at', type: "'driver'", action: "'driver.register'", description: "CONCAT('Driver registered: ', d.name)", user: 'd.name', role: "'driver'", status: "'success'", ip: 'CAST(NULL AS CHAR)', target: 'd.id' })} FROM admins d` },
  { key: 'txn', idCol: 'x.id', time: 'x.scanned_at', where: "x.result IN ('granted','review')",
    sql: `${pick({ uid: "CONCAT('txn-', x.id)", at: 'x.scanned_at', type: "'transaction'", action: "'transaction.scan'",
      description: "CONCAT('Transaction TXN-', LPAD(x.id, 8, '0'), IF(x.student_name IS NULL, '', CONCAT(' for ', x.student_name)), IF(x.result = 'review', ' (under review)', ''))",
      user: "COALESCE(x.driver_name, 'Scanner')", role: "'driver'", status: "'success'", ip: 'CAST(NULL AS CHAR)', target: 'x.id' })} FROM scans x` },
  { key: 'scn', idCol: 'x.id', time: 'x.scanned_at', where: "x.result = 'denied'",
    sql: `${pick({ uid: "CONCAT('scn-', x.id)", at: 'x.scanned_at', type: "'qr'", action: "'qr.scan_denied'",
      description: "CONCAT('QR scan denied', IF(x.student_name IS NULL, '', CONCAT(' for ', x.student_name)), IF(x.reason IS NULL OR x.reason = '', '', CONCAT(': ', LEFT(x.reason, 120))))",
      user: "COALESCE(x.driver_name, 'Scanner')", role: "'driver'", status: "'failed'", ip: 'CAST(NULL AS CHAR)', target: 'x.id' })} FROM scans x` }
];

/** The UNION for the filters: [sql, args]. Date range goes inside each branch (uses the time indexes), the rest wraps the union. */
function build({ q, type, status, from, to } = {}, only = null) {
  const parts = []; const args = [];
  for (const b of BRANCHES) {
    const w = [];
    if (b.where) w.push(b.where);
    if (from) { w.push(`${b.time} >= ?`); args.push(dayStartUtc(from)); }
    if (to) { w.push(`${b.time} < ?`); args.push(new Date(dayStartUtc(to).getTime() + 86400000)); }
    if (only && only.key === b.key) { w.push(`${b.idCol} = ?`); args.push(only.id); }
    if (only && only.key !== b.key) continue;
    parts.push(`${b.sql}${w.length ? ` WHERE ${w.join(' AND ')}` : ''}`);
  }
  const outer = [];
  if (type && type !== 'all') { outer.push('u.type = ?'); args.push(type); }
  if (status && status !== 'all') { outer.push('u.status = ?'); args.push(status); }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    outer.push("(u.description LIKE ? OR u.user LIKE ? OR u.action LIKE ? OR u.ip LIKE ? OR u.target LIKE ?)");
    args.push(like, like, like, like, like);
  }
  return { union: parts.join('\nUNION ALL\n'), outer: outer.length ? `WHERE ${outer.join(' AND ')}` : '', args };
}

const iso = (v) => toDate(v).toISOString();
function item(r) {
  const at = toDate(r.at);
  const { date, time } = displayParts(at);
  return {
    id: r.uid, at: at.toISOString(), date, time, type: r.type, typeLabel: TYPES[r.type] || r.type, action: r.action, description: r.description,
    user: r.user, role: r.role, ip: r.ip || null, status: r.status, statusLabel: STATUS_LABEL[r.status] || r.status, target: r.target || null
  };
}

async function list(pool, f) {
  const { union, outer, args } = build(f);
  const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM (${union}) u ${outer}`, args);
  const [rows] = await pool.query(`SELECT u.* FROM (${union}) u ${outer} ORDER BY u.at DESC, u.uid DESC LIMIT ? OFFSET ?`, [...args, f.limit, f.offset]);
  return { items: rows.map(item), total: Number(c.n), limit: f.limit, offset: f.offset };
}

/** Counts for the summary cards (same filters except the status, so "Failed" is always visible next to "Success"). */
async function summary(pool, f) {
  const { union, outer, args } = build({ ...f, status: 'all' });
  const [rows] = await pool.query(`SELECT u.status AS status, COUNT(*) AS n FROM (${union}) u ${outer} GROUP BY u.status`, args);
  const out = { total: 0, success: 0, failed: 0 };
  for (const r of rows) { out[r.status] = Number(r.n); out.total += Number(r.n); }
  const b2 = build({ ...f, status: 'all', q: f.q });
  const [[fl]] = await pool.query(`SELECT COUNT(*) AS n FROM (${b2.union}) u ${b2.outer ? `${b2.outer} AND` : 'WHERE'} u.action = 'auth.login_failed'`, b2.args);
  out.failedSignIns = Number(fl.n);
  return out;
}

async function all(pool, f, max) {
  const { union, outer, args } = build(f);
  const [rows] = await pool.query(`SELECT u.* FROM (${union}) u ${outer} ORDER BY u.at DESC, u.uid DESC LIMIT ?`, [...args, max]);
  return rows.map(item);
}

const PREFIX = /^(log|reg|qrg|drv|txn|scn)-(.+)$/;
/** One activity with everything known about it. */
async function one(pool, uid) {
  const m = PREFIX.exec(String(uid));
  if (!m) throw notFound('Activity not found');
  const key = m[1];
  const { union, args } = build({}, { key, id: key === 'reg' ? m[2] : /^\d{1,12}$/.test(m[2]) ? Number(m[2]) : -1 });
  const [rows] = await pool.query(`SELECT u.* FROM (${union}) u LIMIT 1`, args);
  if (!rows[0]) throw notFound('Activity not found');
  const base = item(rows[0]);
  const detail = { ...base, source: { log: 'Activity log', reg: 'Student registration', qrg: 'QR code generation', drv: 'Driver registration', txn: 'QR scan (transaction)', scn: 'QR scan (denied)' }[key] };
  if (key === 'log') {
    const [[r]] = await pool.query('SELECT admin_id FROM activity_logs WHERE id = ?', [m[2]]);
    detail.accountId = r && r.admin_id ? r.admin_id : null;
  }
  if (key === 'txn') detail.reference = txnReference(Number(m[2]));
  return detail;
}

/** The filters in words (printed at the top of a report). */
function describeFilters(f) {
  const out = [];
  if (f.q) out.push(`Search: "${f.q}"`);
  if (f.type && f.type !== 'all') out.push(`Type: ${TYPES[f.type] || f.type}`);
  if (f.status && f.status !== 'all') out.push(`Status: ${STATUS_LABEL[f.status]}`);
  if (f.from || f.to) out.push(`Dates: ${f.from || 'start'} to ${f.to || 'today'}`);
  return out;
}

async function report(pool, f) {
  const [items, sum] = await Promise.all([all(pool, f, REPORT_MAX), summary(pool, f)]);
  const total = f.status && f.status !== 'all' ? sum[f.status] : sum.total;
  return { generatedAt: new Date().toISOString(), filters: describeFilters(f), summary: sum, items, total, truncated: total > items.length, maxRows: REPORT_MAX };
}

const ymd = (d) => { const p = localParts(d); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
const hms = (d) => { const p = localParts(d); return [p.hour, p.minute, p.second].map((n) => String(n).padStart(2, '0')).join(':'); };
const COLUMNS = [
  { header: 'Log ID', value: (r) => r.id },
  { header: 'Date', value: (r) => ymd(new Date(r.at)) },
  { header: 'Time', value: (r) => hms(new Date(r.at)) },
  { header: 'Activity Type', value: (r) => r.typeLabel },
  { header: 'Action', value: (r) => r.action },
  { header: 'Description', value: (r) => r.description },
  { header: 'User', value: (r) => r.user },
  { header: 'Role', value: (r) => r.role },
  { header: 'IP Address', value: (r) => r.ip || '' },
  { header: 'Status', value: (r) => r.statusLabel }
];
async function exportCsv(pool, f) {
  const rows = await all(pool, f, EXPORT_MAX);
  return { body: csv.build(COLUMNS, rows), count: rows.length, filename: `activity-logs-${ymd(new Date()).replace(/-/g, '')}.csv` };
}

const typeOptions = () => Object.entries(TYPES).map(([value, label]) => ({ value, label }));

module.exports = { list, summary, one, report, exportCsv, typeOptions, TYPES, REPORT_MAX, EXPORT_MAX, build };
