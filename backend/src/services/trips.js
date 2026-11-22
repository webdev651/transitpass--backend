'use strict';
/*
  Trip management. A trip ties a route, a vehicle and a driver to a time window.
  Conflict rules (checked inside a transaction that locks the driver and vehicle rows, so two administrators
  cannot double-book at the same moment):
    - a driver cannot have two trips whose time windows overlap (scheduled / ongoing trips only)
    - a vehicle cannot have two trips whose time windows overlap
    - a driver or vehicle cannot start a trip while another trip of theirs is ongoing
  Other rules: the route, vehicle and driver must be active; when a route has vehicles / drivers assigned to it, the trip
  must use one of them.
*/
const { withTransaction } = require('../db');
const { notFound, conflict, badRequest } = require('../lib/httpError');
const { escapeLike } = require('../lib/sql');
const { toDate, localParts } = require('../lib/time');
const { dayStartUtc, isRealDate } = require('../lib/dates');

const iso = (v) => (v ? toDate(v).toISOString() : null);
const BASE = `SELECT t.*, r.name AS route_name, r.origin, r.destination, v.name AS vehicle_name, v.plate_number, a.name AS driver_name,
                     (SELECT COUNT(*) FROM scans s WHERE s.scanned_by = t.driver_id AND s.result IN ('granted','review')
                         AND s.scanned_at >= COALESCE(t.actual_start, t.start_time) AND s.scanned_at <= COALESCE(t.actual_end, t.end_time, UTC_TIMESTAMP(3))
                         AND t.status IN ('ongoing','completed')) AS scanned
                FROM trips t JOIN transit_routes r ON r.id = t.route_id JOIN vehicles v ON v.id = t.vehicle_id JOIN admins a ON a.id = t.driver_id`;

const present = (r) => ({
  id: r.id, routeId: r.route_id, route: r.route_name, origin: r.origin, destination: r.destination, vehicleId: r.vehicle_id, vehicle: r.vehicle_name, plateNumber: r.plate_number,
  driverId: r.driver_id, driver: r.driver_name, startTime: iso(r.start_time), endTime: iso(r.end_time), actualStart: iso(r.actual_start), actualEnd: iso(r.actual_end),
  status: r.status, passengerCount: r.passenger_count, scannedPassengers: Number(r.scanned || 0), notes: r.notes, cancelReason: r.cancel_reason, createdAt: iso(r.created_at)
});
async function getRow(db, id) {
  const [rows] = await db.query(`${BASE} WHERE t.id = ?`, [id]);
  if (!rows[0]) throw notFound('Trip not found');
  return rows[0];
}

const FAR = new Date('9999-12-31T00:00:00Z');
/** Another scheduled/ongoing trip of this driver or vehicle whose window overlaps [start, end). */
async function findConflict(conn, col, id, start, end, selfId = 0) {
  const [rows] = await conn.query(
    `SELECT t.id, t.start_time, t.end_time, t.status FROM trips t
      WHERE t.${col} = ? AND t.id <> ? AND t.status IN ('scheduled','ongoing') AND t.start_time < ? AND COALESCE(t.end_time, ?) > ? LIMIT 1`,
    [id, selfId, end || FAR, FAR, start]);
  return rows[0] || null;
}
const when = (d) => toDate(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Validates and locks everything a trip depends on. Throws 400/404/409 with a plain explanation. */
async function check(conn, { routeId, vehicleId, driverId, start, end }, selfId = 0) {
  if (!(end > start)) throw badRequest('The trip must end after it starts.');
  const [r] = await conn.query('SELECT * FROM transit_routes WHERE id = ? FOR UPDATE', [routeId]);
  if (!r[0]) throw notFound('Route not found');
  if (r[0].status !== 'active') throw conflict('This route is inactive.');
  const [v] = await conn.query('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [vehicleId]);
  if (!v[0]) throw notFound('Vehicle not found');
  if (v[0].status !== 'active') throw conflict(`This vehicle is ${v[0].status} and cannot take trips.`);
  const [d] = await conn.query("SELECT * FROM admins WHERE id = ? AND role = 'driver' FOR UPDATE", [driverId]);
  if (!d[0]) throw notFound('Driver not found');
  if (d[0].status !== 'active') throw conflict('This driver account is not active.');
  const [[rv]] = await conn.query('SELECT COUNT(*) AS n, COALESCE(SUM(vehicle_id = ?), 0) AS hit FROM route_vehicles WHERE route_id = ?', [vehicleId, routeId]);
  if (Number(rv.n) > 0 && !Number(rv.hit)) throw conflict('This vehicle is not assigned to the route. Assign it to the route first.');
  const [[rd]] = await conn.query('SELECT COUNT(*) AS n, COALESCE(SUM(driver_id = ?), 0) AS hit FROM route_drivers WHERE route_id = ?', [driverId, routeId]);
  if (Number(rd.n) > 0 && !Number(rd.hit)) throw conflict('This driver is not assigned to the route. Assign them to the route first.');
  const dc = await findConflict(conn, 'driver_id', driverId, start, end, selfId);
  if (dc) throw conflict(`${d[0].name} already has trip #${dc.id} (${dc.status}) from ${when(dc.start_time)}. Choose another driver or time.`);
  const vc = await findConflict(conn, 'vehicle_id', vehicleId, start, end, selfId);
  if (vc) throw conflict(`${v[0].name} is already on trip #${vc.id} (${vc.status}) from ${when(vc.start_time)}. Choose another vehicle or time.`);
}

async function create(pool, admin, d) {
  const id = await withTransaction(pool, async (conn) => {
    await check(conn, { routeId: d.routeId, vehicleId: d.vehicleId, driverId: d.driverId, start: d.startTime, end: d.endTime });
    const [res] = await conn.query(
      'INSERT INTO trips (route_id, vehicle_id, driver_id, start_time, end_time, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [d.routeId, d.vehicleId, d.driverId, d.startTime, d.endTime, d.notes || null, admin.id]);
    return res.insertId;
  });
  return present(await getRow(pool, id));
}

async function update(pool, id, d) {
  await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM trips WHERE id = ? FOR UPDATE', [id]);
    const t = rows[0];
    if (!t) throw notFound('Trip not found');
    if (['completed', 'cancelled'].includes(t.status)) throw conflict(`A ${t.status} trip can no longer be changed.`);
    const next = {
      routeId: d.routeId ?? t.route_id, vehicleId: d.vehicleId ?? t.vehicle_id, driverId: d.driverId ?? t.driver_id,
      start: d.startTime ?? toDate(t.start_time), end: d.endTime ?? (t.end_time ? toDate(t.end_time) : null)
    };
    const planChanged = ['routeId', 'vehicleId', 'driverId', 'startTime', 'endTime'].some((k) => d[k] !== undefined);
    if (planChanged && t.status === 'ongoing') throw conflict('The plan of an ongoing trip cannot be changed. Complete or cancel it.');
    if (planChanged) await check(conn, next, id);
    await conn.query('UPDATE trips SET route_id = ?, vehicle_id = ?, driver_id = ?, start_time = ?, end_time = ?, notes = ?, passenger_count = ? WHERE id = ?',
      [next.routeId, next.vehicleId, next.driverId, next.start, next.end, d.notes !== undefined ? (d.notes || null) : t.notes, d.passengerCount ?? t.passenger_count, id]);
  });
  return present(await getRow(pool, id));
}

async function start(pool, id) {
  await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM trips WHERE id = ? FOR UPDATE', [id]);
    const t = rows[0];
    if (!t) throw notFound('Trip not found');
    if (t.status !== 'scheduled') throw conflict(`Only a scheduled trip can be started (this one is ${t.status}).`);
    for (const [col, label] of [['driver_id', 'driver'], ['vehicle_id', 'vehicle']]) {
      const [on] = await conn.query("SELECT id FROM trips WHERE ?? = ? AND status = 'ongoing' AND id <> ? LIMIT 1", [col, t[col], id]);
      if (on.length) throw conflict(`That ${label} is already on ongoing trip #${on[0].id}. Complete it first.`);
    }
    await conn.query("UPDATE trips SET status = 'ongoing', actual_start = ? WHERE id = ?", [new Date(), id]);
  });
  return present(await getRow(pool, id));
}

async function complete(pool, id, passengerCount) {
  await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM trips WHERE id = ? FOR UPDATE', [id]);
    const t = rows[0];
    if (!t) throw notFound('Trip not found');
    if (t.status !== 'ongoing') throw conflict(`Only an ongoing trip can be completed (this one is ${t.status}).`);
    const end = new Date();
    let count = passengerCount;
    if (count === undefined) { // default: the rides the driver verified during the trip
      const [[c]] = await conn.query("SELECT COUNT(*) AS n FROM scans WHERE scanned_by = ? AND result IN ('granted','review') AND scanned_at >= ? AND scanned_at <= ?", [t.driver_id, t.actual_start, end]);
      count = Number(c.n);
    }
    await conn.query("UPDATE trips SET status = 'completed', actual_end = ?, passenger_count = ? WHERE id = ?", [end, count, id]);
  });
  return present(await getRow(pool, id));
}

async function cancel(pool, id, reason) {
  await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM trips WHERE id = ? FOR UPDATE', [id]);
    const t = rows[0];
    if (!t) throw notFound('Trip not found');
    if (!['scheduled', 'ongoing'].includes(t.status)) throw conflict(`A ${t.status} trip cannot be cancelled.`);
    // actual_end is assigned BEFORE status: MySQL evaluates SET left to right, so IF(status = 'ongoing') still sees the old value.
    await conn.query("UPDATE trips SET actual_end = IF(status = 'ongoing', ?, actual_end), status = 'cancelled', cancel_reason = ? WHERE id = ?", [new Date(), reason, id]);
  });
  return present(await getRow(pool, id));
}

async function list(pool, { from, to, status, driverId, vehicleId, routeId, q, limit, offset }) {
  const where = [];
  const args = [];
  if (from) { where.push('t.start_time >= ?'); args.push(dayStartUtc(from)); }
  if (to) { where.push('t.start_time < ?'); args.push(new Date(dayStartUtc(to).getTime() + 86400000)); }
  if (status && status !== 'all') { where.push('t.status = ?'); args.push(status); }
  if (driverId) { where.push('t.driver_id = ?'); args.push(driverId); }
  if (vehicleId) { where.push('t.vehicle_id = ?'); args.push(vehicleId); }
  if (routeId) { where.push('t.route_id = ?'); args.push(routeId); }
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(r.name LIKE ? OR v.name LIKE ? OR v.plate_number LIKE ? OR a.name LIKE ?)'); args.push(like, like, like, like); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM trips t JOIN transit_routes r ON r.id = t.route_id JOIN vehicles v ON v.id = t.vehicle_id JOIN admins a ON a.id = t.driver_id ${clause}`, args);
  const [rows] = await pool.query(`${BASE} ${clause} ORDER BY t.start_time DESC, t.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { total: Number(total), items: rows.map(present) };
}

const pad = (n) => String(n).padStart(2, '0');
const localYmd = (d) => { const p = localParts(toDate(d)); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
const emptyTotals = () => ({ trips: 0, scheduled: 0, ongoing: 0, completed: 0, cancelled: 0, passengers: 0 });
function tally(t, row) { row.trips++; row[t.status]++; if (t.status === 'completed' || t.status === 'ongoing') row.passengers += t.passenger_count || Number(t.scanned || 0); }

/** Daily (one local day) or monthly (YYYY-MM, one row per day) trip monitoring. */
async function monitor(pool, { period, date }) {
  if (period === 'monthly') {
    if (!/^\d{4}-\d{2}$/.test(date)) throw badRequest('Use the month format YYYY-MM.');
    const [y, m] = date.split('-').map(Number);
    if (m < 1 || m > 12) throw badRequest('Use a real month.');
    const first = `${date}-01`;
    const nextFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
    const [rows] = await pool.query(`${BASE} WHERE t.start_time >= ? AND t.start_time < ?`, [dayStartUtc(first), dayStartUtc(nextFirst)]);
    const byDay = new Map();
    const totals = emptyTotals();
    rows.forEach((t) => { const k = localYmd(t.start_time); if (!byDay.has(k)) byDay.set(k, emptyTotals()); tally(t, byDay.get(k)); tally(t, totals); });
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { period, date, totals, rows: Array.from({ length: days }, (_, i) => { const k = `${date}-${pad(i + 1)}`; return { date: k, ...(byDay.get(k) || emptyTotals()) }; }) };
  }
  if (!isRealDate(date)) throw badRequest('Use the date format YYYY-MM-DD.');
  const [rows] = await pool.query(`${BASE} WHERE t.start_time >= ? AND t.start_time < ? ORDER BY t.start_time`, [dayStartUtc(date), new Date(dayStartUtc(date).getTime() + 86400000)]);
  const totals = emptyTotals();
  const byRoute = new Map();
  rows.forEach((t) => { tally(t, totals); if (!byRoute.has(t.route_name)) byRoute.set(t.route_name, emptyTotals()); tally(t, byRoute.get(t.route_name)); });
  return { period: 'daily', date, totals, byRoute: [...byRoute].map(([route, v]) => ({ route, ...v })), trips: rows.map(present) };
}

module.exports = { create, update, start, complete, cancel, list, getRow, present, monitor };
