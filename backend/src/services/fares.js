"use strict";
/*
  Fare and discount rules. One row of fare_rules = a regular fare (for one route, or the default for every route), a student
  discount percentage, the dates the rule is in force, and on/off switches for the rule and for its discount.

  Which rule prices a ride:  the active rule for the driver's route that is in force today; if the route has none, the active
  default rule (route_id NULL); if there is none either, the original .env values (emergency fallback only, recorded in an inactive row).
  The scanners call forScanner() -> a plain { full, percent, ruleId } that lib/fare.js turns into the fare text and amounts.
*/
const { withTransaction } = require("../db");
const { todayYmd } = require("../lib/dates");
const { round2, envFare } = require("../lib/fare");
const { notFound, conflict } = require("../lib/httpError");
const { verifyPassword } = require("../lib/reauth");
const { escapeLike } = require("../lib/sql");

const ymd = (c) => `DATE_FORMAT(f.${c}, '%Y-%m-%d') AS ${c}`;
const SELECT = `SELECT f.id, f.route_id, f.regular_fare, f.discount_percent, f.discount_active, f.is_active, f.notes, f.created_at, f.updated_at,
    ${ymd("effective_from")}, ${ymd("effective_until")}, ${ymd("discount_start")}, ${ymd("discount_end")},
    r.name AS route_name, r.status AS route_status, ca.name AS created_by_name, ua.name AS updated_by_name
  FROM fare_rules f
  LEFT JOIN transit_routes r ON r.id = f.route_id
  LEFT JOIN admins ca ON ca.id = f.created_by
  LEFT JOIN admins ua ON ua.id = f.updated_by`;

/** State of the rule itself and of its discount, for the day `today` (YYYY-MM-DD strings compare correctly). */
function states(r, today) {
  const rule = !r.is_active
    ? "inactive"
    : r.effective_from > today
      ? "upcoming"
      : r.effective_until && r.effective_until < today
        ? "expired"
        : "current";
  const pct = Number(r.discount_percent);
  const discount =
    pct <= 0
      ? "none"
      : !r.discount_active
        ? "off"
        : r.discount_start && r.discount_start > today
          ? "scheduled"
          : r.discount_end && r.discount_end < today
            ? "expired"
            : "active";
  return { rule, discount };
}

const present = (r, today = todayYmd()) => {
  const st = states(r, today);
  const toIso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: r.id,
    routeId: r.route_id,
    routeName: r.route_id ? r.route_name : null,
    scope: r.route_id ? "route" : "default",
    regularFare: Number(r.regular_fare),
    discountPercent: Number(r.discount_percent),
    discountedFare: round2(
      Number(r.regular_fare) * (1 - Number(r.discount_percent) / 100),
    ),
    discountActive: !!r.discount_active,
    discountStart: r.discount_start || null,
    discountEnd: r.discount_end || null,
    effectiveFrom: r.effective_from,
    effectiveUntil: r.effective_until || null,
    isActive: !!r.is_active,
    state: st.rule,
    discountState: st.discount,
    notes: r.notes || null,
    createdBy: r.created_by_name || null,
    updatedBy: r.updated_by_name || null,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
};

async function getRow(db, id, lock = false) {
  const [rows] = await db.query(
    `${SELECT} WHERE f.id = ?${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  if (!rows[0]) throw notFound("Fare rule not found");
  return rows[0];
}

async function assertRoute(db, routeId) {
  if (routeId == null) return null;
  const [rows] = await db.query(
    "SELECT id, name FROM transit_routes WHERE id = ?",
    [routeId],
  );
  if (!rows[0]) throw notFound("That route does not exist");
  return rows[0];
}

/** Two active rules for the same route (or both defaults) may not cover the same day: that is what keeps "the correct fare" unambiguous. */
async function assertNoOverlap(conn, { routeId, from, until, ignoreId = 0 }) {
  const [rows] = await conn.query(
    `SELECT f.id, DATE_FORMAT(f.effective_from, '%Y-%m-%d') AS a, DATE_FORMAT(f.effective_until, '%Y-%m-%d') AS b FROM fare_rules f
      WHERE f.is_active = 1 AND ${routeId == null ? "f.route_id IS NULL" : "f.route_id = ?"} AND f.id <> ?
        AND f.effective_from <= COALESCE(?, '9999-12-31') AND COALESCE(f.effective_until, '9999-12-31') >= ? LIMIT 1 FOR UPDATE`,
    [...(routeId == null ? [] : [routeId]), ignoreId, until || null, from],
  );
  if (rows[0]) {
    throw conflict(
      `Another active fare for ${routeId == null ? "the default (all routes)" : "this route"} already covers these dates (rule #${rows[0].id}: ${rows[0].a} to ${rows[0].b || "no end date"}). Change its dates or deactivate it first.`,
    );
  }
}

/* ---------- reading ---------- */

async function list(pool, { route, state, q, limit, offset }) {
  const today = todayYmd();
  const where = [];
  const args = [];
  if (route === "default") where.push("f.route_id IS NULL");
  else if (route && route !== "all") {
    where.push("f.route_id = ?");
    args.push(Number(route));
  }
  if (state === "current") {
    where.push(
      "f.is_active = 1 AND f.effective_from <= ? AND (f.effective_until IS NULL OR f.effective_until >= ?)",
    );
    args.push(today, today);
  } else if (state === "upcoming") {
    where.push("f.is_active = 1 AND f.effective_from > ?");
    args.push(today);
  } else if (state === "expired") {
    where.push(
      "f.is_active = 1 AND f.effective_until IS NOT NULL AND f.effective_until < ?",
    );
    args.push(today);
  } else if (state === "inactive") where.push("f.is_active = 0");
  if (q) {
    where.push("(r.name LIKE ? OR f.notes LIKE ?)");
    const like = `%${escapeLike(q)}%`;
    args.push(like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM fare_rules f LEFT JOIN transit_routes r ON r.id = f.route_id ${clause}`,
    args,
  );
  const [rows] = await pool.query(
    `${SELECT} ${clause} ORDER BY (f.route_id IS NULL) DESC, r.name, f.effective_from DESC, f.id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );
  return { items: rows.map((r) => present(r, today)), total, today };
}

async function get(pool, id) {
  return present(await getRow(pool, id));
}

/* ---------- which rule prices a ride ---------- */

/** The rule in force on `day` for `routeId` (null = default only) -> { full, percent, ruleId, routeId, source }. Never throws for "no rule": falls back to .env. */
async function resolve(pool, { routeId = null, day = todayYmd() } = {}) {
  const [rows] = await pool.query(
    `SELECT f.id, f.route_id, f.regular_fare, f.discount_percent, f.discount_active,
            DATE_FORMAT(f.discount_start, '%Y-%m-%d') AS discount_start, DATE_FORMAT(f.discount_end, '%Y-%m-%d') AS discount_end
       FROM fare_rules f
      WHERE f.is_active = 1 AND f.effective_from <= ? AND (f.effective_until IS NULL OR f.effective_until >= ?)
        AND (f.route_id IS NULL${routeId == null ? "" : " OR f.route_id = ?"})
      ORDER BY (f.route_id IS NULL) ASC, f.effective_from DESC, f.id DESC LIMIT 1`,
    routeId == null ? [day, day] : [day, day, routeId],
  );
  const r = rows[0];
  if (r) {
    const on =
      !!r.discount_active &&
      (!r.discount_start || r.discount_start <= day) &&
      (!r.discount_end || r.discount_end >= day);
    return {
      full: Number(r.regular_fare),
      percent: on ? Number(r.discount_percent) : 0,
      ruleId: r.id,
      routeId,
      source: r.route_id ? "route" : "default",
    };
  }
  return ensureDefaultRule(pool, routeId, day);
}

/** Marks the inactive row that records the .env fallback fare, so scans priced by it still point at a real fare_rules row. */
const FALLBACK_NOTE =
  "Fallback fare (original .env settings) - recorded for rides priced while no rule was in force. Not a rule in force.";

/**
 * Nothing in force for this day. With an empty table the original .env fallback is used as is (ruleId null).
 * Once fare rules exist, every scan must still store a fare_rule_id, but a rule that was never configured by an administrator
 * must not become one that is "in force": a stored, active, open-ended default would overlap (and block) the rules the
 * administrator creates next, and would silently price rides after expired / before upcoming rules. So the .env values are kept
 * in one INACTIVE row (never applied by resolve(), never counted by the overlap check) and the scan points at it.
 * The rides are charged exactly the .env fare; the stored row records exactly that.
 */
async function ensureDefaultRule(pool, routeId, day) {
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM fare_rules");
  if (!n) return { ...envFare(), routeId };
  const env = envFare();
  const [existing] = await pool.query(
    "SELECT id FROM fare_rules WHERE is_active = 0 AND route_id IS NULL AND notes = ? AND regular_fare = ? AND discount_percent = ? ORDER BY id DESC LIMIT 1",
    [FALLBACK_NOTE, env.full, env.percent],
  );
  let ruleId = existing[0] ? existing[0].id : null;
  if (ruleId == null) {
    const [res] = await pool.query(
      "INSERT INTO fare_rules (route_id, regular_fare, discount_percent, discount_active, is_active, effective_from, notes) VALUES (NULL, ?, ?, 1, 0, ?, ?)",
      [env.full, env.percent, day, FALLBACK_NOTE],
    );
    ruleId = res.insertId;
  }
  return {
    full: env.full,
    percent: env.percent,
    ruleId,
    routeId,
    source: "env",
  };
}

/** The route a driver is working on: the route of their ongoing trip, else their only assigned active route, else none. */
async function routeForDriver(pool, driverId) {
  const [t] = await pool.query(
    "SELECT r.id, r.name FROM trips t JOIN transit_routes r ON r.id = t.route_id WHERE t.driver_id = ? AND t.status = 'ongoing' ORDER BY t.actual_start DESC, t.id DESC LIMIT 1",
    [driverId],
  );
  if (t[0]) return t[0];
  const [a] = await pool.query(
    "SELECT r.id, r.name FROM route_drivers d JOIN transit_routes r ON r.id = d.route_id WHERE d.driver_id = ? AND r.status = 'active' LIMIT 2",
    [driverId],
  );
  return a.length === 1 ? a[0] : null;
}

/** What the scanners call for every scan: { routeId, routeName, cfg } where cfg feeds lib/fare.js. Administrators (Verify Pass terminal) use the default rule. */
async function forScanner(pool, admin, now = new Date()) {
  const route =
    admin && admin.role === "driver"
      ? await routeForDriver(pool, admin.id)
      : null;
  const cfg = await resolve(pool, {
    routeId: route ? route.id : null,
    day: todayYmd(0, now),
  });
  return {
    routeId: route ? route.id : null,
    routeName: route ? route.name : null,
    cfg,
  };
}

/** The discount percentage students see on their dashboard (default rule: no route is known there). */
async function defaultPercent(pool) {
  return (await resolve(pool)).percent;
}

/** "What will be charged?" for the admin screen: the same resolver the scanner uses, plus the arithmetic. */
async function calculate(pool, { routeId = null, day = todayYmd() }) {
  const route = await assertRoute(pool, routeId);
  const cfg = await resolve(pool, { routeId, day });
  const paid = round2(cfg.full * (1 - cfg.percent / 100));
  return {
    day,
    routeId,
    routeName: route ? route.name : null,
    source: cfg.source,
    ruleId: cfg.ruleId,
    regularFare: cfg.full,
    discountPercent: cfg.percent,
    discountedFare: paid,
    discountAmount: round2(cfg.full - paid),
  };
}

async function summary(pool) {
  const today = todayYmd();
  const def = await resolve(pool);
  const [[r]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM transit_routes WHERE status = 'active') AS routes,
            (SELECT COUNT(DISTINCT f.route_id) FROM fare_rules f JOIN transit_routes t ON t.id = f.route_id
              WHERE t.status = 'active' AND f.is_active = 1 AND f.effective_from <= ? AND (f.effective_until IS NULL OR f.effective_until >= ?)) AS own,
            (SELECT COUNT(*) FROM fare_rules WHERE is_active = 1 AND effective_from > ?) AS upcoming`,
    [today, today, today],
  );
  return {
    today,
    defaultFare: def.full,
    defaultPercent: def.percent,
    usingFallback: def.source === "env",
    activeRoutes: Number(r.routes),
    routesWithOwnFare: Number(r.own),
    upcoming: Number(r.upcoming),
  };
}

/* ---------- changing ---------- */

const cols = (d) => [
  d.routeId ?? null,
  d.regularFare,
  d.discountPercent,
  d.discountStart || null,
  d.discountEnd || null,
  d.effectiveFrom,
  d.effectiveUntil || null,
  d.notes || null,
];

async function create(pool, admin, d) {
  await verifyPassword(admin, d.password);
  const id = await withTransaction(pool, async (conn) => {
    await assertRoute(conn, d.routeId);
    if (d.isActive)
      await assertNoOverlap(conn, {
        routeId: d.routeId ?? null,
        from: d.effectiveFrom,
        until: d.effectiveUntil,
      });
    const [res] = await conn.query(
      `INSERT INTO fare_rules (route_id, regular_fare, discount_percent, discount_start, discount_end, effective_from, effective_until, notes, is_active, discount_active, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ...cols(d),
        d.isActive ? 1 : 0,
        d.discountActive ? 1 : 0,
        admin.id,
        admin.id,
      ],
    );
    return res.insertId;
  });
  return get(pool, id);
}

/** Edits the values of a rule (route, fare, discount, dates, notes). It only changes future rides: past scans keep the amounts they were charged. */
async function update(pool, admin, id, d) {
  await verifyPassword(admin, d.password);
  await withTransaction(pool, async (conn) => {
    const row = await getRow(conn, id, true);
    await assertRoute(conn, d.routeId);
    if (row.is_active)
      await assertNoOverlap(conn, {
        routeId: d.routeId ?? null,
        from: d.effectiveFrom,
        until: d.effectiveUntil,
        ignoreId: id,
      });
    await conn.query(
      `UPDATE fare_rules SET route_id = ?, regular_fare = ?, discount_percent = ?, discount_start = ?, discount_end = ?, effective_from = ?, effective_until = ?, notes = ?, updated_by = ? WHERE id = ?`,
      [...cols(d), admin.id, id],
    );
  });
  return get(pool, id);
}

/** Activates / deactivates the whole rule. Activating is refused if it would overlap another active rule for the same route. */
async function setActive(pool, admin, id, active, password) {
  await verifyPassword(admin, password);
  await withTransaction(pool, async (conn) => {
    const row = await getRow(conn, id, true);
    if (active && !row.is_active)
      await assertNoOverlap(conn, {
        routeId: row.route_id,
        from: row.effective_from,
        until: row.effective_until,
        ignoreId: id,
      });
    await conn.query(
      "UPDATE fare_rules SET is_active = ?, updated_by = ? WHERE id = ?",
      [active ? 1 : 0, admin.id, id],
    );
  });
  return get(pool, id);
}

/** Switches only the student discount of a rule on or off (the regular fare stays in force). */
async function setDiscountActive(pool, admin, id, active, password) {
  await verifyPassword(admin, password);
  await getRow(pool, id);
  await pool.query(
    "UPDATE fare_rules SET discount_active = ?, updated_by = ? WHERE id = ?",
    [active ? 1 : 0, admin.id, id],
  );
  return get(pool, id);
}

module.exports = {
  list,
  get,
  summary,
  calculate,
  resolve,
  routeForDriver,
  forScanner,
  defaultPercent,
  create,
  update,
  setActive,
  setDiscountActive,
  present,
  getRow,
};
