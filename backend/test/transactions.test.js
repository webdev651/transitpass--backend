'use strict';
// Stage 3: Transaction Management. Integration tests against the real database, like the other suites.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload, config } = require('./helpers');
const { todayYmd } = require('../src/lib/dates');

let ctx, admin, dan, eve, danId, eveId, route, rule;
const PW = config.seedAdmin.password;
const A = '/api/admin';
const aget = (p, t = admin) => ctx.api.get(A + p).set(auth(t));
const apost = (p, b, t = admin) => ctx.api.post(A + p).set(auth(t)).send(b || {});
const sql = async (q, a) => (await ctx.pool.query(q, a))[0];

before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await reset(ctx.pool);
  admin = await login(ctx.api);
  for (const [u, n] of [['dan', 'Dan Driver'], ['eve', 'Eve Driver']]) {
    const r = await apost('/drivers', { name: n, username: u, email: `${u}@example.com`, password: 'driver-pass-1', unit: `Bus ${u}` });
    if (u === 'dan') danId = r.body.driver.id; else eveId = r.body.driver.id;
  }
  dan = (await ctx.api.post('/api/auth/login').send({ username: 'dan', password: 'driver-pass-1' })).body.token;
  eve = (await ctx.api.post('/api/auth/login').send({ username: 'eve', password: 'driver-pass-1' })).body.token;
  // dan drives the Campus - Downtown route, which has its own fare rule (20.00, 25% off -> 15.00); eve is priced by the default rule (13.00)
  route = (await apost('/routes', { name: 'Campus - Downtown', origin: 'Campus', destination: 'Downtown' })).body.route;
  await apost(`/routes/${route.id}/drivers`, { driverId: danId });
  rule = (await apost('/fares', { password: PW, routeId: route.id, regularFare: 20, discountPercent: 25, effectiveFrom: todayYmd(-1) })).body.fare;
});
after(() => ctx.pool.end());

async function student() {
  const body = { ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1' };
  const reg = await ctx.api.post('/api/student-portal/register').send(body);
  const lg = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  await apost(`/verifications/${reg.body.student.id}/approve`);
  await ctx.api.post('/api/student-portal/me/qr').set(auth(lg.body.token));
  return { id: reg.body.student.id, schoolId: body.schoolId, name: body.name };
}
async function ride(token, s) {
  const r = await ctx.api.post('/api/scanner/lookup').set(auth(token)).send({ schoolId: s.schoolId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.scan.id;
}
const cancel = (scanId, reason = 'Driver scanned the wrong student') => apost(`/refunds/transactions/${scanId}/cancel`, { reason, password: PW });
async function refund(scanId) {
  const made = await apost('/refunds', { scanId, reason: 'Charged twice on the bus' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const dec = await apost(`/refunds/${made.body.refund.id}/decision`, { decision: 'approved', password: PW });
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
}

/** A cancelled (dan, 15.00), B refunded (eve, 13.00), C completed (eve, 13.00), D completed (dan, 15.00). */
async function world() {
  const [sa, sb, sc, sd] = [await student(), await student(), await student(), await student()];
  const a = await ride(dan, sa), b = await ride(eve, sb), c = await ride(eve, sc), d = await ride(dan, sd);
  assert.equal((await cancel(a)).status, 200);
  await refund(b);
  return { sa, sb, sc, sd, a, b, c, d };
}
const ref = (id) => `TXN-${String(id).padStart(8, '0')}`;

test('every student transaction is listed with its reference, fares, status and the totals keep cancelled and refunded apart', async () => {
  const w = await world();
  const r = await aget('/transactions');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 4);
  const by = Object.fromEntries(r.body.items.map((t) => [t.id, t]));
  assert.equal(by[w.a].status, 'cancelled'); assert.equal(by[w.b].status, 'refunded');
  assert.equal(by[w.c].status, 'completed'); assert.equal(by[w.d].status, 'completed');
  assert.equal(by[w.d].reference, ref(w.d), 'the Stage 2 reference number is reused');
  assert.deepEqual([by[w.d].regularFare, by[w.d].discountPercent, by[w.d].discountAmount, by[w.d].finalFare], [20, 25, 5, 15]);
  assert.deepEqual([by[w.c].regularFare, by[w.c].discountPercent, by[w.c].discountAmount, by[w.c].finalFare], [16.25, 20, 3.25, 13]);
  assert.equal(by[w.a].route, 'Campus - Downtown', 'a ride tied to a route shows the route name'); assert.equal(by[w.a].studentName, w.sa.name); assert.equal(by[w.a].schoolId, w.sa.schoolId);
  const s = r.body.summary;
  assert.deepEqual(s.completed, { count: 2, revenue: 28, regularFare: 36.25, discounts: 8.25 }, 'completed totals exclude cancelled and refunded');
  assert.deepEqual(s.cancelled, { count: 1, fareValue: 15 });
  assert.deepEqual(s.refunded, { count: 1, fareValue: 13, refundedAmount: 13 });
  assert.equal(s.all, 4);
});

test('search by reference number (full or partial), student name and School ID', async () => {
  const w = await world();
  const ids = async (q) => (await aget(`/transactions?q=${encodeURIComponent(q)}`)).body.items.map((t) => t.id).sort();
  assert.deepEqual(await ids(ref(w.c)), [w.c]);
  assert.deepEqual(await ids(String(w.c).padStart(8, '0')), [w.c]);
  assert.deepEqual(await ids(w.sb.name), [w.b]);
  assert.deepEqual(await ids(w.sd.schoolId), [w.d]);
  assert.deepEqual(await ids('no-such-person'), []);
  assert.equal((await aget('/transactions?q=%25')).body.total, 0, 'a % in the search is text, not a wildcard');
});

test('filters: driver, route, date range and status (each alone and combined)', async () => {
  const w = await world();
  const ids = async (qs) => (await aget(`/transactions?${qs}`)).body.items.map((t) => t.id).sort((x, y) => x - y);
  assert.deepEqual(await ids(`driverId=${danId}`), [w.a, w.d]);
  assert.deepEqual(await ids(`driverId=${eveId}`), [w.b, w.c]);
  assert.deepEqual(await ids(`routeId=${route.id}`), [w.a, w.d], "dan's rides are on the route; eve's are not");
  assert.deepEqual(await ids(`status=cancelled`), [w.a]);
  assert.deepEqual(await ids(`status=refunded`), [w.b]);
  assert.deepEqual(await ids(`status=completed`), [w.c, w.d]);
  assert.deepEqual(await ids(`driverId=${danId}&status=completed`), [w.d]);
  assert.equal((await aget(`/transactions?from=${todayYmd()}&to=${todayYmd()}`)).body.total, 4);
  assert.equal((await aget(`/transactions?from=${todayYmd(1)}`)).body.total, 0);
  assert.equal((await aget(`/transactions?to=${todayYmd(-1)}`)).body.total, 0);
  // the totals follow the filters, but not the status filter, so the three groups always show side by side
  const s = (await aget(`/transactions?driverId=${danId}&status=cancelled`)).body.summary;
  assert.equal(s.completed.count, 1); assert.equal(s.cancelled.count, 1); assert.equal(s.refunded.count, 0);
});

test('bad filters are refused', async () => {
  assert.equal((await aget('/transactions?status=bogus')).status, 400);
  assert.equal((await aget('/transactions?from=2026-02-31')).status, 400);
  assert.equal((await aget(`/transactions?from=${todayYmd(1)}&to=${todayYmd(-1)}`)).status, 400, 'start after end');
  assert.equal((await aget('/transactions/export.csv?status=bogus')).status, 400);
  assert.equal((await aget('/transactions/report?driverId=abc')).status, 400);
});

test('a transaction with a pending refund request is still completed; a cancelled one that was also refunded shows as cancelled', async () => {
  const w = await world();
  const made = await apost('/refunds', { scanId: w.c, reason: 'Charged twice on the bus' });
  assert.equal(made.status, 201);
  assert.equal((await aget(`/transactions/${w.c}`)).body.transaction.status, 'completed');
  assert.equal((await aget(`/transactions/${w.c}`)).body.transaction.refundPending, true);
  assert.equal((await cancel(w.b)).status, 200, 'a refunded transaction can still be cancelled by the existing rules');
  const b = (await aget(`/transactions/${w.b}`)).body.transaction;
  assert.equal(b.status, 'cancelled'); assert.equal(b.refund.amount, 13);
  const s = (await aget('/transactions')).body.summary;
  assert.equal(s.refunded.count, 0); assert.equal(s.cancelled.count, 2); assert.equal(s.completed.count, 2);
});

test('details: student, driver, service, fares (from the fare rule that priced the ride), reference, date and time, history', async () => {
  const w = await world();
  const t = (await aget(`/transactions/${w.a}`)).body.transaction;
  assert.equal(t.reference, ref(w.a));
  assert.equal(t.student.name, w.sa.name); assert.equal(t.student.schoolId, w.sa.schoolId);
  assert.ok(t.student.school && t.student.program && t.student.email, 'student information');
  assert.equal(t.driverInfo.name, 'Dan Driver'); assert.equal(t.driverInfo.email, 'dan@example.com');
  assert.equal(t.service.routeName, 'Campus - Downtown'); assert.equal(t.route, 'Campus - Downtown'); assert.ok(['QR scan', 'Manual ID entry'].includes(t.service.method));
  assert.equal(t.service.fareRule.id, rule.id); assert.equal(t.service.fareRule.regularFare, 20); assert.equal(t.service.fareRule.discountPercent, 25);
  assert.deepEqual([t.regularFare, t.discountPercent, t.discountAmount, t.finalFare], [20, 25, 5, 15]);
  assert.match(t.date, /^\d{2} \w{3} \d{4}$/); assert.match(t.time, /^\d{2}:\d{2}:\d{2}$/); assert.ok(t.scannedAt);
  assert.equal(t.cancellation.reason, 'Driver scanned the wrong student'); assert.equal(t.cancellation.cancelledBy, config.seedAdmin.name);
  const b = (await aget(`/transactions/${w.b}`)).body.transaction;
  assert.equal(b.refund.amount, 13); assert.equal(b.refund.reason, 'Charged twice on the bus');
  assert.equal(b.service.fareRule.regularFare, 16.25, 'eve is priced by the default fallback rule stored on her scan');
  assert.equal((await aget('/transactions/99999')).status, 404);
  assert.equal((await aget('/transactions/abc')).status, 404);
});

test('printable receipt: real-time fare, student, driver, service and money fields', async () => {
  const w = await world();
  const r = (await aget(`/transactions/${w.d}/receipt`)).body.receipt;
  assert.ok(r, 'a receipt is returned');
  assert.equal(r.reference, ref(w.d));
  assert.equal(r.status, 'completed');
  assert.ok(['completed', 'cancelled', 'refunded', 'pending'].includes(r.status));
  assert.equal(r.student.name, w.sd.name); assert.equal(r.student.schoolId, w.sd.schoolId);
  assert.equal(r.driver.name, 'Dan Driver');
  assert.equal(r.service, 'Campus - Downtown');
  assert.deepEqual([r.regularFare, r.discountPercent, r.discountAmount, r.finalFare], [20, 25, 5, 15]);
  assert.deepEqual(r.money, { regular: '20.00', discount: '5.00', final: '15.00' });
  assert.ok(r.scannedAt && r.date && r.time);
  assert.equal(r.cancelled, false); assert.equal(r.refunded, false); assert.equal(r.underReview, false);
  assert.equal((await aget('/transactions/99999/receipt')).status, 404);
  assert.equal((await aget('/transactions/abc/receipt')).status, 404);
});

test('cancelled and refunded transactions surface cancellation/refund on the receipt', async () => {
  const w = await world();
  const a = (await aget(`/transactions/${w.a}/receipt`)).body.receipt;
  assert.equal(a.status, 'cancelled'); assert.equal(a.cancelled, true); assert.equal(a.refunded, false);
  const b = (await aget(`/transactions/${w.b}/receipt`)).body.receipt;
  assert.equal(b.status, 'refunded'); assert.equal(b.cancelled, false); assert.equal(b.refunded, true);
});

test('only administrators can open a receipt', async () => {
  const w = await world();
  const paths = [`/transactions/${w.d}/receipt`];
  for (const p of paths) {
    assert.equal((await ctx.api.get(A + p)).status, 401, `${p} needs a token`);
    assert.equal((await ctx.api.get(A + p).set(auth(dan))).status, 403, `${p} is not for drivers`);
  }
  const s = await student();
  const lg = await ctx.api.post('/api/student-portal/login').send({ schoolId: s.schoolId, password: 'secret-pass-1' });
  assert.ok([401, 403].includes((await ctx.api.get(A + `/transactions/${w.d}/receipt`).set(auth(lg.body.token))).status), 'not for students');
});

test('CSV export is Excel-ready, follows the filters, and is recorded in the activity log', async () => {
  const w = await world();
  const all = await aget('/transactions/export.csv');
  assert.equal(all.status, 200);
  assert.match(all.headers['content-type'], /text\/csv/);
  assert.match(all.headers['content-disposition'], /attachment; filename="transactions-\d{8}\.csv"/);
  const text = all.text;
  assert.equal(text.charCodeAt(0), 0xfeff, 'byte-order mark for Excel');
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length, 5, 'header + 4 transactions');
  assert.ok(lines[0].includes('"Reference No."') && lines[0].includes('"Final Fare"') && lines[0].includes('"Status"'));
  assert.ok(text.includes(ref(w.a)) && text.includes('"Cancelled"') && text.includes('"Refunded"'));
  const only = (await aget(`/transactions/export.csv?status=cancelled&driverId=${danId}`)).text.trim().split('\r\n');
  assert.equal(only.length, 2);
  assert.ok(only[1].includes(ref(w.a)));
  const [log] = await sql("SELECT * FROM activity_logs WHERE action = 'transaction.export' ORDER BY id DESC");
  assert.ok(log, 'the export is audited'); assert.equal(log.actor_name, config.seedAdmin.name);
});

test('printable report: rows, separate totals, the filters in words, and who opened it', async () => {
  const w = await world();
  const r = (await aget(`/transactions/report?driverId=${danId}`)).body;
  assert.equal(r.items.length, 2); assert.equal(r.total, 2); assert.equal(r.truncated, false);
  assert.deepEqual(r.filters, ['Driver: Dan Driver']);
  assert.equal(r.summary.completed.count, 1); assert.equal(r.summary.cancelled.count, 1);
  assert.deepEqual(r.items.map((t) => t.id).sort((x, y) => x - y), [w.a, w.d]);
  assert.ok(r.generatedAt);
  assert.ok((await sql("SELECT 1 FROM activity_logs WHERE action = 'transaction.report'")).length);
});

test('only administrators can use it', async () => {
  const w = await world();
  const paths = ['/transactions', `/transactions/${w.c}`, '/transactions/filters', '/transactions/report', '/transactions/export.csv'];
  for (const p of paths) {
    assert.equal((await ctx.api.get(A + p)).status, 401, `${p} needs a token`);
    assert.equal((await ctx.api.get(A + p).set(auth(dan))).status, 403, `${p} is not for drivers`);
  }
  const s = await student();
  const lg = await ctx.api.post('/api/student-portal/login').send({ schoolId: s.schoolId, password: 'secret-pass-1' });
  assert.ok([401, 403].includes((await ctx.api.get(A + '/transactions').set(auth(lg.body.token))).status), 'not for students');
});

test('filter options list the drivers and the routes', async () => {
  const f = (await aget('/transactions/filters')).body;
  assert.deepEqual(f.drivers.map((d) => d.name).sort(), ['Dan Driver', 'Eve Driver']);
  assert.ok(f.routes.some((r) => r.id === route.id && r.name === 'Campus - Downtown'));
});

test('existing refund and cancellation behaviour is unchanged, and nothing is ever deleted or edited by this page', async () => {
  const w = await world();
  const before = await sql('SELECT id, fare_amount, discount_amount, result FROM scans ORDER BY id');
  await aget('/transactions'); await aget(`/transactions/${w.a}`); await aget('/transactions/export.csv'); await aget('/transactions/report');
  assert.deepEqual(await sql('SELECT id, fare_amount, discount_amount, result FROM scans ORDER BY id'), before);
  assert.equal((await cancel(w.a)).status, 409, 'already cancelled');
  assert.equal((await apost('/refunds', { scanId: w.a, reason: 'Charged twice on the bus' })).status, 409, 'a cancelled transaction cannot be refunded');
  assert.equal((await apost('/refunds', { scanId: w.b, reason: 'Charged twice on the bus' })).status, 409, 'one approved refund per transaction');
  assert.equal((await apost(`/refunds/transactions/${w.c}/cancel`, { reason: 'Driver scanned the wrong student', password: 'wrong' })).status, 403, 'a wrong password cancels nothing');
  assert.equal((await sql('SELECT COUNT(*) AS n FROM transaction_cancellations'))[0].n, 1);
  const old = (await aget('/refunds/transactions?state=cancelled')).body;
  assert.deepEqual(old.items.map((t) => t.id), [w.a]);
  assert.equal((await aget(`/refunds/transactions`)).body.total, 4);
  const dash = (await aget('/dashboard/transactions')).body;
  assert.equal(dash.total, 4, 'the dashboard list is untouched');
});

test('QR scanning and fare calculation still work for new rides after the stage-3 migration', async () => {
  const s = await student();
  const r = await ctx.api.post('/api/scanner/lookup').set(auth(eve)).send({ schoolId: s.schoolId });
  assert.equal(r.status, 200);
  assert.equal(r.body.fare, '₱13.00 (−20%)');
  const [[row]] = await ctx.pool.query('SELECT fare_amount, discount_amount, fare_rule_id FROM scans ORDER BY id DESC LIMIT 1');
  assert.equal(row.fare_amount, 13); assert.equal(row.discount_amount, 3.25); assert.ok(row.fare_rule_id);
  const [idx] = await ctx.pool.query("SHOW INDEX FROM scans WHERE Key_name = 'idx_scans_route'");
  assert.ok(idx.length, 'migration added the route index');
});
