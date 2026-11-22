'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, desc, PHOTO, studentPayload, scanId } = require('./helpers');

let ctx; let token;
before(async () => { ctx = await setup(); });
beforeEach(async () => { await reset(ctx.pool); token = await login(ctx.api); });
after(() => ctx.pool.end());

const create = (over) => ctx.api.post('/api/students').set(auth(token)).send(studentPayload(over));
const act = (id, action, body) => ctx.api.post(`/api/students/${id}/actions/${action}`).set(auth(token)).send(body || {});
const emails = async () => (await ctx.api.get('/api/emails').set(auth(token))).body;

test('create issues an active pass with a generated id, lowercased email and a notification', async () => {
  const res = await create({ schoolId: '2026-0418', email: 'MiXeD@Example.edu.ph' });
  assert.equal(res.status, 201);
  const s = res.body.student;
  assert.match(s.id, /^STD-\d{4}-60418$/, 'last 5 digits of the School ID');
  assert.equal(s.status, 'active');
  assert.equal(s.email, 'mixed@example.edu.ph');
  assert.equal(s.validUntil, '31 Mar 2027');
  assert.equal(s.verification.status, 'verified', 'a registrar-issued pass counts as verified by that admin');
  assert.equal(s.qrActive, false, 'no QR exists until one is generated');
  assert.equal(s.discountEligible, true);
  const log = await emails();
  assert.equal(log.total, 1);
  assert.equal(log.items[0].subject, 'Your TransitPass credential is ready');
});

test('ids that collide get a numeric suffix', async () => {
  const a = await create({ schoolId: 'A-60500' });
  const b = await create({ schoolId: 'B-60500' }); // same last 5 digits → same base id
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.student.id, b.body.student.id);
  assert.match(b.body.student.id, /-1$/);
});

test('duplicate email and duplicate School ID are rejected with 409 (case-insensitive)', async () => {
  await create({ schoolId: 'ABC-1', email: 'dup@example.edu.ph' });
  const e = await create({ email: 'DUP@example.edu.ph' });
  assert.equal(e.status, 409);
  assert.match(e.body.error, /email/i);
  const s = await create({ schoolId: 'abc-1' });
  assert.equal(s.status, 409);
  assert.match(s.body.error, /School ID/i);
});

test('create validates fields and rejects School IDs containing QR separators', async () => {
  assert.equal((await create({ name: '' })).status, 400);
  assert.equal((await create({ email: 'not-an-email' })).status, 400);
  assert.equal((await create({ schoolId: '2026::v1' })).status, 400);
  assert.equal((await create({ schoolId: 'A|B' })).status, 400);
  assert.equal((await create({ faceDescriptor: [1, 2, 3] })).status, 400);
  assert.equal((await create({ facePhoto: 'javascript:alert(1)' })).status, 400);
});

test('face enrollment stores the photo but never exposes the descriptor', async () => {
  const res = await create({ faceDescriptor: desc(0.1), facePhoto: PHOTO });
  assert.equal(res.status, 201);
  assert.equal(res.body.student.faceEnrolled, true);
  assert.equal(res.body.student.facePhoto, PHOTO);
  const id = res.body.student.id;
  for (const r of [res, await ctx.api.get(`/api/students/${id}`).set(auth(token)), await ctx.api.get('/api/students').set(auth(token))]) {
    assert.equal(JSON.stringify(r.body).includes('faceDescriptor'), false);
    assert.equal(JSON.stringify(r.body).includes('face_descriptor'), false);
  }
  const [[row]] = await ctx.pool.query('SELECT face_descriptor FROM students WHERE id = ?', [id]);
  assert.equal(JSON.parse(row.face_descriptor).length, 128);
});

test('list supports search, status and discount filters, and escapes LIKE wildcards', async () => {
  await create({ name: 'Alice Cruz', schoolId: 'A-1' });
  const b = await create({ name: 'Bob 100%', schoolId: 'B-2' });
  await act(b.body.student.id, 'mark-ineligible');
  await act(b.body.student.id, 'flag');
  const q = async (qs) => (await ctx.api.get(`/api/students?${qs}`).set(auth(token))).body;
  assert.equal((await q('')).total, 2);
  assert.equal((await q('q=alice')).total, 1);
  assert.equal((await q('q=A-1')).items[0].name, 'Alice Cruz');
  assert.equal((await q('status=flagged')).total, 1);
  assert.equal((await q('discount=ineligible')).items[0].name, 'Bob 100%');
  assert.equal((await q('discount=eligible')).total, 1);
  assert.equal((await q('q=%25')).total, 1, 'a literal % matches only the name containing it');
  assert.equal((await q('q=_')).total, 0, 'underscore is not a wildcard');
  assert.equal((await ctx.api.get('/api/students?status=bogus').set(auth(token))).status, 400);
  const stats = (await ctx.api.get('/api/students/stats').set(auth(token))).body;
  assert.deepEqual(stats, { total: 2, pending: 0, flagged: 1, ineligible: 1 });
});

test('PATCH updates only the given fields, handles face enroll/replace/remove, and logs a notification', async () => {
  const { student } = (await create({ name: 'Original', schoolId: 'P-1' })).body;
  const url = `/api/students/${student.id}`;
  const r1 = await ctx.api.patch(url).set(auth(token)).send({ name: 'Renamed' });
  assert.equal(r1.body.student.name, 'Renamed');
  assert.equal(r1.body.student.schoolId, 'P-1');

  const r2 = await ctx.api.patch(url).set(auth(token)).send({ faceDescriptor: desc(0.2), facePhoto: PHOTO });
  assert.equal(r2.body.student.faceEnrolled, true);
  const r3 = await ctx.api.patch(url).set(auth(token)).send({ phone: '123' });
  assert.equal(r3.body.student.faceEnrolled, true, 'omitting face fields keeps the enrollment');
  const r4 = await ctx.api.patch(url).set(auth(token)).send({ faceDescriptor: null });
  assert.equal(r4.body.student.faceEnrolled, false);
  assert.equal(r4.body.student.facePhoto, null);

  const log = (await emails()).items.map((e) => e.body);
  assert.ok(log.some((b) => b.includes('Face verification has been enrolled')));
  assert.ok(log.some((b) => b.includes('Face verification has been removed')));
  assert.equal((await ctx.api.patch(url).set(auth(token)).send({})).status, 400);
  assert.equal((await ctx.api.patch('/api/students/NOPE').set(auth(token)).send({ name: 'x' })).status, 404);
});

test('PATCH enforces uniqueness against other students but not against itself', async () => {
  const a = (await create({ schoolId: 'U-1', email: 'u1@example.edu.ph' })).body.student;
  const b = (await create({ schoolId: 'U-2', email: 'u2@example.edu.ph' })).body.student;
  assert.equal((await ctx.api.patch(`/api/students/${a.id}`).set(auth(token)).send({ email: 'u1@example.edu.ph', name: 'Same' })).status, 200);
  assert.equal((await ctx.api.patch(`/api/students/${b.id}`).set(auth(token)).send({ schoolId: 'U-1' })).status, 409);
});

test('registrar actions follow the pass lifecycle and reject invalid transitions', async () => {
  const { student } = (await create()).body;
  const id = student.id;
  await ctx.pool.query("UPDATE students SET status = 'pending', valid_until = 'Awaiting registrar' WHERE id = ?", [id]);
  await ctx.pool.query("UPDATE student_verifications SET verification_status = 'pending', verified_by = NULL WHERE student_id = ?", [id]);

  assert.equal((await act(id, 'flag')).status, 409, 'cannot flag a pending pass');
  assert.equal((await act(id, 'reinstate')).status, 409);
  const approved = await act(id, 'approve');
  assert.equal(approved.body.student.status, 'active');
  assert.equal(approved.body.student.validUntil, '31 Mar 2027');
  assert.equal((await act(id, 'approve')).status, 409, 'cannot approve twice');

  const flagged = await act(id, 'flag');
  assert.equal(flagged.body.student.status, 'flagged');
  assert.equal(flagged.body.student.validUntil, 'Under review');
  assert.equal((await act(id, 'reinstate')).body.student.status, 'active');

  const revoked = await act(id, 'revoke');
  assert.equal(revoked.body.student.status, 'expired');
  assert.equal((await act(id, 'revoke')).status, 409);
  assert.equal((await act('NOPE', 'approve')).status, 404);
  assert.equal((await act(id, 'explode')).status, 404);
});

test('QR, discount and validity actions', async () => {
  const id = (await create()).body.student.id;
  assert.equal((await act(id, 'deactivate-qr')).status, 409, 'no QR yet, nothing to deactivate');
  assert.equal((await act(id, 'activate-qr')).status, 409, 'nothing to reactivate');
  assert.equal((await ctx.api.get(`/api/students/${id}/qr`).set(auth(token))).body.payload, null);
  const issued = await act(id, 'regenerate-qr');
  assert.equal(issued.body.student.qrActive, true, 'regenerate issues the first QR');
  assert.equal((await act(id, 'deactivate-qr')).body.student.qrActive, false);
  assert.equal((await act(id, 'deactivate-qr')).status, 409);
  assert.equal((await act(id, 'activate-qr')).body.student.qrActive, true);
  assert.equal((await act(id, 'activate-qr')).status, 409, 'already active');
  const regen = await act(id, 'regenerate-qr');
  assert.equal(regen.body.student.qrVersion, 3);
  assert.equal(regen.body.student.qrActive, true, 'regenerating re-activates');
  assert.match((await ctx.api.get(`/api/students/${id}/qr`).set(auth(token))).body.payload, /^TP1\.[A-Za-z0-9_-]{32}$/);

  assert.equal((await act(id, 'mark-ineligible')).body.student.discountEligible, false);
  assert.equal((await act(id, 'mark-ineligible')).status, 409);
  assert.equal((await act(id, 'mark-eligible')).body.student.discountEligible, true);

  assert.equal((await act(id, 'set-validity')).status, 409, 'validUntil is required');
  assert.equal((await act(id, 'set-validity', { validUntil: '30 Jun 2027' })).body.student.validUntil, '30 Jun 2027');
  assert.ok((await emails()).items.some((e) => e.body.includes('30 Jun 2027')));
});

test('email-qr logs a notification; deleting a student keeps their scan history', async () => {
  const s = (await create({ schoolId: 'D-1' })).body.student;
  assert.equal((await ctx.api.post(`/api/students/${s.id}/email-qr`).set(auth(token))).status, 200);
  assert.ok((await emails()).items.some((e) => e.subject === 'Your TransitPass QR code'));

  await scanId(ctx.api, token, 'D-1');
  assert.equal((await ctx.api.delete(`/api/students/${s.id}`).set(auth(token))).status, 204);
  assert.equal((await ctx.api.get(`/api/students/${s.id}`).set(auth(token))).status, 404);
  assert.equal((await ctx.api.delete(`/api/students/${s.id}`).set(auth(token))).status, 404);
  const scans = (await ctx.api.get('/api/scans').set(auth(token))).body;
  assert.equal(scans.total, 1, 'audit trail survives');
  assert.equal(scans.items[0].student, s.name);
  assert.equal(scans.items[0].studentId, null);
});

test('a student\'s own scan history is paginated and newest-first', async () => {
  const s = (await create({ schoolId: 'H-1' })).body.student;
  for (let i = 0; i < 3; i++) await scanId(ctx.api, token, 'H-1');
  const res = await ctx.api.get(`/api/students/${s.id}/scans?limit=2`).set(auth(token));
  assert.equal(res.body.total, 3);
  assert.equal(res.body.items.length, 2);
  assert.ok(res.body.items[0].scannedAt >= res.body.items[1].scannedAt);
});

test('two simultaneous approvals: exactly one succeeds (row lock), the other gets 409 and only one email is sent', async () => {
  const id = (await create()).body.student.id;
  await ctx.pool.query("UPDATE students SET status = 'pending' WHERE id = ?", [id]);
  await ctx.pool.query("UPDATE student_verifications SET verification_status = 'pending' WHERE student_id = ?", [id]);
  const before = (await emails()).total;
  const results = await Promise.all([act(id, 'approve'), act(id, 'approve'), act(id, 'approve')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await emails()).total, before + 1);
});

test('two simultaneous creates with colliding generated ids both succeed with distinct ids', async () => {
  const [a, b] = await Promise.all([create({ schoolId: 'X-77777' }), create({ schoolId: 'Y-77777' })]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.student.id, b.body.student.id);
});
