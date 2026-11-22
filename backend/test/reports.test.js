'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, reset, login, auth, studentPayload, scanId } = require('./helpers');
const { startOfLocalDay, displayParts, tzOffsetMinutes } = require('../src/lib/time');
const { grantedFare } = require('../src/lib/fare');

let ctx; let token;
before(async () => { ctx = await setup(); });
beforeEach(async () => { await reset(ctx.pool); token = await login(ctx.api); });
after(() => ctx.pool.end());

const get = (p) => ctx.api.get(p).set(auth(token));
const mk = async (over) => (await ctx.api.post('/api/students').set(auth(token)).send(studentPayload(over))).body.student;
const scan = (schoolId) => scanId(ctx.api, token, schoolId);

test('time helpers use the configured timezone (Asia/Manila, UTC+8, no DST)', () => {
  const d = new Date('2026-08-05T23:30:00Z'); // 06 Aug 07:30 in Manila
  assert.equal(tzOffsetMinutes(d), 480);
  assert.equal(startOfLocalDay(d).toISOString(), '2026-08-05T16:00:00.000Z');
  assert.deepEqual(displayParts(d), { day: 'Thu', date: '06 Aug 2026', time: '07:30:00', dateWithDay: 'Thu, 06 Aug 2026' });
  assert.equal(displayParts(new Date('2026-09-15T00:00:00Z')).date, '15 Sep 2026');
});

test('fare math: 16.25 full fare with 20% off is exactly 13.00', () => {
  assert.deepEqual(grantedFare(true), { text: '₱13.00 (−20%)', amount: 13, discount: 3.25 });
});

test('dashboard KPIs count today\'s scans and compare with yesterday', async () => {
  await mk({ schoolId: 'K-1' });
  const flagged = await mk({ schoolId: 'K-2' });
  await ctx.api.post(`/api/students/${flagged.id}/actions/flag`).set(auth(token));
  const expired = await mk({ schoolId: 'K-3' });
  await ctx.api.post(`/api/students/${expired.id}/actions/revoke`).set(auth(token));
  await scan('K-1'); await scan('K-1'); await scan('K-2'); await scan('K-3');
  // one granted scan yesterday (Manila time)
  const y = new Date(startOfLocalDay(new Date()).getTime() - 3600_000);
  await ctx.pool.query(
    `INSERT INTO scans (student_id, student_name, school_id, fare, fare_amount, discount_amount, result, scanned_at)
     VALUES (NULL, 'Old', 'OLD-1', '₱13.00 (−20%)', 13, 3.25, 'granted', ?)`, [y]);

  const res = await get('/api/dashboard');
  assert.equal(res.status, 200);
  const k = Object.fromEntries(res.body.kpis.map((x) => [x.label, x]));
  assert.equal(k['Verified today'].value, '2');
  assert.equal(k['Verified today'].delta, '+100.0%');
  assert.equal(k['Discount released'].value, '₱6.5');
  assert.equal(k['Denied / expired'].value, '1');
  assert.equal(k['Denied / expired'].note, '25.0% of scans');
  assert.equal(k['Fraud reviews'].value, '1');
  assert.equal(k['Fraud reviews'].delta, '+1');
  assert.equal(res.body.feed.length, 5, 'feed is the latest scans regardless of day');
  assert.equal(res.body.raw.yesterday.granted, 1);
});

test('weekly report returns 7 buckets ending today, with counts in the right day', async () => {
  await mk({ schoolId: 'W-1' });
  await scan('W-1');
  const twoDaysAgo = new Date(startOfLocalDay(new Date()).getTime() - 2 * 86400_000 + 3600_000 * 10);
  await ctx.pool.query(
    `INSERT INTO scans (student_name, school_id, fare, result, scanned_at) VALUES ('X', 'X-1', 'Full fare', 'denied', ?)`, [twoDaysAgo]);
  const { days } = (await get('/api/reports/weekly')).body;
  assert.equal(days.length, 7);
  assert.equal(days[6].granted, 1);
  assert.equal(days[4].denied, 1);
  assert.equal(days.reduce((n, d) => n + d.granted + d.denied + d.review, 0), 2);
  assert.equal(days[6].date, displayDateISO(new Date()));
});

function displayDateISO(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p;
}

test('scan history filters by result, text and date range, and reports totals', async () => {
  await mk({ schoolId: 'S-1', name: 'Zed Zebra' });
  const bad = await mk({ schoolId: 'S-2', name: 'Yan Yak' });
  await ctx.api.post(`/api/students/${bad.id}/actions/revoke`).set(auth(token));
  await scan('S-1'); await scan('S-2');
  const all = (await get('/api/scans')).body;
  assert.equal(all.total, 2);
  assert.equal(all.overall, 2);
  assert.equal((await get('/api/scans?result=denied')).body.total, 1);
  const q = (await get('/api/scans?q=zebra')).body;
  assert.equal(q.total, 1);
  assert.equal(q.overall, 2);
  assert.equal(q.items[0].schoolId, 'S-1');
  assert.equal((await get('/api/scans?q=Verification')).body.total, 2);
  assert.equal((await get('/api/scans?from=2999-01-01')).body.total, 0);
  assert.equal((await get('/api/scans?result=weird')).status, 400);
  assert.equal((await get('/api/scans?limit=1')).body.items.length, 1);
});

test('live feed is newest-first with a limit', async () => {
  await mk({ schoolId: 'L-1' });
  for (let i = 0; i < 3; i++) await scan('L-1');
  const { items } = (await get('/api/scans/feed?limit=2')).body;
  assert.equal(items.length, 2);
  assert.ok(items[0].id > items[1].id);
});

test('notification log supports search and paging', async () => {
  await mk({ schoolId: 'N-1', name: 'Nina North' });
  await mk({ schoolId: 'N-2', name: 'Omar Orion' });
  const all = (await get('/api/emails')).body;
  assert.equal(all.total, 2);
  assert.equal((await get('/api/emails?q=nina')).body.total, 1);
  assert.equal((await get('/api/emails?limit=1')).body.items.length, 1);
});

test('operator ledger: seeded rows plus create / update / delete', async () => {
  const list = (await get('/api/operators')).body.items;
  assert.equal(list.length, 4);
  assert.equal(list.find((o) => o.name === 'Metro Bus Consortium').discount, 612400);

  const created = await ctx.api.post('/api/operators').set(auth(token)).send({ name: 'New Ferry Co', trips: 10, discount: 99.5, status: 'For review' });
  assert.equal(created.status, 201);
  const id = created.body.operator.id;
  assert.equal((await ctx.api.post('/api/operators').set(auth(token)).send({ name: 'New Ferry Co' })).status, 409);
  assert.equal((await ctx.api.post('/api/operators').set(auth(token)).send({ name: 'Bad', status: 'Nope' })).status, 400);

  const upd = await ctx.api.patch(`/api/operators/${id}`).set(auth(token)).send({ status: 'Cleared', trips: 25 });
  assert.equal(upd.body.operator.status, 'Cleared');
  assert.equal(upd.body.operator.trips, 25);
  assert.equal((await ctx.api.patch('/api/operators/99999').set(auth(token)).send({ trips: 1 })).status, 404);
  assert.equal((await ctx.api.delete(`/api/operators/${id}`).set(auth(token))).status, 204);
  assert.equal((await ctx.api.delete(`/api/operators/${id}`).set(auth(token))).status, 404);
});

test('unknown API routes return JSON 404 and malformed JSON returns 400', async () => {
  assert.equal((await get('/api/nope')).status, 404);
  const bad = await ctx.api.post('/api/auth/login').set('Content-Type', 'application/json').send('{oops');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'Malformed JSON body');
});
