'use strict';
const { withTransaction } = require('../db');
const { grantedFare, fullFare, discountStatusText } = require('../lib/fare');
const fares = require('./fares');
const { parsePayload } = require('../lib/qrToken');
const { sendEmail } = require('../lib/email');
const { badRequest } = require('../lib/httpError');
const { txnReference } = require('../lib/studentStatus');
const ser = require('../lib/serialize');

// Offline checks are accepted for a week; anything older is refused so a copied device queue cannot rewrite old history.
const OFFLINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

// The six answers a driver can see, plus FLAGGED_REVIEW for passes an admin has flagged (kept from the original terminal).
const OUTCOMES = {
  VERIFIED_STUDENT:     { label: 'VERIFIED STUDENT',     result: 'granted' },
  PENDING_VERIFICATION: { label: 'PENDING VERIFICATION', result: 'denied' },
  INVALID_QR:           { label: 'INVALID QR CODE',      result: 'denied' },
  REVOKED_QR:           { label: 'REVOKED QR CODE',      result: 'denied' },
  EXPIRED_QR:           { label: 'EXPIRED QR CODE',      result: 'denied' },
  REJECTED_STUDENT:     { label: 'REJECTED STUDENT',     result: 'denied' },
  FLAGGED_REVIEW:       { label: 'FLAGGED – REVIEW',     result: 'review' }
};

/**
 * The decision, in the order the requirements list it. Pure: takes rows, returns { code, reason }.
 *   student / verificationStatus come from the database; qr is the QR record (null when a student was found by School ID and has none).
 */
function decide({ student, verificationStatus, qr }, now = new Date()) {
  if (!student) return { code: 'INVALID_QR', reason: 'No student account belongs to this QR code' };
  if (verificationStatus === 'rejected' || student.status === 'rejected') {
    return { code: 'REJECTED_STUDENT', reason: student.rejection_reason ? `Verification rejected: ${student.rejection_reason}` : 'Student verification was rejected' };
  }
  if (verificationStatus !== 'verified' || student.status === 'pending') return { code: 'PENDING_VERIFICATION', reason: 'Student has not completed verification' };
  if (student.status === 'expired') return { code: 'EXPIRED_QR', reason: `Student pass expired ${student.valid_until}` };
  if (student.status === 'flagged') return { code: 'FLAGGED_REVIEW', reason: 'Pass flagged for possible sharing, full fare charged' };
  if (!qr) return { code: 'INVALID_QR', reason: 'No QR code has been issued to this student' };
  if (qr.status === 'revoked') return { code: 'REVOKED_QR', reason: qr.revoke_reason ? `QR code revoked: ${qr.revoke_reason}` : 'QR code has been revoked' };
  if (qr.status === 'expired' || qr.expires_at <= now) return { code: 'EXPIRED_QR', reason: 'QR code has expired' };
  return { code: 'VERIFIED_STUDENT', reason: null };
}

const STUDENT_SQL = `SELECT s.*, v.verification_status, v.rejection_reason FROM students s
                       LEFT JOIN student_verifications v ON v.student_id = s.id`;

/** Writes the scan row for EVERY attempt, including ones that identified nobody, and bumps the granted counter.
 *  `clientTxnId` marks an offline check: it is the device's idempotency key, so a retried upload finds the first row instead
 *  of charging the passenger twice. `scannedAt` keeps the time the driver recorded the check, not the time it reached the server. */
async function record(pool, admin, { student, qr, code, reason, method, scannedValue, scannedAt, clientTxnId }) {
  const out = OUTCOMES[code];
  // The fare and discount come from the active fare rule in the database (this driver's route, else the default rule).
  const { routeId, routeName, cfg } = await fares.forScanner(pool, admin);
  const fare = out.result === 'granted' ? grantedFare(!!student.discount_eligible, cfg) : fullFare(cfg);
  const route = admin.unit || routeName || 'Verification Terminal';
  const operator = `${String(admin.node || 'driver').replace(/^verification\./, '')} · ${admin.name}`;
  const at = scannedAt instanceof Date ? scannedAt : new Date();
  const offline = !!clientTxnId;
  let id;
  try {
    id = await withTransaction(pool, async (conn) => {
      if (qr && qr.status === 'active' && qr.expires_at <= new Date()) await conn.query("UPDATE qr_codes SET status = 'expired' WHERE id = ?", [qr.id]);
      const [res] = await conn.query(
        `INSERT INTO scans (student_id, student_name, school_id, qr_code_id, scanned_value, scan_method, verification_result, driver_name,
                            route, operator, fare, fare_amount, discount_amount, result, reason, scanned_by, scanned_at, device_identifier, fare_rule_id, route_id,
                            client_txn_id, offline, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [student ? student.id : null, student ? student.name : null, student ? student.school_id : null, qr ? qr.id : null,
          scannedValue ? String(scannedValue).slice(0, 255) : null, method, code, admin.name, route, operator,
          student ? fare.text : 'No fare', student ? fare.amount : 0, student ? fare.discount : 0, out.result, reason || null, admin.id, at, admin.deviceIdentifier || null, student ? (cfg.ruleId || fare.ruleId || null) : null, routeId,
          clientTxnId || null, offline ? 1 : 0, offline ? new Date() : null]);
      if (code === 'VERIFIED_STUDENT') await conn.query('UPDATE students SET scans = scans + 1 WHERE id = ?', [student.id]);
      return res.insertId;
    });
  } catch (err) {
    // The unique key (scanned_by, client_txn_id) rejected a retried offline item. Return the original row untouched:
    // the scan counter was not incremented twice and no second fraud e-mail was sent.
    if (err && err.code === 'ER_DUP_ENTRY' && clientTxnId) {
      const [rows] = await pool.query('SELECT * FROM scans WHERE scanned_by = ? AND client_txn_id = ? LIMIT 1', [admin.id, clientTxnId]);
      if (rows[0]) {
        const existing = rows[0];
        return {
          scan: ser.scan(existing), cfg, duplicate: true,
          fare: { text: existing.fare, amount: Number(existing.fare_amount), discount: Number(existing.discount_amount), ruleId: existing.fare_rule_id || null }
        };
      }
    }
    throw err;
  }
  if (student && code === 'FLAGGED_REVIEW') {
    await sendEmail(pool, student, 'Fraud alert — scan flagged for review',
      `Hi ${student.name}, a scan on your pass (School ID ${student.school_id}) was flagged for possible pass sharing. Full fare was charged pending review.`);
  }
  const [rows] = await pool.query('SELECT * FROM scans WHERE id = ?', [id]);
  return { scan: ser.scan(rows[0]), fare, cfg, duplicate: false };
}

/** What the driver is shown. Deliberately small: no email, phone or photo. Nothing at all when nobody was identified. */
function present({ code, reason, student, scan, fare, cfg }) {
  const out = OUTCOMES[code];
  return {
    code, label: out.label, result: out.result, ok: code === 'VERIFIED_STUDENT', reason: reason || null,
    student: student ? { name: student.name, schoolId: student.school_id, school: student.school, program: student.program, level: student.level } : null,
    discountStatus: student ? discountStatusText(!!student.discount_eligible, cfg) : '—',
    fare: student ? fare.text : '—',
    scan
  };
}

async function finish(pool, admin, ctx) {
  const d = decide(ctx);
  const recorded = await record(pool, admin, { ...ctx, ...d });
  const out = present({ ...d, student: ctx.student, scan: recorded.scan, fare: recorded.fare, cfg: recorded.cfg });
  return { ...out, duplicate: !!recorded.duplicate };
}

/** A scanned QR code. The database is the only authority: the picture proves nothing by itself. */
async function scanQr(pool, admin, { code, scannedAt = null, clientTxnId = null }) {
  const raw = String(code || '').trim();
  if (!raw) throw badRequest('Nothing was scanned');
  const token = parsePayload(raw);
  const base = { method: 'qr', scannedValue: raw.slice(0, 60), student: null, qr: null, verificationStatus: null, scannedAt, clientTxnId };
  if (!token) return finish(pool, admin, base);               // not a TransitPass code at all -> INVALID_QR
  const [qrs] = await pool.query('SELECT * FROM qr_codes WHERE qr_token = ?', [token]);
  const qr = qrs[0];
  if (!qr) return finish(pool, admin, base);
  const [rows] = await pool.query(`${STUDENT_SQL} WHERE s.id = ?`, [qr.student_id]);
  const student = rows[0] || null;
  return finish(pool, admin, { method: 'qr', scannedValue: null, student, qr, verificationStatus: student ? student.verification_status : null, scannedAt, clientTxnId });
}

/** Manual fallback: the driver types a School ID. Still checked against the database, using that student's newest QR record. */
async function lookupSchoolId(pool, admin, { schoolId, scannedAt = null, clientTxnId = null }) {
  const id = String(schoolId || '').trim().slice(0, 40);
  if (!id) throw badRequest('Enter a School ID');
  const [rows] = await pool.query(`${STUDENT_SQL} WHERE s.school_id = ?`, [id]);
  const student = rows[0];
  if (!student) return finish(pool, admin, { method: 'manual', scannedValue: id, student: null, qr: null, verificationStatus: null, scannedAt, clientTxnId });
  const [qrs] = await pool.query(
    "SELECT * FROM qr_codes WHERE student_id = ? ORDER BY (status = 'active') DESC, generated_at DESC LIMIT 1", [student.id]);
  return finish(pool, admin, { method: 'manual', scannedValue: id, student, qr: qrs[0] || null, verificationStatus: student.verification_status, scannedAt, clientTxnId });
}

/** A device clock that is far ahead is refused; a very old queued check is refused rather than rewriting history. */
function checkedScannedAt(value) {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) throw badRequest('The recorded time of this offline check is not valid');
  const now = Date.now();
  if (at.getTime() > now + CLOCK_TOLERANCE_MS) throw badRequest("The recorded time is in the future. Check this device's clock.");
  if (now - at.getTime() > OFFLINE_MAX_AGE_MS) throw badRequest('This offline check is more than 7 days old, so it can no longer be synchronized.');
  return at;
}

/**
 * Synchronizes checks a driver recorded without internet. Each item carries the device's idempotency key, so replaying the
 * batch (a reply was lost, the app restarted) is harmless. One bad item never discards the rest of the device's queue.
 * The response is always 200: `results` says, per item, whether the server accepted it and what the verification decided.
 */
async function syncBatch(pool, admin, { items }) {
  const results = [];
  for (const item of items) {
    try {
      const at = checkedScannedAt(item.scannedAt);
      const found = item.method === 'manual'
        ? await lookupSchoolId(pool, admin, { schoolId: item.value, scannedAt: at, clientTxnId: item.clientId })
        : await scanQr(pool, admin, { code: item.value, scannedAt: at, clientTxnId: item.clientId });
      const scan = found.scan;
      const isTransaction = scan.result === 'granted' || scan.result === 'review';
      results.push({
        clientId: item.clientId, ok: true, duplicate: !!found.duplicate,
        code: found.code, label: found.label, result: found.result,
        scanId: scan.id, reference: isTransaction ? txnReference(scan.id) : null,
        fare: found.fare, scannedAt: scan.scannedAt
      });
    } catch (e) {
      results.push({
        clientId: item.clientId, ok: false,
        error: e && e.status && e.status < 500 ? e.message : 'The server could not save this check. It stays on the device and can be retried.'
      });
    }
  }
  return {
    results,
    synced: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    duplicates: results.filter((r) => r.duplicate).length
  };
}

module.exports = { OUTCOMES, decide, scanQr, lookupSchoolId, syncBatch };
