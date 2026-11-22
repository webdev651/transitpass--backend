'use strict';
// Sensitive actions (approving a refund, cancelling a transaction) require the administrator to type their own password again.
const bcrypt = require('bcryptjs');
const { forbidden } = require('./httpError');

async function verifyPassword(admin, password) {
  if (!password || !(await bcrypt.compare(String(password), admin.password_hash))) throw forbidden('Your password is incorrect. This action needs your password to authorize it.');
}
module.exports = { verifyPassword };
