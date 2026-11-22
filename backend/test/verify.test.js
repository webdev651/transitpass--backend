'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, desc, PHOTO, studentPayload } = require('./helpers');
const { parsePassId } = require('../src/services/verification');
const { faceDistance, faceConfidence } = require('../src/lib/face');

let ctx; let token;
before(async () => { ctx = await setup(); });
beforeEach(async () => { await reset(ctx.pool); token = await login(ctx.api); });
after(() => ctx.pool.end());

const post = (path, body) => ctx.api.post(`/api/verify/${path}`).set(auth(token)).send(body);
const scan = (passId, extra) => post('scan', { passId, ...extra });
const mk = async (over) => (await ctx.api.post('/api/students').set(auth(token)).send(studentPayload(over))).body.student;
const act = (id, a, b) => ctx.api.post(`/api/students/${id}/actions/${a}`).set(auth(token)).send(b || {});
const scans = async () => (await ctx.api.get('/api/scans').set(auth(token))).body;
const emails = async () => (await ctx.api.get('/api/emails').set(auth(token))).body.items;
const counter = async (id) => (await ctx.api.get(`/api/students/${id}`).set(auth(token))).body.student.scans;

test('parsePassId handles bare IDs, versioned payloads and the TRANSITPASS| prefix', () => {
  assert.deepEqual(parsePassId(' 2023-1182 '), { schoolId: '2023-1182', version: null });
  assert.deepEqual(parsePassId('2023-1182::v3'), { schoolId: '2023-1182', version: 3 });
  assert.deepEqual(parsePassId('TRANSITPASS|2023-1182::v2'), { schoolId: '2023-1182', version: 2 });
  assert.deepEqual(parsePassId('transitpass|X-1'), { schoolId: 'X-1', version: null });
  assert.equal(parsePassId('X-1::vabc').version, -1);
  assert.equal(parsePassId('A'.repeat(100)).schoolId.length, 40);
});

test('face math: distance, confidence clamp, mismatched lengths', () => {
  assert.equal(faceDistance([0, 0], [3, 4]), 5);
  assert.equal(faceDistance([1], [1, 2]), Infinity);
  assert.equal(faceConfidence(0), 100);
  assert.equal(faceConfidence(2), 0);
  assert.equal(faceConfidence(0.25), 75);
});

test('active + eligible pass is granted at the discounted fare and bumps the scan counter', async () => {
  const s = await mk({ schoolId: 'G-1' });
  const res = await scan('G-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'final');
  assert.equal(res.body.result, 'granted');
  assert.equal(res.body.verdict, 'VALID');
  assert.equal(res.body.fare, '₱13.00 (−20%)');
  assert.equal(res.body.discountStatus, 'Eligible — 20% discount');
  assert.equal(res.body.scan.route, 'Verification Terminal');
  assert.equal(res.body.scan.operator, 'node-04 · Registrar Ops');
  assert.equal(res.body.student.scans, 1);
  assert.equal(await counter(s.id), 1);
});

test('active but not discount-eligible is granted at full fare with no discount recorded', async () => {
  const s = await mk({ schoolId: 'G-2' });
  await act(s.id, 'mark-ineligible');
  const res = await scan('G-2');
  assert.equal(res.body.result, 'granted');
  assert.equal(res.body.fare, '₱16.25 (full fare — discount not eligible)');
  assert.equal(res.body.discountStatus, 'Not eligible — full fare');
  const [[row]] = await ctx.pool.query('SELECT discount_amount FROM scans WHERE id = ?', [res.body.scan.id]);
  assert.equal(Number(row.discount_amount), 0);
});

test('lookup is case-insensitive and accepts decoded QR payloads', async () => {
  await mk({ schoolId: 'ab-12' });
  assert.equal((await scan('AB-12')).body.result, 'granted');
  assert.equal((await scan('ab-12::v1')).body.result, 'granted');
  assert.equal((await scan('TRANSITPASS|ab-12::v1')).body.result, 'granted');
});

test('unknown School ID is reported as invalid and is NOT logged', async () => {
  const res = await scan('NOPE-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.result, 'unknown');
  assert.equal(res.body.verdict, 'INVALID');
  assert.equal(res.body.student, null);
  assert.equal((await scans()).total, 0);
});

test('flagged pass → review at full fare, logged, with a fraud-alert email', async () => {
  const s = await mk({ schoolId: 'F-1' });
  await act(s.id, 'flag');
  const res = await scan('F-1');
  assert.equal(res.body.result, 'review');
  assert.equal(res.body.verdict, 'REVIEW');
  assert.equal(res.body.fare, 'Full fare');
  assert.ok((await emails()).some((e) => e.subject === 'Fraud alert — scan flagged for review'));
  assert.equal(await counter(s.id), 0, 'only granted scans count');
});

test('pending, expired and QR-deactivated passes are denied; only expiry emails the student', async () => {
  const p = await mk({ schoolId: 'P-1' });
  await ctx.pool.query("UPDATE students SET status = 'pending' WHERE id = ?", [p.id]);
  const pending = await scan('P-1');
  assert.equal(pending.body.result, 'denied');
  assert.equal(pending.body.reason, 'registrar approval pending');

  const e = await mk({ schoolId: 'E-1' });
  await act(e.id, 'revoke');
  const expired = await scan('E-1');
  assert.equal(expired.body.result, 'denied');
  assert.match(expired.body.reason, /^pass expired/);
  assert.equal((await emails()).filter((m) => m.subject === 'Discount denied — pass expired').length, 1);

  const q = await mk({ schoolId: 'Q-1' });
  await act(q.id, 'deactivate-qr');
  const off = await scan('Q-1');
  assert.equal(off.body.result, 'denied');
  assert.equal(off.body.reason, 'QR code deactivated by registrar');
  assert.equal((await scans()).total, 3);
});

test('a regenerated QR invalidates the old code but bare School ID entry still works', async () => {
  const s = await mk({ schoolId: 'R-1' });
  await act(s.id, 'regenerate-qr');
  const old = await scan('R-1::v1');
  assert.equal(old.body.result, 'denied');
  assert.match(old.body.reason, /replaced by a newer version/);
  assert.equal((await scan('R-1::v2')).body.result, 'granted');
  assert.equal((await scan('R-1')).body.result, 'granted');
});

test('empty pass id is a 400', async () => {
  assert.equal((await post('scan', { passId: '   ' })).status, 400);
  assert.equal((await post('scan', {})).status, 400);
  assert.equal((await ctx.api.post('/api/verify/scan').send({ passId: 'x' })).status, 401);
});

test('enrolled student: QR step returns face_required and logs nothing until the face check settles', async () => {
  const s = await mk({ schoolId: 'FC-1', faceDescriptor: desc(0.1), facePhoto: PHOTO });
  const step1 = await scan('FC-1');
  assert.equal(step1.body.status, 'face_required');
  assert.equal(step1.body.result, 'granted');
  assert.equal(step1.body.verdict, 'REVIEW');
  assert.equal(step1.body.scan, null);
  assert.equal((await scans()).total, 0);

  const ok = await post('face', { passId: 'FC-1', descriptor: desc(0.11) });
  assert.equal(ok.body.status, 'final');
  assert.equal(ok.body.result, 'granted');
  assert.equal(ok.body.match, true);
  assert.match(ok.body.reason, /^face match \d+% confidence$/);
  assert.equal(await counter(s.id), 1);
  assert.equal((await scans()).total, 1);
});

test('face mismatch → review at full fare, logged once, student emailed', async () => {
  const s = await mk({ schoolId: 'FC-2', faceDescriptor: desc(0.1), facePhoto: PHOTO });
  const res = await post('face', { passId: 'FC-2', descriptor: desc(0.5) });
  assert.equal(res.body.result, 'review');
  assert.equal(res.body.match, false);
  assert.equal(res.body.reason, 'face verification failed — possible identity mismatch');
  assert.equal(res.body.fare, 'Full fare');
  assert.equal(await counter(s.id), 0);
  assert.equal((await scans()).total, 1);
  assert.ok((await emails()).some((e) => e.subject === 'Identity check failed at boarding'));
});

test('face endpoints refuse passes that failed the QR check or have no face enrolled, without logging', async () => {
  const flagged = await mk({ schoolId: 'FC-3', faceDescriptor: desc(0.1), facePhoto: PHOTO });
  await act(flagged.id, 'flag');
  const a = await post('face', { passId: 'FC-3', descriptor: desc(0.1) });
  assert.equal(a.status, 409);
  assert.equal(a.body.details.result, 'review');
  await mk({ schoolId: 'FC-4' });
  assert.equal((await post('face', { passId: 'FC-4', descriptor: desc(0.1) })).status, 409);
  assert.equal((await post('face', { passId: 'GHOST', descriptor: desc(0.1) })).status, 404);
  assert.equal((await post('face', { passId: 'FC-3', descriptor: [1, 2] })).status, 400);
  assert.equal((await scans()).total, 0);
});

test('manual override grants with an audit note; faceUnavailable falls back to QR-only', async () => {
  await mk({ schoolId: 'FC-5', faceDescriptor: desc(0.1), facePhoto: PHOTO });
  const skip = await post('face-skip', { passId: 'FC-5' });
  assert.equal(skip.body.result, 'granted');
  assert.equal(skip.body.reason, 'face verification skipped — manual registrar override');

  const fallback = await scan('FC-5', { faceUnavailable: true });
  assert.equal(fallback.body.status, 'final');
  assert.equal(fallback.body.result, 'granted');
  assert.match(fallback.body.reason, /verification unavailable this session/);
});

test('scan by face identifies the closest enrolled student under the threshold', async () => {
  const a = await mk({ schoolId: 'ID-A', faceDescriptor: desc(0.1), facePhoto: PHOTO });
  await mk({ schoolId: 'ID-B', faceDescriptor: desc(0.4), facePhoto: PHOTO });
  const hit = await post('identify', { descriptor: desc(0.405) });
  assert.equal(hit.body.result, 'granted');
  assert.equal(hit.body.student.schoolId, 'ID-B');
  assert.equal(hit.body.match, true);
  assert.equal(JSON.stringify(hit.body).includes('descriptor'), false);

  const miss = await post('identify', { descriptor: desc(0.9) });
  assert.equal(miss.body.result, 'unknown');
  assert.equal(miss.body.match, false);
  assert.equal((await scans()).total, 1, 'a failed identification is not logged');

  await act(a.id, 'flag');
  const flagged = await post('identify', { descriptor: desc(0.1) });
  assert.equal(flagged.body.result, 'review');
});

test('identify with nobody enrolled reports no match', async () => {
  await mk({ schoolId: 'NOFACE' });
  const res = await post('identify', { descriptor: desc(0.1) });
  assert.equal(res.body.result, 'unknown');
});
