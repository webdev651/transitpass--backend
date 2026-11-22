'use strict';
// Stage 6: Reports & Analytics. Totals are checked against the actual records, and the cancelled / refunded rules are checked end to end.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload, config } = require('./helpers');
const { todayYmd } = require('../src/lib/dates');
const analytics = require('../src/services/analytics');

let ctx, admin, dan, eve, danId, eveId, route;
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
  route = (await apost('/routes', { name: 'Campus - Downtown', origin: 'Campus', destination: 'Downtown' })).body.route;
  await apost(`/routes/${route.id}/drivers`, { driverId: danId });
  await apost('/fares', { password: PW, routeId: route.id, regularFare: 20, discountPercent: 25, effectiveFrom: todayYmd(-1) });
});
after(() => ctx.pool.end());

async function student(verify = true) {
  const body = { ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1' };
  const reg = await ctx.api.post('/api/student-portal/register').send(body);
  const lg = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  if (!verify) return { id: reg.body.student.id, schoolId: body.schoolId };
  await apost(`/verifications/${reg.body.student.id}/approve`);
  await ctx.api.post('/api/student-portal/me/qr').set(auth(lg.body.token));
  return { id: reg.body.student.id, schoolId: body.schoolId, name: body.name };
}
const ride = async (token, s) => (await ctx.api.post('/api/scanner/lookup').set(auth(token)).send({ schoolId: s.schoolId })).body.scan.id;
const cancel = (id) => apost(`/refunds/transactions/${id}/cancel`, { reason: 'Driver scanned the wrong student', password: PW });
async function refund(id) {
  const made = await apost('/refunds', { scanId: id, reason: 'Charged twice on the bus' });
  const dec = await apost(`/refunds/${made.body.refund.id}/decision`, { decision: 'approved', password: PW });
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
}
/** A cancelled (dan 15.00, discount 5), B refunded (eve 13.00, discount 3.25), C completed (eve 13.00), D completed (dan 15.00); plus one denied scan and one pending student. */
async function world() {
  const [sa, sb, sc, sd] = [await student(), await student(), await student(), await student()];
  const pending = await student(false);
  const a = await ride(dan, sa), b = await ride(eve, sb), c = await ride(eve, sc), d = await ride(dan, sd);
  await ctx.api.post('/api/scanner/lookup').set(auth(dan)).send({ schoolId: 'NO-SUCH-ID' });
  assert.equal((await cancel(a)).status, 200); await refund(b);
  return { sa, sb, sc, sd, a, b, c, d, pending };
}
const rep = async (name, q = 'period=daily') => { const r = await aget(`/reports/${name}?${q}`); assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`); return r.body; };

test('transactions report: completed transactions and revenue exclude cancelled and refunded, which are shown separately', async () => {
  await world();
  const r = await rep('transactions');
  assert.deepEqual([r.summary.completed.count, r.summary.completed.revenue, r.summary.completed.discounts], [2, 28, 8.25]);
  assert.deepEqual([r.summary.cancelled.count, r.summary.cancelled.fareValue], [1, 15]);
  assert.deepEqual([r.summary.refunded.count, r.summary.refunded.fareValue], [1, 13]);
  assert.equal(r.table.total, 4, 'the table lists every transaction with its own status');
  const by = (st) => r.table.rows.filter((x) => x.status === st);
  assert.equal(by('Completed').length, 2); assert.equal(by('Cancelled').length, 1); assert.equal(by('Refunded').length, 1);
  assert.equal(r.table.totals.finalFare, 28, 'the totals row only adds completed rows');
  assert.equal(Math.round(by('Completed').reduce((n, x) => n + x.finalFare, 0) * 100) / 100, r.table.totals.finalFare);
  // the figures equal the database, counted independently
  const [[db]] = await ctx.pool.query(`SELECT SUM(fare_amount) AS f, COUNT(*) AS n FROM scans s WHERE result IN ('granted','review')
     AND NOT EXISTS (SELECT 1 FROM transaction_cancellations c WHERE c.scan_id = s.id) AND NOT EXISTS (SELECT 1 FROM refund_requests r WHERE r.scan_id = s.id AND r.status = 'approved')`);
  assert.equal(Number(db.f), 28); assert.equal(Number(db.n), 2);
  assert.equal(r.charts[0].series[0].values.reduce((a, b) => a + b, 0), 2, 'the daily chart adds up to the completed count');
});

test('a transaction that is refunded and later cancelled is counted once, as cancelled', async () => {
  const w = await world();
  const before = await rep('transactions');
  await refund(w.c); assert.equal((await cancel(w.c)).status, 200);
  const r = await rep('transactions');
  assert.equal(r.summary.completed.count, before.summary.completed.count - 1);
  assert.equal(r.summary.cancelled.count, before.summary.cancelled.count + 1);
  assert.equal(r.summary.refunded.count, before.summary.refunded.count, 'not counted a second time as refunded');
  assert.equal(r.summary.completed.count + r.summary.cancelled.count + r.summary.refunded.count, 4, 'every transaction has exactly one status');
});

test('fare collections: collected revenue, regular fare and discounts reconcile and nothing is double counted', async () => {
  await world();
  const r = await rep('fares');
  assert.equal(r.summary.revenue, 28); assert.equal(r.summary.discounts, 8.25); assert.equal(r.summary.regularFare, 36.25); assert.equal(r.summary.count, 2); assert.equal(r.summary.averageFare, 14);
  const sum = (k) => Math.round(r.table.rows.reduce((n, x) => n + x[k], 0) * 100) / 100;
  assert.equal(sum('collected'), r.summary.revenue, 'route rows add up to the total'); assert.equal(sum('discounts'), r.summary.discounts); assert.equal(sum('transactions'), 2);
  assert.ok(r.table.rows.every((x) => Math.abs(x.regularFare - (x.collected + x.discounts)) < 0.005), 'regular fare = collected + discount on every row');
  const routes = Object.fromEntries(r.table.rows.map((x) => [x.route, x.collected])); assert.equal(routes['Campus - Downtown'], 15);
  assert.equal(r.charts[0].series[0].values.reduce((a, b) => a + b, 0), 28);
});

test('discount utilization counts completed rides only and reports excluded discounts separately', async () => {
  await world();
  const r = await rep('discounts');
  assert.equal(r.summary.discounts, 8.25); assert.equal(r.summary.discountedRides, 2); assert.equal(r.summary.fullFareRides, 0); assert.equal(r.summary.utilizationRate, 100);
  assert.equal(r.summary.excludedDiscounts, 8.25, 'the cancelled (5.00) and refunded (3.25) discounts are not counted but are disclosed');
  assert.equal(r.summary.averageDiscount, 4.13); assert.match(r.note, /excluded/i);
  assert.equal(r.charts[1].x.length > 0, true);
});

test('cancelled and refunded report lists them separately with reasons and never as revenue', async () => {
  await world();
  const r = await rep('cancelled-refunded');
  assert.equal(r.table.total, 2);
  const c = r.table.rows.find((x) => x.type === 'Cancelled'), f = r.table.rows.find((x) => x.type === 'Refunded');
  assert.equal(c.fare, 15); assert.match(c.reason, /wrong student/); assert.equal(c.refunded, null);
  assert.equal(f.fare, 13); assert.equal(f.refunded, 13); assert.match(f.reason, /twice/);
  assert.equal(r.summary.cancelled.count, 1); assert.equal(r.summary.refunded.count, 1); assert.equal(r.cards[3].value, '₱28.00', 'excluded from revenue = 15 + 13');
});

test('driver activity: per-driver scans and completed fares add up to the totals', async () => {
  await world();
  const r = await rep('drivers');
  const d = Object.fromEntries(r.table.rows.map((x) => [x.driver, x]));
  assert.deepEqual([d['Dan Driver'].scans, d['Dan Driver'].completed, d['Dan Driver'].cancelled, d['Dan Driver'].denied, d['Dan Driver'].revenue], [3, 1, 1, 1, 15]);
  assert.deepEqual([d['Eve Driver'].scans, d['Eve Driver'].completed, d['Eve Driver'].refunded, d['Eve Driver'].revenue], [2, 1, 1, 13]);
  assert.equal(r.summary.scans, 5); assert.equal(r.summary.completed, 2); assert.equal(r.summary.revenue, 28); assert.equal(r.summary.activeDrivers, 2);
  assert.equal(r.table.totals.revenue, 28);
});

test('student registrations: counts by verification status and by who registered them', async () => {
  const w = await world();
  const r = await rep('students');
  assert.equal(r.summary.total, 5); assert.equal(r.summary.verified, 4); assert.equal(r.summary.pending, 1); assert.equal(r.summary.rejected, 0); assert.equal(r.summary.online, 5);
  assert.equal(r.table.total, 5); assert.ok(r.table.rows.some((x) => x.schoolId === w.pending.schoolId && x.verification === 'Pending'));
  assert.equal(r.charts[0].series[0].values.reduce((a, b) => a + b, 0), 5);
  assert.equal(JSON.stringify(r).includes('password'), false, 'no credentials in a report');
});

test('daily, weekly, monthly and custom ranges', async () => {
  await world();
  const today = todayYmd(0), yesterday = todayYmd(-1), tomorrow = todayYmd(1);
  for (const q of ['period=daily', 'period=weekly', 'period=monthly', `period=custom&from=${yesterday}&to=${tomorrow}`, `period=daily&date=${today}`]) assert.equal((await rep('transactions', q)).summary.completed.count, 2, q);
  for (const q of [`period=daily&date=${yesterday}`, `period=custom&from=${yesterday}&to=${yesterday}`, `period=custom&from=${tomorrow}&to=${tomorrow}`]) assert.equal((await rep('transactions', q)).summary.completed.count, 0, q);
  const w = (await rep('transactions', 'period=weekly')).range; assert.equal(w.days, 7); assert.ok(w.from <= today && today <= w.to);
  const m = (await rep('transactions', 'period=monthly')).range; assert.ok(m.from.endsWith('-01') && m.days >= 28);
  assert.equal((await rep('transactions', 'period=daily')).charts[0].x.length, 1);
  assert.equal((await rep('transactions', 'period=monthly')).charts[0].x.length, m.days, 'one chart point per day');
  const noData = await rep('transactions', `period=custom&from=${tomorrow}&to=${tomorrow}`); assert.deepEqual(noData.table.rows, []); assert.equal(noData.summary.completed.revenue, 0);
  for (const q of ['period=custom', `period=custom&from=${tomorrow}&to=${yesterday}`, 'period=custom&from=2020-01-01&to=2022-01-01', 'period=yearly', 'period=daily&date=2026-02-30', 'period=daily&date=tomorrow']) assert.equal((await aget(`/reports/transactions?${q}`)).status, 400, q);
});

test('the summary cards agree with Transaction Management and the dashboard', async () => {
  await world();
  const o = (await aget('/reports/overview?period=daily')).body;
  const card = Object.fromEntries(o.cards.map((c) => [c.key, c]));
  const t = (await aget(`/transactions?from=${todayYmd(0)}&to=${todayYmd(0)}`)).body.summary;
  assert.equal(card.completed.value, t.completed.count); assert.equal(card.revenue.amount, t.completed.revenue); assert.equal(card.cancelled.value, t.cancelled.count); assert.equal(card.refunded.value, t.refunded.count);
  assert.equal(card.discounts.amount, t.completed.discounts);
  assert.equal(card.students.value, 5); assert.equal(card.drivers.value, 2);
  const dash = await aget('/dashboard/summary'); assert.equal(dash.status, 200, JSON.stringify(dash.body));
  assert.equal(dash.body.stats.totalTransactions, 2, 'the dashboard counts completed rides only');
  assert.equal(dash.body.stats.totalDiscounts, 8.25, 'and only the discounts of completed rides');
  assert.equal(dash.body.notes.transactionsToday, 2); assert.equal(dash.body.notes.discountsToday, 8.25);
  const ch = JSON.stringify((await aget('/dashboard/charts')).body); assert.ok(ch.length > 10);
});

test('CSV export of every report: header, rows, totals row, filename, Excel-safe, and each export is logged', async () => {
  await world();
  const sums = { transactions: 28, fares: 28, drivers: 28, discounts: 8.25 };
  for (const name of analytics.REPORT_NAMES) {
    const r = await aget(`/reports/${name}/export.csv?period=daily`);
    assert.equal(r.status, 200, name); assert.match(r.headers['content-type'], /text\/csv/); assert.match(r.headers['content-disposition'], new RegExp(`transitpass-${name}-\\d{4}-\\d{2}-\\d{2}\\.csv`));
    const lines = r.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    assert.ok(lines.length >= 2, `${name} has data rows`);
    if (sums[name]) assert.ok(/TOTAL/.test(lines[lines.length - 1]) && lines[lines.length - 1].includes(String(sums[name])), `${name} totals row: ${lines[lines.length - 1]}`);
  }
  const csv = (await aget('/reports/transactions/export.csv?period=daily')).text;
  assert.equal(csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/).length, 1 + 4 + 1, 'header + 4 transactions + totals');
  const l = (await aget('/activity-logs?limit=100&type=report')).body.items;
  assert.equal(l.filter((i) => i.action === 'report.export').length >= 7, true);
  assert.equal((await apost('/reports/fares/print?period=daily')).status, 204);
  assert.ok((await aget('/activity-logs?type=report&q=Printed')).body.total >= 1);
});

test('PDF export of every report: real PDF, period and filename, actual rows, each export is logged', async () => {
  await world();
  for (const name of analytics.REPORT_NAMES) {
    const r = await aget(`/reports/${name}/export.pdf?period=daily`);
    assert.equal(r.status, 200, name);
    assert.match(r.headers['content-type'], /application\/pdf/);
    assert.match(r.headers['content-disposition'], new RegExp(`transitpass-${name}-\\d{4}-\\d{2}-\\d{2}\\.pdf`));
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.text || '', 'latin1');
    assert.equal(body.slice(0, 5).toString('latin1'), '%PDF-', `${name} is a real PDF`);
    const text = body.toString('latin1');
    assert.ok(text.includes('TransitPass'), `${name} PDF is branded`);
    assert.ok(text.includes('daily'), `${name} PDF states its period`);
  }
  const l = (await aget('/activity-logs?limit=100&type=report')).body.items;
  assert.equal(l.filter((i) => i.action === 'report.export.pdf').length >= 6, true);
  assert.equal((await aget('/reports/payroll/export.pdf')).status, 404);
});

test('a student named like a spreadsheet formula cannot inject it through a report', async () => {
  const s = await student(); await ride(dan, s);
  await sql("UPDATE students SET name = ? WHERE id = ?", ['=HYPERLINK("http://evil","x")', s.id]);
  await sql("UPDATE scans SET student_name = ? WHERE student_id = ?", ['=HYPERLINK("http://evil","x")', s.id]);
  const csv = (await aget('/reports/transactions/export.csv?period=daily')).text;
  assert.ok(!/(^|,)"?=HYPERLINK/m.test(csv)); assert.match(csv, /'=HYPERLINK/);
});

test('reports are read only, administrator only, and reject unknown reports and hostile input', async () => {
  await world();
  assert.equal((await ctx.api.get(A + '/reports/overview')).status, 401);
  for (const p of ['/reports/overview', '/reports/transactions', '/reports/fares/export.csv']) assert.equal((await aget(p, dan)).status, 403, p);
  assert.equal((await aget('/reports/payroll')).status, 404); assert.equal((await aget('/reports/payroll/export.csv')).status, 404);
  assert.equal((await ctx.api.delete(A + '/reports/transactions').set(auth(admin))).status, 404);
  assert.equal((await ctx.api.put(A + '/reports/transactions').set(auth(admin)).send({})).status, 404);
  const n = (await sql('SELECT COUNT(*) AS n FROM scans'))[0].n;
  assert.equal((await aget("/reports/transactions?period=daily&date=2026-01-01' OR '1'='1")).status, 400);
  assert.equal((await aget('/reports/transactions?limit=999999')).status, 400);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM scans'))[0].n, n);
});

test('an empty system produces zeros, not errors', async () => {
  for (const name of analytics.REPORT_NAMES) { const r = await rep(name, 'period=monthly'); assert.ok(Array.isArray(r.table.rows)); assert.ok(r.cards.length >= 3); }
  assert.equal((await aget('/reports/overview?period=weekly')).status, 200);
});
