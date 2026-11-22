'use strict';
// Pure helpers for the student portal: turns database rows into the statuses the student sees.
const config = require('../config');
const { tzOffsetMinutes, toDate, displayParts } = require('./time');
const { round2 } = require('./fare');

const DAY = 86400000;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** students.valid_until is free text ("31 Mar 2027"). Returns the END of that day in the app timezone, or null when it is not a date. */
function parseValidUntil(text) {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(String(text || '').trim());
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    const guess = Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], 23, 59, 59);
    return new Date(guess - tzOffsetMinutes(new Date(guess)) * 60000);
  }
  const iso = /^\d{4}-\d{2}-\d{2}/.test(String(text || '')) ? new Date(text) : null;
  return iso && !Number.isNaN(iso.getTime()) ? iso : null;
}

const LABELS = { pending: 'Pending', eligible: 'Eligible', not_eligible: 'Not Eligible', expired: 'Expired', suspended: 'Suspended' };

/**
 * The student's discount status. Row must carry verification_status (joined from student_verifications).
 * Only an administrator can move a student to "eligible": nothing here is ever taken from the student.
 */
function discountState(s, now = new Date(), percentOverride = null) {
  const v = s.verification_status;
  const until = parseValidUntil(s.valid_until);
  const daysLeft = until ? Math.ceil((until.getTime() - now.getTime()) / DAY) : null;
  let status;
  let note;
  if (v === 'rejected' || s.status === 'rejected') { status = 'not_eligible'; note = 'Your verification was not approved, so no discount applies.'; }
  else if (v !== 'verified' || s.status === 'pending') { status = 'pending'; note = 'Waiting for an administrator to verify your enrollment.'; }
  else if (s.status === 'flagged') { status = 'suspended'; note = 'Your pass is under registrar review. Full fare applies until it is resolved.'; }
  else if (s.status === 'expired' || (until && until.getTime() < now.getTime())) { status = 'expired'; note = 'Your discount has expired. Request a renewal to continue riding at the student fare.'; }
  else if (!s.discount_eligible) { status = 'not_eligible'; note = 'An administrator has marked your pass as not eligible for the discount. Full fare applies.'; }
  else { status = 'eligible'; note = 'You are eligible for the student discount.'; }
  const basePercent = percentOverride == null ? config.fare.discountRate * 100 : percentOverride;   // percentOverride = the active default rule (services/fares.js)
  const percent = status === 'eligible' ? Math.round(basePercent * 100) / 100 : 0;
  return {
    status, label: LABELS[status], percent, note,
    validUntil: s.valid_until || null,
    validUntilDate: until ? until.toISOString() : null,
    daysLeft: status === 'eligible' || status === 'expired' ? daysLeft : null
  };
}

const registrationState = (s) => {
  const v = s.verification_status;
  const status = v === 'verified' ? 'approved' : v === 'rejected' ? 'rejected' : 'pending';
  return { status, label: status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Pending' };
};

const VERIFY_METHOD = {
  admin_review: 'Reviewed by an administrator',
  admin_issued: 'Issued by the registrar',
  legacy: 'Carried over from registrar records',
  registrar_db: 'Matched with the registrar database'
};

/** TXN-00000123: a stable reference number made from the scan id (no personal data in it). */
const txnReference = (id) => `TXN-${String(id).padStart(8, '0')}`;

/** A scan row -> the transaction the student sees. Regular fare = what was charged + what was discounted. */
function transaction(r) {
  const at = toDate(r.scanned_at);
  const { date, time } = displayParts(at);
  const final = Number(r.fare_amount);
  const discount = Number(r.discount_amount);
  const regular = round2(final + discount);
  return {
    id: r.id,
    reference: txnReference(r.id),
    scannedAt: at.toISOString(), date, time,
    service: r.route,
    operator: r.operator,
    driver: r.driver_name || '—',
    regularFare: regular,
    discountPercent: regular > 0 ? Math.round((discount / regular) * 100) : 0,
    discountAmount: discount,
    finalFare: final,
    result: r.result,
    status: r.result === 'granted' ? (discount > 0 ? 'Discount applied' : 'Full fare') : 'Full fare — under review',
    note: r.reason || null
  };
}

/** Notification category from the message title, so the portal can show an icon and filter. */
const CATEGORY_RULES = [
  [/correction|document/i, 'profile'],
  [/qr/i, 'qr'],
  [/discount|validity|expire|renew/i, 'discount'],
  [/approved|not approved|registration|credential|reinstated|revoked|flagged|fraud/i, 'registration'],
  [/profile|details|password|email|request|updated/i, 'profile']
];
const categoryOf = (subject) => (CATEGORY_RULES.find(([re]) => re.test(subject)) || [null, 'general'])[1];

module.exports = { parseValidUntil, discountState, registrationState, VERIFY_METHOD, txnReference, transaction, categoryOf, LABELS };
