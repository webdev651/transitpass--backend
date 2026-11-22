-- TransitPass schema (MySQL 8 / MariaDB 10.4+)
-- Run with: npm run migrate   (creates tables if they do not exist)

CREATE TABLE IF NOT EXISTS admins (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(60)  NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  node          VARCHAR(80)  NOT NULL DEFAULT 'verification.node-04',
  role          ENUM('admin','driver') NOT NULL DEFAULT 'admin',          -- this table holds every staff login: administrators AND drivers
  status        ENUM('pending','active','inactive') NOT NULL DEFAULT 'active',
  phone         VARCHAR(40)  NULL,
  unit          VARCHAR(80)  NULL,                                         -- vehicle / unit a driver is assigned to
  created_by    INT UNSIGNED NULL,
  last_login_at DATETIME(3)  NULL,
  token_version INT UNSIGNED NOT NULL DEFAULT 0,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admins_username (username),
  KEY idx_admins_role_status (role, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS students (
  id                VARCHAR(32)  NOT NULL PRIMARY KEY,           -- e.g. STD-2026-04182
  school_id         VARCHAR(40)  NOT NULL,
  name              VARCHAR(120) NOT NULL,
  school            VARCHAR(160) NOT NULL,
  program           VARCHAR(160) NOT NULL,
  level             VARCHAR(60)  NOT NULL,
  status            ENUM('active','pending','expired','flagged','rejected') NOT NULL DEFAULT 'pending',
  valid_until       VARCHAR(40)  NOT NULL DEFAULT 'Awaiting registrar', -- free text, as in the UI
  scans             INT UNSIGNED NOT NULL DEFAULT 0,             -- granted scans only
  email             VARCHAR(190) NOT NULL,
  phone             VARCHAR(40)  NOT NULL DEFAULT '—',
  qr_active         TINYINT(1)   NOT NULL DEFAULT 1,
  qr_version        INT UNSIGNED NOT NULL DEFAULT 1,
  face_enrolled     TINYINT(1)   NOT NULL DEFAULT 0,
  face_photo        MEDIUMTEXT   NULL,                           -- small JPEG data URL
  face_descriptor   MEDIUMTEXT   NULL,                           -- JSON array of 128 floats; never returned by the API
  discount_eligible TINYINT(1)   NOT NULL DEFAULT 1,
  password_hash     VARCHAR(100) NULL,                           -- bcrypt hash for the student login; NULL = no login yet; never returned by the API
  campus            VARCHAR(120) NOT NULL DEFAULT '—',           -- student portal registration
  section           VARCHAR(60)  NOT NULL DEFAULT '—',
  profile_photo     MEDIUMTEXT   NULL,                           -- small image data URL chosen by the student (NOT the face-enrollment photo)
  id_document       VARCHAR(255) NULL,                           -- relative path under UPLOAD_DIR; never returned by the API
  enrollment_document VARCHAR(255) NULL,                         -- relative path under UPLOAD_DIR; never returned by the API
  token_version     INT UNSIGNED NOT NULL DEFAULT 0,             -- bump to sign the student out everywhere (password change / reset)
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_students_school_id (school_id),
  UNIQUE KEY uq_students_email (email),
  KEY idx_students_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Identity verification of a student (is this person really enrolled?). One row per student.
-- students.status mirrors the outcome (verified -> active, rejected -> rejected, pending -> pending).
CREATE TABLE IF NOT EXISTS student_verifications (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  student_id          VARCHAR(32)  NOT NULL,
  verification_status ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
  method              VARCHAR(40)  NOT NULL DEFAULT 'admin_review',   -- admin_review | admin_issued | registrar_db | legacy
  registrar_ref       VARCHAR(120) NULL,                              -- reserved for the school registrar integration
  submitted_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  verified_by         INT UNSIGNED NULL,
  verification_date   DATETIME(3)  NULL,
  rejection_reason    VARCHAR(255) NULL,
  note                VARCHAR(255) NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sv_student (student_id),
  KEY idx_sv_status (verification_status),
  CONSTRAINT fk_sv_student  FOREIGN KEY (student_id)  REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_sv_verifier FOREIGN KEY (verified_by) REFERENCES admins (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every QR credential ever issued. qr_token is random (192 bits) and carries no personal data.
-- At most one row per student is 'active' (enforced in the service under a row lock).
CREATE TABLE IF NOT EXISTS qr_codes (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  student_id           VARCHAR(32)  NOT NULL,
  qr_token             VARCHAR(64)  NOT NULL,
  generated_by_type    ENUM('student','admin') NOT NULL,
  generated_by_student VARCHAR(32)  NULL,
  generated_by_admin   INT UNSIGNED NULL,
  generated_by_name    VARCHAR(120) NOT NULL,                         -- snapshot, survives account deletion
  generated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  status               ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
  expires_at           DATETIME(3)  NOT NULL,
  revoked_at           DATETIME(3)  NULL,
  revoked_by_name      VARCHAR(120) NULL,
  revoke_reason        VARCHAR(255) NULL,
  UNIQUE KEY uq_qr_token (qr_token),
  KEY idx_qr_student_status (student_id, status),
  KEY idx_qr_status_expiry (status, expires_at),
  KEY idx_qr_generated_at (generated_at),
  CONSTRAINT fk_qr_student    FOREIGN KEY (student_id)           REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_qr_gen_student FOREIGN KEY (generated_by_student) REFERENCES students (id) ON DELETE SET NULL,
  CONSTRAINT fk_qr_gen_admin  FOREIGN KEY (generated_by_admin)   REFERENCES admins (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One table backs both the per-student history and the live feed.
-- student_id is SET NULL on delete so subsidy/audit history survives removing a student.
CREATE TABLE IF NOT EXISTS scans (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  student_id      VARCHAR(32)  NULL,
  student_name    VARCHAR(120) NULL,                           -- NULL when the QR / ID did not identify anyone
  school_id       VARCHAR(40)  NULL,
  qr_code_id      BIGINT UNSIGNED NULL,
  scanned_value   VARCHAR(255) NULL,                           -- what the scanner read or the driver typed (kept for invalid attempts)
  scan_method     ENUM('qr','manual') NOT NULL DEFAULT 'qr',
  verification_result VARCHAR(30) NULL,                        -- VERIFIED_STUDENT | PENDING_VERIFICATION | INVALID_QR | REVOKED_QR | EXPIRED_QR | REJECTED_STUDENT | FLAGGED_REVIEW
  driver_name     VARCHAR(120) NULL,                           -- snapshot of the account that scanned
  route           VARCHAR(120) NOT NULL DEFAULT 'Verification Terminal',
  operator        VARCHAR(120) NOT NULL DEFAULT 'node-04 · Registrar Ops',
  fare            VARCHAR(100) NOT NULL,
  fare_amount     DECIMAL(8,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(8,2) NOT NULL DEFAULT 0,
  result          ENUM('granted','review','denied') NOT NULL,
  reason          VARCHAR(255) NULL,
  scanned_by      INT UNSIGNED NULL,
  scanned_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),   -- stored in UTC
  client_txn_id   VARCHAR(64)  NULL,                           -- idempotency key of a check recorded offline (unique per driver)
  offline         TINYINT(1)   NOT NULL DEFAULT 0,             -- 1 = the check was recorded on the device without internet
  synced_at       DATETIME(3)  NULL,                           -- when the server accepted an offline check
  KEY idx_scans_at (scanned_at),
  KEY idx_scans_student (student_id, scanned_at),
  KEY idx_scans_result (result, scanned_at),
  KEY idx_scans_driver (scanned_by, scanned_at),
  KEY idx_scans_code (verification_result),
  UNIQUE KEY uq_scans_client (scanned_by, client_txn_id),
  CONSTRAINT fk_scans_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL,
  CONSTRAINT fk_scans_admin   FOREIGN KEY (scanned_by) REFERENCES admins (id)   ON DELETE SET NULL,
  CONSTRAINT fk_scans_qr      FOREIGN KEY (qr_code_id) REFERENCES qr_codes (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_log (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  student_id   VARCHAR(32)  NULL,
  to_email     VARCHAR(190) NOT NULL,
  student_name VARCHAR(120) NOT NULL,
  school_id    VARCHAR(40)  NOT NULL,
  subject      VARCHAR(200) NOT NULL,
  body         TEXT         NOT NULL,
  status       ENUM('logged','sent','failed') NOT NULL DEFAULT 'logged',
  sent_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  is_read      TINYINT(1)   NOT NULL DEFAULT 0,                              -- student portal: read / unread
  KEY idx_email_sent (sent_at),
  KEY idx_email_student (student_id),
  CONSTRAINT fk_email_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Operator subsidy ledger (reports page). Maintained by the registrar; scans are not tied to operators.
CREATE TABLE IF NOT EXISTS operators (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(120) NOT NULL,
  trips           INT UNSIGNED NOT NULL DEFAULT 0,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  status          VARCHAR(40)  NOT NULL DEFAULT 'Pending docs',
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_operators_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------------------------
-- Student web portal additions (the notification inbox reuses email_log; nothing else is duplicated)
-- ---------------------------------------------------------------------------------------------

-- Things a student asks the registrar for: information corrections, discount renewal, QR replacement, lost-QR reports.
-- Students can only CREATE and read their own rows (and cancel a pending one); an administrator decides them.
CREATE TABLE IF NOT EXISTS student_requests (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  student_id      VARCHAR(32)  NOT NULL,
  type            ENUM('correction','renewal','qr_replacement','qr_lost') NOT NULL,
  field_name      VARCHAR(40)  NULL,                          -- correction only: which field
  current_value   VARCHAR(255) NULL,
  requested_value VARCHAR(255) NULL,
  reason          VARCHAR(500) NULL,
  status          ENUM('pending','approved','rejected','cancelled','resolved') NOT NULL DEFAULT 'pending',
  admin_note      VARCHAR(255) NULL,
  reviewed_by     INT UNSIGNED NULL,
  reviewed_at     DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_req_student (student_id, created_at),
  KEY idx_req_status (status, type),
  CONSTRAINT fk_req_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_req_admin   FOREIGN KEY (reviewed_by) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- System announcements shown to every student, and who has read them.
CREATE TABLE IF NOT EXISTS announcements (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title      VARCHAR(200) NOT NULL,
  body       TEXT         NOT NULL,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  expires_at DATETIME(3)  NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ann_active (is_active, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS announcement_reads (
  student_id      VARCHAR(32)  NOT NULL,
  announcement_id INT UNSIGNED NOT NULL,
  read_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (student_id, announcement_id),
  CONSTRAINT fk_ar_student FOREIGN KEY (student_id)      REFERENCES students (id)      ON DELETE CASCADE,
  CONSTRAINT fk_ar_ann     FOREIGN KEY (announcement_id) REFERENCES announcements (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Forgot-password links. Only a SHA-256 hash of the token is stored, so a database leak does not leak working links.
CREATE TABLE IF NOT EXISTS password_resets (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  student_id VARCHAR(32)  NOT NULL,
  token_hash CHAR(64)     NOT NULL,
  expires_at DATETIME(3)  NOT NULL,
  used_at    DATETIME(3)  NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_pr_token (token_hash),
  KEY idx_pr_student (student_id),
  CONSTRAINT fk_pr_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------------------------
-- Administrator dashboard: who did what. Written by src/services/activity.js (sign-in / sign-out / failed
-- sign-ins, and every change an administrator makes). Read by the dashboard's "Recent system activities".
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id    INT UNSIGNED NULL,                                  -- NULL for a sign-in attempt by an unknown username
  actor_name  VARCHAR(120) NOT NULL,                              -- snapshot, survives account deletion
  actor_role  VARCHAR(20)  NOT NULL DEFAULT 'admin',
  category    ENUM('auth','student','verification','qr','driver','account','system') NOT NULL,
  action      VARCHAR(60)  NOT NULL,                              -- e.g. auth.login, student.approve
  description VARCHAR(255) NOT NULL,
  target_id   VARCHAR(64)  NULL,
  status      ENUM('success','failed') NOT NULL DEFAULT 'success',
  ip_address  VARCHAR(45)  NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_activity_created (created_at),
  KEY idx_activity_admin (admin_id, created_at),
  CONSTRAINT fk_activity_admin FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------------------------
-- Student management: an administrator's decision on each uploaded document (one row per student + document).
-- No row = not reviewed yet (pending). A new upload by the student removes the row again.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_document_reviews (
  student_id  VARCHAR(32)  NOT NULL,
  kind        ENUM('id','enrollment') NOT NULL,
  status      ENUM('verified','rejected') NOT NULL,
  reason      VARCHAR(255) NULL,                                  -- required when rejected
  reviewed_by INT UNSIGNED NULL,
  reviewed_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (student_id, kind),
  CONSTRAINT fk_sdr_student FOREIGN KEY (student_id)  REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_sdr_admin   FOREIGN KEY (reviewed_by) REFERENCES admins (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
