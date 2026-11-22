'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload } = require('./helpers');

let ctx; let admin; let driver; let driver2;
before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await reset(ctx.pool);
  admin = await login(ctx.api);
  for (const [u, n] of [['dan', 'Dan Driver'], ['eve', 'Eve Driver']]) {
    await ctx.api.post('/api/admin/drivers').set(auth(admin)).send({ name: n, username: u, email: `${u}@example.com`, password: 'driver-pass-1', unit: `Bus ${u}` });
  }
  driver = (await ctx.api.post('/api/auth/login').send({ username: 'dan', password: 'driver-pass-1' })).body.token;
  driver2 = (await ctx.api.post('/api/auth/login').send({ username: 'eve', password: 'driver-pass-1' })).body.token;
});
after(() => ctx.pool.end());

/** A student who registered themselves. Returns { id, schoolId, st } where st is their auth header. */
async function register(over = {}) {
  const body = { ...studentPayload(), password: 'secret-pass-1', confirm: 'secret-pass-1', ...over };
  const reg = await ctx.api.post('/api/student-portal/register').send(body);
  assert.equal(reg.status, 201);
  const lg = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  return { id: reg.body.student.id, schoolId: body.schoolId, name: body.name, st: auth(lg.body.token) };
}
const approve = (id) => ctx.api.post(`/api/admin/verifications/${id}/approve`).set(auth(admin)).send({});
const genQr = async (s) => (await ctx.api.post('/api/student-portal/me/qr').set(s.st)).body.qr;
const scan = (t, code) => ctx.api.post('/api/scanner/scan').set(auth(t)).send({ code });
const lookup = (t, schoolId) => ctx.api.post('/api/scanner/lookup').set(auth(t)).send({ schoolId });
async function verifiedStudent() { const s = await register(); await approve(s.id); s.qr = await genQr(s); return s; }

test('full workflow: register -> pending -> admin verifies -> QR generated and stored -> driver scans -> logged against the driver', async () => {
  const s = await register();
  const me = await ctx.api.get('/api/student-portal/me').set(s.st);
  assert.equal(me.body.student.verification.status, 'pending');

  const v = await approve(s.id);
  assert.equal(v.status, 200);
  assert.equal(v.body.student.verification.status, 'verified');
  assert.equal(v.body.student.status, 'active');
  assert.ok(v.body.student.verification.by);

  const qr = await genQr(s);
  assert.equal(qr.status, 'active');
  assert.equal(qr.generatedBy.type, 'student');
  const [[row]] = await ctx.pool.query('SELECT * FROM qr_codes WHERE student_id = ?', [s.id]);
  assert.equal(`TP1.${row.qr_token}`, qr.payload);
  assert.equal(row.generated_by_student, s.id);
  assert.ok(row.generated_at && row.expires_at > row.generated_at);
  assert.equal(qr.payload.includes(s.schoolId) || qr.payload.includes(s.name), false, 'the QR holds no personal data');

  const res = await scan(driver, qr.payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'VERIFIED_STUDENT');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.student.name, s.name);
  assert.equal(JSON.stringify(res.body).includes('@example.edu.ph'), false, 'no email shown to drivers');

  const [[sc]] = await ctx.pool.query('SELECT sc.*, a.username FROM scans sc JOIN admins a ON a.id = sc.scanned_by');
  assert.equal(sc.username, 'dan');
  assert.equal(sc.driver_name, 'Dan Driver');
  assert.equal(sc.student_id, s.id);
  assert.equal(sc.qr_code_id, row.id);
  assert.equal(sc.verification_result, 'VERIFIED_STUDENT');
  assert.equal(sc.result, 'granted');
});

test('only verified, approved students can generate a QR; rejected and pending are refused', async () => {
  const pending = await register();
  assert.equal((await ctx.api.post('/api/student-portal/me/qr').set(pending.st)).status, 403);
  const rejected = await register();
  assert.equal((await ctx.api.post(`/api/admin/verifications/${rejected.id}/reject`).set(auth(admin)).send({})).status, 400, 'a reason is required');
  const rj = await ctx.api.post(`/api/admin/verifications/${rejected.id}/reject`).set(auth(admin)).send({ reason: 'Not on the enrollment list' });
  assert.equal(rj.body.student.verification.status, 'rejected');
  assert.equal(rj.body.student.verification.rejectionReason, 'Not on the enrollment list');
  assert.equal((await ctx.api.post('/api/student-portal/me/qr').set(rejected.st)).status, 403);
  // admin cannot issue one for an unverified student either
  assert.equal((await ctx.api.post(`/api/students/${pending.id}/actions/regenerate-qr`).set(auth(admin)).send({})).status, 409);
});

test('no duplicate active QR; regenerate replaces and the old code is REVOKED; revoke blocks scanning', async () => {
  const s = await verifiedStudent();
  assert.equal((await ctx.api.post('/api/student-portal/me/qr').set(s.st)).status, 409);
  const first = s.qr.payload;
  const re = await ctx.api.post('/api/student-portal/me/qr/regenerate').set(s.st);
  assert.equal(re.status, 201);
  assert.notEqual(re.body.qr.payload, first);
  const [[n]] = await ctx.pool.query("SELECT COUNT(*) AS n FROM qr_codes WHERE student_id = ? AND status = 'active'", [s.id]);
  assert.equal(n.n, 1);
  assert.equal((await scan(driver, first)).body.code, 'REVOKED_QR');
  assert.equal((await scan(driver, re.body.qr.payload)).body.code, 'VERIFIED_STUDENT');
  await ctx.api.post('/api/student-portal/me/qr/revoke').set(s.st);
  assert.equal((await scan(driver, re.body.qr.payload)).body.code, 'REVOKED_QR');
});

test('concurrent generate requests still leave exactly one active QR', async () => {
  const s = await register(); await approve(s.id);
  const rs = await Promise.all([1, 2, 3, 4].map(() => ctx.api.post('/api/student-portal/me/qr').set(s.st)));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal((await ctx.pool.query("SELECT COUNT(*) AS n FROM qr_codes WHERE student_id = ? AND status = 'active'", [s.id]))[0][0].n, 1);
});

test('all six results come from the database, never from how the QR looks', async () => {
  // INVALID: garbage, right shape but unknown token, and a School ID that was the old QR format
  assert.equal((await scan(driver, 'hello')).body.code, 'INVALID_QR');
  assert.equal((await scan(driver, `TP1.${'A'.repeat(32)}`)).body.code, 'INVALID_QR');
  const ok = await verifiedStudent();
  assert.equal((await scan(driver, `${ok.schoolId}::v1`)).body.code, 'INVALID_QR');
  assert.equal((await scan(driver, ok.schoolId)).body.code, 'INVALID_QR');

  // PENDING: verified student later sent back to pending (reject -> reopen)
  const p = await verifiedStudent();
  await ctx.api.post(`/api/admin/verifications/${p.id}/reject`).set(auth(admin)).send({ reason: 'Documents unclear' });
  const rej = await scan(driver, p.qr.payload);
  assert.equal(rej.body.code, 'REJECTED_STUDENT');
  assert.equal(rej.body.student.name, p.name);
  await ctx.api.post(`/api/admin/verifications/${p.id}/reopen`).set(auth(admin));
  assert.equal((await scan(driver, p.qr.payload)).body.code, 'PENDING_VERIFICATION');

  // EXPIRED: time ran out
  const e = await verifiedStudent();
  await ctx.pool.query("UPDATE qr_codes SET expires_at = '2020-01-01 00:00:00' WHERE student_id = ?", [e.id]);
  const ex = await scan(driver, e.qr.payload);
  assert.equal(ex.body.code, 'EXPIRED_QR');
  assert.equal((await ctx.pool.query('SELECT status FROM qr_codes WHERE student_id = ?', [e.id]))[0][0].status, 'expired');
  assert.equal((await ctx.api.post('/api/student-portal/me/qr').set(e.st)).status, 201, 'an expired QR can be replaced by a new one');

  // none of the failed ones granted anything
  const [[g]] = await ctx.pool.query("SELECT COUNT(*) AS n FROM scans WHERE result = 'granted'");
  assert.equal(g.n, 0);
});

test('every attempt is logged, including failures that identify nobody', async () => {
  await scan(driver, 'garbage-value');
  await scan(driver, `TP1.${'B'.repeat(32)}`);
  await lookup(driver, 'NOPE-123');
  const s = await verifiedStudent();
  await scan(driver, s.qr.payload);
  const [rows] = await ctx.pool.query('SELECT verification_result AS c, student_id, scan_method AS m, scanned_by, driver_name FROM scans ORDER BY id');
  assert.deepEqual(rows.map((r) => [r.c, r.m]), [['INVALID_QR', 'qr'], ['INVALID_QR', 'qr'], ['INVALID_QR', 'manual'], ['VERIFIED_STUDENT', 'qr']]);
  assert.equal(rows[0].student_id, null);
  assert.ok(rows.every((r) => r.scanned_by && r.driver_name === 'Dan Driver'));
});

test('manual School ID lookup goes through the same database checks', async () => {
  const s = await verifiedStudent();
  assert.equal((await lookup(driver, s.schoolId)).body.code, 'VERIFIED_STUDENT');
  await ctx.api.post('/api/student-portal/me/qr/revoke').set(s.st);
  assert.equal((await lookup(driver, s.schoolId)).body.code, 'REVOKED_QR');
  const p = await register();
  assert.equal((await lookup(driver, p.schoolId)).body.code, 'PENDING_VERIFICATION');
  assert.equal((await lookup(driver, 'NOPE-1')).body.code, 'INVALID_QR');
  assert.equal((await lookup(driver, '  ')).status, 400);
});

test('driver scan history is private to that driver; admin sees everyone with filters and daily totals', async () => {
  const a = await verifiedStudent(); const b = await verifiedStudent();
  await scan(driver, a.qr.payload); await scan(driver, 'junk');
  await scan(driver2, b.qr.payload);

  const mine = await ctx.api.get('/api/driver/scans').set(auth(driver));
  assert.equal(mine.body.total, 2);
  assert.ok(mine.body.items.every((i) => i.driver === 'Dan Driver'));
  // a driverId in the URL is ignored: still only their own
  assert.equal((await ctx.api.get('/api/driver/scans?driverId=' + (await ctx.pool.query("SELECT id FROM admins WHERE username='eve'"))[0][0].id).set(auth(driver))).body.total, 2);
  const stats = (await ctx.api.get('/api/driver/me').set(auth(driver))).body.stats;
  assert.deepEqual(stats.allTime, { total: 2, verified: 1, rejected: 1, review: 0 });
  assert.deepEqual(stats.today, { total: 2, verified: 1, rejected: 1, review: 0 });

  const all = await ctx.api.get('/api/scans').set(auth(admin));
  assert.equal(all.body.total, 3);
  assert.deepEqual([...new Set(all.body.items.map((i) => i.driver))].sort(), ['Dan Driver', 'Eve Driver']);
  const eveId = (await ctx.pool.query("SELECT id FROM admins WHERE username='eve'"))[0][0].id;
  assert.equal((await ctx.api.get(`/api/scans?driverId=${eveId}`).set(auth(admin))).body.total, 1);
  assert.equal((await ctx.api.get('/api/scans?code=INVALID_QR').set(auth(admin))).body.total, 1);
  assert.equal((await ctx.api.get('/api/scans?result=granted').set(auth(admin))).body.total, 2);
  assert.equal((await ctx.api.get('/api/scans?q=Eve').set(auth(admin))).body.total, 1);
  assert.equal((await ctx.api.get('/api/scans?code=BOGUS').set(auth(admin))).status, 400);

  const daily = (await ctx.api.get('/api/scans/daily?days=3').set(auth(admin))).body.days;
  assert.equal(daily.length, 3);
  assert.deepEqual([daily[0].total, daily[0].verified, daily[0].rejected], [3, 2, 1]);
  const dd = (await ctx.api.get('/api/driver/scans/daily?days=3').set(auth(driver))).body.days;
  assert.equal(dd[0].total, 2);
});

test('admin QR list shows who generated each code and when; tokens are never listed; revoke and reactivate work', async () => {
  const s = await verifiedStudent();
  const regen = await ctx.api.post(`/api/students/${s.id}/actions/regenerate-qr`).set(auth(admin)).send({});
  assert.equal(regen.status, 200);
  const list = await ctx.api.get('/api/admin/qr-codes').set(auth(admin));
  assert.equal(list.body.total, 2);
  const [newest, oldest] = list.body.items;
  assert.equal(oldest.generatedBy.type, 'student');
  assert.equal(oldest.generatedBy.name, s.name);
  assert.equal(oldest.status, 'revoked');
  assert.equal(newest.generatedBy.type, 'admin');
  assert.equal(newest.status, 'active');
  assert.ok(newest.generatedAt && newest.expiresAt);
  assert.equal(JSON.stringify(list.body).includes(s.qr.payload.slice(4)), false);
  assert.equal(list.body.items.some((i) => 'payload' in i), false);

  assert.equal((await ctx.api.post(`/api/admin/qr-codes/${newest.id}/revoke`).set(auth(admin)).send({ reason: 'Lost phone' })).status, 200);
  assert.equal((await ctx.api.get('/api/admin/qr-codes?status=revoked').set(auth(admin))).body.total, 2);
  assert.equal((await ctx.api.post(`/api/admin/qr-codes/${newest.id}/revoke`).set(auth(admin)).send({})).status, 409);
  assert.equal((await ctx.api.post(`/api/admin/qr-codes/${newest.id}/reactivate`).set(auth(admin))).status, 200);
  assert.equal((await ctx.api.post(`/api/admin/qr-codes/${oldest.id}/reactivate`).set(auth(admin))).status, 409, 'only one active code per student');
});

test('verification list shows pending/verified/rejected counts; approving twice is refused; rejecting revokes the live QR', async () => {
  const a = await register(); const b = await verifiedStudent();
  const list = await ctx.api.get('/api/admin/verifications?status=pending').set(auth(admin));
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].id, a.id);
  assert.deepEqual(list.body.counts, { pending: 1, verified: 1, rejected: 0 });
  assert.equal((await approve(b.id)).status, 409);
  await ctx.api.post(`/api/admin/verifications/${b.id}/reject`).set(auth(admin)).send({ reason: 'Enrollment record not found' });
  assert.equal((await ctx.pool.query("SELECT status FROM qr_codes WHERE student_id = ?", [b.id]))[0][0].status, 'revoked');
  const rc = await ctx.api.get(`/api/admin/verifications/${a.id}/registrar-check`).set(auth(admin));
  assert.equal(rc.body.registrar.available, false);
});

test('students added by a registrar count as verified by that admin; old records keep their history', async () => {
  const res = await ctx.api.post('/api/students').set(auth(admin)).send(studentPayload());
  assert.equal(res.body.student.verification.status, 'verified');
  const [[v]] = await ctx.pool.query('SELECT method, verified_by FROM student_verifications WHERE student_id = ?', [res.body.student.id]);
  assert.equal(v.method, 'admin_issued');
  assert.ok(v.verified_by);
});
