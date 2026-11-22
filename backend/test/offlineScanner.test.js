'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, reset, login, auth, studentPayload } = require('./helpers');

let ctx; let admin; let driver;

before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await reset(ctx.pool);
  admin = await login(ctx.api);
  await ctx.api.post('/api/admin/drivers').set(auth(admin))
    .send({ name: 'Offline Driver', username: 'offline', email: 'offline@example.com', password: 'driver-pass-1', unit: 'Bus 7' });
  driver = (await ctx.api.post('/api/auth/login').send({ username: 'offline', password: 'driver-pass-1' })).body.token;
});
after(() => ctx.pool.end());

async function register(over = {}) {
  const body = { ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1', ...over };
  const reg = await ctx.api.post('/api/student-portal/register').send(body);
  assert.equal(reg.status, 201);
  const lg = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  return { id: reg.body.student.id, schoolId: body.schoolId, name: body.name, st: auth(lg.body.token) };
}
async function verifiedStudent() {
  const s = await register();
  await ctx.api.post(`/api/admin/verifications/${s.id}/approve`).set(auth(admin)).send({});
  s.qr = (await ctx.api.post('/api/student-portal/me/qr').set(s.st)).body.qr;
  return s;
}
const sync = (items, token = driver) => ctx.api.post('/api/scanner/sync').set(auth(token)).send({ items });
const offlineItem = (over = {}) => ({
  clientId: crypto.randomUUID(), method: 'qr', value: 'unused', scannedAt: new Date().toISOString(), ...over
});

test('an offline check keeps its original time, is marked offline, and becomes a normal transaction', async () => {
  const s = await verifiedStudent();
  const recordedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const item = offlineItem({ value: s.qr.payload, scannedAt: recordedAt.toISOString() });
  const res = await sync([item]);
  assert.equal(res.status, 200);
  const r = res.body.results[0];
  assert.equal(r.ok, true);
  assert.equal(r.code, 'VERIFIED_STUDENT');
  assert.equal(r.duplicate, false);
  assert.match(r.reference, /^TXN-\d{8}$/);
  assert.equal(res.body.synced, 1);

  const [rows] = await ctx.pool.query('SELECT * FROM scans');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.client_txn_id, item.clientId);
  assert.equal(row.offline, 1);
  assert.ok(row.synced_at);
  assert.ok(Math.abs(new Date(row.scanned_at).getTime() - recordedAt.getTime()) < 1500, 'the ride time is the time it was recorded, not the sync time');
  assert.equal(row.result, 'granted');

  const scans = (await ctx.api.get('/api/driver/scans').set(auth(driver))).body.items;
  assert.equal(scans[0].offline, true);
  assert.ok(scans[0].syncedAt);
  const tx = (await ctx.api.get('/api/driver/transactions').set(auth(driver))).body;
  assert.equal(tx.items[0].reference, r.reference);
  assert.equal(tx.items[0].offline, true);
});

test('re-sending the same client id never creates a second transaction or a second scan count', async () => {
  const s = await verifiedStudent();
  const item = offlineItem({ value: s.qr.payload });
  const first = await sync([item]);
  const second = await sync([item]);
  assert.equal(second.status, 200);
  assert.equal(second.body.results[0].duplicate, true);
  assert.equal(second.body.results[0].reference, first.body.results[0].reference);
  assert.equal(second.body.results[0].scanId, first.body.results[0].scanId);
  const [[n]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM scans');
  assert.equal(n.n, 1);
  const [[st]] = await ctx.pool.query('SELECT scans FROM students WHERE id = ?', [s.id]);
  assert.equal(st.scans, 1, 'the granted counter is bumped exactly once');
});

test('one rejected item does not lose the rest of the batch', async () => {
  const s = await verifiedStudent();
  const tooOld = offlineItem({ value: s.qr.payload, scannedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() });
  const good = offlineItem({ value: s.qr.payload });
  const res = await sync([tooOld, good]);
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].ok, false);
  assert.match(res.body.results[0].error, /7 days/);
  assert.equal(res.body.results[1].ok, true);
  assert.equal(res.body.synced, 1);
  assert.equal(res.body.failed, 1);
  const [[n]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM scans');
  assert.equal(n.n, 1);
});

test('a manual School ID recorded offline is verified by the server at sync time', async () => {
  const s = await verifiedStudent();
  const item = offlineItem({ method: 'manual', value: s.schoolId });
  const res = await sync([item]);
  assert.equal(res.body.results[0].code, 'VERIFIED_STUDENT');
  const [[row]] = await ctx.pool.query('SELECT scan_method, scanned_value, client_txn_id FROM scans');
  assert.equal(row.scan_method, 'manual');
  assert.equal(row.scanned_value, s.schoolId);
  assert.equal(row.client_txn_id, item.clientId);

  const pending = await register();
  const pendingRes = await sync([offlineItem({ method: 'manual', value: pending.schoolId })]);
  assert.equal(pendingRes.body.results[0].code, 'PENDING_VERIFICATION');
  assert.equal(pendingRes.body.results[0].reference, null, 'a denied check is not a transaction');
});

test('client ids are scoped to the driver who recorded them', async () => {
  const a = await verifiedStudent();
  const b = await verifiedStudent();
  await ctx.api.post('/api/admin/drivers').set(auth(admin))
    .send({ name: 'Second Driver', username: 'second', email: 'second@example.com', password: 'driver-pass-1', unit: 'Bus 8' });
  const driver2 = (await ctx.api.post('/api/auth/login').send({ username: 'second', password: 'driver-pass-1' })).body.token;
  const sharedId = crypto.randomUUID();
  const r1 = await sync([offlineItem({ clientId: sharedId, value: a.qr.payload })]);
  const r2 = await sync([offlineItem({ clientId: sharedId, value: b.qr.payload })], driver2);
  assert.equal(r1.body.results[0].duplicate, false);
  assert.equal(r2.body.results[0].duplicate, false);
  const [[n]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM scans');
  assert.equal(n.n, 2, 'the unique key is per driver, not global');
});

test('sync validates its input and requires a driver session', async () => {
  assert.equal((await ctx.api.post('/api/scanner/sync').send({ items: [] })).status, 401);
  const tooMany = Array.from({ length: 51 }, () => offlineItem());
  assert.equal((await sync(tooMany)).status, 400);
  assert.equal((await sync([])).status, 400);
  assert.equal((await sync([offlineItem({ clientId: 'short' })])).status, 400);
  const badDate = offlineItem({ scannedAt: 'not-a-date' });
  assert.equal((await sync([badDate])).status, 400);
});

test('normal online scans are unchanged: no offline flag, no sync time', async () => {
  const s = await verifiedStudent();
  const res = await ctx.api.post('/api/scanner/scan').set(auth(driver)).send({ code: s.qr.payload });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'VERIFIED_STUDENT');
  assert.equal(res.body.duplicate, false);
  assert.equal(res.body.scan.offline, false);
  assert.equal(res.body.scan.syncedAt, null);
  const [[row]] = await ctx.pool.query('SELECT offline, client_txn_id, synced_at FROM scans');
  assert.equal(row.offline, 0);
  assert.equal(row.client_txn_id, null);
  assert.equal(row.synced_at, null);
});
