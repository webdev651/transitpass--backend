'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized, forbidden } = require('../lib/httpError');

/*
  Two kinds of people sign in, and every token says which kind it is (the "role"):
    role "admin"   -> the driver / registrar side  (checked by requireAuth)
    role "student" -> the student side              (checked by requireStudent)
  A student token can never open a driver route, and a driver token can never open a student route.
*/

const PENDING_MESSAGE = 'Your account is waiting for admin verification. You can sign in to check your status, but your QR pass stays locked until an administrator confirms you are an enrolled student.';

function makeToken(role, id, extra = {}) {
  return jwt.sign({ sub: id, role, ...extra }, config.jwt.secret, {
    algorithm: 'HS256', expiresIn: config.jwt.expiresIn
  });
}

// The token's role is the staff role itself ("admin" or "driver"), and it is re-checked against the database on every request.
const signToken = (admin) => makeToken(admin.role || 'admin', admin.id, { tv: admin.token_version });
// "tv" lets a password change / reset / "sign out everywhere" kill every older student token (old tokens without tv count as 0).
const signStudentToken = (student) => makeToken('student', student.id, { tv: student.token_version || 0 });

/** Reads "Authorization: Bearer <token>" and returns what is inside it (or says 401). */
function readToken(req) {
  const m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
  if (!m) throw unauthorized();
  try {
    return jwt.verify(m[1], config.jwt.secret, { algorithms: ['HS256'] });
  } catch (_) {
    throw unauthorized('Invalid or expired token');
  }
}

/** Driver / admin guard: loads the admin row (so password changes revoke old tokens). */
function requireAuth(pool) {
  return async (req, res, next) => {
    const payload = readToken(req);
    if (payload.role !== 'admin' && payload.role !== 'driver') throw unauthorized('Invalid or expired token');
    const [rows] = await pool.query('SELECT * FROM admins WHERE id = ?', [payload.sub]);
    const admin = rows[0];
    if (!admin || admin.token_version !== payload.tv || admin.role !== payload.role) throw unauthorized('Session expired — please sign in again');
    // A deactivated or not-yet-approved account loses access at once, even with a token that has not expired.
    if (admin.status !== 'active') throw unauthorized('This account is not active');
    // Idle timeout, enforced here as well as in the browser: a token that has not been refreshed for the configured idle time (Settings ->
    // Session timeout) is dead, so a stolen or forgotten token cannot be used after the person walked away. Every request with a token older
    // than a minute gets a fresh one in X-Refresh-Token (the web app stores it), so activity keeps the session alive; the 8 h limit still applies.
    const age = Math.floor(Date.now() / 1000) - Number(payload.iat || 0);
    const idleMinutes = Number((await require('../services/settings').runtime(pool)).idleMinutes) || 30;
    if (age > idleMinutes * 60) throw unauthorized('Session expired due to inactivity — please sign in again');
    if (age > 60) res.set('X-Refresh-Token', signToken(admin));
    req.admin = admin;
    next();
  };
}

/** Role gate, placed after requireAuth: requireRole('admin'), requireRole('admin', 'driver'). */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.admin || !roles.includes(req.admin.role)) throw forbidden('You do not have access to this');
  next();
};

/** Student guard: loads the student row into req.student. */
function requireStudent(pool) {
  return async (req, res, next) => {
    const payload = readToken(req);
    if (payload.role !== 'student') throw unauthorized('Invalid or expired token');
    const [rows] = await pool.query('SELECT * FROM students WHERE id = ?', [payload.sub]);
    if (!rows[0] || (payload.tv || 0) !== (rows[0].token_version || 0)) throw unauthorized('Session expired — please sign in again');
    // Pending and rejected students may sign in to see their verification status; the QR service refuses to issue them a pass.
    req.student = rows[0];
    next();
  };
}

module.exports = { signToken, signStudentToken, requireAuth, requireRole, requireStudent, PENDING_MESSAGE };
