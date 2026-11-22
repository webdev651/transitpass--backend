'use strict';
// Stage 5: Activity Log Management. Read only, built on the existing activity_logs table and the other existing records.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload, config } = require('./helpers');
const { todayYmd } = require('../src/lib/dates');

let ctx, admin, dan, danId;
const PW = config.seedAdmin.password;
const A = '/api/admin';
const aget = (p, t = admin) => ctx.api.get(A + p).set(auth(t));
const apost = (p, b, t = admin) => ctx.api.post(A + p).set(auth(t)).send(b || {});
const sql = async (q, a) => (await ctx.pool.query(q, a))[0];

before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await reset(ctx.pool);
  admin = await login(ctx.api);
  const r = await apost('/drivers', { name: 'Dan Driver', username: 'dan', email: 'dan@example.com', password: 'driver-pass-1', unit: 'Bus 1' });
  danId = r.body.driver.id;
  dan = (await ctx.api.post('/api/auth/login').send({ username: 'dan', password: 'driver-pass-1' })).body.token;
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
const scan = (schoolId) => ctx.api.post('/api/scanner/lookup').set(auth(dan)).send({ schoolId });

/** Activity of every kind the page has to show. */
async function activity() {
  await ctx.api.post('/api/auth/login').send({ username: 'nobody', password: 'wrong-wrong-1' });       // failed sign-in
  const s = await student();                                                                          // student registration + QR generation
  const ok = await scan(s.schoolId); const scanId = ok.body.scan.id;                                  // a transaction
  await scan('NO-SUCH-ID');                                                                           // a denied scan
  await apost('/fares', { password: PW, regularFare: 18, discountPercent: 20, effectiveFrom: todayYmd(-1) });   // fare
  const made = await apost('/refunds', { scanId, reason: 'Charged twice on the bus' });               // refund
  await apost(`/refunds/${made.body.refund.id}/decision`, { decision: 'approved', password: PW });
  await ctx.api.patch(A + '/account').set(auth(admin)).send({ name: 'Chief Admin' });                  // profile
  return { s, scanId };
}

test('every kind of activity is shown with type, description, date, time, IP address and status', async () => {
  const { scanId } = await activity();
  const r = await aget('/activity-logs?limit=100');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const types = new Set(r.body.items.map((i) => i.type));
  for (const t of ['auth', 'student', 'qr', 'driver', 'fare', 'transaction', 'refund', 'account']) assert.ok(types.has(t), `missing activity type ${t}: ${[...types]}`);
  for (const i of r.body.items) {
    for (const k of ['id', 'type', 'typeLabel', 'description', 'date', 'time', 'status', 'statusLabel', 'at']) assert.ok(i[k], `${i.id} lacks ${k}`);
    assert.match(i.date, /\d/); assert.match(i.time, /\d/);
  }
  const login1 = r.body.items.find((i) => i.action === 'auth.login' && i.status === 'success');
  assert.ok(login1 && login1.ip, 'a successful sign-in records the IP address');
  const bad = r.body.items.find((i) => i.action === 'auth.login_failed');
  assert.ok(bad && bad.status === 'failed' && bad.ip, 'a failed sign-in is recorded as failed with its IP address');
  assert.ok(r.body.items.some((i) => i.id === `txn-${scanId}` && i.type === 'transaction'));
  assert.ok(r.body.items.some((i) => i.type === 'qr' && i.action === 'qr.scan_denied' && i.status === 'failed'));
  assert.ok(r.body.items.some((i) => i.type === 'student' && i.action === 'student.register'));
  assert.ok(r.body.items.some((i) => i.type === 'fare'), 'fare changes appear under the fare type even though they were logged under settings');
  assert.deepEqual(r.body.items.map((i) => i.at), [...r.body.items.map((i) => i.at)].sort().reverse(), 'newest first');
});

test('search and filters by type, status and date work, alone and together', async () => {
  const { s } = await activity();
  const only = async (q) => (await aget('/activity-logs?' + (/limit=/.test(q) ? '' : 'limit=200&') + q)).body;
  for (const t of ['fare', 'refund', 'account', 'transaction', 'auth']) { const b = await only('type=' + t); assert.ok(b.total > 0, t); assert.ok(b.items.every((i) => i.type === t), `type=${t}`); }
  const failed = await only('status=failed'); assert.ok(failed.total >= 2); assert.ok(failed.items.every((i) => i.status === 'failed'));
  const okOnly = await only('status=success'); assert.ok(okOnly.items.every((i) => i.status === 'success'));
  assert.equal(failed.total + okOnly.total, (await only('')).total, 'success + failed add up to everything');
  const today = todayYmd(0), tomorrow = todayYmd(1), yesterday = todayYmd(-1);
  assert.equal((await only(`from=${today}&to=${today}`)).total, (await only('')).total, 'everything happened today');
  assert.equal((await only(`from=${tomorrow}`)).total, 0); assert.equal((await only(`to=${yesterday}`)).total, 0);
  const q = await only('q=' + encodeURIComponent(s.schoolId)); assert.ok(q.total >= 1); assert.ok(q.items.every((i) => JSON.stringify(i).includes(s.schoolId)));
  const both = await only(`type=auth&status=failed&from=${today}&to=${today}&q=nobody`); assert.equal(both.total, 1);
  assert.equal((await aget(`/activity-logs?from=${tomorrow}&to=${yesterday}`)).status, 400, 'start after end');
  assert.equal((await aget('/activity-logs?from=2026-02-31')).status, 400, 'not a real date');
  assert.equal((await aget('/activity-logs?status=maybe')).status, 400);
  const page1 = await only('limit=5&offset=0'), page2 = await only('limit=5&offset=5');
  assert.equal(page1.items.length, 5); assert.notEqual(page1.items[0].id, page2.items[0].id); assert.equal(page1.total, page2.total);
});

test('summary counts agree with the list', async () => {
  await activity();
  const total = (await aget('/activity-logs?limit=1')).body.total;
  const s = (await aget('/activity-logs/summary')).body;
  assert.equal(s.total, total); assert.equal(s.success + s.failed, total); assert.ok(s.failed >= 2); assert.equal(s.failedSignIns, 1);
  const f = (await aget('/activity-logs/summary?type=fare')).body; assert.equal(f.total, (await aget('/activity-logs?type=fare&limit=1')).body.total);
});

test('one activity can be opened with its details; unknown or malformed ids are 404', async () => {
  const { scanId } = await activity();
  const list = (await aget('/activity-logs?type=account&limit=5')).body.items;
  const d = await aget('/activity-logs/' + list[0].id);
  assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.activity.id, list[0].id); assert.ok(d.body.activity.source); assert.equal(d.body.activity.description, list[0].description);
  const t = await aget('/activity-logs/txn-' + scanId); assert.equal(t.body.activity.reference, `TXN-${String(scanId).padStart(8, '0')}`);
  for (const bad of ['log-999999', 'txn-0', 'zzz-1', 'log-1%27%20OR%201=1', 'log-abc']) assert.equal((await aget('/activity-logs/' + bad)).status, 404, bad);
});

test('CSV export has the required columns, respects the filters, protects against spreadsheet formulas and is itself logged', async () => {
  await activity();
  await sql("INSERT INTO activity_logs (admin_id, actor_name, actor_role, category, action, description, status, ip_address) VALUES (NULL, 'Eve', 'admin', 'system', 'test.formula', '=HYPERLINK(\"http://evil\")', 'success', '10.0.0.9')");
  const r = await aget('/activity-logs/export.csv?type=auth');
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /text\/csv/); assert.match(r.headers['content-disposition'], /activity-logs-\d{8}\.csv/);
  const lines = r.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  assert.equal(lines[0].replace(/"/g, ''), 'Log ID,Date,Time,Activity Type,Action,Description,User,Role,IP Address,Status');
  assert.ok(lines.length > 2); assert.ok(lines.slice(1).every((l) => l.includes('Sign-in / sign-out')), 'only the filtered type is exported');
  const all = (await aget('/activity-logs/export.csv?q=HYPERLINK')).text;
  assert.ok(!/(^|,)"?=HYPERLINK/m.test(all), 'a cell never starts with ='); assert.match(all, /'=HYPERLINK/);
  const exp = (await aget('/activity-logs?limit=50&q=Exported')).body.items;
  assert.ok(exp.some((i) => i.action === 'activitylog.export' && i.type === 'report'), 'the export is recorded');
});

test('the print report returns the filtered rows and a readable description of the filters', async () => {
  await activity();
  const r = await aget('/activity-logs/report?type=fare&status=success');
  assert.equal(r.status, 200); assert.ok(r.body.items.length > 0 && r.body.items.every((i) => i.type === 'fare'));
  assert.deepEqual(r.body.filters, ['Type: Fare & discount', 'Status: Success']); assert.equal(r.body.truncated, false); assert.ok(r.body.generatedAt);
});

test('logs are read only and only the administrator can open them', async () => {
  const { scanId } = await activity();
  const before = (await sql('SELECT COUNT(*) AS n FROM activity_logs'))[0].n;
  const id = (await sql('SELECT id FROM activity_logs ORDER BY id LIMIT 1'))[0].id;
  for (const [m, p] of [['post', '/activity-logs'], ['patch', `/activity-logs/log-${id}`], ['put', `/activity-logs/log-${id}`], ['delete', `/activity-logs/log-${id}`], ['delete', '/activity-logs'], ['post', `/activity-logs/txn-${scanId}`]]) {
    const r = await ctx.api[m](A + p).set(auth(admin)).send({ description: 'tampered' });
    assert.equal(r.status, 404, `${m} ${p} -> ${r.status}`);
  }
  assert.equal((await sql('SELECT COUNT(*) AS n FROM activity_logs'))[0].n, before, 'nothing was added, changed or removed');
  assert.ok(!(await sql('SELECT 1 FROM activity_logs WHERE description = ?', ['tampered'])).length);
  for (const p of ['/activity-logs', '/activity-logs/summary', '/activity-logs/meta', '/activity-logs/export.csv', '/activity-logs/report', '/activity-logs/log-1']) {
    assert.equal((await ctx.api.get(A + p)).status, 401, 'no token ' + p);
    assert.equal((await ctx.api.get(A + p).set(auth(dan))).status, 403, 'driver ' + p);
    assert.equal((await ctx.api.get(A + p).set(auth('not.a.token'))).status, 401, 'bad token ' + p);
  }
  const st = (await ctx.api.post('/api/student-portal/login').send({ schoolId: (await sql('SELECT school_id FROM students LIMIT 1'))[0].school_id, password: 'secret-pass-1' })).body.token;
  assert.equal((await ctx.api.get(A + '/activity-logs').set(auth(st))).status, 401, 'a student token is not accepted');
});

test('hostile search text and filters cannot break the query', async () => {
  await activity();
  const total = (await aget('/activity-logs?limit=1')).body.total;
  for (const q of ["' OR '1'='1", "'; DROP TABLE activity_logs; --", '%', '_', '\\', 'a'.repeat(60)]) {
    const r = await aget('/activity-logs?q=' + encodeURIComponent(q)); assert.equal(r.status, 200, q); assert.ok(r.body.total <= total, q);
  }
  assert.equal((await aget('/activity-logs?type=' + encodeURIComponent("auth' OR '1'='1"))).status, 400);
  assert.equal((await aget('/activity-logs?q=' + 'a'.repeat(500))).status, 400);
  assert.equal((await aget('/activity-logs?limit=1')).body.total, total);
});
