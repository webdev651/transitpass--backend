'use strict';
const { displayParts, toDate } = require('./time');

/** Public student shape (mirrors the frontend record). The face descriptor is deliberately never included. */
function student(r) {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    school: r.school,
    program: r.program,
    level: r.level,
    status: r.status,
    validUntil: r.valid_until,
    scans: r.scans,
    email: r.email,
    phone: r.phone,
    // qrActive is true only when a live (active, unexpired) QR code exists; falls back to the legacy flag on rows without the join.
    qrActive: r.active_qr_id !== undefined ? !!r.active_qr_id : !!r.qr_active,
    qrVersion: r.qr_version,
    verification: r.verification_status ? {
      status: r.verification_status,
      method: r.verification_method || null,
      date: r.verification_date ? toDate(r.verification_date).toISOString() : null,
      by: r.verified_by_name || null,
      rejectionReason: r.rejection_reason || null,
      note: r.verification_note || null,
      submittedAt: r.submitted_at ? toDate(r.submitted_at).toISOString() : null
    } : undefined,
    faceEnrolled: !!r.face_enrolled,
    facePhoto: r.face_photo || null,
    discountEligible: !!r.discount_eligible,
    createdAt: r.created_at ? toDate(r.created_at).toISOString() : undefined,
    updatedAt: r.updated_at ? toDate(r.updated_at).toISOString() : undefined
  };
}

/** Scan row (optionally joined with the live student row as st_*). */
function scan(r) {
  const at = toDate(r.scanned_at);
  const { date, time, dateWithDay } = displayParts(at);
  return {
    id: r.id,
    studentId: r.student_id,
    student: r.st_name || r.student_name || 'Unknown',
    schoolId: r.st_school_id || r.school_id || '—',
    qrCodeId: r.qr_code_id || null,
    code: r.verification_result || null,
    method: r.scan_method || 'qr',
    driverId: r.scanned_by || null,
    driver: r.driver_name || null,
    route: r.route,
    operator: r.operator,
    fare: r.fare,
    result: r.result,
    reason: r.reason || undefined,
    scannedAt: at.toISOString(),
    offline: !!r.offline,
    syncedAt: r.synced_at ? toDate(r.synced_at).toISOString() : null,
    date, time, dateWithDay
  };
}

function email(r) {
  const at = toDate(r.sent_at);
  const { date, time } = displayParts(at);
  return {
    id: r.id, to: r.to_email, student: r.student_name, schoolId: r.school_id,
    subject: r.subject, body: r.body, status: r.status, sentAt: at.toISOString(), date, time
  };
}

function admin(r) {
  return {
    id: r.id, username: r.username, name: r.name, email: r.email, node: r.node,
    role: r.role || 'admin', status: r.status || 'active', phone: r.phone || null, unit: r.unit || null,
    lastLoginAt: r.last_login_at ? toDate(r.last_login_at).toISOString() : null,
    createdAt: r.created_at ? toDate(r.created_at).toISOString() : undefined
  };
}

/** QR code row (admin / student views). The full token is only returned when withToken is set, to the QR's own student. */
function qr(r, { withToken = false } = {}) {
  const { hint, toPayload } = require('./qrToken');
  const status = r.effective_status || r.status;
  return {
    id: r.id, studentId: r.student_id, student: r.student_name, schoolId: r.student_school_id,
    tokenHint: hint(r.qr_token),
    ...(withToken ? { payload: toPayload(r.qr_token) } : {}),
    status,
    generatedBy: { type: r.generated_by_type, name: r.generated_by_name },
    generatedAt: toDate(r.generated_at).toISOString(),
    expiresAt: toDate(r.expires_at).toISOString(),
    revokedAt: r.revoked_at ? toDate(r.revoked_at).toISOString() : null,
    revokedBy: r.revoked_by_name || null,
    revokeReason: r.revoke_reason || null
  };
}

function operator(r) {
  return { id: r.id, name: r.name, trips: r.trips, discount: Number(r.discount_amount), status: r.status };
}

module.exports = { student, scan, email, admin, operator, qr };
