'use strict';
// Stage 4: administrator profile, password change, and the single-administrator rule. Integration tests against the real database.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { execFileSync } = require('node:child_process');
const { setup, reset, login, auth, config } = require('./helpers');
const { ensureDriver } = require('../src/lib/ensureDriver');

let ctx, admin;
const PW = config.seedAdmin.password;
const A = '/api/admin';
const sql = async (q, a) => (await ctx.pool.query(q, a))[0];
const logs = (action) => sql('SELECT * FROM activity_logs WHERE action = ? ORDER BY id', [action]);

before(async () => { ctx = await setup(); });
beforeEach(async () => { await reset(ctx.pool); admin = await login(ctx.api); });
after(() => ctx.pool.end());

test('the profile shows status, last login, the single-administrator rule and warns while the default password is in use', async () => {
  const r = await ctx.api.get(A + '/account').set(auth(admin));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.admin.role, 'admin'); assert.equal(r.body.admin.status, 'active');
  assert.ok(r.body.admin.lastLoginAt, 'last login is stamped at sign-in');
  assert.equal(r.body.administratorCount, 1);
  assert.equal(r.body.defaultPassword, true, 'the seeded password is still the one from the setup instructions');
  assert.ok(!JSON.stringify(r.body).includes('$2'), 'no password hash is ever returned');
});

test('previous login and failed sign-ins since then are reported', async () => {
  await ctx.api.post('/api/auth/login').send({ username: config.seedAdmin.username, password: 'wrong-wrong-1' });
  const second = await login(ctx.api);
  const r = await ctx.api.get(A + '/account').set(auth(second));
  assert.ok(r.body.previousLoginAt, 'the sign-in before this one');
  assert.equal(r.body.failedSignInsSinceLast, 1);
});

test('editing the profile saves it, reports what changed and records it in the existing activity log without values or secrets', async () => {
  const r = await ctx.api.patch(A + '/account').set(auth(admin)).send({ name: 'Chief Admin', phone: '+63 912 345 6789' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changed.sort(), ['name', 'phone']);
  assert.equal(r.body.admin.name, 'Chief Admin');
  const l = await logs('account.update');
  assert.equal(l.length, 1); assert.equal(l[0].status, 'success'); assert.equal(l[0].category, 'account');
  assert.match(l[0].description, /name, phone/); assert.ok(!l[0].description.includes('Chief Admin'));
  const again = await ctx.api.patch(A + '/account').set(auth(admin)).send({ name: 'Chief Admin' });
  assert.deepEqual(again.body.changed, [], 'saving unchanged values changes nothing');
});

test('profile validation: bad phone, bad email, taken username are refused and nothing is half-saved', async () => {
  assert.equal((await ctx.api.patch(A + '/account').set(auth(admin)).send({ phone: 'call me' })).status, 400);
  assert.equal((await ctx.api.patch(A + '/account').set(auth(admin)).send({ email: 'not-an-email' })).status, 400);
  await ctx.api.post(A + '/drivers').set(auth(admin)).send({ name: 'Dan', username: 'dandriver', email: 'dan@example.com', password: 'driver-pass-1' });
  const dup = await ctx.api.patch(A + '/account').set(auth(admin)).send({ username: 'dandriver', name: 'Should Not Save' });
  assert.equal(dup.status, 409, JSON.stringify(dup.body));
  assert.notEqual((await ctx.api.get(A + '/account').set(auth(admin))).body.admin.name, 'Should Not Save');
});

test('changing the password needs the current password, applies the policy, stores a bcrypt hash and signs other sessions out', async () => {
  const other = await login(ctx.api);                                            // a second session
  const bad = await ctx.api.post(A + '/account/password').set(auth(admin)).send({ current: 'wrong-wrong-1', new: 'a-better-pass-9', confirm: 'a-better-pass-9' });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /current password/i);
  const failed = await logs('account.password');
  assert.equal(failed.length, 1); assert.equal(failed[0].status, 'failed'); assert.match(failed[0].description, /refused/i);

  for (const [next, re] of [[PW, /different/i], ['admin1234', /username|common|different/i], [`my-${config.seedAdmin.username}-pass`, /username/i], ['password123', /common/i], ['aaaaaaaaaa', /repeated/i]]) {
    const r = await ctx.api.post(A + '/account/password').set(auth(admin)).send({ current: PW, new: next, confirm: next });
    assert.equal(r.status, 400, `${next}: ${JSON.stringify(r.body)}`); assert.match(r.body.error, re);
  }
  assert.equal((await ctx.api.post(A + '/account/password').set(auth(admin)).send({ current: PW, new: 'a-better-pass-9', confirm: 'different-pass-9' })).status, 400, 'confirmation must match');

  const ok = await ctx.api.post(A + '/account/password').set(auth(admin)).send({ current: PW, new: 'a-better-pass-9', confirm: 'a-better-pass-9' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [row] = await sql("SELECT password_hash FROM admins WHERE role = 'admin'");
  assert.match(row.password_hash, /^\$2[aby]\$/); assert.ok(await bcrypt.compare('a-better-pass-9', row.password_hash));
  assert.equal((await ctx.api.get(A + '/account').set(auth(ok.body.token))).status, 200, 'this session continues with the new token');
  assert.equal((await ctx.api.get(A + '/account').set(auth(other))).status, 401, 'other sessions are signed out');
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: config.seedAdmin.username, password: PW })).status, 401, 'the old password no longer works');
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: config.seedAdmin.username, password: 'a-better-pass-9' })).status, 200);
  const okLog = (await logs('account.password')).find((x) => x.status === 'success');
  assert.ok(okLog); assert.ok(!JSON.stringify(await sql('SELECT * FROM activity_logs')).includes('a-better-pass-9'), 'no password ever reaches the log');
  assert.equal((await ctx.api.get(A + '/account').set(auth(ok.body.token))).body.defaultPassword, false);
});

test('wrong current-password guesses are rate limited', async () => {
  process.env.TEST_RATE_LIMIT = '1';
  try {
    let last;
    for (let i = 0; i < 6; i++) last = await ctx.api.post(A + '/account/password').set(auth(admin)).send({ current: 'wrong-wrong-' + i, new: 'a-better-pass-9', confirm: 'a-better-pass-9' });
    assert.equal(last.status, 429);
  } finally { delete process.env.TEST_RATE_LIMIT; }
});

test('there can only be one administrator: no way to add one, drivers cannot be created as administrators, startup never adds another', async () => {
  const made = await ctx.api.post(A + '/drivers').set(auth(admin)).send({ name: 'Sneaky', username: 'sneaky', email: 's@example.com', password: 'driver-pass-1', role: 'admin' });
  assert.equal(made.status, 201);
  assert.equal((await sql("SELECT role FROM admins WHERE username = 'sneaky'"))[0].role, 'driver', 'a role in the request body is ignored');
  for (const [m, p] of [['post', '/admins'], ['post', '/account/admins'], ['post', '/users']]) assert.equal((await ctx.api[m](A + p).set(auth(admin)).send({ name: 'X', username: 'x2', email: 'x2@example.com', password: 'driver-pass-1' })).status, 404);
  assert.equal(await ensureDriver(ctx.pool), false, 'an administrator exists: nothing is created');
  assert.equal((await sql("SELECT COUNT(*) AS n FROM admins WHERE role = 'admin'"))[0].n, 1);
  // recovery: a database that lost its administrator (only drivers left) gets exactly one back
  await sql("DELETE FROM admins WHERE role = 'admin'");
  assert.equal(await ensureDriver(ctx.pool), true);
  assert.equal((await sql("SELECT COUNT(*) AS n FROM admins WHERE role = 'admin'"))[0].n, 1);
});

test('the only administrator cannot be deleted or deactivated and the attempts are recorded', async () => {
  const del = await ctx.api.delete(A + '/account').set(auth(admin));
  assert.equal(del.status, 409); assert.match(del.body.error, /cannot be deleted/i);
  const off = await ctx.api.post(A + '/account/deactivate').set(auth(admin)).send({});
  assert.equal(off.status, 409); assert.match(off.body.error, /cannot be deactivated/i);
  assert.equal((await sql("SELECT status FROM admins WHERE role = 'admin'"))[0].status, 'active');
  assert.equal((await ctx.api.get(A + '/account').set(auth(admin))).status, 200, 'still signed in and active');
  assert.equal((await logs('account.delete_refused'))[0].status, 'failed');
  assert.equal((await logs('account.deactivate_refused'))[0].status, 'failed');
});

test('driver routes can never reach the administrator account, and a driver cannot use the administrator-only routes', async () => {
  const adminId = (await sql("SELECT id FROM admins WHERE role = 'admin'"))[0].id;
  await ctx.api.post(A + '/drivers').set(auth(admin)).send({ name: 'Dan', username: 'dan', email: 'dan@example.com', password: 'driver-pass-1' });
  const dan = (await ctx.api.post('/api/auth/login').send({ username: 'dan', password: 'driver-pass-1' })).body.token;
  for (const [m, p, b] of [['patch', `/drivers/${adminId}`, { name: 'Hijack' }], ['post', `/drivers/${adminId}/actions/deactivate`, { password: PW }], ['post', `/drivers/${adminId}/password`, { password: 'new-pass-12345' }], ['delete', `/drivers/${adminId}`, {}]]) {
    const r = await ctx.api[m](A + p).set(auth(admin)).send(b);
    assert.ok([404, 405].includes(r.status) || r.status === 400, `${m} ${p} -> ${r.status}`);
  }
  assert.equal((await sql('SELECT name, status FROM admins WHERE id = ?', [adminId]))[0].status, 'active');
  for (const [m, p] of [['get', '/activity-logs'], ['get', '/reports/overview'], ['delete', '/account'], ['post', '/account/deactivate']]) assert.equal((await ctx.api[m](A + p).set(auth(dan))).status, 403, `${m} ${p}`);
});

test('npm run reset-admin recovers the single administrator (and refuses unknown accounts)', async () => {
  const env = { ...process.env, DB_NAME: config.db.database, DB_USER: config.db.user, DB_PASSWORD: config.db.password, DB_HOST: config.db.host, DB_PORT: String(config.db.port), NODE_ENV: 'test' };
  const out = execFileSync('node', ['scripts/reset-admin.js', config.seedAdmin.username, 'recovered-pass-77'], { env, encoding: 'utf8' });
  assert.match(out, /Password reset/);
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: config.seedAdmin.username, password: 'recovered-pass-77' })).status, 200);
  assert.equal((await ctx.api.get(A + '/account').set(auth(admin))).status, 401, 'old sessions are signed out');
  assert.throws(() => execFileSync('node', ['scripts/reset-admin.js', 'nobody', 'recovered-pass-77'], { env, encoding: 'utf8', stdio: 'pipe' }));
});
