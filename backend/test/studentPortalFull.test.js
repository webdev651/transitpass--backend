'use strict';
// The student web portal: sign-up with files, login by email, password reset, dashboard, QR rules, transactions,
// requests, notifications and settings. Every test also checks that a student only reaches their own records.
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-uploads-'));
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload, config } = require('./helpers');

let ctx;
before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await reset(ctx.pool);
  for (const f of fs.readdirSync(process.env.UPLOAD_DIR)) fs.rmSync(path.join(process.env.UPLOAD_DIR, f), { recursive: true, force: true });
});
after(async () => { await ctx.pool.end(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const FAKE = Buffer.from('this is not an image, just text pretending to be one');

const signUp = (over = {}) => ({ ...studentPayload(), campus: 'Main Campus', section: 'A', password: 'secret-pass-1', confirm: 'secret-pass-1', ...over });

/** The sign-up page's request: form fields + photo + two documents. */
function multipart(body, { photo = PNG, id = PDF, enr = PNG } = {}) {
  let req = ctx.api.post('/api/student-portal/register');
  for (const [k, v] of Object.entries(body)) req = req.field(k, v);
  if (photo) req = req.attach('photo', photo, { filename: 'me.png' });
  if (id) req = req.attach('idDocument', id, { filename: 'id.pdf' });
  if (enr) req = req.attach('enrollmentDocument', enr, { filename: 'cor.png' });
  return req;
}

async function registered(over = {}) {
  const body = signUp(over);
  const reg = await multipart(body);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  return { body, id: reg.body.student.id };
}
async function approved(over = {}) {
  const { body, id } = await registered(over);
  const admin = await login(ctx.api);
  await ctx.api.post(`/api/students/${id}/actions/approve`).set(auth(admin)).send({});
  const res = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  return { body, id, admin, token: res.body.token, t: auth(res.body.token) };
}
const get = (t, p) => ctx.api.get(`/api/student-portal${p}`).set(t);
const post = (t, p, b) => ctx.api.post(`/api/student-portal${p}`).set(t).send(b || {});

/** Student generates a QR, an administrator scans it. */
async function rideOnce(s) {
  const q = await post(s.t, '/me/qr');
  const scan = await ctx.api.post('/api/scanner/scan').set(auth(s.admin)).send({ code: q.body.qr.payload });
  assert.equal(scan.body.code, 'VERIFIED_STUDENT');
  return scan.body.scan;
}

/* ------------------------------------------------------------------ registration */

test('multipart sign-up saves photo and documents, starts pending, and never leaks file paths or the password', async () => {
  const { body, id } = await registered();
  const [[row]] = await ctx.pool.query('SELECT * FROM students WHERE id = ?', [id]);
  assert.equal(row.campus, 'Main Campus');
  assert.equal(row.section, 'A');
  assert.match(row.profile_photo, /^data:image\/png;base64,/);
  for (const col of ['id_document', 'enrollment_document']) {
    assert.match(row[col], /^students\/STD-/);
    assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, row[col])), `${col} was written to disk`);
  }
  const login = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  const profile = await get(auth(login.body.token), '/me/profile');
  assert.equal(profile.body.student.registration.status, 'pending');
  assert.deepEqual(profile.body.student.documents, { idDocument: true, enrollmentDocument: true });
  const text = JSON.stringify(profile.body) + JSON.stringify(login.body);
  assert.equal(/students\/STD|password_hash|secret-pass/.test(text), false);
});

test('sign-up refuses a fake image, a wrong document type and missing campus/section (files are optional, but must be real)', async () => {
  const fakePhoto = await multipart(signUp(), { photo: FAKE });
  assert.equal(fakePhoto.status, 400);
  const fakeDoc = await multipart(signUp(), { enr: FAKE });
  assert.equal(fakeDoc.status, 400);
  const noCampus = await multipart(signUp({ campus: '' }));
  assert.equal(noCampus.status, 400);
  const [[{ n }]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM students');
  assert.equal(n, 0, 'nothing is saved when any check fails');
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR), [], 'no stray files either');
});

test('photo and documents are optional at sign-up', async () => {
  const body = signUp();
  const none = await multipart(body, { photo: null, id: null, enr: null });
  assert.equal(none.status, 201, JSON.stringify(none.body));
  const some = await multipart(signUp({ schoolId: '2026-7777', email: 'one@example.com' }), { photo: null, id: PDF, enr: null });
  assert.equal(some.status, 201);
  const t = auth((await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password })).body.token);
  assert.deepEqual((await get(t, '/me/profile')).body.student.documents, { idDocument: false, enrollmentDocument: false });
  assert.equal((await ctx.api.get('/api/student-portal/me/documents/id').set(t)).status, 404);
});

test('sign-up refuses a duplicate Student ID or email, and a client cannot choose its own status', async () => {
  const first = signUp();
  assert.equal((await multipart(first)).status, 201);
  assert.equal((await multipart(signUp({ schoolId: first.schoolId }))).status, 409);
  assert.equal((await multipart(signUp({ email: first.email.toUpperCase() }))).status, 409);
  const sneaky = await multipart(signUp({ status: 'active', validUntil: '31 Dec 2099' }));
  assert.equal(sneaky.body.student.status, 'pending');
});

/* ------------------------------------------------------------------ login + reset */

test('a student can sign in with the Student ID or the email, and wrong credentials all look the same', async () => {
  const { body } = await registered();
  const byId = await ctx.api.post('/api/student-portal/login').send({ identifier: body.schoolId, password: body.password });
  const byEmail = await ctx.api.post('/api/student-portal/login').send({ identifier: body.email.toUpperCase(), password: body.password });
  assert.equal(byId.status, 200);
  assert.equal(byEmail.status, 200);
  const wrong = await ctx.api.post('/api/student-portal/login').send({ identifier: body.email, password: 'nope-nope-1' });
  const ghost = await ctx.api.post('/api/student-portal/login').send({ identifier: 'ghost@example.com', password: 'nope-nope-1' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, ghost.body.error);
});

test('forgot password: same answer for unknown accounts; the link works once, then old sessions end', async () => {
  const { body } = await registered();
  const old = await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password });
  const unknown = await ctx.api.post('/api/student-portal/forgot-password').send({ identifier: 'nobody@example.com' });
  const known = await ctx.api.post('/api/student-portal/forgot-password').send({ identifier: body.email });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.message, known.body.message);
  assert.equal(known.body.devResetPath, undefined, 'the link is only in the email unless SHOW_RESET_LINK is on in development');

  const [[mail]] = await ctx.pool.query("SELECT body FROM email_log WHERE subject = 'Reset your TransitPass password'");
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.body)[1];
  const [[stored]] = await ctx.pool.query('SELECT token_hash FROM password_resets');
  assert.notEqual(stored.token_hash, token, 'only a hash of the token is stored');

  const short = await ctx.api.post('/api/student-portal/reset-password').send({ token, password: 'abc', confirm: 'abc' });
  assert.equal(short.status, 400);
  const ok = await ctx.api.post('/api/student-portal/reset-password').send({ token, password: 'brand-new-pass-2', confirm: 'brand-new-pass-2' });
  assert.equal(ok.status, 200);
  assert.equal((await ctx.api.post('/api/student-portal/reset-password').send({ token, password: 'another-pass-3', confirm: 'another-pass-3' })).status, 400, 'a link cannot be used twice');
  assert.equal((await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password })).status, 401);
  assert.equal((await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: 'brand-new-pass-2' })).status, 200);
  assert.equal((await get(auth(old.body.token), '/me')).status, 401, 'the session from before the reset is dead');
});

test('an expired reset link and a made-up one are refused', async () => {
  const { body } = await registered();
  await ctx.api.post('/api/student-portal/forgot-password').send({ identifier: body.schoolId });
  const [[mail]] = await ctx.pool.query("SELECT body FROM email_log WHERE subject = 'Reset your TransitPass password'");
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.body)[1];
  await ctx.pool.query('UPDATE password_resets SET expires_at = ?', [new Date(Date.now() - 1000)]);
  const pw = { password: 'brand-new-pass-2', confirm: 'brand-new-pass-2' };
  assert.equal((await ctx.api.post('/api/student-portal/reset-password').send({ token, ...pw })).status, 400);
  assert.equal((await ctx.api.post('/api/student-portal/reset-password').send({ token: 'x'.repeat(43), ...pw })).status, 400);
});

/* ------------------------------------------------------------------ dashboard + eligibility */

test('dashboard for a pending student: pending status, no QR, no discount, zero totals', async () => {
  const { body } = await registered();
  const t = auth((await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password })).body.token);
  const d = (await get(t, '/me/dashboard')).body;
  assert.equal(d.student.registration.status, 'pending');
  assert.equal(d.eligibility.status, 'pending');
  assert.equal(d.eligibility.percent, 0);
  assert.equal(d.qr.status, 'none');
  assert.deepEqual(d.totals, { transactions: 0, totalDiscount: 0, totalPaid: 0 });
  assert.equal(d.unreadNotifications, 1); // "we received your registration"
});

test('dashboard after approval: eligible 20%, QR status, totals and recent rides come from real scans', async () => {
  const s = await approved();
  await rideOnce(s);
  const d = (await get(s.t, '/me/dashboard')).body;
  assert.equal(d.student.registration.status, 'approved');
  assert.equal(d.eligibility.status, 'eligible');
  assert.equal(d.eligibility.percent, 20);
  assert.equal(d.eligibility.validUntil, '31 Mar 2027');
  assert.equal(d.qr.status, 'active');
  assert.equal(d.totals.transactions, 1);
  assert.equal(d.totals.totalDiscount, 3.25);
  assert.equal(d.totals.totalPaid, 13);
  assert.equal(d.recentTransactions.length, 1);
  assert.ok(d.unreadNotifications >= 1);
});

test('discount status follows the administrator: not eligible, suspended and expired show up, and a student cannot change any of it', async () => {
  const s = await approved();
  const act = (a, b) => ctx.api.post(`/api/students/${s.id}/actions/${a}`).set(auth(s.admin)).send(b || {});
  const status = async () => (await get(s.t, '/me/eligibility')).body.eligibility;
  assert.equal((await status()).status, 'eligible');
  await act('mark-ineligible');
  assert.equal((await status()).status, 'not_eligible');
  assert.equal((await status()).percent, 0);
  await act('mark-eligible');
  await act('flag');
  assert.equal((await status()).status, 'suspended');
  await act('reinstate');
  await act('set-validity', { validUntil: '01 Jan 2020' });
  assert.equal((await status()).status, 'expired');

  // nothing a student can send changes any of this
  await ctx.api.patch('/api/student-portal/me/profile').set(s.t).send({ phone: '0917 111 2222', status: 'active', discountEligible: true, validUntil: '31 Dec 2099' });
  const [[row]] = await ctx.pool.query('SELECT status, valid_until FROM students WHERE id = ?', [s.id]);
  assert.equal(row.valid_until, '01 Jan 2020');
  for (const p of ['/api/students', `/api/students/${s.id}/actions/mark-eligible`, '/api/admin/verifications']) {
    const r = p.includes('actions') ? await ctx.api.post(p).set(s.t) : await ctx.api.get(p).set(s.t);
    assert.equal(r.status, 401, `${p} is closed to students`);
  }
});

test('an expiry reminder is written once, then not repeated', async () => {
  const s = await approved();
  await ctx.api.post(`/api/students/${s.id}/actions/set-validity`).set(auth(s.admin)).send({ validUntil: '01 Jan 2020' });
  await get(s.t, '/me/dashboard');
  await get(s.t, '/me/dashboard');
  const [rows] = await ctx.pool.query("SELECT * FROM email_log WHERE student_id = ? AND subject = 'Your student discount has expired'", [s.id]);
  assert.equal(rows.length, 1);
});

test('renewal can be requested only when allowed, once at a time', async () => {
  const s = await approved();
  const renew = () => post(s.t, '/me/requests', { type: 'renewal', reason: 'Enrolled again next term' });
  assert.equal((await renew()).status, 409, 'not yet near expiry');
  await ctx.api.post(`/api/students/${s.id}/actions/set-validity`).set(auth(s.admin)).send({ validUntil: '01 Jan 2020' });
  const first = await renew();
  assert.equal(first.status, 201);
  assert.equal(first.body.request.status, 'pending');
  assert.equal((await renew()).status, 409, 'one pending request at a time');
  const e = (await get(s.t, '/me/eligibility')).body;
  assert.equal(e.renewal.canRequest, false);
  assert.equal(e.requests.length, 1);
  const cancelled = await post(s.t, `/me/requests/${first.body.request.id}/cancel`);
  assert.equal(cancelled.body.request.status, 'cancelled');
  assert.equal((await get(s.t, '/me/eligibility')).body.renewal.canRequest, true);
});

/* ------------------------------------------------------------------ profile */

test('profile: contact number and photo can be changed; enrollment details change only through a correction request', async () => {
  const s = await approved();
  const upd = await ctx.api.patch('/api/student-portal/me/profile').set(s.t).send({ phone: '0917 555 1234' });
  assert.equal(upd.body.student.phone, '0917 555 1234');
  assert.equal((await ctx.api.patch('/api/student-portal/me/profile').set(s.t).send({ phone: 'abc' })).status, 400);

  const photo = await ctx.api.post('/api/student-portal/me/photo').set(s.t).attach('photo', PNG, { filename: 'new.png' });
  assert.equal(photo.status, 200);
  assert.match(photo.body.student.profilePhoto, /^data:image\/png/);
  assert.equal((await ctx.api.post('/api/student-portal/me/photo').set(s.t).attach('photo', FAKE, { filename: 'x.png' })).status, 400);

  const before = (await get(s.t, '/me/profile')).body.student;
  const reqBody = { type: 'correction', field: 'section', value: 'B', reason: 'I was moved to section B' };
  const made = await post(s.t, '/me/requests', reqBody);
  assert.equal(made.status, 201);
  assert.equal(made.body.request.currentValue, 'A');
  assert.equal((await get(s.t, '/me/profile')).body.student.section, before.section, 'nothing changed until an admin decides');
  assert.equal((await post(s.t, '/me/requests', reqBody)).status, 409, 'duplicate pending correction');
  assert.equal((await post(s.t, '/me/requests', { ...reqBody, field: 'section', value: 'A' })).status, 400, 'same as current value');
  assert.equal((await post(s.t, '/me/requests', { type: 'correction', field: 'status', value: 'x', reason: 'hacking it' })).status, 400, 'only known fields');
  const [[row]] = await ctx.pool.query('SELECT section FROM students WHERE id = ?', [s.id]);
  assert.equal(row.section, 'A');
});

test('documents: the owner can open them, nobody else can; approved students cannot swap them', async () => {
  const pending = await registered();
  const t = auth((await ctx.api.post('/api/student-portal/login').send({ schoolId: pending.body.schoolId, password: pending.body.password })).body.token);
  const doc = await ctx.api.get('/api/student-portal/me/documents/id').set(t);
  assert.equal(doc.status, 200);
  assert.equal(doc.headers['content-type'].startsWith('application/pdf'), true);
  assert.equal(doc.headers['x-content-type-options'], 'nosniff');
  assert.equal((await ctx.api.get('/api/student-portal/me/documents/id')).status, 401);
  assert.equal((await ctx.api.get('/api/student-portal/me/documents/passwd').set(t)).status, 404);
  const swap = await ctx.api.post('/api/student-portal/me/documents').set(t).attach('enrollmentDocument', PDF, { filename: 'new.pdf' });
  assert.equal(swap.status, 200);

  const s = await approved();
  const locked = await ctx.api.post('/api/student-portal/me/documents').set(s.t).attach('idDocument', PDF, { filename: 'n.pdf' });
  assert.equal(locked.status, 409);
});

/* ------------------------------------------------------------------ QR code */

test('QR: generate, replace, report lost; every change is real and the token holds no personal data', async () => {
  const s = await approved();
  const made = await post(s.t, '/me/qr');
  assert.equal(made.status, 201);
  const first = made.body.qr.payload;
  assert.match(first, /^TP1\.[A-Za-z0-9_-]{32}$/);
  assert.equal(first.includes(s.body.schoolId) || first.includes(s.body.name), false);
  assert.equal((await post(s.t, '/me/qr')).status, 409, 'only one active code');

  const replaced = await post(s.t, '/me/qr/regenerate');
  assert.notEqual(replaced.body.qr.payload, first);
  const old = await ctx.api.post('/api/scanner/scan').set(auth(s.admin)).send({ code: first });
  assert.equal(old.body.code, 'REVOKED_QR');

  const lost = await post(s.t, '/me/qr/lost', { note: 'Dropped my phone' });
  assert.equal(lost.status, 200);
  assert.equal(lost.body.qr, null);
  const scan = await ctx.api.post('/api/scanner/scan').set(auth(s.admin)).send({ code: replaced.body.qr.payload });
  assert.equal(scan.body.code, 'REVOKED_QR');
  assert.equal((await post(s.t, '/me/qr/lost')).status, 409, 'nothing left to report');
  const [[rep]] = await ctx.pool.query("SELECT status FROM student_requests WHERE type = 'qr_lost'");
  assert.equal(rep.status, 'resolved');
  assert.equal((await post(s.t, '/me/qr')).status, 201, 'after reporting a loss the student may make a new one');
});

test('QR: a code an administrator deactivated cannot be replaced by the student; they send a request instead', async () => {
  const s = await approved();
  await post(s.t, '/me/qr');
  await ctx.api.post(`/api/students/${s.id}/actions/deactivate-qr`).set(auth(s.admin)).send({ reason: 'Suspected sharing' });
  const state = (await get(s.t, '/me/qr')).body;
  assert.equal(state.qr, null);
  assert.equal(state.canGenerate, false);
  assert.equal(state.blockedByAdmin, true);
  assert.equal((await post(s.t, '/me/qr')).status, 403);
  assert.equal((await post(s.t, '/me/qr/regenerate')).status, 403);
  const rq = await post(s.t, '/me/requests', { type: 'qr_replacement', reason: 'Please issue me a new one' });
  assert.equal(rq.status, 201);
  assert.equal((await post(s.t, '/me/requests', { type: 'qr_replacement', reason: 'Please issue me a new one' })).status, 409);
  assert.equal((await get(s.t, '/me/qr')).body.replacementRequestPending, true);
  const n = (await ctx.pool.query('SELECT COUNT(*) AS n FROM qr_codes WHERE status = "active"'))[0][0].n;
  assert.equal(n, 0);
});

/* ------------------------------------------------------------------ transactions */

test('transactions: reference, driver, fares and discount are correct, with search, date filter and totals', async () => {
  const s = await approved();
  await rideOnce(s);
  await ctx.pool.query("UPDATE scans SET route = 'Bus 118 · Unit 4', driver_name = 'Pedro Driver'");
  await ctx.pool.query("INSERT INTO scans (student_id, student_name, school_id, route, operator, fare, fare_amount, discount_amount, result, driver_name, scanned_at) VALUES (?, 'x', 'x', 'Old route', 'op', 'Full fare', 16.25, 0, 'review', 'Ana Driver', '2026-01-15 02:00:00')", [s.id]);
  await ctx.pool.query("INSERT INTO scans (student_id, student_name, school_id, route, operator, fare, fare_amount, discount_amount, result, scanned_at) VALUES (?, 'x', 'x', 'Denied ride', 'op', 'Full fare', 16.25, 0, 'denied', '2026-01-16 02:00:00')", [s.id]);

  const all = (await get(s.t, '/me/transactions')).body;
  assert.equal(all.total, 2, 'a denied scan is not a ride');
  const ride = all.items.find((i) => i.driver === 'Pedro Driver');
  assert.match(ride.reference, /^TXN-\d{8}$/);
  assert.equal(ride.service, 'Bus 118 · Unit 4');
  assert.equal(ride.regularFare, 16.25);
  assert.equal(ride.discountPercent, 20);
  assert.equal(ride.discountAmount, 3.25);
  assert.equal(ride.finalFare, 13);
  assert.equal(all.summary.totalDiscount, 3.25);
  assert.equal(all.summary.totalPaid, 29.25);

  assert.equal((await get(s.t, '/me/transactions?q=Pedro')).body.total, 1);
  assert.equal((await get(s.t, `/me/transactions?q=${ride.reference}`)).body.total, 1);
  assert.equal((await get(s.t, '/me/transactions?q=nobody')).body.total, 0);
  const jan = (await get(s.t, '/me/transactions?from=2026-01-15&to=2026-01-15')).body;
  assert.equal(jan.total, 1);
  assert.equal(jan.items[0].service, 'Old route');
  assert.equal(jan.summary.totalDiscount, 0);
  assert.equal((await get(s.t, '/me/transactions?from=15-01-2026')).status, 400);

  const one = await get(s.t, `/me/transactions/${ride.id}`);
  assert.equal(one.body.transaction.reference, ride.reference);
});

test('transactions: cancelled and refunded rides are categorized apart from completed ones, and the totals match', async () => {
  const s = await approved();
  const ride = await rideOnce(s);
  const admin = s.admin;
  const PW = config.seedAdmin.password;
  const apost = (p, b) => ctx.api.post('/api/admin' + p).set(auth(admin)).send(b || {});
  // a second granted ride inserted directly (a second rideOnce would hit the one-active-QR rule)
  await ctx.pool.query("INSERT INTO scans (student_id, student_name, school_id, route, operator, fare, fare_amount, discount_amount, result, driver_name, scanned_at) VALUES (?, 'x', 'x', 'Second ride', 'op', 'Full fare', 13, 3.25, 'granted', 'Ana Driver', NOW())", [s.id]);
  const [[other]] = await ctx.pool.query("SELECT id FROM scans WHERE student_id = ? AND route = 'Second ride' ORDER BY id DESC LIMIT 1", [s.id]);
  // cancel one ride, refund the other
  await apost(`/refunds/transactions/${ride.id}/cancel`, { reason: 'Wrong student scanned', password: PW });
  const made = await ctx.api.post('/api/student-portal/me/refunds').set(s.t).send({ scanId: other.id, reason: 'Charged twice on the bus' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const dec = await apost(`/refunds/${made.body.refund.id}/decision`, { decision: 'approved', password: PW });
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
  const all = (await get(s.t, '/me/transactions')).body;
  assert.equal(all.total, 2);
  const byId = Object.fromEntries(all.items.map((t) => [t.id, t]));
  assert.equal(byId[ride.id].status, 'cancelled');
  assert.equal(byId[other.id].status, 'refunded');
  assert.equal(byId[ride.id].cancelReason, 'Wrong student scanned');
  assert.equal(byId[other.id].refundAmount, 13);
  const st = all.summary.byStatus;
  assert.deepEqual(st.completed, { count: 0, revenue: 0, discount: 0, regular: 0 });
  assert.equal(st.cancelled.count, 1);
  assert.equal(st.refunded.count, 1);
  assert.equal(st.pending.count, 0);
});

test('transactions: an under-review ride shows as pending and the status filter works', async () => {
  const s = await approved();
  const ride = await rideOnce(s);
  await ctx.pool.query("INSERT INTO scans (student_id, student_name, school_id, route, operator, fare, fare_amount, discount_amount, result, driver_name, scanned_at) VALUES (?, 'x', 'x', 'Review ride', 'op', 'Full fare', 16.25, 0, 'review', 'Ana Driver', NOW())", [s.id]);
  const all = (await get(s.t, '/me/transactions')).body;
  assert.equal(all.total, 2);
  const pending = (await get(s.t, '/me/transactions?status=pending')).body;
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].status, 'pending');
  assert.equal(pending.items[0].statusLabel, 'Pending');
  const completed = (await get(s.t, '/me/transactions?status=completed')).body;
  assert.equal(completed.total, 1);
  assert.equal(completed.items[0].status, 'completed');
  const cancelled = (await get(s.t, '/me/transactions?status=cancelled')).body;
  assert.equal(cancelled.total, 0);
});

test('transaction detail shows cancellation and refund information', async () => {
  const s = await approved();
  const ride = await rideOnce(s);
  const admin = s.admin;
  const PW = config.seedAdmin.password;
  const apost = (p, b) => ctx.api.post('/api/admin' + p).set(auth(admin)).send(b || {});
  await apost(`/refunds/transactions/${ride.id}/cancel`, { reason: 'Scanner error', password: PW });
  const d = await get(s.t, `/me/transactions/${ride.id}`);
  assert.equal(d.status, 200);
  const t = d.body.transaction;
  assert.equal(t.status, 'cancelled');
  assert.equal(t.cancelReason, 'Scanner error');
  assert.equal(t.refundAmount, null);
});

test('a student can open a printable receipt for their own transaction', async () => {
  const s = await approved();
  const ride = await rideOnce(s);
  const r = await get(s.t, `/me/transactions/${ride.id}/receipt`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rc = r.body.receipt;
  assert.ok(rc);
  assert.equal(rc.reference, `TXN-${String(ride.id).padStart(8, '0')}`);
  assert.equal(rc.student.name, s.body.name);
  assert.equal(rc.student.schoolId, s.body.schoolId);
  assert.ok(rc.scannedAt && rc.date && rc.time);
  assert.deepEqual([rc.regularFare, rc.discountPercent, rc.discountAmount, rc.finalFare], [16.25, 20, 3.25, 13]);
  assert.ok(['completed', 'cancelled', 'refunded', 'pending'].includes(rc.status));
  assert.equal(rc.underReview, false);
});

test("a student cannot open another student's receipt", async () => {
  const a = await approved();
  const b = await approved();
  const scanA = await rideOnce(a);
  assert.equal((await get(b.t, `/me/transactions/${scanA.id}/receipt`)).status, 404, "someone else's receipt is not found");
  assert.equal((await get(b.t, '/me/transactions/999999/receipt')).status, 404);
});

test('a student sees only their own transactions, notifications, requests and documents', async () => {
  const a = await approved();
  const b = await approved();
  const scanA = await rideOnce(a);
  assert.equal((await get(b.t, `/me/transactions/${scanA.id}`)).status, 404, "someone else's transaction id is simply not found");
  assert.equal((await get(b.t, '/me/transactions')).body.total, 0);
  assert.equal((await get(a.t, '/me/transactions')).body.total, 1);
  assert.equal((await get(b.t, '/me/dashboard')).body.totals.transactions, 0);

  const mailA = (await get(a.t, '/me/notifications')).body.items[0];
  assert.equal((await post(b.t, `/me/notifications/${mailA.id}/read`)).status, 404);
  const reqA = await post(a.t, '/me/requests', { type: 'correction', field: 'school', value: 'Another School', reason: 'Wrong school name' });
  assert.equal((await post(b.t, `/me/requests/${reqA.body.request.id}/cancel`)).status, 404);
  assert.equal((await get(b.t, '/me/requests')).body.items.length, 0);
});

/* ------------------------------------------------------------------ notifications */

test('notifications: admin actions arrive unread, can be marked read one by one or all, and announcements work too', async () => {
  const s = await approved();
  const list = (await get(s.t, '/me/notifications')).body;
  assert.ok(list.items.some((i) => i.title === 'Your TransitPass has been approved' && i.category === 'registration'));
  const unreadBefore = list.unread;
  assert.ok(unreadBefore >= 2);

  const one = list.items.find((i) => !i.read);
  const after = await post(s.t, `/me/notifications/${one.id}/read`);
  assert.equal(after.body.unread, unreadBefore - 1);
  assert.equal((await get(s.t, '/me/notifications?filter=unread')).body.items.some((i) => i.id === one.id), false);

  await ctx.pool.query("INSERT INTO announcements (title, body) VALUES ('Service change', 'Route 4 starts at 6am.')");
  const withAnn = (await get(s.t, '/me/notifications')).body;
  const ann = withAnn.items.find((i) => i.kind === 'announcement');
  assert.equal(ann.read, false);
  assert.equal(ann.category, 'announcement');
  assert.equal(withAnn.unread, unreadBefore);
  await post(s.t, `/me/notifications/${ann.id}/read`);
  assert.equal((await get(s.t, '/me/notifications')).body.items.find((i) => i.id === ann.id).read, true);

  assert.equal((await post(s.t, '/me/notifications/read-all')).body.unread, 0);
  assert.equal((await get(s.t, '/me/dashboard')).body.unreadNotifications, 0);
  assert.equal((await post(s.t, '/me/notifications/zzz/read')).status, 404);
});

/* ------------------------------------------------------------------ settings */

test('settings: changing the password checks the old one and signs out other devices', async () => {
  const s = await approved();
  const bad = await post(s.t, '/me/password', { current: 'wrong-pass-1', new: 'a-new-password-1', confirm: 'a-new-password-1' });
  assert.equal(bad.status, 400);
  assert.equal((await post(s.t, '/me/password', { current: s.body.password, new: 'short', confirm: 'short' })).status, 400);
  assert.equal((await post(s.t, '/me/password', { current: s.body.password, new: 'a-new-password-1', confirm: 'different-1' })).status, 400);
  const ok = await post(s.t, '/me/password', { current: s.body.password, new: 'a-new-password-1', confirm: 'a-new-password-1' });
  assert.equal(ok.status, 200);
  assert.equal((await get(s.t, '/me')).status, 401, 'the old token is dead');
  assert.equal((await get(auth(ok.body.token), '/me')).status, 200, 'the fresh token works');
  assert.equal((await ctx.api.post('/api/student-portal/login').send({ schoolId: s.body.schoolId, password: 'a-new-password-1' })).status, 200);
  const [[row]] = await ctx.pool.query('SELECT password_hash FROM students WHERE id = ?', [s.id]);
  assert.match(row.password_hash, /^\$2[aby]\$/);
});

test('settings: changing the email needs the password, stays unique, and "sign out everywhere" works', async () => {
  const s = await approved();
  const other = await approved();
  assert.equal((await post(s.t, '/me/email', { email: 'new@example.com', password: 'wrong-pass-1' })).status, 400);
  assert.equal((await post(s.t, '/me/email', { email: other.body.email, password: s.body.password })).status, 409);
  const ok = await post(s.t, '/me/email', { email: 'New.Address@Example.com', password: s.body.password });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.student.email, 'new.address@example.com');
  assert.equal((await ctx.api.post('/api/student-portal/login').send({ identifier: 'new.address@example.com', password: s.body.password })).status, 200);

  const out = await post(s.t, '/me/sessions/revoke-all');
  assert.equal(out.status, 200);
  assert.equal((await get(s.t, '/me')).status, 401);
  assert.equal((await get(auth(out.body.token), '/me')).status, 200);
});

test('every student route needs a student token; a driver or admin token is refused', async () => {
  const s = await approved();
  const paths = ['/me/dashboard', '/me/profile', '/me/eligibility', '/me/transactions', '/me/notifications', '/me/requests', '/me/qr'];
  for (const p of paths) {
    assert.equal((await ctx.api.get(`/api/student-portal${p}`)).status, 401, `${p} without a token`);
    assert.equal((await ctx.api.get(`/api/student-portal${p}`).set(auth(s.admin))).status, 401, `${p} with an admin token`);
    assert.equal((await get(s.t, p)).status, 200, `${p} with the student's own token`);
  }
});
