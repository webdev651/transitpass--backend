'use strict';
/*
  Numbers for the administrator dashboard. Everything is counted live from the existing tables
  (students, student_verifications, qr_codes, admins, scans); nothing is stored or hardcoded.

  "Transaction" = a ride that was charged a fare: a scan that was granted (discount applied) or sent to review (full fare).
  Denied scans (invalid / expired QR ...) never became a ride, so they are in Scan History but not counted here.
*/
const { startOfLocalDay, tzOffsetMinutes, localParts, toDate, displayParts } = require('../lib/time');
const { round2 } = require('../lib/fare');
const { txnReference } = require('../lib/studentStatus');
const { notFound } = require('../lib/httpError');
const { escapeLike } = require('../lib/sql');

const DAY = 86400000;
const RIDE = "result IN ('granted','review')";
// A COMPLETED transaction: a ride that was neither cancelled nor refunded. Dashboard totals / charts count only these, exactly like
// Transaction Management and the reports (a cancelled or refunded ride is never counted as a completed ride or as a discount given).
const DONE = `${RIDE} AND NOT EXISTS (SELECT 1 FROM transaction_cancellations c WHERE c.scan_id = scans.id)
  AND NOT EXISTS (SELECT 1 FROM refund_requests r WHERE r.scan_id = scans.id AND r.status = 'approved')`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** Today's local calendar date as a UTC-midnight Date, so day arithmetic is plain +/- 86400000. */
function localToday(now) { const p = localParts(now); return new Date(Date.UTC(p.year, p.month - 1, p.day)); }
const fmt = (d) => ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
/** The UTC instant at which the given local calendar day (a UTC-midnight Date) starts. */
const dayStart = (d) => startOfLocalDay(new Date(d.getTime() + 12 * 3600000));

async function summary(pool, now = new Date()) {
  const todayStart = startOfLocalDay(now);
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const [[st]] = await pool.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(COALESCE(v.verification_status, 'pending') = 'verified'), 0) AS verified,
            COALESCE(SUM(COALESCE(v.verification_status, 'pending') = 'pending'), 0) AS pending,
            COALESCE(SUM(s.created_at >= ?), 0) AS new_week
       FROM students s LEFT JOIN student_verifications v ON v.student_id = s.id`, [weekAgo]);
  const [[qr]] = await pool.query("SELECT COUNT(*) AS n FROM qr_codes WHERE status = 'active' AND expires_at > ?", [now]);
  const [[dr]] = await pool.query("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'active'), 0) AS active FROM admins WHERE role = 'driver'");
  const [[tx]] = await pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(discount_amount), 0) AS discount,
                                          COALESCE(SUM(scanned_at >= ?), 0) AS today, COALESCE(SUM(CASE WHEN scanned_at >= ? THEN discount_amount ELSE 0 END), 0) AS discount_today
                                     FROM scans WHERE ${DONE}`, [todayStart, todayStart]);
  return {
    asOf: now.toISOString(),
    stats: {
      totalStudents: Number(st.total),
      verifiedStudents: Number(st.verified),
      pendingApplications: Number(st.pending),
      activeQrCodes: Number(qr.n),
      totalDrivers: Number(dr.total),
      totalTransactions: Number(tx.n),
      totalDiscounts: round2(Number(tx.discount))
    },
    notes: {
      newStudentsThisWeek: Number(st.new_week),
      activeDrivers: Number(dr.active),
      transactionsToday: Number(tx.today),
      discountsToday: round2(Number(tx.discount_today))
    }
  };
}

/** ride count + discount per local day / ISO week / month, with empty buckets filled in with zeros. */
async function charts(pool, now = new Date()) {
  const off = tzOffsetMinutes(now);
  const today = localToday(now);

  const days = Array.from({ length: 14 }, (_, i) => new Date(today.getTime() - (13 - i) * DAY));
  const mondayOf = (d) => new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
  const thisMonday = mondayOf(today);
  const weeks = Array.from({ length: 8 }, (_, i) => new Date(thisMonday.getTime() - (7 - i) * 7 * DAY));
  const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (11 - i), 1)));

  const L = 'DATE_ADD(scanned_at, INTERVAL ? MINUTE)';
  const [dMap, wMap, mMap] = await Promise.all([
    pool.query(`SELECT DATE_FORMAT(${L}, '%Y-%m-%d') AS k, COUNT(*) AS n, COALESCE(SUM(discount_amount), 0) AS d FROM scans WHERE ${DONE} AND scanned_at >= ? GROUP BY k`, [off, dayStart(days[0])]).then(([r]) => new Map(r.map((x) => [x.k, x]))),
    pool.query(`SELECT DATE_FORMAT(DATE_SUB(DATE(${L}), INTERVAL WEEKDAY(${L}) DAY), '%Y-%m-%d') AS k, COUNT(*) AS n, COALESCE(SUM(discount_amount), 0) AS d FROM scans WHERE ${DONE} AND scanned_at >= ? GROUP BY k`, [off, off, dayStart(weeks[0])]).then(([r]) => new Map(r.map((x) => [x.k, x]))),
    pool.query(`SELECT DATE_FORMAT(${L}, '%Y-%m') AS k, COUNT(*) AS n, COALESCE(SUM(discount_amount), 0) AS d FROM scans WHERE ${DONE} AND scanned_at >= ? GROUP BY k`, [off, dayStart(months[0])]).then(([r]) => new Map(r.map((x) => [x.k, x])))
  ]);
  const val = (map, key) => { const r = map.get(key); return { transactions: r ? Number(r.n) : 0, discount: r ? round2(Number(r.d)) : 0 }; };

  const daily = days.map((d) => ({ date: fmt(d), label: `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`, ...val(dMap, fmt(d)) }));
  const weekly = weeks.map((d) => {
    const end = new Date(d.getTime() + 6 * DAY);
    return { start: fmt(d), end: fmt(end), label: `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`, ...val(wMap, fmt(d)) };
  });
  const monthly = months.map((d) => {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return { month: key, label: `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`, ...val(mMap, key) };
  });
  const sum = (a) => a.reduce((t, x) => t + x.transactions, 0);
  const last2 = (a) => ({ current: a[a.length - 1].transactions, previous: a[a.length - 2].transactions });
  return {
    daily: { items: daily, total: sum(daily), ...last2(daily) },
    weekly: { items: weekly, total: sum(weekly), ...last2(weekly) },
    monthly: { items: monthly, total: sum(monthly), ...last2(monthly) },
    discounts: await discounts(pool, now)
  };
}

async function discounts(pool, now) {
  const todayStart = startOfLocalDay(now);
  const lp = localParts(now);
  const monthStart = startOfLocalDay(new Date(Date.UTC(lp.year, lp.month - 1, 1, 12)));
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS rides, COALESCE(SUM(discount_amount > 0), 0) AS discounted, COALESCE(SUM(discount_amount), 0) AS total,
            COALESCE(SUM(CASE WHEN scanned_at >= ? THEN discount_amount ELSE 0 END), 0) AS today,
            COALESCE(SUM(CASE WHEN scanned_at >= ? THEN discount_amount ELSE 0 END), 0) AS month,
            COUNT(DISTINCT CASE WHEN discount_amount > 0 THEN student_id END) AS students_using
       FROM scans WHERE ${DONE}`, [todayStart, monthStart]);
  const [[e]] = await pool.query(
    `SELECT COUNT(*) AS n FROM students s JOIN student_verifications v ON v.student_id = s.id
      WHERE v.verification_status = 'verified' AND s.status = 'active' AND s.discount_eligible = 1`);
  const rides = Number(t.rides), discounted = Number(t.discounted), eligible = Number(e.n), using = Number(t.students_using);
  return {
    totalDiscount: round2(Number(t.total)), todayDiscount: round2(Number(t.today)), monthDiscount: round2(Number(t.month)),
    totalRides: rides, discountedRides: discounted, fullFareRides: rides - discounted,
    rideUtilization: rides ? Math.round((discounted / rides) * 100) : 0,          // % of rides that got the discount
    averageDiscount: discounted ? round2(Number(t.total) / discounted) : 0,
    eligibleStudents: eligible, studentsUsingDiscount: using,
    studentUtilization: eligible ? Math.min(100, Math.round((using / eligible) * 100)) : 0 // % of eligible students who have used it
  };
}

/* ---------- recent transactions ---------- */

const item = (r) => {
  const at = toDate(r.scanned_at);
  const { date, time } = displayParts(at);
  const final = Number(r.fare_amount), discount = Number(r.discount_amount);
  return {
    id: r.id, reference: txnReference(r.id),
    studentName: r.student_name || '—', schoolId: r.school_id || '—', driver: r.driver_name || '—',
    regularFare: round2(final + discount), discountAmount: discount, finalFare: final,
    scannedAt: at.toISOString(), date, time,
    status: r.result === 'granted' ? 'Completed' : 'Under review', statusKey: r.result === 'granted' ? 'completed' : 'review'
  };
};

async function transactions(pool, { q, limit, offset }) {
  const where = [RIDE];
  const args = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push("(CONCAT('TXN-', LPAD(id, 8, '0')) LIKE ? OR student_name LIKE ? OR school_id LIKE ? OR driver_name LIKE ?)");
    args.push(like, like, like, like);
  }
  const clause = where.join(' AND ');
  const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM scans WHERE ${clause}`, args);
  const [rows] = await pool.query(`SELECT * FROM scans WHERE ${clause} ORDER BY scanned_at DESC, id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { items: rows.map(item), total: Number(c.n), limit, offset };
}

async function transaction(pool, id) {
  const [rows] = await pool.query(`SELECT * FROM scans WHERE id = ? AND ${RIDE}`, [id]);
  if (!rows[0]) throw notFound('Transaction not found');
  const r = rows[0];
  const final = Number(r.fare_amount), discount = Number(r.discount_amount);
  return {
    ...item(r),
    discountPercent: final + discount > 0 ? Math.round((discount / (final + discount)) * 100) : 0,
    route: r.route, operator: r.operator, method: r.scan_method === 'manual' ? 'Manual ID entry' : 'QR scan',
    fareLabel: r.fare, reason: r.reason || null
  };
}

module.exports = { summary, charts, transactions, transaction };
