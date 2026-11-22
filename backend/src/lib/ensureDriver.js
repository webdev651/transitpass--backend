'use strict';
const bcrypt = require('bcryptjs');
const config = require('../config');
const { adminCount } = require('./singleAdmin');

/**
 * Makes sure there is an administrator account to sign in with, so nobody has to run a seed command.
 * It only creates one when there are NO driver accounts at all, so it never brings back a
 * default account after someone renamed it or changed its password. Drivers are then created by that administrator.
 * Default (development): username "admin", password "admin1234". Change them with ADMIN_USERNAME / ADMIN_PASSWORD.
 */
async function ensureDriver(pool, log = () => {}) {
  // The single administrator account: created only when there is none (driver accounts alone do not count, so a
  // database that lost its administrator can always be recovered by restarting). Never creates a second one.
  const a = config.seedAdmin;
  if (!a.password) throw new Error('ADMIN_PASSWORD is required to create the administrator account in production');
  if (a.password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');

  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM admins WHERE role = 'admin'");
  if (n > 0) {
    // Administrator already exists: leave credentials untouched. Only the status is forced active
    // so a suspended admin can be recovered by restarting. Driver accounts are unaffected.
    await pool.query(
      "UPDATE admins SET status = 'active' WHERE role = 'admin' AND id = (SELECT id FROM (SELECT id FROM admins WHERE role = 'admin' ORDER BY id LIMIT 1) AS t) LIMIT 1");
    log(`Administrator account exists (username unchanged).`);
    return false;
  }

  await pool.query("INSERT INTO admins (username, password_hash, name, email, node, role) VALUES (?, ?, ?, ?, ?, 'admin')",
    [a.username, await bcrypt.hash(a.password, 12), a.name, a.email, a.node])
    .catch((e) => {
      if (e.code === 'ER_DUP_ENTRY') {
        log(`Administrator account "${a.username}" already exists (concurrent creation).`);
        return;
      }
      throw e;
    });
  log(`Created administrator account "${a.username}".`);
  return true;
}

module.exports = { ensureDriver };
