'use strict';
// Administrator login + dashboard: authentication, role protection, live statistics, charts, activities,
// transactions and logout. All numbers are checked against rows the test created itself.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { setup, reset, login, auth, studentPayload, scanId, config } = require('./helpers');

let ctx, admin;
before(async () => { ctx = await setup(); });
beforeEach(async () => { await reset(ctx.pool); admin = await login(ctx.api); });
after(async () => { await ctx.pool.end(); });

const D = '/api/admin/dashboard';
const get = (p, t = admin) => ctx.api.get(D + p).set(auth(t));
const driverBody = (o = {}) => ({ name: 'Pedro Driver', username: 'pedro', email: 'pedro@example.com', password: 'driver-pass-1', ...o });

/** A student the registrar approved, who has ridden once (a discounted transaction). */
async function rider() {
  const created = await ctx.api.post('/api/students').set(auth(admin)).send(studentPayload({ status: 'active' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const s = created.body.student;
  const scan = await scanId(ctx.api, admin, s.schoolId);
  assert.equal(scan.body.code, 'VERIFIED_STUDENT', JSON.stringify(scan.body));
  return s;
}

/* ------------------------------------------------------------------ login */

test('administrator login: correct credentials return a token and the administrator', async () => {
  const res = await ctx.api.post('/api/auth/login').send({ username: config.seedAdmin.username, password: config.seedAdmin.password, portal: 'admin' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.admin.role, 'admin');
  assert.equal(JSON.stringify(res.body).includes('password_hash'), false);
  assert.equal((await ctx.api.get('/api/auth/me').set(auth(res.body.token))).status, 200);
});

test('administrator login: the email address works too, and a wrong password or unknown user get the same message', async () => {
  const me = (await ctx.api.get('/api/auth/me').set(auth(admin))).body.admin;
  const byEmail = await ctx.api.post('/api/auth/login').send({ username: me.email, password: config.seedAdmin.password, portal: 'admin' });
  assert.equal(byEmail.status, 200);
  const wrong = await ctx.api.post('/api/auth/login').send({ username: me.username, password: 'wrong-password', portal: 'admin' });
  const ghost = await ctx.api.post('/api/auth/login').send({ username: 'nobody', password: 'wrong-password', portal: 'admin' });
  assert.equal(wrong.status, 401);
  assert.equal(ghost.status, 401);
  assert.equal(wrong.body.error, ghost.body.error);
});

test('administrator login: inactive and pending accounts are refused (even with the right password)', async () => {
  const d = (await ctx.api.post('/api/admin/drivers').set(auth(admin)).send(driverBody())).body.driver;
  await ctx.api.post(`/api/admin/drivers/${d.id}/actions/deactivate`).set(auth(admin));
  const off = await ctx.api.post('/api/auth/login').send({ username: 'pedro', password: 'driver-pass-1' });
  assert.equal(off.status, 403);
  assert.match(off.body.error, /deactivated/i);
  await ctx.pool.query("UPDATE admins SET status = 'pending' WHERE id = ?", [d.id]);
  const pend = await ctx.api.post('/api/auth/login').send({ username: 'pedro', password: 'driver-pass-1' });
  assert.equal(pend.status, 403);
  assert.match(pend.body.error, /approval/i);
  // an administrator account that is switched off
  await ctx.pool.query("UPDATE admins SET status = 'inactive' WHERE role = 'admin'");
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: config.seedAdmin.username, password: config.seedAdmin.password, portal: 'admin' })).status, 403);
});

test('administrator sign-in page: a driver account is refused there but still signs in the normal way', async () => {
  await ctx.api.post('/api/admin/drivers').set(auth(admin)).send(driverBody());
  const onAdmin = await ctx.api.post('/api/auth/login').send({ username: 'pedro', password: 'driver-pass-1', portal: 'admin' });
  assert.equal(onAdmin.status, 403);
  assert.match(onAdmin.body.error, /administrator accounts only/i);
  const normal = await ctx.api.post('/api/auth/login').send({ username: 'pedro', password: 'driver-pass-1' });
  assert.equal(normal.status, 200);
  assert.equal(normal.body.admin.role, 'driver');
});

test('login input is validated, and SQL in the username is just a wrong username', async () => {
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: '', password: 'x' })).status, 400);
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: 'admin', password: 'x', portal: 'root' })).status, 400);
  const sqli = await ctx.api.post('/api/auth/login').send({ username: "' OR '1'='1' -- ", password: "' OR '1'='1" });
  assert.equal(sqli.status, 401);
});

/* ------------------------------------------------------------------ protection */

test('dashboard routes need an administrator token: none, driver, student, tampered and expired tokens are all refused', async () => {
  const d = (await ctx.api.post('/api/admin/drivers').set(auth(admin)).send(driverBody())).body.driver;
  const driver = (await ctx.api.post('/api/auth/login').send({ username: 'pedro', password: 'driver-pass-1' })).body.token;
  const reg = await ctx.api.post('/api/student-portal/register').send({ ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1' });
  const student = (await ctx.api.post('/api/student-portal/login').send({ schoolId: reg.body.student.schoolId, password: 'secret-pass-1' })).body.token;
  const expired = jwt.sign({ sub: 1, role: 'admin', tv: 0 }, config.jwt.secret, { expiresIn: -10 });
  const forged = jwt.sign({ sub: 1, role: 'admin', tv: 0 }, 'not-the-real-secret');
  for (const p of ['/summary', '/charts', '/activities', '/transactions', '/transactions/1']) {
    assert.equal((await ctx.api.get(D + p)).status, 401, `${p} without a token`);
    assert.equal((await get(p, driver)).status, 403, `${p} with a driver token`);
    assert.equal((await get(p, student)).status, 401, `${p} with a student token`);
    assert.equal((await get(p, expired)).status, 401, `${p} with an expired token`);
    assert.equal((await get(p, forged)).status, 401, `${p} with a forged token`);
    assert.equal((await get(p)).status === 404 ? 404 : 200, p === '/transactions/1' ? 404 : 200, `${p} with the administrator's token`);
  }
  assert.ok(d.id);
});

test('an account switched off loses dashboard access immediately, even with a valid token', async () => {
  await ctx.pool.query("INSERT INTO admins (username, password_hash, name, email, role, status) SELECT 'second', password_hash, 'Second Admin', 'second@example.com', 'admin', 'active' FROM admins LIMIT 1");
  const second = await login(ctx.api, 'second', config.seedAdmin.password);
  assert.equal((await get('/summary', second)).status, 200);
  await ctx.pool.query("UPDATE admins SET status = 'inactive' WHERE username = 'second'");
  assert.equal((await get('/summary', second)).status, 401);
});

/* ------------------------------------------------------------------ statistics */

test('summary: an empty system shows zeros', async () => {
  const { stats, asOf } = (await get('/summary')).body;
  assert.deepEqual(stats, { totalStudents: 0, verifiedStudents: 0, pendingApplications: 0, activeQrCodes: 0, totalDrivers: 0, totalTransactions: 0, totalDiscounts: 0 });
  assert.ok(asOf);
});

test('summary: every card is counted from the database', async () => {
  await rider();
  const pending = await ctx.api.post('/api/student-portal/register').send({ ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1' });
  assert.equal(pending.status, 201);
  await ctx.api.post('/api/admin/drivers').set(auth(admin)).send(driverBody());
  await ctx.api.post('/api/admin/drivers').set(auth(admin)).send(driverBody({ username: 'ana', email: 'ana@example.com', name: 'Ana Driver' }));
  const body = (await get('/summary')).body;
  assert.equal(body.stats.totalStudents, 2);
  assert.equal(body.stats.verifiedStudents, 1);
  assert.equal(body.stats.pendingApplications, 1);
  assert.equal(body.stats.activeQrCodes, 1);
  assert.equal(body.stats.totalDrivers, 2);
  assert.equal(body.stats.totalTransactions, 1);
  assert.equal(body.stats.totalDiscounts, 3.25);
  assert.equal(body.notes.transactionsToday, 1);
  assert.equal(body.notes.discountsToday, 3.25);
  assert.equal(body.notes.newStudentsThisWeek, 2);
  // numbers change when the data changes
  await rider();
  assert.equal((await get('/summary')).body.stats.totalTransactions, 2);
});

test('summary: denied scans are not transactions, and a revoked or expired QR is not an active QR', async () => {
  const s = await rider();
  await ctx.api.post('/api/scanner/lookup').set(auth(admin)).send({ schoolId: 'NO-SUCH-ID' });          // denied
  assert.equal((await get('/summary')).body.stats.totalTransactions, 1);
  await ctx.pool.query("UPDATE qr_codes SET expires_at = ? WHERE student_id = ?", [new Date(Date.now() - 1000), s.id]);
  assert.equal((await get('/summary')).body.stats.activeQrCodes, 0);
});

/* ------------------------------------------------------------------ charts */

test('charts: daily, weekly and monthly series have the right shape and add up to the real transactions', async () => {
  await rider(); await rider();
  const c = (await get('/charts')).body;
  assert.equal(c.daily.items.length, 14);
  assert.equal(c.weekly.items.length, 8);
  assert.equal(c.monthly.items.length, 12);
  for (const k of ['daily', 'weekly', 'monthly']) {
    assert.equal(c[k].total, 2, `${k} total`);
    assert.equal(c[k].current, 2, `${k} current bucket`);
    assert.equal(c[k].items.at(-1).transactions, 2);
    assert.equal(c[k].items.at(-1).discount, 6.5);
    assert.equal(c[k].items.slice(0, -1).every((x) => x.transactions === 0), true);
  }
  assert.match(c.daily.items[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(c.monthly.items[0].month, /^\d{4}-\d{2}$/);
});

test('charts: older transactions land in the right day, week and month bucket', async () => {
  const s = await rider();
  const old = new Date(Date.now() - 20 * 86400000);
  await ctx.pool.query("INSERT INTO scans (student_id, student_name, school_id, route, operator, fare, fare_amount, discount_amount, result, scanned_at) VALUES (?, 'x', 'x', 'r', 'o', 'f', 13, 3.25, 'granted', ?)", [s.id, old]);
  const c = (await get('/charts')).body;
  assert.equal(c.daily.total, 1, 'a 20-day-old ride is outside the 14-day window');
  assert.equal(c.weekly.total, 2, 'but inside the 8-week window');
  assert.equal(c.monthly.total, 2);
  assert.equal(c.discounts.totalDiscount, 6.5);
});

test('charts: discount statistics', async () => {
  const s = await rider();
  await ctx.pool.query("INSERT INTO scans (student_id, student_name, school_id, route, operator, fare, fare_amount, discount_amount, result, scanned_at) VALUES (?, 'x', 'x', 'r', 'o', 'f', 16.25, 0, 'review', NOW())", [s.id]);
  const d = (await get('/charts')).body.discounts;
  assert.equal(d.totalDiscount, 3.25);
  assert.equal(d.totalRides, 2);
  assert.equal(d.discountedRides, 1);
  assert.equal(d.fullFareRides, 1);
  assert.equal(d.rideUtilization, 50);
  assert.equal(d.averageDiscount, 3.25);
  assert.equal(d.eligibleStudents, 1);
  assert.equal(d.studentsUsingDiscount, 1);
  assert.equal(d.studentUtilization, 100);
});

/* ------------------------------------------------------------------ activities */

test('activities: sign-ins, failed sign-ins and administrator actions are logged with who, when and status', async () => {
  await ctx.api.post('/api/auth/login').send({ username: config.seedAdmin.username, password: 'wrong-password' });
  const s = (await ctx.api.post('/api/students').set(auth(admin)).send(studentPayload())).body.student;
  await ctx.api.post(`/api/students/${s.id}/actions/approve`).set(auth(admin)).send({});
  await ctx.api.post('/api/admin/drivers').set(auth(admin)).send(driverBody());
  await ctx.api.post(`/api/students/${s.id}/actions/nonsense`).set(auth(admin)).send({});
  const { items } = (await get('/activities?limit=50')).body;
  const text = items.map((i) => `${i.status}|${i.description}`);
  assert.ok(items.every((i) => i.user && i.at && i.status && i.category), 'every item has a user, time, status and category');
  assert.ok(text.some((t) => t.startsWith('Failed|Failed sign-in attempt')));
  assert.ok(text.some((t) => t.startsWith('Success|Signed in')));
  assert.ok(text.some((t) => t.includes(`Registered student ${s.name}`)));
  assert.ok(text.some((t) => t.includes(`Approved student ${s.name} (${s.schoolId})`)));
  assert.ok(text.some((t) => t.includes('Registered driver Pedro Driver')));
  assert.ok(text.some((t) => t.startsWith('Failed|') && t.includes('nonsense')), 'a refused action is logged as failed');
  const at = items.map((i) => i.at);
  assert.deepEqual(at, [...at].sort().reverse(), 'newest first');
  const me = (await ctx.api.get('/api/auth/me').set(auth(admin))).body.admin;
  assert.equal(items.find((i) => i.description.startsWith('Approved student')).user, me.name);
});

test('activities: student registrations, student QR codes and transactions show up too, and paging works', async () => {
  const reg = await ctx.api.post('/api/student-portal/register').send({ ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1' });
  await rider();
  const all = (await get('/activities?limit=50')).body.items;
  const cats = new Set(all.map((i) => i.category));
  for (const c of ['registration', 'transaction', 'student', 'auth']) assert.ok(cats.has(c), `has ${c}`);
  const reg1 = all.find((i) => i.category === 'registration');
  assert.equal(reg1.status, 'Pending');
  assert.ok(reg1.description.includes(reg.body.student.name));
  assert.equal(all.filter((i) => i.category === 'registration').length, 1, 'registrations made by an administrator are not counted twice');
  const first = (await get('/activities?limit=3')).body;
  assert.equal(first.items.length, 3);
  assert.equal(first.hasMore, true);
  const next = (await get('/activities?limit=3&offset=3')).body;
  assert.notEqual(first.items[0].id, next.items[0].id);
  assert.equal((await get('/activities?limit=0')).status, 400);
});

test('activities: a driver account is logged signing in and out too, and the log is never exposed to non-admins', async () => {
  await ctx.api.post('/api/admin/drivers').set(auth(admin)).send(driverBody());
  const driver = (await ctx.api.post('/api/auth/login').send({ username: 'pedro', password: 'driver-pass-1' })).body.token;
  await ctx.api.post('/api/auth/logout').set(auth(driver));
  const items = (await get('/activities?limit=50')).body.items;
  assert.ok(items.some((i) => i.user === 'Pedro Driver' && i.description === 'Signed in'));
  assert.ok(items.some((i) => i.user === 'Pedro Driver' && i.description === 'Signed out'));
  assert.equal((await get('/activities', driver)).status, 403);
});

/* ------------------------------------------------------------------ transactions */

test('transactions: the table returns real rows with all the columns, newest first', async () => {
  const s = await rider();
  await ctx.pool.query("UPDATE scans SET driver_name = 'Pedro Driver'");
  const r = (await get('/transactions')).body;
  assert.equal(r.total, 1);
  const t = r.items[0];
  assert.match(t.reference, /^TXN-\d{8}$/);
  assert.equal(t.studentName, s.name);
  assert.equal(t.schoolId, s.schoolId);
  assert.equal(t.driver, 'Pedro Driver');
  assert.equal(t.regularFare, 16.25);
  assert.equal(t.discountAmount, 3.25);
  assert.equal(t.finalFare, 13);
  assert.equal(t.status, 'Completed');
  assert.ok(t.date && t.time && t.scannedAt);
});

test('transactions: search by name, school ID, driver and reference; pagination; no SQL injection through the search box', async () => {
  const a = await rider(); const b = await rider();
  await ctx.pool.query("UPDATE scans SET driver_name = 'Pedro Driver' WHERE student_id = ?", [a.id]);
  await ctx.pool.query("UPDATE scans SET driver_name = 'Ana Driver' WHERE student_id = ?", [b.id]);
  assert.equal((await get(`/transactions?q=${encodeURIComponent(a.name)}`)).body.total, 1);
  assert.equal((await get(`/transactions?q=${a.schoolId}`)).body.total, 1);
  assert.equal((await get('/transactions?q=Ana')).body.total, 1);
  const ref = (await get('/transactions')).body.items[0].reference;
  assert.equal((await get(`/transactions?q=${ref}`)).body.total, 1);
  assert.equal((await get('/transactions?q=zzzz-none')).body.total, 0);
  assert.equal((await get('/transactions?q=%25')).body.total, 0, 'a % in the search is not a wildcard');
  const inj = await get(`/transactions?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(inj.status, 200);
  assert.equal(inj.body.total, 0);
  const p1 = (await get('/transactions?limit=1')).body;
  const p2 = (await get('/transactions?limit=1&offset=1')).body;
  assert.equal(p1.total, 2);
  assert.equal(p1.items.length, 1);
  assert.notEqual(p1.items[0].id, p2.items[0].id);
  assert.equal((await get('/transactions?limit=500')).status, 400);
});

test('transactions: details, and a missing or malformed id is a clean 404', async () => {
  await rider();
  const { id } = (await get('/transactions')).body.items[0];
  const t = (await get(`/transactions/${id}`)).body.transaction;
  assert.equal(t.id, id);
  assert.equal(t.discountPercent, 20);
  assert.ok(t.route && t.operator && t.method);
  assert.equal((await get('/transactions/999999')).status, 404);
  assert.equal((await get('/transactions/abc')).status, 404);
  assert.equal((await get('/transactions/1;DROP TABLE scans')).status, 404);
});

/* ------------------------------------------------------------------ logout */

test('logout: the token stops working on the server, and the action is logged', async () => {
  const token = await login(ctx.api);
  assert.equal((await get('/summary', token)).status, 200);
  const out = await ctx.api.post('/api/auth/logout').set(auth(token));
  assert.equal(out.status, 200);
  assert.equal((await get('/summary', token)).status, 401, 'the old token is dead');
  assert.equal((await ctx.api.post('/api/auth/logout')).status, 401, 'logout needs a token');
  const fresh = await login(ctx.api);
  assert.ok((await get('/activities?limit=50', fresh)).body.items.some((i) => i.description === 'Signed out'));
});
