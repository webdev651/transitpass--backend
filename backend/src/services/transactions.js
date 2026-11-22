"use strict";
/*
  Transaction Management (administrator). A "transaction" is a granted / review row of `scans`, exactly as in the dashboard and
  in Refunds & Cancellations; nothing is copied or stored again. This module only READS (list, details, totals, CSV, report):
  cancelling and refunding stay in services/refunds.js.

  Status of a transaction:
    cancelled  - it has a row in transaction_cancellations
    refunded   - not cancelled, and a refund request for it was approved
    completed  - everything else (a ride that is under review is still a charged ride; it carries an "under review" flag)
  A transaction that was refunded and later cancelled counts as cancelled (the cancellation voids it); its refund stays visible in the details.

  Totals: completed count / revenue / discounts exclude cancelled and refunded transactions; those two are totalled separately.
  Revenue = the fare actually charged (scans.fare_amount, i.e. the final fare after the discount of the fare rule that priced the ride).
  Fares come from what each scan stored when it was priced (fare_rule_id -> fare_rules); past rides are never re-priced.
*/
const { toDate, displayParts, localParts } = require("../lib/time");
const { dayStartUtc } = require("../lib/dates");
const { txnReference } = require("../lib/studentStatus");
const { round2 } = require("../lib/fare");
const { notFound } = require("../lib/httpError");
const { escapeLike } = require("../lib/sql");
const csv = require("../lib/csv");

const REPORT_MAX = 5000; // rows in one printed report
const EXPORT_MAX = 50000; // rows in one CSV file
const STATUS_LABEL = {
  completed: "Completed",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

// joins used by every query; c = cancellation, ra = the approved refund (if any)
const J_STATUS = `FROM scans s
  LEFT JOIN transaction_cancellations c ON c.scan_id = s.id
  LEFT JOIN refund_requests ra ON ra.id = (SELECT MAX(r2.id) FROM refund_requests r2 WHERE r2.scan_id = s.id AND r2.status = 'approved')`;
const J_LIST = `${J_STATUS}
  LEFT JOIN transit_routes tr ON tr.id = s.route_id`;
const J_DETAIL = `${J_LIST}
  LEFT JOIN students st ON st.id = s.student_id
  LEFT JOIN admins dr ON dr.id = s.scanned_by
  LEFT JOIN fare_rules fr ON fr.id = s.fare_rule_id`;
const COLS = `s.*, c.id AS cancel_id, c.created_at AS cancelled_at, c.reason AS cancel_reason, c.cancelled_by_name,
  ra.id AS refund_id, ra.amount AS refund_amount, ra.reason AS refund_reason, ra.decision_reason AS refund_decision_reason,
  ra.decided_by_name AS refund_decided_by, ra.decided_at AS refund_decided_at, ra.requested_by_name AS refund_requested_by, tr.name AS tr_name,
  (SELECT COUNT(*) FROM refund_requests r3 WHERE r3.scan_id = s.id AND r3.status = 'pending') AS refund_pending`;
const COLS_DETAIL = `${COLS},
  st.school AS st_school, st.program AS st_program, st.level AS st_level, st.email AS st_email, st.phone AS st_phone, st.status AS st_status,
  dr.username AS dr_username, dr.email AS dr_email, dr.phone AS dr_phone, dr.unit AS dr_unit,
  tr.origin AS tr_origin, tr.destination AS tr_destination,
  fr.regular_fare AS fr_regular, fr.discount_percent AS fr_percent, fr.route_id AS fr_route_id`;

const iso = (v) => (v ? toDate(v).toISOString() : null);
const statusOf = (r) =>
  r.cancel_id ? "cancelled" : r.refund_id ? "refunded" : "completed";
const SQL_COMPLETED = "c.id IS NULL AND ra.id IS NULL";

/**
 * WHERE clause + arguments for the filters. `withStatus` is false for the totals, so the three groups can always be shown side by side.
 * Search matches the transaction reference (full or partial, e.g. TXN-00000012 or 12), the student's name and the School ID.
 */
function where(
  { q, driverId, routeId, from, to, status },
  { withStatus = true } = {},
) {
  const w = ["s.result IN ('granted','review')"];
  const a = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    w.push(
      "(CONCAT('TXN-', LPAD(s.id, 8, '0')) LIKE ? OR s.student_name LIKE ? OR s.school_id LIKE ?)",
    );
    a.push(like, like, like);
  }
  if (driverId) {
    w.push("s.scanned_by = ?");
    a.push(driverId);
  }
  if (routeId) {
    // rides priced after fare rules were introduced carry route_id; older rides only have the route's name
    w.push(
      "(s.route_id = ? OR (s.route_id IS NULL AND s.route = (SELECT name FROM transit_routes WHERE id = ?)))",
    );
    a.push(routeId, routeId);
  }
  if (from) {
    w.push("s.scanned_at >= ?");
    a.push(dayStartUtc(from));
  }
  if (to) {
    w.push("s.scanned_at < ?");
    a.push(new Date(dayStartUtc(to).getTime() + 86400000));
  }
  if (withStatus && status === "cancelled") w.push("c.id IS NOT NULL");
  if (withStatus && status === "refunded")
    w.push("c.id IS NULL AND ra.id IS NOT NULL");
  if (withStatus && status === "completed") w.push(SQL_COMPLETED);
  return { clause: `WHERE ${w.join(" AND ")}`, args: a };
}

/** One row of the list / report / CSV. */
function item(r) {
  const at = toDate(r.scanned_at);
  const { date, time } = displayParts(at);
  const final = Number(r.fare_amount),
    discount = Number(r.discount_amount),
    regular = round2(final + discount);
  const status = statusOf(r);
  return {
    id: r.id,
    reference: txnReference(r.id),
    status,
    statusLabel: STATUS_LABEL[status],
    underReview: r.result === "review",
    offline: !!r.offline,
    studentId: r.student_id || null,
    studentName: r.student_name || "—",
    schoolId: r.school_id || "—",
    driverId: r.scanned_by || null,
    driver: r.driver_name || "—",
    route: r.tr_name || r.route,
    routeId: r.route_id || null, // the route's name when the ride is tied to one, else the service text the scanner stored
    regularFare: regular,
    discountPercent: regular > 0 ? round2((discount / regular) * 100) : 0,
    discountAmount: discount,
    finalFare: final,
    scannedAt: at.toISOString(),
    date,
    time,
    cancelReason: r.cancel_reason || null,
    refundAmount: r.refund_id ? Number(r.refund_amount) : null,
  };
}

/**
 * Complete details of one transaction. The fares are the ones stored on the scan when it was priced (fare_amount + discount_amount);
 * the rule is only identified by its id. Editing a fare rule later never changes what a past transaction shows.
 */
function detail(r) {
  const base = item(r);
  const rule = r.fare_rule_id
    ? {
        id: Number(r.fare_rule_id),
        regularFare: base.regularFare,
        discountPercent: base.discountPercent,
        appliesToRoute: r.fr_route_id ? true : false,
      }
    : null;
  return {
    ...base,
    student: {
      id: r.student_id || null,
      schoolId: base.schoolId,
      name: base.studentName,
      school: r.st_school || null,
      program: r.st_program || null,
      level: r.st_level || null,
      email: r.st_email || null,
      phone: r.st_phone || null,
      status: r.st_status || null,
    },
    driverInfo: {
      id: r.scanned_by || null,
      name: base.driver,
      username: r.dr_username || null,
      email: r.dr_email || null,
      phone: r.dr_phone || null,
      unit: r.dr_unit || null,
    },
    service: {
      service: r.route,
      routeName: r.tr_name || null,
      origin: r.tr_origin || null,
      destination: r.tr_destination || null,
      operator: r.operator,
      method: r.scan_method === "manual" ? "Manual ID entry" : "QR scan",
      fareLabel: r.fare,
      reason: r.reason || null,
      fareRule: rule,
    },
    cancellation: r.cancel_id
      ? {
          reason: r.cancel_reason,
          cancelledBy: r.cancelled_by_name,
          cancelledAt: iso(r.cancelled_at),
        }
      : null,
    refund: r.refund_id
      ? {
          id: r.refund_id,
          amount: Number(r.refund_amount),
          reason: r.refund_reason,
          requestedBy: r.refund_requested_by,
          decisionNote: r.refund_decision_reason || null,
          decidedBy: r.refund_decided_by,
          decidedAt: iso(r.refund_decided_at),
        }
      : null,
    refundPending: Number(r.refund_pending) > 0,
  };
}

/** Totals for the filters (all pages). Completed figures leave out cancelled and refunded transactions, which are totalled separately. */
async function summary(pool, f) {
  const { clause, args } = where(f, { withStatus: false });
  const done = `(${SQL_COMPLETED})`,
    canc = "(c.id IS NOT NULL)",
    refd = "(c.id IS NULL AND ra.id IS NOT NULL)";
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(${done}), 0) AS done_n, COALESCE(SUM(CASE WHEN ${done} THEN s.fare_amount END), 0) AS done_revenue,
            COALESCE(SUM(CASE WHEN ${done} THEN s.discount_amount END), 0) AS done_discount,
            COALESCE(SUM(CASE WHEN ${done} THEN s.fare_amount + s.discount_amount END), 0) AS done_regular,
            COALESCE(SUM(${canc}), 0) AS canc_n, COALESCE(SUM(CASE WHEN ${canc} THEN s.fare_amount END), 0) AS canc_value,
            COALESCE(SUM(${refd}), 0) AS ref_n, COALESCE(SUM(CASE WHEN ${refd} THEN s.fare_amount END), 0) AS ref_value,
            COALESCE(SUM(CASE WHEN ${refd} THEN ra.amount END), 0) AS ref_amount
       ${J_STATUS} ${clause}`,
    args,
  );
  return {
    all: Number(t.n),
    completed: {
      count: Number(t.done_n),
      revenue: round2(Number(t.done_revenue)),
      regularFare: round2(Number(t.done_regular)),
      discounts: round2(Number(t.done_discount)),
    },
    cancelled: {
      count: Number(t.canc_n),
      fareValue: round2(Number(t.canc_value)),
    },
    refunded: {
      count: Number(t.ref_n),
      fareValue: round2(Number(t.ref_value)),
      refundedAmount: round2(Number(t.ref_amount)),
    },
  };
}

/** The list, one page, with the totals for the same filters. */
async function list(pool, f) {
  const { clause, args } = where(f);
  const [[c]] = await pool.query(
    `SELECT COUNT(*) AS n ${J_STATUS} ${clause}`,
    args,
  ); // the route name is not needed to count
  const [rows] = await pool.query(
    `SELECT ${COLS} ${J_LIST} ${clause} ORDER BY s.scanned_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    [...args, f.limit, f.offset],
  );
  return {
    items: rows.map(item),
    total: Number(c.n),
    limit: f.limit,
    offset: f.offset,
    summary: await summary(pool, f),
  };
}

async function one(pool, id) {
  const [rows] = await pool.query(
    `SELECT ${COLS_DETAIL} ${J_DETAIL} WHERE s.id = ? AND s.result IN ('granted','review')`,
    [id],
  );
  if (!rows[0]) throw notFound("Transaction not found");
  return detail(rows[0]);
}

/** A printable receipt for one transaction: real-time data from the database, nothing hardcoded. */
async function receipt(pool, id) {
  const d = await one(pool, id);
  const money = (n) => (n == null ? '' : Number(n).toFixed(2));
  return {
    system: 'TransitPass',
    reference: d.reference,
    status: d.status,
    statusLabel: d.statusLabel,
    scannedAt: d.scannedAt,
    date: d.date,
    time: d.time,
    student: {
      id: d.student.id == null ? null : Number(d.student.id),
      name: d.student.name || '—',
      schoolId: d.student.schoolId || '—'
    },
    driver: {
      id: d.driverInfo.id == null ? null : Number(d.driverInfo.id),
      name: d.driverInfo.name || '—'
    },
    service: d.route || '—',
    route: d.service.routeName || null,
    origin: d.service.origin || null,
    destination: d.service.destination || null,
    operator: d.service.operator || '—',
    method: d.service.method || '—',
    regularFare: d.regularFare,
    discountPercent: d.discountPercent,
    discountAmount: d.discountAmount,
    finalFare: d.finalFare,
    money: { regular: money(d.regularFare), discount: money(d.discountAmount), final: money(d.finalFare) },
    cancelled: !!d.cancellation,
    refunded: !!d.refund,
    underReview: d.underReview === true
  };
}

/** Everything the filters match (newest first), up to `max` rows. */
async function all(pool, f, max) {
  const { clause, args } = where(f);
  const [rows] = await pool.query(
    `SELECT ${COLS} ${J_LIST} ${clause} ORDER BY s.scanned_at DESC, s.id DESC LIMIT ?`,
    [...args, max],
  );
  return rows.map(item);
}

/** Dropdown choices: every driver account and every route. */
async function filterOptions(pool) {
  const [drivers] = await pool.query(
    "SELECT id, name, status FROM admins WHERE role = 'driver' ORDER BY name, id",
  );
  const [routes] = await pool.query(
    "SELECT id, name, status FROM transit_routes ORDER BY name, id",
  );
  return {
    drivers: drivers.map((d) => ({ id: d.id, name: d.name, status: d.status })),
    routes: routes.map((r) => ({ id: r.id, name: r.name, status: r.status })),
  };
}

/** What is being filtered, in words (printed at the top of a report). */
async function describeFilters(pool, f) {
  const out = [];
  if (f.q) out.push(`Search: "${f.q}"`);
  if (f.driverId) {
    const [[d]] = await pool.query("SELECT name FROM admins WHERE id = ?", [
      f.driverId,
    ]);
    out.push(`Driver: ${d ? d.name : `#${f.driverId}`}`);
  }
  if (f.routeId) {
    const [[r]] = await pool.query(
      "SELECT name FROM transit_routes WHERE id = ?",
      [f.routeId],
    );
    out.push(`Route: ${r ? r.name : `#${f.routeId}`}`);
  }
  if (f.from || f.to)
    out.push(`Dates: ${f.from || "start"} to ${f.to || "today"}`);
  if (f.status && f.status !== "all")
    out.push(`Status: ${STATUS_LABEL[f.status]}`);
  return out;
}

/** Data for the printable report. */
async function report(pool, f) {
  const [items, sum, filters] = await Promise.all([
    all(pool, f, REPORT_MAX),
    summary(pool, f),
    describeFilters(pool, f),
  ]);
  const total =
    f.status && f.status !== "all"
      ? sum[f.status === "completed" ? "completed" : f.status].count
      : sum.all;
  return {
    generatedAt: new Date().toISOString(),
    filters,
    summary: sum,
    items,
    total,
    truncated: total > items.length,
    maxRows: REPORT_MAX,
  };
}

const isoDate = (d) => {
  const p = localParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};
const hhmmss = (d) => {
  const p = localParts(d);
  return [p.hour, p.minute, p.second]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
};
const money = (n) => (n == null ? "" : Number(n).toFixed(2));
const remarks = (t) =>
  t.status === "cancelled"
    ? `Cancelled: ${t.cancelReason}`
    : t.status === "refunded"
      ? `Refunded ${money(t.refundAmount)}`
      : t.underReview
        ? "Under review (full fare charged)"
        : "";
const COLUMNS = [
  { header: "Reference No.", value: (t) => t.reference },
  { header: "Date", value: (t) => isoDate(new Date(t.scannedAt)) },
  { header: "Time", value: (t) => hhmmss(new Date(t.scannedAt)) },
  { header: "Status", value: (t) => t.statusLabel },
  { header: "Student Name", value: (t) => t.studentName },
  { header: "Student ID", value: (t) => t.schoolId },
  { header: "Driver", value: (t) => t.driver },
  { header: "Route / Service", value: (t) => t.route },
  { header: "Regular Fare", value: (t) => t.regularFare },
  { header: "Discount %", value: (t) => t.discountPercent },
  { header: "Discount Amount", value: (t) => t.discountAmount },
  { header: "Final Fare", value: (t) => t.finalFare },
  {
    header: "Refunded Amount",
    value: (t) => (t.refundAmount == null ? "" : t.refundAmount),
  },
  { header: "Remarks", value: remarks },
];

/** The CSV file (for Excel) for the filters. */
async function exportCsv(pool, f) {
  const rows = await all(pool, f, EXPORT_MAX);
  return {
    body: csv.build(COLUMNS, rows),
    count: rows.length,
    filename: `transactions-${isoDate(new Date()).replace(/-/g, "")}.csv`,
  };
}

module.exports = {
  list,
  one,
  receipt,
  summary,
  report,
  exportCsv,
  filterOptions,
  where,
  item,
  detail,
  all,
  J_STATUS,
  J_LIST,
  SQL_COMPLETED,
  COLUMNS,
  REPORT_MAX,
  EXPORT_MAX,
};
