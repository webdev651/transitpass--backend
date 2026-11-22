'use strict';
/*
  TransitPass has exactly ONE administrator account. Drivers live in the same `admins` table with role 'driver'.
  Every code path that could add, remove, demote or deactivate an administrator goes through here, so the rule
  is enforced in one place (and tested), not scattered.
*/
const { conflict, forbidden } = require('./httpError');

const MSG = {
  create: 'Only one administrator account is allowed. Additional administrator accounts cannot be created.',
  delete: 'The only administrator account cannot be deleted.',
  deactivate: 'The only administrator account cannot be deactivated.',
  demote: 'The only administrator account cannot be changed to another role.'
};

async function adminCount(db) {
  const [[r]] = await db.query("SELECT COUNT(*) AS n FROM admins WHERE role = 'admin'");
  return Number(r.n);
}

/** Refuses to add another administrator while one already exists. */
async function assertCanCreateAdmin(db) {
  if ((await adminCount(db)) >= 1) throw conflict(MSG.create);
}

/** Refuses an action that would remove or disable the last administrator. action: 'delete' | 'deactivate' | 'demote'. */
async function assertNotLastAdmin(db, adminId, action) {
  const [rows] = await db.query("SELECT role FROM admins WHERE id = ?", [adminId]);
  if (!rows[0] || rows[0].role !== 'admin') return;
  const [[r]] = await db.query("SELECT COUNT(*) AS n FROM admins WHERE role = 'admin' AND status = 'active'");
  if (Number(r.n) <= 1) throw conflict(MSG[action] || MSG.delete);
}

/** For routes that must only ever touch drivers: never lets a driver route be pointed at the administrator. */
function assertDriverRole(row) {
  if (row && row.role === 'admin') throw forbidden('This action is not allowed on the administrator account.');
}

module.exports = { adminCount, assertCanCreateAdmin, assertNotLastAdmin, assertDriverRole, MSG };
