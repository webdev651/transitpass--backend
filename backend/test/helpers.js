'use strict';
// Integration tests run against a real MySQL/MariaDB database that is WIPED between tests.
// Configure with TEST_DB_NAME (must end in "_test"), TEST_DB_USER, TEST_DB_PASSWORD, TEST_DB_HOST, TEST_DB_PORT.
process.env.NODE_ENV = 'test';
require('dotenv').config({ quiet: true });
process.env.DB_NAME = process.env.TEST_DB_NAME || 'transitpass_test';
if (process.env.TEST_DB_USER) process.env.DB_USER = process.env.TEST_DB_USER;
if (process.env.TEST_DB_PASSWORD !== undefined) process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD;
if (process.env.TEST_DB_HOST) process.env.DB_HOST = process.env.TEST_DB_HOST;
if (process.env.TEST_DB_PORT) process.env.DB_PORT = process.env.TEST_DB_PORT;

const request = require('supertest');
const config = require('../src/config');
const { createPool } = require('../src/db');
const { createApp } = require('../src/app');
const { migrate } = require('../scripts/migrate');
const { seed } = require('../scripts/seed');

if (!/_test$/.test(config.db.database)) throw new Error(`Refusing to run tests against "${config.db.database}" — name must end in _test`);

const TABLES = ['suspicious_notes', 'suspicious_flags', 'refund_requests', 'transaction_cancellations', 'notifications', 'device_events', 'driver_devices', 'trips', 'route_vehicles', 'route_drivers', 'fare_rules', 'transit_routes', 'vehicles', 'driver_documents', 'application_review_history', 'backup_history', 'system_settings', 'activity_logs', 'student_document_reviews', 'scans', 'qr_codes', 'student_verifications', 'email_log', 'student_requests', 'announcement_reads', 'announcements', 'password_resets', 'students', 'operators', 'admins'];
// admins IS in TABLES: tests that modify admin state (status, username, etc.) must be fully reset.
// ensureDriver() in seed() recreates the single administrator after the wipe.

let migrated = false;

/** Reset the student counter so each test file starts from the same IDs (no cross-file leakage). */
function resetCounter() {
  // `studentPayload` uses a module-level `n`; reset it here so each test file gets fresh IDs.
  // This is called from setup() at the top of each test file.
  global.__tpStudentCounter = 0;
}

async function setup() {
  if (!migrated) {
    await migrate({ quiet: true });
    migrated = true;
  }
  resetCounter();
  const pool = createPool();
  const app = createApp(pool);
  const api = request(app);
  return { pool, app, api };
}

async function reset(pool) {
  // Activity writes started by the previous test finish on the response's "finish" event; let them land before the
  // tables are wiped, otherwise a late row appears in the next test's counts.
  await require('../src/services/activity').flushPending();
  // Use one connection for the whole wipe so FOREIGN_KEY_CHECKS and the deletes all apply on the same session.
  // DELETE FROM (not TRUNCATE) keeps auto_increment stable and works within a transaction on one connection.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await conn.query(`DELETE FROM ${t}`);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* connection may be gone */ }
    throw e;
  } finally {
    conn.release();
  }
  require('../src/services/settings').clearCache();
  await seed({ pool, quiet: true });
}

async function login(api, username = config.seedAdmin.username, password = config.seedAdmin.password) {
  const res = await api.post('/api/auth/login').send({ username, password });
  return res.body.token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const desc = (v) => Array(128).fill(v);
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/';

let n = 0;
/** Valid create payload; override fields as needed. */
function studentPayload(over = {}) {
  n += 1;
  return {
    name: `Test Student ${n}`, school: 'Test School', program: 'BS Testing', level: '1st Year',
    email: `student${n}@example.edu.ph`, schoolId: `2026-${String(1000 + n)}`, phone: '0917 000 0000', ...over
  };
}

/** Scans a student by School ID the way a driver's manual lookup does, issuing a QR first when the student is allowed one. */
async function scanId(api, token, schoolId) {
  const list = await api.get(`/api/students?q=${encodeURIComponent(schoolId)}`).set(auth(token));
  const s = list.body.items.find((x) => x.schoolId === schoolId);
  if (s && !s.qrActive) await api.post(`/api/students/${s.id}/actions/regenerate-qr`).set(auth(token)); // refused (409) for students who may not hold a QR
  return api.post('/api/scanner/lookup').set(auth(token)).send({ schoolId });
}

module.exports = { scanId, setup, reset, login, auth, desc, PHOTO, studentPayload, config };
