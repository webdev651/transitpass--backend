'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const adminProfile = require('../services/adminProfile');
const { validate } = require('../middleware/validate');
const { signToken, requireRole } = require('../middleware/auth');
const schemas = require('../schemas');
const ser = require('../lib/serialize');
const { toPayload } = require('../lib/qrToken');
const { audit } = require('../lib/audit');
const drivers = require('../services/drivers');
const verification = require('../services/studentVerification');
const qr = require('../services/qr');
const review = require('../services/studentReview');
const activity = require('../services/activity');
const { notFound } = require('../lib/httpError');

/** Staff account (any signed-in admin or driver) plus the administrator-only management routes. Mounted behind requireAuth. */
module.exports = function adminRoutes(pool) {
  const r = express.Router();

  // Own account (any signed-in admin or driver). The administrator profile page and the driver "My Account" page share these.
  r.get('/account', async (req, res) => res.json(await adminProfile.profile(pool, req.admin)));

  r.patch('/account', validate(schemas.accountUpdate), async (req, res) => {
    const { row, changed } = await adminProfile.updateProfile(pool, req.admin, req.valid.body);
    req.auditNote = changed.length ? `Updated own profile: ${changed.join(', ')}` : 'Saved own profile (no changes)';
    // Token only carries the id, so it stays valid across a username change; returned for convenience.
    res.json({ admin: ser.admin(row), changed, token: signToken(row) });
  });

  // Wrong current-password guesses are limited per account (a stolen session cannot be used to brute-force the password).
  const pwLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true,
    keyGenerator: (req) => `pw:${req.admin.id}`,
    skip: () => config.isTest && !process.env.TEST_RATE_LIMIT,
    message: { error: 'Too many failed password attempts. Try again in a few minutes.' }
  });
  r.post('/account/password', pwLimiter, validate(schemas.passwordChange), async (req, res) => {
    const { current, new: next } = req.valid.body;
    try {
      const row = await adminProfile.changePassword(pool, req.admin, { current, next });
      req.auditNote = 'Changed own password (other sessions signed out)';
      res.json({ message: 'Password updated.', token: signToken(row) });
    } catch (e) {
      req.auditNote = `Password change refused: ${e.message}`.slice(0, 200);
      throw e;
    }
  });

  // The only administrator can never be deleted or deactivated. These routes exist so the refusal is explicit and recorded.
  r.delete('/account', requireRole('admin'), async (req, res) => { req.auditNote = 'Refused: tried to delete the only administrator account'; await adminProfile.refuseRemoval(pool, req.admin, 'delete'); });
  r.post('/account/deactivate', requireRole('admin'), async (req, res) => { req.auditNote = 'Refused: tried to deactivate the only administrator account'; await adminProfile.refuseRemoval(pool, req.admin, 'deactivate'); });

  /* ---------- everything below is for administrators only ---------- */
  const adminOnly = requireRole('admin');
  const actor = (req) => ({ type: 'admin', id: req.admin.id, name: req.admin.name });

  // Drivers: register, edit, approve, activate, deactivate, reset password
  r.get('/drivers', adminOnly, validate(schemas.driverList, 'query'), async (req, res) => res.json(await drivers.list(pool, req.valid.query)));
  r.post('/drivers', adminOnly, validate(schemas.driverCreate), async (req, res) => res.status(201).json({ driver: await drivers.create(pool, req.valid.body, req.admin) }));
  r.patch('/drivers/:id', adminOnly, validate(schemas.driverUpdate), async (req, res) => res.json({ driver: await drivers.update(pool, req.params.id, req.valid.body) }));
  r.post('/drivers/:id/actions/:action', adminOnly, async (req, res) => {
    if (!drivers.ACTION_NAMES.includes(req.params.action)) throw notFound(`Unknown action: ${req.params.action}`);
    res.json({ driver: await drivers.act(pool, req.params.id, req.params.action) });
  });
  r.post('/drivers/:id/password', adminOnly, validate(schemas.driverPassword), async (req, res) => {
    await drivers.resetPassword(pool, req.params.id, req.valid.body.password);
    res.json({ message: 'Password reset. The driver has been signed out everywhere.' });
  });

  // Student verification requests
  r.get('/verifications', adminOnly, validate(schemas.verificationList, 'query'), async (req, res) => {
    const d = await verification.list(pool, req.valid.query);
    await review.attachDocuments(pool, d.items);            // adds the state of each uploaded document to every row
    res.json(d);
  });
  r.get('/verifications/:studentId/registrar-check', adminOnly, async (req, res) => res.json({ registrar: await verification.registrarCheck(pool, req.params.studentId) }));
  r.post('/verifications/:studentId/approve', adminOnly, validate(schemas.verificationApprove), async (req, res) =>
    res.json({ student: await verification.approve(pool, req.params.studentId, req.admin, req.valid.body.note) }));
  r.post('/verifications/:studentId/reject', adminOnly, validate(schemas.verificationReject), async (req, res) =>
    res.json({ student: await verification.reject(pool, req.params.studentId, req.admin, req.valid.body.reason) }));
  r.post('/verifications/:studentId/reopen', adminOnly, async (req, res) => res.json({ student: await verification.reopen(pool, req.params.studentId, req.admin) }));

  // Student management: the review panel for one student, their uploaded documents, and the decision on each document
  r.get('/verifications/:studentId', adminOnly, async (req, res) => res.json(await review.detail(pool, req.params.studentId)));
  r.get('/verifications/:studentId/documents/:kind', adminOnly, async (req, res) => {
    const f = await review.documentFile(pool, req.params.studentId, req.params.kind);
    const [who] = await pool.query('SELECT name, school_id FROM students WHERE id = ?', [req.params.studentId]);
    await activity.log(pool, { admin: req.admin, category: 'student', action: 'student.document.view', description: `Viewed the ${f.noun} of ${who[0].name} (${who[0].school_id})`, targetId: req.params.studentId, ip: req.ip }); // private files: opening one is recorded
    res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    res.sendFile(f.abs);
  });
  r.post('/verifications/:studentId/documents/:kind/review', adminOnly, validate(schemas.documentReview), async (req, res) =>
    res.json(await review.reviewDocument(pool, req.params.studentId, req.params.kind, req.admin, req.valid.body)));

  // Student information-correction requests (sent from the student portal)
  r.get('/correction-requests', adminOnly, validate(schemas.correctionList, 'query'), async (req, res) => res.json(await review.listCorrections(pool, req.valid.query)));
  r.post('/correction-requests/:id/approve', adminOnly, validate(schemas.correctionApprove), async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('Correction request not found');
    res.json({ request: await review.approveCorrection(pool, req.params.id, req.admin, req.valid.body.note) });
  });
  r.post('/correction-requests/:id/reject', adminOnly, validate(schemas.correctionReject), async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('Correction request not found');
    res.json({ request: await review.rejectCorrection(pool, req.params.id, req.admin, req.valid.body.reason) });
  });

  // Student discount-renewal requests
  r.get('/renewal-requests', adminOnly, validate(schemas.renewalList, 'query'), async (req, res) => res.json(await review.listRequests(pool, { type: 'renewal', ...req.valid.query })));
  r.post('/renewal-requests/:id/approve', adminOnly, validate(schemas.requestApprove), async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('Renewal request not found');
    res.json({ request: await review.approveRenewal(pool, req.params.id, req.admin, req.valid.body.note) });
  });
  r.post('/renewal-requests/:id/reject', adminOnly, validate(schemas.requestReject), async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('Renewal request not found');
    res.json({ request: await review.rejectRenewal(pool, req.params.id, req.admin, req.valid.body.reason) });
  });

  // Student QR replacement requests
  r.get('/qr-replacement-requests', adminOnly, validate(schemas.qrReplacementList, 'query'), async (req, res) => res.json(await review.listRequests(pool, { type: 'qr_replacement', ...req.valid.query })));
  r.post('/qr-replacement-requests/:id/approve', adminOnly, validate(schemas.requestApprove), async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('QR replacement request not found');
    res.json({ request: await review.approveQrReplacement(pool, req.params.id, req.admin, req.valid.body.note) });
  });
  r.post('/qr-replacement-requests/:id/reject', adminOnly, validate(schemas.requestReject), async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('QR replacement request not found');
    res.json({ request: await review.rejectQrReplacement(pool, req.params.id, req.admin, req.valid.body.reason) });
  });

  // QR codes: who generated each one, when, and its state
  r.get('/qr-codes', adminOnly, validate(schemas.qrList, 'query'), async (req, res) => res.json(await qr.list(pool, req.valid.query)));
  r.post('/qr-codes/:id/revoke', adminOnly, validate(schemas.qrRevoke), async (req, res) => {
    await qr.revoke(pool, req.params.id, actor(req), req.valid.body.reason);
    res.json({ message: 'QR code revoked.' });
  });
  r.post('/qr-codes/:id/reactivate', adminOnly, async (req, res) => {
    await qr.reactivate(pool, req.params.id, actor(req));
    res.json({ message: 'QR code reactivated.' });
  });

  // Viewing the full QR token is security-sensitive: limit how often an administrator can fetch it.
  const payloadLimiter = rateLimit({
    windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
    skip: () => config.isTest && !process.env.TEST_RATE_LIMIT,
    keyGenerator: (req) => `qr-payload:${req.admin.id}`,
    message: { error: 'Too many QR payload requests. Try again in a minute.' }
  });
  // QR code payload (full token) for an administrator to render/download/print a QR pass.
  // Audited because the token is the scannable secret of a pass.
  r.get('/qr-codes/:id/payload', payloadLimiter, adminOnly, async (req, res) => {
    const [rows] = await pool.query(
      `SELECT q.id, q.qr_token, q.status, q.expires_at, q.student_id, s.name AS student_name, s.school_id AS student_school_id
       FROM qr_codes q JOIN students s ON s.id = q.student_id WHERE q.id = ?`, [req.params.id]);
    const q = rows[0];
    if (!q) throw notFound('QR code not found');
    await audit(pool, req, 'qr', 'qr.payload.view', `Viewed the QR payload of code #${q.id} (student ${q.student_name}, ${q.student_school_id}, ${q.status})`);
    res.json({ qr: { id: q.id, token: q.qr_token, payload: toPayload(q.qr_token), status: q.status, expiresAt: q.expires_at, student: { name: q.student_name, schoolId: q.student_school_id } } });
  });

  return r;
};
