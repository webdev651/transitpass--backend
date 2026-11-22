'use strict';
/*
  Student side of the API  ->  /api/student-portal/...

    POST /register          student creates their own account (starts "pending"; JSON, or multipart with photo + documents)
    POST /login             Student ID OR email + password  ->  token
    POST /forgot-password   emails a one-time reset link        POST /reset-password   sets a new password from that link
    GET  /me                the signed-in student
    GET  /me/dashboard | /me/profile | /me/eligibility | /me/transactions | /me/notifications | /me/requests ...
    (everything under /me is limited to the signed-in student's own records)

  This is the ONLY place an account can be created by the person who will use it.
  The driver side (/api/auth/login) can sign in but cannot sign up.
*/
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { signStudentToken, requireStudent, PENDING_MESSAGE } = require('../middleware/auth');
const { unauthorized, notFound } = require('../lib/httpError');
const schemas = require('../schemas');
const ser = require('../lib/serialize');
const students = require('../services/students');
const qr = require('../services/qr');
const portal = require('../services/studentPortal');
const refunds = require('../services/refunds');
const uploads = require('../lib/uploads');

// Compared against when the School ID doesn't exist, so response time doesn't reveal which IDs are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

module.exports = function studentPortalRoutes(pool) {
  const r = express.Router();
  const skipInTests = () => config.isTest && !process.env.TEST_RATE_LIMIT;

  // Too many wrong passwords from one IP -> wait a few minutes (correct logins are not counted).
  const loginLimiter = rateLimit({
    windowMs: config.loginRateLimit.windowMs,
    limit: config.loginRateLimit.max,
    standardHeaders: 'draft-7', legacyHeaders: false,
    skipSuccessfulRequests: true, skip: skipInTests,
    message: { error: 'Too many failed sign-in attempts. Try again in a few minutes.' }
  });
  // Stops one IP from creating hundreds of accounts.
  const registerLimiter = rateLimit({
    windowMs: config.registerRateLimit.windowMs,
    limit: config.registerRateLimit.max,
    standardHeaders: 'draft-7', legacyHeaders: false, skip: skipInTests,
    message: { error: 'Too many accounts created from this network. Try again later.' }
  });

  // Resetting a password: a few requests per IP so nobody can spam someone's inbox.
  const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, skip: skipInTests,
    message: { error: 'Too many reset requests. Try again in a few minutes.' }
  });

  // 1) Create account. JSON (API clients) or multipart/form-data (the sign-up page: photo + ID + enrollment document).
  const pickSchema = (req, res, next) => validate(req.is('multipart/form-data') ? schemas.studentRegisterStrict : schemas.studentRegister)(req, res, next);
  r.post('/register', registerLimiter, uploads.maybeMultipart, pickSchema, async (req, res) => {
    const d = req.valid.body;
    const multipart = !!req.is('multipart/form-data');
    const files = req.files || {};
    // Photo and documents are optional. Any file that IS sent is fully checked BEFORE anything is saved.
    const one = (k) => (files[k] || [])[0];
    const photo = one('photo') ? uploads.photoToDataUrl(one('photo')) : null;
    const docs = {};
    if (one('idDocument')) docs.id = uploads.checkDocument(one('idDocument'), 'Student ID document');
    if (one('enrollmentDocument')) docs.enrollment = uploads.checkDocument(one('enrollmentDocument'), 'Enrollment document');
    const student = await students.create(pool, {
      name: d.name, school: d.school, program: d.program, level: d.level, campus: d.campus, section: d.section,
      email: d.email, schoolId: d.schoolId, phone: d.phone,
      status: 'pending',                              // a registrar approves it later
      passwordHash: await bcrypt.hash(d.password, 12) // we never store the real password
    });
    if (photo || Object.keys(docs).length) {
      try {
        const paths = await portal.saveRegistrationFiles(student.id, docs);
        await pool.query('UPDATE students SET profile_photo = ?, id_document = ?, enrollment_document = ? WHERE id = ?',
          [photo, paths.id_document || null, paths.enrollment_document || null, student.id]);
      } catch (err) {                                  // no half-registered accounts
        await students.remove(pool, student.id).catch(() => {});
        throw err;
      }
    }
    // No token: the admin must verify the student first. They can sign in once approved.
    res.status(201).json({ student, message: PENDING_MESSAGE });
  });

  // 2) Sign in with Student ID or email
  r.post('/login', loginLimiter, validate(schemas.studentLogin), async (req, res) => {
    const { password } = req.valid.body;
    const who = req.valid.body.schoolId || req.valid.body.identifier;
    const [rows] = await pool.query('SELECT * FROM students WHERE school_id = ? OR email = ? LIMIT 1', [who, who.toLowerCase()]);
    const row = rows[0];
    // A student a registrar added (no password set) simply cannot sign in yet.
    const hash = row && row.password_hash ? row.password_hash : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hash);
    if (!row || !row.password_hash || !ok) throw unauthorized('Incorrect Student ID / email or password.');
    // Pending and rejected students can sign in to see their verification status; the QR pass stays locked for them.
    res.json({ token: signStudentToken(row), student: await students.get(pool, row.id) });
  });

  // 2b) Forgot / reset password. The reply is the same whether or not the account exists.
  r.post('/forgot-password', resetLimiter, validate(schemas.studentForgot), async (req, res) => {
    const token = await portal.requestPasswordReset(pool, req.valid.body.identifier);
    res.json({
      message: 'If an account matches, a password reset link has been sent to its email address. The link works for ' + config.passwordReset.ttlMinutes + ' minutes.',
      ...(token && config.passwordReset.showLink ? { devResetPath: `student-reset.html?token=${token}` } : {}) // development only (SHOW_RESET_LINK=true)
    });
  });
  r.post('/reset-password', resetLimiter, validate(schemas.studentReset), async (req, res) => {
    await portal.resetPassword(pool, req.valid.body);
    res.json({ message: 'Your password was changed. You can sign in now.' });
  });

  // 3) Everything below needs a student token
  const onlyStudents = requireStudent(pool);

  const row = (req) => portal.loadRow(pool, req.student.id);              // fresh row with verification state (id always comes from the token)
  const qrReply = async (req) => portal.qrState(pool, await row(req));

  r.get('/me', onlyStudents, async (req, res) => res.json({ student: await students.get(pool, req.student.id) }));
  r.get('/me/dashboard', onlyStudents, async (req, res) => res.json(await portal.dashboard(pool, req.student.id)));

  // --- profile: contact number + photo directly; everything about enrollment goes through a correction request ---
  r.get('/me/profile', onlyStudents, async (req, res) => res.json(await portal.profile(pool, req.student.id)));
  r.patch('/me/profile', onlyStudents, validate(schemas.studentProfileUpdate), async (req, res) =>
    res.json({ student: await portal.updatePhone(pool, req.student.id, req.valid.body.phone) }));
  r.post('/me/photo', onlyStudents, uploads.multipartOnly, async (req, res) =>
    res.json({ student: await portal.updatePhoto(pool, req.student.id, (req.files.photo || [])[0]) }));
  r.post('/me/documents', onlyStudents, uploads.multipartOnly, async (req, res) => {
    const f = req.files || {};                                                   // multer gives arrays; take the one file per field
    res.json({ student: await portal.replaceDocuments(pool, await row(req), { idDocument: (f.idDocument || [])[0], enrollmentDocument: (f.enrollmentDocument || [])[0] }) });
  });
  r.get('/me/documents/:kind', onlyStudents, async (req, res) => {
    const f = await portal.documentFile(pool, req.student.id, req.params.kind);
    res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    res.sendFile(f.abs);
  });

  // --- requests to the registrar (corrections, renewal, QR replacement) ---
  r.get('/me/requests', onlyStudents, async (req, res) => res.json({ items: await portal.listRequests(pool, req.student.id) }));
  r.post('/me/requests', onlyStudents, validate(schemas.studentRequest), async (req, res) =>
    res.status(201).json({ request: await portal.createRequest(pool, await row(req), req.valid.body) }));
  r.post('/me/requests/:id/cancel', onlyStudents, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('Request not found');
    res.json({ request: await portal.cancelRequest(pool, req.student.id, req.params.id) });
  });

  // --- refund requests: a student asks for their money back on a ride ---
  r.get('/me/refunds', onlyStudents, validate(schemas.studentRefundList, 'query'), async (req, res) =>
    res.json(await refunds.listStudentRefunds(pool, req.student.id, req.valid.query)));
  r.post('/me/refunds', onlyStudents, validate(schemas.studentRefundCreate), async (req, res) =>
    res.status(201).json(await refunds.createStudentRefund(pool, await row(req), req.valid.body)));

  // --- discount eligibility ---
  r.get('/me/eligibility', onlyStudents, async (req, res) => res.json(await portal.eligibility(pool, req.student.id)));

  // --- QR code: only a verified, approved student can generate one; an admin's deactivation cannot be undone by the student ---
  r.get('/me/qr', onlyStudents, async (req, res) => res.json(await qrReply(req)));
  r.post('/me/qr', onlyStudents, async (req, res) => { await portal.issueQr(pool, await row(req), { replace: false }); res.status(201).json(await qrReply(req)); });
  r.post('/me/qr/regenerate', onlyStudents, async (req, res) => { await portal.issueQr(pool, await row(req), { replace: true }); res.status(201).json(await qrReply(req)); });
  r.post('/me/qr/revoke', onlyStudents, async (req, res) => { await portal.revokeQr(pool, await row(req)); res.json(await qrReply(req)); });
  r.post('/me/qr/lost', onlyStudents, validate(schemas.studentQrLost), async (req, res) => {
    await portal.reportLost(pool, await row(req), req.valid.body.note);
    res.json(await qrReply(req));
  });
  r.get('/me/qr/history', onlyStudents, async (req, res) => res.json({ items: await qr.historyFor(pool, req.student.id) }));

  // --- transactions (rides) and the older raw scan list ---
  r.get('/me/transactions', onlyStudents, validate(schemas.studentTransactions, 'query'), async (req, res) =>
    res.json(await portal.transactions(pool, req.student.id, req.valid.query)));
  r.get('/me/transactions/:id', onlyStudents, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('Transaction not found');
    res.json({ transaction: await portal.transaction(pool, req.student.id, req.params.id) });
  });
  r.get('/me/transactions/:id/receipt', onlyStudents, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('Transaction not found');
    res.json({ receipt: await portal.receipt(pool, req.student.id, req.params.id) });
  });
  r.get('/me/scans', onlyStudents, validate(schemas.page, 'query'), async (req, res) =>
    res.json(await students.scansFor(pool, req.student.id, req.valid.query)));

  // --- notifications ---
  r.get('/me/notifications', onlyStudents, validate(schemas.studentNotifications, 'query'), async (req, res) =>
    res.json(await portal.notifications(pool, req.student.id, req.valid.query)));
  r.post('/me/notifications/read-all', onlyStudents, async (req, res) => res.json(await portal.markAllRead(pool, req.student.id)));
  r.post('/me/notifications/:id/read', onlyStudents, async (req, res) => res.json(await portal.markRead(pool, req.student.id, req.params.id)));

  // --- account settings ---
  r.post('/me/password', onlyStudents, validate(schemas.studentPasswordChange), async (req, res) => {
    const after = await portal.changePassword(pool, await row(req), req.valid.body);
    res.json({ message: 'Password updated. Other devices were signed out.', token: signStudentToken(after) });
  });
  r.post('/me/email', onlyStudents, validate(schemas.studentEmailChange), async (req, res) =>
    res.json({ student: await portal.changeEmail(pool, await row(req), req.valid.body), message: 'Email updated.' }));
  r.post('/me/sessions/revoke-all', onlyStudents, async (req, res) => {
    const after = await portal.signOutEverywhere(pool, await row(req));
    res.json({ message: 'Signed out of every other device.', token: signStudentToken(after) });
  });

  return r;
};
