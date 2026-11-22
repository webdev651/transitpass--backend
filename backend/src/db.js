'use strict';
const mysql = require('mysql2/promise');
const config = require('./config');

function createPool(overrides = {}) {
  return mysql.createPool({
    ...config.db,
    waitForConnections: true,
    charset: 'utf8mb4',
    timezone: 'Z',            // DATETIME columns are UTC
    decimalNumbers: true,
    ...overrides
  });
}

/** Runs fn(conn) inside a transaction; commits on success, rolls back on throw. */
async function withTransaction(pool, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* connection may be gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { createPool, withTransaction };
