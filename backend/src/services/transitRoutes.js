'use strict';
// Route management: routes, and which vehicles and drivers are assigned to each.
const { notFound, conflict } = require('../lib/httpError');
const { escapeLike } = require('../lib/sql');
const { toDate } = require('../lib/time');

const iso = (v) => (v ? toDate(v).toISOString() : null);

async function assignments(db, ids) {
  const out = new Map(ids.map((i) => [i, { vehicles: [], drivers: [] }]));
  if (!ids.length) return out;
  const [v] = await db.query('SELECT rv.route_id, v.id, v.name, v.plate_number, v.status FROM route_vehicles rv JOIN vehicles v ON v.id = rv.vehicle_id WHERE rv.route_id IN (?) ORDER BY v.name', [ids]);
  v.forEach((r) => out.get(r.route_id).vehicles.push({ id: r.id, name: r.name, plateNumber: r.plate_number, status: r.status }));
  const [d] = await db.query('SELECT rd.route_id, a.id, a.name, a.status FROM route_drivers rd JOIN admins a ON a.id = rd.driver_id WHERE rd.route_id IN (?) ORDER BY a.name', [ids]);
  d.forEach((r) => out.get(r.route_id).drivers.push({ id: r.id, name: r.name, status: r.status }));
  return out;
}
const present = (r, a) => ({
  id: r.id, name: r.name, origin: r.origin, destination: r.destination, description: r.description, status: r.status,
  vehicles: a.vehicles, drivers: a.drivers, openTrips: Number(r.open_trips || 0), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
});
const BASE = "SELECT r.*, (SELECT COUNT(*) FROM trips t WHERE t.route_id = r.id AND t.status IN ('scheduled','ongoing')) AS open_trips FROM transit_routes r";

async function getRow(db, id) {
  const [rows] = await db.query(`${BASE} WHERE r.id = ?`, [id]);
  if (!rows[0]) throw notFound('Route not found');
  return rows[0];
}
async function get(db, id) { const r = await getRow(db, id); return present(r, (await assignments(db, [r.id])).get(r.id)); }

async function list(pool, { q, status, limit, offset }) {
  const where = [];
  const args = [];
  if (status && status !== 'all') { where.push('r.status = ?'); args.push(status); }
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(r.name LIKE ? OR r.origin LIKE ? OR r.destination LIKE ? OR r.description LIKE ?)'); args.push(like, like, like, like); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM transit_routes r ${clause}`, args);
  const [rows] = await pool.query(`${BASE} ${clause} ORDER BY r.status = 'inactive', r.name LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const a = await assignments(pool, rows.map((r) => r.id));
  return { total: Number(total), items: rows.map((r) => present(r, a.get(r.id))) };
}

async function create(pool, admin, d) {
  const [res] = await pool.query('INSERT INTO transit_routes (name, origin, destination, description, status, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [d.name, d.origin, d.destination, d.description || null, d.status || 'active', admin.id]);
  return get(pool, res.insertId);
}
async function update(pool, id, d) {
  await getRow(pool, id);
  const map = { name: 'name', origin: 'origin', destination: 'destination', description: 'description' };
  const cols = Object.keys(d).filter((k) => map[k]);
  if (cols.length) await pool.query(`UPDATE transit_routes SET ${cols.map((c) => `${map[c]} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => (d[c] === '' ? null : d[c])), id]);
  return get(pool, id);
}
async function setStatus(pool, id, status) {
  const r = await getRow(pool, id);
  if (r.status === status) throw conflict(`This route is already ${status}.`);
  if (status === 'inactive' && Number(r.open_trips) > 0) throw conflict(`This route has ${r.open_trips} scheduled or ongoing trip(s). Cancel or finish them first.`);
  await pool.query('UPDATE transit_routes SET status = ? WHERE id = ?', [status, id]);
  return get(pool, id);
}

async function assign(pool, kind, routeId, targetId) {
  await getRow(pool, routeId);
  if (kind === 'vehicle') {
    const [v] = await pool.query('SELECT * FROM vehicles WHERE id = ?', [targetId]);
    if (!v[0]) throw notFound('Vehicle not found');
    if (v[0].status === 'inactive') throw conflict('This vehicle is inactive.');
    const [r] = await pool.query('INSERT IGNORE INTO route_vehicles (route_id, vehicle_id) VALUES (?, ?)', [routeId, targetId]);
    if (!r.affectedRows) throw conflict('That vehicle is already assigned to this route.');
  } else {
    const [d] = await pool.query("SELECT * FROM admins WHERE id = ? AND role = 'driver'", [targetId]);
    if (!d[0]) throw notFound('Driver not found');
    if (d[0].status !== 'active') throw conflict('Only active drivers can be assigned to a route.');
    const [r] = await pool.query('INSERT IGNORE INTO route_drivers (route_id, driver_id) VALUES (?, ?)', [routeId, targetId]);
    if (!r.affectedRows) throw conflict('That driver is already assigned to this route.');
  }
  return get(pool, routeId);
}

async function unassign(pool, kind, routeId, targetId) {
  await getRow(pool, routeId);
  const col = kind === 'vehicle' ? 'vehicle_id' : 'driver_id';
  const [[open]] = await pool.query(`SELECT COUNT(*) AS n FROM trips WHERE route_id = ? AND ${col} = ? AND status IN ('scheduled','ongoing')`, [routeId, targetId]);
  if (Number(open.n)) throw conflict(`This ${kind} has scheduled or ongoing trips on this route. Cancel or finish them first.`);
  const [r] = await pool.query(`DELETE FROM ${kind === 'vehicle' ? 'route_vehicles' : 'route_drivers'} WHERE route_id = ? AND ${col} = ?`, [routeId, targetId]);
  if (!r.affectedRows) throw notFound(`That ${kind} is not assigned to this route.`);
  return get(pool, routeId);
}

module.exports = { getRow, get, list, create, update, setStatus, assign, unassign };
