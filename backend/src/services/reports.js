'use strict';
const { startOfLocalDay, localParts, DAYS } = require('../lib/time');
const { escapeLike } = require('../lib/sql');
const ser = require('../lib/serialize');

const DAY_MS = 86400000;
const MINUS = '\u2212'; // matches the typography used by the existing UI

async function counts(pool, from, to) {
  const [rows] = await pool.query(
    `SELECT result, COUNT(*) AS n, COALESCE(SUM(discount_amount), 0) AS discount
       FROM scans WHERE scanned_at >= ? AND scanned_at < ? GROUP BY result`, [from, to]);
  const out = { granted: 0, review: 0, denied: 0, total: 0, discount: 0 };
  for (const r of rows) {
    out[r.result] = Number(r.n);
    out.total += Number(r.n);
    out.discount += Number(r.discount);
  }
  return out;
}

const pctDelta = (now, prev) => {
  if (!prev) return now ? 'new' : '0%';
  const p = ((now - prev) / prev) * 100;
  return `${p >= 0 ? '+' : MINUS}${Math.abs(p).toFixed(1)}%`;
};
const absDelta = (now, prev) => { const d = now - prev; return d === 0 ? '0' : `${d > 0 ? '+' : MINUS}${Math.abs(d)}`; };
const num = (n) => n.toLocaleString('en-US');
const money = (n) => `₱${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Dashboard KPI cards for "today" (in the configured timezone) versus yesterday. */
async function kpis(pool, now = new Date()) {
  const start = startOfLocalDay(now);
  const yStart = new Date(start.getTime() - DAY_MS);
  const [t, y] = await Promise.all([counts(pool, start, new Date(start.getTime() + DAY_MS)), counts(pool, yStart, start)]);
  const deniedShare = t.total ? ((t.denied / t.total) * 100).toFixed(1) : '0.0';
  return {
    asOf: now.toISOString(),
    kpis: [
      { label: 'Verified today', value: num(t.granted), delta: pctDelta(t.granted, y.granted), note: 'vs. yesterday' },
      { label: 'Discount released', value: money(t.discount), delta: pctDelta(t.discount, y.discount), note: 'subsidy accrued' },
      { label: 'Denied / expired', value: num(t.denied), delta: pctDelta(t.denied, y.denied), note: `${deniedShare}% of scans` },
      { label: 'Fraud reviews', value: num(t.review), delta: absDelta(t.review, y.review), note: 'queued for registrar' }
    ],
    raw: { today: t, yesterday: y }
  };
}

/** Last 7 local days (oldest first, ending today): granted / review / denied scan counts. */
async function weekly(pool, now = new Date()) {
  const todayStart = startOfLocalDay(now);
  const first = new Date(todayStart.getTime() - 6 * DAY_MS);
  const [rows] = await pool.query(
    `SELECT FLOOR(TIMESTAMPDIFF(SECOND, ?, scanned_at) / 86400) AS bucket, result, COUNT(*) AS n
       FROM scans WHERE scanned_at >= ? AND scanned_at < ? GROUP BY bucket, result`,
    [first, first, new Date(todayStart.getTime() + DAY_MS)]);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const start = new Date(first.getTime() + i * DAY_MS);
    const p = localParts(new Date(start.getTime() + 12 * 3600000)); // noon avoids edge cases at midnight
    const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    days.push({
      day: DAYS[dow],
      date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
      granted: 0, review: 0, denied: 0
    });
  }
  for (const r of rows) {
    const b = Number(r.bucket);
    if (days[b]) days[b][r.result] = Number(r.n);
  }
  return days;
}

async function listScans(pool, { q, result, code, method, driverId, from, to, limit, offset }) {
  const where = [];
  const args = [];
  if (result && result !== 'all') { where.push('sc.result = ?'); args.push(result); }
  if (code && code !== 'all') { where.push('sc.verification_result = ?'); args.push(code); }
  if (method && method !== 'all') { where.push('sc.scan_method = ?'); args.push(method); }
  if (driverId) { where.push('sc.scanned_by = ?'); args.push(driverId); }
  if (from) { where.push('sc.scanned_at >= ?'); args.push(from); }
  if (to) { where.push('sc.scanned_at < ?'); args.push(to); }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push('(COALESCE(st.name, sc.student_name) LIKE ? OR COALESCE(st.school_id, sc.school_id) LIKE ? OR sc.route LIKE ? OR sc.operator LIKE ? OR sc.driver_name LIKE ? OR sc.scanned_value LIKE ?)');
    args.push(like, like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const join = 'FROM scans sc LEFT JOIN students st ON st.id = sc.student_id';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${join} ${clause}`, args);
  // "overall" = every scan this caller is allowed to see (a driver's own history never counts other drivers' scans).
  const [[{ overall }]] = await pool.query(`SELECT COUNT(*) AS overall FROM scans ${driverId ? 'WHERE scanned_by = ?' : ''}`, driverId ? [driverId] : []);
  const [rows] = await pool.query(
    `SELECT sc.*, st.name AS st_name, st.school_id AS st_school_id ${join} ${clause}
      ORDER BY sc.scanned_at DESC, sc.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { items: rows.map(ser.scan), total, overall };
}

async function feed(pool, limit) {
  const [rows] = await pool.query(
    `SELECT sc.*, st.name AS st_name, st.school_id AS st_school_id
       FROM scans sc LEFT JOIN students st ON st.id = sc.student_id
      ORDER BY sc.scanned_at DESC, sc.id DESC LIMIT ?`, [limit]);
  return rows.map(ser.scan);
}

async function listEmails(pool, { q, limit, offset }) {
  const where = [];
  const args = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push('(student_name LIKE ? OR to_email LIKE ? OR subject LIKE ? OR school_id LIKE ?)');
    args.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM email_log ${clause}`, args);
  const [rows] = await pool.query(
    `SELECT * FROM email_log ${clause} ORDER BY sent_at DESC, id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { items: rows.map(ser.email), total };
}

/** Per-day scanning record (local days, newest first), optionally for one driver. */
async function daily(pool, { days = 14, driverId = null } = {}, now = new Date()) {
  const todayStart = startOfLocalDay(now);
  const first = new Date(todayStart.getTime() - (days - 1) * DAY_MS);
  const [rows] = await pool.query(
    `SELECT FLOOR(TIMESTAMPDIFF(SECOND, ?, scanned_at) / 86400) AS bucket, result, COUNT(*) AS n
       FROM scans WHERE scanned_at >= ? AND scanned_at < ? ${driverId ? 'AND scanned_by = ?' : ''} GROUP BY bucket, result`,
    [first, first, new Date(todayStart.getTime() + DAY_MS), ...(driverId ? [driverId] : [])]);
  const out = [];
  for (let i = 0; i < days; i++) {
    const p = localParts(new Date(first.getTime() + i * DAY_MS + 12 * 3600000));
    out.push({ date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, total: 0, verified: 0, rejected: 0, review: 0 });
  }
  for (const r of rows) {
    const d = out[Number(r.bucket)];
    if (!d) continue;
    const n = Number(r.n);
    d.total += n;
    if (r.result === 'granted') d.verified += n; else if (r.result === 'review') d.review += n; else d.rejected += n;
  }
  return out.reverse();
}

/** A driver's own numbers: total scanned, verified, rejected/invalid, flagged. */
async function driverStats(pool, driverId, now = new Date()) {
  const start = startOfLocalDay(now);
  const q = async (since) => {
    const [rows] = await pool.query(
      `SELECT result, COUNT(*) AS n FROM scans WHERE scanned_by = ? ${since ? 'AND scanned_at >= ?' : ''} GROUP BY result`, since ? [driverId, since] : [driverId]);
    const o = { total: 0, verified: 0, rejected: 0, review: 0 };
    for (const r of rows) {
      const n = Number(r.n);
      o.total += n;
      if (r.result === 'granted') o.verified += n; else if (r.result === 'review') o.review += n; else o.rejected += n;
    }
    return o;
  };
  return { today: await q(start), allTime: await q(null) };
}

module.exports = { kpis, weekly, listScans, feed, listEmails, daily, driverStats };
