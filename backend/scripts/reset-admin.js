'use strict';
// Recovery for a forgotten administrator password:  npm run reset-admin -- <username-or-email> <new-password>
// Works on the single administrator account only (never on drivers) and signs out every old session.
const bcrypt = require('bcryptjs');
const { createPool } = require('../src/db');

(async () => {
  const [who, password] = process.argv.slice(2);
  if (!who || !password || password.length < 8) {
    console.error('Usage: npm run reset-admin -- <username-or-email> <new-password (at least 8 characters)>');
    process.exitCode = 1;
    return;
  }
  const pool = createPool();
  try {
    const hash = await bcrypt.hash(password, 12);
    const [r] = await pool.query(
      "UPDATE admins SET password_hash = ?, status = 'active', token_version = token_version + 1 WHERE role = 'admin' AND (username = ? OR email = ?)",
      [hash, who, who.toLowerCase()]);
    if (r.affectedRows) console.log(`Password reset for the administrator "${who}". Every old session was signed out.`);
    else { console.error(`No administrator account found for "${who}".`); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error('Password reset failed:', e.message); process.exitCode = 1; });
