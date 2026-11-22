'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, config } = require('./helpers');
const ADMIN = config.seedAdmin;
const { ensureDriver } = require('../src/lib/ensureDriver');

let ctx;
before(async () => { ctx = await setup(); });
beforeEach(() => reset(ctx.pool));
after(() => ctx.pool.end());

test('login succeeds with seeded credentials and returns a token without the password hash', async () => {
  const res = await ctx.api.post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.admin.username, ADMIN.username);
  assert.equal(JSON.stringify(res.body).includes('password'), false);
});

test('login rejects a wrong password and an unknown user with the same message', async () => {
  const a = await ctx.api.post('/api/auth/login').send({ username: ADMIN.username, password: 'nope-nope' });
  const b = await ctx.api.post('/api/auth/login').send({ username: 'ghost', password: 'whatever1' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
});

test('login validates input', async () => {
  const res = await ctx.api.post('/api/auth/login').send({ username: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('protected routes require a valid bearer token', async () => {
  const token = await login(ctx.api);
  assert.equal((await ctx.api.get('/api/students')).status, 401);
  assert.equal((await ctx.api.get('/api/students').set(auth('garbage'))).status, 401);
  assert.equal((await ctx.api.get('/api/auth/me').set(auth(token))).status, 200);
});

test('health endpoint is public', async () => {
  const res = await ctx.api.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('profile update changes name/email/username and enforces unique usernames', async () => {
  const token = await login(ctx.api);
  const res = await ctx.api.patch('/api/admin/account').set(auth(token)).send({ name: 'New Name', username: 'new.user' });
  assert.equal(res.status, 200);
  assert.equal(res.body.admin.username, 'new.user');
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: 'new.user', password: ADMIN.password })).status, 200);
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password })).status, 401);

  await ctx.pool.query("INSERT INTO admins (username, password_hash, name, email) VALUES ('other', 'x', 'Other', 'o@x.ph')");
  const dup = await ctx.api.patch('/api/admin/account').set(auth(token)).send({ username: 'other' });
  assert.equal(dup.status, 409);
});

test('password change checks the current password, enforces length/match, and revokes old tokens', async () => {
  const oldToken = await login(ctx.api);
  const bad = await ctx.api.post('/api/admin/account/password').set(auth(oldToken)).send({ current: 'wrong-pass', new: 'brand-new-pass', confirm: 'brand-new-pass' });
  assert.equal(bad.status, 400);
  const short = await ctx.api.post('/api/admin/account/password').set(auth(oldToken)).send({ current: ADMIN.password, new: 'short', confirm: 'short' });
  assert.equal(short.status, 400);
  const mismatch = await ctx.api.post('/api/admin/account/password').set(auth(oldToken)).send({ current: ADMIN.password, new: 'brand-new-pass', confirm: 'different-pass' });
  assert.equal(mismatch.status, 400);

  const ok = await ctx.api.post('/api/admin/account/password').set(auth(oldToken)).send({ current: ADMIN.password, new: 'brand-new-pass', confirm: 'brand-new-pass' });
  assert.equal(ok.status, 200);
  assert.equal((await ctx.api.get('/api/auth/me').set(auth(oldToken))).status, 401, 'old token must be revoked');
  assert.equal((await ctx.api.get('/api/auth/me').set(auth(ok.body.token))).status, 200, 'returned token must work');
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: ADMIN.username, password: 'brand-new-pass' })).status, 200);
});

test('ensureDriver creates the first administrator when there are no accounts, and only then', async () => {
  await ctx.pool.query('DELETE FROM admins');
  assert.equal(await ensureDriver(ctx.pool), true);
  const ok = await ctx.api.post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password });
  assert.equal(ok.status, 200);

  // Rename the account: it must NOT come back as a second default "driver" account on the next start.
  await ctx.pool.query("UPDATE admins SET username = 'boss'");
  assert.equal(await ensureDriver(ctx.pool), false);
  const [[{ n }]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM admins');
  assert.equal(n, 1);
});
