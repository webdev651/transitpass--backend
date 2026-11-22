'use strict';
const { withTransaction } = require('../db');
const { badRequest, notFound, conflict } = require('../lib/httpError');
const { sendEmail } = require('../lib/email');
const { grantedFare, fullFare, discountStatusText } = require('../lib/fare');
const fares = require('./fares');
const { faceDistance, faceConfidence, isMatch, parseDescriptor } = require('../lib/face');
const ser = require('../lib/serialize');

/**
 * Accepts what a QR scanner or the manual-entry box produces:
 *   "2023-1182"            bare School ID (manual entry)
 *   "2023-1182::v2"        pass QR payload (School ID + pass version)
 *   "TRANSITPASS|2023-1182[::v2]"
 * Returns { schoolId, version } — version is null when the input carried none.
 */
function parsePassId(raw) {
  let text = String(raw || '').trim();
  const parts = text.split('|');
  if (parts.length >= 2 && parts[0].toUpperCase() === 'TRANSITPASS') text = parts[1];
  let version = null;
  const sep = text.indexOf('::v');
  if (sep !== -1) {
    const v = text.slice(sep + 3);
    version = /^\d+$/.test(v) ? Number(v) : -1; // malformed suffix never matches a real version
    text = text.slice(0, sep);
  }
  return { schoolId: text.trim().slice(0, 40), version };
}

async function findStudent(pool, schoolId) {
  const [rows] = await pool.query('SELECT * FROM students WHERE school_id = ?', [schoolId]);
  return rows[0] || null;
}

/** QR/registry decision only — no side effects. `cfg` = the active fare rule (see services/fares.js). Mirrors the terminal's resolveQr(), plus pass-version enforcement. */
function decide(s, version, cfg) {
  if (!s.qr_active) return { decision: 'denied', fare: fullFare(cfg), reason: 'QR code deactivated by registrar' };
  if (version !== null && version !== s.qr_version) {
    return { decision: 'denied', fare: fullFare(cfg), reason: 'QR code was replaced by a newer version — present the latest pass' };
  }
  if (s.status === 'active') return { decision: 'granted', fare: grantedFare(!!s.discount_eligible, cfg) };
  if (s.status === 'flagged') return { decision: 'review', fare: fullFare(cfg), reason: 'flagged for possible pass sharing — full fare charged' };
  if (s.status === 'pending') return { decision: 'denied', fare: fullFare(cfg), reason: 'registrar approval pending' };
  return { decision: 'denied', fare: fullFare(cfg), reason: `pass expired ${s.valid_until}` };
}

const hasFace = (s) => !!s.face_enrolled && Array.isArray(parseDescriptor(s.face_descriptor));

/** Writes the scan row (and bumps the student's granted-scan counter) atomically. */
async function record(pool, admin, s, result, fare, reason) {
  const operator = `${String(admin.node).replace(/^verification\./, '')} · ${admin.name}`;
  const id = await withTransaction(pool, async (conn) => {
    const [res] = await conn.query(
      `INSERT INTO scans (student_id, student_name, school_id, route, operator, fare, fare_amount, discount_amount, result, reason, scanned_by, fare_rule_id)
       VALUES (?, ?, ?, 'Verification Terminal', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.name, s.school_id, operator, fare.text, fare.amount, fare.discount, result, reason || null, admin.id, fare.ruleId || null]);
    if (result === 'granted') await conn.query('UPDATE students SET scans = scans + 1 WHERE id = ?', [s.id]);
    return res.insertId;
  });
  const [rows] = await pool.query('SELECT * FROM scans WHERE id = ?', [id]);
  return ser.scan(rows[0]);
}

function body({ status, result, s, fare, reason, scan, passId, extra, cfg }) {
  const verdict = status === 'face_required' ? 'REVIEW' : result === 'granted' ? 'VALID' : result === 'review' ? 'REVIEW' : 'INVALID';
  return {
    status,                                   // "final" | "face_required"
    result,                                   // "granted" | "review" | "denied" | "unknown"
    verdict,                                  // "VALID" | "REVIEW" | "INVALID" — what the terminal banner shows
    passId,
    student: s ? ser.student(s) : null,
    discountStatus: s ? discountStatusText(!!s.discount_eligible, cfg) : '—',
    fare: fare ? fare.text : '—',
    reason: reason || null,
    scan: scan || null,                       // the logged scan; null until the decision is final
    ...extra
  };
}

const unknown = (passId, reason = 'School ID not found in registry', extra) =>
  body({ status: 'final', result: 'unknown', s: null, fare: null, reason, passId, extra });

async function grant(pool, admin, s, fare, note, passId, extra, cfg) {
  const scan = await record(pool, admin, s, 'granted', fare, note);
  const fresh = (await pool.query('SELECT * FROM students WHERE id = ?', [s.id]))[0][0];
  return body({ status: 'final', result: 'granted', s: fresh, fare, reason: note, scan, passId, extra, cfg });
}

/** Logs denied/review outcomes and sends the matching notification. */
async function settleNonGrant(pool, admin, s, d, passId, extra, cfg) {
  const scan = await record(pool, admin, s, d.decision, d.fare, d.reason);
  if (d.decision === 'denied' && d.reason.startsWith('pass expired')) {
    await sendEmail(pool, s, 'Discount denied — pass expired',
      `Hi ${s.name}, a scan on your pass (School ID ${s.school_id}) at the Verification Terminal was denied because your pass expired on ${s.valid_until}. Please renew to restore your discount.`);
  }
  if (d.decision === 'review') {
    await sendEmail(pool, s, 'Fraud alert — scan flagged for review',
      `Hi ${s.name}, a scan on your pass (School ID ${s.school_id}) at the Verification Terminal was flagged for possible pass sharing. Full fare was charged pending registrar review.`);
  }
  return body({ status: 'final', result: d.decision, s, fare: d.fare, reason: d.reason, scan, passId, extra, cfg });
}

async function faceMismatch(pool, admin, s, passId, extra, cfg) {
  const reason = 'face verification failed — possible identity mismatch';
  const scan = await record(pool, admin, s, 'review', fullFare(cfg), reason);
  await sendEmail(pool, s, 'Identity check failed at boarding',
    `Hi ${s.name}, a scan on your pass (School ID ${s.school_id}) passed the QR check but failed face verification at the Verification Terminal. Full fare was charged pending registrar review.`);
  return body({ status: 'final', result: 'review', s, fare: fullFare(cfg), reason, scan, passId, extra, cfg });
}

/** Step 1 — QR / School ID. Returns a final result, or status:"face_required" (nothing logged yet). */
async function scanPass(pool, admin, { passId: raw, faceUnavailable }) {
  const { schoolId, version } = parsePassId(raw);
  if (!schoolId) throw badRequest('Empty pass ID');
  const s = await findStudent(pool, schoolId);
  if (!s) return unknown(schoolId);
  const { cfg } = await fares.forScanner(pool, admin);   // the active fare rule from the database
  const d = decide(s, version, cfg);
  if (d.decision !== 'granted') return settleNonGrant(pool, admin, s, d, schoolId, undefined, cfg);

  if (hasFace(s) && !faceUnavailable) {
    return body({ status: 'face_required', result: 'granted', s, fare: d.fare, reason: 'QR accepted — awaiting face verification…', passId: schoolId, cfg });
  }
  const note = s.face_enrolled ? 'face on file but verification unavailable this session — QR-only decision' : null;
  return grant(pool, admin, s, d.fare, note, schoolId, undefined, cfg);
}

/** Loads the student for the follow-up face steps and checks the QR decision is still "granted". */
async function pendingFaceStudent(pool, admin, raw) {
  const { schoolId, version } = parsePassId(raw);
  if (!schoolId) throw badRequest('Empty pass ID');
  const s = await findStudent(pool, schoolId);
  if (!s) throw notFound('School ID not found in registry');
  const { cfg } = await fares.forScanner(pool, admin);
  const d = decide(s, version, cfg);
  if (d.decision !== 'granted') {
    throw conflict('QR check did not pass, so face verification does not apply', { result: d.decision, reason: d.reason });
  }
  if (!hasFace(s)) throw conflict('This student has no face enrolled');
  return { s, d, schoolId, cfg };
}

/** Step 2 — compare a fresh capture with the enrolled face (the stored descriptor never leaves the server). */
async function verifyFace(pool, admin, { passId: raw, descriptor }) {
  const { s, d, schoolId, cfg } = await pendingFaceStudent(pool, admin, raw);
  const distance = faceDistance(descriptor, parseDescriptor(s.face_descriptor));
  const confidence = faceConfidence(distance);
  const match = isMatch(distance);
  const extra = { match, confidence, distance: Number.isFinite(distance) ? Math.round(distance * 1000) / 1000 : null };
  if (!match) return faceMismatch(pool, admin, s, schoolId, extra, cfg);
  return grant(pool, admin, s, d.fare, `face match ${confidence}% confidence`, schoolId, extra, cfg);
}

/** Conductor override when the face check can't be completed. */
async function skipFace(pool, admin, { passId: raw }) {
  const { s, d, schoolId, cfg } = await pendingFaceStudent(pool, admin, raw);
  return grant(pool, admin, s, d.fare, 'face verification skipped — manual registrar override', schoolId, undefined, cfg);
}

/** "Scan by face": 1:N identification against every enrolled student, then the normal decision. */
async function identify(pool, admin, { descriptor }) {
  const [rows] = await pool.query('SELECT * FROM students WHERE face_enrolled = 1 AND face_descriptor IS NOT NULL');
  let best = null;
  let bestDistance = Infinity;
  for (const row of rows) {
    const dist = faceDistance(descriptor, parseDescriptor(row.face_descriptor));
    if (dist < bestDistance) { best = row; bestDistance = dist; }
  }
  if (!best || !isMatch(bestDistance)) {
    return unknown('', 'No matching face found among enrolled students', { match: false });
  }
  const confidence = faceConfidence(bestDistance);
  const extra = { match: true, confidence, distance: Math.round(bestDistance * 1000) / 1000 };
  const { cfg } = await fares.forScanner(pool, admin);
  const d = decide(best, null, cfg);
  if (d.decision !== 'granted') return settleNonGrant(pool, admin, best, d, best.school_id, extra, cfg);
  return grant(pool, admin, best, d.fare, `face match ${confidence}% confidence`, best.school_id, extra, cfg);
}

module.exports = { parsePassId, decide, scanPass, verifyFace, skipFace, identify };
