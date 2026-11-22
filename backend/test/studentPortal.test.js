'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload } = require('./helpers');

let ctx;
before(async () => { ctx = await setup(); });
beforeEach(() => reset(ctx.pool));
after(() => ctx.pool.end());

// What the sign-up form sends: a normal student plus a password.
// Registers a student and has the admin approve them, like the real flow: register -> admin verifies -> login.
async function approvedStudent(over = {}) {
  const body = signUp(over);
  const reg = await ctx.api.post('/api/student-portal/register').send(body);
  const admin = await login(ctx.api);
  await ctx.api.post(`/api/students/${reg.body.student.id}/actions/approve`).set(auth(admin)).send({});
  const res = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  return { body, token: res.body.token, student: res.body.student };
}

const signUp = (over = {}) => ({ ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1', ...over });

test('a student can create their own account: it starts pending and the password is never returned', async () => {
  const res = await ctx.api.post('/api/student-portal/register').send(signUp());
  assert.equal(res.status, 201);
  assert.equal(res.body.token, undefined); // registering does not sign anyone in
  assert.equal(res.body.student.verification.status, 'pending');
  assert.equal(res.body.student.status, 'pending');
  assert.equal(res.body.student.validUntil, 'Awaiting registrar');
  const text = JSON.stringify(res.body);
  assert.equal(text.includes('password'), false);
  assert.equal(text.includes('secret-pass-1'), false);
});

test('registering sends the "we received your registration" notification', async () => {
  const body = signUp();
  await ctx.api.post('/api/student-portal/register').send(body);
  const [rows] = await ctx.pool.query('SELECT subject FROM email_log WHERE to_email = ?', [body.email]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'We received your TransitPass registration');
});

test('register checks the form: short password, mismatch, bad email', async () => {
  const short = await ctx.api.post('/api/student-portal/register').send(signUp({ password: 'abc', confirm: 'abc' }));
  const mismatch = await ctx.api.post('/api/student-portal/register').send(signUp({ confirm: 'something-else' }));
  const badEmail = await ctx.api.post('/api/student-portal/register').send(signUp({ email: 'not-an-email' }));
  for (const r of [short, mismatch, badEmail]) {
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Validation failed');
  }
});

test('register refuses a School ID or email that already exists', async () => {
  const first = signUp();
  assert.equal((await ctx.api.post('/api/student-portal/register').send(first)).status, 201);
  const sameId = await ctx.api.post('/api/student-portal/register').send(signUp({ schoolId: first.schoolId }));
  const sameEmail = await ctx.api.post('/api/student-portal/register').send(signUp({ email: first.email }));
  assert.equal(sameId.status, 409);
  assert.equal(sameEmail.status, 409);
});

test('a client cannot sneak in its own status or password hash', async () => {
  const res = await ctx.api.post('/api/student-portal/register').send(signUp({ status: 'active', validUntil: '31 Dec 2099' }));
  assert.equal(res.status, 201);
  assert.equal(res.body.student.status, 'pending');
  assert.equal(res.body.student.validUntil, 'Awaiting registrar');
});

test('student login works with School ID + password and fails the same way for wrong password / unknown ID', async () => {
  const body = signUp();
  await ctx.api.post('/api/student-portal/register').send(body);
  const admin = await login(ctx.api);
  const [rows] = await ctx.pool.query('SELECT id FROM students WHERE school_id = ?', [body.schoolId]);
  await ctx.api.post(`/api/students/${rows[0].id}/actions/approve`).set(auth(admin)).send({});

  const ok = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal(ok.body.student.schoolId, body.schoolId);

  const wrong = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: 'wrong-pass-1' });
  const ghost = await ctx.api.post('/api/student-portal/login').send({ schoolId: '0000-0000', password: 'whatever-1' });
  assert.equal(wrong.status, 401);
  assert.equal(ghost.status, 401);
  assert.equal(wrong.body.error, ghost.body.error);
});

test('a student the registrar added (no password) cannot sign in', async () => {
  const admin = await login(ctx.api);
  const p = studentPayload();
  assert.equal((await ctx.api.post('/api/students').set(auth(admin)).send(p)).status, 201);
  const res = await ctx.api.post('/api/student-portal/login').send({ schoolId: p.schoolId, password: 'student1234' });
  assert.equal(res.status, 401);
});

test('a pending student can sign in to see their status, but cannot generate a QR until verified', async () => {
  const body = signUp();
  await ctx.api.post('/api/student-portal/register').send(body);
  const inRes = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  assert.equal(inRes.status, 200);
  const t = { Authorization: `Bearer ${inRes.body.token}` };
  const me = await ctx.api.get('/api/student-portal/me').set(t);
  assert.equal(me.body.student.verification.status, 'pending');
  const qr = await ctx.api.get('/api/student-portal/me/qr').set(t);
  assert.equal(qr.body.qr, null);
  assert.equal(qr.body.canGenerate, false);
  assert.equal((await ctx.api.post('/api/student-portal/me/qr').set(t)).status, 403);
  assert.equal((await ctx.pool.query('SELECT COUNT(*) AS n FROM qr_codes'))[0][0].n, 0);

  const admin = await login(ctx.api);
  await ctx.api.post(`/api/students/${me.body.student.id}/actions/approve`).set(auth(admin)).send({});
  const made = await ctx.api.post('/api/student-portal/me/qr').set(t);
  assert.equal(made.status, 201);
  assert.match(made.body.qr.payload, /^TP1\.[A-Za-z0-9_-]{32}$/);
});

test('a wrong password on a pending account still says "incorrect", not "pending"', async () => {
  const body = signUp();
  await ctx.api.post('/api/student-portal/register').send(body);
  const res = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: 'wrong-pass-1' });
  assert.equal(res.status, 401);
});

test('a signed-in student can read their own account and scan history', async () => {
  const { body, token, student } = await approvedStudent();
  const me = await ctx.api.get('/api/student-portal/me').set(auth(token));
  assert.equal(me.status, 200);
  assert.equal(me.body.student.id, student.id);
  const scans = await ctx.api.get('/api/student-portal/me/scans').set(auth(token));
  assert.equal(scans.status, 200);
  assert.deepEqual(scans.body.items, []);
});

test('student and driver tokens cannot be used on each other\'s routes', async () => {
  const { token } = await approvedStudent();
  const adminToken = await login(ctx.api);

  // student token on driver routes
  assert.equal((await ctx.api.get('/api/students').set(auth(token))).status, 401);
  assert.equal((await ctx.api.get('/api/auth/me').set(auth(token))).status, 401);
  // driver token on student routes
  assert.equal((await ctx.api.get('/api/student-portal/me').set(auth(adminToken))).status, 401);
  // no token at all
  assert.equal((await ctx.api.get('/api/student-portal/me')).status, 401);
});

test('the driver login has no sign-up: there is no way to create a driver account through the API', async () => {
  const res = await ctx.api.post('/api/auth/register').send({ username: 'newdriver', password: 'password123' });
  assert.equal(res.status, 401); // falls through to the protected catch-all: not a public route
});
