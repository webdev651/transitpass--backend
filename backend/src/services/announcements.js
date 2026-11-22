'use strict';
/*
  Announcement management. Lifecycle: draft -> (scheduled ->) published -> deactivated. `is_active` is the flag the student
  portal already reads, and it is 1 only while the announcement is published, so the portal needs no knowledge of drafts or schedules.
  Publishing also sends a notification to every recipient of the chosen audience (students, drivers or both) - once, even if "send" is repeated.
*/
const { notFound, conflict, badRequest } = require('../lib/httpError');
const { escapeLike } = require('../lib/sql');
const { toDate } = require('../lib/time');
const settings = require('./settings');

const iso = (v) => (v ? toDate(v).toISOString() : null);
const BASE = 'SELECT a.*, ad.name AS created_by_name FROM announcements a LEFT JOIN admins ad ON ad.id = a.created_by';

function present(r, now = new Date()) {
  const expired = r.expires_at && toDate(r.expires_at) <= now;
  return {
    id: r.id, title: r.title, body: r.body, audience: r.audience, state: r.state, status: r.state === 'published' && expired ? 'expired' : r.state,
    publishAt: iso(r.publish_at), publishedAt: iso(r.published_at), expiresAt: iso(r.expires_at), sentAt: iso(r.sent_at),
    createdBy: r.created_by_name || null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
  };
}
async function getRow(db, id) {
  const [rows] = await db.query(`${BASE} WHERE a.id = ?`, [id]);
  if (!rows[0]) throw notFound('Announcement not found');
  return rows[0];
}

/** Scheduled announcements whose time has come go live. Called by the scheduler and whenever the list is opened. */
async function publishDue(pool, now = new Date()) {
  const [due] = await pool.query("SELECT id FROM announcements WHERE state = 'scheduled' AND publish_at <= ?", [now]);
  for (const r of due) {
    const [u] = await pool.query("UPDATE announcements SET state = 'published', is_active = 1, published_at = ? WHERE id = ? AND state = 'scheduled'", [now, r.id]);
    if (u.affectedRows) await send(pool, null, r.id);
  }
  return due.length;
}

async function list(pool, { status, audience, q, limit, offset }) {
  await publishDue(pool);
  const where = [];
  const args = [];
  const now = new Date();
  if (status === 'expired') { where.push("a.state = 'published' AND a.expires_at IS NOT NULL AND a.expires_at <= ?"); args.push(now); }
  else if (status === 'published') { where.push("a.state = 'published' AND (a.expires_at IS NULL OR a.expires_at > ?)"); args.push(now); }
  else if (status && status !== 'all') { where.push('a.state = ?'); args.push(status); }
  if (audience && audience !== 'all') { where.push('a.audience = ?'); args.push(audience); }
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(a.title LIKE ? OR a.body LIKE ?)'); args.push(like, like); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM announcements a ${clause}`, args);
  const [rows] = await pool.query(`${BASE} ${clause} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { total: Number(total), items: rows.map((r) => present(r, now)) };
}

function checkDates({ publishAt, expiresAt }) {
  if (publishAt && expiresAt && expiresAt <= publishAt) throw badRequest('The expiration date must be after the publish date.');
}

async function create(pool, admin, d) {
  checkDates(d);
  const now = new Date();
  if (d.expiresAt && d.expiresAt <= now) throw badRequest('The expiration date is already in the past.');
  const publishNow = d.publish === 'now';
  const scheduled = !publishNow && d.publishAt && d.publishAt > now;
  const state = publishNow ? 'published' : scheduled ? 'scheduled' : 'draft';
  const [res] = await pool.query(
    'INSERT INTO announcements (title, body, audience, state, is_active, publish_at, published_at, expires_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [d.title, d.body, d.audience, state, publishNow ? 1 : 0, d.publishAt || null, publishNow ? now : null, d.expiresAt || null, admin.id, now]);
  if (publishNow) await send(pool, admin, res.insertId);
  return present(await getRow(pool, res.insertId));
}

async function update(pool, id, d) {
  const r = await getRow(pool, id);
  checkDates({ publishAt: d.publishAt !== undefined ? d.publishAt : r.publish_at && toDate(r.publish_at), expiresAt: d.expiresAt !== undefined ? d.expiresAt : r.expires_at && toDate(r.expires_at) });
  const map = { title: 'title', body: 'body', audience: 'audience', publishAt: 'publish_at', expiresAt: 'expires_at' };
  const cols = Object.keys(d).filter((k) => map[k]);
  const sets = cols.map((c) => `${map[c]} = ?`);
  const args = cols.map((c) => d[c] ?? null);
  sets.push('updated_at = ?'); args.push(new Date());
  // a scheduled announcement whose publish date is moved to the past would never fire correctly: keep it scheduled, it goes live on the next check.
  await pool.query(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
  return present(await getRow(pool, id));
}

async function publish(pool, admin, id) {
  const r = await getRow(pool, id);
  if (r.state === 'published') throw conflict('This announcement is already published.');
  if (r.expires_at && toDate(r.expires_at) <= new Date()) throw conflict('This announcement has already expired. Change its expiration date first.');
  await pool.query("UPDATE announcements SET state = 'published', is_active = 1, published_at = ?, updated_at = ? WHERE id = ?", [new Date(), new Date(), id]);
  await send(pool, admin, id);
  return present(await getRow(pool, id));
}

async function deactivate(pool, id) {
  const r = await getRow(pool, id);
  if (!['published', 'scheduled'].includes(r.state)) throw conflict('Only a published or scheduled announcement can be deactivated.');
  await pool.query("UPDATE announcements SET state = 'deactivated', is_active = 0, updated_at = ? WHERE id = ?", [new Date(), id]);
  return present(await getRow(pool, id));
}

async function remove(pool, id) {
  await getRow(pool, id);
  await pool.query('DELETE FROM notifications WHERE announcement_id = ?', [id]); // its notification entries go with it
  await pool.query('DELETE FROM announcements WHERE id = ?', [id]);
}

/** Notification rows for the announcement's audience. Idempotent: a recipient is never notified twice (dedupe_key). */
async function send(pool, admin, id) {
  const r = await getRow(pool, id);
  if (r.state !== 'published') throw conflict('Publish the announcement before sending it.');
  let students = 0;
  let drivers = 0;
  if (await settings.get(pool, 'notifications.announcements')) {
    const by = [admin ? admin.id : null, admin ? admin.name : null];
    if (['all', 'students'].includes(r.audience)) {
      const [res] = await pool.query(
        `INSERT IGNORE INTO notifications (recipient_type, student_id, recipient_name, category, title, body, delivery_status, announcement_id, dedupe_key, created_by, created_by_name)
         SELECT 'student', s.id, s.name, 'announcement', ?, ?, 'delivered', ?, CONCAT('ann:', ?, ':s:', s.id), ?, ? FROM students s`, [r.title, r.body, id, id, ...by]);
      students = res.affectedRows;
    }
    if (['all', 'drivers'].includes(r.audience)) {
      const [res] = await pool.query(
        `INSERT IGNORE INTO notifications (recipient_type, driver_id, recipient_name, category, title, body, delivery_status, announcement_id, dedupe_key, created_by, created_by_name)
         SELECT 'driver', a.id, a.name, 'announcement', ?, ?, 'delivered', ?, CONCAT('ann:', ?, ':d:', a.id), ?, ? FROM admins a WHERE a.role = 'driver' AND a.status = 'active'`, [r.title, r.body, id, id, ...by]);
      drivers = res.affectedRows;
    }
  }
  await pool.query('UPDATE announcements SET sent_at = ? WHERE id = ?', [new Date(), id]);
  return { students, drivers };
}

module.exports = { present, getRow, publishDue, list, create, update, publish, deactivate, remove, send };
