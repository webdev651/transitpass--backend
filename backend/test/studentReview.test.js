'use strict';
// Student management: viewing uploaded documents, verifying them, and approving / rejecting correction requests,
// next to the application approve / reject that already existed. Every decision must be recorded and reach the student.
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-review-'));
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload } = require('./helpers');

let ctx, admin;
before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await reset(ctx.pool);
  for (const f of fs.readdirSync(process.env.UPLOAD_DIR)) fs.rmSync(path.join(process.env.UPLOAD_DIR, f), { recursive: true, force: true });
  admin = await login(ctx.api);
});
after(async () => { await ctx.pool.end(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const V = '/api/admin/verifications';
const C = '/api/admin/correction-requests';
const RN = '/api/admin/renewal-requests';
const QR = '/api/admin/qr-replacement-requests';
const aget = (p, t = admin) => ctx.api.get(p).set(auth(t));
const apost = (p, b, t = admin) => ctx.api.post(p).set(auth(t)).send(b || {});

/** A student who signed up online (optionally with documents). */
async function applicant({ docs = true, ...over } = {}) {
  const body = { ...studentPayload(), campus: 'Main', section: 'A', password: 'secret-pass-1', confirm: 'secret-pass-1', ...over };
  let req = ctx.api.post('/api/student-portal/register');
  for (const [k, v] of Object.entries(body)) req = req.field(k, v);
  if (docs) req = req.attach('idDocument', PDF, { filename: 'id.pdf' }).attach('enrollmentDocument', PNG, { filename: 'cor.png' });
  const reg = docs ? await req : await ctx.api.post('/api/student-portal/register').send(body);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const token = (await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password })).body.token;
  return { id: reg.body.student.id, body, name: body.name, token, t: auth(token) };
}
const sget = (s, p) => ctx.api.get(`/api/student-portal${p}`).set(s.t);
const spost = (s, p, b) => ctx.api.post(`/api/student-portal${p}`).set(s.t).send(b || {});

/* ------------------------------------------------------------------ applications (existing features keep working) */

test('applications: approve records a note, reject records the reason, and both show in the review panel', async () => {
  const a = await applicant();
  assert.equal((await aget(`${V}/${a.id}`)).body.student.verification.status, 'pending');
  assert.equal((await apost(`${V}/${a.id}/reject`, { reason: 'x' })).status, 400, 'a reason is required');
  const rej = await apost(`${V}/${a.id}/reject`, { reason: 'Enrollment document is blurry' });
  assert.equal(rej.status, 200);
  let d = (await aget(`${V}/${a.id}`)).body.student.verification;
  assert.equal(d.status, 'rejected');
  assert.equal(d.rejectionReason, 'Enrollment document is blurry');
  assert.ok(d.by && d.date);
  assert.equal((await sget(a, '/me/dashboard')).body.student.registration.rejectionReason, 'Enrollment document is blurry', 'the student sees the reason');
  await apost(`${V}/${a.id}/reopen`);
  const ok = await apost(`${V}/${a.id}/approve`, { note: 'Checked against the registrar list' });
  assert.equal(ok.status, 200);
  d = (await aget(`${V}/${a.id}`)).body.student.verification;
  assert.equal(d.status, 'verified');
  assert.equal(d.note, 'Checked against the registrar list');
});

/* ------------------------------------------------------------------ documents */

test('documents: the review panel lists what was uploaded, with type, size and status', async () => {
  const a = await applicant();
  const d = (await aget(`${V}/${a.id}`)).body;
  assert.equal(d.documents.length, 2);
  const idDoc = d.documents.find((x) => x.kind === 'id');
  assert.equal(idDoc.label, 'Student ID document');
  assert.equal(idDoc.submitted, true);
  assert.equal(idDoc.available, true);
  assert.equal(idDoc.status, 'pending');
  assert.equal(idDoc.fileType, 'PDF');
  assert.ok(idDoc.sizeBytes > 0);
  assert.equal(d.documents.find((x) => x.kind === 'enrollment').fileType, 'PNG image');
  assert.equal(d.profile.campus, 'Main');
  assert.equal(d.profile.section, 'A');
  assert.equal(JSON.stringify(d).includes('students/STD'), false, 'file paths never leave the server');
  assert.equal(JSON.stringify(d).includes('password_hash'), false);
});

test('documents: a student without uploads shows "not submitted", and the list shows each document state', async () => {
  const none = await applicant({ docs: false });
  const d = (await aget(`${V}/${none.id}`)).body;
  assert.deepEqual(d.documents.map((x) => [x.submitted, x.status]), [[false, 'none'], [false, 'none']]);
  const full = await applicant();
  const list = (await aget(`${V}?status=all&limit=50`)).body.items;
  assert.deepEqual(list.find((s) => s.id === none.id).documents, { id: 'none', enrollment: 'none' });
  assert.deepEqual(list.find((s) => s.id === full.id).documents, { id: 'pending', enrollment: 'pending' });
});

test('documents: an administrator can open the real file; viewing is logged; nobody else can open it', async () => {
  const a = await applicant();
  const f = await aget(`${V}/${a.id}/documents/id`);
  assert.equal(f.status, 200);
  assert.equal(f.headers['content-type'].startsWith('application/pdf'), true);
  assert.equal(f.headers['x-content-type-options'], 'nosniff');
  assert.match(f.headers['cache-control'], /no-store/);
  assert.equal(Buffer.compare(f.body, PDF), 0, 'the same bytes the student uploaded');
  const img = await aget(`${V}/${a.id}/documents/enrollment`);
  assert.equal(img.headers['content-type'].startsWith('image/png'), true);
  const log = (await aget('/api/admin/dashboard/activities?limit=20')).body.items;
  assert.ok(log.some((i) => i.description === `Viewed the student ID document of ${a.name} (${a.body.schoolId})`));

  await apost('/api/admin/drivers', { name: 'Pedro', username: 'pedro', email: 'pedro@example.com', password: 'driver-pass-1' });
  const driver = await login(ctx.api, 'pedro', 'driver-pass-1');
  assert.equal((await ctx.api.get(`${V}/${a.id}/documents/id`)).status, 401, 'no token');
  assert.equal((await aget(`${V}/${a.id}/documents/id`, driver)).status, 403, 'a driver');
  assert.equal((await aget(`${V}/${a.id}/documents/id`, a.token)).status, 401, 'a student token');
  assert.equal((await aget(`${V}/${a.id}/documents/passwd`)).status, 404, 'unknown document type');
  assert.equal((await aget(`${V}/NO-SUCH/documents/id`)).status, 404);
  const none = await applicant({ docs: false });
  assert.equal((await aget(`${V}/${none.id}/documents/id`)).status, 404, 'nothing uploaded');
});

test('documents: verify one, reject another with a reason; the student is told and sees the status', async () => {
  const a = await applicant();
  const bad = await apost(`${V}/${a.id}/documents/id/review`, { decision: 'rejected' });
  assert.equal(bad.status, 400, 'rejecting needs a reason');
  assert.equal((await apost(`${V}/${a.id}/documents/id/review`, { decision: 'maybe' })).status, 400);
  const ok = await apost(`${V}/${a.id}/documents/enrollment/review`, { decision: 'verified' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.documents.find((x) => x.kind === 'enrollment').status, 'verified');
  assert.ok(ok.body.documents.find((x) => x.kind === 'enrollment').reviewedBy);
  const rej = await apost(`${V}/${a.id}/documents/id/review`, { decision: 'rejected', reason: 'The photo is too dark to read' });
  assert.equal(rej.body.documents.find((x) => x.kind === 'id').status, 'rejected');
  assert.equal(rej.body.documents.find((x) => x.kind === 'id').reason, 'The photo is too dark to read');

  const profile = (await sget(a, '/me/profile')).body;
  assert.deepEqual(profile.documentReviews, { id: { status: 'rejected', reason: 'The photo is too dark to read' }, enrollment: { status: 'verified', reason: null } });
  const notes = (await sget(a, '/me/notifications')).body.items;
  const n = notes.find((i) => i.title === 'Your student ID document was not approved');
  assert.ok(n, 'the student got a notification');
  assert.match(n.body, /too dark to read/);
  assert.equal(n.category, 'profile');
  assert.ok(notes.some((i) => i.title === 'Your enrollment document was approved' && i.category === 'profile'));
  const list = (await aget(`${V}?status=all&limit=50`)).body.items;
  assert.deepEqual(list.find((s) => s.id === a.id).documents, { id: 'rejected', enrollment: 'verified' });
  const log = (await aget('/api/admin/dashboard/activities?limit=30')).body.items.map((i) => i.description);
  assert.ok(log.some((d) => d.startsWith('Verified the enrollment document of')));
  assert.ok(log.some((d) => d.startsWith('Rejected the student ID document of')));
});

test('documents: a replaced file has to be reviewed again; approved students cannot swap documents', async () => {
  const a = await applicant();
  await apost(`${V}/${a.id}/documents/id/review`, { decision: 'rejected', reason: 'Wrong person on the card' });
  const swap = await ctx.api.post('/api/student-portal/me/documents').set(a.t).attach('idDocument', PNG, { filename: 'new.png' });
  assert.equal(swap.status, 200);
  const d = (await aget(`${V}/${a.id}`)).body.documents.find((x) => x.kind === 'id');
  assert.equal(d.status, 'pending', 'the old rejection no longer applies to the new file');
  assert.equal(d.fileType, 'PNG image');
  assert.equal((await sget(a, '/me/profile')).body.documentReviews.id.status, 'pending');
});

test('documents: reviewing a document that was never uploaded is refused', async () => {
  const none = await applicant({ docs: false });
  const r = await apost(`${V}/${none.id}/documents/id/review`, { decision: 'verified' });
  assert.equal(r.status, 409);
  assert.equal((await apost(`${V}/${none.id}/documents/zzz/review`, { decision: 'verified' })).status, 404);
  assert.equal((await apost(`${V}/NO-SUCH/documents/id/review`, { decision: 'verified' })).status, 404);
});

/* ------------------------------------------------------------------ correction requests */

const correction = (s, over = {}) => spost(s, '/me/requests', { type: 'correction', field: 'section', value: 'B', reason: 'I was moved to section B', ...over });

test('corrections: pending requests are listed with the student, the field and both values', async () => {
  const a = await applicant();
  await correction(a);
  await correction(a, { field: 'program', value: 'BS Nursing', reason: 'Shifted course this semester' });
  const l = (await aget(`${C}?status=pending`)).body;
  assert.equal(l.total, 2);
  assert.deepEqual(l.counts, { pending: 2, approved: 0, rejected: 0 });
  const sec = l.items.find((i) => i.field === 'section');
  assert.equal(sec.studentName, a.name);
  assert.equal(sec.schoolId, a.body.schoolId);
  assert.equal(sec.fieldLabel, 'Section');
  assert.equal(sec.currentValue, 'A');
  assert.equal(sec.requestedValue, 'B');
  assert.equal(sec.reason, 'I was moved to section B');
  assert.equal(sec.status, 'pending');
  assert.equal((await aget(`${V}/${a.id}`)).body.pendingCorrections, 2);
  assert.equal((await aget(`${C}?q=${encodeURIComponent(a.name)}`)).body.total, 2);
  assert.equal((await aget(`${C}?q=nobody-here`)).body.total, 0);
  assert.equal((await aget(`${C}?status=bogus`)).status, 400);
});

test('corrections: approving CHANGES the student record, records who/when/note, and tells the student', async () => {
  const a = await applicant();
  const made = await correction(a);
  const id = made.body.request.id;
  const ok = await apost(`${C}/${id}/approve`, { note: 'Confirmed with the class list' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.request.status, 'approved');
  assert.equal(ok.body.request.adminNote, 'Confirmed with the class list');
  assert.ok(ok.body.request.reviewedBy && ok.body.request.reviewedAt);
  const [[row]] = await ctx.pool.query('SELECT section, name, program FROM students WHERE id = ?', [a.id]);
  assert.equal(row.section, 'B');
  assert.equal(row.name, a.name, 'nothing else was touched');
  const profile = (await sget(a, '/me/profile')).body;
  assert.equal(profile.student.section, 'B');
  const r = profile.requests.find((x) => x.id === id);
  assert.equal(r.status, 'approved');
  assert.equal(r.adminNote, 'Confirmed with the class list');
  const n = (await sget(a, '/me/notifications')).body.items.find((i) => i.title === 'Your information correction request was approved');
  assert.ok(n && n.category === 'profile');
  assert.equal((await apost(`${C}/${id}/approve`)).status, 409, 'cannot decide twice');
  assert.equal((await apost(`${C}/${id}/reject`, { reason: 'changed my mind' })).status, 409);
  assert.deepEqual((await aget(`${C}?status=all`)).body.counts, { pending: 0, approved: 1, rejected: 0 });
});

test('corrections: every correctable field is applied to the right column', async () => {
  const a = await applicant();
  const cases = [['name', 'Corrected Name', 'name'], ['school', 'New College', 'school'], ['campus', 'North Campus', 'campus'], ['program', 'BS Nursing', 'program'], ['level', '3rd Year', 'level'], ['section', 'C', 'section'], ['schoolId', '2026-9001', 'school_id']];
  for (const [field, value, col] of cases) {
    const id = (await correction(a, { field, value, reason: `Fix ${field}` })).body.request.id;
    assert.equal((await apost(`${C}/${id}/approve`)).status, 200, field);
    const [[row]] = await ctx.pool.query(`SELECT ${col} AS v FROM students WHERE id = ?`, [a.id]);
    assert.equal(row.v, value, field);
  }
  assert.equal((await sget(a, '/me/profile')).status, 200, 'the student can still sign in with the changed details');
});

test('corrections: rejecting needs a reason, changes nothing, and the student sees the reason', async () => {
  const a = await applicant();
  const id = (await correction(a)).body.request.id;
  assert.equal((await apost(`${C}/${id}/reject`, {})).status, 400);
  assert.equal((await apost(`${C}/${id}/reject`, { reason: 'ab' })).status, 400);
  const rej = await apost(`${C}/${id}/reject`, { reason: 'Your class list still says section A' });
  assert.equal(rej.status, 200);
  assert.equal(rej.body.request.status, 'rejected');
  assert.equal(rej.body.request.adminNote, 'Your class list still says section A');
  const [[row]] = await ctx.pool.query('SELECT section FROM students WHERE id = ?', [a.id]);
  assert.equal(row.section, 'A');
  const r = (await sget(a, '/me/profile')).body.requests.find((x) => x.id === id);
  assert.equal(r.status, 'rejected');
  assert.equal(r.adminNote, 'Your class list still says section A');
  const n = (await sget(a, '/me/notifications')).body.items.find((i) => i.title === 'Your information correction request was not approved');
  assert.match(n.body, /still says section A/);
  assert.equal((await correction(a)).status, 201, 'after a rejection the student may ask again');
});

test('corrections: a Student ID that another student has taken in the meantime cannot be approved', async () => {
  const a = await applicant();
  const other = await applicant();
  const id = (await correction(a, { field: 'schoolId', value: '2026-5555', reason: 'My ID was typed wrong' })).body.request.id;
  await ctx.pool.query("UPDATE students SET school_id = '2026-5555' WHERE id = ?", [other.id]);
  const r = await apost(`${C}/${id}/approve`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already uses that Student ID/);
  const [[st]] = await ctx.pool.query('SELECT school_id FROM students WHERE id = ?', [a.id]);
  assert.equal(st.school_id, a.body.schoolId, 'unchanged');
  const [[rq]] = await ctx.pool.query('SELECT status FROM student_requests WHERE id = ?', [id]);
  assert.equal(rq.status, 'pending', 'the request stays open so it can be rejected with a reason');
  assert.equal((await apost(`${C}/${id}/reject`, { reason: 'That ID belongs to another student' })).status, 200);
});

test('corrections: only correction requests are listed here (renewal and QR requests are not)', async () => {
  const a = await applicant();
  await ctx.pool.query("INSERT INTO student_requests (student_id, type, reason) VALUES (?, 'renewal', 'please')", [a.id]);
  await ctx.pool.query("INSERT INTO student_requests (student_id, type, reason) VALUES (?, 'qr_replacement', 'lost')", [a.id]);
  const lone = (await aget(`${C}?status=all`)).body;
  assert.equal(lone.total, 0);
  const [[{ id }]] = await ctx.pool.query("SELECT id FROM student_requests WHERE type = 'renewal'");
  assert.equal((await apost(`${C}/${id}/approve`)).status, 404, 'and cannot be approved through this route');
  assert.equal((await apost(`${C}/abc/approve`)).status, 404);
  assert.equal((await apost(`${C}/99999/approve`)).status, 404);
});

test('corrections: a request the student cancelled cannot be approved', async () => {
  const a = await applicant();
  const id = (await correction(a)).body.request.id;
  await spost(a, `/me/requests/${id}/cancel`);
  assert.equal((await apost(`${C}/${id}/approve`)).status, 409);
  assert.equal((await aget(`${C}?status=pending`)).body.total, 0);
});

/* ------------------------------------------------------------------ renewal requests */

test('renewals: an expired discount can be renewed; approving extends validity and reactivates the pass', async () => {
  const a = await applicant();
  await apost(`${V}/${a.id}/approve`);
  await ctx.pool.query("UPDATE students SET valid_until = '31 Oct 2026' WHERE id = ?", [a.id]);
  const elig = (await sget(a, '/me/eligibility')).body.eligibility;
  assert.equal(elig.status, 'expired', 'the discount is expired so a renewal can be requested');
  const made = await spost(a, '/me/requests', { type: 'renewal', reason: 'Enrolled again next semester' });
  assert.equal(made.status, 201);
  const id = made.body.request.id;
  assert.equal(made.body.request.type, 'renewal');
  assert.equal((await sget(a, '/me/requests')).body.items.find((r) => r.id === id).status, 'pending');
  const ok = await apost(`${RN}/${id}/approve`, { note: 'Enrollment confirmed with the registrar' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.request.status, 'approved');
  assert.equal(ok.body.request.adminNote, 'Enrollment confirmed with the registrar');
  assert.ok(ok.body.request.reviewedBy && ok.body.request.reviewedAt);
  const [[row]] = await ctx.pool.query('SELECT status, valid_until FROM students WHERE id = ?', [a.id]);
  assert.equal(row.status, 'active', 'the pass is active again');
  assert.match(row.valid_until, /^\d{2} [A-Z][a-z]{2} \d{4}$/, 'new validity date');
  assert.notEqual(row.valid_until, '31 Oct 2026');
  const n = (await sget(a, '/me/notifications')).body.items.find((i) => i.title === 'Your discount renewal was approved');
  assert.ok(n && n.category === 'discount', 'the student is told');
  assert.equal((await apost(`${RN}/${id}/approve`)).status, 409, 'cannot decide twice');
  assert.equal((await apost(`${RN}/${id}/reject`, { reason: 'changed my mind' })).status, 409);
  assert.deepEqual((await aget(`${RN}?status=all`)).body.counts, { pending: 0, approved: 1, rejected: 0 });
});

test('renewals: rejection needs a reason, changes nothing, and the student may ask again', async () => {
  const a = await applicant();
  await apost(`${V}/${a.id}/approve`);
  await ctx.pool.query("UPDATE students SET valid_until = '31 Oct 2026' WHERE id = ?", [a.id]);
  const id = (await spost(a, '/me/requests', { type: 'renewal', reason: 'Please extend' })).body.request.id;
  assert.equal((await apost(`${RN}/${id}/reject`, {})).status, 400);
  assert.equal((await apost(`${RN}/${id}/reject`, { reason: 'ab' })).status, 400);
  const rej = await apost(`${RN}/${id}/reject`, { reason: 'Not enrolled this semester' });
  assert.equal(rej.status, 200);
  assert.equal(rej.body.request.status, 'rejected');
  assert.equal(rej.body.request.adminNote, 'Not enrolled this semester');
  const [[row]] = await ctx.pool.query('SELECT status, valid_until FROM students WHERE id = ?', [a.id]);
  assert.equal(row.status, 'active');
  assert.equal(row.valid_until, '31 Oct 2026', 'nothing was changed');
  const n = (await sget(a, '/me/notifications')).body.items.find((i) => i.title === 'Your discount renewal was not approved');
  assert.ok(n && n.category === 'discount');
  assert.match(n.body, /Not enrolled this semester/);
  assert.equal((await spost(a, '/me/requests', { type: 'renewal', reason: 'Try again' })).status, 201, 'after a rejection the student may ask again');
});

/* ------------------------------------------------------------------ QR replacement requests */

test('qr replacements: a deactivated code is replaced only after the administrator approves the request', async () => {
  const a = await applicant();
  await apost(`${V}/${a.id}/approve`);
  await spost(a, '/me/qr');
  const before = (await sget(a, '/me/qr')).body;
  assert.ok(before.qr && before.qr.status === 'active', 'the student has an active QR code');
  const qrId = before.qr.id;
  assert.equal((await apost('/api/admin/qr-codes/' + qrId + '/revoke', { reason: 'Lost code' })).status, 200, 'administrator deactivates the code');
  assert.equal((await spost(a, '/me/qr')).status, 403, 'the student cannot generate a new one alone');
  const state = (await sget(a, '/me/qr')).body;
  assert.ok(state.blockedByAdmin && state.replacementRequestPending === false);
  const made = await spost(a, '/me/requests', { type: 'qr_replacement', reason: 'My code was deactivated and I need a new one' });
  assert.equal(made.status, 201);
  assert.equal(made.body.request.type, 'qr_replacement');
  const id = made.body.request.id;
  assert.equal((await sget(a, '/me/qr')).body.replacementRequestPending, true, 'the pending request shows on My QR Code');
  const ok = await apost(`${QR}/${id}/approve`, { note: 'Identity re-checked against the registrar list' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.request.status, 'approved');
  const after = (await sget(a, '/me/qr')).body;
  assert.ok(after.qr && after.qr.status === 'active', 'a new active QR code was issued');
  assert.notEqual(after.qr.id, qrId);
  assert.equal(after.replacementRequestPending, false);
  const [[old]] = await ctx.pool.query('SELECT status FROM qr_codes WHERE id = ?', [qrId]);
  assert.equal(old.status, 'revoked', 'the old code stays deactivated');
  const n = (await sget(a, '/me/notifications')).body.items.find((i) => i.title === 'A new QR code has been issued for your pass');
  assert.ok(n, 'the student is told a new code was issued');
  assert.equal((await apost(`${QR}/${id}/approve`)).status, 409, 'cannot decide twice');
  assert.equal((await apost(`${QR}/${id}/reject`, { reason: 'nope' })).status, 409);
  assert.deepEqual((await aget(`${QR}?status=all`)).body.counts, { pending: 0, approved: 1, rejected: 0 });
});

test('qr replacements: rejection changes nothing and the student sees the reason', async () => {
  const a = await applicant();
  await apost(`${V}/${a.id}/approve`);
  await spost(a, '/me/qr');
  const qrId = (await sget(a, '/me/qr')).body.qr.id;
  await apost('/api/admin/qr-codes/' + qrId + '/revoke', { reason: 'Lost code' });
  const id = (await spost(a, '/me/requests', { type: 'qr_replacement', reason: 'Please replace it' })).body.request.id;
  const rej = await apost(`${QR}/${id}/reject`, { reason: 'We already issued you a replacement this month' });
  assert.equal(rej.status, 200);
  assert.equal(rej.body.request.status, 'rejected');
  assert.equal((await sget(a, '/me/qr')).body.qr, null, 'no new QR code was issued');
  const n = (await sget(a, '/me/notifications')).body.items.find((i) => i.title === 'Your QR replacement request was not approved');
  assert.ok(n);
  assert.match(n.body, /We already issued you a replacement this month/);
});

/* ------------------------------------------------------------------ protection + logging */

test('every new route is closed to anonymous users, students and drivers', async () => {
  const a = await applicant();
  const id = (await correction(a)).body.request.id;
  await apost('/api/admin/drivers', { name: 'Pedro', username: 'pedro', email: 'pedro@example.com', password: 'driver-pass-1' });
  const driver = await login(ctx.api, 'pedro', 'driver-pass-1');
  const routes = [['get', `${V}/${a.id}`], ['get', `${V}/${a.id}/documents/id`], ['post', `${V}/${a.id}/documents/id/review`, { decision: 'verified' }],
    ['get', C], ['post', `${C}/${id}/approve`, {}], ['post', `${C}/${id}/reject`, { reason: 'nope nope' }]];
  for (const [m, p, b] of routes) {
    const call = (t) => { let r = ctx.api[m](p); if (t) r = r.set(auth(t)); return b ? r.send(b) : r; };
    assert.equal((await call()).status, 401, `${p} anonymous`);
    assert.equal((await call(a.token)).status, 401, `${p} student`);
    assert.equal((await call(driver)).status, 403, `${p} driver`);
  }
  const [[row]] = await ctx.pool.query('SELECT section FROM students WHERE id = ?', [a.id]);
  assert.equal(row.section, 'A', 'none of those attempts changed anything');
});

test('renewal and QR replacement routes are closed to anonymous users, students and drivers', async () => {
  const a = await applicant();
  await apost(`${V}/${a.id}/approve`);
  await ctx.pool.query("UPDATE students SET valid_until = '31 Oct 2026' WHERE id = ?", [a.id]);
  const rn = (await spost(a, '/me/requests', { type: 'renewal', reason: 'please extend' })).body.request.id;
  await ctx.pool.query("INSERT INTO student_requests (student_id, type, reason, status) VALUES (?, 'qr_replacement', 'code dead', 'pending')", [a.id]);
  const [[{ id: qid }]] = await ctx.pool.query("SELECT id FROM student_requests WHERE type = 'qr_replacement'");
  await apost('/api/admin/drivers', { name: 'Pedro', username: 'pedro', email: 'pedro@example.com', password: 'driver-pass-1' });
  const driver = await login(ctx.api, 'pedro', 'driver-pass-1');
  const posts = [
    ['post', RN + '/' + rn + '/approve', {}],
    ['post', RN + '/' + rn + '/reject', { reason: 'nope nope' }],
    ['post', QR + '/' + qid + '/approve', {}],
    ['post', QR + '/' + qid + '/reject', { reason: 'nope nope' }]
  ];
  for (const [m, p, b] of posts) {
    const call = (t) => { let r = ctx.api[m](p); if (t) r = r.set(auth(t)); return r.send(b); };
    assert.equal((await call()).status, 401, `${p} anonymous`);
    assert.equal((await call(a.token)).status, 401, `${p} student`);
    assert.equal((await call(driver)).status, 403, `${p} driver`);
  }
  const lists = [['get', RN], ['get', QR]];
  for (const [m, p] of lists) {
    assert.equal((await ctx.api[m](p)).status, 401, `${p} anonymous`);
    assert.equal((await ctx.api[m](p).set(auth(a.token))).status, 401, `${p} student`);
    assert.equal((await ctx.api[m](p).set(auth(driver))).status, 403, `${p} driver`);
  }
  const [[rq]] = await ctx.pool.query('SELECT status FROM student_requests WHERE id = ?', [rn]);
  assert.equal(rq.status, 'pending', 'nothing was decided');
});

test('every decision is written to the activity log with who made it', async () => {
  const a = await applicant();
  const id = (await correction(a)).body.request.id;
  await apost(`${V}/${a.id}/documents/enrollment/review`, { decision: 'verified' });
  await apost(`${C}/${id}/approve`);
  const me = (await ctx.api.get('/api/auth/me').set(auth(admin))).body.admin;
  const items = (await aget('/api/admin/dashboard/activities?limit=30')).body.items;
  const doc = items.find((i) => i.description.startsWith('Verified the enrollment document'));
  const cor = items.find((i) => i.description.startsWith('Approved information correction request'));
  assert.ok(doc && cor);
  assert.equal(doc.user, me.name);
  assert.equal(cor.status, 'Success');
  assert.match(cor.description, new RegExp(`${a.name}.*section`));
});

test('a rejected correction attempt (conflict) is logged as failed, not lost', async () => {
  const a = await applicant();
  const id = (await correction(a)).body.request.id;
  await apost(`${C}/${id}/approve`);
  await apost(`${C}/${id}/approve`);
  const items = (await aget('/api/admin/dashboard/activities?limit=30')).body.items;
  assert.ok(items.some((i) => i.status === 'Failed' && i.description.startsWith('Approved information correction request')));
});
