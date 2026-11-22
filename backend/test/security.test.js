'use strict';
// Stage 7: security review. Authentication, session revocation, authorization on every administrator API, QR token handling,
// injection resistance, error handling.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { setup, reset, login, auth, studentPayload, config } = require('./helpers');

let ctx, admin, dan, danId;
const A = '/api/admin';
const PW = config.seedAdmin.password;
const aget = (p, t = admin) => ctx.api.get(A + p).set(auth(t));
const apost = (p, b, t = admin) => ctx.api.post(A + p).set(auth(t)).send(b || {});
const sql = async (q, a) => (await ctx.pool.query(q, a))[0];

before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await reset(ctx.pool);
  admin = await login(ctx.api);
  const r = await apost('/drivers', { name: 'Dan', username: 'dan', email: 'dan@example.com', password: 'driver-pass-1' });
  danId = r.body.driver.id;
  dan = (await ctx.api.post('/api/auth/login').send({ username: 'dan', password: 'driver-pass-1' })).body.token;
});
after(() => ctx.pool.end());

async function student() {
  const body = { ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1' };
  const reg = await ctx.api.post('/api/student-portal/register').send(body);
  const lg = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  await apost(`/verifications/${reg.body.student.id}/approve`);
  const qr = await ctx.api.post('/api/student-portal/me/qr').set(auth(lg.body.token));
  return { id: reg.body.student.id, schoolId: body.schoolId, token: lg.body.token, qr: qr.body };
}

test('forged, tampered, expired and mismatched tokens are all rejected', async () => {
  const adminId = (await sql("SELECT id, token_version FROM admins WHERE role = 'admin'"))[0];
  const secret = config.jwt.secret;
  const bad = {
    'alg none': jwt.sign({ sub: adminId.id, role: 'admin', tv: adminId.token_version }, '', { algorithm: 'none' }),
    'wrong secret': jwt.sign({ sub: adminId.id, role: 'admin', tv: adminId.token_version }, 'not-the-secret', { algorithm: 'HS256' }),
    'expired': jwt.sign({ sub: adminId.id, role: 'admin', tv: adminId.token_version }, secret, { algorithm: 'HS256', expiresIn: -10 }),
    'unknown account': jwt.sign({ sub: 999999, role: 'admin', tv: 0 }, secret, { algorithm: 'HS256', expiresIn: 60 }),
    'driver claiming admin role': jwt.sign({ sub: danId, role: 'admin', tv: 0 }, secret, { algorithm: 'HS256', expiresIn: 60 }),
    'old token version': jwt.sign({ sub: adminId.id, role: 'admin', tv: adminId.token_version + 5 }, secret, { algorithm: 'HS256', expiresIn: 60 }),
    'student role on a staff route': jwt.sign({ sub: adminId.id, role: 'student', tv: 0 }, secret, { algorithm: 'HS256', expiresIn: 60 }),
    'garbage': 'abc.def.ghi', 'empty bearer': ' ', 'truncated': admin.slice(0, -5)
  };
  for (const [name, t] of Object.entries(bad)) assert.equal((await aget('/account', t)).status, 401, name);
  assert.equal((await ctx.api.get(A + '/account').set({ Authorization: 'Basic ' + admin })).status, 401, 'only Bearer is accepted');
  assert.equal((await aget('/account')).status, 200, 'the genuine token still works');
});

test('a deactivated driver and a signed-out session lose access immediately', async () => {
  assert.equal((await ctx.api.get('/api/auth/me').set(auth(dan))).status, 200);
  await sql("UPDATE admins SET status = 'inactive' WHERE id = ?", [danId]);
  assert.equal((await ctx.api.get('/api/auth/me').set(auth(dan))).status, 401, 'an unexpired token stops working the moment the account is deactivated');
  const refused = await ctx.api.post('/api/auth/login').send({ username: 'dan', password: 'driver-pass-1' });
  assert.ok([401, 403].includes(refused.status), 'and the driver cannot sign in again: ' + refused.status);
  const second = await login(ctx.api);
  assert.equal((await ctx.api.post('/api/auth/logout').set(auth(second)).send({})).status < 300, true);
  assert.equal((await aget('/account', second)).status, 401, 'after logout the same token is dead on the server');
});

test('sign-in does not reveal whether a username exists and refuses malformed input', async () => {
  const a = await ctx.api.post('/api/auth/login').send({ username: 'nobody-here', password: 'whatever-123' });
  const b = await ctx.api.post('/api/auth/login').send({ username: config.seedAdmin.username, password: 'whatever-123' });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.body.error, b.body.error);
  for (const body of [{}, { username: 'x' }, { username: { $ne: 1 }, password: { $ne: 1 } }, { username: ["a"], password: ["b"] }, { username: "' OR 1=1 --", password: "' OR 1=1 --" }, { username: 'a'.repeat(5000), password: 'b' }]) {
    const r = await ctx.api.post('/api/auth/login').send(body); assert.ok([400, 401].includes(r.status), JSON.stringify(body).slice(0, 40) + ' -> ' + r.status);
  }
});

test('every administrator-only API refuses anonymous callers, drivers and students', async () => {
  const s = await student();
  const getters = ['/students', '/drivers', '/fares', '/transactions', '/refunds', '/routes', '/vehicles', '/devices', '/settings', '/backups', '/suspicious', '/applications', '/announcements',
    '/notifications', '/dashboard/summary', '/dashboard/charts', '/dashboard/activities', '/dashboard/transactions', '/activity-logs', '/activity-logs/summary', '/activity-logs/export.csv',
    '/reports/overview', '/reports/transactions', '/reports/fares/export.csv', '/qr-codes', '/verifications', '/trips', '/driver-documents', '/transactions/export.csv'];
  const seen = [];
  for (const p of getters) {
    const anon = await ctx.api.get(A + p);
    if (anon.status === 404) { seen.push(`${p}: not a route`); continue; }
    assert.equal(anon.status, 401, `anonymous ${p}`);
    assert.equal((await aget(p, dan)).status, 403, `driver ${p}`);
    assert.equal((await aget(p, s.token)).status, 401, `student ${p}`);
    assert.equal((await aget(p)).status < 500, true, `admin ${p}`);
  }
  assert.ok(seen.length < getters.length / 2, 'most paths exist: ' + seen.join('; '));
  for (const [m, p] of [['post', '/drivers'], ['post', '/fares'], ['post', '/refunds'], ['post', '/backups'], ['patch', '/settings'], ['delete', '/account']]) {
    assert.equal((await ctx.api[m](A + p).send({})).status, 401, `anonymous ${m} ${p}`);
    assert.equal((await ctx.api[m](A + p).set(auth(dan)).send({})).status, 403, `driver ${m} ${p}`);
  }
});

test('sensitive values never appear in API responses (password hashes, full QR tokens, reset tokens)', async () => {
  const s = await student();
  const bodies = [];
  for (const p of ['/students', '/drivers', '/qr-codes', '/verifications', '/account', '/activity-logs?limit=100', '/dashboard/activities', '/transactions']) { const r = await aget(p); if (r.status === 200) bodies.push([p, JSON.stringify(r.body)]); }
  bodies.push(['/auth/me', JSON.stringify((await ctx.api.get('/api/auth/me').set(auth(admin))).body)]);
  bodies.push(['/student me', JSON.stringify((await ctx.api.get('/api/student-portal/me').set(auth(s.token))).body)]);
  const [qr] = await sql('SELECT qr_token AS token FROM qr_codes LIMIT 1');
  for (const [p, b] of bodies) {
    assert.ok(!/\$2[aby]\$/.test(b), `${p} leaks a password hash`); assert.ok(!/password_hash|passwordHash|token_version/.test(b), `${p} leaks internals`);
    if (p !== '/student me') assert.ok(!(qr && b.includes(qr.token)), `${p} leaks a full QR token`);
  }
});

test('QR scanning: forged, malformed, hostile and replayed codes are denied cleanly (never a server error)', async () => {
  const s = await student();
  const scan = (body) => ctx.api.post('/api/scanner/scan').set(auth(dan)).send(body);
  const real = await sql('SELECT qr_token AS token FROM qr_codes LIMIT 1');
  const attempts = ['TP1.' + 'A'.repeat(32), 'TP1.' + real[0].token.slice(0, -1) + (real[0].token.endsWith('A') ? 'B' : 'A'), "TP1.' OR '1'='1", 'TP1.' + '\u0000'.repeat(32), 'x'.repeat(20000), '', '   ', 'TP2.' + real[0].token, real[0].token.toLowerCase() === real[0].token ? real[0].token.toUpperCase() : real[0].token.toLowerCase()];
  for (const raw of attempts) {
    const r = await scan({ payload: raw, code: raw, token: raw, qr: raw });
    assert.ok(r.status < 500, `payload ${String(raw).slice(0, 20)} -> ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
    assert.ok(!(r.body.scan && r.body.scan.result === 'granted'), 'a forged code is never granted');
  }
  assert.equal((await scan({ payload: { $gt: '' } })).status < 500, true);
  assert.equal((await ctx.api.post('/api/scanner/scan').send({ payload: 'TP1.' + 'A'.repeat(32) })).status, 401, 'scanning needs a signed-in driver');
  assert.equal((await ctx.api.post('/api/scanner/scan').set(auth(s.token)).send({ payload: 'x' })).status, 401, 'a student token cannot scan');
  const noWords = await sql("SELECT COUNT(*) AS n FROM scans WHERE result = 'granted'"); assert.equal(Number(noWords[0].n), 0);
});

test('the QR token is random, long, unique per student and asking again never creates a second active code', async () => {
  const a = await student(), b = await student();
  const tokens = (await sql('SELECT qr_token AS token FROM qr_codes')).map((r) => r.token);
  assert.equal(new Set(tokens).size, tokens.length); assert.ok(tokens.every((t) => /^[A-Za-z0-9_-]{32}$/.test(t)));
  assert.ok(!tokens.some((t) => t.includes(a.schoolId) || t.includes(String(a.id))), 'no personal data inside the token');
  await ctx.api.post('/api/student-portal/me/qr').set(auth(a.token));
  assert.equal(Number((await sql("SELECT COUNT(*) AS n FROM qr_codes WHERE student_id = ? AND status = 'active'", [a.id]))[0].n), 1, 'one active code per student');
});

test('SQL injection strings in every search / filter parameter are handled as plain text', async () => {
  await student();
  const evil = ["' OR '1'='1", "'; DROP TABLE students; --", '" OR ""="', '%', '\\', "1; SELECT SLEEP(5)", '`', '/*', "\u0027 UNION SELECT password_hash FROM admins --"];
  const paths = ['/students?q=', '/drivers?q=', '/transactions?q=', '/refunds?q=', '/qr-codes?q=', '/routes?q=', '/vehicles?q=', '/fares?q=', '/activity-logs?q=', '/verifications?q=', '/devices?q=', '/suspicious?q=', '/applications?q='];
  const t0 = Date.now();
  for (const p of paths) for (const e of evil) {
    const r = await aget(p + encodeURIComponent(e));
    assert.ok(r.status < 500, `${p}${e} -> ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    assert.ok(!/\$2[aby]\$/.test(JSON.stringify(r.body)), 'no hash returned by a UNION injection');
  }
  assert.ok(Date.now() - t0 < 60000, 'no SLEEP injection took effect');
  assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM students'))[0].n), 1, 'the students table is intact');
  for (const p of ['/students/1%20OR%201=1', "/students/1'", '/drivers/abc', '/transactions/-1', '/refunds/99999999999999999999']) assert.ok([400, 404].includes((await aget(p)).status), p);
});

test('errors are handled: malformed JSON, oversized bodies, unknown routes and duplicates give clean, non-leaking responses', async () => {
  const bad = await ctx.api.post('/api/auth/login').set('Content-Type', 'application/json').send('{"username": "a",');
  assert.equal(bad.status, 400); assert.ok(!/SyntaxError|at .*\.js/.test(JSON.stringify(bad.body)));
  const big = await ctx.api.post('/api/auth/login').send({ username: 'a', password: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(big.status, 413);
  const nf = await ctx.api.get('/api/does-not-exist'); assert.ok([401, 404].includes(nf.status)); assert.deepEqual(Object.keys(nf.body), ['error']);
  const dup = await apost('/drivers', { name: 'Dan 2', username: 'dan', email: 'dan2@example.com', password: 'driver-pass-1' });
  assert.equal(dup.status, 409); assert.ok(!/ER_DUP|sql|INSERT/i.test(JSON.stringify(dup.body)), 'no database message reaches the client');
  const wrongType = await apost('/drivers', { name: { a: 1 }, username: [], email: 5, password: null });
  assert.equal(wrongType.status, 400);
  const h = (await ctx.api.get('/api/auth/me')).headers;
  assert.equal(h['x-content-type-options'], 'nosniff'); assert.ok(h['x-frame-options'] || /frame-ancestors/.test(h['content-security-policy'] || '')); assert.equal(h['x-powered-by'], undefined);
});

test('passwords are stored as bcrypt hashes and never accepted when too short', async () => {
  const rows = await sql('SELECT password_hash FROM admins');
  assert.ok(rows.length >= 2 && rows.every((r) => /^\$2[aby]\$\d\d\$/.test(r.password_hash)));
  assert.equal((await apost('/drivers', { name: 'Short', username: 'short', email: 's@example.com', password: 'abc' })).status, 400);
  const sr = await ctx.api.post('/api/student-portal/register').send({ ...studentPayload(), password: 'abc', confirm: 'abc' }); assert.equal(sr.status, 400);
  const st = await sql('SELECT password_hash FROM students WHERE password_hash IS NOT NULL'); assert.ok(st.every((r) => /^\$2[aby]\$/.test(r.password_hash)));
});

test('sessions end after the configured idle time on the server, and active sessions are renewed', async () => {
  const me = (await sql("SELECT id, token_version FROM admins WHERE role = 'admin'"))[0];
  const now = Math.floor(Date.now() / 1000);
  const mk = (ageSeconds) => jwt.sign({ sub: me.id, role: 'admin', tv: me.token_version, iat: now - ageSeconds }, config.jwt.secret, { algorithm: 'HS256', expiresIn: 8 * 3600 });
  const idle = Number((await require('../src/services/settings').runtime(ctx.pool)).idleMinutes);
  const fresh = await aget('/account', admin); assert.equal(fresh.status, 200); assert.equal(fresh.headers['x-refresh-token'], undefined, 'a brand-new token is not renewed yet');
  const active = await aget('/account', mk(5 * 60)); assert.equal(active.status, 200);
  assert.ok(active.headers['x-refresh-token'], 'a token older than a minute is renewed while it is used');
  assert.equal((await aget('/account', active.headers['x-refresh-token'])).status, 200, 'the renewed token works');
  assert.equal((await aget('/account', mk((idle - 1) * 60))).status, 200, 'just inside the idle limit');
  const dead = await aget('/account', mk((idle + 1) * 60)); assert.equal(dead.status, 401); assert.match(dead.body.error, /inactiv/i);
  assert.equal((await aget('/activity-logs', mk((idle + 1) * 60))).status, 401, 'on every protected route');
});
