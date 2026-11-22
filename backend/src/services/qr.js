'use strict';
const config = require('../config');
const { withTransaction } = require('../db');
const { notFound, conflict, forbidden } = require('../lib/httpError');
const { newToken, toPayload } = require('../lib/qrToken');
const { escapeLike } = require('../lib/sql');
const { sendEmail } = require('../lib/email');
const ser = require('../lib/serialize');

const DAY = 86400000;
const actorName = (a) => a.name || (a.type === 'student' ? 'Student' : 'Administrator');

/** Why a student may not hold a QR code right now (null = may). Verified identity AND an active pass are both required. */
function blockReason(student, verificationStatus) {
  if (verificationStatus === 'rejected' || student.status === 'rejected') return 'Your verification was rejected, so a QR code cannot be issued.';
  if (verificationStatus !== 'verified' || student.status === 'pending') return 'Your verification is still pending. A QR code can be generated once an administrator verifies you.';
  if (student.status !== 'active') return 'Your pass is not active right now, so a QR code cannot be issued.';
  return null;
}

async function loadStudent(conn, id, lock = false) {
  const [rows] = await conn.query(
    `SELECT s.*, v.verification_status FROM students s LEFT JOIN student_verifications v ON v.student_id = s.id
      WHERE s.id = ? ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw notFound('Student not found');
  return rows[0];
}

/** Turns active QR codes whose time ran out into "expired" (so reports and the scanner agree). */
async function expireStale(conn, studentId = null, now = new Date()) {
  await conn.query(
    `UPDATE qr_codes SET status = 'expired' WHERE status = 'active' AND expires_at <= ? ${studentId ? 'AND student_id = ?' : ''}`,
    studentId ? [now, studentId] : [now]);
}

/** Finds every active code whose time ran out, marks it "expired", and returns the rows so callers can notify the students. */
async function expireDue(db, now = new Date()) {
  const [rows] = await db.query("SELECT id, student_id, expires_at FROM qr_codes WHERE status = 'active' AND expires_at <= ?", [now]);
  if (rows.length) await db.query("UPDATE qr_codes SET status = 'expired' WHERE status = 'active' AND expires_at <= ?", [now]);
  return rows;
}

async function currentFor(db, studentId) {
  await expireStale(db, studentId);
  const [rows] = await db.query("SELECT * FROM qr_codes WHERE student_id = ? AND status = 'active' ORDER BY generated_at DESC LIMIT 1", [studentId]);
  return rows[0] || null;
}

async function revokeActive(conn, studentId, byName, reason) {
  const [res] = await conn.query(
    "UPDATE qr_codes SET status = 'revoked', revoked_at = ?, revoked_by_name = ?, revoke_reason = ? WHERE student_id = ? AND status = 'active'",
    [new Date(), byName, reason, studentId]);
  return res.affectedRows;
}

/**
 * Creates a QR code for a student.
 * `db` may be a pool (a transaction is opened) or a connection the caller already owns (the issuance then joins
 * that transaction). actor: { type: 'student' | 'admin', id, name }.  replace=false refuses when an active code
 * already exists; replace=true revokes the old one first (regeneration / replacement).
 */
async function issue(db, studentId, actor, { replace = false } = {}) {
  const own = typeof db.getConnection === 'function';
  const conn = own ? await db.getConnection() : db;
  try {
    if (own) await conn.beginTransaction();
    const created = await run(conn);
    if (own) await conn.commit();
    if (actor.type === 'admin') {
      await sendEmail(db, created.student, 'A new QR code has been issued for your pass',
        `Hi ${created.student.name}, an administrator generated a new QR code for your pass (School ID ${created.student.school_id}). Sign in and open My Pass to view it. Any previously saved copy no longer works.`);
    }
    return created.qr;
  } catch (err) {
    if (own) { try { await conn.rollback(); } catch (_) { /* connection may be gone */ } }
    throw err;
  } finally {
    if (own) conn.release();
  }

  async function run(conn) {
    const s = await loadStudent(conn, studentId, true); // row lock: two requests for one student cannot both create an active code
    const why = blockReason(s, s.verification_status);
    if (why) throw (actor.type === 'student' ? forbidden(why) : conflict(why.replace('Your', 'This student\'s')));
    await expireStale(conn, studentId);
    const [active] = await conn.query("SELECT id FROM qr_codes WHERE student_id = ? AND status = 'active' FOR UPDATE", [studentId]);
    if (active.length && !replace) throw conflict('An active QR code already exists. Revoke or regenerate it first.');
    if (active.length) await revokeActive(conn, studentId, actorName(actor), 'Replaced by a newly generated QR code');
    const now = new Date();
    const [ins] = await conn.query(
      `INSERT INTO qr_codes (student_id, qr_token, generated_by_type, generated_by_student, generated_by_admin, generated_by_name, generated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [studentId, newToken(), actor.type, actor.type === 'student' ? actor.id : null, actor.type === 'admin' ? actor.id : null,
        actorName(actor), now, new Date(now.getTime() + config.qr.validityDays * DAY)]);
    await conn.query('UPDATE students SET qr_active = 1, qr_version = qr_version + 1 WHERE id = ?', [studentId]); // legacy columns kept in step
    const [rows] = await conn.query('SELECT * FROM qr_codes WHERE id = ?', [ins.insertId]);
    return { qr: rows[0], student: s };
  }
}

async function revoke(pool, qrId, actor, reason, { onlyStudentId } = {}) {
  const out = await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM qr_codes WHERE id = ? FOR UPDATE', [qrId]);
    const q = rows[0];
    if (!q || (onlyStudentId && q.student_id !== onlyStudentId)) throw notFound('QR code not found');
    if (q.status !== 'active') throw conflict(`This QR code is already ${q.status}.`);
    await conn.query("UPDATE qr_codes SET status = 'revoked', revoked_at = ?, revoked_by_name = ?, revoke_reason = ? WHERE id = ?",
      [new Date(), actorName(actor), reason || (actor.type === 'student' ? 'Revoked by the student' : 'Revoked by an administrator'), qrId]);
    await conn.query('UPDATE students SET qr_active = 0 WHERE id = ?', [q.student_id]);
    const [after] = await conn.query('SELECT * FROM qr_codes WHERE id = ?', [qrId]);
    return after[0];
  });
  if (actor.type === 'admin') {
    const [st] = await pool.query('SELECT * FROM students WHERE id = ?', [out.student_id]);
    await sendEmail(pool, st[0], 'Your QR code has been deactivated',
      `Hi ${st[0].name}, your TransitPass QR code (School ID ${st[0].school_id}) has been deactivated by an administrator. Scans will be refused until it is reactivated or replaced.`);
  }
  return out;
}

/** Admin: bring a revoked code back, only if it has not expired and the student is still verified and active. */
async function reactivate(pool, qrId, actor) {
  const out = await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM qr_codes WHERE id = ? FOR UPDATE', [qrId]);
    const q = rows[0];
    if (!q) throw notFound('QR code not found');
    const s = await loadStudent(conn, q.student_id, true);
    if (q.status !== 'revoked') throw conflict(q.status === 'active' ? 'This QR code is already active.' : 'An expired QR code cannot be reactivated. Generate a new one.');
    if (q.expires_at <= new Date()) {
      await conn.query("UPDATE qr_codes SET status = 'expired' WHERE id = ?", [qrId]);
      throw conflict('This QR code has expired. Generate a new one.');
    }
    const why = blockReason(s, s.verification_status);
    if (why) throw conflict('The student is not verified and active, so the code cannot be reactivated.');
    const [other] = await conn.query("SELECT id FROM qr_codes WHERE student_id = ? AND status = 'active' AND id <> ?", [q.student_id, qrId]);
    if (other.length) throw conflict('The student already has another active QR code.');
    await conn.query("UPDATE qr_codes SET status = 'active', revoked_at = NULL, revoked_by_name = NULL, revoke_reason = NULL WHERE id = ?", [qrId]);
    await conn.query('UPDATE students SET qr_active = 1 WHERE id = ?', [q.student_id]);
    const [after] = await conn.query('SELECT * FROM qr_codes WHERE id = ?', [qrId]);
    return { qr: after[0], student: s };
  });
  await sendEmail(pool, out.student, 'Your QR code has been reactivated',
    `Hi ${out.student.name}, your TransitPass QR code (School ID ${out.student.school_id}) was reactivated by ${actorName(actor)} and can be scanned again.`);
  return out.qr;
}

/** Revokes whatever is active for a student (used when a verification is rejected or reopened). */
async function revokeAllFor(conn, studentId, byName, reason) {
  const n = await revokeActive(conn, studentId, byName, reason);
  if (n) await conn.query('UPDATE students SET qr_active = 0 WHERE id = ?', [studentId]);
  return n;
}

const EFFECTIVE = "CASE WHEN q.status = 'active' AND q.expires_at <= ? THEN 'expired' ELSE q.status END";

/** Admin list: every QR code with who generated it and when. Full tokens are never returned. */
async function list(pool, { q, status, studentId, limit, offset }) {
  const now = new Date();
  const where = [];
  const args = [];
  if (status && status !== 'all') { where.push(`${EFFECTIVE} = ?`); args.push(now, status); }
  if (studentId) { where.push('q.student_id = ?'); args.push(studentId); }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push('(s.name LIKE ? OR s.school_id LIKE ? OR q.generated_by_name LIKE ?)');
    args.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = 'FROM qr_codes q JOIN students s ON s.id = q.student_id';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${clause}`, args);
  const [rows] = await pool.query(
    `SELECT q.*, ${EFFECTIVE} AS effective_status, s.name AS student_name, s.school_id AS student_school_id ${from} ${clause}
      ORDER BY q.generated_at DESC, q.id DESC LIMIT ? OFFSET ?`, [now, ...args, limit, offset]);
  return { items: rows.map((r) => ser.qr(r)), total };
}

async function historyFor(pool, studentId) {
  const now = new Date();
  const [rows] = await pool.query(
    `SELECT q.*, ${EFFECTIVE} AS effective_status FROM qr_codes q WHERE q.student_id = ? ORDER BY q.generated_at DESC, q.id DESC LIMIT 50`, [now, studentId]);
  return rows.map((r) => ser.qr(r));
}

const payloadOf = (row) => toPayload(row.qr_token);

module.exports = { blockReason, issue, revoke, reactivate, revokeAllFor, currentFor, expireDue, expireStale, list, historyFor, payloadOf, loadStudent };
