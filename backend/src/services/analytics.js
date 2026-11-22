'use strict';
/*
  Reports & Analytics (administrator, read only). Every number is counted live from the existing tables (scans, transaction_cancellations,
  refund_requests, students, student_verifications, admins); nothing is stored, copied or hardcoded.

  Counting rules (the same ones Transaction Management uses, so the two screens always agree):
    a transaction     = a scan with result granted / review (a denied scan never became a ride)
    completed         = a transaction with NO cancellation and NO approved refund
    collected revenue = SUM(fare_amount) of COMPLETED transactions only
    discounts         = SUM(discount_amount) of COMPLETED transactions only
    cancelled         = has a row in transaction_cancellations (counted ONLY here, even if it was also refunded)
    refunded          = not cancelled, with an approved refund request
  Each transaction has exactly one status, so a fare or a discount can never be counted twice. Cancelled and refunded transactions are
  shown on their own and never added to revenue. All dates are local calendar days (APP_TIMEZONE) of the transaction / registration time.
*/
const { tzOffsetMinutes, toDate, displayParts } = require('../lib/time');
const { dayStartUtc, todayYmd, isRealDate } = require('../lib/dates');
const { round2 } = require('../lib/fare');
const { badRequest } = require('../lib/httpError');
const csv = require('../lib/csv');
const tx = require('./transactions');
const pdf = require('../lib/pdf');

const DAY = 86400000;
const MAX_DAYS = 366;
const SCREEN_ROWS = 200;
const EXPORT_ROWS = 50000;
const RIDE = "s.result IN ('granted','review')";
const DONE = `${RIDE} AND ${tx.SQL_COMPLETED}`;       // completed transaction
const CANC = `${RIDE} AND c.id IS NOT NULL`;           // cancelled
const REFD = `${RIDE} AND c.id IS NULL AND ra.id IS NOT NULL`; // refunded (not also cancelled)

const REPORT_NAMES = ['transactions', 'students', 'drivers', 'fares', 'discounts', 'cancelled-refunded'];
const TITLES = {
  transactions: 'Transactions report', students: 'Student registrations report', drivers: 'Driver activity report', fares: 'Fare collections report',
  discounts: 'Discount utilization report', 'cancelled-refunded': 'Cancelled and refunded transactions report'
};

/* ---------- the date range ---------- */
const parse = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/** period: daily | weekly | monthly | custom. `date` anchors daily / weekly (Monday to Sunday) / monthly; custom uses from + to. */
function resolveRange({ period = 'monthly', date, from, to } = {}, now = new Date()) {
  const anchor = date || todayYmd(0, now);
  if (!isRealDate(anchor)) throw badRequest('Use a real date in the format YYYY-MM-DD');
  const a = parse(anchor);
  let f; let t;
  if (period === 'daily') { f = a; t = a; }
  else if (period === 'weekly') { f = new Date(a.getTime() - ((a.getUTCDay() + 6) % 7) * DAY); t = new Date(f.getTime() + 6 * DAY); }
  else if (period === 'monthly') { f = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1)); t = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0)); }
  else if (period === 'custom') {
    if (!from || !to) throw badRequest('Choose both a start date and an end date.');
    if (!isRealDate(from) || !isRealDate(to)) throw badRequest('Use real dates in the format YYYY-MM-DD');
    f = parse(from); t = parse(to);
    if (f > t) throw badRequest('The start date must not be after the end date.');
    if ((t - f) / DAY + 1 > MAX_DAYS) throw badRequest(`Choose a range of at most ${MAX_DAYS} days.`);
  } else throw badRequest('Unknown period.');
  const days = Math.round((t - f) / DAY) + 1;
  return { period, from: fmt(f), to: fmt(t), days, start: dayStartUtc(fmt(f)), end: new Date(dayStartUtc(fmt(t)).getTime() + DAY), label: days === 1 ? fmt(f) : `${fmt(f)} to ${fmt(t)}` };
}

const dayList = (r) => Array.from({ length: r.days }, (_, i) => fmt(new Date(parse(r.from).getTime() + i * DAY)));
const offOf = (r) => tzOffsetMinutes(r.start);
const num = (v) => Number(v || 0);
const money = (v) => round2(num(v));
const pct = (a, b) => (b ? round2((a / b) * 100) : 0);
const peso = (v) => `₱${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Fills a per-day query result (rows with k = 'YYYY-MM-DD') into one value per day of the range. */
function perDay(r, rows, pick) {
  const m = new Map(rows.map((x) => [x.k, x]));
  return dayList(r).map((d) => (m.has(d) ? pick(m.get(d)) : 0));
}
const labelsOf = (r) => dayList(r).map((d) => (r.days <= 31 ? d.slice(8) + '/' + d.slice(5, 7) : d.slice(5)));

/* ---------- the reports. each returns { cards, charts, table: { columns, rows, totals? }, note? } ---------- */
const col = (key, header, type = 'text') => ({ key, header, type });

async function transactionsReport(pool, r) {
  const sum = await tx.summary(pool, { from: r.from, to: r.to });
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(DATE_ADD(s.scanned_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS k, SUM(${DONE}) AS done_n, SUM(CASE WHEN ${DONE} THEN s.fare_amount END) AS revenue,
            SUM(${CANC}) AS canc_n, SUM(${REFD}) AS ref_n
       ${tx.J_STATUS} WHERE ${RIDE} AND s.scanned_at >= ? AND s.scanned_at < ? GROUP BY k`, [offOf(r), r.start, r.end]);
  const items = await tx.all(pool, { from: r.from, to: r.to }, EXPORT_ROWS);
  return {
    cards: [
      { label: 'Completed transactions', value: sum.completed.count, note: 'not cancelled, not refunded' },
      { label: 'Collected revenue', value: peso(sum.completed.revenue), note: 'completed transactions only' },
      { label: 'Cancelled', value: sum.cancelled.count, note: `${peso(sum.cancelled.fareValue)} not collected` },
      { label: 'Refunded', value: sum.refunded.count, note: `${peso(sum.refunded.refundedAmount)} refunded` }
    ],
    summary: sum,
    charts: [
      { title: 'Completed transactions per day', kind: 'bar', x: labelsOf(r), series: [{ name: 'Completed', values: perDay(r, days, (x) => num(x.done_n)) }] },
      { title: 'Transactions by status', kind: 'bar', x: ['Completed', 'Cancelled', 'Refunded'], series: [{ name: 'Transactions', values: [sum.completed.count, sum.cancelled.count, sum.refunded.count] }] }
    ],
    table: {
      columns: [col('reference', 'Reference'), col('date', 'Date'), col('time', 'Time'), col('status', 'Status'), col('student', 'Student'), col('schoolId', 'Student ID'), col('driver', 'Driver'),
        col('route', 'Route / service'), col('regularFare', 'Regular fare', 'money'), col('discountAmount', 'Discount', 'money'), col('finalFare', 'Final fare', 'money'), col('refundAmount', 'Refunded', 'money'), col('remarks', 'Remarks')],
      rows: items.map((t) => ({
        reference: t.reference, date: t.date, time: t.time, status: t.statusLabel, student: t.studentName, schoolId: t.schoolId, driver: t.driver, route: t.route,
        regularFare: t.regularFare, discountAmount: t.discountAmount, finalFare: t.finalFare, refundAmount: t.refundAmount,
        remarks: t.status === 'cancelled' ? `Cancelled: ${t.cancelReason}` : t.status === 'refunded' ? 'Refunded' : t.underReview ? 'Under review (full fare charged)' : ''
      })),
      // revenue and discounts are totalled over COMPLETED rows only; the table also lists cancelled / refunded rows, which are excluded here
      totals: { label: 'Completed transactions only', regularFare: sum.completed.regularFare, discountAmount: sum.completed.discounts, finalFare: sum.completed.revenue }
    }
  };
}

async function studentsReport(pool, r) {
  const [rows] = await pool.query(
    `SELECT s.id, s.school_id, s.name, s.program, s.level, s.created_at, (s.password_hash IS NOT NULL) AS online, COALESCE(v.verification_status, 'pending') AS vs
       FROM students s LEFT JOIN student_verifications v ON v.student_id = s.id
      WHERE s.created_at >= ? AND s.created_at < ? ORDER BY s.created_at DESC, s.id DESC LIMIT ?`, [r.start, r.end, EXPORT_ROWS]);
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(DATE_ADD(created_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS k, COUNT(*) AS n FROM students WHERE created_at >= ? AND created_at < ? GROUP BY k`, [offOf(r), r.start, r.end]);
  const by = (f) => rows.filter(f).length;
  const total = rows.length;
  const sum = { total, verified: by((x) => x.vs === 'verified'), pending: by((x) => x.vs === 'pending'), rejected: by((x) => x.vs === 'rejected'), online: by((x) => x.online), byStaff: by((x) => !x.online) };
  return {
    cards: [
      { label: 'New registrations', value: total, note: `${sum.online} online, ${sum.byStaff} by staff` },
      { label: 'Verified', value: sum.verified, note: 'verification approved' },
      { label: 'Pending', value: sum.pending, note: 'waiting for review' },
      { label: 'Rejected', value: sum.rejected, note: 'verification rejected' }
    ],
    summary: sum,
    charts: [
      { title: 'Registrations per day', kind: 'bar', x: labelsOf(r), series: [{ name: 'Registrations', values: perDay(r, days, (x) => num(x.n)) }] },
      { title: 'Current verification status', kind: 'bar', x: ['Verified', 'Pending', 'Rejected'], series: [{ name: 'Students', values: [sum.verified, sum.pending, sum.rejected] }] }
    ],
    table: {
      columns: [col('registered', 'Registered'), col('schoolId', 'School ID'), col('name', 'Student'), col('program', 'Program'), col('level', 'Year level'), col('source', 'Registered by'), col('verification', 'Verification')],
      rows: rows.map((x) => { const p = displayParts(toDate(x.created_at)); return { registered: `${p.date} ${p.time}`, schoolId: x.school_id, name: x.name, program: x.program, level: x.level, source: x.online ? 'Student (online)' : 'Staff', verification: x.vs[0].toUpperCase() + x.vs.slice(1) }; })
    }
  };
}

async function driversReport(pool, r) {
  const [drivers] = await pool.query("SELECT id, name, username, status, unit FROM admins WHERE role = 'driver' ORDER BY name, id");
  const [agg] = await pool.query(
    `SELECT s.scanned_by AS driver_id, MAX(s.driver_name) AS driver_name, COUNT(*) AS scans, SUM(s.result = 'denied') AS denied, SUM(${RIDE}) AS rides, SUM(${DONE}) AS completed,
            COALESCE(SUM(CASE WHEN ${DONE} THEN s.fare_amount END), 0) AS revenue, COALESCE(SUM(CASE WHEN ${DONE} THEN s.discount_amount END), 0) AS discounts,
            SUM(${CANC}) AS cancelled, SUM(${REFD}) AS refunded, MAX(s.scanned_at) AS last_at
       ${tx.J_STATUS} WHERE s.scanned_at >= ? AND s.scanned_at < ? GROUP BY s.scanned_by`, [r.start, r.end]);
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(DATE_ADD(s.scanned_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS k, COUNT(*) AS n FROM scans s WHERE s.scanned_at >= ? AND s.scanned_at < ? GROUP BY k`, [offOf(r), r.start, r.end]);
  const map = new Map(agg.map((a) => [a.driver_id, a]));
  const known = new Set(drivers.map((d) => d.id));
  const rows = drivers.map((d) => ({ d, a: map.get(d.id) }))
    .concat(agg.filter((a) => !known.has(a.driver_id)).map((a) => ({ d: { id: a.driver_id, name: a.driver_name || 'Unknown driver', username: '', status: 'removed', unit: null }, a })))
    .map(({ d, a }) => ({
      driver: d.name, username: d.username || '', unit: d.unit || '', status: d.status[0].toUpperCase() + d.status.slice(1), scans: num(a && a.scans), completed: num(a && a.completed),
      denied: num(a && a.denied), cancelled: num(a && a.cancelled), refunded: num(a && a.refunded), revenue: money(a && a.revenue), discounts: money(a && a.discounts),
      lastActivity: a && a.last_at ? (() => { const p = displayParts(toDate(a.last_at)); return `${p.date} ${p.time}`; })() : ''
    })).sort((x, y) => y.scans - x.scans || x.driver.localeCompare(y.driver));
  const sum = rows.reduce((o, x) => ({ scans: o.scans + x.scans, completed: o.completed + x.completed, denied: o.denied + x.denied, revenue: o.revenue + x.revenue, discounts: o.discounts + x.discounts }), { scans: 0, completed: 0, denied: 0, revenue: 0, discounts: 0 });
  sum.revenue = round2(sum.revenue); sum.discounts = round2(sum.discounts);
  const active = rows.filter((x) => x.scans > 0).length;
  return {
    cards: [
      { label: 'Active drivers', value: active, note: `of ${drivers.length} driver account(s)` },
      { label: 'Scans handled', value: sum.scans, note: `${sum.denied} denied` },
      { label: 'Completed transactions', value: sum.completed, note: 'not cancelled, not refunded' },
      { label: 'Fares collected', value: peso(sum.revenue), note: 'completed transactions only' }
    ],
    summary: { ...sum, activeDrivers: active, driverAccounts: drivers.length },
    charts: [
      { title: 'Scans per day (all drivers)', kind: 'bar', x: labelsOf(r), series: [{ name: 'Scans', values: perDay(r, days, (x) => num(x.n)) }] },
      { title: 'Scans per driver', kind: 'bar', x: rows.filter((x) => x.scans > 0).slice(0, 8).map((x) => x.driver), series: [{ name: 'Scans', values: rows.filter((x) => x.scans > 0).slice(0, 8).map((x) => x.scans) }] }
    ],
    table: {
      columns: [col('driver', 'Driver'), col('unit', 'Unit'), col('status', 'Account'), col('scans', 'Scans', 'int'), col('completed', 'Completed', 'int'), col('denied', 'Denied scans', 'int'),
        col('cancelled', 'Cancelled', 'int'), col('refunded', 'Refunded', 'int'), col('revenue', 'Fares collected', 'money'), col('discounts', 'Discounts given', 'money'), col('lastActivity', 'Last activity')],
      rows, totals: { label: 'All drivers', scans: sum.scans, completed: sum.completed, denied: sum.denied, revenue: sum.revenue, discounts: sum.discounts }
    }
  };
}

async function faresReport(pool, r) {
  const sum = (await tx.summary(pool, { from: r.from, to: r.to })).completed;
  const [byRoute] = await pool.query(
    `SELECT COALESCE(tr.name, s.route) AS route, COUNT(*) AS n, SUM(s.fare_amount) AS revenue, SUM(s.discount_amount) AS discounts
       ${tx.J_LIST} WHERE ${DONE} AND s.scanned_at >= ? AND s.scanned_at < ? GROUP BY COALESCE(tr.name, s.route) ORDER BY revenue DESC, route`, [r.start, r.end]);
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(DATE_ADD(s.scanned_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS k, SUM(s.fare_amount) AS revenue, COUNT(*) AS n
       ${tx.J_STATUS} WHERE ${DONE} AND s.scanned_at >= ? AND s.scanned_at < ? GROUP BY k`, [offOf(r), r.start, r.end]);
  const avg = sum.count ? round2(sum.revenue / sum.count) : 0;
  const rows = byRoute.map((x) => ({ route: x.route, transactions: num(x.n), regularFare: money(num(x.revenue) + num(x.discounts)), discounts: money(x.discounts), collected: money(x.revenue), average: num(x.n) ? round2(num(x.revenue) / num(x.n)) : 0, share: pct(num(x.revenue), sum.revenue) }));
  return {
    cards: [
      { label: 'Fares collected', value: peso(sum.revenue), note: 'completed transactions only' },
      { label: 'Completed transactions', value: sum.count, note: `average fare ${peso(avg)}` },
      { label: 'Regular fare value', value: peso(sum.regularFare), note: 'before discounts' },
      { label: 'Discounts given', value: peso(sum.discounts), note: 'regular fare minus fare collected' }
    ],
    summary: { ...sum, averageFare: avg },
    charts: [
      { title: 'Fares collected per day (₱)', kind: 'line', x: labelsOf(r), series: [{ name: 'Fares collected', values: perDay(r, days, (x) => money(x.revenue)) }] },
      { title: 'Fares collected by route (₱)', kind: 'bar', x: rows.slice(0, 8).map((x) => x.route), series: [{ name: 'Fares collected', values: rows.slice(0, 8).map((x) => x.collected) }] }
    ],
    table: {
      columns: [col('route', 'Route / service'), col('transactions', 'Transactions', 'int'), col('regularFare', 'Regular fare', 'money'), col('discounts', 'Discounts', 'money'), col('collected', 'Fares collected', 'money'), col('average', 'Average fare', 'money'), col('share', 'Share of revenue %', 'pct')],
      rows, totals: { label: 'All routes', transactions: sum.count, regularFare: sum.regularFare, discounts: sum.discounts, collected: sum.revenue, average: avg, share: sum.revenue ? 100 : 0 }
    }
  };
}

async function discountsReport(pool, r) {
  const sum = (await tx.summary(pool, { from: r.from, to: r.to }));
  const done = sum.completed;
  const [[ex]] = await pool.query(
    `SELECT COALESCE(SUM(s.discount_amount), 0) AS d ${tx.J_STATUS} WHERE (${CANC} OR ${REFD}) AND s.scanned_at >= ? AND s.scanned_at < ?`, [r.start, r.end]);
  const [[disc]] = await pool.query(
    `SELECT COUNT(*) AS n ${tx.J_STATUS} WHERE ${DONE} AND s.discount_amount > 0 AND s.scanned_at >= ? AND s.scanned_at < ?`, [r.start, r.end]);
  const [byPct] = await pool.query(
    `SELECT ROUND(s.discount_amount * 100 / (s.fare_amount + s.discount_amount)) AS p, COUNT(*) AS n, SUM(s.discount_amount) AS d, SUM(s.fare_amount) AS revenue
       ${tx.J_STATUS} WHERE ${DONE} AND s.discount_amount > 0 AND (s.fare_amount + s.discount_amount) > 0 AND s.scanned_at >= ? AND s.scanned_at < ?
      GROUP BY p ORDER BY p DESC`, [r.start, r.end]);
  const [byRoute] = await pool.query(
    `SELECT COALESCE(tr.name, s.route) AS route, COUNT(*) AS n, SUM(s.discount_amount > 0) AS dn, SUM(s.discount_amount) AS d
       ${tx.J_LIST} WHERE ${DONE} AND s.scanned_at >= ? AND s.scanned_at < ? GROUP BY COALESCE(tr.name, s.route) ORDER BY d DESC, route`, [r.start, r.end]);
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(DATE_ADD(s.scanned_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS k, SUM(s.discount_amount) AS d
       ${tx.J_STATUS} WHERE ${DONE} AND s.scanned_at >= ? AND s.scanned_at < ? GROUP BY k`, [offOf(r), r.start, r.end]);
  const discounted = num(disc.n);
  const rate = pct(discounted, done.count);
  const avg = discounted ? round2(done.discounts / discounted) : 0;
  const rows = byRoute.map((x) => ({ route: x.route, transactions: num(x.n), discounted: num(x.dn), utilization: pct(num(x.dn), num(x.n)), discounts: money(x.d), average: num(x.dn) ? round2(num(x.d) / num(x.dn)) : 0 }));
  return {
    cards: [
      { label: 'Discounts given', value: peso(done.discounts), note: 'completed transactions only' },
      { label: 'Discounted rides', value: discounted, note: `${done.count - discounted} full-fare ride(s)` },
      { label: 'Discount utilization', value: `${rate}%`, note: 'discounted rides / completed rides' },
      { label: 'Average discount', value: peso(avg), note: 'per discounted ride' }
    ],
    summary: { discounts: done.discounts, discountedRides: discounted, fullFareRides: done.count - discounted, completed: done.count, utilizationRate: rate, averageDiscount: avg, excludedDiscounts: money(ex.d) },
    charts: [
      { title: 'Discounts given per day (₱)', kind: 'bar', x: labelsOf(r), series: [{ name: 'Discounts', values: perDay(r, days, (x) => money(x.d)) }] },
      { title: 'Discounted rides by discount rate', kind: 'bar', x: byPct.map((x) => `${num(x.p)}%`), series: [{ name: 'Rides', values: byPct.map((x) => num(x.n)) }] }
    ],
    note: `Discounts of cancelled and refunded transactions (${peso(money(ex.d))}) are excluded.`,
    table: {
      columns: [col('route', 'Route / service'), col('transactions', 'Completed rides', 'int'), col('discounted', 'Discounted rides', 'int'), col('utilization', 'Utilization %', 'pct'), col('discounts', 'Discounts given', 'money'), col('average', 'Average discount', 'money')],
      rows, totals: { label: 'All routes', transactions: done.count, discounted, utilization: rate, discounts: done.discounts, average: avg }
    }
  };
}

async function cancelledRefundedReport(pool, r) {
  const sum = await tx.summary(pool, { from: r.from, to: r.to });
  const [rows] = await pool.query(
    `SELECT s.id, s.scanned_at, s.student_name, s.school_id, s.fare_amount, COALESCE(tr.name, s.route) AS route, c.id AS cancel_id, c.reason AS cancel_reason, c.cancelled_by_name, c.created_at AS cancelled_at,
            ra.id AS refund_id, ra.amount AS refund_amount, ra.reason AS refund_reason, ra.decided_by_name, ra.decided_at
       ${tx.J_LIST} WHERE (${CANC} OR ${REFD}) AND s.scanned_at >= ? AND s.scanned_at < ? ORDER BY s.scanned_at DESC, s.id DESC LIMIT ?`, [r.start, r.end, EXPORT_ROWS]);
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(DATE_ADD(s.scanned_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS k, SUM(${CANC}) AS c, SUM(${REFD}) AS f FROM scans s
       LEFT JOIN transaction_cancellations c ON c.scan_id = s.id LEFT JOIN refund_requests ra ON ra.id = (SELECT MAX(r2.id) FROM refund_requests r2 WHERE r2.scan_id = s.id AND r2.status = 'approved')
      WHERE ${RIDE} AND s.scanned_at >= ? AND s.scanned_at < ? GROUP BY k`, [offOf(r), r.start, r.end]);
  return {
    cards: [
      { label: 'Cancelled transactions', value: sum.cancelled.count, note: `${peso(sum.cancelled.fareValue)} fare value` },
      { label: 'Refunded transactions', value: sum.refunded.count, note: `${peso(sum.refunded.fareValue)} fare value` },
      { label: 'Amount refunded', value: peso(sum.refunded.refundedAmount), note: 'approved refunds' },
      { label: 'Excluded from revenue', value: peso(round2(sum.cancelled.fareValue + sum.refunded.fareValue)), note: 'never counted as collected' }
    ],
    summary: { cancelled: sum.cancelled, refunded: sum.refunded },
    charts: [
      { title: 'Cancelled and refunded per day', kind: 'bar', x: labelsOf(r), series: [{ name: 'Cancelled', values: perDay(r, days, (x) => num(x.c)) }, { name: 'Refunded', values: perDay(r, days, (x) => num(x.f)) }] }
    ],
    table: {
      columns: [col('type', 'Type'), col('reference', 'Reference'), col('date', 'Date'), col('student', 'Student'), col('schoolId', 'Student ID'), col('route', 'Route / service'), col('fare', 'Fare', 'money'),
        col('refunded', 'Refunded amount', 'money'), col('reason', 'Reason'), col('by', 'Decided by'), col('decidedAt', 'Decided on')],
      rows: rows.map((x) => {
        const cancelled = !!x.cancel_id; const when = toDate(cancelled ? x.cancelled_at : x.decided_at); const p = displayParts(toDate(x.scanned_at));
        return { type: cancelled ? 'Cancelled' : 'Refunded', reference: `TXN-${String(x.id).padStart(8, '0')}`, date: `${p.date} ${p.time}`, student: x.student_name || '—', schoolId: x.school_id || '—', route: x.route, fare: money(x.fare_amount),
          refunded: cancelled ? null : money(x.refund_amount), reason: cancelled ? x.cancel_reason : x.refund_reason, by: (cancelled ? x.cancelled_by_name : x.decided_by_name) || '', decidedAt: x.decided_at || x.cancelled_at ? `${displayParts(when).date}` : '' };
      })
    }
  };
}

const LOADERS = { transactions: transactionsReport, students: studentsReport, drivers: driversReport, fares: faresReport, discounts: discountsReport, 'cancelled-refunded': cancelledRefundedReport };

/** Summary cards of every report side by side (the page header). */
async function overview(pool, r) {
  const [t, s, d, f, c] = await Promise.all([transactionsReport(pool, r), studentsReport(pool, r), driversReport(pool, r), discountsReport(pool, r), cancelledRefundedReport(pool, r)]);
  return {
    range: publicRange(r),
    cards: [
      { key: 'completed', label: 'Completed transactions', value: t.summary.completed.count, note: 'not cancelled, not refunded' },
      { key: 'revenue', label: 'Collected revenue', value: peso(t.summary.completed.revenue), amount: t.summary.completed.revenue, note: 'completed transactions only' },
      { key: 'discounts', label: 'Discounts given', value: peso(f.summary.discounts), amount: f.summary.discounts, note: `${f.summary.utilizationRate}% utilization` },
      { key: 'cancelled', label: 'Cancelled', value: c.summary.cancelled.count, note: 'shown separately' },
      { key: 'refunded', label: 'Refunded', value: c.summary.refunded.count, note: `${peso(c.summary.refunded.refundedAmount)} refunded` },
      { key: 'students', label: 'New registrations', value: s.summary.total, note: `${s.summary.verified} verified` },
      { key: 'drivers', label: 'Active drivers', value: d.summary.activeDrivers, note: `${d.summary.scans} scan(s)` }
    ]
  };
}

const publicRange = (r) => ({ period: r.period, from: r.from, to: r.to, days: r.days, label: r.label });

async function run(pool, name, query, { limit = SCREEN_ROWS } = {}) {
  if (!LOADERS[name]) throw badRequest('Unknown report.');
  const r = resolveRange(query);
  const out = await LOADERS[name](pool, r);
  const total = out.table.rows.length;
  return { report: name, title: TITLES[name], range: publicRange(r), generatedAt: new Date().toISOString(), cards: out.cards, summary: out.summary, charts: out.charts, note: out.note || null,
    table: { columns: out.table.columns, rows: out.table.rows.slice(0, limit), totals: out.table.totals || null, total, truncated: total > limit } };
}

/** CSV (Excel-compatible) of one report: every row of the table plus a totals row where the report has one. */
async function exportCsv(pool, name, query) {
  if (!LOADERS[name]) throw badRequest('Unknown report.');
  const r = resolveRange(query);
  const out = await LOADERS[name](pool, r);
  const rows = out.table.rows.map((x) => x);
  const columns = out.table.columns.map((c) => ({ header: c.header, value: (row) => (row[c.key] === undefined ? null : row[c.key]) }));
  const t = out.table.totals;
  if (t) rows.push({ ...Object.fromEntries(out.table.columns.map((c) => [c.key, t[c.key] === undefined ? '' : t[c.key]])), [out.table.columns[0].key]: `TOTAL (${t.label})` });
  return { body: csv.build(columns, rows), count: out.table.rows.length, filename: `transitpass-${name}-${r.from}${r.from === r.to ? '' : `_to_${r.to}`}.csv`, range: r.label };
}

/** Dedicated PDF (no browser print, no library) of one report: title, branding, period, summary and the actual table rows. */
async function exportPdf(pool, name, query) {
  if (!LOADERS[name]) throw badRequest('Unknown report.');
  const r = resolveRange(query);
  const out = await LOADERS[name](pool, r);
  const rows = out.table.rows;
  const columns = out.table.columns;
  const totals = out.table.totals;
  const doc = new pdf.PdfDoc();
  const M = pdf.M, contentW = pdf.PAGE_W - 2 * M;
  const colW = contentW / columns.length;
  const p = doc.cur();
  const gen = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const period = r.from === r.to ? r.from : r.from + ' to ' + r.to;
  p.text(M, pdf.PAGE_H - M - 22, 16, 'TransitPass', 'Helvetica');
  p.text(M, pdf.PAGE_H - M - 42, 12.5, TITLES[name], 'Helvetica');
  p.text(M, pdf.PAGE_H - M - 58, 9, `Generated ${gen} · Period: ${period} (${r.period})`, 'Helvetica');
  let y = pdf.PAGE_H - M - 82;
  p.text(M, y, 9, 'Summary', 'Helvetica'); y -= 13;
  for (const c of out.cards) {
    const line = c.label + ': ' + c.value + (c.note ? ' · ' + c.note : '');
    for (const wrapped of pdf.wrap(line, contentW, 8)) { p.text(M, y, 8, wrapped); y -= 10; }
    y -= 3;
  }
  y -= 7;
  const drawHeader = () => {
    p.text(M, y, 8.5, 'Records', 'Helvetica'); y -= 13;
    let x = M;
    for (const c of columns) { p.text(x, y, 7.5, c.header, 'Helvetica'); x += colW; }
    y -= 10;
    p.line(M, y, M + contentW, y); y -= 8;
  };
  drawHeader();
  const cellText = (v) => v === undefined || v === null ? '' : String(v);
  for (const row of rows) {
    if (y < M + 34) { doc.newPage(); const np = doc.cur(); y = pdf.PAGE_H - M - 34; let x = M; for (const c of columns) { np.text(x, y, 7.5, c.header, 'Helvetica'); x += colW; } y -= 10; np.line(M, y, M + contentW, y); y -= 8; }
    let x = M;
    for (const c of columns) {
      const v = cellText(row[c.key]);
      const max = colW - 6;
      let txt = v;
      while (pdf.textWidth(txt, 7) > max && txt.length > 1) txt = txt.slice(0, -1);
      if (txt !== v) txt = txt.slice(0, txt.length - 1) + '…';
      p.text(x, y, 7, txt, 'Helvetica');
      x += colW;
    }
    y -= 9;
  }
  if (totals) {
    if (y < M + 30) { doc.newPage(); y = pdf.PAGE_H - M - 30; }
    p.text(M, y, 7.5, 'TOTAL (' + (totals.label || 'records') + ')', 'Helvetica'); y -= 10;
    let x = M;
    for (const c of columns) {
      const v = totals[c.key] === undefined ? '' : String(totals[c.key]);
      p.text(x, y, 7, v, 'Helvetica');
      x += colW;
    }
    y -= 9;
  }
  const total = doc.pageCount();
  return { body: doc.buffer(total), count: rows.length, filename: `transitpass-${name}-${r.from}${r.from === r.to ? '' : '_to_' + r.to}.pdf`, range: r.label };
}

module.exports = { run, overview, exportCsv, exportPdf, resolveRange, REPORT_NAMES, TITLES, SCREEN_ROWS };
