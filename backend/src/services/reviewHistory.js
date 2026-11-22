'use strict';
// Application review history: an append-only record of every administrator decision about a student application,
// uploaded document or information correction (who, when, and the reason given). Written by the existing review services.
const { toDate } = require('../lib/time');
const { escapeLike } = require('../lib/sql');

const EVENTS = ['application_approved', 'application_rejected', 'application_reopened', 'document_verified', 'document_rejected', 'correction_approved', 'correction_rejected', 'renewal_approved', 'renewal_rejected', 'qr_replacement_approved', 'qr_replacement_rejected'];
const LABEL = {
  application_approved: 'Application approved', application_rejected: 'Application rejected', application_reopened: 'Application reopened',
  document_verified: 'Document verified', document_rejected: 'Document rejected', correction_approved: 'Correction approved', correction_rejected: 'Correction rejected',
  renewal_approved: 'Renewal approved', renewal_rejected: 'Renewal rejected', qr_replacement_approved: 'QR replacement approved', qr_replacement_rejected: 'QR replacement rejected'
};

/** Never throws: history must not break the decision it describes. `reopen` has no admin in the old API, so admin may be null. */
async function record(db, { studentId, event, subject = null, reason = null, admin = null }) {
  try {
    await db.query(
      'INSERT INTO application_review_history (student_id, event, subject, reason, admin_id, admin_name) VALUES (?, ?, ?, ?, ?, ?)',
      [studentId, event, subject ? String(subject).slice(0, 80) : null, reason ? String(reason).slice(0, 255) : null, admin ? admin.id : null, admin ? admin.name : 'System']);
  } catch (e) { console.error('[review-history] could not write:', e.message); }
}

const item = (r) => ({
  id: r.id, studentId: r.student_id, student: r.student_name, schoolId: r.school_id, event: r.event, label: LABEL[r.event], subject: r.subject,
  reason: r.reason, adminId: r.admin_id, admin: r.admin_name, at: toDate(r.created_at).toISOString()
});

async function list(pool, { studentId, event, q, limit = 50, offset = 0 }) {
  const where = [];
  const args = [];
  if (studentId) { where.push('h.student_id = ?'); args.push(studentId); }
  if (event && event !== 'all') { where.push('h.event = ?'); args.push(event); }
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(s.name LIKE ? OR s.school_id LIKE ? OR h.admin_name LIKE ? OR h.reason LIKE ?)'); args.push(like, like, like, like); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = 'FROM application_review_history h JOIN students s ON s.id = h.student_id';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${clause}`, args);
  const [rows] = await pool.query(`SELECT h.*, s.name AS student_name, s.school_id ${from} ${clause} ORDER BY h.created_at DESC, h.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { total: Number(total), items: rows.map(item) };
}

module.exports = { EVENTS, LABEL, record, list };
