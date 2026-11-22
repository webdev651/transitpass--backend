'use strict';
/*
  Driver web portal: the pieces a signed-in driver sees on their own dashboard. Nothing here is stored again; it only READS what the
  administrator modules already keep (vehicles, routes, trips, driver documents, notifications, scans / transactions).
  Every function takes the driver's id from the session (req.admin.id) - there is no way to ask for another driver's data.
*/
const reports = require('./reports');
const vehicles = require('./vehicles');
const trips = require('./trips');
const driverDocs = require('./driverDocs');
const notifications = require('./notifications');
const transactions = require('./transactions');
const ser = require('../lib/serialize');
const { todayYmd } = require('../lib/dates');

/**
 * The transportation service the administrator assigned to this driver: the vehicle, the routes (assigned to the driver directly,
 * to the driver's vehicle, or carried by a trip of theirs) and their trips. Routes are shown without the other drivers / vehicles on them.
 */
async function service(pool, driverId, { tripLimit = 5 } = {}) {
  const [[veh]] = await Promise.all([pool.query('SELECT id FROM vehicles WHERE driver_id = ? LIMIT 1', [driverId])]);
  const vehicle = veh[0] ? vehicles.present(await vehicles.getRow(pool, veh[0].id)) : null;
  const [routeRows] = await pool.query(
    `SELECT r.id, r.name, r.origin, r.destination, r.description, r.status FROM transit_routes r
      WHERE r.id IN (SELECT route_id FROM route_drivers WHERE driver_id = ?)
         OR r.id IN (SELECT rv.route_id FROM route_vehicles rv JOIN vehicles v ON v.id = rv.vehicle_id WHERE v.driver_id = ?)
         OR r.id IN (SELECT route_id FROM trips WHERE driver_id = ? AND status IN ('scheduled','ongoing'))
      ORDER BY r.status = 'inactive', r.name`, [driverId, driverId, driverId]);
  const own = (t) => ({
    id: t.id, route: t.route, origin: t.origin, destination: t.destination, vehicle: t.vehicle, plateNumber: t.plateNumber,
    startTime: t.startTime, endTime: t.endTime, actualStart: t.actualStart, status: t.status, scannedPassengers: t.scannedPassengers, notes: t.notes
  });
  const [ongoing, scheduled, [[counts]]] = await Promise.all([
    trips.list(pool, { driverId, status: 'ongoing', limit: 3, offset: 0 }),
    trips.list(pool, { driverId, status: 'scheduled', limit: 200, offset: 0 }),
    pool.query("SELECT COALESCE(SUM(status = 'completed'), 0) AS completed, COALESCE(SUM(status IN ('scheduled','ongoing')), 0) AS open FROM trips WHERE driver_id = ?", [driverId])
  ]);
  // the trips list is newest-first; the driver wants the NEXT trips first
  const upcoming = scheduled.items.filter((t) => new Date(t.startTime).getTime() >= Date.now() - 3600000).reverse().slice(0, tripLimit);
  return {
    vehicle: vehicle && {
      id: vehicle.id, name: vehicle.name, type: vehicle.type, plateNumber: vehicle.plateNumber, capacity: vehicle.capacity, status: vehicle.status,
      registrationNo: vehicle.registrationNo, registrationExpiry: vehicle.registrationExpiry, registrationState: vehicle.registrationState, daysToRegistrationExpiry: vehicle.daysToRegistrationExpiry
    },
    routes: routeRows.map((r) => ({ id: r.id, name: r.name, origin: r.origin, destination: r.destination, description: r.description, status: r.status })),
    currentTrip: ongoing.items[0] ? own(ongoing.items[0]) : null,
    upcomingTrips: upcoming.map(own),
    tripCounts: { completed: Number(counts.completed), open: Number(counts.open) },
    assigned: !!(vehicle || routeRows.length)
  };
}

/** The driver's own transaction history (granted / under-review rides they scanned), with totals for the same filters. */
async function ownTransactions(pool, driverId, query) {
  const r = await transactions.list(pool, { ...query, status: query.status === 'all' ? undefined : query.status, driverId });
  return {
    total: r.total, limit: r.limit, offset: r.offset, summary: r.summary,
    items: r.items.map((t) => ({
      id: t.id, reference: t.reference, status: t.status, statusLabel: t.statusLabel, underReview: t.underReview, offline: t.offline, studentName: t.studentName, schoolId: t.schoolId, route: t.route,
      regularFare: t.regularFare, discountPercent: t.discountPercent, discountAmount: t.discountAmount, finalFare: t.finalFare, scannedAt: t.scannedAt, date: t.date, time: t.time,
      cancelReason: t.cancelReason, refundAmount: t.refundAmount
    }))
  };
}

/** One call for the whole dashboard: numbers, last 7 days, assigned service, documents, notifications and today's fare totals. */
async function dashboard(pool, driver) {
  const [stats, daily, svc, docs, counts, latest, txAll] = await Promise.all([
    reports.driverStats(pool, driver.id),
    reports.daily(pool, { days: 7, driverId: driver.id }),
    service(pool, driver.id, { tripLimit: 3 }),
    driverDocs.listOwn(pool, driver.id),
    notifications.driverCounts(pool, driver.id),
    notifications.driverInbox(pool, driver.id, { limit: 3, filter: 'unread' }),
    transactions.summary(pool, { driverId: driver.id })
  ]);
  const todayTx = await transactions.summary(pool, { driverId: driver.id, from: todayYmd() });
  return {
    driver: ser.admin(driver),
    stats,
    daily: daily.slice().reverse(),             // oldest first, ready for a chart
    service: svc,
    documents: { verification: docs.verification, items: docs.items.map((d) => ({ type: d.type, typeLabel: d.typeLabel, status: d.status, expiresOn: d.expiresOn, daysToExpiry: d.daysToExpiry, expiryState: d.expiryState, remarks: d.remarks })) },
    notifications: { unread: counts.unread, all: counts.all, latest: latest.items },
    fares: { today: todayTx.completed, allTime: txAll.completed, cancelled: txAll.cancelled.count, refunded: txAll.refunded.count }
  };
}

module.exports = { service, ownTransactions, dashboard };
