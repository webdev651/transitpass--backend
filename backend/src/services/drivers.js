'use strict';
const bcrypt = require('bcryptjs');
const { notFound, conflict } = require('../lib/httpError');
const { escapeLike } = require('../lib/sql');
const ser = require('../lib/serialize');
const notifications = require('./notifications');

async function getRow(db, id) {
  const [rows] = await db.query("SELECT * FROM admins WHERE id = ? AND role = 'driver'", [id]);
  if (!rows[0]) throw notFound('Driver not found');
  return rows[0];
}

async function list(pool, { q, status, limit, offset }) {
  const where = ["a.role = 'driver'"];
  const args = [];
  if (status !== 'all') { where.push('a.status = ?'); args.push(status); }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push('(a.name LIKE ? OR a.username LIKE ? OR a.email LIKE ? OR a.unit LIKE ?)');
    args.push(like, like, like, like);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM admins a ${clause}`, args);
  const [rows] = await pool.query(
    `SELECT a.*, (SELECT COUNT(*) FROM scans sc WHERE sc.scanned_by = a.id) AS scan_count,
            (SELECT MAX(sc.scanned_at) FROM scans sc WHERE sc.scanned_by = a.id) AS last_scan_at
       FROM admins a ${clause} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return {
    total,
    items: rows.map((r) => ({ ...ser.admin(r), scanCount: Number(r.scan_count), lastScanAt: r.last_scan_at ? new Date(r.last_scan_at).toISOString() : null }))
  };
}

async function create(pool, d, creator) {
  const hash = await bcrypt.hash(d.password, 12); // bcrypt, same cost as the other accounts
  const [res] = await pool.query(
    `INSERT INTO admins (username, password_hash, name, email, node, role, status, phone, unit, created_by)
     VALUES (?, ?, ?, ?, ?, 'driver', ?, ?, ?, ?)`,
    [d.username, hash, d.name, d.email, d.unit ? `unit-${d.unit}`.slice(0, 80) : 'driver', d.status, d.phone || null, d.unit || null, creator.id]);
  return ser.admin(await getRow(pool, res.insertId));
}

async function update(pool, id, d) {
  await getRow(pool, id);
  const map = { name: 'name', username: 'username', email: 'email', phone: 'phone', unit: 'unit' };
  const cols = Object.keys(d).filter((k) => map[k]);
  const sets = cols.map((c) => `${map[c]} = ?`);
  const args = cols.map((c) => (d[c] === '' ? null : d[c]));
  if (d.unit !== undefined) { sets.push('node = ?'); args.push(d.unit ? `unit-${d.unit}`.slice(0, 80) : 'driver'); }
  if (sets.length) await pool.query(`UPDATE admins SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
  return ser.admin(await getRow(pool, id));
}

// Deactivating also bumps token_version, which signs the driver out of every session immediately.
const ACTIONS = {
  approve:    { from: ['pending'],  to: 'active',   problem: 'Only pending drivers can be approved' },
  activate:   { from: ['inactive'], to: 'active',   problem: 'Only inactive drivers can be activated' },
  deactivate: { from: ['active', 'pending'], to: 'inactive', problem: 'This driver is already inactive' }
};

async function act(pool, id, action) {
  const def = ACTIONS[action];
  if (!def) throw notFound(`Unknown action: ${action}`);
  const row = await getRow(pool, id);
  if (!def.from.includes(row.status)) throw conflict(def.problem);
  await pool.query('UPDATE admins SET status = ?, token_version = token_version + 1 WHERE id = ?', [def.to, id]);
  const text = { approve: ['Your driver account was approved', 'Your driver account was approved. You can now sign in.'], activate: ['Your driver account was activated', 'Your driver account is active again.'], deactivate: ['Your driver account was deactivated', 'Your driver account was deactivated by the administrator. Contact the administrator for details.'] }[action];
  await notifications.accountStatus(pool, row, 'driver', { title: text[0], body: text[1] }).catch(() => {});
  return ser.admin(await getRow(pool, id));
}

async function resetPassword(pool, id, password) {
  await getRow(pool, id);
  await pool.query('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(password, 12), id]);
}

module.exports = { list, create, update, act, resetPassword, ACTION_NAMES: Object.keys(ACTIONS) };
