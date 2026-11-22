'use strict';
// Admin modules, groups 7-12: announcements, notifications, refunds / cancellation, settings, suspicious activity, backups.
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-mod2-up-'));
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-mod2-bk-'));
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { setup, reset, login, auth, studentPayload, config } = require('./helpers');
const backups = require('../src/services/backups');
const notificationsSvc = require('../src/services/notifications');

let ctx, admin;
before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await reset(ctx.pool);
  for (const f of fs.readdirSync(process.env.BACKUP_DIR)) fs.rmSync(path.join(process.env.BACKUP_DIR, f), { force: true });
  admin = await login(ctx.api);
});
after(async () => { await ctx.pool.end(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true }); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const A = '/api/admin';
const aget = (p, t = admin) => ctx.api.get(A + p).set(auth(t));
const apost = (p, b, t = admin) => ctx.api.post(A + p).set(auth(t)).send(b || {});
const apatch = (p, b, t = admin) => ctx.api.patch(A + p).set(auth(t)).send(b || {});
const adel = (p, t = admin) => ctx.api.delete(A + p).set(auth(t));
const sql = async (q, a) => (await ctx.pool.query(q, a))[0];
const audit = async (action) => (await sql('SELECT * FROM activity_logs WHERE action = ? ORDER BY id DESC', [action]))[0];

let dn = 0;
async function driver(over = {}) {
  dn += 1;
  const body = { name: `Driver ${dn}`, username: `driver${dn}`, email: `driver${dn}@example.com`, password: 'driver-pass-1', status: 'active', ...over };
  const res = await ctx.api.post(`${A}/drivers`).set(auth(admin)).send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const tok = (await ctx.api.post('/api/auth/login').send({ username: body.username, password: body.password })).body.token;
  return { ...res.body.driver, token: tok };
}
async function activeStudent() {
  const created = await ctx.api.post('/api/students').set(auth(admin)).send(studentPayload({ status: 'active' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.student;
}
/** A student with a portal login (so they can read their own notifications). */
async function portalStudent() {
  const body = { ...studentPayload(), campus: 'Main', section: 'A', password: 'secret-pass-1', confirm: 'secret-pass-1' };
  const reg = await ctx.api.post('/api/student-portal/register').send(body);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  await ctx.api.post(`${A}/verifications/${reg.body.student.id}/approve`).set(auth(admin)).send({});
  const token = (await ctx.api.post('/api/student-portal/login').send({ schoolId: body.schoolId, password: body.password })).body.token;
  return { id: reg.body.student.id, name: body.name, schoolId: body.schoolId, t: auth(token) };
}
const myNotes = (s, q = '') => ctx.api.get(`/api/student-portal/me/notifications${q}`).set(s.t);
async function ride(d, s, headers = {}) {
  if (!s.qrIssued) { await ctx.api.post(`/api/students/${s.id}/actions/regenerate-qr`).set(auth(admin)); s.qrIssued = true; }
  return ctx.api.post('/api/scanner/lookup').set(auth(d.token)).set(headers).send({ schoolId: s.schoolId });
}

/* ================================================================== 7. announcements */

test('announcements: draft, publish, edit, deactivate, delete - students only see what is published to them', async () => {
  const s = await portalStudent(); const d = await driver();
  assert.equal((await apost('/announcements', { title: '', body: 'x' })).status, 400);
  assert.equal((await apost('/announcements', { title: 'Bad', body: 'x', publish: 'now', expiresAt: new Date(Date.now() - 1000).toISOString() })).status, 400, 'expiry in the past');
  assert.equal((await apost('/announcements', { title: 'Bad', body: 'x', publishAt: new Date(Date.now() + 7200000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() })).status, 400, 'expires before it is published');
  const draft = (await apost('/announcements', { title: 'Route change', body: 'Bus 4 now stops at Gate 2.', audience: 'all' })).body.announcement;
  assert.equal(draft.status, 'draft');
  assert.equal((await myNotes(s)).body.items.filter((i) => i.kind === 'announcement').length, 0, 'drafts are invisible');
  const pub = await apost(`/announcements/${draft.id}/publish`);
  assert.equal(pub.body.announcement.status, 'published');
  assert.ok(pub.body.announcement.sentAt);
  assert.equal((await apost(`/announcements/${draft.id}/publish`)).status, 409);
  const seen = (await myNotes(s)).body.items.find((i) => i.kind === 'announcement');
  assert.equal(seen.title, 'Route change');
  assert.equal(seen.read, false);
  assert.ok((await ctx.api.get('/api/driver/notifications').set(auth(d.token))).body.items.some((n) => n.title === 'Route change'), 'drivers are notified too');
  const sent = (await apost(`/announcements/${draft.id}/send`)).body.sent;
  assert.deepEqual(sent, { students: 0, drivers: 0 }, 'sending again never duplicates a notification');
  assert.equal((await apatch(`/announcements/${draft.id}`, { title: 'Route change (updated)' })).body.announcement.title, 'Route change (updated)');
  assert.equal((await myNotes(s)).body.items.find((i) => i.kind === 'announcement').title, 'Route change (updated)');
  assert.equal((await aget('/announcements?status=published')).body.total, 1);
  assert.equal((await aget('/announcements?q=gate')).body.total, 1);
  const off = await apost(`/announcements/${draft.id}/deactivate`);
  assert.equal(off.body.announcement.status, 'deactivated');
  assert.equal((await myNotes(s)).body.items.filter((i) => i.kind === 'announcement').length, 0, 'deactivated = hidden from students');
  assert.equal((await apost(`/announcements/${draft.id}/deactivate`)).status, 409);
  await apost(`/announcements/${draft.id}/publish`);
  assert.equal((await adel(`/announcements/${draft.id}`)).status, 200);
  assert.equal((await aget('/announcements')).body.total, 0);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM notifications WHERE announcement_id = ?', [draft.id]))[0].n, 0);
  assert.equal((await adel(`/announcements/${draft.id}`)).status, 404);
  assert.ok(await audit('announcement.delete'));
});

test('announcements: audience, scheduled publishing and expiration', async () => {
  const s = await portalStudent(); const d = await driver();
  const drv = (await apost('/announcements', { title: 'Drivers only', body: 'Depot meeting at 5.', audience: 'drivers', publish: 'now' })).body.announcement;
  assert.equal((await myNotes(s)).body.items.filter((i) => i.kind === 'announcement').length, 0, 'a drivers-only announcement is not shown to students');
  assert.ok((await ctx.api.get('/api/driver/notifications').set(auth(d.token))).body.items.some((n) => n.announcementId === drv.id));
  const stu = (await apost('/announcements', { title: 'Students only', body: 'Enrollment reminder.', audience: 'students', publish: 'now' })).body.announcement;
  assert.equal((await ctx.api.get('/api/driver/notifications').set(auth(d.token))).body.items.filter((n) => n.announcementId === stu.id).length, 0);
  assert.equal((await myNotes(s)).body.items.filter((i) => i.kind === 'announcement').length, 1);
  // scheduled: not live until its time, then goes live by itself
  const soon = (await apost('/announcements', { title: 'Later', body: 'Scheduled one.', audience: 'students', publishAt: new Date(Date.now() + 3600000).toISOString() })).body.announcement;
  assert.equal(soon.status, 'scheduled');
  assert.equal((await myNotes(s)).body.items.filter((i) => i.title === 'Later').length, 0);
  await sql('UPDATE announcements SET publish_at = ? WHERE id = ?', [new Date(Date.now() - 1000), soon.id]);
  assert.equal((await aget('/announcements?status=published')).body.items.find((a) => a.id === soon.id).status, 'published', 'due announcements are published automatically');
  assert.equal((await myNotes(s)).body.items.filter((i) => i.title === 'Later').length, 1);
  // expiry
  await sql('UPDATE announcements SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000), soon.id]);
  assert.equal((await aget('/announcements?status=expired')).body.items[0].id, soon.id);
  assert.equal((await myNotes(s)).body.items.filter((i) => i.title === 'Later').length, 0, 'expired announcements disappear');
  assert.equal((await apost(`/announcements/${soon.id}/publish`)).status, 409, 'cannot re-publish an expired one');
  assert.equal((await aget('/announcements?audience=drivers')).body.total, 1);
});

/* ================================================================== 8. notifications */

test('notifications: student and driver messages, read / unread, delivery, history and filters', async () => {
  const s = await portalStudent(); const d = await driver();
  assert.equal((await apost('/notifications', { audience: 'selected_students', studentIds: [s.id], title: 'Hello', body: '' })).status, 400);
  assert.equal((await apost('/notifications', { audience: 'selected_students', studentIds: [], title: 'Hello', body: 'x' })).status, 400);
  assert.equal((await apost('/notifications', { audience: 'selected_students', studentIds: ['NOPE'], title: 'Hello', body: 'x' })).status, 400);
  const sent = await apost('/notifications', { audience: 'selected_students', studentIds: [s.id], title: 'Bring your ID', body: 'Please bring your student ID tomorrow.' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.sent, 1);
  const mine = (await myNotes(s)).body.items.find((i) => i.title === 'Bring your ID');
  assert.ok(mine && !mine.read, 'it reached the student portal inbox');
  let row = (await aget('/notifications?q=Bring')).body.items[0];
  assert.equal(row.recipientType, 'student');
  assert.equal(row.read, false);
  assert.equal(row.delivery, 'delivered');
  assert.equal(row.sentBy, config.seedAdmin.name);
  await ctx.api.post(`/api/student-portal/me/notifications/${mine.id}/read`).set(s.t);
  row = (await aget('/notifications?q=Bring')).body.items[0];
  assert.equal(row.read, true, 'read state follows the student');
  assert.equal((await aget('/notifications?q=Bring&read=unread')).body.total, 0);
  assert.equal((await aget('/notifications?q=Bring&read=read')).body.total, 1);
  // drivers
  const dsent = await apost('/notifications', { audience: 'selected_drivers', driverIds: [d.id], title: 'Depot change', body: 'Report to depot B.' });
  assert.equal(dsent.body.sent, 1);
  let inbox = (await ctx.api.get('/api/driver/notifications').set(auth(d.token))).body;
  const n = inbox.items.find((x) => x.title === 'Depot change');
  assert.equal(inbox.unread >= 1, true);
  assert.equal((await ctx.api.post(`/api/driver/notifications/${n.id}/read`).set(auth(d.token))).status, 200);
  const other = await driver();
  assert.equal((await ctx.api.post(`/api/driver/notifications/${n.id}/read`).set(auth(other.token))).status, 404, "a driver cannot read another driver's notification");
  assert.equal((await aget('/notifications?recipientType=driver&read=read')).body.items[0].title, 'Depot change');
  assert.equal((await apost('/notifications', { audience: 'drivers', title: 'All drivers', body: 'Safety briefing.' })).body.sent, 2);
  assert.equal((await ctx.api.get('/api/driver/notifications').set(s.t)).status, 401);
  const stats = (await aget('/notifications/stats')).body;
  assert.ok(stats.students >= 1 && stats.drivers >= 3);
  assert.equal((await aget('/notifications?category=general')).body.items.every((i) => i.category === 'general'), true);
  assert.equal((await aget('/notifications?delivery=failed')).body.total, 0);
  await sql("UPDATE email_log SET status = 'failed' WHERE id = ?", [(await sql('SELECT email_log_id FROM notifications WHERE title = ?', ['Bring your ID']))[0].email_log_id]);
  assert.equal((await aget('/notifications?delivery=failed')).body.items[0].delivery, 'failed', 'delivery failures are visible');
});

test('notifications: account status, QR code expiry and eligibility expiry are generated once', async () => {
  const s = await portalStudent(); const d = await driver();
  // account status (drivers)
  await apost(`/drivers/${d.id}/actions/deactivate`);
  assert.ok((await aget('/notifications?category=account_status&recipientType=driver')).body.items.some((n) => /deactivated/.test(n.title)));
  // account status (students) - decisions made elsewhere are still in the history
  assert.ok((await aget('/notifications?category=account_status&recipientType=student')).body.items.some((n) => /approved/i.test(n.title)));
  // QR expiry
  const issue = await ctx.api.post('/api/student-portal/me/qr').set(s.t);
  assert.equal([200, 201].includes(issue.status), true, JSON.stringify(issue.body));
  await sql("UPDATE qr_codes SET expires_at = ? WHERE student_id = ? AND status = 'active'", [new Date(Date.now() + 3 * 86400000), s.id]);
  const first = (await apost('/notifications/generate')).body;
  assert.equal(first.qrExpiry, 1);
  assert.equal((await apost('/notifications/generate')).body.qrExpiry, 0, 'never repeated');
  assert.ok((await myNotes(s)).body.items.some((i) => /QR code expires soon/.test(i.title)));
  assert.equal((await aget('/notifications?category=qr_expiry')).body.total, 1);
  // eligibility expiry: valid until in 10 days
  const soon = new Date(Date.now() + 10 * 86400000);
  const label = `${String(soon.getUTCDate()).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][soon.getUTCMonth()]} ${soon.getUTCFullYear()}`;
  await sql('UPDATE students SET valid_until = ? WHERE id = ?', [label, s.id]);
  assert.equal((await apost('/notifications/generate')).body.eligibilityExpiry, 1);
  assert.equal((await apost('/notifications/generate')).body.eligibilityExpiry, 0);
  assert.equal((await aget('/notifications?category=eligibility_expiry')).body.total, 1);
  assert.equal((await sql("SELECT COUNT(*) AS n FROM email_log WHERE student_id = ? AND subject = 'Your student discount expires soon'", [s.id]))[0].n, 1, "the portal's own reminder does not duplicate it");
  await myNotes(s);
  assert.equal((await sql("SELECT COUNT(*) AS n FROM email_log WHERE student_id = ? AND subject = 'Your student discount expires soon'", [s.id]))[0].n, 1);
  // switching account-status notifications off in Settings is respected
  await apatch('/settings', { 'notifications.accountStatus': false });
  await apost(`/drivers/${d.id}/actions/activate`);
  assert.equal((await aget('/notifications?q=active%20again')).body.total, 0);
  assert.equal(notificationsSvc.CATEGORIES.includes('qr_expiry'), true);
});

/* ================================================================== 9. refunds and cancellation */

async function paidTransaction() {
  const d = await driver(); const s = await activeStudent();
  const r = await ride(d, s);
  assert.equal(r.body.code, 'VERIFIED_STUDENT', JSON.stringify(r.body));
  return { d, s, scanId: r.body.scan.id };
}

test('refunds: record, review details, approve / reject with authorization, reasons, history, and the admin is identified', async () => {
  const { s, scanId } = await paidTransaction();
  const txns = (await aget('/refunds/transactions')).body;
  assert.equal(txns.total, 1);
  assert.equal(txns.items[0].refund, null);
  assert.equal((await apost('/refunds', { scanId, reason: 'no' })).status, 400, 'reason needs substance');
  assert.equal((await apost('/refunds', { scanId, amount: 999, reason: 'Charged twice on the bus' })).status, 400, 'more than the fare');
  assert.equal((await apost('/refunds', { scanId: 99999, reason: 'Charged twice on the bus' })).status, 404);
  const made = await apost('/refunds', { scanId, reason: 'Charged twice on the bus' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.refund.id;
  assert.equal(made.body.refund.amount, 13);
  assert.equal(made.body.refund.status, 'pending');
  assert.equal(made.body.transaction.refund.status, 'pending');
  assert.equal((await apost('/refunds', { scanId, reason: 'Charged twice on the bus' })).status, 409, 'one open refund per transaction');
  const detail = (await aget(`/refunds/${id}`)).body;
  assert.equal(detail.refund.requestedBy, config.seedAdmin.name);
  assert.equal(detail.transaction.schoolId, s.schoolId);
  // authorization
  assert.equal((await apost(`/refunds/${id}/decision`, { decision: 'approved' })).status, 400, 'password is required');
  const wrong = await apost(`/refunds/${id}/decision`, { decision: 'approved', password: 'not-my-password' });
  assert.equal(wrong.status, 403);
  assert.equal((await aget(`/refunds/${id}`)).body.refund.status, 'pending', 'a wrong password changes nothing');
  assert.equal((await apost(`/refunds/${id}/decision`, { decision: 'rejected', password: config.seedAdmin.password })).status, 400, 'rejecting needs a reason');
  const ok = await apost(`/refunds/${id}/decision`, { decision: 'approved', reason: 'Duplicate charge confirmed', password: config.seedAdmin.password });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.refund.status, 'approved');
  assert.equal(ok.body.refund.decidedBy, config.seedAdmin.name);
  assert.ok(ok.body.refund.decidedAt);
  assert.equal((await apost(`/refunds/${id}/decision`, { decision: 'rejected', reason: 'changed mind', password: config.seedAdmin.password })).status, 409, 'a decision is final');
  assert.equal((await apost('/refunds', { scanId, reason: 'Charged twice on the bus' })).status, 409, 'an approved refund also blocks a new one');
  const log = await audit('refund.approve');
  assert.equal(log.actor_name, config.seedAdmin.name);
  assert.equal(log.admin_id !== null, true);
  assert.ok((await sql("SELECT 1 FROM email_log WHERE student_id = ? AND subject LIKE '%refund request was approved%'", [s.id])).length, 'the student is told');
  assert.equal((await aget('/refunds?status=approved')).body.total, 1);
  assert.equal((await aget('/refunds')).body.counts.approved, 1);
  // a rejected one
  const t2 = await paidTransaction();
  const r2 = (await apost('/refunds', { scanId: t2.scanId, reason: 'Wrong fare shown' })).body.refund;
  const rej = await apost(`/refunds/${r2.id}/decision`, { decision: 'rejected', reason: 'Fare was correct', password: config.seedAdmin.password });
  assert.equal(rej.body.refund.decisionReason, 'Fare was correct');
  assert.equal((await aget('/refunds?q=Wrong')).body.total, 1);
  assert.equal((await apost('/refunds', { scanId: t2.scanId, reason: 'Trying again after a rejection' })).status, 201, 'a rejected request can be raised again');
});

test('cancellation: needs a reason and the administrator password, never deletes the transaction, can happen once, and is in the history', async () => {
  const { s, scanId } = await paidTransaction();
  const before = (await sql('SELECT * FROM scans WHERE id = ?', [scanId]))[0];
  assert.equal((await apost(`/refunds/transactions/${scanId}/cancel`, { reason: 'Test cancel' })).status, 400, 'password required');
  assert.equal((await apost(`/refunds/transactions/${scanId}/cancel`, { reason: 'abc', password: config.seedAdmin.password })).status, 400, 'reason needs substance');
  assert.equal((await apost(`/refunds/transactions/${scanId}/cancel`, { reason: 'Duplicate scan by mistake', password: 'wrong-password' })).status, 403);
  assert.equal((await aget('/refunds/cancellations')).body.total, 0);
  // a pending refund must be decided first
  const rf = (await apost('/refunds', { scanId, reason: 'Charged twice on the bus' })).body.refund;
  assert.equal((await apost(`/refunds/transactions/${scanId}/cancel`, { reason: 'Duplicate scan by mistake', password: config.seedAdmin.password })).status, 409);
  await apost(`/refunds/${rf.id}/decision`, { decision: 'rejected', reason: 'Not needed', password: config.seedAdmin.password });
  const done = await apost(`/refunds/transactions/${scanId}/cancel`, { reason: 'Duplicate scan by mistake', password: config.seedAdmin.password });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.transaction.cancelled, true);
  assert.equal(done.body.transaction.cancelledBy, config.seedAdmin.name);
  assert.deepEqual((await sql('SELECT * FROM scans WHERE id = ?', [scanId]))[0], before, 'the transaction record itself is untouched');
  assert.equal((await sql('SELECT COUNT(*) AS n FROM scans'))[0].n, 1, 'nothing was deleted');
  assert.equal((await apost(`/refunds/transactions/${scanId}/cancel`, { reason: 'Duplicate scan by mistake', password: config.seedAdmin.password })).status, 409, 'only once');
  assert.equal((await apost('/refunds', { scanId, reason: 'Charged twice on the bus' })).status, 409, 'a cancelled transaction cannot be refunded');
  const hist = (await aget('/refunds/cancellations')).body;
  assert.equal(hist.total, 1);
  assert.equal(hist.items[0].cancelReason, 'Duplicate scan by mistake');
  assert.equal((await aget('/refunds/cancellations?q=duplicate')).body.total, 1);
  assert.equal((await aget('/refunds/transactions?state=cancelled')).body.total, 1);
  assert.equal((await aget('/refunds/transactions?state=active')).body.total, 0);
  assert.equal((await aget(`/refunds/transactions?q=${s.schoolId}`)).body.total, 1);
  assert.equal((await aget(`/refunds/transactions?q=TXN-${String(scanId).padStart(8, '0')}`)).body.total, 1);
  assert.equal((await audit('transaction.cancel')).actor_name, config.seedAdmin.name);
  assert.ok((await sql("SELECT 1 FROM email_log WHERE student_id = ? AND subject LIKE '%transaction%cancelled%'", [s.id])).length);
  const ledger = await sql('SELECT * FROM transaction_cancellations');
  assert.equal(ledger.length, 1);
  await assert.rejects(ctx.pool.query('DELETE FROM scans WHERE id = ?', [scanId]), /foreign key/i, 'the database itself refuses to drop a cancelled transaction');
});

/* ================================================================== 10. settings */

test('settings: defaults, validation, persistence, branding, system information and the audit trail', async () => {
  const cur = (await aget('/settings')).body.settings;
  assert.equal(cur['session.idleMinutes'], 30);
  assert.equal(cur['system.hasLogo'], false);
  assert.equal(JSON.stringify(cur).includes('data:image'), false);
  for (const bad of [{ 'session.idleMinutes': 2 }, { 'session.idleMinutes': '30' }, { nope: 1 }, { 'backup.time': '25:00' }, { 'retention.activityLogDays': 10 }, { 'system.name': '' }, { 'backup.frequency': 'hourly' }, { 'system.contactEmail': 'not-an-email' }, { 'system.logo': 'data:x' }, {}]) {
    assert.equal((await apatch('/settings', bad)).status, 400, JSON.stringify(bad));
  }
  const ok = await apatch('/settings', { 'system.name': 'TCC TransitPass', 'session.idleMinutes': 45, 'system.contactEmail': 'ops@tcc.edu.ph', 'retention.activityLogDays': 365, 'notifications.qrDays': 10, 'maintenance.window': 'Sun 1-2 AM' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.settings['system.name'], 'TCC TransitPass');
  assert.equal((await aget('/settings/runtime')).body.idleMinutes, 45);
  assert.equal((await aget('/settings/runtime')).body.name, 'TCC TransitPass');
  const log = await audit('settings.update');
  assert.equal(log.actor_name, config.seedAdmin.name);
  assert.match(log.description, /session\.idleMinutes/);
  // logo
  assert.equal((await ctx.api.post(`${A}/settings/logo`).set(auth(admin)).attach('file', Buffer.from('<?php echo 1;?> not an image'), { filename: 'logo.png' })).status, 400);
  assert.equal((await ctx.api.post(`${A}/settings/logo`).set(auth(admin)).attach('file', Buffer.alloc(300 * 1024, 7), { filename: 'big.png' })).status, 400);
  assert.equal((await ctx.api.post(`${A}/settings/logo`).set(auth(admin)).attach('file', PNG, { filename: 'logo.png' })).status, 200);
  assert.match((await aget('/settings/runtime')).body.logo, /^data:image\/png;base64,/);
  assert.equal((await aget('/settings')).body.settings['system.hasLogo'], true);
  assert.equal((await adel('/settings/logo')).status, 200);
  assert.equal((await aget('/settings/runtime')).body.logo, null);
  const info = (await aget('/settings/system')).body;
  assert.ok(info.node && info.database && info.timezone && info.application);
  assert.equal(typeof info.counts.students, 'number');
});

test('settings: maintenance mode blocks students and drivers but never administrators, and ends when switched off', async () => {
  const s = await portalStudent(); const d = await driver();
  await apatch('/settings', { 'maintenance.enabled': true, 'maintenance.message': 'Back at 3 PM.' });
  const blocked = await ctx.api.post('/api/student-portal/login').send({ schoolId: s.schoolId, password: 'secret-pass-1' });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error, 'Back at 3 PM.');
  assert.equal((await ctx.api.get('/api/driver/me').set(auth(d.token))).status, 503);
  assert.equal((await ctx.api.post('/api/scanner/lookup').set(auth(d.token)).send({ schoolId: 'x' })).status, 503);
  assert.equal((await aget('/settings')).status, 200, 'administrators keep working');
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: d.username, password: 'driver-pass-1' })).status, 200, 'sign-in itself still works');
  await apatch('/settings', { 'maintenance.enabled': false });
  assert.equal((await ctx.api.get('/api/driver/me').set(auth(d.token))).status, 200);
});

test('settings: the existing administrator profile and password endpoints keep working (reused by the Settings page)', async () => {
  const up = await apatch('/account', { name: 'Ops Lead' }).catch(() => null);
  const upd = await ctx.api.patch(`${A}/account`).set(auth(admin)).send({ name: 'Ops Lead' });
  assert.equal(upd.status, 200);
  const pw = await ctx.api.post(`${A}/account/password`).set(auth(admin)).send({ current: config.seedAdmin.password, new: 'brand-new-pass-1', confirm: 'brand-new-pass-1' });
  assert.equal(pw.status, 200);
  assert.equal((await ctx.api.post('/api/auth/login').send({ username: config.seedAdmin.username, password: 'brand-new-pass-1' })).status, 200);
  assert.ok(up === null || up.status);
});

/* ================================================================== 11. suspicious activity */

test('suspicious: repeated scans, duplicate transactions and multiple devices are flagged once, with evidence', async () => {
  await apatch('/settings', { 'suspicious.offHoursStart': 12, 'suspicious.offHoursEnd': 12 }); // empty off-hours window: the result must not depend on the time of day
  const d = await driver(); const s = await activeStudent();
  for (const dev of ['web-dev-aaaa1', 'web-dev-aaaa1', 'web-dev-bbbb2']) assert.equal((await ride(d, s, { 'X-Device-Id': dev })).status, 200);
  const det = (await apost('/suspicious/detect', {})).body;
  assert.equal(det.byType.repeated_scan, 1);
  assert.equal(det.byType.duplicate_transaction, 2, 'each back-to-back pair');
  assert.equal(det.byType.multi_device, 1);
  assert.equal((await apost('/suspicious/detect', {})).body.newFlags, 0, 'detection is repeatable: no duplicates');
  const list = (await aget('/suspicious')).body;
  assert.equal(list.total, 4);
  assert.equal(list.counts.open, 4);
  assert.equal(list.items[0].severity, 'high', 'most serious first');
  assert.equal((await aget('/suspicious?type=multi_device')).body.total, 1);
  assert.equal((await aget('/suspicious?severity=high')).body.items.every((f) => f.severity === 'high'), true);
  assert.equal((await aget(`/suspicious?q=${encodeURIComponent(s.name.slice(0, 6))}`)).body.total >= 3, true);
  const rep = list.items.find((f) => f.type === 'repeated_scan');
  const detail = (await aget(`/suspicious/${rep.id}`)).body;
  assert.equal(detail.evidence.length, 3, 'the scans involved are shown');
  assert.equal(detail.details.count, 3);
  assert.equal(detail.notes.length, 0);
  const dev = list.items.find((f) => f.type === 'multi_device');
  assert.deepEqual((await aget(`/suspicious/${dev.id}`)).body.details.devices.sort(), ['web-dev-aaaa1', 'web-dev-bbbb2']);
  // review is mandatory before any action
  assert.equal((await apost(`/suspicious/${rep.id}/action`, { action: 'flag_student', note: 'Sharing a pass' })).status, 409, 'cannot act on an unreviewed flag');
  assert.equal((await ctx.api.get(`/api/students/${s.id}`).set(auth(admin))).body.student.status, 'active', 'nothing happened to the account');
  assert.equal((await apost(`/suspicious/${rep.id}/review`, { decision: 'reviewed' })).status, 400, 'a note is required');
  assert.equal((await apost(`/suspicious/${rep.id}/review`, { decision: 'reviewed', note: 'ok' })).status, 400);
  const rev = await apost(`/suspicious/${rep.id}/review`, { decision: 'reviewed', note: 'Scanned three times in a minute; confirmed with the driver.' });
  assert.equal(rev.body.flag.status, 'reviewed');
  assert.equal(rev.body.flag.reviewedBy, config.seedAdmin.name);
  assert.equal(rev.body.notes.length, 1);
  assert.equal((await apost(`/suspicious/${rep.id}/notes`, { note: 'Student contacted by the registrar.' })).body.notes.length, 2);
  assert.equal((await apost(`/suspicious/${rep.id}/action`, { action: 'deactivate_driver', note: 'wrong target here' })).status, 400, 'this flag is about a student, not a driver');
  const act = await apost(`/suspicious/${rep.id}/action`, { action: 'flag_student', note: 'Possible pass sharing' });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  assert.equal(act.body.flag.status, 'actioned');
  assert.equal((await ctx.api.get(`/api/students/${s.id}`).set(auth(admin))).body.student.status, 'flagged');
  assert.equal((await apost(`/suspicious/${rep.id}/action`, { action: 'flag_student', note: 'Possible pass sharing' })).status, 409);
  assert.ok(await audit('suspicious.action'));
  // dismissing a false alarm, and acting against a driver after review
  const dup = list.items.find((f) => f.type === 'duplicate_transaction');
  assert.equal((await apost(`/suspicious/${dup.id}/review`, { decision: 'dismissed', note: 'Student tapped twice, one fare only.' })).body.flag.status, 'dismissed');
  assert.equal((await aget('/suspicious?status=dismissed')).body.total, 1);
  assert.equal((await apost(`/suspicious/${dev.id}/action`, { action: 'deactivate_driver', note: 'Driver shared the account' })).status, 409);
  await apost(`/suspicious/${dev.id}/review`, { decision: 'reviewed', note: 'Two phones used by one driver login.' });
  assert.equal((await apost(`/suspicious/${dev.id}/action`, { action: 'deactivate_driver', note: 'Driver shared the account' })).status, 200);
  assert.equal((await aget('/drivers')).body.items.find((x) => x.id === d.id).status, 'inactive');
  assert.equal((await aget('/suspicious/99999')).status, 404);
});

test('suspicious: unusual scanning (bursts, off-hours) follows the thresholds in Settings', async () => {
  await apatch('/settings', { 'suspicious.offHoursStart': 12, 'suspicious.offHoursEnd': 12 });
  const d = await driver(); const students = [await activeStudent(), await activeStudent(), await activeStudent()];
  for (const s of students) await ride(d, s);
  assert.equal((await apost('/suspicious/detect', {})).body.byType.unusual_activity, 0, 'three scans are normal with the default limit');
  await apatch('/settings', { 'suspicious.burstCount': 3 });
  const burst = (await apost('/suspicious/detect', {})).body;
  assert.equal(burst.byType.unusual_activity, 1);
  assert.match((await aget('/suspicious?type=unusual_activity')).body.items[0].summary, /scanned 3 passes/);
  // off-hours: make "now" off-hours for every hour of the day
  await apatch('/settings', { 'suspicious.offHoursStart': 0, 'suspicious.offHoursEnd': 23 });
  const off = (await apost('/suspicious/detect', {})).body;
  assert.ok(off.byType.unusual_activity >= 1);
  assert.equal((await aget('/suspicious?severity=low')).body.total >= 1, true);
  await apatch('/settings', { 'suspicious.repeatCount': 2, 'suspicious.repeatMinutes': 5 });
  assert.equal((await apost('/suspicious/detect', { hours: 48 })).status, 200);
  assert.equal((await apost('/suspicious/detect', { hours: 0 })).status, 400);
});

/* ================================================================== 12. backups and retention */

test('backups: manual backup is complete, checksummed, stored privately, downloadable only by administrators, and verifiable', async () => {
  await activeStudent(); await driver();
  const res = await apost('/backups');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const b = res.body.backup;
  assert.equal(b.status, 'completed');
  assert.match(b.checksum, /^[a-f0-9]{64}$/);
  assert.ok(b.tables >= 25 && b.rows > 0 && b.sizeBytes > 0);
  assert.equal(b.fileAvailable, true);
  assert.ok(fs.existsSync(path.join(process.env.BACKUP_DIR, b.filename)));
  assert.ok(fs.existsSync(path.join(process.env.BACKUP_DIR, `${b.filename}.sha256`)));
  assert.equal((fs.statSync(path.join(process.env.BACKUP_DIR, b.filename)).mode & 0o077), 0, 'file is private to its owner');
  // not reachable through any public URL
  assert.equal(backups.dir().startsWith(path.resolve(config.frontendDir)), false);
  for (const u of [`/${b.filename}`, `/backups/${b.filename}`, `/api/backups/${b.filename}`, `/../backups/${b.filename}`]) assert.ok([401, 404].includes((await ctx.api.get(u)).status), u);
  // download: administrators only
  assert.equal((await ctx.api.get(`${A}/backups/${b.id}/download`)).status, 401);
  const someDriver = await driver();   // (created before building the request: supertest binds its server when the request is built)
  assert.equal((await ctx.api.get(`${A}/backups/${b.id}/download`).set(auth(someDriver.token))).status, 403);
  const dl = await ctx.api.get(`${A}/backups/${b.id}/download`).set(auth(admin)).buffer(true).parse((r, cb) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => cb(null, Buffer.concat(c))); });
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-disposition'], /attachment/);
  assert.equal(dl.headers['cache-control'], 'private, no-store');
  const sqlText = zlib.gunzipSync(dl.body).toString('utf8');
  assert.match(sqlText, /CREATE TABLE `students`/);
  assert.match(sqlText, /INSERT INTO `admins`/);
  assert.ok(await audit('backup.download'));
  assert.equal((await ctx.api.get(`${A}/backups/abc/download`).set(auth(admin))).status, 404);
  // status + history
  const st = (await aget('/backups/status')).body;
  assert.equal(st.health, 'ok');
  assert.equal(st.stored, 1);
  assert.equal(st.lastSuccessful.id, b.id);
  assert.equal((await aget('/backups')).body.total, 1);
  assert.equal((await aget('/backups?status=failed')).body.total, 0);
  // verify, then damage the file and verify again
  assert.equal((await apost(`/backups/${b.id}/verify`)).body.ok, true);
  fs.appendFileSync(path.join(process.env.BACKUP_DIR, b.filename), Buffer.from([1, 2, 3]));
  const bad = (await apost(`/backups/${b.id}/verify`)).body;
  assert.equal(bad.ok, false);
  assert.match(bad.result, /checksum/);
  // one backup at a time
  await sql("INSERT INTO backup_history (backup_type, status, created_by_name) VALUES ('manual', 'running', 'x')");
  assert.equal((await apost('/backups')).status, 409);
});

test('backups: a backup restores into an empty database with the same data (recovery procedure), and a damaged file is refused', async () => {
  const s = await activeStudent(); const d = await driver();
  await ride(d, s);
  const v = (await apost('/vehicles', { name: 'Restore Bus', type: 'Bus', plateNumber: 'RST 111', capacity: 30 })).body.vehicle;
  await apost('/announcements', { title: 'Quote \'single\' "double" \\ back', body: 'Line one\nLine two ₱ ünïcode 🚌', publish: 'now' });
  const b = (await apost('/backups')).body.backup;
  const file = path.join(process.env.BACKUP_DIR, b.filename);
  const scratch = 'tp_restore_check';
  const env = { ...process.env };
  const script = path.join(__dirname, '..', 'scripts', 'restore-backup.js');
  const dry = spawnSync('node', [script, file, '--database', scratch], { env, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Checksum OK/);
  assert.match(dry.stdout, /Dry run only/);
  const run = spawnSync('node', [script, file, '--database', scratch, '--yes', '--no-safety-backup'], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const conn = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: scratch, dateStrings: true });
  try {
    for (const t of ['students', 'admins', 'scans', 'vehicles', 'announcements', 'qr_codes', 'email_log', 'notifications']) {
      const [[a]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
      const [[o]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
      assert.equal(a.n, o.n, `${t} row count`);
    }
    const [[veh]] = await conn.query('SELECT * FROM vehicles WHERE id = ?', [v.id]);
    assert.equal(veh.plate_number, 'RST 111');
    const [[ann]] = await conn.query('SELECT title, body FROM announcements LIMIT 1');
    assert.equal(ann.title, 'Quote \'single\' "double" \\ back', 'special characters survive');
    assert.equal(ann.body, 'Line one\nLine two ₱ ünïcode 🚌');
    const [[orig]] = await ctx.pool.query('SELECT scanned_at FROM scans LIMIT 1');
    const [[copy]] = await conn.query('SELECT scanned_at FROM scans LIMIT 1');
    assert.equal(new Date(String(copy.scanned_at).replace(' ', 'T') + 'Z').getTime(), new Date(orig.scanned_at).getTime(), 'timestamps are identical');
    const [fks] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'", [scratch]);
    assert.ok(fks[0].n > 20, 'foreign keys were restored');
  } finally { await conn.end(); }
  // damaged file: restore refuses
  fs.appendFileSync(file, Buffer.from([9, 9, 9]));
  const refuse = spawnSync('node', [script, file, '--database', scratch, '--yes', '--no-safety-backup'], { env, encoding: 'utf8' });
  assert.equal(refuse.status, 1);
  assert.match(refuse.stderr, /Checksum mismatch/);
  const root = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password });
  await root.query(`DROP DATABASE IF EXISTS \`${scratch}\``); await root.end();
});

test('backups: scheduled backups run once when due, and retention keeps what it should and never touches transactions', async () => {
  const s = await activeStudent(); const d = await driver(); await ride(d, s);
  assert.equal((await backups.tick(ctx.pool)).ran, false, 'scheduling is off by default');
  assert.equal((await apatch('/settings', { 'backup.enabled': true, 'backup.time': '00:00', 'backup.frequency': 'daily' })).status, 200);
  const t1 = await backups.tick(ctx.pool);
  assert.equal(t1.ran, true);
  assert.equal(t1.backup.type, 'scheduled');
  assert.equal(t1.backup.createdBy, 'Scheduler');
  assert.equal((await backups.tick(ctx.pool)).ran, false, 'not twice on the same day');
  assert.equal((await aget('/backups/status')).body.schedule.enabled, true);
  // retention
  await apatch('/settings', { 'backup.keepCount': 1, 'backup.keepDays': 1, 'retention.activityLogDays': 90 });
  const b2 = (await apost('/backups')).body.backup; const b3 = (await apost('/backups')).body.backup;
  await sql("UPDATE backup_history SET finished_at = ? WHERE id <> ?", [new Date(Date.now() - 10 * 86400000), b3.id]);
  await sql("INSERT INTO activity_logs (actor_name, category, action, description, created_at) VALUES ('old', 'system', 'old.entry', 'ancient', ?)", [new Date(Date.now() - 200 * 86400000)]);
  const scansBefore = (await sql('SELECT COUNT(*) AS n FROM scans'))[0].n;
  const dry = (await apost('/backups/retention', { dryRun: true })).body;
  assert.equal(dry.dryRun, true);
  assert.equal(dry.backups, 2, 'two backups are older than the policy');
  assert.equal(dry.activityLogs, 1);
  assert.equal((await aget('/backups?status=completed')).body.total, 3, 'a dry run deletes nothing');
  const real = (await apost('/backups/retention', { dryRun: false })).body;
  assert.equal(real.backups, 2);
  assert.equal(real.activityLogs, 1);
  assert.equal((await aget('/backups?status=completed')).body.total, 1);
  assert.equal((await aget('/backups?status=deleted')).body.total, 2);
  assert.equal(fs.readdirSync(process.env.BACKUP_DIR).filter((f) => f.endsWith('.sql.gz')).length, 1, 'files are removed from disk');
  assert.equal((await sql("SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'old.entry'"))[0].n, 0);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM scans'))[0].n, scansBefore, 'transactions are never purged by retention');
  assert.ok(await audit('retention.apply'));
  assert.equal((await adel(`/backups/${b3.id}`)).status, 409, 'the only remaining backup cannot be deleted');
  const b4 = (await apost('/backups')).body.backup;
  assert.equal((await adel(`/backups/${b2.id}`)).status, 404, 'already deleted');
  const del = await adel(`/backups/${b3.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.backup.status, 'deleted');
  assert.equal(fs.existsSync(path.join(process.env.BACKUP_DIR, b3.filename)), false);
  assert.ok(b4.id);
});

test('backups: the backup folder cannot be placed inside the public web folder', async () => {
  const cfg = require('../src/config');
  const keep = cfg.backups.dir;
  try {
    cfg.backups.dir = path.join(path.resolve(cfg.frontendDir), 'oops');
    assert.throws(() => backups.dir(), /must not be inside the public frontend folder/);
  } finally { cfg.backups.dir = keep; }
});
