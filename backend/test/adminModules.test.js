'use strict';
// Admin modules, groups 1-6: applications, driver documents, vehicles, routes, trips, driver devices.
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-mod-up-'));
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-mod-bk-'));
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload, config } = require('./helpers');
const { todayYmd } = require('../src/lib/dates');

let ctx, admin;
before(async () => { ctx = await setup(); });
beforeEach(async () => { await reset(ctx.pool); admin = await login(ctx.api); });
after(async () => { await ctx.pool.end(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true }); });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const A = '/api/admin';
const aget = (p, t = admin) => ctx.api.get(A + p).set(auth(t));
const apost = (p, b, t = admin) => ctx.api.post(A + p).set(auth(t)).send(b || {});
const apatch = (p, b, t = admin) => ctx.api.patch(A + p).set(auth(t)).send(b || {});
const adel = (p, t = admin) => ctx.api.delete(A + p).set(auth(t));
const iso = (ms) => new Date(ms).toISOString();
const H = 3600000;
const BASE = Math.floor(Date.now() / 60000) * 60000;   // one fixed instant, so "back to back" trips really are back to back
const future = (hours) => iso(BASE + hours * H);

let dn = 0;
async function driver(over = {}) {
  dn += 1;
  const body = { name: `Driver ${dn}`, username: `driver${dn}`, email: `driver${dn}@example.com`, password: 'driver-pass-1', status: 'active', ...over };
  const res = await ctx.api.post(`${A}/drivers`).set(auth(admin)).send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const tok = (await ctx.api.post('/api/auth/login').send({ username: body.username, password: body.password })).body.token;
  return { ...res.body.driver, token: tok, username: body.username };
}
let vn = 0;
async function vehicle(over = {}) {
  vn += 1;
  const res = await apost('/vehicles', { name: `Bus ${vn}`, type: 'Bus', plateNumber: `ABC ${1000 + vn}`, capacity: 40, ...over });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.vehicle;
}
let rn = 0;
async function route(over = {}) {
  rn += 1;
  const res = await apost('/routes', { name: `Route ${rn}`, origin: 'Campus', destination: `Town ${rn}`, ...over });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.route;
}
async function newTrip(r, v, d, startH, endH, over = {}) {
  return apost('/trips', { routeId: r.id, vehicleId: v.id, driverId: d.id, startTime: future(startH), endTime: future(endH), ...over });
}
async function activeStudent() {
  const created = await ctx.api.post('/api/students').set(auth(admin)).send(studentPayload({ status: 'active' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.student;
}
async function applicant(docs = false) {
  const body = { ...studentPayload(), campus: 'Main', section: 'A', password: 'secret-pass-1', confirm: 'secret-pass-1' };
  let req = ctx.api.post('/api/student-portal/register');
  for (const [k, v] of Object.entries(body)) req = req.field(k, v);
  if (docs) req = req.attach('idDocument', PDF, { filename: 'id.pdf' }).attach('enrollmentDocument', PNG, { filename: 'cor.png' });
  const reg = docs ? await req : await ctx.api.post('/api/student-portal/register').send(body);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const token = (await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password })).body.token;
  return { id: reg.body.student.id, name: body.name, token, t: auth(token) };
}
/** A driver scans a student by School ID (after the admin issued the student a QR code). */
async function ride(d, student, headers = {}) {
  if (!student.qrIssued) { await ctx.api.post(`/api/students/${student.id}/actions/regenerate-qr`).set(auth(admin)); student.qrIssued = true; }
  return ctx.api.post('/api/scanner/lookup').set(auth(d.token)).set(headers).send({ schoolId: student.schoolId });
}
const audit = async (action) => (await ctx.pool.query('SELECT * FROM activity_logs WHERE action = ? ORDER BY id DESC', [action]))[0];

/* ================================================================== security across every module */

test('security: every module endpoint needs sign-in and an administrator (drivers and students are refused)', async () => {
  const d = await driver();
  const s = await applicant();
  const paths = ['/applications', '/applications/summary', '/applications/history', '/driver-documents', '/driver-documents/summary', '/driver-documents/drivers', '/vehicles', '/vehicles/summary', '/routes', '/trips',
    '/trips/monitor', '/devices', '/devices/summary', '/devices/history', '/devices/activity', '/announcements', '/notifications', '/notifications/stats', '/refunds', '/refunds/transactions', '/refunds/cancellations',
    '/suspicious', '/settings', '/settings/runtime', '/settings/system', '/backups', '/backups/status'];
  for (const p of paths) {
    assert.equal((await ctx.api.get(A + p)).status, 401, `${p} without a token`);
    assert.equal((await ctx.api.get(A + p).set(auth(d.token))).status, 403, `${p} as a driver`);
    assert.equal((await ctx.api.get(A + p).set(s.t)).status, 401, `${p} as a student`);
    assert.equal((await ctx.api.get(A + p).set(auth(admin))).status, 200, `${p} as an administrator`);
  }
  for (const [m, p] of [['post', '/vehicles'], ['post', '/routes'], ['post', '/trips'], ['post', '/devices'], ['post', '/backups'], ['patch', '/settings'], ['post', '/announcements'], ['post', '/refunds']]) {
    assert.equal((await ctx.api[m](A + p).set(auth(d.token)).send({})).status, 403, `${m} ${p} as a driver`);
    assert.equal((await ctx.api[m](A + p).send({})).status, 401, `${m} ${p} anonymous`);
  }
});

/* ================================================================== 1. student applications */

test('applications: every decision is kept in the review history with who, when and why; monitoring shows the state', async () => {
  const a = await applicant();
  await apost(`/verifications/${a.id}/reject`, { reason: 'Blurry enrollment document' });
  await apost(`/verifications/${a.id}/reopen`);
  await apost(`/verifications/${a.id}/approve`, { note: 'Matched the registrar list' });
  const h = (await aget(`/applications/history?studentId=${a.id}`)).body;
  assert.deepEqual(h.items.map((x) => x.event).reverse(), ['application_rejected', 'application_reopened', 'application_approved']);
  const rej = h.items.find((x) => x.event === 'application_rejected');
  assert.equal(rej.reason, 'Blurry enrollment document');
  assert.equal(rej.admin, config.seedAdmin.name);
  assert.ok(rej.at);
  assert.equal(h.items.find((x) => x.event === 'application_approved').reason, 'Matched the registrar list');
  assert.equal((await aget('/applications/history?event=application_rejected')).body.total, 1);
  assert.equal((await aget(`/applications/history?q=${encodeURIComponent(a.name.slice(0, 8))}`)).body.total, 3);
  const mon = (await aget('/applications?status=verified')).body;
  assert.equal(mon.items[0].verification.status, 'verified');
  assert.equal(mon.items[0].lastDecision.event, 'application_approved');
  assert.equal((await aget('/applications/summary')).body.verified, 1);
});

test('applications: document decisions and correction decisions are in the history, and corrections show in monitoring', async () => {
  const a = await applicant(true);
  assert.equal((await apost(`/verifications/${a.id}/documents/id/review`, { decision: 'rejected' })).status, 400, 'a rejection needs a reason');
  await apost(`/verifications/${a.id}/documents/id/review`, { decision: 'rejected', reason: 'ID photo is cropped' });
  await apost(`/verifications/${a.id}/documents/enrollment/review`, { decision: 'verified' });
  const req = await ctx.api.post('/api/student-portal/me/requests').set(a.t).send({ type: 'correction', field: 'section', value: 'B', reason: 'I was moved to section B' });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  assert.equal((await aget('/applications?status=pending')).body.items[0].pendingCorrections, 1);
  assert.equal((await aget('/applications/summary')).body.pendingCorrections, 1);
  await apost(`/correction-requests/${req.body.request.id}/approve`, { note: 'Confirmed' });
  const events = (await aget(`/applications/history?studentId=${a.id}`)).body.items;
  assert.ok(events.some((e) => e.event === 'document_rejected' && e.subject === 'Student ID document' && e.reason === 'ID photo is cropped'));
  assert.ok(events.some((e) => e.event === 'document_verified'));
  assert.ok(events.some((e) => e.event === 'correction_approved' && e.subject === 'Section'));
  const r2 = await ctx.api.post('/api/student-portal/me/requests').set(a.t).send({ type: 'correction', field: 'level', value: '2nd Year', reason: 'Promoted to second year' });
  await apost(`/correction-requests/${r2.body.request.id}/reject`, { reason: 'No proof provided' });
  assert.ok((await aget(`/applications/history?studentId=${a.id}`)).body.items.some((e) => e.event === 'correction_rejected' && e.reason === 'No proof provided'));
});

/* ================================================================== 2. driver documents */

const upload = (d, type, over = {}, buf = PDF, name = 'doc.pdf') => {
  let r = ctx.api.post(`${A}/driver-documents`).set(auth(admin)).field('driverId', String(d.id)).field('type', type);
  for (const [k, v] of Object.entries({ documentNo: 'N01-23-456789', expiresOn: todayYmd(400), ...over })) if (v !== undefined) r = r.field(k, v);
  return r.attach('file', buf, { filename: name });
};

test('driver documents: upload, view the file (audited), approve or reject with a reason, and the driver verification status follows', async () => {
  const d = await driver();
  let st = (await aget('/driver-documents/drivers')).body.items.find((x) => x.id === d.id);
  assert.equal(st.verification, 'incomplete');
  const lic = await upload(d, 'license');
  assert.equal(lic.status, 201, JSON.stringify(lic.body));
  assert.equal(lic.body.document.status, 'pending');
  assert.equal(JSON.stringify(lic.body).includes('file_path'), false);
  const file = await ctx.api.get(`${A}/driver-documents/${lic.body.document.id}/file`).set(auth(admin));
  assert.equal(file.status, 200);
  assert.match(file.headers['content-type'], /pdf/);
  assert.equal(file.headers['cache-control'], 'private, no-store');
  assert.ok(await audit('driver.document.view'), 'opening a private document is recorded');
  assert.equal((await ctx.api.get(`${A}/driver-documents/${lic.body.document.id}/file`).set(auth(d.token))).status, 403);
  assert.equal((await ctx.api.get(`${A}/driver-documents/${lic.body.document.id}/file`)).status, 401);
  assert.equal((await apost(`/driver-documents/${lic.body.document.id}/review`, { decision: 'rejected' })).status, 400);
  const rej = await apost(`/driver-documents/${lic.body.document.id}/review`, { decision: 'rejected', reason: 'Licence photo is unreadable' });
  assert.equal(rej.body.document.status, 'rejected');
  assert.equal(rej.body.document.reviewedBy, config.seedAdmin.name);
  st = (await aget('/driver-documents/drivers')).body.items.find((x) => x.id === d.id);
  assert.equal(st.verification, 'rejected');
  // a fresh upload replaces the rejected one as the current document
  const lic2 = await upload(d, 'license');
  assert.equal((await aget(`/driver-documents?driverId=${d.id}&type=license`)).body.items.length, 1);
  assert.equal((await aget(`/driver-documents?driverId=${d.id}&type=license&history=1`)).body.items.length, 2);
  assert.equal((await apost(`/driver-documents/${lic.body.document.id}/review`, { decision: 'verified' })).status, 409, 'the replaced document cannot be reviewed');
  await apost(`/driver-documents/${lic2.body.document.id}/review`, { decision: 'verified' });
  assert.equal((await aget('/driver-documents/drivers')).body.items.find((x) => x.id === d.id).verification, 'incomplete', 'ID still missing');
  const id = await upload(d, 'government_id', { expiresOn: undefined }, PNG, 'id.png');
  assert.equal(id.status, 201, JSON.stringify(id.body));
  await apost(`/driver-documents/${id.body.document.id}/review`, { decision: 'verified' });
  assert.equal((await aget('/driver-documents/drivers')).body.items.find((x) => x.id === d.id).verification, 'verified');
  assert.equal((await aget('/driver-documents/summary')).body.verified, 1);
  const inbox = (await ctx.api.get('/api/driver/notifications').set(auth(d.token))).body;
  assert.ok(inbox.items.some((n) => /not approved/.test(n.title)), 'the driver is told about the rejection');
});

test('driver documents: bad uploads are refused, and expiry is monitored', async () => {
  const d = await driver();
  assert.equal((await upload(d, 'license', {}, Buffer.from('MZ not a document at all......'), 'evil.pdf')).status, 400, 'type comes from the file content, not its name');
  assert.equal((await upload(d, 'license', { expiresOn: undefined })).status, 400, 'a licence needs an expiry date');
  assert.equal((await upload(d, 'license', { expiresOn: '2020-01-01' })).status, 400, 'already expired');
  assert.equal((await upload(d, 'license', { expiresOn: '2027-02-31' })).status, 400, 'not a real date');
  assert.equal((await ctx.api.post(`${A}/driver-documents`).set(auth(admin)).field('driverId', '99999').field('type', 'license').field('expiresOn', todayYmd(300)).attach('file', PDF, { filename: 'a.pdf' })).status, 404);
  const soon = await upload(d, 'license', { expiresOn: todayYmd(10) });
  await apost(`/driver-documents/${soon.body.document.id}/review`, { decision: 'verified' });
  assert.equal(soon.body.document.expiryState, 'expiring');
  assert.equal((await aget('/driver-documents?expiry=expiring')).body.items.length, 1);
  assert.equal((await aget('/driver-documents/summary')).body.documentsExpiringSoon, 1);
  assert.equal((await apost('/notifications/generate')).body.driverDocuments, 1);
  assert.equal((await apost('/notifications/generate')).body.driverDocuments, 0, 'reminders are sent once');
  await ctx.pool.query('UPDATE driver_documents SET expires_on = ? WHERE id = ?', [todayYmd(-2), soon.body.document.id]);
  const exp = (await aget('/driver-documents?status=expired')).body.items;
  assert.equal(exp.length, 1);
  assert.equal(exp[0].status, 'expired');
  assert.equal((await aget('/driver-documents/drivers')).body.items.find((x) => x.id === d.id).verification, 'expired');
  assert.equal((await apost(`/driver-documents/${soon.body.document.id}/review`, { decision: 'verified' })).status, 409, 'an expired document cannot be approved');
  assert.equal(JSON.stringify(fs.readdirSync(process.env.UPLOAD_DIR)).includes('drivers'), true);
  assert.equal((await ctx.api.get(`/uploads/drivers/${d.id}`)).status, 404, 'files are not reachable through a public URL');
});

/* ================================================================== 3. vehicles */

test('vehicles: register, validate, edit, search and filter, activate / deactivate', async () => {
  const v = await vehicle({ name: 'Bus Alpha', plateNumber: 'abc 123', registrationNo: 'OR-998', registrationExpiry: todayYmd(10) });
  assert.equal(v.plateNumber, 'ABC 123', 'plates are stored in capitals');
  assert.equal(v.registrationState, 'expiring');
  assert.equal((await apost('/vehicles', { name: 'Dup', type: 'Bus', plateNumber: 'ABC 123', capacity: 10 })).status, 409, 'plate numbers are unique');
  assert.equal((await apost('/vehicles', { name: 'x', type: 'Bus', plateNumber: 'ZZZ 1', capacity: 0 })).status, 400);
  assert.equal((await apost('/vehicles', { name: 'x', type: 'Bus', plateNumber: '!!', capacity: 5 })).status, 400);
  assert.equal((await apost('/vehicles', { name: '', type: 'Bus', plateNumber: 'ZZZ 2', capacity: 5 })).status, 400);
  await vehicle({ name: 'Jeep One', type: 'Jeepney', capacity: 18 });
  assert.equal((await apatch(`/vehicles/${v.id}`, { capacity: 45, notes: 'New tyres' })).body.vehicle.capacity, 45);
  assert.equal((await apatch(`/vehicles/${v.id}`, { plateNumber: 'JEE 1' })).status, 200);
  assert.equal((await aget('/vehicles?q=jeep')).body.total, 1);
  assert.equal((await aget('/vehicles?q=JEE 1')).body.total, 1, 'plate search');
  assert.equal((await aget('/vehicles?type=Jeepney')).body.items[0].name, 'Jeep One');
  assert.equal((await aget('/vehicles?assigned=unassigned')).body.total, 2);
  const off = await apost(`/vehicles/${v.id}/status`, { status: 'inactive' });
  assert.equal(off.body.vehicle.status, 'inactive');
  assert.equal((await apost(`/vehicles/${v.id}/status`, { status: 'inactive' })).status, 409);
  assert.equal((await aget('/vehicles?status=inactive')).body.total, 1);
  assert.equal((await aget('/vehicles/summary')).body.inactive, 1);
  assert.equal((await apost(`/vehicles/${v.id}/status`, { status: 'active' })).body.vehicle.status, 'active');
  assert.ok(await audit('vehicle.create'));
});

test('vehicles: a driver can hold only one vehicle and a vehicle only one driver', async () => {
  const [d1, d2] = [await driver(), await driver()];
  const [v1, v2] = [await vehicle({ name: 'Unit One' }), await vehicle({ name: 'Unit Two' })];
  const ok = await apost(`/vehicles/${v1.id}/driver`, { driverId: d1.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.vehicle.driver, d1.name);
  assert.equal((await aget('/drivers?limit=50')).body.items.find((x) => x.id === d1.id).unit, 'Unit One', "the driver's unit follows the assignment");
  assert.equal((await apost(`/vehicles/${v1.id}/driver`, { driverId: d2.id })).status, 409, 'vehicle already has a driver');
  assert.equal((await apost(`/vehicles/${v2.id}/driver`, { driverId: d1.id })).status, 409, 'driver already has a vehicle');
  assert.equal((await apost(`/vehicles/${v2.id}/driver`, { driverId: 99999 })).status, 404);
  assert.equal((await aget('/vehicles?assigned=assigned')).body.total, 1);
  // simultaneous requests for the same vehicle: exactly one wins
  const race = await Promise.all([apost(`/vehicles/${v2.id}/driver`, { driverId: d2.id }), apost(`/vehicles/${v2.id}/driver`, { driverId: (await driver()).id })]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const un = await adel(`/vehicles/${v1.id}/driver`);
  assert.equal(un.status, 200);
  assert.equal(un.body.vehicle.driver, null);
  assert.equal((await adel(`/vehicles/${v1.id}/driver`)).status, 409);
  assert.equal((await apost(`/vehicles/${v1.id}/driver`, { driverId: d1.id })).status, 200, 'free again');
  const inactive = await driver({ status: 'pending' });
  assert.equal((await apost(`/vehicles/${v1.id}/driver`, { driverId: inactive.id })).status, 409);
});

/* ================================================================== 4. routes */

test('routes: register, validate, assign vehicles and drivers, activate / deactivate, search', async () => {
  const r = await route({ name: 'Campus - Downtown', origin: 'TCC Campus', destination: 'Downtown', description: 'Morning loop' });
  assert.equal((await apost('/routes', { name: 'Campus - Downtown', origin: 'A', destination: 'B' })).status, 409, 'route names are unique');
  assert.equal((await apost('/routes', { name: 'Loop', origin: 'Same', destination: 'same' })).status, 400);
  assert.equal((await apost('/routes', { name: 'No dest', origin: 'A', destination: '' })).status, 400);
  const v = await vehicle(); const d = await driver();
  const a1 = await apost(`/routes/${r.id}/vehicles`, { vehicleId: v.id });
  assert.equal(a1.body.route.vehicles.length, 1);
  assert.equal((await apost(`/routes/${r.id}/vehicles`, { vehicleId: v.id })).status, 409, 'already assigned');
  assert.equal((await apost(`/routes/${r.id}/drivers`, { driverId: d.id })).body.route.drivers[0].name, d.name);
  assert.equal((await apost(`/routes/${r.id}/drivers`, { driverId: d.id })).status, 409);
  assert.equal((await apost(`/routes/${r.id}/vehicles`, { vehicleId: 99999 })).status, 404);
  const other = await route();
  assert.equal((await apost(`/routes/${other.id}/vehicles`, { vehicleId: v.id })).status, 200, 'a vehicle may serve several routes');
  assert.equal((await aget('/routes?q=downtown')).body.total, 1);
  assert.equal((await aget('/routes?q=TCC Campus')).body.total, 1);
  assert.equal((await apatch(`/routes/${r.id}`, { description: 'Evening loop' })).body.route.description, 'Evening loop');
  assert.equal((await apost(`/routes/${r.id}/status`, { status: 'inactive' })).body.route.status, 'inactive');
  assert.equal((await aget('/routes?status=inactive')).body.total, 1);
  assert.equal((await apost(`/routes/${r.id}/status`, { status: 'inactive' })).status, 409);
  await apost(`/routes/${r.id}/status`, { status: 'active' });
  assert.equal((await adel(`/routes/${r.id}/vehicles/${v.id}`)).body.route.vehicles.length, 0);
  assert.equal((await adel(`/routes/${r.id}/vehicles/${v.id}`)).status, 404);
  assert.equal((await adel(`/routes/${r.id}/drivers/${d.id}`)).body.route.drivers.length, 0);
  const inactiveV = await vehicle(); await apost(`/vehicles/${inactiveV.id}/status`, { status: 'inactive' });
  assert.equal((await apost(`/routes/${r.id}/vehicles`, { vehicleId: inactiveV.id })).status, 409, 'inactive vehicles cannot be assigned');
});

/* ================================================================== 5. trips */

test('trips: creation, conflicting driver / vehicle assignments are refused, and the rules about active and assigned resources', async () => {
  const r = await route(); const v1 = await vehicle(); const v2 = await vehicle(); const d1 = await driver(); const d2 = await driver();
  const t1 = await newTrip(r, v1, d1, 24, 26);
  assert.equal(t1.status, 201, JSON.stringify(t1.body));
  assert.equal(t1.body.trip.status, 'scheduled');
  assert.equal((await newTrip(r, v2, d1, 25, 27)).status, 409, 'same driver, overlapping time');
  assert.equal((await newTrip(r, v1, d2, 25, 27)).status, 409, 'same vehicle, overlapping time');
  assert.equal((await newTrip(r, v1, d1, 24, 26)).status, 409, 'identical trip');
  assert.equal((await newTrip(r, v2, d2, 25, 27)).status, 201, 'a different driver and vehicle is fine');
  assert.equal((await newTrip(r, v1, d1, 26, 28)).status, 201, 'back to back (end = next start) is not a conflict');
  assert.equal((await newTrip(r, v2, d2, 30, 29)).status, 400, 'ends before it starts');
  const noRoute = await newTrip({ id: 99999 }, v1, d1, 40, 41); assert.equal(noRoute.status, 404);
  const cancelled = await apost(`/trips/${t1.body.trip.id}/cancel`, { reason: 'Road closed' });
  assert.equal(cancelled.body.trip.status, 'cancelled');
  assert.equal((await newTrip(r, await vehicle(), d1, 24, 26)).status, 201, 'a cancelled trip frees the driver');
  const rOff = await route(); await apost(`/routes/${rOff.id}/status`, { status: 'inactive' });
  assert.equal((await newTrip(rOff, v2, d2, 50, 51)).status, 409, 'inactive route');
  const vM = await vehicle(); await apost(`/vehicles/${vM.id}/status`, { status: 'maintenance' });
  assert.equal((await newTrip(r, vM, d2, 60, 61)).status, 409, 'vehicle in maintenance');
  const pending = await driver({ status: 'pending' });
  assert.equal((await newTrip(r, v1, pending, 60, 61)).status, 409, 'inactive driver');
  // once a route has assigned vehicles / drivers, trips must use them
  const r2 = await route(); await apost(`/routes/${r2.id}/vehicles`, { vehicleId: v1.id }); await apost(`/routes/${r2.id}/drivers`, { driverId: d1.id });
  assert.equal((await newTrip(r2, v2, d1, 70, 71)).status, 409, 'vehicle is not assigned to the route');
  assert.equal((await newTrip(r2, v1, d2, 70, 71)).status, 409, 'driver is not assigned to the route');
  assert.equal((await newTrip(r2, v1, d1, 70, 71)).status, 201);
});

test('trips: two administrators booking the same driver at the same moment - exactly one succeeds', async () => {
  const r = await route(); const v1 = await vehicle(); const v2 = await vehicle(); const d = await driver();
  const res = await Promise.all([newTrip(r, v1, d, 100, 102), newTrip(r, v2, d, 101, 103)]);
  assert.deepEqual(res.map((x) => x.status).sort(), [201, 409]);
  const res2 = await Promise.all([newTrip(r, v1, await driver(), 200, 202), newTrip(r, v1, await driver(), 201, 203)]);
  assert.deepEqual(res2.map((x) => x.status).sort(), [201, 409], 'same vehicle');
});

test('trips: start, complete with a passenger count, history, editing rules, and daily / monthly monitoring', async () => {
  const r = await route({ name: 'Monitor route' }); const v = await vehicle(); const d = await driver(); const student = await activeStudent();
  const planned = await newTrip(r, v, d, 1, 3, { notes: 'First run' }); const id = planned.body.trip.id;
  assert.equal((await apost(`/trips/${id}/complete`, {})).status, 409, 'only an ongoing trip can be completed');
  assert.equal((await apatch(`/trips/${id}`, { notes: 'Edited' })).body.trip.notes, 'Edited');
  const started = await apost(`/trips/${id}/start`);
  assert.equal(started.body.trip.status, 'ongoing');
  assert.ok(started.body.trip.actualStart);
  assert.equal((await apost(`/trips/${id}/start`)).status, 409);
  assert.equal((await apatch(`/trips/${id}`, { driverId: (await driver()).id })).status, 409, 'the plan of an ongoing trip is locked');
  const other = await newTrip(r, await vehicle(), d, 10, 12);
  assert.equal((await apost(`/trips/${other.body.trip.id}/start`)).status, 409, 'the driver is already on a trip');
  assert.equal((await ride(d, student)).body.code, 'VERIFIED_STUDENT');
  assert.equal((await aget(`/trips/${id}`)).body.trip.scannedPassengers, 1, 'rides verified by the driver during the trip are counted');
  const done = await apost(`/trips/${id}/complete`, {});
  assert.equal(done.body.trip.status, 'completed');
  assert.equal(done.body.trip.passengerCount, 1, 'defaults to the scanned rides');
  assert.ok(done.body.trip.actualEnd);
  assert.equal((await apost(`/trips/${id}/cancel`, { reason: 'too late' })).status, 409);
  assert.equal((await apatch(`/trips/${id}`, { notes: 'x' })).status, 409, 'completed trips are read-only');
  assert.equal((await apost(`/trips/${other.body.trip.id}/cancel`, {})).status, 400, 'a cancellation needs a reason');
  assert.equal((await aget('/trips?status=completed')).body.total, 1);
  assert.equal((await aget(`/trips?driverId=${d.id}`)).body.total, 2);
  assert.equal((await aget('/trips?q=Monitor')).body.total, 2);
  const day = todayYmd();
  assert.equal((await aget(`/trips?from=${day}&to=${day}`)).body.total >= 0, true);
  const daily = (await aget(`/trips/monitor?period=daily&date=${day}`)).body;
  const monthly = (await aget(`/trips/monitor?period=monthly&date=${day.slice(0, 7)}`)).body;
  assert.equal(monthly.totals.completed, 1);
  assert.equal(monthly.totals.trips, 2);
  assert.equal(monthly.totals.passengers, 1);
  assert.ok(monthly.rows.length >= 28);
  assert.ok(daily.totals.trips >= 0 && Array.isArray(daily.trips));
  assert.equal((await aget('/trips/monitor?period=daily&date=2026-13-40')).status, 400);
  assert.equal((await aget('/trips/monitor?period=monthly&date=bad')).status, 400);
});

test('vehicles and routes with open trips cannot be taken out of service', async () => {
  const r = await route(); const v = await vehicle(); const d = await driver();
  await apost(`/vehicles/${v.id}/driver`, { driverId: d.id });
  const t = await newTrip(r, v, d, 5, 6);
  assert.equal((await apost(`/vehicles/${v.id}/status`, { status: 'inactive' })).status, 409);
  assert.equal((await apost(`/routes/${r.id}/status`, { status: 'inactive' })).status, 409);
  assert.equal((await adel(`/vehicles/${v.id}/driver`)).status, 409);
  await apost(`/routes/${r.id}/vehicles`, { vehicleId: v.id });
  const t2 = await newTrip(r, v, d, 7, 8);
  assert.equal((await adel(`/routes/${r.id}/vehicles/${v.id}`)).status, 409);
  await apost(`/trips/${t.body.trip.id}/cancel`, { reason: 'x1x1' }); await apost(`/trips/${t2.body.trip.id}/cancel`, { reason: 'x1x1' });
  assert.equal((await apost(`/vehicles/${v.id}/status`, { status: 'inactive' })).status, 200);
  assert.equal((await apost(`/routes/${r.id}/status`, { status: 'inactive' })).status, 200);
});

/* ================================================================== 6. driver devices */

test('devices: register, link to a driver, activate / deactivate, remove, re-link, and the full history', async () => {
  const d1 = await driver(); const d2 = await driver();
  const reg = await apost('/devices', { driverId: d1.id, identifier: 'web-abc12345', name: 'Bus 1 tablet', platform: 'Android' });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal(reg.body.device.driver, d1.name);
  assert.equal((await apost('/devices', { driverId: d2.id, identifier: 'web-abc12345', name: 'Copy' })).status, 409, 'one device, one driver');
  assert.equal((await apost('/devices', { driverId: d2.id, identifier: 'x', name: 'Short id' })).status, 400);
  assert.equal((await apost('/devices', { driverId: 99999, identifier: 'web-other-1', name: 'Ghost' })).status, 404);
  assert.equal((await apost('/devices', { driverId: (await driver({ status: 'pending' })).id, identifier: 'web-other-2', name: 'Pending' })).status, 409);
  const id = reg.body.device.id;
  assert.equal((await apost(`/devices/${id}/status`, { status: 'inactive' })).body.device.status, 'inactive');
  assert.equal((await apost(`/devices/${id}/status`, { status: 'inactive' })).status, 409);
  assert.equal((await apost(`/devices/${id}/status`, { status: 'active' })).body.device.status, 'active');
  assert.equal((await apost(`/devices/${id}/remove`, {})).status, 400, 'removal needs a reason');
  assert.equal((await apost(`/devices/${id}/remove`, { reason: 'Lost tablet' })).body.device.status, 'removed');
  assert.equal((await aget('/devices')).body.total, 0, 'removed devices leave the list');
  assert.equal((await aget('/devices?status=removed')).body.total, 1);
  assert.equal((await apost(`/devices/${id}/status`, { status: 'active' })).status, 409, 'a removed device must be registered again');
  const re = await apost('/devices', { driverId: d2.id, identifier: 'web-abc12345', name: 'Moved tablet' });
  assert.equal(re.status, 201, 're-registering a removed device links it to the new driver');
  assert.equal(re.body.device.driver, d2.name);
  const hist = (await aget(`/devices/history?deviceId=${id}`)).body.items.map((e) => e.event).reverse();
  assert.deepEqual(hist, ['registered', 'deactivated', 'activated', 'removed', 'relinked']);
  assert.equal((await aget(`/devices?driverId=${d2.id}`)).body.total, 1);
  assert.equal((await aget('/devices?q=moved')).body.total, 1);
  assert.equal((await aget('/devices/summary')).body.active, 1);
});

test('devices: activity is monitored (scans per device, unregistered devices) and enforcement refuses unauthorized ones', async () => {
  const d = await driver(); const other = await driver(); const s = await activeStudent();
  // enforcement OFF (default): scanning still works, the device is recorded as unregistered
  const first = await ride(d, s, { 'X-Device-Id': 'web-unknown-01' });
  assert.equal(first.status, 200);
  const act = (await aget('/devices/activity')).body;
  assert.equal(act.unregistered[0].identifier, 'web-unknown-01');
  assert.equal(act.unregistered[0].driverId, d.id);
  assert.equal((await aget('/devices/summary')).body.unregisteredSeen, 1);
  assert.ok((await aget(`/devices/history?driverId=${d.id}`)).body.items.some((e) => e.event === 'unregistered_use'));
  // register it: activity moves to the device
  const reg = (await apost('/devices', { driverId: d.id, identifier: 'web-unknown-01', name: 'Phone' })).body.device;
  await ride(d, s, { 'X-Device-Id': 'web-unknown-01' });
  const row = (await aget('/devices')).body.items[0];
  assert.equal(row.scanCount, 2);
  assert.ok(row.lastSeenAt, 'last activity is tracked');
  assert.equal((await aget('/devices/activity')).body.unregistered.length, 0);
  // enforcement ON
  assert.equal((await apatch('/settings', { 'devices.enforce': true })).status, 200);
  assert.equal((await ride(d, s, { 'X-Device-Id': 'web-unknown-01' })).status, 200, 'the registered device works');
  const noHeader = await ride(d, s);
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.body.code, 'DEVICE_NOT_AUTHORIZED');
  assert.equal((await ride(d, s, { 'X-Device-Id': 'web-stranger-9' })).status, 403);
  assert.equal((await ride(other, s, { 'X-Device-Id': 'web-unknown-01' })).status, 403, "another driver cannot use this driver's device");
  await apost(`/devices/${reg.id}/status`, { status: 'inactive' });
  assert.equal((await ride(d, s, { 'X-Device-Id': 'web-unknown-01' })).status, 403, 'a deactivated device is refused');
  assert.equal((await ctx.api.post('/api/scanner/lookup').set(auth(admin)).send({ schoolId: s.schoolId })).status, 200, 'administrators are not device-checked');
  assert.ok((await aget('/devices/activity')).body.blocked.length >= 1);
  await apost(`/devices/${reg.id}/status`, { status: 'active' });
  assert.equal((await ride(d, s, { 'X-Device-Id': 'web-unknown-01' })).status, 200);
});
