'use strict';
// Stage 2: fare and discount management. The scanners must price rides from the active fare_rules row, not from .env.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload, config } = require('./helpers');
const { todayYmd } = require('../src/lib/dates');

let ctx; let admin; let dan; let eve; let danId;
const PW = config.seedAdmin.password;
before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await reset(ctx.pool);
  admin = await login(ctx.api);
  for (const [u, n] of [['dan', 'Dan Driver'], ['eve', 'Eve Driver']]) {
    const r = await ctx.api.post('/api/admin/drivers').set(auth(admin)).send({ name: n, username: u, email: `${u}@example.com`, password: 'driver-pass-1', unit: `Bus ${u}` });
    if (u === 'dan') danId = r.body.driver.id;
  }
  dan = (await ctx.api.post('/api/auth/login').send({ username: 'dan', password: 'driver-pass-1' })).body.token;
  eve = (await ctx.api.post('/api/auth/login').send({ username: 'eve', password: 'driver-pass-1' })).body.token;
});
after(() => ctx.pool.end());

const day = (n = 0) => todayYmd(n);
const fpost = (body) => ctx.api.post('/api/admin/fares').set(auth(admin)).send({ password: PW, ...body });
const rule = (over = {}) => ({ regularFare: 20, discountPercent: 25, effectiveFrom: day(-1), ...over });
async function newRoute(name = 'Campus - Downtown') {
  const r = await ctx.api.post('/api/admin/routes').set(auth(admin)).send({ name, origin: 'Campus', destination: `Town ${name}` });
  return r.body.route;
}
async function verifiedStudent() {
  const body = { ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1' };
  const reg = await ctx.api.post('/api/student-portal/register').send(body);
  const lg = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  const st = auth(lg.body.token);
  await ctx.api.post(`/api/admin/verifications/${reg.body.student.id}/approve`).set(auth(admin)).send({});
  await ctx.api.post('/api/student-portal/me/qr').set(st);
  return { id: reg.body.student.id, schoolId: body.schoolId, st };
}
const lookup = (token, schoolId) => ctx.api.post('/api/scanner/lookup').set(auth(token)).send({ schoolId });

test('with no database rule the scanner still works (falls back to the original .env values)', async () => {
  const s = await verifiedStudent();
  const r = await lookup(dan, s.schoolId);
  assert.equal(r.status, 200);
  assert.equal(r.body.fare, '₱13.00 (−20%)');
  const sum = await ctx.api.get('/api/admin/fares/summary').set(auth(admin));
  assert.equal(sum.body.usingFallback, true);
});

test('an administrator-set default fare and discount is what the driver scanner charges (not .env)', async () => {
  const c = await fpost(rule());
  assert.equal(c.status, 201);
  assert.equal(c.body.fare.state, 'current');
  assert.equal(c.body.fare.discountState, 'active');
  const s = await verifiedStudent();
  const r = await lookup(dan, s.schoolId);
  assert.equal(r.body.fare, '₱15.00 (−25%)');
  assert.equal(r.body.discountStatus, 'Eligible — 25% discount');
  const [[row]] = await ctx.pool.query('SELECT fare_amount, discount_amount, fare_rule_id FROM scans ORDER BY id DESC LIMIT 1');
  assert.equal(row.fare_amount, 15); assert.equal(row.discount_amount, 5); assert.equal(row.fare_rule_id, c.body.fare.id);
  const dash = await ctx.api.get('/api/student-portal/me/dashboard').set(s.st);
  assert.equal(JSON.stringify(dash.body).includes('25'), true);       // the student sees the percentage from the active rule
});

test('a route can have its own fare: drivers on that route are charged it, drivers without a route use the default', async () => {
  await fpost(rule());                                                          // default 20 / 25%
  const route = await newRoute();
  const rf = await fpost(rule({ routeId: route.id, regularFare: 30, discountPercent: 10 }));
  assert.equal(rf.status, 201); assert.equal(rf.body.fare.routeName, route.name);
  assert.equal((await ctx.api.post(`/api/admin/routes/${route.id}/drivers`).set(auth(admin)).send({ driverId: danId })).status, 200);
  const s = await verifiedStudent();
  assert.equal((await lookup(dan, s.schoolId)).body.fare, '₱27.00 (−10%)');   // dan: assigned to the route
  assert.equal((await lookup(eve, s.schoolId)).body.fare, '₱15.00 (−25%)');   // eve: no route -> default
  const [rows] = await ctx.pool.query('SELECT route_id, fare_rule_id FROM scans ORDER BY id');
  assert.equal(rows[0].route_id, route.id); assert.equal(rows[0].fare_rule_id, rf.body.fare.id); assert.equal(rows[1].route_id, null);
  const calc = await ctx.api.get(`/api/admin/fares/calculate?routeId=${route.id}`).set(auth(admin));
  assert.deepEqual([calc.body.regularFare, calc.body.discountPercent, calc.body.discountedFare, calc.body.discountAmount], [30, 10, 27, 3]);
});

test('effective and expiration dates: upcoming and expired rules are never used', async () => {
  await fpost(rule({ regularFare: 18, discountPercent: 20, effectiveFrom: day(-30), effectiveUntil: day(-5) }));   // expired
  const next = await fpost(rule({ regularFare: 40, discountPercent: 50, effectiveFrom: day(5) }));               // upcoming
  assert.equal(next.body.fare.state, 'upcoming');
  const s = await verifiedStudent();
  assert.equal((await lookup(dan, s.schoolId)).body.fare, '₱13.00 (−20%)');      // neither applies -> .env fallback
  const cur = await fpost(rule({ regularFare: 20, discountPercent: 25, effectiveFrom: day(-4), effectiveUntil: day(4) }));
  assert.equal(cur.status, 201);
  assert.equal((await lookup(dan, s.schoolId)).body.fare, '₱15.00 (−25%)');
  const past = await ctx.api.get(`/api/admin/fares/calculate?date=${day(6)}`).set(auth(admin));
  assert.equal(past.body.regularFare, 40);                                          // the preview can look at a future day
});

test('the discount can be switched off, scheduled, or ended without touching the regular fare', async () => {
  const f = (await fpost(rule())).body.fare;
  const s = await verifiedStudent();
  const off = await ctx.api.post(`/api/admin/fares/${f.id}/discount`).set(auth(admin)).send({ active: false, password: PW });
  assert.equal(off.body.fare.discountState, 'off');
  const r1 = await lookup(dan, s.schoolId);
  assert.equal(r1.body.fare, '₱20.00 (full fare — no discount is active right now)');
  assert.equal(r1.body.discountStatus, 'Eligible — no discount is active right now');
  await ctx.api.post(`/api/admin/fares/${f.id}/discount`).set(auth(admin)).send({ active: true, password: PW });
  await ctx.api.patch(`/api/admin/fares/${f.id}`).set(auth(admin)).send({ ...rule(), discountStart: day(3), password: PW });
  assert.equal((await lookup(dan, s.schoolId)).body.fare.startsWith('₱20.00 (full fare'), true);   // discount starts later
  await ctx.api.patch(`/api/admin/fares/${f.id}`).set(auth(admin)).send({ ...rule(), discountStart: day(-3), discountEnd: day(-1), password: PW });
  assert.equal((await lookup(dan, s.schoolId)).body.fare.startsWith('₱20.00 (full fare'), true);   // discount already ended
  await ctx.api.patch(`/api/admin/fares/${f.id}`).set(auth(admin)).send({ ...rule(), discountStart: day(-3), discountEnd: day(3), password: PW });
  assert.equal((await lookup(dan, s.schoolId)).body.fare, '₱15.00 (−25%)');                          // inside the discount window
});

test('rule activation: overlapping active rules for the same route are refused; deactivating frees the dates', async () => {
  const a = (await fpost(rule())).body.fare;
  const clash = await fpost(rule({ regularFare: 22 }));
  assert.equal(clash.status, 409); assert.match(clash.body.error, /already covers these dates/);
  const off = await ctx.api.post(`/api/admin/fares/${a.id}/status`).set(auth(admin)).send({ active: false, password: PW });
  assert.equal(off.body.fare.state, 'inactive');
  const b = await fpost(rule({ regularFare: 22 }));
  assert.equal(b.status, 201);
  const back = await ctx.api.post(`/api/admin/fares/${a.id}/status`).set(auth(admin)).send({ active: true, password: PW });
  assert.equal(back.status, 409);
  const other = await fpost(rule({ routeId: (await newRoute('Other')).id }));                // a different route does not clash
  assert.equal(other.status, 201);
  const inactive = await fpost(rule({ isActive: false }));                                   // saved as inactive: never clashes
  assert.equal(inactive.status, 201);
  const list = await ctx.api.get('/api/admin/fares?state=inactive').set(auth(admin));
  assert.equal(list.body.items.length, 2);
});

test('inputs are validated and sensitive changes need the administrator password', async () => {
  const bad = [{ regularFare: 0 }, { regularFare: -5 }, { regularFare: 'abc' }, { regularFare: 10.555 }, { discountPercent: 101 }, { discountPercent: -1 },
    { effectiveFrom: '2026-02-31' }, { effectiveUntil: day(-10) }, { discountStart: day(3), discountEnd: day(1) }, { routeId: 99999 }];
  for (const b of bad) assert.ok([400, 404].includes((await fpost(rule(b))).status), JSON.stringify(b));
  const noPw = await ctx.api.post('/api/admin/fares').set(auth(admin)).send(rule());
  assert.equal(noPw.status, 400);
  const wrong = await fpost(rule({ password: 'not-my-password' }));
  assert.equal(wrong.status, 403);
  const [[{ n }]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM fare_rules');
  assert.equal(n, 0);
  const f = (await fpost(rule())).body.fare;
  assert.equal((await ctx.api.post(`/api/admin/fares/${f.id}/status`).set(auth(admin)).send({ active: false, password: 'nope' })).status, 403);
  assert.equal((await ctx.api.get(`/api/admin/fares/${f.id}`).set(auth(admin))).body.fare.isActive, true);
  assert.equal((await ctx.api.get('/api/admin/fares/abc').set(auth(admin))).status, 404);
});

test('every fare change (and every refused attempt) is written to the activity log', async () => {
  const f = (await fpost(rule())).body.fare;
  await ctx.api.patch(`/api/admin/fares/${f.id}`).set(auth(admin)).send({ ...rule({ regularFare: 21, discountPercent: 30 }), password: PW });
  await ctx.api.post(`/api/admin/fares/${f.id}/discount`).set(auth(admin)).send({ active: false, password: PW });
  await ctx.api.post(`/api/admin/fares/${f.id}/status`).set(auth(admin)).send({ active: false, password: 'wrong' });
  const [rows] = await ctx.pool.query("SELECT action, status, description, actor_name FROM activity_logs WHERE action LIKE 'fare.%' ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.action, r.status]), [['fare.create', 'success'], ['fare.update', 'success'], ['fare.discount_off', 'success'], ['fare.deactivate', 'failed']]);
  assert.match(rows[1].description, /fare ₱20\.00 to ₱21\.00, discount 25% to 30%/);
  assert.ok(rows[0].actor_name);
});

test('editing a rule never rewrites past transactions', async () => {
  const f = (await fpost(rule())).body.fare;
  const s = await verifiedStudent();
  await lookup(dan, s.schoolId);
  await ctx.api.patch(`/api/admin/fares/${f.id}`).set(auth(admin)).send({ ...rule({ regularFare: 50, discountPercent: 40 }), password: PW });
  const [[old]] = await ctx.pool.query('SELECT fare, fare_amount, discount_amount FROM scans ORDER BY id LIMIT 1');
  assert.deepEqual([old.fare, old.fare_amount, old.discount_amount], ['₱15.00 (−25%)', 15, 5]);
  assert.equal((await lookup(dan, s.schoolId)).body.fare, '₱30.00 (−40%)');
});

test('denied scans are charged the full fare from the active rule, and the Verify Pass terminal uses the same rule', async () => {
  await fpost(rule());
  const s = await verifiedStudent();
  const verification = require('../src/services/verification');
  const [[adm]] = await ctx.pool.query("SELECT * FROM admins WHERE role = 'admin' LIMIT 1");
  const out = await verification.scanPass(ctx.pool, adm, { passId: s.schoolId, faceUnavailable: true });
  assert.equal(out.fare, '₱15.00 (−25%)');
  assert.equal(out.discountStatus, 'Eligible — 25% discount');
  const bad = await ctx.api.post('/api/scanner/lookup').set(auth(dan)).send({ schoolId: 'NOPE-0000' });
  assert.equal(bad.body.result, 'denied');
});

test('only administrators can read or change fares', async () => {
  const paths = ['/api/admin/fares', '/api/admin/fares/summary', '/api/admin/fares/calculate'];
  for (const p of paths) {
    assert.equal((await ctx.api.get(p)).status, 401);
    assert.equal((await ctx.api.get(p).set(auth(dan))).status, 403);
  }
  assert.equal((await ctx.api.post('/api/admin/fares').set(auth(dan)).send({ password: 'driver-pass-1', ...rule() })).status, 403);
  const s = await verifiedStudent();
  assert.equal((await ctx.api.get('/api/admin/fares').set(s.st)).status, 401);
});
