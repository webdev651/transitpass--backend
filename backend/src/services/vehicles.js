'use strict';
// Vehicle management: registration, details, status, and the one-driver-per-vehicle assignment.
const { withTransaction } = require('../db');
const { notFound, conflict } = require('../lib/httpError');
const { escapeLike } = require('../lib/sql');
const { toDate } = require('../lib/time');
const { todayYmd } = require('../lib/dates');

const ymd = (v) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);
const iso = (v) => (v ? toDate(v).toISOString() : null);
const BASE = `SELECT v.*, a.name AS driver_name, a.status AS driver_status,
                     (SELECT COUNT(*) FROM trips t WHERE t.vehicle_id = v.id AND t.status IN ('scheduled','ongoing')) AS open_trips,
                     (SELECT COUNT(*) FROM route_vehicles rv WHERE rv.vehicle_id = v.id) AS route_count
                FROM vehicles v LEFT JOIN admins a ON a.id = v.driver_id`;

function present(r) {
  const exp = ymd(r.registration_expiry);
  const days = exp ? Math.round((Date.parse(exp) - Date.parse(todayYmd())) / 86400000) : null;
  return {
    id: r.id, name: r.name, type: r.vehicle_type, plateNumber: r.plate_number, capacity: r.capacity, registrationNo: r.registration_no, registrationExpiry: exp,
    registrationState: days === null ? 'unknown' : days < 0 ? 'expired' : days <= 30 ? 'expiring' : 'valid', daysToRegistrationExpiry: days,
    notes: r.notes, status: r.status, driverId: r.driver_id, driver: r.driver_name || null, openTrips: Number(r.open_trips || 0), routeCount: Number(r.route_count || 0),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
  };
}
async function getRow(db, id) {
  const [rows] = await db.query(`${BASE} WHERE v.id = ?`, [id]);
  if (!rows[0]) throw notFound('Vehicle not found');
  return rows[0];
}

async function list(pool, { q, status, type, assigned, limit, offset }) {
  const where = [];
  const args = [];
  if (status && status !== 'all') { where.push('v.status = ?'); args.push(status); }
  if (type && type !== 'all') { where.push('v.vehicle_type = ?'); args.push(type); }
  if (assigned === 'assigned') where.push('v.driver_id IS NOT NULL');
  if (assigned === 'unassigned') where.push('v.driver_id IS NULL');
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(v.name LIKE ? OR v.plate_number LIKE ? OR v.registration_no LIKE ? OR a.name LIKE ?)'); args.push(like, like, like, like); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM vehicles v LEFT JOIN admins a ON a.id = v.driver_id ${clause}`, args);
  const [rows] = await pool.query(`${BASE} ${clause} ORDER BY v.status = 'inactive', v.name, v.id LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const [types] = await pool.query('SELECT DISTINCT vehicle_type FROM vehicles ORDER BY vehicle_type');
  return { total: Number(total), items: rows.map(present), types: types.map((t) => t.vehicle_type) };
}

async function summary(pool) {
  const [[s]] = await pool.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'inactive'), 0) AS inactive, COALESCE(SUM(status = 'maintenance'), 0) AS maintenance,
            COALESCE(SUM(driver_id IS NULL AND status = 'active'), 0) AS unassigned, COALESCE(SUM(registration_expiry < ?), 0) AS expired,
            COALESCE(SUM(registration_expiry >= ? AND registration_expiry <= ?), 0) AS expiring FROM vehicles`, [todayYmd(), todayYmd(), todayYmd(30)]);
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v)]));
}

async function create(pool, admin, d) {
  const [res] = await pool.query(
    'INSERT INTO vehicles (name, vehicle_type, plate_number, capacity, registration_no, registration_expiry, notes, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [d.name, d.type, d.plateNumber, d.capacity, d.registrationNo || null, d.registrationExpiry || null, d.notes || null, d.status || 'active', admin.id]);
  return present(await getRow(pool, res.insertId));
}

async function update(pool, id, d) {
  await getRow(pool, id);
  const map = { name: 'name', type: 'vehicle_type', plateNumber: 'plate_number', capacity: 'capacity', registrationNo: 'registration_no', registrationExpiry: 'registration_expiry', notes: 'notes' };
  const cols = Object.keys(d).filter((k) => map[k]);
  if (cols.length) await pool.query(`UPDATE vehicles SET ${cols.map((c) => `${map[c]} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => (d[c] === '' ? null : d[c])), id]);
  return present(await getRow(pool, id));
}

/** active / maintenance / inactive. A vehicle with scheduled or ongoing trips cannot be taken out of service until they are cancelled or finished. */
async function setStatus(pool, id, status) {
  const v = await getRow(pool, id);
  if (v.status === status) throw conflict(`This vehicle is already ${status}.`);
  if (status !== 'active' && Number(v.open_trips) > 0) throw conflict(`This vehicle has ${v.open_trips} scheduled or ongoing trip(s). Cancel or finish them first.`);
  await pool.query('UPDATE vehicles SET status = ? WHERE id = ?', [status, id]);
  return present(await getRow(pool, id));
}

const unitNode = (name) => `unit-${name}`.slice(0, 80);

/** A driver may be assigned to one vehicle at a time, and a vehicle holds one driver. The driver's "unit" is kept in step. */
async function assignDriver(pool, id, driverId) {
  await withTransaction(pool, async (conn) => {
    const [vr] = await conn.query('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [id]);
    const v = vr[0];
    if (!v) throw notFound('Vehicle not found');
    const [dr] = await conn.query("SELECT * FROM admins WHERE id = ? AND role = 'driver' FOR UPDATE", [driverId]);
    const d = dr[0];
    if (!d) throw notFound('Driver not found');
    if (d.status !== 'active') throw conflict('Only active drivers can be assigned to a vehicle.');
    if (v.status === 'inactive') throw conflict('This vehicle is inactive. Activate it before assigning a driver.');
    if (v.driver_id === d.id) throw conflict('That driver is already assigned to this vehicle.');
    if (v.driver_id) throw conflict('This vehicle already has a driver. Unassign them first.');
    const [other] = await conn.query('SELECT name FROM vehicles WHERE driver_id = ? AND id <> ?', [d.id, id]);
    if (other.length) throw conflict(`${d.name} is already assigned to ${other[0].name}. Unassign them there first.`);
    await conn.query('UPDATE vehicles SET driver_id = ? WHERE id = ?', [d.id, id]);
    await conn.query('UPDATE admins SET unit = ?, node = ? WHERE id = ?', [v.name.slice(0, 80), unitNode(v.name), d.id]);
  });
  return present(await getRow(pool, id));
}

async function unassignDriver(pool, id) {
  await withTransaction(pool, async (conn) => {
    const [vr] = await conn.query('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [id]);
    const v = vr[0];
    if (!v) throw notFound('Vehicle not found');
    if (!v.driver_id) throw conflict('No driver is assigned to this vehicle.');
    const [[open]] = await conn.query("SELECT COUNT(*) AS n FROM trips WHERE vehicle_id = ? AND driver_id = ? AND status IN ('scheduled','ongoing')", [id, v.driver_id]);
    if (Number(open.n)) throw conflict('This driver has scheduled or ongoing trips on this vehicle. Cancel or finish them first.');
    await conn.query('UPDATE vehicles SET driver_id = NULL WHERE id = ?', [id]);
    await conn.query("UPDATE admins SET unit = NULL, node = 'driver' WHERE id = ? AND unit = ?", [v.driver_id, v.name.slice(0, 80)]);
  });
  return present(await getRow(pool, id));
}

module.exports = { present, getRow, list, summary, create, update, setStatus, assignDriver, unassignDriver };
