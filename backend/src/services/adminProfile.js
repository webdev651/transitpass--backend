'use strict';
/*
  Administrator profile: view / edit the profile, change the password, and the facts the profile page shows
  (account status, last login, whether the single-administrator rule holds). Reuses the existing `admins` table,
  bcrypt hashing and activity logging; nothing new is stored.
*/
const bcrypt = require('bcryptjs');
const config = require('../config');
const ser = require('../lib/serialize');
const { toDate } = require('../lib/time');
const { badRequest, conflict } = require('../lib/httpError');
const { adminCount, assertNotLastAdmin } = require('../lib/singleAdmin');

const BCRYPT_COST = 12;
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', 'admin1234', 'admin12345', 'letmein123', 'iloveyou1', 'transitpass']);
const FIELD_LABEL = { name: 'name', email: 'email', username: 'username', phone: 'phone' };

/**
 * Strength rules for DRIVER passwords (administrators keep the existing policy): at least 8 characters with an uppercase letter,
 * a lowercase letter, a number and a symbol. Returns the list of rules the password fails (empty = strong enough).
 * The driver "My Account" page shows the same rules live, so what the person sees is what the server enforces.
 */
const DRIVER_RULES = [
  ['at least 8 characters', (p) => p.length >= 8],
  ['an uppercase letter', (p) => /[A-Z]/.test(p)],
  ['a lowercase letter', (p) => /[a-z]/.test(p)],
  ['a number', (p) => /[0-9]/.test(p)],
  ['a symbol (for example ! @ # $ %)', (p) => /[^A-Za-z0-9\s]/.test(p)]
];
const strengthProblems = (next) => DRIVER_RULES.filter(([, ok]) => !ok(next)).map(([label]) => label);

/** Why a new password is not acceptable, or null. Length is already checked by the schema. */
function passwordProblem(next, current, username, role = 'admin') {
  if (next === current) return 'The new password must be different from the current password.';
  const low = next.toLowerCase();
  if (username && low.includes(String(username).toLowerCase()) && String(username).length >= 4) return 'The new password must not contain your username.';
  if (COMMON.has(low)) return 'That password is too common. Choose something harder to guess.';
  if (/^(.)\1+$/.test(next)) return 'The new password must not be a single repeated character.';
  if (role === 'driver') {
    const missing = strengthProblems(next);
    if (missing.length) return `The new password is too weak. It needs ${missing.join(', ')}.`;
  }
  return null;
}

/** The signed-in account plus what the profile page needs. `isDefaultPassword` is only computed for the administrator. */
async function profile(pool, admin) {
  const out = { admin: ser.admin(admin) };
  const [[prev]] = await Promise.all([
    pool.query("SELECT created_at FROM activity_logs WHERE admin_id = ? AND action = 'auth.login' AND status = 'success' ORDER BY created_at DESC, id DESC LIMIT 2", [admin.id])
  ]);
  // last_login_at is stamped at sign-in, so it is THIS session; the one before it is the "previous" login
  out.previousLoginAt = prev[1] ? toDate(prev[1].created_at).toISOString() : null;
  const since = prev[1] ? prev[1].created_at : new Date(0);
  const [[fails]] = await pool.query("SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'auth.login_failed' AND actor_name = ? AND created_at > ?", [admin.username, since]);
  out.failedSignInsSinceLast = Number(fails.n);
  if (admin.role === 'admin') {
    out.administratorCount = await adminCount(pool);
    out.singleAdministratorRule = true;
    // Warn while the account still uses the password from .env / the README (the default is public knowledge).
    out.defaultPassword = !!config.seedAdmin.password && await bcrypt.compare(config.seedAdmin.password, admin.password_hash);
  }
  return out;
}

/** Updates name / email / username / phone. Returns { admin, changed } where changed is the list of field names that really changed. */
async function updateProfile(pool, admin, d) {
  const set = []; const args = []; const changed = [];
  for (const f of ['name', 'email', 'username', 'phone']) {
    if (d[f] === undefined) continue;
    const next = d[f] === '' ? null : d[f];
    const cur = admin[f] === undefined ? null : admin[f];
    if (f === 'phone' ? (next || null) === (cur || null) : next === cur) continue;
    set.push(`${f} = ?`); args.push(next); changed.push(FIELD_LABEL[f]);
  }
  if (set.length) await pool.query(`UPDATE admins SET ${set.join(', ')} WHERE id = ?`, [...args, admin.id]);
  const [rows] = await pool.query('SELECT * FROM admins WHERE id = ?', [admin.id]);
  return { row: rows[0], changed };
}

/** Verifies the current password, applies the policy, stores the bcrypt hash and signs out every other session. */
async function changePassword(pool, admin, { current, next }) {
  if (!(await bcrypt.compare(current, admin.password_hash))) throw badRequest('Current password is incorrect.');
  const problem = passwordProblem(next, current, admin.username, admin.role);
  if (problem) throw badRequest(problem);
  const hash = await bcrypt.hash(next, BCRYPT_COST);
  // token_version + 1 signs out every other session; the caller issues a fresh token for this one
  await pool.query('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [hash, admin.id]);
  const [rows] = await pool.query('SELECT * FROM admins WHERE id = ?', [admin.id]);
  return rows[0];
}

/** The administrator account can never be deleted or deactivated through the API. Always refuses; the message says why. */
async function refuseRemoval(pool, admin, action) {
  await assertNotLastAdmin(pool, admin.id, action);
  // A driver account is managed from the Drivers page, never from here.
  throw conflict('Driver accounts are managed from the Drivers page.');
}

module.exports = { profile, updateProfile, changePassword, refuseRemoval, passwordProblem, strengthProblems, DRIVER_RULES };
