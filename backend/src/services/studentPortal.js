'use strict';
/*
  Everything the signed-in student can see or ask for. Every function takes the student's own id (from the
  verified token), never an id from the request, so one student can never reach another student's records.
  Students can READ their status and SUBMIT requests. Approving, changing the discount, activating a QR code
  and editing transactions are administrator actions and have no student-facing code path here.
*/
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { withTransaction } = require('../db');
const { badRequest, notFound, conflict, forbidden } = require('../lib/httpError');
const { sendEmail } = require('../lib/email');
const { escapeLike } = require('../lib/sql');
const { startOfLocalDay, displayParts, toDate } = require('../lib/time');
const status = require('../lib/studentStatus');
const { round2 } = require('../lib/fare');
const fares = require('./fares');
const uploads = require('../lib/uploads');
const ser = require('../lib/serialize');
const qr = require('./qr');
const txns = require('./transactions');

const DAY = 86400000;
const iso = (v) => (v ? toDate(v).toISOString() : null);

/* ---------------------------------------------------------------- loading + shaping */

const ROW_SQL = `SELECT s.*, v.verification_status, v.method AS verification_method, v.verification_date, v.rejection_reason,
                        v.note AS verification_note, v.submitted_at
                   FROM students s LEFT JOIN student_verifications v ON v.student_id = s.id WHERE s.id = ?`;

async function loadRow(db, id) {
  const [rows] = await db.query(ROW_SQL, [id]);
  if (!rows[0]) throw notFound('Student not found');
  return rows[0];
}

/** What the student sees about themselves. Password hash, token version, face data and file paths are never included. */
function portalStudent(r) {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    email: r.email,
    phone: r.phone === '—' ? '' : r.phone,
    school: r.school,
    campus: r.campus,
    course: r.program,
    yearLevel: r.level,
    section: r.section,
    profilePhoto: r.profile_photo || null,
    registration: {
      ...status.registrationState(r),
      submittedAt: iso(r.submitted_at),
      decidedAt: iso(r.verification_date),
      rejectionReason: r.rejection_reason || null
    },
    documents: { idDocument: !!r.id_document, enrollmentDocument: !!r.enrollment_document },
    createdAt: iso(r.created_at)
  };
}

/* ---------------------------------------------------------------- QR code */

// Reasons a STUDENT's own actions leave on a revoked code. Any other reason means an administrator deactivated it.
const STUDENT_REVOKE_REASONS = new Set(['Revoked by the student', 'Reported lost by the student']);

/** An administrator-deactivated code cannot be replaced by the student alone (that would undo the admin's decision). */
async function adminBlock(db, studentId) {
  const [rows] = await db.query('SELECT status, revoke_reason FROM qr_codes WHERE student_id = ? ORDER BY generated_at DESC, id DESC LIMIT 1', [studentId]);
  const q = rows[0];
  if (!q || q.status !== 'revoked') return null;
  const why = q.revoke_reason || '';
  if (STUDENT_REVOKE_REASONS.has(why) || why.startsWith('Replaced by')) return null;
  return 'Your QR code was deactivated by an administrator, so you cannot generate a new one yourself. Send a replacement request and the registrar will review it.';
}

async function qrState(db, row) {
  const live = await qr.currentFor(db, row.id);
  const verificationWhy = live ? null : qr.blockReason(row, row.verification_status);
  const adminWhy = live || verificationWhy ? null : await adminBlock(db, row.id);
  const history = await qr.historyFor(db, row.id);
  const [pend] = await db.query("SELECT id FROM student_requests WHERE student_id = ? AND type = 'qr_replacement' AND status = 'pending' LIMIT 1", [row.id]);
  return {
    qr: live ? ser.qr({ ...live, student_name: row.name, student_school_id: row.school_id }, { withToken: true }) : null,
    canGenerate: !live && !verificationWhy && !adminWhy,
    reason: verificationWhy || adminWhy,
    blockedByAdmin: !!adminWhy,
    replacementRequestPending: pend.length > 0,
    last: history[0] ? { status: history[0].status, generatedAt: history[0].generatedAt, expiresAt: history[0].expiresAt, revokedAt: history[0].revokedAt } : null
  };
}

const QR_LABEL = { active: 'Active', expired: 'Expired', revoked: 'Deactivated', none: 'Not generated' };
function qrSummary(state) {
  if (state.qr) return { status: 'active', label: QR_LABEL.active, generatedAt: state.qr.generatedAt, expiresAt: state.qr.expiresAt };
  const last = state.last;
  const st = last ? (last.status === 'revoked' ? 'revoked' : 'expired') : 'none';
  return { status: st, label: QR_LABEL[st], generatedAt: last ? last.generatedAt : null, expiresAt: last ? last.expiresAt : null };
}

/** Generate / replace, with the extra rule that an admin's deactivation cannot be bypassed by the student. */
async function issueQr(pool, row, { replace }) {
  const live = await qr.currentFor(pool, row.id);
  if (!live) {
    const why = await adminBlock(pool, row.id);
    if (why) throw forbidden(why);
  }
  await qr.issue(pool, row.id, { type: 'student', id: row.id, name: row.name }, { replace });
}

async function revokeQr(pool, row) {
  const live = await qr.currentFor(pool, row.id);
  if (!live) throw conflict('You have no active QR code to revoke.');
  await qr.revoke(pool, live.id, { type: 'student', id: row.id, name: row.name }, 'Revoked by the student', { onlyStudentId: row.id });
}

/** Lost QR: the code stops working immediately (so a finder cannot use it) and the report is recorded. */
async function reportLost(pool, row, note) {
  const live = await qr.currentFor(pool, row.id);
  if (!live) throw conflict('You have no active QR code to report.');
  await qr.revoke(pool, live.id, { type: 'student', id: row.id, name: row.name }, 'Reported lost by the student', { onlyStudentId: row.id });
  await pool.query("INSERT INTO student_requests (student_id, type, reason, status) VALUES (?, 'qr_lost', ?, 'resolved')", [row.id, note || null]);
  await sendEmail(pool, row, 'Your QR code was reported lost',
    `Hi ${row.name}, you reported your TransitPass QR code (School ID ${row.school_id}) as lost. It was deactivated immediately and cannot be used. You can generate a new one from My QR Code.`);
}

/* ---------------------------------------------------------------- notifications */

const itemFromMail = (r) => ({
  id: `n-${r.id}`, kind: 'message', category: status.categoryOf(r.subject), title: r.subject, body: r.body,
  createdAt: iso(r.sent_at), date: displayParts(toDate(r.sent_at)).date, time: displayParts(toDate(r.sent_at)).time, read: !!r.is_read
});
const itemFromAnnouncement = (r) => ({
  id: `a-${r.id}`, kind: 'announcement', category: 'announcement', title: r.title, body: r.body,
  createdAt: iso(r.created_at), date: displayParts(toDate(r.created_at)).date, time: displayParts(toDate(r.created_at)).time, read: !!r.is_read
});

/** Expiry reminders are written into the student's inbox once per validity date (so they are not repeated on every visit). */
async function ensureReminders(pool, row, elig) {
  let subject = null;
  let body = null;
  if (elig.status === 'eligible' && elig.daysLeft !== null && elig.daysLeft <= config.renewalWindowDays) {
    subject = 'Your student discount expires soon';
    body = `Hi ${row.name}, your student discount is valid until ${row.valid_until} (${Math.max(elig.daysLeft, 0)} day${elig.daysLeft === 1 ? '' : 's'} left). Open Discount Eligibility to request a renewal before it expires.`;
  } else if (elig.status === 'expired' && row.status === 'active') {
    subject = 'Your student discount has expired';
    body = `Hi ${row.name}, your student discount expired after ${row.valid_until}. Open Discount Eligibility to request a renewal.`;
  }
  if (!subject) return;
  const [dup] = await pool.query('SELECT 1 FROM email_log WHERE student_id = ? AND subject = ? AND body LIKE ? LIMIT 1',
    [row.id, subject, `%${escapeLike(row.valid_until)}%`]);
  if (!dup.length) await sendEmail(pool, row, subject, body);
}

async function unreadCount(db, studentId) {
  const [[m]] = await db.query('SELECT COUNT(*) AS n FROM email_log WHERE student_id = ? AND is_read = 0', [studentId]);
  const [[a]] = await db.query(
    `SELECT COUNT(*) AS n FROM announcements a WHERE a.is_active = 1 AND a.audience IN ('all','students') AND (a.expires_at IS NULL OR a.expires_at > ?)
        AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.student_id = ?)`, [new Date(), studentId]);
  return Number(m.n) + Number(a.n);
}

async function notifications(pool, studentId, { filter = 'all', limit = 50, offset = 0 } = {}) {
  const row = await loadRow(pool, studentId);
  await ensureReminders(pool, row, status.discountState(row));
  const [mail] = await pool.query('SELECT id, subject, body, sent_at, is_read FROM email_log WHERE student_id = ? ORDER BY sent_at DESC, id DESC LIMIT 300', [studentId]);
  const [ann] = await pool.query(
    `SELECT a.id, a.title, a.body, a.created_at, (r.student_id IS NOT NULL) AS is_read
       FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.student_id = ?
      WHERE a.is_active = 1 AND a.audience IN ('all','students') AND (a.expires_at IS NULL OR a.expires_at > ?) ORDER BY a.created_at DESC LIMIT 100`, [studentId, new Date()]);
  const all = [...mail.map(itemFromMail), ...ann.map(itemFromAnnouncement)].sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
  const shown = filter === 'unread' ? all.filter((i) => !i.read) : all;
  return { items: shown.slice(offset, offset + limit), total: shown.length, unread: all.filter((i) => !i.read).length };
}

async function markRead(pool, studentId, id) {
  const m = /^(n|a)-(\d+)$/.exec(String(id));
  if (!m) throw notFound('Notification not found');
  if (m[1] === 'n') {
    const [r] = await pool.query('SELECT id FROM email_log WHERE id = ? AND student_id = ?', [m[2], studentId]); // own rows only
    if (!r.length) throw notFound('Notification not found');
    await pool.query('UPDATE email_log SET is_read = 1 WHERE id = ? AND student_id = ?', [m[2], studentId]);
  } else {
    const [r] = await pool.query("SELECT id FROM announcements WHERE id = ? AND is_active = 1 AND audience IN ('all','students')", [m[2]]);
    if (!r.length) throw notFound('Notification not found');
    await pool.query('INSERT IGNORE INTO announcement_reads (student_id, announcement_id) VALUES (?, ?)', [studentId, m[2]]);
  }
  return { unread: await unreadCount(pool, studentId) };
}

async function markAllRead(pool, studentId) {
  await pool.query('UPDATE email_log SET is_read = 1 WHERE student_id = ?', [studentId]);
  await pool.query('INSERT IGNORE INTO announcement_reads (student_id, announcement_id) SELECT ?, id FROM announcements WHERE is_active = 1 AND audience IN (\'all\',\'students\')', [studentId]);
  return { unread: 0 };
}

/* ---------------------------------------------------------------- transactions */

const TXN_WHERE = "scans.student_id = ? AND scans.result IN ('granted','review')"; // rides: discounted or charged full fare. Failed (denied) scans are not rides.
// Joins used to determine each transaction's status: cancelled / refunded / pending (under review) / completed.
const TXN_JOINS = `
  LEFT JOIN transaction_cancellations c ON c.scan_id = scans.id
  LEFT JOIN refund_requests ra ON ra.id = (SELECT MAX(r2.id) FROM refund_requests r2 WHERE r2.scan_id = scans.id AND r2.status = 'approved')`;
const TXN_COLS = `scans.*,
  c.id AS cancel_id, c.reason AS cancel_reason,
  ra.id AS refund_id, ra.amount AS refund_amount,
  (SELECT COUNT(*) FROM refund_requests r3 WHERE r3.scan_id = scans.id AND r3.status = 'pending') AS refund_pending`;
const TXN_STATUS_LABEL = { completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded', pending: 'Pending' };
const txnStatusOf = (r) =>
  r.cancel_id ? 'cancelled' : r.refund_id ? 'refunded' : (r.result === 'review' ? 'pending' : 'completed');

function txnFilter(studentId, { q, from, to, status }) {
  const where = [TXN_WHERE];
  const args = [studentId];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push("(CONCAT('TXN-', LPAD(scans.id, 8, '0')) LIKE ? OR scans.route LIKE ? OR scans.driver_name LIKE ? OR scans.operator LIKE ?)");
    args.push(like, like, like, like);
  }
  if (from) { where.push('scans.scanned_at >= ?'); args.push(startOfLocalDay(new Date(`${from}T12:00:00Z`))); }
  if (to) { where.push('scans.scanned_at < ?'); args.push(new Date(startOfLocalDay(new Date(`${to}T12:00:00Z`)).getTime() + DAY)); }
  if (status === 'cancelled') where.push('c.id IS NOT NULL');
  else if (status === 'refunded') where.push('c.id IS NULL AND ra.id IS NOT NULL');
  else if (status === 'pending') where.push('c.id IS NULL AND ra.id IS NULL AND scans.result = \'review\'');
  else   if (status === 'completed') where.push('c.id IS NULL AND ra.id IS NULL AND scans.result = \'granted\'');
  return { clause: 'WHERE ' + where.join(' AND '), args };
}

const txnItem = (r) => {
  const at = toDate(r.scanned_at);
  const { date, time } = displayParts(at);
  const final = Number(r.fare_amount), discount = Number(r.discount_amount);
  const regular = round2(final + discount);
  const st = txnStatusOf(r);
  return {
    id: r.id,
    reference: status.txnReference(r.id),
    scannedAt: at.toISOString(), date, time,
    service: r.route,
    operator: r.operator,
    driver: r.driver_name || '—',
    regularFare: regular,
    discountPercent: regular > 0 ? Math.round((discount / regular) * 100) : 0,
    discountAmount: discount,
    finalFare: final,
    result: r.result,
    status: st,
    statusLabel: TXN_STATUS_LABEL[st],
    underReview: r.result === 'review',
    cancelReason: r.cancel_reason || null,
    refundAmount: r.refund_id ? Number(r.refund_amount) : null,
    refundPending: Number(r.refund_pending || 0) > 0
  };
};

async function transactions(pool, studentId, query) {
  const { clause, args } = txnFilter(studentId, query);
  const [[sum]] = await pool.query(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(discount_amount), 0) AS discount,
            COALESCE(SUM(fare_amount), 0) AS paid,
            COALESCE(SUM(fare_amount + discount_amount), 0) AS regular,
            COALESCE(SUM(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS cancelled_count,
            COALESCE(SUM(CASE WHEN c.id IS NOT NULL THEN scans.fare_amount END), 0) AS cancelled_value,
            COALESCE(SUM(CASE WHEN ra.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS refunded_count,
            COALESCE(SUM(CASE WHEN ra.id IS NOT NULL THEN scans.fare_amount END), 0) AS refunded_value,
            COALESCE(SUM(CASE WHEN ra.id IS NOT NULL THEN ra.amount END), 0) AS refunded_amount,
            COALESCE(SUM(CASE WHEN c.id IS NULL AND ra.id IS NULL AND scans.result = 'review' THEN 1 ELSE 0 END), 0) AS pending_count,
            COALESCE(SUM(CASE WHEN c.id IS NULL AND ra.id IS NULL AND scans.result = 'review' THEN scans.fare_amount END), 0) AS pending_value,
            COALESCE(SUM(CASE WHEN c.id IS NULL AND ra.id IS NULL AND scans.result = 'granted' THEN 1 ELSE 0 END), 0) AS completed_count,
            COALESCE(SUM(CASE WHEN c.id IS NULL AND ra.id IS NULL AND scans.result = 'granted' THEN scans.fare_amount END), 0) AS completed_revenue,
            COALESCE(SUM(CASE WHEN c.id IS NULL AND ra.id IS NULL AND scans.result = 'granted' THEN scans.discount_amount END), 0) AS completed_discount,
            COALESCE(SUM(CASE WHEN c.id IS NULL AND ra.id IS NULL AND scans.result = 'granted' THEN scans.fare_amount + scans.discount_amount END), 0) AS completed_regular
       FROM scans ${TXN_JOINS} ${clause}`, args);
  const [rows] = await pool.query(
    `SELECT ${TXN_COLS} FROM scans ${TXN_JOINS} ${clause} ORDER BY scans.scanned_at DESC, scans.id DESC LIMIT ? OFFSET ?`, [...args, query.limit, query.offset]);
  const t = sum;
  return {
    items: rows.map(txnItem),
    total: Number(sum.count),
    summary: {
      count: Number(sum.count),
      totalDiscount: Number(sum.discount),
      totalPaid: Number(sum.paid),
      totalRegular: Number(sum.regular),
      byStatus: {
        completed: { count: Number(t.completed_count), revenue: round2(Number(t.completed_revenue)), discount: round2(Number(t.completed_discount)), regular: round2(Number(t.completed_regular)) },
        cancelled: { count: Number(t.cancelled_count), fareValue: round2(Number(t.cancelled_value)) },
        refunded: { count: Number(t.refunded_count), fareValue: round2(Number(t.refunded_value)), refundedAmount: round2(Number(t.refunded_amount)) },
        pending: { count: Number(t.pending_count), fareValue: round2(Number(t.pending_value)) }
      }
    }
  };
}

async function transaction(pool, studentId, id) {
  const [rows] = await pool.query(
    `SELECT ${TXN_COLS} FROM scans ${TXN_JOINS} WHERE scans.id = ? AND ${TXN_WHERE}`, [id, studentId]); // id AND owner: someone else's id is simply "not found"
  if (!rows[0]) throw notFound('Transaction not found');
  const r = rows[0];
  const base = status.transaction(r);
  const st = txnStatusOf(r);
  return {
    ...base,
    status: st,
    statusLabel: TXN_STATUS_LABEL[st],
    underReview: r.result === 'review',
    cancelReason: r.cancel_reason || null,
    refundAmount: r.refund_id ? Number(r.refund_amount) : null,
    refundPending: Number(r.refund_pending || 0) > 0
  };
}

/** Receipt for one of the student's own transactions; ownership is enforced by `transaction()`. */
async function receipt(pool, studentId, id) {
  await transaction(pool, studentId, id); // throws notFound if the student does not own this transaction
  return txns.receipt(pool, id);
}

/* ---------------------------------------------------------------- dashboard + eligibility */

async function dashboard(pool, studentId) {
  const row = await loadRow(pool, studentId);
  const elig = status.discountState(row, new Date(), await fares.defaultPercent(pool));
  await ensureReminders(pool, row, elig);
  const state = await qrState(pool, row);
  const [[tot]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(discount_amount), 0) AS discount, COALESCE(SUM(fare_amount), 0) AS paid FROM scans WHERE ${TXN_WHERE}`, [studentId]);
  const [recent] = await pool.query(`SELECT * FROM scans WHERE ${TXN_WHERE} ORDER BY scanned_at DESC, id DESC LIMIT 5`, [studentId]);
  const note = await notifications(pool, studentId, { limit: 5 });
  return {
    student: portalStudent(row),
    eligibility: elig,
    qr: qrSummary(state),
    totals: { transactions: Number(tot.count), totalDiscount: Number(tot.discount), totalPaid: Number(tot.paid) },
    recentTransactions: recent.map(status.transaction),
    notifications: note.items,
    unreadNotifications: note.unread
  };
}

async function renewalRule(pool, row, elig) {
  const [pend] = await pool.query("SELECT id FROM student_requests WHERE student_id = ? AND type = 'renewal' AND status = 'pending' LIMIT 1", [row.id]);
  if (pend.length) return { canRequest: false, reason: 'You already have a renewal request waiting for the registrar.' };
  if (row.verification_status !== 'verified') return { canRequest: false, reason: 'You can request a renewal after your registration is approved.' };
  if (elig.status === 'suspended') return { canRequest: false, reason: 'Your pass is under registrar review. Please contact the registrar.' };
  if (elig.status === 'expired' || elig.status === 'not_eligible') return { canRequest: true, reason: null };
  if (elig.status === 'eligible' && elig.daysLeft !== null && elig.daysLeft <= config.renewalWindowDays) return { canRequest: true, reason: null };
  return { canRequest: false, reason: `You can request a renewal ${config.renewalWindowDays} days before your discount expires.` };
}

async function eligibility(pool, studentId) {
  const row = await loadRow(pool, studentId);
  const elig = status.discountState(row, new Date(), await fares.defaultPercent(pool));
  await ensureReminders(pool, row, elig);
  const renewal = await renewalRule(pool, row, elig);
  const reqs = await listRequests(pool, studentId, { type: 'renewal' });
  return {
    eligibility: elig,
    enrollment: {
      registration: portalStudent(row).registration,
      verifiedBy: row.verification_method ? status.VERIFY_METHOD[row.verification_method] || null : null,
      verificationNote: row.verification_note || null,
      school: row.school, campus: row.campus, course: row.program, yearLevel: row.level, section: row.section, schoolId: row.school_id
    },
    renewal: { ...renewal, windowDays: config.renewalWindowDays },
    requests: reqs
  };
}

/* ---------------------------------------------------------------- profile */

async function profile(pool, studentId) {
  const row = await loadRow(pool, studentId);
  const [rev] = await pool.query('SELECT kind, status, reason, reviewed_at FROM student_document_reviews WHERE student_id = ?', [studentId]);
  const reviews = { id: { status: row.id_document ? 'pending' : 'none', reason: null }, enrollment: { status: row.enrollment_document ? 'pending' : 'none', reason: null } };
  for (const r of rev) if (reviews[r.kind].status !== 'none') reviews[r.kind] = { status: r.status, reason: r.reason || null };
  return { student: portalStudent(row), documentReviews: reviews, requests: await listRequests(pool, studentId, { type: 'correction' }) };
}

async function updatePhone(pool, studentId, phone) {
  await pool.query('UPDATE students SET phone = ? WHERE id = ?', [phone, studentId]);
  const row = await loadRow(pool, studentId);
  await sendEmail(pool, row, 'Your TransitPass contact details were updated', `Hi ${row.name}, your contact number was updated to ${phone}. If this was not you, change your password and contact the registrar.`);
  return portalStudent(row);
}

async function updatePhoto(pool, studentId, file) {
  const dataUrl = uploads.photoToDataUrl(file);
  await pool.query('UPDATE students SET profile_photo = ? WHERE id = ?', [dataUrl, studentId]);
  const row = await loadRow(pool, studentId);
  await sendEmail(pool, row, 'Your TransitPass profile photo was updated', `Hi ${row.name}, your profile photo was updated.`);
  return portalStudent(row);
}

const DOC_COLUMN = { id: 'id_document', enrollment: 'enrollment_document' };

/** Stores the registration documents (used right after sign-up). Returns the relative paths. */
async function saveRegistrationFiles(studentId, files) {
  const out = {};
  for (const [kind, col] of [['id', 'id_document'], ['enrollment', 'enrollment_document']]) {
    const f = files[kind];
    if (f) out[col] = await uploads.saveDocument(studentId, kind, f);
  }
  return out;
}

/** A student whose registration is still pending (or was rejected) can replace the documents; approved students cannot. */
async function replaceDocuments(pool, row, files) {
  if (row.verification_status === 'verified') throw conflict('Your registration is already approved, so the documents are locked. Send a correction request if something is wrong.');
  const checked = {};
  if (files.idDocument) checked.id = uploads.checkDocument(files.idDocument, 'Student ID document');
  if (files.enrollmentDocument) checked.enrollment = uploads.checkDocument(files.enrollmentDocument, 'Enrollment document');
  if (!Object.keys(checked).length) throw badRequest('Choose a file to upload.');
  const saved = await saveRegistrationFiles(row.id, checked);
  for (const [kind, col] of Object.entries(DOC_COLUMN)) {
    if (saved[col]) {
      await pool.query(`UPDATE students SET ${col} = ? WHERE id = ?`, [saved[col], row.id]);
      await pool.query('DELETE FROM student_document_reviews WHERE student_id = ? AND kind = ?', [row.id, kind]); // a new file must be checked again
      await uploads.removeStored(row[col]);
    }
  }
  await sendEmail(pool, row, 'We received your updated documents', `Hi ${row.name}, your updated enrollment documents were received and will be checked by the registrar.`);
  return portalStudent(await loadRow(pool, row.id));
}

async function documentFile(pool, studentId, kind) {
  const col = DOC_COLUMN[kind];
  if (!col) throw notFound('Document not found');
  const row = await loadRow(pool, studentId);
  const abs = uploads.resolveStored(row[col]);
  if (!abs) throw notFound('Document not found');
  return { abs, mime: uploads.mimeForFile(abs) };
}

/* ---------------------------------------------------------------- requests */

const TYPE_LABEL = { correction: 'Information correction', renewal: 'Discount renewal', qr_replacement: 'QR replacement', qr_lost: 'Lost QR report' };
const FIELD_LABEL = { name: 'Full name', schoolId: 'Student ID', school: 'School', campus: 'Campus', program: 'Course', level: 'Year level', section: 'Section' };
const FIELD_COLUMN = { name: 'name', schoolId: 'school_id', school: 'school', campus: 'campus', program: 'program', level: 'level', section: 'section' };
const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', resolved: 'Recorded' };

const itemFromRequest = (r) => ({
  id: r.id, type: r.type, typeLabel: TYPE_LABEL[r.type], field: r.field_name, fieldLabel: r.field_name ? FIELD_LABEL[r.field_name] || r.field_name : null,
  currentValue: r.current_value, requestedValue: r.requested_value, reason: r.reason,
  status: r.status, statusLabel: STATUS_LABEL[r.status], adminNote: r.admin_note, createdAt: iso(r.created_at), reviewedAt: iso(r.reviewed_at)
});

async function listRequests(pool, studentId, { type } = {}) {
  const [rows] = await pool.query(
    `SELECT * FROM student_requests WHERE student_id = ? ${type ? 'AND type = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT 50`, type ? [studentId, type] : [studentId]);
  return rows.map(itemFromRequest);
}

async function createRequest(pool, row, d) {
  const dupPending = async (type, field) => {
    const [r] = await pool.query(
      `SELECT id FROM student_requests WHERE student_id = ? AND type = ? ${field ? 'AND field_name = ?' : ''} AND status = 'pending' LIMIT 1`,
      field ? [row.id, type, field] : [row.id, type]);
    return r.length > 0;
  };
  let ins;
  if (d.type === 'correction') {
    const current = row[FIELD_COLUMN[d.field]];
    if (d.value === current) throw badRequest('That is already your current value.');
    if (d.field === 'schoolId') {
      if (!/^[A-Za-z0-9][A-Za-z0-9\-_./]{0,39}$/.test(d.value)) throw badRequest('Student ID may only contain letters, numbers and - _ . /');
      const [taken] = await pool.query('SELECT 1 FROM students WHERE school_id = ? AND id <> ?', [d.value, row.id]);
      if (taken.length) throw conflict('Another account already uses that Student ID.');
    }
    if (await dupPending('correction', d.field)) throw conflict(`You already have a pending correction for ${FIELD_LABEL[d.field]}.`);
    [ins] = await pool.query(
      "INSERT INTO student_requests (student_id, type, field_name, current_value, requested_value, reason) VALUES (?, 'correction', ?, ?, ?, ?)",
      [row.id, d.field, String(current).slice(0, 255), d.value, d.reason]);
    await sendEmail(pool, row, 'We received your information correction request', `Hi ${row.name}, your request to change ${FIELD_LABEL[d.field]} to "${d.value}" was sent to the registrar. You will be notified once it is reviewed.`);
  } else if (d.type === 'renewal') {
    const rule = await renewalRule(pool, row, status.discountState(row));
    if (!rule.canRequest) throw conflict(rule.reason);
    [ins] = await pool.query("INSERT INTO student_requests (student_id, type, reason) VALUES (?, 'renewal', ?)", [row.id, d.reason || null]);
    await sendEmail(pool, row, 'We received your discount renewal request', `Hi ${row.name}, your discount renewal request was sent to the registrar. You will be notified once it is reviewed.`);
  } else {
    const live = await qr.currentFor(pool, row.id);
    if (live) throw conflict('You already have an active QR code. Use "Replace my QR code" to get a new one.');
    if (!(await adminBlock(pool, row.id))) throw conflict('You can generate a new QR code yourself from My QR Code.');
    if (await dupPending('qr_replacement')) throw conflict('You already have a replacement request waiting for the registrar.');
    [ins] = await pool.query("INSERT INTO student_requests (student_id, type, reason) VALUES (?, 'qr_replacement', ?)", [row.id, d.reason]);
    await sendEmail(pool, row, 'We received your QR replacement request', `Hi ${row.name}, your QR replacement request was sent to the registrar. You will be notified once it is reviewed.`);
  }
  const [r] = await pool.query('SELECT * FROM student_requests WHERE id = ?', [ins.insertId]);
  return itemFromRequest(r[0]);
}

async function cancelRequest(pool, studentId, id) {
  const [r] = await pool.query('SELECT status FROM student_requests WHERE id = ? AND student_id = ?', [id, studentId]);
  if (!r.length) throw notFound('Request not found');
  if (r[0].status !== 'pending') throw conflict('Only a pending request can be cancelled.');
  await pool.query("UPDATE student_requests SET status = 'cancelled' WHERE id = ? AND student_id = ? AND status = 'pending'", [id, studentId]);
  const [after] = await pool.query('SELECT * FROM student_requests WHERE id = ?', [id]);
  return itemFromRequest(after[0]);
}

/* ---------------------------------------------------------------- account settings */

async function changePassword(pool, row, { current, new: next }) {
  if (!row.password_hash || !(await bcrypt.compare(current, row.password_hash))) throw badRequest('Your current password is incorrect.');
  if (await bcrypt.compare(next, row.password_hash)) throw badRequest('Choose a password you have not used before.');
  // token_version + 1 signs out every other device; the caller gets a fresh token for this one.
  await pool.query('UPDATE students SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(next, 12), row.id]);
  await sendEmail(pool, row, 'Your TransitPass password was changed', `Hi ${row.name}, your password was just changed. If this was not you, reset it right away and contact the registrar.`);
  const [rows] = await pool.query('SELECT * FROM students WHERE id = ?', [row.id]);
  return rows[0];
}

async function changeEmail(pool, row, { email, password }) {
  if (!row.password_hash || !(await bcrypt.compare(password, row.password_hash))) throw badRequest('Your password is incorrect.');
  if (email === row.email) throw badRequest('That is already your email address.');
  await pool.query('UPDATE students SET email = ? WHERE id = ?', [email, row.id]); // a duplicate surfaces as 409 "email already exists"
  const after = await loadRow(pool, row.id);
  await sendEmail(pool, row, 'Your TransitPass email address was changed', `Hi ${row.name}, the email on your TransitPass account was changed to ${email}. If this was not you, contact the registrar immediately.`); // goes to the OLD address
  await sendEmail(pool, after, 'Your TransitPass email address was updated', `Hi ${after.name}, this address is now the email for your TransitPass account (School ID ${after.school_id}).`);
  return portalStudent(after);
}

async function signOutEverywhere(pool, row) {
  await pool.query('UPDATE students SET token_version = token_version + 1 WHERE id = ?', [row.id]);
  const [rows] = await pool.query('SELECT * FROM students WHERE id = ?', [row.id]);
  return rows[0];
}

/* ---------------------------------------------------------------- forgot / reset password */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Creates a one-time link and emails it. Does nothing (silently) for an unknown account, so the answer never reveals who is registered. */
async function requestPasswordReset(pool, identifier) {
  const [rows] = await pool.query('SELECT * FROM students WHERE school_id = ? OR email = ? LIMIT 1', [identifier, identifier.toLowerCase()]);
  const s = rows[0];
  if (!s) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('UPDATE password_resets SET used_at = ? WHERE student_id = ? AND used_at IS NULL', [new Date(), s.id]); // older links stop working
  await pool.query('INSERT INTO password_resets (student_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [s.id, sha256(token), new Date(Date.now() + config.passwordReset.ttlMinutes * 60000)]);
  const link = `${config.publicUrl}/student-reset.html?token=${token}`;
  await sendEmail(pool, s, 'Reset your TransitPass password',
    `Hi ${s.name}, we received a request to reset your TransitPass password. Open this link within ${config.passwordReset.ttlMinutes} minutes to choose a new one: ${link}  If you did not ask for this, ignore this message; your password has not changed.`);
  if (!config.isProd && !config.isTest && config.email.mode === 'log') console.log(`[password reset] ${s.school_id}: ${link}`);
  return token;
}

async function resetPassword(pool, { token, password }) {
  const hash = await bcrypt.hash(password, 12);
  const studentId = await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM password_resets WHERE token_hash = ? FOR UPDATE', [sha256(token)]);
    const r = rows[0];
    if (!r || r.used_at || toDate(r.expires_at) <= new Date()) throw badRequest('This reset link is invalid or has expired. Ask for a new one.');
    await conn.query('UPDATE password_resets SET used_at = ? WHERE id = ?', [new Date(), r.id]);
    await conn.query('UPDATE students SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [hash, r.student_id]);
    return r.student_id;
  });
  const [rows] = await pool.query('SELECT * FROM students WHERE id = ?', [studentId]);
  await sendEmail(pool, rows[0], 'Your TransitPass password was changed', `Hi ${rows[0].name}, your password was reset. If this was not you, contact the registrar immediately.`);
}

module.exports = {
  FIELD_LABEL, FIELD_COLUMN, loadRow, portalStudent, qrState, issueQr, revokeQr, reportLost, adminBlock, notifications, markRead, markAllRead, unreadCount,
  transactions, transaction, receipt, dashboard, eligibility, profile, updatePhone, updatePhoto, saveRegistrationFiles, replaceDocuments, documentFile,
  listRequests, createRequest, cancelRequest, changePassword, changeEmail, signOutEverywhere, requestPasswordReset, resetPassword
};
