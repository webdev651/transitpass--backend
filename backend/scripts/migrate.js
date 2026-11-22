'use strict';
// Creates the database (if permitted) and all tables, and upgrades older databases in place.
// Safe to re-run: every step checks what already exists and never drops or rewrites existing records.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

async function migrate({ quiet = false } = {}) {
  const { host, port, user, password, database, ssl } = config.db;
  const root = await mysql.createConnection({ host, port, user, password, ssl, multipleStatements: true });
  const log = (m) => { if (!quiet) console.log(m); };
  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (err) {
    if (!quiet) console.warn(`Could not create database (${err.code}); assuming "${database}" already exists.`);
  }
  await root.query(`USE \`${database}\``);
  await root.query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8'));

  const one = async (sql, args) => (await root.query(sql, args))[0][0];
  const hasColumn = async (table, col) => !!(await one(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [database, table, col]));
  const hasIndex = async (table, name) => !!(await one(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?', [database, table, name]));
  const hasConstraint = async (table, name) => !!(await one(
    'SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?', [database, table, name]));
  const addColumn = async (table, col, ddl) => {
    if (await hasColumn(table, col)) return false;
    await root.query(`ALTER TABLE \`${table}\` ADD COLUMN ${col} ${ddl}`);
    log(`  + ${table}.${col}`);
    return true;
  };

  // --- older databases: student login (password_hash) ---
  await addColumn('students', 'password_hash', 'VARCHAR(100) NULL AFTER discount_eligible');

  // --- student web portal: extra student fields, the read flag on notifications (new tables come from schema.sql) ---
  await addColumn('students', 'campus', "VARCHAR(120) NOT NULL DEFAULT '—' AFTER password_hash");
  await addColumn('students', 'section', "VARCHAR(60) NOT NULL DEFAULT '—' AFTER campus");
  await addColumn('students', 'profile_photo', 'MEDIUMTEXT NULL AFTER section');
  await addColumn('students', 'id_document', 'VARCHAR(255) NULL AFTER profile_photo');
  await addColumn('students', 'enrollment_document', 'VARCHAR(255) NULL AFTER id_document');
  await addColumn('students', 'token_version', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER enrollment_document');
  if (await addColumn('email_log', 'is_read', 'TINYINT(1) NOT NULL DEFAULT 0')) {
    await root.query('UPDATE email_log SET is_read = 1'); // old messages are history, not "new" notifications
  }

  // --- staff roles: administrators and drivers share the admins table (login, bcrypt, token_version already live there) ---
  // Existing accounts keep full access: they become role "admin".
  await addColumn('admins', 'role', "ENUM('admin','driver') NOT NULL DEFAULT 'admin' AFTER node");
  await addColumn('admins', 'status', "ENUM('pending','active','inactive') NOT NULL DEFAULT 'active' AFTER role");
  await addColumn('admins', 'phone', 'VARCHAR(40) NULL AFTER status');
  await addColumn('admins', 'unit', 'VARCHAR(80) NULL AFTER phone');
  await addColumn('admins', 'created_by', 'INT UNSIGNED NULL AFTER unit');
  await addColumn('admins', 'last_login_at', 'DATETIME(3) NULL AFTER created_by');
  if (!(await hasIndex('admins', 'idx_admins_role_status'))) await root.query('ALTER TABLE admins ADD KEY idx_admins_role_status (role, status)');
  if (!(await hasIndex('admins', 'uq_admins_email'))) {
    // Drivers can sign in with their email, so it must be unique. Skipped (not forced) if old rows already clash.
    try { await root.query('ALTER TABLE admins ADD UNIQUE KEY uq_admins_email (email)'); }
    catch (err) { if (err.code !== 'ER_DUP_ENTRY') throw err; log('  ! admins.email is not unique yet (duplicate emails exist); login by email is disabled for those'); }
  }

  // --- students.status gains "rejected" ---
  const st = await one("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'students' AND COLUMN_NAME = 'status'", [database]);
  if (st && !/'rejected'/.test(st.t)) {
    await root.query("ALTER TABLE students MODIFY status ENUM('active','pending','expired','flagged','rejected') NOT NULL DEFAULT 'pending'");
    log('  ~ students.status now accepts "rejected"');
  }

  // --- scans: link to the QR code, keep what was scanned, who scanned, and the six-way result ---
  await addColumn('scans', 'qr_code_id', 'BIGINT UNSIGNED NULL AFTER school_id');
  await addColumn('scans', 'scanned_value', 'VARCHAR(255) NULL AFTER qr_code_id');
  await addColumn('scans', 'scan_method', "ENUM('qr','manual') NOT NULL DEFAULT 'qr' AFTER scanned_value");
  await addColumn('scans', 'verification_result', 'VARCHAR(30) NULL AFTER scan_method');
  await addColumn('scans', 'driver_name', 'VARCHAR(120) NULL AFTER verification_result');
  await root.query('ALTER TABLE scans MODIFY student_name VARCHAR(120) NULL, MODIFY school_id VARCHAR(40) NULL'); // failed scans may identify nobody
  if (!(await hasIndex('scans', 'idx_scans_driver'))) await root.query('ALTER TABLE scans ADD KEY idx_scans_driver (scanned_by, scanned_at)');
  if (!(await hasIndex('scans', 'idx_scans_code'))) await root.query('ALTER TABLE scans ADD KEY idx_scans_code (verification_result)');
  if (!(await hasConstraint('scans', 'fk_scans_qr'))) {
    await root.query('ALTER TABLE scans ADD CONSTRAINT fk_scans_qr FOREIGN KEY (qr_code_id) REFERENCES qr_codes (id) ON DELETE SET NULL');
  }

  // --- backfill: every existing student gets a verification row (INSERT IGNORE keeps this repeatable) ---
  // Students a registrar already approved (anything but "pending") are recorded as verified with method "legacy";
  // students still waiting stay pending. Nobody new is ever auto-verified.
  const [filled] = await root.query(
    `INSERT IGNORE INTO student_verifications (student_id, verification_status, method, verification_date, note)
     SELECT id, IF(status = 'pending', 'pending', 'verified'), IF(status = 'pending', 'admin_review', 'legacy'),
            IF(status = 'pending', NULL, UTC_TIMESTAMP(3)), IF(status = 'pending', NULL, 'Carried over from the registry before verification tracking')
       FROM students`);
  if (filled.affectedRows) log(`  + ${filled.affectedRows} verification record(s) backfilled`);

  // Old scans pre-date driver accounts: keep them, just tag the result code.
  // Old denied scans keep a NULL code (the old reasons were free text, so guessing a code would be wrong).
  await root.query(`UPDATE scans SET verification_result = IF(result = 'granted', 'VERIFIED_STUDENT', 'FLAGGED_REVIEW')
                    WHERE verification_result IS NULL AND result IN ('granted', 'review')`);

  // --- admin modules (vehicles, routes, trips, devices, notifications, refunds, suspicious activity, backups, settings ...) ---
  // New tables come from sql/admin_modules.sql (CREATE TABLE IF NOT EXISTS). Changes to EXISTING tables are additive and listed here.
  await root.query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'admin_modules.sql'), 'utf8'));

  // Expand the review-history event enum with the new renewal / QR-replacement decisions.
  const eh = await one("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'application_review_history' AND COLUMN_NAME = 'event'", [database]);
  if (eh && !/'renewal_approved'/.test(eh.t)) {
    await root.query(`ALTER TABLE application_review_history MODIFY COLUMN event
      ENUM('application_approved','application_rejected','application_reopened','document_verified','document_rejected','correction_approved','correction_rejected','renewal_approved','renewal_rejected','qr_replacement_approved','qr_replacement_rejected') NOT NULL`);
    log('  ~ application_review_history.event now accepts renewal / QR-replacement decisions');
  }

  // announcements: audience, scheduled publishing and a lifecycle state. Old rows keep behaving exactly as before
  // (active ones become "published", switched-off ones "deactivated"); is_active stays the flag the student portal reads.
  await addColumn('announcements', 'audience', "ENUM('all','students','drivers') NOT NULL DEFAULT 'all'");
  await addColumn('announcements', 'publish_at', 'DATETIME(3) NULL');
  await addColumn('announcements', 'published_at', 'DATETIME(3) NULL');
  await addColumn('announcements', 'sent_at', 'DATETIME(3) NULL');
  await addColumn('announcements', 'created_by', 'INT UNSIGNED NULL');
  await addColumn('announcements', 'updated_at', 'DATETIME(3) NULL');
  if (await addColumn('announcements', 'state', "ENUM('draft','scheduled','published','deactivated') NOT NULL DEFAULT 'published'")) {
    await root.query("UPDATE announcements SET state = IF(is_active = 1, 'published', 'deactivated'), published_at = created_at");
  }

  // scans: which registered device the driver scanned with (sent by the app as the X-Device-Id header; NULL for older scans).
  await addColumn('scans', 'device_identifier', 'VARCHAR(100) NULL');
  if (!(await hasIndex('scans', 'idx_scans_device'))) await root.query('ALTER TABLE scans ADD KEY idx_scans_device (device_identifier, scanned_at)');

  // fare_rules (Stage 2): scans remember which rule priced them and which route they belong to (NULL on older scans).
  await addColumn('scans', 'fare_rule_id', 'INT UNSIGNED NULL');
  await addColumn('scans', 'route_id', 'INT UNSIGNED NULL');
  // Transaction Management (Stage 3): the route filter reads scans.route_id + date, so give it an index (no data is touched).
  if (!(await hasIndex('scans', 'idx_scans_route'))) await root.query('ALTER TABLE scans ADD KEY idx_scans_route (route_id, scanned_at)');

  // Offline transactions: a check recorded without internet carries a client-generated idempotency key, so a retry can never
  // create a second transaction. The unique key is scoped to the driver who recorded it; online scans keep NULL and are unaffected.
  await addColumn('scans', 'client_txn_id', 'VARCHAR(64) NULL AFTER scanned_at');
  await addColumn('scans', 'offline', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER client_txn_id');
  await addColumn('scans', 'synced_at', 'DATETIME(3) NULL AFTER offline');
  if (!(await hasIndex('scans', 'uq_scans_client'))) {
    // Old databases have no offline rows yet, so this index can always be created.
    await root.query('ALTER TABLE scans ADD UNIQUE KEY uq_scans_client (scanned_by, client_txn_id)');
  }
  // First run only: carry today's FULL_FARE / DISCOUNT_RATE from .env into the database as the default rule, so behaviour is unchanged
  // until an administrator edits it. After that the database is the only source (the .env values remain only as an emergency fallback).
  const [[{ n: fareRules }]] = await root.query('SELECT COUNT(*) AS n FROM fare_rules');
  if (!fareRules) {
    await root.query(
      "INSERT INTO fare_rules (route_id, regular_fare, discount_percent, discount_active, effective_from, notes) VALUES (NULL, ?, ?, 1, UTC_DATE() - INTERVAL 1 DAY, 'Default fare (imported from the original settings)')",
      [config.fare.full, Math.round(config.fare.discountRate * 10000) / 100]);
    log('  + default fare rule created from FULL_FARE / DISCOUNT_RATE');
  }

  // activity_logs: more categories so the new modules show up in "Recent system activities".
  const cat = await one("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'activity_logs' AND COLUMN_NAME = 'category'", [database]);
  if (cat && !/'security'/.test(cat.t)) {
    await root.query(`ALTER TABLE activity_logs MODIFY category
      ENUM('auth','student','verification','qr','driver','account','system','vehicle','route','trip','device','announcement','notification','refund','settings','backup','security') NOT NULL`);
    log('  ~ activity_logs.category accepts the new module categories');
  }

  // Activity Log Management (Stage 5): no new table and no column change. Two indexes make the log page's type / status / date filters fast.
  if (!(await hasIndex('activity_logs', 'idx_activity_category'))) await root.query('ALTER TABLE activity_logs ADD KEY idx_activity_category (category, created_at)');
  if (!(await hasIndex('activity_logs', 'idx_activity_status'))) await root.query('ALTER TABLE activity_logs ADD KEY idx_activity_status (status, created_at)');

  // Single administrator (Stage 4): nothing is changed or removed. If an older database already holds more than one administrator, say so.
  const [[{ n: admins }]] = await root.query("SELECT COUNT(*) AS n FROM admins WHERE role = 'admin'");
  if (admins > 1) log(`  ! ${admins} administrator accounts exist. TransitPass expects exactly one; none were changed. Remove the extra ones manually.`);

  await root.end();
  log(`Schema applied to "${database}".`);
}

module.exports = { migrate };
if (require.main === module) migrate().catch((e) => { console.error(e.message); process.exit(1); });
