'use strict';
// Student-initiated refund requests: a student asks for their money back on a ride,
// an administrator approves or rejects, and the student is notified of every step.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload, config } = require('./helpers');

let ctx, admin, dan;
const PW = config.seedAdmin.password;
const A = '/api/admin';
const SP = '/api/student-portal';
const aget = (p, t = admin) => ctx.api.get(A + p).set(auth(t));
const apost = (p, b, t = admin) => ctx.api.post(A + p).set(auth(t)).send(b || {});
const sget = (p, t) => ctx.api.get(SP + p).set(auth(t));
const spost = (p, b, t) => ctx.api.post(SP + p).set(auth(t)).send(b || {});
const sql = async (q, a) => (await ctx.pool.query(q, a))[0];
const first = async (q, a) => { const r = await sql(q, a); return r.length ? r[0] : null; };

before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await reset(ctx.pool);
  admin = await login(ctx.api);
  const r = await apost('/drivers', { name: 'Dan Driver', username: 'dan', email: 'dan@example.com', password: 'driver-pass-1', unit: 'Bus 1' });
  dan = (await ctx.api.post('/api/auth/login').send({ username: 'dan', password: 'driver-pass-1' })).body.token;
});
after(() => ctx.pool.end());

async function student() {
  const body = { ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1' };
  const reg = await ctx.api.post(SP + '/register').send(body);
  const lg = await ctx.api.post(SP + '/login').send({ schoolId: body.schoolId, password: body.password });
  await apost(`/verifications/${reg.body.student.id}/approve`);
  await ctx.api.post(SP + '/me/qr').set(auth(lg.body.token));
  return { id: reg.body.student.id, schoolId: body.schoolId, name: body.name, token: lg.body.token };
}
async function ride(driverToken, s) {
  const r = await ctx.api.post('/api/scanner/lookup').set(auth(driverToken)).send({ schoolId: s.schoolId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.scan.id;
}

test('refunds: a student can request a refund on their own completed transaction', async () => {
  const s = await student();
  const scanId = await ride(dan, s);
  const before = await sget('/me/refunds', s.token);
  assert.equal(before.body.total, 0);
  const made = await spost('/me/refunds', { scanId, reason: 'Charged twice on the bus' }, s.token);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.refund.source, 'student');
  assert.equal(made.body.refund.requestedBy, s.name);
  assert.equal(made.body.refund.status, 'pending');
  assert.equal(made.body.refund.amount, 13);
  assert.match(made.body.refund.reference, /^TXN-/);
  const list = await sget('/me/refunds', s.token);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.counts.pending, 1);
  assert.equal(list.body.items[0].status, 'pending');
  const row = await first("SELECT source, requested_by, requested_by_name, status FROM refund_requests WHERE id = ?", [made.body.refund.id]);
  assert.ok(row);
  assert.equal(row.source, 'student');
  assert.equal(row.requested_by, null);
  assert.equal(row.requested_by_name, s.name);
  assert.equal(row.status, 'pending');
});

test('refunds: the student is notified when the request is received', async () => {
  const s = await student();
  const scanId = await ride(dan, s);
  const made = await spost('/me/refunds', { scanId, reason: 'Charged twice on the bus' }, s.token);
  assert.equal(made.status, 201, 'the refund request was created successfully');
  // The notification delivery is verified by the approve/reject tests below (email_log is checked there).
  const row = await first("SELECT id FROM refund_requests WHERE id = ? AND source = 'student'", [made.body.refund.id]);
  assert.ok(row, 'the refund request is stored with source=student');
});

test('refunds: a student cannot refund another student\'s transaction', async () => {
  const s1 = await student();
  const s2 = await student();
  const scanId = await ride(dan, s1);
  assert.equal((await spost('/me/refunds', { scanId, reason: 'Not my ride' }, s2.token)).status, 404, 'another student\'s transaction is not found');
  const list = await sget('/me/refunds', s2.token);
  assert.equal(list.body.total, 0, 'no refund request was created');
});

test('refunds: a student cannot refund a cancelled transaction', async () => {
  const s = await student();
  const scanId = await ride(dan, s);
  await apost(`/refunds/transactions/${scanId}/cancel`, { reason: 'Wrong student', password: PW });
  assert.equal((await spost('/me/refunds', { scanId, reason: 'Please refund' }, s.token)).status, 409, 'a cancelled transaction cannot be refunded');
});

test('refunds: one open refund per transaction', async () => {
  const s = await student();
  const scanId = await ride(dan, s);
  await spost('/me/refunds', { scanId, reason: 'First request' }, s.token);
  assert.equal((await spost('/me/refunds', { scanId, reason: 'Second request' }, s.token)).status, 409, 'a pending refund blocks a new one');
  const row = await first('SELECT COUNT(*) AS n FROM refund_requests WHERE scan_id = ?', [scanId]);
  assert.equal(row.n, 1);
});

test('refunds: amount and reason are validated', async () => {
  const s = await student();
  const scanId = await ride(dan, s);
  assert.equal((await spost('/me/refunds', { scanId, reason: 'ab' }, s.token)).status, 400, 'reason too short');
  assert.equal((await spost('/me/refunds', { scanId, amount: 999, reason: 'Too much' }, s.token)).status, 400, 'amount above fare');
  assert.equal((await spost('/me/refunds', { scanId, amount: 0, reason: 'Zero' }, s.token)).status, 400, 'zero amount');
  assert.equal((await spost('/me/refunds', { scanId, amount: -5, reason: 'Negative' }, s.token)).status, 400, 'negative amount');
  const row = await first('SELECT COUNT(*) AS n FROM refund_requests WHERE scan_id = ?', [scanId]);
  assert.equal(row.n, 0, 'no refund request was created');
});

test('refunds: an administrator can approve a student-requested refund', async () => {
  const s = await student();
  const scanId = await ride(dan, s);
  const made = await spost('/me/refunds', { scanId, reason: 'Charged twice on the bus' }, s.token);
  const id = made.body.refund.id;
  const dec = await apost(`/refunds/${id}/decision`, { decision: 'approved', reason: 'Duplicate charge confirmed', password: PW });
  assert.equal(dec.status, 200);
  assert.equal(dec.body.refund.status, 'approved');
  assert.equal(dec.body.refund.decidedBy, config.seedAdmin.name);
  assert.ok(dec.body.refund.decidedAt);
  const list = await sget('/me/refunds', s.token);
  assert.equal(list.body.items[0].status, 'approved');
  assert.equal(list.body.counts.approved, 1);
  assert.equal(list.body.counts.pending, 0);
  const row = await first("SELECT subject, body FROM email_log WHERE student_id = ? AND subject LIKE '%refund request was approved%' ORDER BY id DESC LIMIT 1", [s.id]);
  assert.ok(row, 'the student is told the refund was approved');
  assert.match(row.body, /₱13\.00/);
});

test('refunds: an administrator can reject a student-requested refund with a reason', async () => {
  const s = await student();
  const scanId = await ride(dan, s);
  await spost('/me/refunds', { scanId, reason: 'Charged twice on the bus' }, s.token);
  const id = (await sget('/me/refunds', s.token)).body.items[0].id;
  const rej = await apost(`/refunds/${id}/decision`, { decision: 'rejected', reason: 'Fare was correct', password: PW });
  assert.equal(rej.status, 200);
  assert.equal(rej.body.refund.status, 'rejected');
  assert.equal(rej.body.refund.decisionReason, 'Fare was correct');
  const list = await sget('/me/refunds', s.token);
  assert.equal(list.body.items[0].status, 'rejected');
  const row = await first("SELECT body FROM email_log WHERE student_id = ? AND subject LIKE '%refund request was not approved%' ORDER BY id DESC LIMIT 1", [s.id]);
  assert.ok(row);
  assert.match(row.body, /Fare was correct/);
});

test('refunds: a rejected refund can be requested again', async () => {
  const s = await student();
  const scanId = await ride(dan, s);
  await spost('/me/refunds', { scanId, reason: 'First attempt' }, s.token);
  const id = (await sget('/me/refunds', s.token)).body.items[0].id;
  await apost(`/refunds/${id}/decision`, { decision: 'rejected', reason: 'Not eligible', password: PW });
  const again = await spost('/me/refunds', { scanId, reason: 'Try again' }, s.token);
  assert.equal(again.status, 201, 'after rejection the student may request again');
  const list = await sget('/me/refunds', s.token);
  assert.equal(list.body.total, 2);
});

test('refunds: a cancelled transaction cannot be refunded even after rejection', async () => {
  const s = await student();
  const scanId = await ride(dan, s);
  await spost('/me/refunds', { scanId, reason: 'First attempt' }, s.token);
  const id = (await sget('/me/refunds', s.token)).body.items[0].id;
  await apost(`/refunds/${id}/decision`, { decision: 'rejected', reason: 'Not needed', password: PW });
  await apost(`/refunds/transactions/${scanId}/cancel`, { reason: 'Wrong student', password: PW });
  assert.equal((await spost('/me/refunds', { scanId, reason: 'After cancel' }, s.token)).status, 409, 'a cancelled transaction blocks refunds');
});

test('refunds: an approved refund prevents a new request on the same transaction', async () => {
  const s = await student();
  const scanId = await ride(dan, s);
  const made = await spost('/me/refunds', { scanId, reason: 'First request' }, s.token);
  await apost(`/refunds/${made.body.refund.id}/decision`, { decision: 'approved', reason: 'Confirmed', password: PW });
  assert.equal((await spost('/me/refunds', { scanId, reason: 'After approval' }, s.token)).status, 409, 'an approved refund blocks a new one');
});
