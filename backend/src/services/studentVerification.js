'use strict';
const config = require('../config');
const { withTransaction } = require('../db');
const { notFound, conflict } = require('../lib/httpError');
const { sendEmail } = require('../lib/email');
const { escapeLike } = require('../lib/sql');
const { checkEnrollment } = require('../lib/registrar');
const qr = require('./qr');
const history = require('./reviewHistory');
const ser = require('../lib/serialize');

const LIST_SQL = `SELECT s.*, v.verification_status, v.method AS verification_method, v.verification_date, v.rejection_reason,
                         v.note AS verification_note, v.submitted_at, a.name AS verified_by_name
                    FROM students s
                    JOIN student_verifications v ON v.student_id = s.id
                    LEFT JOIN admins a ON a.id = v.verified_by`;

async function list(pool, { status, q, limit, offset }) {
  const where = [];
  const args = [];
  if (status !== 'all') { where.push('v.verification_status = ?'); args.push(status); }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push('(s.name LIKE ? OR s.school_id LIKE ? OR s.email LIKE ? OR s.program LIKE ?)');
    args.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM students s JOIN student_verifications v ON v.student_id = s.id ${clause}`, args);
  const [rows] = await pool.query(`${LIST_SQL} ${clause} ORDER BY (v.verification_status = 'pending') DESC, v.submitted_at DESC, s.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const [[counts]] = await pool.query(
    `SELECT COALESCE(SUM(verification_status = 'pending'), 0) AS pending, COALESCE(SUM(verification_status = 'verified'), 0) AS verified,
            COALESCE(SUM(verification_status = 'rejected'), 0) AS rejected FROM student_verifications`);
  return { items: rows.map(ser.student), total, counts: { pending: Number(counts.pending), verified: Number(counts.verified), rejected: Number(counts.rejected) } };
}

async function getOne(db, studentId) {
  const [rows] = await db.query(`${LIST_SQL} WHERE s.id = ?`, [studentId]);
  if (!rows[0]) throw notFound('Student not found');
  return rows[0];
}

/** Admin-assisted: the admin compares the student with the school's records (registrar answer shown when available). */
async function registrarCheck(pool, studentId) {
  const s = await getOne(pool, studentId);
  return checkEnrollment(s);
}

async function approve(pool, studentId, admin, note) {
  const row = await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM students WHERE id = ? FOR UPDATE', [studentId]);
    const s = rows[0];
    if (!s) throw notFound('Student not found');
    const [v] = await conn.query('SELECT verification_status FROM student_verifications WHERE student_id = ? FOR UPDATE', [studentId]);
    if (v[0] && v[0].verification_status === 'verified') throw conflict('This student is already verified.');
    const now = new Date();
    await conn.query(
      `INSERT INTO student_verifications (student_id, verification_status, method, verified_by, verification_date, rejection_reason, note)
       VALUES (?, 'verified', 'admin_review', ?, ?, NULL, ?)
       ON DUPLICATE KEY UPDATE verification_status = 'verified', method = 'admin_review', verified_by = VALUES(verified_by),
                               verification_date = VALUES(verification_date), rejection_reason = NULL, note = VALUES(note)`,
      [studentId, admin.id, now, note || null]);
    if (s.status === 'pending' || s.status === 'rejected') {
      await conn.query("UPDATE students SET status = 'active', valid_until = ? WHERE id = ?", [config.fare.defaultValidity, studentId]);
    }
    const [after] = await conn.query('SELECT * FROM students WHERE id = ?', [studentId]);
    return after[0];
  });
  await sendEmail(pool, row, 'Your TransitPass has been approved',
    `Hi ${row.name}, you have been verified as an enrolled student. Your discount pass (School ID ${row.school_id}) is now active and valid until ${config.fare.defaultValidity}. Sign in to generate your QR code.`);
  await history.record(pool, { studentId, event: 'application_approved', reason: note, admin });
  return ser.student(await getOne(pool, studentId));
}

async function reject(pool, studentId, admin, reason) {
  const row = await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM students WHERE id = ? FOR UPDATE', [studentId]);
    const s = rows[0];
    if (!s) throw notFound('Student not found');
    const [v] = await conn.query('SELECT verification_status FROM student_verifications WHERE student_id = ? FOR UPDATE', [studentId]);
    if (v[0] && v[0].verification_status === 'rejected') throw conflict('This student is already rejected.');
    await conn.query(
      `INSERT INTO student_verifications (student_id, verification_status, method, verified_by, verification_date, rejection_reason)
       VALUES (?, 'rejected', 'admin_review', ?, ?, ?)
       ON DUPLICATE KEY UPDATE verification_status = 'rejected', method = 'admin_review', verified_by = VALUES(verified_by),
                               verification_date = VALUES(verification_date), rejection_reason = VALUES(rejection_reason)`,
      [studentId, admin.id, new Date(), reason]);
    await conn.query("UPDATE students SET status = 'rejected', valid_until = 'Rejected' WHERE id = ?", [studentId]);
    await qr.revokeAllFor(conn, studentId, admin.name, 'Student verification was rejected');
    const [after] = await conn.query('SELECT * FROM students WHERE id = ?', [studentId]);
    return after[0];
  });
  await sendEmail(pool, row, 'Your TransitPass verification was not approved',
    `Hi ${row.name}, we could not verify that you are an enrolled student (School ID ${row.school_id}). Reason: ${reason}. Please contact your school registrar.`);
  await history.record(pool, { studentId, event: 'application_rejected', reason, admin });
  return ser.student(await getOne(pool, studentId));
}

/** Rejected -> pending again (for example after the student fixed their details). */
async function reopen(pool, studentId, admin = null) {
  await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM students WHERE id = ? FOR UPDATE', [studentId]);
    if (!rows[0]) throw notFound('Student not found');
    const [v] = await conn.query('SELECT verification_status FROM student_verifications WHERE student_id = ? FOR UPDATE', [studentId]);
    if (!v[0] || v[0].verification_status !== 'rejected') throw conflict('Only rejected requests can be reopened.');
    await conn.query(
      "UPDATE student_verifications SET verification_status = 'pending', verified_by = NULL, verification_date = NULL, rejection_reason = NULL, submitted_at = ? WHERE student_id = ?",
      [new Date(), studentId]);
    await conn.query("UPDATE students SET status = 'pending', valid_until = 'Awaiting registrar' WHERE id = ?", [studentId]);
  });
  await history.record(pool, { studentId, event: 'application_reopened', admin });
  return ser.student(await getOne(pool, studentId));
}

module.exports = { list, getOne, registrarCheck, approve, reject, reopen };
