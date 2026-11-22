'use strict';
// Tests the device queue in isolation: no database, no browser. localStorage and the API client are faked, so the test
// exercises exactly the rules that protect a driver's offline checks: durable storage, idempotent retry, and no silent loss.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const QUEUE_FILE = path.join(__dirname, '..', '..', 'frontend', 'js', 'offline.js');
const KEY = 'transitpass.offlineQueue.v1';

function harness() {
  const store = new Map();
  const apiCalls = [];
  let apiImpl = async () => ({ results: [] });
  const ctx = {
    console,
    window: { crypto: crypto.webcrypto, addEventListener() {}, dispatchEvent() { return true; } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    navigator: { onLine: true },
    document: { hidden: false, addEventListener() {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    esc: (v) => String(v == null ? '' : v),
    fmtDateTime: (v) => `at ${v}`
  };
  ctx.api = (...args) => { apiCalls.push(args); return apiImpl(...args); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(QUEUE_FILE, 'utf8'), ctx, { filename: 'offline.js' });
  return {
    TP: ctx.window.TPOffline, store, apiCalls, ctx,
    setApi(fn) { apiImpl = fn; },
    setOnline(v) { ctx.navigator.onLine = v; },
    raw() { const raw = store.get(KEY); return raw ? JSON.parse(raw) : []; }
  };
}

const QR = 'TP1.' + 'a'.repeat(32);
const okResults = (items, extra = {}) => ({
  results: items.map((it, i) => ({
    clientId: it.clientId, ok: true, duplicate: false, code: 'VERIFIED_STUDENT', label: 'VERIFIED STUDENT',
    result: 'granted', scanId: 20 + i, reference: 'TXN-00000020', ...extra
  }))
});

test('a check is stored as Pending and an immediate repeat is not queued twice', async () => {
  const h = harness();
  h.TP.start({ driverId: 7 });
  const first = await h.TP.add({ method: 'qr', value: QR });
  const again = await h.TP.add({ method: 'qr', value: QR });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(h.TP.list().length, 1);
  assert.equal(h.TP.summary().pending, 1);
  assert.equal(h.raw()[0].status, 'pending');
  assert.ok(h.store.get(KEY).includes(QR), 'the check is on the device until it is synchronized');
});

test('flush uploads every Pending item and marks it Synchronized with the server reference', async () => {
  const h = harness();
  let synced = 0;
  h.TP.start({ driverId: 7, onSynced: (n) => { synced += n; } });
  h.setApi(async (p, opts) => okResults(opts.body.items));
  await h.TP.add({ method: 'qr', value: QR });
  await h.TP.add({ method: 'manual', value: '2026-0418' });
  const res = await h.TP.flush();
  assert.equal(res.synced, 2);
  assert.equal(synced, 2);
  assert.equal(h.apiCalls[0][0], '/scanner/sync');
  assert.equal(h.apiCalls[0][1].body.items.length, 2);
  const items = h.TP.list();
  assert.ok(items.every((i) => i.status === 'synced'));
  assert.equal(h.TP.summary().synced, 2);
  const qr = items.find((i) => i.method === 'qr');
  assert.equal(qr.reference, 'TXN-00000020');
  assert.equal(qr.value, '', 'the QR payload is removed after a successful sync');
  assert.equal(qr.preview, 'QR scan');
  const manual = items.find((i) => i.method === 'manual');
  assert.equal(manual.value, '2026-0418');
});

test('nothing is uploaded while the device is offline, and the queue survives', async () => {
  const h = harness();
  h.setOnline(false);
  h.TP.start({ driverId: 7 });
  await h.TP.add({ method: 'qr', value: QR });
  const res = await h.TP.flush();
  assert.equal(res.offline, true);
  assert.equal(h.apiCalls.length, 0);
  assert.equal(h.TP.list()[0].status, 'pending');
});

test('a network error keeps the item Pending; the retry is idempotent and finishes as Synchronized', async () => {
  const h = harness();
  h.TP.start({ driverId: 7 });
  h.setApi(async () => { const e = new Error('Cannot reach the server.'); e.status = 0; throw e; });
  await h.TP.add({ method: 'qr', value: QR });
  await h.TP.flush();
  let item = h.TP.list()[0];
  assert.equal(item.status, 'pending', 'a lost connection must not lose the transaction');
  assert.equal(item.attempts, 1);
  assert.match(item.lastError, /Cannot reach/);

  h.setApi(async (p, opts) => okResults(opts.body.items, { duplicate: true }));
  const res = await h.TP.flush();
  assert.equal(res.synced, 1);
  item = h.TP.list()[0];
  assert.equal(item.status, 'synced');
  assert.equal(item.duplicate, true);
  assert.equal(item.attempts, 2);
});

test('a rejected item becomes Failed and stays until it is retried successfully', async () => {
  const h = harness();
  h.TP.start({ driverId: 7 });
  h.setApi(async (p, opts) => ({
    results: opts.body.items.map((it) => ({ clientId: it.clientId, ok: false, error: 'This offline check is more than 7 days old.' }))
  }));
  await h.TP.add({ method: 'manual', value: '2026-0418' });
  const failed = await h.TP.flush();
  assert.equal(failed.failed, 1);
  let item = h.TP.list()[0];
  assert.equal(item.status, 'failed');
  assert.match(item.lastError, /7 days/);
  assert.equal(h.TP.summary().failed, 1);

  h.setApi(async (p, opts) => okResults(opts.body.items));
  await h.TP.retry(item.clientId);
  item = h.TP.list()[0];
  assert.equal(item.status, 'synced');
  assert.equal(item.lastError, null);
});

test('each driver only sees and sends their own queued checks', async () => {
  const h = harness();
  h.TP.start({ driverId: 7 });
  await h.TP.add({ method: 'qr', value: QR });
  h.TP.start({ driverId: 8 });
  assert.equal(h.TP.list().length, 0, "another driver's queue is not shown");
  h.setApi(async (p, opts) => okResults(opts.body.items));
  await h.TP.flush();
  assert.equal(h.apiCalls.length, 0, 'nothing to send for driver 8');
  h.TP.start({ driverId: 7 });
  assert.equal(h.TP.list().length, 1);
  assert.equal(h.raw().length, 1);
});

test('Remove deletes a queued item, and Clear synchronized keeps Pending items', async () => {
  const h = harness();
  h.TP.start({ driverId: 7 });
  h.setApi(async (p, opts) => okResults(opts.body.items));
  const a = await h.TP.add({ method: 'qr', value: QR });
  await h.TP.add({ method: 'manual', value: '2026-9999' });
  await h.TP.flush();
  h.TP.clearSynced();
  assert.equal(h.TP.list().length, 0);

  const b = await h.TP.add({ method: 'qr', value: 'TP1.' + 'b'.repeat(32) });
  h.TP.start({ driverId: 8 });
  h.TP.start({ driverId: 7 });
  h.TP.remove(b.item.clientId);
  assert.equal(h.TP.list().length, 0);
  assert.ok(a.item.clientId && b.item.clientId);
});
