'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { signToken, requireAuth } = require('../middleware/auth');
const { unauthorized, forbidden } = require('../lib/httpError');
const schemas = require('../schemas');
const ser = require('../lib/serialize');
const activity = require('../services/activity');

// Compared against when the username doesn't exist, so response time doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

module.exports = function authRoutes(pool) {
  const r = express.Router();
  const limiter = rateLimit({
    windowMs: config.loginRateLimit.windowMs,
    limit: config.loginRateLimit.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    skip: () => config.isTest && !process.env.TEST_RATE_LIMIT,
    message: { error: 'Too many failed sign-in attempts. Try again in a few minutes.' }
  });

  r.post('/login', limiter, validate(schemas.login), async (req, res, next) => {
    try {
      const { username, password, portal } = req.valid.body;
      // Administrators and drivers each sign in with their own username (or email) and password.
      const [rows] = await pool.query('SELECT * FROM admins WHERE username = ? OR email = ? ORDER BY (username = ?) DESC LIMIT 1', [username, username.toLowerCase(), username]);
      const admin = rows[0];
      const ok = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);
      // Every sign-in attempt is written to the activity log (who, when, from where, and whether it worked).
      const note = (status, description) => activity.log(pool, {
        admin: admin && ok ? admin : null, name: admin && ok ? admin.name : username.slice(0, 60), role: admin && ok ? admin.role : 'unknown',
        category: 'auth', action: status === 'success' ? 'auth.login' : 'auth.login_failed', description, status, ip: req.ip
      });
      if (!admin || !ok) { await note('failed', `Failed sign-in attempt for "${username.slice(0, 60)}"`); throw unauthorized('Incorrect username or password.'); }
      // Only said after the password is right, so it does not reveal which usernames exist.
      if (admin.status === 'pending') { await note('failed', 'Sign-in refused: account is waiting for approval'); throw forbidden('This account is waiting for administrator approval.'); }
      if (admin.status === 'inactive') { await note('failed', 'Sign-in refused: account is deactivated'); throw forbidden('This account has been deactivated. Contact the administrator.'); }
      if (portal === 'admin' && admin.role !== 'admin') { await note('failed', 'Sign-in refused: not an administrator account'); throw forbidden('This sign-in is for administrator accounts only. Drivers sign in on the driver login page.'); }
      if (portal === 'driver' && admin.role !== 'driver') { await note('failed', 'Sign-in refused: not a driver account'); throw forbidden('This sign-in is for driver accounts only. Administrators sign in on the administrator login page.'); }
      await pool.query('UPDATE admins SET last_login_at = ? WHERE id = ?', [new Date(), admin.id]);
      await note('success', 'Signed in');
      res.json({ token: signToken(admin), admin: ser.admin(admin) });
    } catch (err) {
      // Record the actual exception with its stack trace, then let the central error handler
      // reply with a safe status/message (401/403 for auth refusals, 500 logged for anything else).
      if (!config.isTest) console.error('[auth/login]', err);
      next(err);
    }
  });

  r.get('/me', requireAuth(pool), (req, res) => res.json({ admin: ser.admin(req.admin) }));

  // Secure logout: for administrators the token is killed on the server too (token_version + 1), not just forgotten by the browser.
  r.post('/logout', requireAuth(pool), async (req, res) => {
    if (req.admin.role === 'admin') await pool.query('UPDATE admins SET token_version = token_version + 1 WHERE id = ?', [req.admin.id]);
    await activity.log(pool, { admin: req.admin, category: 'auth', action: 'auth.logout', description: 'Signed out', ip: req.ip });
    res.json({ message: 'Signed out.' });
  });

  return r;
};
