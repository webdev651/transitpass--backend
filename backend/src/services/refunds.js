'use strict';
/*
  Refunds and transaction cancellation. A "transaction" is a granted / review row of `scans`. Those rows are NEVER deleted or
  edited here: a cancellation is a separate record (transaction_cancellations) and a refund is a request with a decision.
  Approving a refund or cancelling a transaction needs the administrator's password again, a written reason, and is stored
  with the administrator's id and name. Money itself moves outside TransitPass; this module records the decision.
*/
const { withTransaction } = require('../db');
const { notFound, conflict, badRequest } = require('../lib/httpError');
const { escapeLike } = require('../lib/sql');
const { toDate, displayParts } = require('../lib/time');
const { dayStartUtc } = require('../lib/dates');
const { txnReference } = require('../lib/studentStatus');
const { verifyPassword } = require('../lib/reauth');
const notifications = require('./notifications');

const iso = (v) => (v ? toDate(v).toISOString() : null);
const RIDE = "s.result IN ('granted','review')";

const txn = (r) => ({
  id: r.id, reference: txnReference(r.id), studentId: r.student_id, student: r.student_name, schoolId: r.school_id, driver: r.driver_name, route: r.route, fare: r.fare,
  amount: Number(r.fare_amount), discount: Number(r.discount_amount), result: r.result, scannedAt: iso(r.scanned_at), ...displayParts(toDate(r.scanned_at)),
  cancelled: !!r.cancel_id, cancelledAt: iso(r.cancelled_at), cancelReason: r.cancel_reason || null, cancelledBy: r.cancelled_by_name || null,
  refund: r.refund_id ? { id: r.refund_id, status: r.refund_status } : null
});
const TXN_BASE = `SELECT s.*, c.id AS cancel_id, c.created_at AS cancelled_at, c.reason AS cancel_reason, c.cancelled_by_name,
                         (SELECT rr.id FROM refund_requests rr WHERE rr.scan_id = s.id ORDER BY rr.id DESC LIMIT 1) AS refund_id,
                         (SELECT rr.status FROM refund_requests rr WHERE rr.scan_id = s.id ORDER BY rr.id DESC LIMIT 1) AS refund_status
                    FROM scans s LEFT JOIN transaction_cancellations c ON c.scan_id = s.id`;

/** The transactions an administrator can refund or cancel (with their current state). */
async function transactions(pool, { q, state, from, to, limit, offset }) {
  const where = [RIDE];
  const args = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    const ref = /^TXN-0*(\d+)$/i.exec(q.trim());
    where.push(`(s.student_name LIKE ? OR s.school_id LIKE ? OR s.driver_name LIKE ?${ref ? ' OR s.id = ?' : ''})`);
    args.push(like, like, like); if (ref) args.push(Number(ref[1]));
  }
  if (from) { where.push('s.scanned_at >= ?'); args.push(dayStartUtc(from)); }
  if (to) { where.push('s.scanned_at < ?'); args.push(new Date(dayStartUtc(to).getTime() + 86400000)); }
  if (state === 'cancelled') where.push('c.id IS NOT NULL');
  if (state === 'active') where.push('c.id IS NULL');
  const clause = `WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM scans s LEFT JOIN transaction_cancellations c ON c.scan_id = s.id ${clause}`, args);
  const [rows] = await pool.query(`${TXN_BASE} ${clause} ORDER BY s.scanned_at DESC, s.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { total: Number(total), items: rows.map(txn) };
}

const refundItem = (r) => ({
  id: r.id, scanId: r.scan_id, reference: txnReference(r.scan_id), studentId: r.student_id, student: r.student_name, amount: Number(r.amount), reason: r.reason, source: r.source,
  status: r.status, decisionReason: r.decision_reason, requestedBy: r.requested_by_name, decidedBy: r.decided_by_name, decidedAt: iso(r.decided_at), createdAt: iso(r.created_at)
});
async function getRefund(db, id) {
  const [rows] = await db.query('SELECT * FROM refund_requests WHERE id = ?', [id]);
  if (!rows[0]) throw notFound('Refund request not found');
  return rows[0];
}

async function listRefunds(pool, { status, q, limit, offset }) {
  const where = [];
  const args = [];
  if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(student_name LIKE ? OR reason LIKE ? OR requested_by_name LIKE ?)'); args.push(like, like, like); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM refund_requests ${clause}`, args);
  const [rows] = await pool.query(`SELECT * FROM refund_requests ${clause} ORDER BY (status = 'pending') DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const [[c]] = await pool.query("SELECT COALESCE(SUM(status = 'pending'),0) AS pending, COALESCE(SUM(status = 'approved'),0) AS approved, COALESCE(SUM(status = 'rejected'),0) AS rejected FROM refund_requests");
  return { total: Number(total), items: rows.map(refundItem), counts: { pending: Number(c.pending), approved: Number(c.approved), rejected: Number(c.rejected) } };
}

/** Refund details: the request plus the transaction it is about. */
async function refundDetail(pool, id) {
  const r = await getRefund(pool, id);
  const [t] = await pool.query(`${TXN_BASE} WHERE s.id = ?`, [r.scan_id]);
  return { refund: refundItem(r), transaction: t[0] ? txn(t[0]) : null };
}

async function createRefund(pool, admin, { scanId, amount, reason }) {
  const id = await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM scans WHERE id = ? FOR UPDATE', [scanId]);
    const s = rows[0];
    if (!s || !['granted', 'review'].includes(s.result)) throw notFound('Transaction not found');
    const [c] = await conn.query('SELECT 1 FROM transaction_cancellations WHERE scan_id = ?', [scanId]);
    if (c.length) throw conflict('This transaction was cancelled. A cancelled transaction cannot be refunded.');
    const [open] = await conn.query("SELECT id, status FROM refund_requests WHERE scan_id = ? AND status IN ('pending','approved') LIMIT 1", [scanId]);
    if (open.length) throw conflict(`This transaction already has a ${open[0].status} refund request (#${open[0].id}).`);
    const value = amount === undefined ? Number(s.fare_amount) : amount;
    if (!(value > 0) || value > Number(s.fare_amount)) throw badRequest(`The refund must be more than 0 and at most the fare paid (₱${Number(s.fare_amount).toFixed(2)}).`);
    const [res] = await conn.query(
      'INSERT INTO refund_requests (scan_id, student_id, student_name, amount, reason, source, requested_by, requested_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [scanId, s.student_id, s.student_name, value, reason, 'admin', admin.id, admin.name]);
    return res.insertId;
  });
  return refundDetail(pool, id);
}

async function decide(pool, admin, id, { decision, reason, password }) {
  await verifyPassword(admin, password);
  const r = await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM refund_requests WHERE id = ? FOR UPDATE', [id]);
    const q = rows[0];
    if (!q) throw notFound('Refund request not found');
    if (q.status !== 'pending') throw conflict(`This refund request was already ${q.status}.`);
    const [c] = await conn.query('SELECT 1 FROM transaction_cancellations WHERE scan_id = ?', [q.scan_id]);
    if (decision === 'approved' && c.length) throw conflict('The transaction was cancelled in the meantime. Reject this request instead.');
    await conn.query('UPDATE refund_requests SET status = ?, decision_reason = ?, decided_by = ?, decided_by_name = ?, decided_at = ? WHERE id = ?',
      [decision, reason || null, admin.id, admin.name, new Date(), id]);
    return q;
  });
  if (r.student_id) {
    const [st] = await pool.query('SELECT * FROM students WHERE id = ?', [r.student_id]);
    if (st[0]) await notifications.notifyStudent(pool, st[0], {
      category: 'refund', admin, title: decision === 'approved' ? 'Your refund request was approved' : 'Your refund request was not approved',
      body: decision === 'approved' ? `Hi ${st[0].name}, your refund of ₱${Number(r.amount).toFixed(2)} for ${txnReference(r.scan_id)} was approved.${reason ? ` Note: ${reason}` : ''}`
        : `Hi ${st[0].name}, your refund request for ${txnReference(r.scan_id)} was not approved. Reason: ${reason}.`
    });
  }
  return refundDetail(pool, id);
}

async function cancelTransaction(pool, admin, scanId, { reason, password }) {
  await verifyPassword(admin, password);
  const scan = await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM scans WHERE id = ? FOR UPDATE', [scanId]);
    const s = rows[0];
    if (!s || !['granted', 'review'].includes(s.result)) throw notFound('Transaction not found');
    const [c] = await conn.query('SELECT 1 FROM transaction_cancellations WHERE scan_id = ?', [scanId]);
    if (c.length) throw conflict('This transaction was already cancelled.');
    const [p] = await conn.query("SELECT id FROM refund_requests WHERE scan_id = ? AND status = 'pending' LIMIT 1", [scanId]);
    if (p.length) throw conflict(`Decide refund request #${p[0].id} for this transaction before cancelling it.`);
    await conn.query('INSERT INTO transaction_cancellations (scan_id, reason, cancelled_by, cancelled_by_name) VALUES (?, ?, ?, ?)', [scanId, reason, admin.id, admin.name]);
    return s;
  });
  if (scan.student_id) {
    const [st] = await pool.query('SELECT * FROM students WHERE id = ?', [scan.student_id]);
    if (st[0]) await notifications.notifyStudent(pool, st[0], { category: 'refund', admin, title: 'A transaction on your account was cancelled', body: `Hi ${st[0].name}, transaction ${txnReference(scan.id)} was cancelled by the administrator. Reason: ${reason}.` });
  }
  const [t] = await pool.query(`${TXN_BASE} WHERE s.id = ?`, [scanId]);
  return txn(t[0]);
}

async function cancellations(pool, { q, limit, offset }) {
  const args = [];
  let where = '';
  if (q) { const like = `%${escapeLike(q)}%`; where = 'WHERE (s.student_name LIKE ? OR s.school_id LIKE ? OR c.reason LIKE ? OR c.cancelled_by_name LIKE ?)'; args.push(like, like, like, like); }
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM transaction_cancellations c JOIN scans s ON s.id = c.scan_id ${where}`, args);
  const [rows] = await pool.query(
    `SELECT s.*, c.id AS cancel_id, c.created_at AS cancelled_at, c.reason AS cancel_reason, c.cancelled_by_name,
            (SELECT rr.id FROM refund_requests rr WHERE rr.scan_id = s.id ORDER BY rr.id DESC LIMIT 1) AS refund_id,
            (SELECT rr.status FROM refund_requests rr WHERE rr.scan_id = s.id ORDER BY rr.id DESC LIMIT 1) AS refund_status
       FROM transaction_cancellations c JOIN scans s ON s.id = c.scan_id ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { total: Number(total), items: rows.map(txn) };
}

/** A student requests a refund for one of their own transactions. `requested_by` stays NULL (students are not admins);
  the student's name is stored in `requested_by_name`. */
async function createStudentRefund(pool, student, { scanId, amount, reason }) {
  const id = await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM scans WHERE id = ? FOR UPDATE', [scanId]);
    const s = rows[0];
    if (!s || !['granted', 'review'].includes(s.result)) throw notFound('Transaction not found');
    if (s.student_id !== student.id) throw notFound('Transaction not found');
    const [c] = await conn.query('SELECT 1 FROM transaction_cancellations WHERE scan_id = ?', [scanId]);
    if (c.length) throw conflict('This transaction was cancelled. A cancelled transaction cannot be refunded.');
    const [open] = await conn.query("SELECT id, status FROM refund_requests WHERE scan_id = ? AND status IN ('pending','approved') LIMIT 1", [scanId]);
    if (open.length) throw conflict(`This transaction already has a ${open[0].status} refund request (#${open[0].id}).`);
    const value = amount === undefined ? Number(s.fare_amount) : amount;
    if (!(value > 0) || value > Number(s.fare_amount)) throw badRequest(`The refund must be more than 0 and at most the fare paid (₱${Number(s.fare_amount).toFixed(2)}).`);
    const [res] = await conn.query(
      'INSERT INTO refund_requests (scan_id, student_id, student_name, amount, reason, source, requested_by, requested_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [scanId, student.id, student.name, value, reason, 'student', null, student.name]);
    return res.insertId;
  });
  const d = await refundDetail(pool, id);
  await notifications.notifyStudent(pool, student, {
    category: 'refund', title: 'We received your refund request',
    body: `Hi ${student.name}, your refund request of ₱${Number(d.refund.amount).toFixed(2)} for ${txnReference(d.refund.scanId)} was received and is awaiting a decision.`
  });
  return d;
}

/** Refund requests owned by one student (their own portal view). */
async function listStudentRefunds(pool, studentId, { status, q, limit, offset }) {
  const where = ['student_id = ?'];
  const args = [studentId];
  if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(reason LIKE ? OR scan_id LIKE ?)'); args.push(like, like); }
  const clause = `WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM refund_requests ${clause}`, args);
  const [rows] = await pool.query(`SELECT * FROM refund_requests ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const [[c]] = await pool.query("SELECT COALESCE(SUM(status = 'pending'),0) AS pending, COALESCE(SUM(status = 'approved'),0) AS approved, COALESCE(SUM(status = 'rejected'),0) AS rejected FROM refund_requests WHERE student_id = ?", [studentId]);
  return { total: Number(total), items: rows.map(refundItem), counts: { pending: Number(c.pending), approved: Number(c.approved), rejected: Number(c.rejected) } };
}

module.exports = { transactions, listRefunds, refundDetail, createRefund, createStudentRefund, decide, cancelTransaction, cancellations, listStudentRefunds };
