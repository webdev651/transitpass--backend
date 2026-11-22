'use strict';
// Phase 1 - driver web portal: change password, notification inbox, own documents, dashboard, assigned service, transactions, authorization.
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-drv-up-'));
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload, config } = require('./helpers');
const { todayYmd } = require('../src/lib/dates');
const notifications = require('../src/services/notifications');
const driverDocs = require('../src/services/driverDocs');

let ctx, admin;
before(async () => { ctx = await setup(); });
beforeEach(async () => { await reset(ctx.pool); admin = await login(ctx.api); });
after(async () => { await ctx.pool.end(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const A = '/api/admin';
const D = '/api/driver';
const PW = config.seedAdmin.password;
const STRONG = 'Fresh-Pass-9!';
const dget = (p, t) => ctx.api.get(D + p).set(auth(t));
const dpost = (p, b, t) => ctx.api.post(D + p).set(auth(t)).send(b || {});
const apost = (p, b, t = admin) => ctx.api.post(A + p).set(auth(t)).send(b || {});

let dn = 0;
async function driver(over = {}) {
  dn += 1;
  const body = { name: `Driver ${dn}`, username: `driver${dn}`, email: `driver${dn}@example.com`, password: 'driver-pass-1', status: 'active', ...over };
  const res = await ctx.api.post(`${A}/drivers`).set(auth(admin)).send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const token = (await ctx.api.post('/api/auth/login').send({ username: body.username, password: body.password })).body.token;
  return { ...res.body.driver, token, username: body.username, password: body.password };
}
const notify = (d, title, over = {}) => notifications.notifyDriver(ctx.pool, d, { category: 'general', title, body: `${title} body`, ...over });
const upload = (d, type, over = {}, buf = PDF, name = 'doc.pdf') => {
  let r = ctx.api.post(`${D}/documents`).set(auth(d.token)).field('type', type);
  for (const [k, v] of Object.entries({ documentNo: 'N01-23-456789', expiresOn: todayYmd(400), ...over })) if (v !== undefined) r = r.field(k, v);
  return r.attach('file', buf, { filename: name });
};

/* ================================================================== 1-4. change password */

test('driver changes their password: current password is verified, the new one is confirmed and checked for strength', async () => {
  const d = await driver();
  const post = (b, t = d.token) => ctx.api.post(`${A}/account/password`).set(auth(t)).send(b);

  // current password verification
  let r = await post({ current: 'not-my-password', new: STRONG, confirm: STRONG });
  assert.equal(r.status, 400); assert.match(r.body.error, /current password is incorrect/i);
  // confirmation must match
  r = await post({ current: d.password, new: STRONG, confirm: 'Different-Pass-9!' });
  assert.equal(r.status, 400); assert.ok(JSON.stringify(r.body).match(/do not match/i));
  // strength: each missing rule is named
  r = await post({ current: d.password, new: 'alllowercase', confirm: 'alllowercase' });
  assert.equal(r.status, 400); assert.match(r.body.error, /too weak/i); assert.match(r.body.error, /uppercase/); assert.match(r.body.error, /number/); assert.match(r.body.error, /symbol/);
  r = await post({ current: d.password, new: 'NoSymbols123', confirm: 'NoSymbols123' });
  assert.equal(r.status, 400); assert.match(r.body.error, /symbol/);
  r = await post({ current: d.password, new: 'Sh0rt!', confirm: 'Sh0rt!' });
  assert.equal(r.status, 400);
  // not the same as the current one, and not containing the username
  r = await post({ current: d.password, new: d.password, confirm: d.password });
  assert.equal(r.status, 400); assert.match(r.body.error, /different/i);
  r = await post({ current: d.password, new: `${d.username}-Pass1!`, confirm: `${d.username}-Pass1!` });
  assert.equal(r.status, 400); assert.match(r.body.error, /username/i);
  // nothing changed so far
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: d.username, password: d.password })).status, 200);

  // a good change: new token, old token dead, old password dead, hash stored with bcrypt, change is in the activity log
  r = await post({ current: d.password, new: STRONG, confirm: STRONG });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
  assert.equal((await dget('/me', d.token)).status, 401, 'the old session is signed out');
  assert.equal((await dget('/me', r.body.token)).status, 200, 'the session that made the change continues');
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: d.username, password: d.password })).status, 401);
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: d.username, password: STRONG })).status, 200);
  const [[row]] = await ctx.pool.query('SELECT password_hash FROM admins WHERE id = ?', [d.id]);
  assert.match(row.password_hash, /^\$2[aby]\$/);
  assert.equal(JSON.stringify(r.body).includes(STRONG), false);
  const [logs] = await ctx.pool.query("SELECT description FROM activity_logs WHERE admin_id = ? AND description LIKE '%password%'", [d.id]);
  assert.ok(logs.length >= 1);
});

test('the driver password rules do not change the administrator policy, and a driver can only change their OWN password', async () => {
  const a = await driver(); const b = await driver();
  // administrator keeps the existing rule (8+ characters, not common): a simple password is still accepted
  const r = await ctx.api.post(`${A}/account/password`).set(auth(admin)).send({ current: PW, new: 'simplelongpassword', confirm: 'simplelongpassword' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // the endpoint has no way to name another account: B's password is untouched after A changes theirs
  await ctx.api.post(`${A}/account/password`).set(auth(a.token)).send({ current: a.password, new: STRONG, confirm: STRONG });
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: b.username, password: b.password })).status, 200);
  // unauthenticated
  assert.equal((await ctx.api.post(`${A}/account/password`).send({ current: 'x', new: STRONG, confirm: STRONG })).status, 401);
});

/* ================================================================== 5-8. notification inbox */

test('notification inbox: read / unread, filters, counter, mark one and mark all as read - always limited to the signed-in driver', async () => {
  const a = await driver(); const b = await driver();
  const a1 = await notify(a, 'A first'); const a2 = await notify(a, 'A second', { category: 'account_status' }); await notify(a, 'A third', { category: 'announcement' });
  const b1 = await notify(b, 'B only');

  let inbox = (await dget('/notifications', a.token)).body;
  assert.equal(inbox.items.length, 3);
  assert.equal(inbox.unread, 3); assert.equal(inbox.read, 0); assert.equal(inbox.all, 3);
  assert.ok(inbox.items.every((n) => n.read === false && n.driverId === a.id));
  assert.equal(JSON.stringify(inbox).includes('B only'), false, 'another driver\'s message never appears');
  assert.deepEqual((await dget('/notifications/count', a.token)).body, { all: 3, unread: 3, read: 0 });

  // mark one as read
  assert.equal((await dpost(`/notifications/${a1}/read`, {}, a.token)).status, 200);
  assert.deepEqual((await dget('/notifications/count', a.token)).body, { all: 3, unread: 2, read: 1 });
  const [[first]] = await ctx.pool.query('SELECT read_at FROM notifications WHERE id = ?', [a1]);
  assert.ok(first.read_at);
  assert.equal((await dpost(`/notifications/${a1}/read`, {}, a.token)).status, 200, 'marking it again is harmless');
  const [[again]] = await ctx.pool.query('SELECT read_at FROM notifications WHERE id = ?', [a1]);
  assert.equal(new Date(again.read_at).getTime(), new Date(first.read_at).getTime(), 'the first read time is kept');

  // filters
  assert.equal((await dget('/notifications?filter=unread', a.token)).body.items.length, 2);
  assert.equal((await dget('/notifications?filter=read', a.token)).body.items.length, 1);
  assert.equal((await dget('/notifications?filter=unread&category=account_status', a.token)).body.items.length, 1);
  assert.equal((await dget('/notifications?filter=unread', a.token)).body.total, 2);
  assert.equal((await dget('/notifications?limit=1', a.token)).body.items.length, 1);
  assert.equal((await dget('/notifications?filter=bogus', a.token)).status, 400);
  assert.equal((await dget('/notifications?category=bogus', a.token)).status, 400);

  // somebody else's notification, or one that does not exist, is "not found" and stays unread
  assert.equal((await dpost(`/notifications/${b1}/read`, {}, a.token)).status, 404);
  assert.equal((await dpost('/notifications/999999/read', {}, a.token)).status, 404);
  assert.equal((await dpost('/notifications/abc/read', {}, a.token)).status, 404);
  assert.equal((await dget('/notifications/count', b.token)).body.unread, 1);

  // mark all as read: only this driver's
  const all = await dpost('/notifications/read-all', {}, a.token);
  assert.equal(all.status, 200); assert.equal(all.body.marked, 2); assert.equal(all.body.unread, 0);
  assert.deepEqual((await dget('/notifications/count', a.token)).body, { all: 3, unread: 0, read: 3 });
  assert.equal((await dget('/notifications/count', b.token)).body.unread, 1, 'the other driver is untouched');
  assert.equal((await dpost('/notifications/read-all', {}, a.token)).body.marked, 0);
  void a2;
});

test('notification inbox authorization: admins, students and anonymous callers cannot use it', async () => {
  const a = await driver(); await notify(a, 'hello');
  for (const p of ['/notifications', '/notifications/count']) {
    assert.equal((await dget(p, admin)).status, 403, p);
    assert.equal((await ctx.api.get(D + p)).status, 401, p);
  }
  assert.equal((await dpost('/notifications/read-all', {}, admin)).status, 403);
  await ctx.api.post('/api/student-portal/register').send({ ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1' });
  const [[s]] = await ctx.pool.query('SELECT school_id FROM students LIMIT 1');
  const st = (await ctx.api.post('/api/student-portal/login').send({ schoolId: s.school_id, password: 'secret-pass-1' })).body.token;
  assert.equal((await dget('/notifications', st)).status, 401);
});

test('an administrator rejecting a document sends the driver a notification that shows up in the inbox and the counter', async () => {
  const a = await driver();
  const up = await upload(a, 'license');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  await apost(`/driver-documents/${up.body.document.id}/review`, { decision: 'rejected', reason: 'Licence photo is unreadable' });
  const inbox = (await dget('/notifications', a.token)).body;
  assert.equal(inbox.unread, 1);
  assert.match(inbox.items[0].title, /not approved/i);
  assert.match(inbox.items[0].body, /Licence photo is unreadable/);
});

/* ================================================================== 9-13. documents */

test('driver documents: upload, preview, status, expiry tracking, administrator remarks and replacement - only the owner can open a file', async () => {
  const a = await driver(); const b = await driver();

  let docs = (await dget('/documents', a.token)).body;
  assert.equal(docs.items.length, 2);
  assert.ok(docs.items.every((x) => x.status === 'missing'));
  assert.equal(docs.verification, 'incomplete');

  // upload: pending until an administrator reviews it; the file path is never returned
  const up = await upload(a, 'license', { expiresOn: todayYmd(10) });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const lic = up.body.document;
  assert.equal(lic.status, 'pending'); assert.equal(lic.expiryState, 'expiring'); assert.equal(lic.daysToExpiry, 10);
  assert.equal(JSON.stringify(up.body).includes('file_path'), false);
  assert.equal(JSON.stringify(up.body).includes('drivers/'), false);
  const [[stored]] = await ctx.pool.query('SELECT driver_id, uploaded_by FROM driver_documents WHERE id = ?', [lic.id]);
  assert.equal(stored.driver_id, a.id); assert.equal(stored.uploaded_by, a.id);

  // the driver cannot upload "for" someone else: a driverId in the form is ignored
  const sneaky = await ctx.api.post(`${D}/documents`).set(auth(a.token)).field('type', 'government_id').field('driverId', String(b.id)).field('documentNo', 'ID-1')
    .attach('file', PNG, { filename: 'id.png' });
  assert.equal(sneaky.status, 201);
  const [[sn]] = await ctx.pool.query('SELECT driver_id FROM driver_documents WHERE id = ?', [sneaky.body.document.id]);
  assert.equal(sn.driver_id, a.id);
  assert.equal((await dget('/documents', b.token)).body.items.every((x) => x.status === 'missing'), true);

  // preview: the right bytes and type; owner only
  const file = await ctx.api.get(`${D}/documents/${lic.id}/file`).set(auth(a.token));
  assert.equal(file.status, 200);
  assert.match(file.headers['content-type'], /application\/pdf/);
  assert.equal(file.headers['x-content-type-options'], 'nosniff');
  assert.match(file.headers['cache-control'], /no-store/);
  assert.equal((await ctx.api.get(`${D}/documents/${lic.id}/file`).set(auth(b.token))).status, 404, 'another driver gets "not found"');
  assert.equal((await ctx.api.get(`${D}/documents/${lic.id}/file`).set(auth(admin))).status, 403);
  assert.equal((await ctx.api.get(`${D}/documents/${lic.id}/file`)).status, 401);
  assert.equal((await ctx.api.get(`${D}/documents/abc/file`).set(auth(a.token))).status, 404);
  assert.equal((await ctx.api.get(`${D}/documents/99999/file`).set(auth(a.token))).status, 404);

  // administrator rejects with a remark: the driver sees status + remark; verification follows
  await apost(`/driver-documents/${lic.id}/review`, { decision: 'rejected', reason: 'The licence photo is blurred' });
  docs = (await dget('/documents', a.token)).body;
  let cur = docs.items.find((x) => x.type === 'license');
  assert.equal(cur.status, 'rejected'); assert.equal(cur.remarks, 'The licence photo is blurred'); assert.ok(cur.reviewedAt);
  assert.equal(docs.verification, 'rejected');

  // replacement: a new pending document becomes current, the old one moves to history with its remark
  const rep = await upload(a, 'license', { expiresOn: todayYmd(300), documentNo: 'N01-99-000001' }, PNG, 'new.png');
  assert.equal(rep.status, 201);
  assert.notEqual(rep.body.document.id, lic.id);
  docs = (await dget('/documents', a.token)).body;
  cur = docs.items.find((x) => x.type === 'license');
  assert.equal(cur.id, rep.body.document.id); assert.equal(cur.status, 'pending'); assert.equal(cur.remarks, null); assert.equal(cur.expiryState, 'valid');
  assert.ok(docs.history.some((h) => h.id === lic.id && h.status === 'rejected' && h.remarks === 'The licence photo is blurred'));
  assert.equal((await ctx.api.get(`${D}/documents/${lic.id}/file`).set(auth(a.token))).status, 200, 'the old file can still be previewed from history');

  // administrator approves both: verification becomes "verified"
  await apost(`/driver-documents/${rep.body.document.id}/review`, { decision: 'verified' });
  await apost(`/driver-documents/${sneaky.body.document.id}/review`, { decision: 'verified' });
  docs = (await dget('/documents', a.token)).body;
  assert.equal(docs.verification, 'verified');
  assert.deepEqual(docs.items.map((x) => x.status).sort(), ['verified', 'verified']);

  // expiry tracking: a verified document past its date is shown as expired (and the dashboard counts it)
  await ctx.pool.query('UPDATE driver_documents SET expires_on = ? WHERE id = ?', [todayYmd(-3), rep.body.document.id]);
  docs = (await dget('/documents', a.token)).body;
  cur = docs.items.find((x) => x.type === 'license');
  assert.equal(cur.status, 'expired'); assert.equal(cur.expiryState, 'expired'); assert.equal(cur.daysToExpiry, -3);
  assert.equal(docs.verification, 'expired');
});

test('document expiration alerts: a verified document expiring within the warning window notifies the driver once, and expired documents are not re-alerted', async () => {
  const a = await driver();
  const up = await upload(a, 'license', { expiresOn: todayYmd(10) });
  assert.equal(up.status, 201);

  // pending documents do not trigger an alert
  let made = await driverDocs.notifyExpiring(ctx.pool);
  assert.equal(made.notified, 0);

  // once verified, the driver gets an expiration alert (plus the approval notification from the review)
  await apost(`/driver-documents/${up.body.document.id}/review`, { decision: 'verified' });
  made = await driverDocs.notifyExpiring(ctx.pool);
  assert.equal(made.notified, 1);
  const inbox = (await dget('/notifications', a.token)).body;
  assert.equal(inbox.unread, 2);              // "approved" + "expires soon"
  assert.match(inbox.items[0].title, /expires soon/i);  // newest first: the expiry alert
  assert.match(inbox.items[0].body, /expires on/);

  // dedupe: running again creates no duplicate notification
  made = await driverDocs.notifyExpiring(ctx.pool);
  assert.equal(made.notified, 0);
  assert.deepEqual((await dget('/notifications/count', a.token)).body, { all: 2, unread: 2, read: 0 });

  // an already-expired verified document is not re-alerted (outside the upcoming window)
  await ctx.pool.query('UPDATE driver_documents SET expires_on = ? WHERE id = ?', [todayYmd(-3), up.body.document.id]);
  made = await driverDocs.notifyExpiring(ctx.pool);
  assert.equal(made.notified, 0);
});

test('driver document uploads are validated like the administrator ones', async () => {
  const a = await driver();
  assert.equal((await upload(a, 'license', {}, Buffer.from('just some text, not a document'), 'x.pdf')).status, 400, 'type is read from the file, not the name');
  assert.equal((await upload(a, 'license', { expiresOn: undefined })).status, 400, 'a licence needs an expiry date');
  assert.equal((await upload(a, 'license', { expiresOn: todayYmd(-1) })).status, 400, 'an expired document is refused');
  assert.equal((await upload(a, 'license', { expiresOn: '2026-02-31' })).status, 400);
  assert.equal((await upload(a, 'passport')).status, 400);
  assert.equal((await ctx.api.post(`${D}/documents`).set(auth(a.token)).field('type', 'license').field('expiresOn', todayYmd(100))).status, 400, 'a file is required');
  assert.equal((await upload(a, 'government_id', { expiresOn: undefined }, PNG, 'id.png')).status, 201, 'an ID may have no expiry');
  const big = Buffer.concat([PDF, Buffer.alloc(config.uploads.maxDocBytes + 10, 1)]);
  assert.equal((await upload(a, 'license', {}, big)).status, 413);
  // nothing from the refused attempts was kept
  const [[n]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM driver_documents WHERE driver_id = ?', [a.id]);
  assert.equal(Number(n.n), 1);
  // administrators and anonymous callers cannot use the driver upload
  assert.equal((await ctx.api.post(`${D}/documents`).set(auth(admin)).field('type', 'license').attach('file', PDF, { filename: 'x.pdf' })).status, 403);
  assert.equal((await ctx.api.post(`${D}/documents`).field('type', 'license').attach('file', PDF, { filename: 'x.pdf' })).status, 401);
  assert.equal((await ctx.api.get(`${D}/documents`)).status, 401);
  assert.equal((await ctx.api.get(`${D}/documents`).set(auth(admin))).status, 403);
});

test('an administrator sees the driver\'s own upload in the existing Driver Documents module (nothing duplicated)', async () => {
  const a = await driver();
  const up = await upload(a, 'license');
  const list = (await ctx.api.get(`${A}/driver-documents?driverId=${a.id}`).set(auth(admin))).body;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, up.body.document.id); assert.equal(list.items[0].status, 'pending'); assert.equal(list.items[0].uploadedBy, a.name);
  const [logs] = await ctx.pool.query("SELECT admin_id FROM activity_logs WHERE action = 'driver.document.upload'");
  assert.equal(logs.length, 1); assert.equal(logs[0].admin_id, a.id);
});

/* ================================================================== 14-16. dashboard, assigned service, transactions */

const insertScan = (d, result, fare = 13, discount = 3.25, over = {}) => ctx.pool.query(
  `INSERT INTO scans (student_name, school_id, route, operator, fare, fare_amount, discount_amount, result, scanned_by, driver_name, scanned_at)
   VALUES (?, ?, 'Route X', 'op', 'Student fare', ?, ?, ?, ?, ?, ?)`,
  [over.student || 'Sam Student', over.schoolId || '2026-0001', fare, discount, result, d.id, d.name, over.at || new Date()]);

test('dashboard: totals, last 7 days, fares, documents and notifications are the driver\'s own numbers (no mock data)', async () => {
  const a = await driver(); const b = await driver();
  await insertScan(a, 'granted'); await insertScan(a, 'granted'); await insertScan(a, 'review', 16.25, 0); await insertScan(a, 'denied', 0, 0);
  await insertScan(a, 'granted', 13, 3.25, { at: new Date(Date.now() - 3 * 86400000) });
  await insertScan(b, 'granted'); await insertScan(b, 'granted');
  await notify(a, 'hello');
  await upload(a, 'license');

  const d = (await dget('/dashboard', a.token)).body;
  assert.equal(d.driver.id, a.id);
  assert.deepEqual(d.stats.allTime, { total: 5, verified: 3, rejected: 1, review: 1 });
  assert.deepEqual(d.stats.today, { total: 4, verified: 2, rejected: 1, review: 1 });
  assert.equal(d.daily.length, 7);
  assert.equal(d.daily[6].total, 4, 'today is the last day');
  assert.equal(d.daily.reduce((n, x) => n + x.total, 0), 5);
  assert.equal(d.fares.allTime.count, 4); assert.equal(d.fares.allTime.revenue, 13 + 13 + 16.25 + 13);
  assert.equal(d.fares.today.count, 3); assert.equal(d.fares.today.revenue, 13 + 13 + 16.25);
  assert.equal(d.notifications.unread, 1); assert.equal(d.notifications.latest.length, 1);
  assert.equal(d.documents.verification, 'incomplete');
  assert.equal(d.documents.items.find((x) => x.type === 'license').status, 'pending');
  assert.equal(d.service.assigned, false);

  // the other driver sees only their own numbers
  const o = (await dget('/dashboard', b.token)).body;
  assert.equal(o.stats.allTime.total, 2); assert.equal(o.notifications.unread, 0);
  // existing endpoints keep working
  assert.equal((await dget('/me', a.token)).body.stats.allTime.total, 5);
  assert.equal((await dget('/scans?limit=50', a.token)).body.total, 5);
  assert.equal((await dget('/dashboard', admin)).status, 403);
  assert.equal((await ctx.api.get(`${D}/dashboard`)).status, 401);
});

test('assigned transportation service: vehicle, routes and trips of this driver only, without other drivers\' details', async () => {
  const a = await driver(); const b = await driver();
  const v = (await apost('/vehicles', { name: 'Bus 7', type: 'Bus', plateNumber: 'ABC 1234', capacity: 40, registrationNo: 'OR-1', registrationExpiry: todayYmd(200) })).body.vehicle;
  const r = (await apost('/routes', { name: 'Campus - Town', origin: 'Campus', destination: 'Town', description: 'Morning run' })).body.route;
  const other = (await apost('/routes', { name: 'Somewhere else', origin: 'X', destination: 'Y' })).body.route;
  assert.equal((await apost(`/vehicles/${v.id}/driver`, { driverId: a.id })).status, 200);
  assert.equal((await apost(`/routes/${r.id}/vehicles`, { vehicleId: v.id })).status, 200);
  assert.equal((await apost(`/routes/${r.id}/drivers`, { driverId: a.id })).status, 200);
  assert.equal((await apost(`/routes/${r.id}/drivers`, { driverId: b.id })).status, 200);
  const start = new Date(Date.now() + 5 * 3600000); const end = new Date(Date.now() + 7 * 3600000);
  const trip = await apost('/trips', { routeId: r.id, vehicleId: v.id, driverId: a.id, startTime: start.toISOString(), endTime: end.toISOString(), notes: 'Bring the scanner' });
  assert.equal(trip.status, 201, JSON.stringify(trip.body));

  const s = (await dget('/service', a.token)).body;
  assert.equal(s.assigned, true);
  assert.equal(s.vehicle.name, 'Bus 7'); assert.equal(s.vehicle.plateNumber, 'ABC 1234'); assert.equal(s.vehicle.capacity, 40); assert.equal(s.vehicle.registrationState, 'valid');
  assert.deepEqual(s.routes.map((x) => x.name), ['Campus - Town']);
  assert.equal(s.routes[0].origin, 'Campus'); assert.equal(s.routes[0].description, 'Morning run');
  assert.equal(JSON.stringify(s).includes(b.name), false, 'other drivers on the route are not shown');
  assert.equal(JSON.stringify(s).includes('Somewhere else'), false);
  assert.equal(s.upcomingTrips.length, 1); assert.equal(s.upcomingTrips[0].route, 'Campus - Town'); assert.equal(s.upcomingTrips[0].notes, 'Bring the scanner');
  assert.equal(s.tripCounts.open, 1);
  assert.equal(s.currentTrip, null);

  // a driver with route access but no vehicle / trips: sees the route, no vehicle
  const sb = (await dget('/service', b.token)).body;
  assert.equal(sb.vehicle, null); assert.deepEqual(sb.routes.map((x) => x.name), ['Campus - Town']); assert.equal(sb.upcomingTrips.length, 0);
  // a driver with nothing assigned
  const c = await driver();
  const sc = (await dget('/service', c.token)).body;
  assert.equal(sc.assigned, false); assert.equal(sc.vehicle, null); assert.deepEqual(sc.routes, []);
  assert.equal((await dget('/service', admin)).status, 403);
  assert.equal((await dget('/service?limit=0', a.token)).status, 400);
  void other;
});

test('transaction history: only this driver\'s rides, with fares, discounts, cancelled / refunded status, search, dates and totals', async () => {
  const a = await driver(); const b = await driver();
  await insertScan(a, 'granted', 13, 3.25, { student: 'Ana Reyes', schoolId: '2026-1111' });
  await insertScan(a, 'granted', 13, 3.25, { student: 'Ben Cruz', schoolId: '2026-2222', at: new Date(Date.now() - 10 * 86400000) });
  await insertScan(a, 'review', 16.25, 0, { student: 'Cara Diaz', schoolId: '2026-3333' });
  await insertScan(a, 'denied', 0, 0, { student: 'Denied Person' });        // a denied scan is not a transaction
  await insertScan(b, 'granted', 13, 3.25, { student: 'Other Driver Rider', schoolId: '2026-9999' });
  const [[cancelRow]] = await ctx.pool.query("SELECT id FROM scans WHERE student_name = 'Ben Cruz'");
  assert.equal((await apost(`/refunds/transactions/${cancelRow.id}/cancel`, { reason: 'Scanned the wrong student', password: PW })).status, 200);

  const all = (await dget('/transactions', a.token)).body;
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map((t) => t.studentName).sort(), ['Ana Reyes', 'Ben Cruz', 'Cara Diaz']);
  assert.equal(JSON.stringify(all).includes('Other Driver Rider'), false);
  assert.equal(JSON.stringify(all).includes('Denied Person'), false);
  const ana = all.items.find((t) => t.studentName === 'Ana Reyes');
  assert.match(ana.reference, /^TXN-\d{8}$/); assert.equal(ana.status, 'completed'); assert.equal(ana.finalFare, 13); assert.equal(ana.regularFare, 16.25); assert.equal(ana.discountAmount, 3.25); assert.equal(ana.discountPercent, 20);
  assert.equal(all.items.find((t) => t.studentName === 'Ben Cruz').status, 'cancelled');
  assert.equal(all.items.find((t) => t.studentName === 'Cara Diaz').underReview, true);
  // totals leave out the cancelled ride
  assert.equal(all.summary.completed.count, 2); assert.equal(all.summary.completed.revenue, 13 + 16.25); assert.equal(all.summary.completed.discounts, 3.25);
  assert.equal(all.summary.cancelled.count, 1);
  // filters
  assert.equal((await dget('/transactions?status=cancelled', a.token)).body.items.length, 1);
  assert.equal((await dget('/transactions?status=completed', a.token)).body.items.length, 2);
  assert.equal((await dget('/transactions?q=Cara', a.token)).body.items.length, 1);
  assert.equal((await dget('/transactions?q=2026-2222', a.token)).body.items.length, 1);
  assert.equal((await dget(`/transactions?from=${todayYmd(-2)}`, a.token)).body.total, 2);
  assert.equal((await dget(`/transactions?to=${todayYmd(-5)}`, a.token)).body.total, 1);
  assert.equal((await dget('/transactions?limit=1&offset=1', a.token)).body.items.length, 1);
  // another driver's id in the query changes nothing; bad input is refused
  assert.equal((await dget(`/transactions?driverId=${b.id}`, a.token)).body.total, 3);
  assert.equal((await dget('/transactions?status=bogus', a.token)).status, 400);
  assert.equal((await dget('/transactions?from=2026-13-40', a.token)).status, 400);
  // the other driver sees only theirs; admin / anonymous are refused
  assert.equal((await dget('/transactions', b.token)).body.total, 1);
  assert.equal((await dget('/transactions', admin)).status, 403);
  assert.equal((await ctx.api.get(`${D}/transactions`)).status, 401);
});

test('a deactivated driver loses access to every driver endpoint at once', async () => {
  const a = await driver();
  for (const p of ['/dashboard', '/service', '/transactions', '/documents', '/notifications', '/notifications/count']) assert.equal((await dget(p, a.token)).status, 200, p);
  await ctx.api.post(`${A}/drivers/${a.id}/actions/deactivate`).set(auth(admin));
  for (const p of ['/dashboard', '/service', '/transactions', '/documents', '/notifications', '/notifications/count']) assert.equal((await dget(p, a.token)).status, 401, p);
});
