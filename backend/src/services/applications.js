'use strict';
// Application status monitoring: one place to see where every student application stands (verification, uploaded
// documents, pending correction requests, how long it has been waiting, and the last decision made).
const verification = require('./studentVerification');
const review = require('./studentReview');
const { toDate } = require('../lib/time');

async function summary(pool) {
  const [[v]] = await pool.query(
    `SELECT COALESCE(SUM(verification_status = 'pending'), 0) AS pending, COALESCE(SUM(verification_status = 'verified'), 0) AS verified,
            COALESCE(SUM(verification_status = 'rejected'), 0) AS rejected, MIN(IF(verification_status = 'pending', submitted_at, NULL)) AS oldest
       FROM student_verifications`);
  const [[d]] = await pool.query(
    `SELECT COUNT(*) AS n FROM students s WHERE (s.id_document IS NOT NULL AND NOT EXISTS (SELECT 1 FROM student_document_reviews r WHERE r.student_id = s.id AND r.kind = 'id'))
        OR (s.enrollment_document IS NOT NULL AND NOT EXISTS (SELECT 1 FROM student_document_reviews r WHERE r.student_id = s.id AND r.kind = 'enrollment'))`);
  const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM student_requests WHERE type = 'correction' AND status = 'pending'");
  const [[rn]] = await pool.query("SELECT COUNT(*) AS n FROM student_requests WHERE type = 'renewal' AND status = 'pending'");
  const [[qr]] = await pool.query("SELECT COUNT(*) AS n FROM student_requests WHERE type = 'qr_replacement' AND status = 'pending'");
  const [[h]] = await pool.query('SELECT COUNT(*) AS n FROM application_review_history WHERE created_at >= (UTC_TIMESTAMP(3) - INTERVAL 7 DAY)');
  return {
    pending: Number(v.pending), verified: Number(v.verified), rejected: Number(v.rejected),
    oldestPendingAt: v.oldest ? toDate(v.oldest).toISOString() : null,
    awaitingDocumentReview: Number(d.n), pendingCorrections: Number(c.n), pendingRenewals: Number(rn.n), pendingQrReplacements: Number(qr.n), decisionsLast7Days: Number(h.n)
  };
}

/** The verification list (same query the Verifications page uses) enriched with correction counts and the last decision. */
async function monitor(pool, query) {
  const d = await verification.list(pool, query);
  await review.attachDocuments(pool, d.items);
  const ids = d.items.map((i) => i.id);
  const corr = new Map();
  const last = new Map();
  if (ids.length) {
    const [c] = await pool.query("SELECT student_id, COUNT(*) AS n FROM student_requests WHERE type = 'correction' AND status = 'pending' AND student_id IN (?) GROUP BY student_id", [ids]);
    c.forEach((r) => corr.set(r.student_id, Number(r.n)));
    const [l] = await pool.query(
      `SELECT h.student_id, h.event, h.admin_name, h.created_at FROM application_review_history h
         JOIN (SELECT student_id, MAX(id) AS mid FROM application_review_history WHERE student_id IN (?) GROUP BY student_id) m ON m.mid = h.id`, [ids]);
    l.forEach((r) => last.set(r.student_id, { event: r.event, by: r.admin_name, at: toDate(r.created_at).toISOString() }));
  }
  const now = Date.now();
  d.items = d.items.map((s) => {
    const submitted = s.verification && s.verification.submittedAt ? new Date(s.verification.submittedAt).getTime() : null;
    const waiting = s.verification && s.verification.status === 'pending' && submitted ? Math.max(0, Math.floor((now - submitted) / 86400000)) : null;
    return { ...s, pendingCorrections: corr.get(s.id) || 0, lastDecision: last.get(s.id) || null, waitingDays: waiting };
  });
  return d;
}

module.exports = { summary, monitor };
