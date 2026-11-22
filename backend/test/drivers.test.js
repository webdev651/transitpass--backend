'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload } = require('./helpers');

let ctx; let admin;
before(async () => { ctx = await setup(); });
beforeEach(async () => { await reset(ctx.pool); admin = await login(ctx.api); });
after(() => ctx.pool.end());

const driverBody = (o = {}) => ({ name: 'Dan Driver', username: 'dan.driver', email: 'dan@example.com', unit: 'Bus 7', password: 'driver-pass-1', ...o });
const mkDriver = async (o) => (await ctx.api.post('/api/admin/drivers').set(auth(admin)).send(driverBody(o)));
const driverToken = async (u = 'dan.driver', p = 'driver-pass-1') => (await ctx.api.post('/api/auth/login').send({ username: u, password: p })).body.token;

test('admin registers a driver; the password is stored as a bcrypt hash and never returned', async () => {
  const res = await mkDriver();
  assert.equal(res.status, 201);
  assert.equal(res.body.driver.role, 'driver');
  assert.equal(res.body.driver.status, 'active');
  assert.equal(JSON.stringify(res.body).includes('driver-pass-1'), false);
  const [[row]] = await ctx.pool.query("SELECT password_hash FROM admins WHERE username = 'dan.driver'");
  assert.match(row.password_hash, /^\$2[aby]\$/);
});

test('driver signs in with username or email, gets a separate session, and can read only their own dashboard', async () => {
  await mkDriver();
  const byEmail = await ctx.api.post('/api/auth/login').send({ username: 'dan@example.com', password: 'driver-pass-1' });
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.body.admin.role, 'driver');
  const t = await driverToken();
  const me = await ctx.api.get('/api/driver/me').set(auth(t));
  assert.equal(me.status, 200);
  assert.equal(me.body.driver.username, 'dan.driver');
  assert.deepEqual(me.body.stats.allTime, { total: 0, verified: 0, rejected: 0, review: 0 });
});

test('role separation: drivers cannot reach admin routes, admins cannot reach driver routes, students reach neither', async () => {
  await mkDriver();
  const t = await driverToken();
  for (const p of ['/api/students', '/api/admin/drivers', '/api/admin/verifications', '/api/admin/qr-codes', '/api/scans', '/api/dashboard']) {
    assert.equal((await ctx.api.get(p).set(auth(t))).status, 403, p);
  }
  assert.equal((await ctx.api.get('/api/driver/me').set(auth(admin))).status, 403);

  await ctx.api.post('/api/student-portal/register').send({ ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1' });
  const [[s]] = await ctx.pool.query('SELECT school_id FROM students LIMIT 1');
  const st = (await ctx.api.post('/api/student-portal/login').send({ schoolId: s.school_id, password: 'secret-pass-1' })).body.token;
  for (const p of ['/api/driver/me', '/api/admin/drivers', '/api/students']) assert.equal((await ctx.api.get(p).set(auth(st))).status, 401, p);
  assert.equal((await ctx.api.post('/api/scanner/lookup').set(auth(st)).send({ schoolId: 'x' })).status, 401);
  assert.equal((await ctx.api.get('/api/driver/me')).status, 401);
});

test('deactivating a driver blocks login and kills the existing session; reactivating restores it', async () => {
  const d = (await mkDriver()).body.driver;
  const t = await driverToken();
  assert.equal((await ctx.api.post(`/api/admin/drivers/${d.id}/actions/deactivate`).set(auth(admin))).body.driver.status, 'inactive');
  assert.equal((await ctx.api.get('/api/driver/me').set(auth(t))).status, 401);
  const blocked = await ctx.api.post('/api/auth/login').send({ username: 'dan.driver', password: 'driver-pass-1' });
  assert.equal(blocked.status, 403);
  assert.equal((await ctx.api.post(`/api/admin/drivers/${d.id}/actions/deactivate`).set(auth(admin))).status, 409);
  await ctx.api.post(`/api/admin/drivers/${d.id}/actions/activate`).set(auth(admin));
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: 'dan.driver', password: 'driver-pass-1' })).status, 200);
});

test('a pending driver cannot sign in until an admin approves; the wrong password still says "incorrect"', async () => {
  const d = (await mkDriver({ status: 'pending' })).body.driver;
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: 'dan.driver', password: 'nope-nope-1' })).status, 401);
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: 'dan.driver', password: 'driver-pass-1' })).status, 403);
  await ctx.api.post(`/api/admin/drivers/${d.id}/actions/approve`).set(auth(admin));
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: 'dan.driver', password: 'driver-pass-1' })).status, 200);
});

test('driver validation: duplicate username/email, weak password, bad input', async () => {
  await mkDriver();
  assert.equal((await mkDriver({ email: 'other@example.com' })).status, 409);
  assert.equal((await mkDriver({ username: 'other.driver' })).status, 409);
  assert.equal((await mkDriver({ username: 'x1', email: 'x1@example.com', password: 'short' })).status, 400);
  assert.equal((await mkDriver({ username: 'bad name!', email: 'x2@example.com' })).status, 400);
});

test('admin resets a driver password: old password stops working and old sessions end', async () => {
  const d = (await mkDriver()).body.driver;
  const t = await driverToken();
  assert.equal((await ctx.api.post(`/api/admin/drivers/${d.id}/password`).set(auth(admin)).send({ password: 'fresh-pass-99' })).status, 200);
  assert.equal((await ctx.api.get('/api/driver/me').set(auth(t))).status, 401);
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: 'dan.driver', password: 'driver-pass-1' })).status, 401);
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: 'dan.driver', password: 'fresh-pass-99' })).status, 200);
});

test('a driver can change their own profile and password through the account routes, not another driver\'s', async () => {
  await mkDriver();
  await mkDriver({ name: 'Eve', username: 'eve', email: 'eve@example.com' });
  const t = await driverToken();
  const up = await ctx.api.patch('/api/admin/account').set(auth(t)).send({ name: 'Daniel D.' });
  assert.equal(up.body.admin.name, 'Daniel D.');
  assert.equal(up.body.admin.role, 'driver');
  const pw = await ctx.api.post('/api/admin/account/password').set(auth(t)).send({ current: 'driver-pass-1', new: 'New-Driver-Pass-1!', confirm: 'New-Driver-Pass-1!' });
  assert.equal(pw.status, 200);
  const [[eve]] = await ctx.pool.query("SELECT name FROM admins WHERE username = 'eve'");
  assert.equal(eve.name, 'Eve');
});
