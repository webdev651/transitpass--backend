'use strict';
/*
  Administrator modules added on top of the existing system. Returns { prefix: router }; app.js mounts each one at
  /api/admin/<prefix> behind the existing authentication guard + the administrator role check, so none of these endpoints
  is reachable by students, drivers or anonymous callers. Every change is written to the activity log with the administrator's id and name.
*/
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { notFound, badRequest } = require('../lib/httpError');
const { audit } = require('../lib/audit');
const S = require('../schemas.admin');
const apps = require('../services/applications');
const history = require('../services/reviewHistory');
const driverDocs = require('../services/driverDocs');
const vehicles = require('../services/vehicles');
const transitRoutes = require('../services/transitRoutes');
const trips = require('../services/trips');
const devices = require('../services/devices');
const announcements = require('../services/announcements');
const notifications = require('../services/notifications');
const refunds = require('../services/refunds');
const transactions = require('../services/transactions');
const suspicious = require('../services/suspicious');
const settings = require('../services/settings');
const fares = require('../services/fares');
const activityLogs = require('../services/activityLogs');
const analytics = require('../services/analytics');
const backups = require('../services/backups');

const one = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.uploads.maxDocBytes, files: 1, fields: 12, fieldSize: 10 * 1024 } }).single('file');
const pid = (req, name = 'id') => { if (!/^\d{1,12}$/.test(req.params[name])) throw notFound('Not found'); return Number(req.params[name]); };
const FILE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' };

module.exports = function modules(pool) {
  const R = {};

  /* ---------- 1. student applications: status monitoring + review history ---------- */
  R.applications = express.Router();
  R.applications.get('/summary', async (req, res) => res.json(await apps.summary(pool)));
  R.applications.get('/', validate(S.appMonitor, 'query'), async (req, res) => res.json(await apps.monitor(pool, req.valid.query)));
  R.applications.get('/history', validate(S.historyList, 'query'), async (req, res) => res.json(await history.list(pool, req.valid.query)));

  /* ---------- 2. driver documents ---------- */
  R['driver-documents'] = express.Router();
  const dd = R['driver-documents'];
  dd.get('/summary', async (req, res) => res.json(await driverDocs.summary(pool)));
  dd.get('/drivers', validate(S.driverStatusList, 'query'), async (req, res) => res.json(await driverDocs.driverStatuses(pool, req.valid.query)));
  dd.get('/', validate(S.docList, 'query'), async (req, res) => res.json(await driverDocs.list(pool, req.valid.query)));
  dd.post('/', one, validate(S.docUpload), async (req, res) => {
    const doc = await driverDocs.upload(pool, req.admin, req.valid.body, req.file);
    await audit(pool, req, 'driver', 'driver.document.upload', `Uploaded the ${doc.typeLabel.toLowerCase()} of ${doc.driver}`, doc.id);
    res.status(201).json({ document: doc });
  });
  dd.get('/:id/file', async (req, res) => {
    const f = await driverDocs.file(pool, pid(req));
    await audit(pool, req, 'driver', 'driver.document.view', `Viewed the ${f.typeLabel.toLowerCase()} of ${f.driverName}`, f.row.id); // private files: opening one is recorded
    res.set({ ...FILE_HEADERS, 'Content-Type': f.mime, 'Content-Disposition': 'inline' });
    res.sendFile(f.abs);
  });
  dd.post('/:id/review', validate(S.docReview), async (req, res) => {
    const doc = await driverDocs.review(pool, req.admin, pid(req), req.valid.body);
    await audit(pool, req, 'driver', `driver.document.${doc.storedStatus === 'verified' ? 'verify' : 'reject'}`, `${doc.storedStatus === 'verified' ? 'Verified' : 'Rejected'} the ${doc.typeLabel.toLowerCase()} of ${doc.driver}${req.valid.body.reason ? `: ${req.valid.body.reason}` : ''}`, doc.id);
    res.json({ document: doc });
  });

  /* ---------- 3. vehicles ---------- */
  R.vehicles = express.Router();
  const vh = R.vehicles;
  vh.get('/summary', async (req, res) => res.json(await vehicles.summary(pool)));
  vh.get('/', validate(S.vehicleList, 'query'), async (req, res) => res.json(await vehicles.list(pool, req.valid.query)));
  vh.post('/', validate(S.vehicleCreate), async (req, res) => {
    const v = await vehicles.create(pool, req.admin, req.valid.body);
    await audit(pool, req, 'vehicle', 'vehicle.create', `Registered vehicle ${v.name} (${v.plateNumber})`, v.id);
    res.status(201).json({ vehicle: v });
  });
  vh.get('/:id', async (req, res) => res.json({ vehicle: vehicles.present(await vehicles.getRow(pool, pid(req))) }));
  vh.patch('/:id', validate(S.vehicleUpdate), async (req, res) => {
    const v = await vehicles.update(pool, pid(req), req.valid.body);
    await audit(pool, req, 'vehicle', 'vehicle.update', `Updated vehicle ${v.name} (${v.plateNumber})`, v.id);
    res.json({ vehicle: v });
  });
  vh.post('/:id/status', validate(S.vehicleStatus), async (req, res) => {
    const v = await vehicles.setStatus(pool, pid(req), req.valid.body.status);
    await audit(pool, req, 'vehicle', `vehicle.${v.status}`, `Set vehicle ${v.name} to ${v.status}`, v.id);
    res.json({ vehicle: v });
  });
  vh.post('/:id/driver', validate(S.driverRef), async (req, res) => {
    const v = await vehicles.assignDriver(pool, pid(req), req.valid.body.driverId);
    await audit(pool, req, 'vehicle', 'vehicle.assign_driver', `Assigned ${v.driver} to vehicle ${v.name}`, v.id);
    res.json({ vehicle: v });
  });
  vh.delete('/:id/driver', async (req, res) => {
    const before = await vehicles.getRow(pool, pid(req));
    const v = await vehicles.unassignDriver(pool, pid(req));
    await audit(pool, req, 'vehicle', 'vehicle.unassign_driver', `Removed ${before.driver_name} from vehicle ${v.name}`, v.id);
    res.json({ vehicle: v });
  });

  /* ---------- 4. routes ---------- */
  R.routes = express.Router();
  const rt = R.routes;
  rt.get('/', validate(S.routeList, 'query'), async (req, res) => res.json(await transitRoutes.list(pool, req.valid.query)));
  rt.post('/', validate(S.routeCreate), async (req, res) => {
    const r = await transitRoutes.create(pool, req.admin, req.valid.body);
    await audit(pool, req, 'route', 'route.create', `Registered route ${r.name} (${r.origin} to ${r.destination})`, r.id);
    res.status(201).json({ route: r });
  });
  rt.get('/:id', async (req, res) => res.json({ route: await transitRoutes.get(pool, pid(req)) }));
  rt.patch('/:id', validate(S.routeUpdate), async (req, res) => {
    const r = await transitRoutes.update(pool, pid(req), req.valid.body);
    await audit(pool, req, 'route', 'route.update', `Updated route ${r.name}`, r.id);
    res.json({ route: r });
  });
  rt.post('/:id/status', validate(S.routeStatus), async (req, res) => {
    const r = await transitRoutes.setStatus(pool, pid(req), req.valid.body.status);
    await audit(pool, req, 'route', `route.${r.status}`, `Set route ${r.name} to ${r.status}`, r.id);
    res.json({ route: r });
  });
  rt.post('/:id/vehicles', validate(S.vehicleRef), async (req, res) => {
    const r = await transitRoutes.assign(pool, 'vehicle', pid(req), req.valid.body.vehicleId);
    await audit(pool, req, 'route', 'route.assign_vehicle', `Assigned a vehicle to route ${r.name}`, r.id);
    res.json({ route: r });
  });
  rt.delete('/:id/vehicles/:vehicleId', async (req, res) => {
    const r = await transitRoutes.unassign(pool, 'vehicle', pid(req), pid(req, 'vehicleId'));
    await audit(pool, req, 'route', 'route.unassign_vehicle', `Removed a vehicle from route ${r.name}`, r.id);
    res.json({ route: r });
  });
  rt.post('/:id/drivers', validate(S.driverRef), async (req, res) => {
    const r = await transitRoutes.assign(pool, 'driver', pid(req), req.valid.body.driverId);
    await audit(pool, req, 'route', 'route.assign_driver', `Assigned a driver to route ${r.name}`, r.id);
    res.json({ route: r });
  });
  rt.delete('/:id/drivers/:driverId', async (req, res) => {
    const r = await transitRoutes.unassign(pool, 'driver', pid(req), pid(req, 'driverId'));
    await audit(pool, req, 'route', 'route.unassign_driver', `Removed a driver from route ${r.name}`, r.id);
    res.json({ route: r });
  });

  /* ---------- 5. trips ---------- */
  R.trips = express.Router();
  const tr = R.trips;
  tr.get('/monitor', validate(S.tripMonitor, 'query'), async (req, res) => {
    const { period, date } = req.valid.query;
    const { todayYmd } = require('../lib/dates');
    res.json(await trips.monitor(pool, { period, date: date || (period === 'monthly' ? todayYmd().slice(0, 7) : todayYmd()) }));
  });
  tr.get('/', validate(S.tripList, 'query'), async (req, res) => res.json(await trips.list(pool, req.valid.query)));
  tr.post('/', validate(S.tripCreate), async (req, res) => {
    const t = await trips.create(pool, req.admin, req.valid.body);
    await audit(pool, req, 'trip', 'trip.create', `Created trip #${t.id}: ${t.route}, ${t.vehicle}, driver ${t.driver}`, t.id);
    res.status(201).json({ trip: t });
  });
  tr.get('/:id', async (req, res) => res.json({ trip: trips.present(await trips.getRow(pool, pid(req))) }));
  tr.patch('/:id', validate(S.tripUpdate), async (req, res) => {
    const t = await trips.update(pool, pid(req), req.valid.body);
    await audit(pool, req, 'trip', 'trip.update', `Updated trip #${t.id}`, t.id);
    res.json({ trip: t });
  });
  tr.post('/:id/start', async (req, res) => { const t = await trips.start(pool, pid(req)); await audit(pool, req, 'trip', 'trip.start', `Started trip #${t.id}`, t.id); res.json({ trip: t }); });
  tr.post('/:id/complete', validate(S.tripComplete), async (req, res) => {
    const t = await trips.complete(pool, pid(req), req.valid.body.passengerCount);
    await audit(pool, req, 'trip', 'trip.complete', `Completed trip #${t.id} with ${t.passengerCount} passenger(s)`, t.id);
    res.json({ trip: t });
  });
  tr.post('/:id/cancel', validate(S.tripCancel), async (req, res) => {
    const t = await trips.cancel(pool, pid(req), req.valid.body.reason);
    await audit(pool, req, 'trip', 'trip.cancel', `Cancelled trip #${t.id}: ${req.valid.body.reason}`, t.id);
    res.json({ trip: t });
  });

  /* ---------- 6. driver devices ---------- */
  R.devices = express.Router();
  const dv = R.devices;
  dv.get('/summary', async (req, res) => res.json(await devices.summary(pool)));
  dv.get('/activity', async (req, res) => res.json(await devices.unregisteredActivity(pool)));
  dv.get('/history', validate(S.deviceHistory, 'query'), async (req, res) => res.json(await devices.history(pool, req.valid.query)));
  dv.get('/', validate(S.deviceList, 'query'), async (req, res) => res.json(await devices.list(pool, req.valid.query)));
  dv.post('/', validate(S.deviceRegister), async (req, res) => {
    const d = await devices.register(pool, req.admin, req.valid.body);
    await audit(pool, req, 'device', 'device.register', `Registered device "${d.name}" to ${d.driver}`, d.id);
    res.status(201).json({ device: d });
  });
  dv.post('/:id/status', validate(S.deviceStatus), async (req, res) => {
    const d = await devices.setStatus(pool, req.admin, pid(req), req.valid.body.status);
    await audit(pool, req, 'device', `device.${d.status === 'active' ? 'activate' : 'deactivate'}`, `${d.status === 'active' ? 'Activated' : 'Deactivated'} device "${d.name}" of ${d.driver}`, d.id);
    res.json({ device: d });
  });
  dv.post('/:id/remove', validate(S.deviceRemove), async (req, res) => {
    const d = await devices.remove(pool, req.admin, pid(req), req.valid.body.reason);
    await audit(pool, req, 'device', 'device.remove', `Removed device "${d.name}" of ${d.driver}: ${req.valid.body.reason}`, d.id);
    res.json({ device: d });
  });

  /* ---------- 7. announcements ---------- */
  R.announcements = express.Router();
  const an = R.announcements;
  an.get('/', validate(S.annList, 'query'), async (req, res) => res.json(await announcements.list(pool, req.valid.query)));
  an.post('/', validate(S.annCreate), async (req, res) => {
    const a = await announcements.create(pool, req.admin, req.valid.body);
    await audit(pool, req, 'announcement', 'announcement.create', `Created announcement "${a.title}" (${a.state})`, a.id);
    res.status(201).json({ announcement: a });
  });
  an.patch('/:id', validate(S.annUpdate), async (req, res) => {
    const a = await announcements.update(pool, pid(req), req.valid.body);
    await audit(pool, req, 'announcement', 'announcement.update', `Edited announcement "${a.title}"`, a.id);
    res.json({ announcement: a });
  });
  an.post('/:id/publish', async (req, res) => { const a = await announcements.publish(pool, req.admin, pid(req)); await audit(pool, req, 'announcement', 'announcement.publish', `Published announcement "${a.title}" to ${a.audience}`, a.id); res.json({ announcement: a }); });
  an.post('/:id/deactivate', async (req, res) => { const a = await announcements.deactivate(pool, pid(req)); await audit(pool, req, 'announcement', 'announcement.deactivate', `Deactivated announcement "${a.title}"`, a.id); res.json({ announcement: a }); });
  an.post('/:id/send', async (req, res) => {
    const sent = await announcements.send(pool, req.admin, pid(req));
    await audit(pool, req, 'announcement', 'announcement.send', `Sent announcement #${req.params.id} (${sent.students} student, ${sent.drivers} driver notifications)`, req.params.id);
    res.json({ sent });
  });
  an.delete('/:id', async (req, res) => {
    const a = await announcements.getRow(pool, pid(req));
    await announcements.remove(pool, pid(req));
    await audit(pool, req, 'announcement', 'announcement.delete', `Deleted announcement "${a.title}"`, a.id);
    res.json({ message: 'Announcement deleted.' });
  });

  /* ---------- 8. notifications ---------- */
  R.notifications = express.Router();
  const nf = R.notifications;
  nf.get('/stats', async (req, res) => res.json(await notifications.stats(pool)));
  nf.get('/', validate(S.notifList, 'query'), async (req, res) => res.json(await notifications.list(pool, req.valid.query)));
  nf.post('/', validate(S.notifSend), async (req, res) => {
    const out = await notifications.send(pool, req.admin, req.valid.body);
    await audit(pool, req, 'notification', 'notification.send', `Sent "${req.valid.body.title.slice(0, 80)}" to ${out.sent} recipient(s) (${req.valid.body.audience})`);
    res.status(201).json(out);
  });
  nf.post('/generate', async (req, res) => {
    const out = await notifications.generateExpiryNotifications(pool);
    const docs = await driverDocs.notifyExpiring(pool);
    await audit(pool, req, 'notification', 'notification.generate', `Generated expiry reminders: ${out.qrExpiry} QR code, ${out.eligibilityExpiry} eligibility, ${docs.notified} driver document`);
    res.json({ ...out, driverDocuments: docs.notified });
  });

  /* ---------- 9. refunds and transaction cancellation ---------- */
  R.refunds = express.Router();
  const rf = R.refunds;
  rf.get('/transactions', validate(S.txnList, 'query'), async (req, res) => res.json(await refunds.transactions(pool, req.valid.query)));
  rf.post('/transactions/:id/cancel', validate(S.txnCancel), async (req, res) => {
    const t = await refunds.cancelTransaction(pool, req.admin, pid(req), req.valid.body);
    await audit(pool, req, 'refund', 'transaction.cancel', `Cancelled transaction ${t.reference}: ${req.valid.body.reason.slice(0, 120)}`, t.id);
    res.json({ transaction: t });
  });
  rf.get('/cancellations', validate(S.cancelList, 'query'), async (req, res) => res.json(await refunds.cancellations(pool, req.valid.query)));
  rf.get('/', validate(S.refundList, 'query'), async (req, res) => res.json(await refunds.listRefunds(pool, req.valid.query)));
  rf.post('/', validate(S.refundCreate), async (req, res) => {
    const d = await refunds.createRefund(pool, req.admin, req.valid.body);
    await audit(pool, req, 'refund', 'refund.create', `Recorded a refund request of ₱${d.refund.amount.toFixed(2)} for ${d.refund.reference}`, d.refund.id);
    res.status(201).json(d);
  });
  rf.get('/:id', async (req, res) => res.json(await refunds.refundDetail(pool, pid(req))));
  rf.post('/:id/decision', validate(S.refundDecide), async (req, res) => {
    const d = await refunds.decide(pool, req.admin, pid(req), req.valid.body);
    await audit(pool, req, 'refund', `refund.${d.refund.status === 'approved' ? 'approve' : 'reject'}`, `${d.refund.status === 'approved' ? 'Approved' : 'Rejected'} refund #${d.refund.id} (${d.refund.reference}, ₱${d.refund.amount.toFixed(2)})`, d.refund.id);
    res.json(d);
  });

  /* ---------- 9b. transaction management (read-only: list, details, totals, report, CSV) ---------- */
  R.transactions = express.Router();
  const tx = R.transactions;
  tx.get('/filters', async (req, res) => res.json(await transactions.filterOptions(pool)));
  tx.get('/report', validate(S.txnMgmtFilter, 'query'), async (req, res) => {
    const out = await transactions.report(pool, req.valid.query);
    await audit(pool, req, 'system', 'transaction.report', `Opened a transaction report (${out.items.length} of ${out.total} transaction(s))`);
    res.json(out);
  });
  tx.get('/export.csv', validate(S.txnMgmtFilter, 'query'), async (req, res) => {
    const out = await transactions.exportCsv(pool, req.valid.query);
    await audit(pool, req, 'system', 'transaction.export', `Exported ${out.count} transaction(s) to CSV`);
    res.set({ ...FILE_HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"` });
    res.send(out.body);
  });
  tx.get('/', validate(S.txnMgmtList, 'query'), async (req, res) => res.json(await transactions.list(pool, req.valid.query)));
  tx.get('/:id', async (req, res) => res.json({ transaction: await transactions.one(pool, pid(req)) }));
  tx.get('/:id/receipt', async (req, res) => {
    const r = await transactions.receipt(pool, pid(req));
    await audit(pool, req, 'system', 'transaction.receipt', `Opened receipt for transaction #${r.reference}`);
    res.json({ receipt: r });
  });

  /* ---------- 9c. activity logs (READ ONLY: there is no route that creates, edits or deletes a log) ---------- */
  R['activity-logs'] = express.Router();
  const lg = R['activity-logs'];
  lg.use((req, res, next) => { res.set(FILE_HEADERS); next(); });
  lg.get('/meta', (req, res) => res.json({ types: activityLogs.typeOptions() }));
  lg.get('/summary', validate(S.logFilter, 'query'), async (req, res) => res.json(await activityLogs.summary(pool, req.valid.query)));
  lg.get('/report', validate(S.logFilter, 'query'), async (req, res) => {
    const out = await activityLogs.report(pool, req.valid.query);
    await audit(pool, req, 'system', 'activitylog.report', `Opened an activity log report (${out.items.length} of ${out.total} record(s))`);
    res.json(out);
  });
  lg.get('/export.csv', validate(S.logFilter, 'query'), async (req, res) => {
    const out = await activityLogs.exportCsv(pool, req.valid.query);
    await audit(pool, req, 'system', 'activitylog.export', `Exported ${out.count} activity log record(s) to CSV`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"` });
    res.send(out.body);
  });
  lg.get('/', validate(S.logList, 'query'), async (req, res) => res.json(await activityLogs.list(pool, req.valid.query)));
  lg.get('/:id', async (req, res) => res.json({ activity: await activityLogs.one(pool, req.params.id) }));

  /* ---------- 9d. reports & analytics (READ ONLY) ---------- */
  R.reports = express.Router();
  const rp = R.reports;
  rp.use((req, res, next) => { res.set(FILE_HEADERS); next(); });
  const reportName = (req) => { if (!analytics.REPORT_NAMES.includes(req.params.name)) throw notFound('Report not found'); return req.params.name; };
  rp.get('/overview', validate(S.reportQuery, 'query'), async (req, res) => res.json(await analytics.overview(pool, analytics.resolveRange(req.valid.query))));
  rp.get('/:name/export.csv', validate(S.reportQuery, 'query'), async (req, res) => {
    const out = await analytics.exportCsv(pool, reportName(req), req.valid.query);
    await audit(pool, req, 'system', 'report.export', `Exported the ${analytics.TITLES[req.params.name].toLowerCase()} to CSV (${out.range}, ${out.count} row(s))`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"` });
    res.send(out.body);
  });
  rp.get('/:name/export.pdf', validate(S.reportQuery, 'query'), async (req, res) => {
    const out = await analytics.exportPdf(pool, reportName(req), req.valid.query);
    await audit(pool, req, 'system', 'report.export.pdf', `Exported the ${analytics.TITLES[req.params.name].toLowerCase()} to PDF (${out.range}, ${out.count} row(s))`);
    res.set({ ...FILE_HEADERS, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${out.filename}"` });
    res.send(out.body);
  });
  rp.post('/:name/print', validate(S.reportQuery, 'query'), async (req, res) => {   // the browser prints the page; this only records that it happened
    const r = analytics.resolveRange(req.valid.query);
    await audit(pool, req, 'system', 'report.print', `Printed / saved as PDF the ${analytics.TITLES[reportName(req)].toLowerCase()} (${r.label})`);
    res.status(204).end();
  });
  rp.get('/:name', validate(S.reportQuery, 'query'), async (req, res) => res.json(await analytics.run(pool, reportName(req), req.valid.query, { limit: req.valid.query.limit })));

  /* ---------- 11. suspicious activity ---------- */
  R.suspicious = express.Router();
  const sp = R.suspicious;
  sp.post('/detect', validate(S.suspDetect), async (req, res) => {
    const out = await suspicious.detect(pool, req.valid.body);
    await audit(pool, req, 'security', 'suspicious.detect', `Ran suspicious-activity detection (${out.newFlags} new flag(s))`);
    res.json(out);
  });
  sp.get('/', validate(S.suspList, 'query'), async (req, res) => res.json(await suspicious.list(pool, req.valid.query)));
  sp.get('/:id', async (req, res) => res.json(await suspicious.detail(pool, pid(req))));
  sp.post('/:id/notes', validate(S.suspNote), async (req, res) => { const d = await suspicious.addNote(pool, req.admin, pid(req), req.valid.body.note); await audit(pool, req, 'security', 'suspicious.note', `Added an investigation note to flag #${req.params.id}`, req.params.id); res.status(201).json(d); });
  sp.post('/:id/review', validate(S.suspReview), async (req, res) => {
    const d = await suspicious.review(pool, req.admin, pid(req), req.valid.body);
    await audit(pool, req, 'security', `suspicious.${req.valid.body.decision}`, `Marked suspicious flag #${req.params.id} as ${req.valid.body.decision}`, req.params.id);
    res.json(d);
  });
  sp.post('/:id/action', validate(S.suspAction), async (req, res) => {
    const d = await suspicious.takeAction(pool, req.admin, pid(req), req.valid.body);
    await audit(pool, req, 'security', 'suspicious.action', `${suspicious.ACTIONS[req.valid.body.action]} (flag #${req.params.id})`, req.params.id);
    res.json(d);
  });

  /* ---------- 10. settings ---------- */
  R.settings = express.Router();
  const st = R.settings;
  st.get('/runtime', async (req, res) => res.json(await settings.runtime(pool)));      // branding + idle timeout, loaded by every administrator page
  st.get('/system', async (req, res) => res.json(await settings.systemInfo(pool)));
  st.get('/logo', async (req, res) => { const v = await settings.get(pool, 'system.logo'); res.json({ logo: v || null }); });
  st.post('/logo', one, async (req, res) => { await settings.setLogo(pool, req.admin, req.file); await audit(pool, req, 'settings', 'settings.logo', 'Changed the system logo'); res.json({ message: 'Logo updated.' }); });
  st.delete('/logo', async (req, res) => { await settings.clearLogo(pool); await audit(pool, req, 'settings', 'settings.logo', 'Removed the custom system logo'); res.json({ message: 'Logo removed.' }); });
  st.get('/', async (req, res) => res.json({ settings: await settings.getAll(pool) }));
  st.patch('/', validate(S.settingsPatch), async (req, res) => {
    const out = await settings.update(pool, req.admin, req.valid.body);
    await audit(pool, req, 'settings', 'settings.update', `Changed settings: ${out.changed.join(', ')}`.slice(0, 250));
    res.json({ settings: await settings.getAll(pool), changed: out.changed });
  });

  /* ---------- 12. backups and data retention ---------- */
  R.backups = express.Router();
  const bk = R.backups;
  bk.get('/status', async (req, res) => res.json(await backups.status(pool)));
  bk.get('/', validate(S.backupList, 'query'), async (req, res) => res.json(await backups.list(pool, req.valid.query)));
  bk.post('/', async (req, res) => {
    const b = await backups.run(pool, req.admin, 'manual');
    await audit(pool, req, 'backup', 'backup.create', `Created database backup ${b.filename}`, b.id);
    res.status(201).json({ backup: b });
  });
  bk.post('/retention', validate(S.retentionRun), async (req, res) => {
    const out = await backups.applyRetention(pool, req.admin, { dryRun: req.valid.body.dryRun });
    if (!req.valid.body.dryRun) await audit(pool, req, 'backup', 'retention.apply', `Applied the data retention policy: ${out.backups} backup(s), ${out.activityLogs} log(s), ${out.notifications} notification(s), ${out.suspiciousFlags} flag(s) removed`);
    res.json(out);
  });
  bk.get('/:id/download', async (req, res) => {
    const f = await backups.filePath(pool, pid(req));
    await audit(pool, req, 'backup', 'backup.download', `Downloaded backup ${f.filename}`, req.params.id);
    res.sendFile(f.abs, {
      cacheControl: false,
      lastModified: false,
      acceptRanges: false,
      headers: { ...FILE_HEADERS, 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${f.filename}"` }
    });
  });
  bk.post('/:id/verify', async (req, res) => { const v = await backups.verify(pool, pid(req)); await audit(pool, req, 'backup', 'backup.verify', `Verified backup #${req.params.id}: ${v.result}`.slice(0, 250), req.params.id, v.ok ? 'success' : 'failed'); res.json(v); });
  bk.delete('/:id', async (req, res) => { const b = await backups.removeFile(pool, req.admin, pid(req)); await audit(pool, req, 'backup', 'backup.delete', `Deleted backup file ${b.filename}`, b.id); res.json({ backup: b }); });

  /* ---------- 12. fares and discounts ---------- */
  R.fares = express.Router();
  const fr = R.fares;
  const peso = (n) => `₱${Number(n).toFixed(2)}`;
  const scopeOf = (f) => (f.routeName ? `route ${f.routeName}` : 'the default fare (all routes)');
  // Fare changes are sensitive (they change what students pay), so every attempt is logged, including refused ones (wrong password, overlapping dates).
  async function audited(req, action, id, describe, fn) {
    try { const out = await fn(); await audit(pool, req, 'settings', action, describe(out), id); return out; }
    catch (e) { await audit(pool, req, 'settings', action, `Refused: ${action.replace('.', ' ')}${id ? ` #${id}` : ''} (${String(e.message || 'error').slice(0, 120)})`, id, 'failed'); throw e; }
  }
  fr.get('/summary', async (req, res) => res.json(await fares.summary(pool)));
  fr.get('/calculate', validate(S.fareCalc, 'query'), async (req, res) => res.json(await fares.calculate(pool, { routeId: req.valid.query.routeId, ...(req.valid.query.date ? { day: req.valid.query.date } : {}) })));
  fr.get('/', validate(S.fareList, 'query'), async (req, res) => res.json(await fares.list(pool, req.valid.query)));
  fr.get('/:id', async (req, res) => res.json({ fare: await fares.get(pool, pid(req)) }));
  fr.post('/', validate(S.fareCreate), async (req, res) => {
    const f = await audited(req, 'fare.create', null, (x) => `Created a fare rule for ${scopeOf(x)}: ${peso(x.regularFare)}, ${x.discountPercent}% student discount, from ${x.effectiveFrom}${x.effectiveUntil ? ` to ${x.effectiveUntil}` : ''}`, () => fares.create(pool, req.admin, req.valid.body));
    res.status(201).json({ fare: f });
  });
  fr.patch('/:id', validate(S.fareUpdate), async (req, res) => {
    const id = pid(req);
    const before = await fares.get(pool, id);
    const f = await audited(req, 'fare.update', id, (x) => {
      const bits = [];
      if (before.regularFare !== x.regularFare) bits.push(`fare ${peso(before.regularFare)} to ${peso(x.regularFare)}`);
      if (before.discountPercent !== x.discountPercent) bits.push(`discount ${before.discountPercent}% to ${x.discountPercent}%`);
      if (before.effectiveFrom !== x.effectiveFrom || before.effectiveUntil !== x.effectiveUntil) bits.push(`dates ${x.effectiveFrom} to ${x.effectiveUntil || 'no end'}`);
      if (before.routeId !== x.routeId) bits.push(`applies to ${scopeOf(x)}`);
      return `Changed fare rule #${id} (${scopeOf(x)})${bits.length ? ': ' + bits.join(', ') : ''}`;
    }, () => fares.update(pool, req.admin, id, req.valid.body));
    res.json({ fare: f });
  });
  fr.post('/:id/status', validate(S.fareToggle), async (req, res) => {
    const id = pid(req);
    const f = await audited(req, req.valid.body.active ? 'fare.activate' : 'fare.deactivate', id, (x) => `${x.isActive ? 'Activated' : 'Deactivated'} the fare rule #${id} for ${scopeOf(x)}`, () => fares.setActive(pool, req.admin, id, req.valid.body.active, req.valid.body.password));
    res.json({ fare: f });
  });
  fr.post('/:id/discount', validate(S.fareToggle), async (req, res) => {
    const id = pid(req);
    const f = await audited(req, req.valid.body.active ? 'fare.discount_on' : 'fare.discount_off', id, (x) => `${x.discountActive ? 'Switched on' : 'Switched off'} the student discount of fare rule #${id} (${scopeOf(x)})`, () => fares.setDiscountActive(pool, req.admin, id, req.valid.body.active, req.valid.body.password));
    res.json({ fare: f });
  });

  return R;
};

/** Driver-side inbox for notifications (a driver only ever sees their own rows). Mounted at /api/driver/notifications. */
module.exports.driverInbox = function driverInbox(pool) {
  const r = express.Router();
  r.get('/', validate(S.driverInboxQuery, 'query'), async (req, res) => res.json(await notifications.driverInbox(pool, req.admin.id, req.valid.query)));
  r.get('/count', async (req, res) => res.json(await notifications.driverCounts(pool, req.admin.id)));   // the notification counter (bell badge)
  r.post('/read-all', async (req, res) => {
    const out = await notifications.driverMarkAllRead(pool, req.admin.id);
    res.json({ message: out.marked ? `Marked ${out.marked} notification${out.marked === 1 ? '' : 's'} as read.` : 'Everything is already read.', ...out, unread: 0 });
  });
  r.post('/:id/read', async (req, res) => {
    if (!/^\d{1,12}$/.test(req.params.id)) throw notFound('Notification not found');
    await notifications.driverMarkRead(pool, req.admin.id, Number(req.params.id));
    res.json({ message: 'Marked as read.' });
  });
  return r;
};
