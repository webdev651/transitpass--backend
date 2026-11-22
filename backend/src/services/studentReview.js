'use strict';
/*
  Student management for administrators: look at the documents a student uploaded, decide whether each one is
  acceptable, and review the information-correction requests students send from their portal.

  The application itself (approve / reject with a reason / reopen) already lives in studentVerification.js and is
  not repeated here. Everything below uses the existing tables: students (uploaded file paths), student_requests
  (corrections) and the new student_document_reviews. Students get a notification (email_log) for every decision.
*/
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { withTransaction } = require('../db');
const { notFound, conflict, badRequest } = require('../lib/httpError');
const { sendEmail } = require('../lib/email');
const { escapeLike } = require('../lib/sql');
const { toDate, displayParts } = require('../lib/time');
const uploads = require('../lib/uploads');
const verification = require('./studentVerification');
const portal = require('./studentPortal');
const history = require('./reviewHistory');
const qr = require('./qr');
const ser = require('../lib/serialize');

const DOCS = {
  id: { col: 'id_document', label: 'Student ID document', noun: 'student ID document' },
  enrollment: { col: 'enrollment_document', label: 'Enrollment document', noun: 'enrollment document' }
};
const KINDS = Object.keys(DOCS);
const TYPE_LABEL = { correction: 'Information correction', renewal: 'Discount renewal', qr_replacement: 'QR replacement' };
const iso = (v) => (v ? toDate(v).toISOString() : null);
const DAY = 86400000;
const fmtUntil = (d) => displayParts(d).date;

/** 'none' (not uploaded) | 'pending' (uploaded, not reviewed) | 'verified' | 'rejected' */
const docState = (row, kind, review) => (!row[DOCS[kind].col] ? 'none' : review ? review.status : 'pending');

async function reviewsFor(db, ids) {
  if (!ids.length) return new Map();
  const [rows] = await db.query('SELECT * FROM student_document_reviews WHERE student_id IN (?)', [ids]);
  return new Map(rows.map((r) => [`${r.student_id}:${r.kind}`, r]));
}

/** Adds items[i].documents = { id: state, enrollment: state } to a page of verification-list rows (one extra query each). */
async function attachDocuments(pool, items) {
  if (!items.length) return items;
  const ids = items.map((i) => i.id);
  const [rows] = await pool.query('SELECT id, id_document, enrollment_document FROM students WHERE id IN (?)', [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const reviews = await reviewsFor(pool, ids);
  for (const it of items) {
    const row = byId.get(it.id) || {};
    it.documents = Object.fromEntries(KINDS.map((k) => [k, docState(row, k, reviews.get(`${it.id}:${k}`))]));
  }
  return items;
}

/** Everything the review panel needs about one student. */
async function detail(pool, studentId) {
  const row = await verification.getOne(pool, studentId);
  const reviews = await reviewsFor(pool, [studentId]);
  const [revBy] = await pool.query('SELECT r.kind, a.name FROM student_document_reviews r LEFT JOIN admins a ON a.id = r.reviewed_by WHERE r.student_id = ?', [studentId]);
  const reviewer = Object.fromEntries(revBy.map((x) => [x.kind, x.name]));
  const documents = [];
  for (const kind of KINDS) {
    const rev = reviews.get(`${studentId}:${kind}`);
    const abs = uploads.resolveStored(row[DOCS[kind].col]);
    let size = null;
    if (abs) { try { size = (await fs.promises.stat(abs)).size; } catch (_) { /* file missing on disk */ } }
    const ext = abs ? path.extname(abs).slice(1).toUpperCase() : null;
    documents.push({
      kind, label: DOCS[kind].label, submitted: !!row[DOCS[kind].col], available: size !== null,
      status: docState(row, kind, rev), reason: rev ? rev.reason : null, reviewedAt: rev ? iso(rev.reviewed_at) : null, reviewedBy: rev ? reviewer[kind] || null : null,
      fileType: ext === 'JPG' ? 'JPG image' : ext === 'PNG' ? 'PNG image' : ext === 'PDF' ? 'PDF' : ext, sizeBytes: size
    });
  }
  const [[pend]] = await pool.query("SELECT COUNT(*) AS n FROM student_requests WHERE student_id = ? AND type = 'correction' AND status = 'pending'", [studentId]);
  return {
    student: ser.student(row),
    profile: { campus: row.campus, section: row.section, profilePhoto: row.profile_photo || null, selfRegistered: !!row.password_hash },
    documents, pendingCorrections: Number(pend.n)
  };
}

async function documentFile(pool, studentId, kind) {
  if (!DOCS[kind]) throw notFound('Document not found');
  const [rows] = await pool.query(`SELECT ${DOCS[kind].col} AS file FROM students WHERE id = ?`, [studentId]);
  if (!rows[0]) throw notFound('Student not found');
  const abs = uploads.resolveStored(rows[0].file);
  if (!abs || !fs.existsSync(abs)) throw notFound('This document was not uploaded.');
  return { abs, mime: uploads.mimeForFile(abs), label: DOCS[kind].label, noun: DOCS[kind].noun };
}

async function reviewDocument(pool, studentId, kind, admin, { decision, reason }) {
  if (!DOCS[kind]) throw notFound('Document not found');
  const row = await verification.getOne(pool, studentId);
  const abs = uploads.resolveStored(row[DOCS[kind].col]);
  if (!abs || !fs.existsSync(abs)) throw conflict(`This student has not uploaded a ${DOCS[kind].noun}.`);
  await pool.query(
    `INSERT INTO student_document_reviews (student_id, kind, status, reason, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), reason = VALUES(reason), reviewed_by = VALUES(reviewed_by), reviewed_at = VALUES(reviewed_at)`,
    [studentId, kind, decision, decision === 'rejected' ? reason : (reason || null), admin.id, new Date()]);
  const label = DOCS[kind].noun;
  await history.record(pool, { studentId, event: decision === 'verified' ? 'document_verified' : 'document_rejected', subject: DOCS[kind].label, reason, admin });
  await sendEmail(pool, row, decision === 'verified' ? `Your ${label} was approved` : `Your ${label} was not approved`,
    decision === 'verified'
      ? `Hi ${row.name}, the registrar checked your ${label} and it was accepted.`
      : `Hi ${row.name}, your ${label} was not accepted. Reason: ${reason}. Open My Profile in the student portal and upload a new file.`);
  return detail(pool, studentId);
}

/* ---------------------------------------------------------------- information correction requests */

const itemFromRow = (r) => ({
  id: r.id, studentId: r.student_id, studentName: r.student_name, schoolId: r.student_school_id,
  field: r.field_name, fieldLabel: portal.FIELD_LABEL[r.field_name] || r.field_name,
  currentValue: r.current_value, requestedValue: r.requested_value, reason: r.reason,
  status: r.status, adminNote: r.admin_note, reviewedBy: r.reviewed_by_name || null, reviewedAt: iso(r.reviewed_at), createdAt: iso(r.created_at)
});
const BASE = `SELECT r.*, s.name AS student_name, s.school_id AS student_school_id, a.name AS reviewed_by_name
                FROM student_requests r JOIN students s ON s.id = r.student_id LEFT JOIN admins a ON a.id = r.reviewed_by`;

async function listRequests(pool, { type, status, q, limit, offset }) {
  const where = ["r.type = ?"];
  const args = [type];
  if (status !== 'all') { where.push('r.status = ?'); args.push(status); }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push('(s.name LIKE ? OR s.school_id LIKE ? OR r.requested_value LIKE ? OR r.reason LIKE ?)');
    args.push(like, like, like, like);
  }
  const clause = where.join(' AND ');
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM student_requests r JOIN students s ON s.id = r.student_id WHERE ${clause}`, args);
  const [rows] = await pool.query(`${BASE} WHERE ${clause} ORDER BY (r.status = 'pending') DESC, r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const [[c]] = await pool.query(
    `SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'approved'), 0) AS approved, COALESCE(SUM(status = 'rejected'), 0) AS rejected
       FROM student_requests WHERE type = ?`, [type]);
  return { items: rows.map(itemFromRow), total: Number(total), counts: { pending: Number(c.pending), approved: Number(c.approved), rejected: Number(c.rejected) } };
}

async function listCorrections(pool, query) { return listRequests(pool, { type: 'correction', ...query }); }

async function oneCorrection(db, id) {
  const [rows] = await db.query(`${BASE} WHERE r.id = ? AND r.type = 'correction'`, [id]);
  if (!rows[0]) throw notFound('Correction request not found');
  return rows[0];
}

/** Approving CHANGES the student's record to the requested value, in one transaction with the decision. */
async function approveCorrection(pool, id, admin, note) {
  const { student, request } = await withTransaction(pool, async (conn) => {
    const [reqs] = await conn.query("SELECT * FROM student_requests WHERE id = ? AND type = 'correction' FOR UPDATE", [id]);
    const r = reqs[0];
    if (!r) throw notFound('Correction request not found');
    if (r.status !== 'pending') throw conflict(`This request was already ${r.status}.`);
    const col = portal.FIELD_COLUMN[r.field_name];
    if (!col) throw badRequest('This request is for a field that cannot be corrected.');
    const [studs] = await conn.query('SELECT * FROM students WHERE id = ? FOR UPDATE', [r.student_id]);
    if (!studs[0]) throw notFound('Student not found');
    if (r.field_name === 'schoolId') {
      if (!/^[A-Za-z0-9][A-Za-z0-9\-_./]{0,39}$/.test(r.requested_value)) throw badRequest('The requested Student ID has invalid characters.');
      const [taken] = await conn.query('SELECT 1 FROM students WHERE school_id = ? AND id <> ?', [r.requested_value, r.student_id]);
      if (taken.length) throw conflict('Another student already uses that Student ID, so this request cannot be approved.');
    }
    await conn.query(`UPDATE students SET ${col} = ? WHERE id = ?`, [r.requested_value, r.student_id]);
    await conn.query("UPDATE student_requests SET status = 'approved', admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", [note || null, admin.id, new Date(), id]);
    return { student: studs[0], request: r };
  });
  await sendEmail(pool, { ...student, name: request.field_name === 'name' ? request.requested_value : student.name },
    'Your information correction request was approved',
    `Hi ${student.name}, the registrar approved your request. Your ${portal.FIELD_LABEL[request.field_name]} is now "${request.requested_value}".${note ? ` Note: ${note}` : ''}`);
  await history.record(pool, { studentId: request.student_id, event: 'correction_approved', subject: portal.FIELD_LABEL[request.field_name] || request.field_name, reason: note, admin });
  return itemFromRow(await oneCorrection(pool, id));
}

async function rejectCorrection(pool, id, admin, reason) {
  const r = await withTransaction(pool, async (conn) => {
    const [reqs] = await conn.query("SELECT * FROM student_requests WHERE id = ? AND type = 'correction' FOR UPDATE", [id]);
    if (!reqs[0]) throw notFound('Correction request not found');
    if (reqs[0].status !== 'pending') throw conflict(`This request was already ${reqs[0].status}.`);
    await conn.query("UPDATE student_requests SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", [reason, admin.id, new Date(), id]);
    return reqs[0];
  });
  await history.record(pool, { studentId: r.student_id, event: 'correction_rejected', subject: portal.FIELD_LABEL[r.field_name] || r.field_name, reason, admin });
  const [studs] = await pool.query('SELECT * FROM students WHERE id = ?', [r.student_id]);
  await sendEmail(pool, studs[0], 'Your information correction request was not approved',
    `Hi ${studs[0].name}, the registrar did not approve your request to change ${portal.FIELD_LABEL[r.field_name]} to "${r.requested_value}". Reason: ${reason}.`);
  return itemFromRow(await oneCorrection(pool, id));
}

async function oneRequest(db, id, type) {
  const [rows] = await db.query(`${BASE} WHERE r.id = ? AND r.type = ?`, [id, type]);
  if (!rows[0]) throw notFound(`${TYPE_LABEL[type]} request not found`);
  return rows[0];
}

/** Approving a renewal extends the student's discount validity and makes the pass active again. */
async function approveRenewal(pool, id, admin, note) {
  const { student, request } = await withTransaction(pool, async (conn) => {
    const r = await oneRequest(conn, id, 'renewal');
    if (r.status !== 'pending') throw conflict(`This request was already ${r.status}.`);
    const [studs] = await conn.query('SELECT s.*, v.verification_status FROM students s LEFT JOIN student_verifications v ON v.student_id = s.id WHERE s.id = ? FOR UPDATE', [r.student_id]);
    if (!studs[0]) throw notFound('Student not found');
    if (studs[0].verification_status !== 'verified') throw conflict('This student is not verified, so the discount cannot be renewed.');
    const until = new Date(Date.now() + config.renewal.validityDays * DAY);
    await conn.query("UPDATE students SET valid_until = ?, status = 'active' WHERE id = ?", [fmtUntil(until), r.student_id]);
    await conn.query("UPDATE student_requests SET status = 'approved', admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", [note || null, admin.id, new Date(), id]);
    return { student: studs[0], request: r };
  });
  await sendEmail(pool, student, 'Your discount renewal was approved',
    `Hi ${student.name}, your discount renewal was approved. Your student discount is now valid until ${fmtUntil(new Date(Date.now() + config.renewal.validityDays * DAY))}.${note ? ` Note: ${note}` : ''}`);
  await history.record(pool, { studentId: request.student_id, event: 'renewal_approved', subject: 'Discount validity', reason: note, admin });
  return itemFromRow(await oneRequest(pool, id, 'renewal'));
}

async function rejectRenewal(pool, id, admin, reason) {
  const r = await withTransaction(pool, async (conn) => {
    const req = await oneRequest(conn, id, 'renewal');
    if (req.status !== 'pending') throw conflict(`This request was already ${req.status}.`);
    await conn.query("UPDATE student_requests SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", [reason, admin.id, new Date(), id]);
    return req;
  });
  const [studs] = await pool.query('SELECT * FROM students WHERE id = ?', [r.student_id]);
  await sendEmail(pool, studs[0], 'Your discount renewal was not approved',
    `Hi ${studs[0].name}, the registrar did not approve your discount renewal request. Reason: ${reason}.`);
  await history.record(pool, { studentId: r.student_id, event: 'renewal_rejected', subject: 'Discount validity', reason, admin });
  return itemFromRow(await oneRequest(pool, id, 'renewal'));
}

/** Approving a QR replacement issues the student a new active QR code (the old one stays revoked). */
async function approveQrReplacement(pool, id, admin, note) {
  const { student, request } = await withTransaction(pool, async (conn) => {
    const r = await oneRequest(conn, id, 'qr_replacement');
    if (r.status !== 'pending') throw conflict(`This request was already ${r.status}.`);
    const [studs] = await conn.query('SELECT * FROM students WHERE id = ? FOR UPDATE', [r.student_id]);
    if (!studs[0]) throw notFound('Student not found');
    await qr.issue(conn, r.student_id, { type: 'admin', id: admin.id, name: admin.name }, { replace: true });
    await conn.query("UPDATE student_requests SET status = 'approved', admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", [note || null, admin.id, new Date(), id]);
    return { student: studs[0], request: r };
  });
  await history.record(pool, { studentId: request.student_id, event: 'qr_replacement_approved', subject: 'QR code', reason: note, admin });
  return itemFromRow(await oneRequest(pool, id, 'qr_replacement'));
}

async function rejectQrReplacement(pool, id, admin, reason) {
  const r = await withTransaction(pool, async (conn) => {
    const req = await oneRequest(conn, id, 'qr_replacement');
    if (req.status !== 'pending') throw conflict(`This request was already ${req.status}.`);
    await conn.query("UPDATE student_requests SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", [reason, admin.id, new Date(), id]);
    return req;
  });
  const [studs] = await pool.query('SELECT * FROM students WHERE id = ?', [r.student_id]);
  await sendEmail(pool, studs[0], 'Your QR replacement request was not approved',
    `Hi ${studs[0].name}, the registrar did not approve your QR replacement request. Reason: ${reason}.`);
  await history.record(pool, { studentId: r.student_id, event: 'qr_replacement_rejected', subject: 'QR code', reason, admin });
  return itemFromRow(await oneRequest(pool, id, 'qr_replacement'));
}

module.exports = { KINDS, attachDocuments, detail, documentFile, reviewDocument, listCorrections, listRequests, approveCorrection, rejectCorrection,
  approveRenewal, rejectRenewal, approveQrReplacement, rejectQrReplacement };
