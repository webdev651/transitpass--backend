-- TransitPass admin modules (additive). Applied by scripts/migrate.js right after schema.sql.
-- Every statement is CREATE TABLE IF NOT EXISTS, so it is safe to run repeatedly and never touches existing data.
-- Column additions to EXISTING tables (announcements, scans, activity_logs) are done in scripts/migrate.js.

-- Settings: one row per key. Values are JSON text; defaults live in src/services/settings.js.
CREATE TABLE IF NOT EXISTS system_settings (
  setting_key   VARCHAR(80)  NOT NULL PRIMARY KEY,
  setting_value MEDIUMTEXT   NOT NULL,
  updated_by    INT UNSIGNED NULL,
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_settings_admin FOREIGN KEY (updated_by) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1. Student application review history: every decision an administrator made on an application, document or correction.
CREATE TABLE IF NOT EXISTS application_review_history (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  student_id VARCHAR(32)  NOT NULL,
  event      ENUM('application_approved','application_rejected','application_reopened','document_verified','document_rejected','correction_approved','correction_rejected','renewal_approved','renewal_rejected','qr_replacement_approved','qr_replacement_rejected') NOT NULL,
  subject    VARCHAR(80)  NULL,                       -- which document / which field
  reason     VARCHAR(255) NULL,                       -- approval note or rejection reason
  admin_id   INT UNSIGNED NULL,
  admin_name VARCHAR(120) NOT NULL,                   -- snapshot, survives account deletion
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_arh_student (student_id, created_at),
  KEY idx_arh_created (created_at),
  CONSTRAINT fk_arh_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_arh_admin   FOREIGN KEY (admin_id)   REFERENCES admins (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Driver documents (licence, government ID). Files live under UPLOAD_DIR/drivers, never in the public frontend folder.
CREATE TABLE IF NOT EXISTS driver_documents (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  driver_id      INT UNSIGNED NOT NULL,
  doc_type       ENUM('license','government_id') NOT NULL,
  document_no    VARCHAR(60)  NULL,                   -- licence number / ID number
  expires_on     DATE         NULL,
  file_path      VARCHAR(255) NOT NULL,               -- relative to UPLOAD_DIR; never returned by the API
  original_name  VARCHAR(160) NULL,
  mime_type      VARCHAR(60)  NOT NULL,
  size_bytes     INT UNSIGNED NOT NULL,
  status         ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
  reason         VARCHAR(255) NULL,                   -- required when rejected
  uploaded_by    INT UNSIGNED NULL,
  uploaded_by_name VARCHAR(120) NOT NULL,
  uploaded_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_by    INT UNSIGNED NULL,
  reviewed_by_name VARCHAR(120) NULL,
  reviewed_at    DATETIME(3)  NULL,
  superseded     TINYINT(1)   NOT NULL DEFAULT 0,     -- 1 once a newer upload of the same type replaced it (kept for history)
  KEY idx_dd_driver (driver_id, doc_type, superseded),
  KEY idx_dd_status (status, superseded),
  KEY idx_dd_expiry (expires_on),
  CONSTRAINT fk_dd_driver   FOREIGN KEY (driver_id)   REFERENCES admins (id) ON DELETE CASCADE,
  CONSTRAINT fk_dd_uploader FOREIGN KEY (uploaded_by) REFERENCES admins (id) ON DELETE SET NULL,
  CONSTRAINT fk_dd_reviewer FOREIGN KEY (reviewed_by) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Vehicles. One driver can be assigned to at most one vehicle (UNIQUE on driver_id; NULL = unassigned).
CREATE TABLE IF NOT EXISTS vehicles (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name               VARCHAR(100) NOT NULL,
  vehicle_type       VARCHAR(40)  NOT NULL,           -- Bus, Jeepney, UV Express, Shuttle ...
  plate_number       VARCHAR(20)  NOT NULL,
  capacity           SMALLINT UNSIGNED NOT NULL,
  registration_no    VARCHAR(60)  NULL,               -- LTO OR/CR number
  registration_expiry DATE        NULL,
  notes              VARCHAR(255) NULL,
  status             ENUM('active','inactive','maintenance') NOT NULL DEFAULT 'active',
  driver_id          INT UNSIGNED NULL,
  created_by         INT UNSIGNED NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vehicles_plate (plate_number),
  UNIQUE KEY uq_vehicles_driver (driver_id),
  KEY idx_vehicles_status (status),
  CONSTRAINT fk_vehicles_driver  FOREIGN KEY (driver_id)  REFERENCES admins (id) ON DELETE SET NULL,
  CONSTRAINT fk_vehicles_creator FOREIGN KEY (created_by) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Routes and which vehicles / drivers are assigned to them.
CREATE TABLE IF NOT EXISTS transit_routes (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  origin      VARCHAR(120) NOT NULL,
  destination VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by  INT UNSIGNED NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_routes_name (name),
  KEY idx_routes_status (status),
  CONSTRAINT fk_routes_creator FOREIGN KEY (created_by) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS route_vehicles (
  route_id   INT UNSIGNED NOT NULL,
  vehicle_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (route_id, vehicle_id),
  CONSTRAINT fk_rv_route   FOREIGN KEY (route_id)   REFERENCES transit_routes (id) ON DELETE CASCADE,
  CONSTRAINT fk_rv_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles (id)       ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS route_drivers (
  route_id   INT UNSIGNED NOT NULL,
  driver_id  INT UNSIGNED NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (route_id, driver_id),
  CONSTRAINT fk_rd_route  FOREIGN KEY (route_id)  REFERENCES transit_routes (id) ON DELETE CASCADE,
  CONSTRAINT fk_rd_driver FOREIGN KEY (driver_id) REFERENCES admins (id)         ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Trips. RESTRICT: a route / vehicle / driver that has trips cannot be removed, so trip history stays complete.
CREATE TABLE IF NOT EXISTS trips (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  route_id        INT UNSIGNED NOT NULL,
  vehicle_id      INT UNSIGNED NOT NULL,
  driver_id       INT UNSIGNED NOT NULL,
  start_time      DATETIME(3)  NOT NULL,               -- planned start
  end_time        DATETIME(3)  NULL,                   -- planned end (NULL = open-ended)
  actual_start    DATETIME(3)  NULL,
  actual_end      DATETIME(3)  NULL,
  status          ENUM('scheduled','ongoing','completed','cancelled') NOT NULL DEFAULT 'scheduled',
  passenger_count INT UNSIGNED NOT NULL DEFAULT 0,
  notes           VARCHAR(255) NULL,
  cancel_reason   VARCHAR(255) NULL,
  created_by      INT UNSIGNED NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_trips_start (start_time),
  KEY idx_trips_driver (driver_id, status, start_time),
  KEY idx_trips_vehicle (vehicle_id, status, start_time),
  KEY idx_trips_route (route_id, start_time),
  CONSTRAINT fk_trips_route   FOREIGN KEY (route_id)   REFERENCES transit_routes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_trips_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles (id)       ON DELETE RESTRICT,
  CONSTRAINT fk_trips_driver  FOREIGN KEY (driver_id)  REFERENCES admins (id)         ON DELETE RESTRICT,
  CONSTRAINT fk_trips_creator FOREIGN KEY (created_by) REFERENCES admins (id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Driver devices. A device identifier belongs to exactly one driver account at a time.
CREATE TABLE IF NOT EXISTS driver_devices (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  driver_id         INT UNSIGNED NOT NULL,
  device_identifier VARCHAR(100) NOT NULL,
  device_name       VARCHAR(120) NOT NULL,
  platform          VARCHAR(60)  NULL,
  status            ENUM('active','inactive','removed') NOT NULL DEFAULT 'active',
  registered_by     INT UNSIGNED NULL,
  registered_by_name VARCHAR(120) NOT NULL,
  registered_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at      DATETIME(3)  NULL,
  last_seen_ip      VARCHAR(45)  NULL,
  UNIQUE KEY uq_devices_identifier (device_identifier),
  KEY idx_devices_driver (driver_id, status),
  CONSTRAINT fk_devices_driver FOREIGN KEY (driver_id)     REFERENCES admins (id) ON DELETE CASCADE,
  CONSTRAINT fk_devices_admin  FOREIGN KEY (registered_by) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_events (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id   BIGINT UNSIGNED NULL,
  driver_id   INT UNSIGNED NULL,
  identifier  VARCHAR(100) NULL,                       -- kept even when the device row is gone / was never registered
  event       VARCHAR(30)  NOT NULL,                   -- registered | activated | deactivated | removed | relinked | blocked | unregistered_use
  detail      VARCHAR(255) NULL,
  admin_name  VARCHAR(120) NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_de_device (device_id, created_at),
  KEY idx_de_driver (driver_id, created_at),
  KEY idx_de_created (created_at),
  CONSTRAINT fk_de_device FOREIGN KEY (device_id) REFERENCES driver_devices (id) ON DELETE SET NULL,
  CONSTRAINT fk_de_driver FOREIGN KEY (driver_id) REFERENCES admins (id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Notification management (one row per recipient). Students also get the message in their portal inbox (email_log);
-- the read / delivery state of those rows is read from email_log / announcement_reads, not duplicated here.
CREATE TABLE IF NOT EXISTS notifications (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  recipient_type ENUM('student','driver') NOT NULL,
  student_id     VARCHAR(32)  NULL,
  driver_id      INT UNSIGNED NULL,
  recipient_name VARCHAR(120) NOT NULL,
  category       ENUM('account_status','eligibility_expiry','qr_expiry','announcement','refund','general') NOT NULL DEFAULT 'general',
  title          VARCHAR(200) NOT NULL,
  body           TEXT         NOT NULL,
  delivery_status ENUM('queued','delivered','failed') NOT NULL DEFAULT 'delivered',
  email_log_id   BIGINT UNSIGNED NULL,
  announcement_id INT UNSIGNED NULL,
  is_read        TINYINT(1)   NOT NULL DEFAULT 0,      -- drivers only; students: see email_log / announcement_reads
  read_at        DATETIME(3)  NULL,
  dedupe_key     VARCHAR(120) NULL,
  created_by     INT UNSIGNED NULL,
  created_by_name VARCHAR(120) NULL,                   -- NULL = generated automatically by the system
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_notif_dedupe (dedupe_key),
  KEY idx_notif_created (created_at),
  KEY idx_notif_student (student_id, created_at),
  KEY idx_notif_driver (driver_id, is_read, created_at),
  KEY idx_notif_category (category, created_at),
  CONSTRAINT fk_notif_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_notif_driver  FOREIGN KEY (driver_id)  REFERENCES admins (id)   ON DELETE CASCADE,
  CONSTRAINT fk_notif_admin   FOREIGN KEY (created_by) REFERENCES admins (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. Refunds and transaction cancellation. A "transaction" is a granted/review row in scans; scans rows are NEVER deleted or edited.
CREATE TABLE IF NOT EXISTS refund_requests (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  scan_id         BIGINT UNSIGNED NOT NULL,
  student_id      VARCHAR(32)  NULL,
  student_name    VARCHAR(120) NULL,
  amount          DECIMAL(8,2) NOT NULL,
  reason          VARCHAR(500) NOT NULL,
  source          ENUM('student','admin') NOT NULL DEFAULT 'admin',
  status          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  decision_reason VARCHAR(255) NULL,
  requested_by    INT UNSIGNED NULL,
  requested_by_name VARCHAR(120) NOT NULL,
  decided_by      INT UNSIGNED NULL,
  decided_by_name VARCHAR(120) NULL,
  decided_at      DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_refund_status (status, created_at),
  KEY idx_refund_scan (scan_id),
  KEY idx_refund_student (student_id),
  CONSTRAINT fk_refund_scan    FOREIGN KEY (scan_id)      REFERENCES scans (id)    ON DELETE RESTRICT,
  CONSTRAINT fk_refund_student FOREIGN KEY (student_id)   REFERENCES students (id) ON DELETE SET NULL,
  CONSTRAINT fk_refund_req     FOREIGN KEY (requested_by) REFERENCES admins (id)   ON DELETE SET NULL,
  CONSTRAINT fk_refund_dec     FOREIGN KEY (decided_by)   REFERENCES admins (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transaction_cancellations (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  scan_id          BIGINT UNSIGNED NOT NULL,
  reason           VARCHAR(500) NOT NULL,
  cancelled_by     INT UNSIGNED NULL,
  cancelled_by_name VARCHAR(120) NOT NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_cancel_scan (scan_id),                 -- a transaction can be cancelled only once
  KEY idx_cancel_created (created_at),
  CONSTRAINT fk_cancel_scan  FOREIGN KEY (scan_id)      REFERENCES scans (id)  ON DELETE RESTRICT,
  CONSTRAINT fk_cancel_admin FOREIGN KEY (cancelled_by) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. Suspicious activity. dedupe_key makes detection repeatable: the same event is never flagged twice.
CREATE TABLE IF NOT EXISTS suspicious_flags (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  flag_type   ENUM('repeated_scan','duplicate_transaction','unusual_activity','multi_device') NOT NULL,
  severity    ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  student_id  VARCHAR(32)  NULL,
  driver_id   INT UNSIGNED NULL,
  scan_id     BIGINT UNSIGNED NULL,
  summary     VARCHAR(255) NOT NULL,
  details     TEXT         NULL,                       -- JSON
  status      ENUM('open','reviewed','dismissed','actioned') NOT NULL DEFAULT 'open',
  dedupe_key  VARCHAR(160) NOT NULL,
  detected_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_by INT UNSIGNED NULL,
  reviewed_by_name VARCHAR(120) NULL,
  reviewed_at DATETIME(3)  NULL,
  action_taken VARCHAR(255) NULL,
  UNIQUE KEY uq_flag_dedupe (dedupe_key),
  KEY idx_flag_status (status, detected_at),
  KEY idx_flag_student (student_id),
  KEY idx_flag_driver (driver_id),
  CONSTRAINT fk_flag_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL,
  CONSTRAINT fk_flag_driver  FOREIGN KEY (driver_id)  REFERENCES admins (id)   ON DELETE SET NULL,
  CONSTRAINT fk_flag_scan    FOREIGN KEY (scan_id)    REFERENCES scans (id)    ON DELETE SET NULL,
  CONSTRAINT fk_flag_rev     FOREIGN KEY (reviewed_by) REFERENCES admins (id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS suspicious_notes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  flag_id    BIGINT UNSIGNED NOT NULL,
  admin_id   INT UNSIGNED NULL,
  admin_name VARCHAR(120) NOT NULL,
  note       TEXT         NOT NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_sn_flag (flag_id, created_at),
  CONSTRAINT fk_sn_flag  FOREIGN KEY (flag_id)  REFERENCES suspicious_flags (id) ON DELETE CASCADE,
  CONSTRAINT fk_sn_admin FOREIGN KEY (admin_id) REFERENCES admins (id)           ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. Backup history. The files are stored OUTSIDE the public frontend folder (BACKUP_DIR) and are only served to administrators.
CREATE TABLE IF NOT EXISTS backup_history (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  filename      VARCHAR(160) NULL,
  backup_type   ENUM('manual','scheduled') NOT NULL DEFAULT 'manual',
  status        ENUM('running','completed','failed','deleted') NOT NULL DEFAULT 'running',
  size_bytes    BIGINT UNSIGNED NULL,
  checksum      CHAR(64)     NULL,                     -- SHA-256 of the stored (compressed) file
  tables_count  INT UNSIGNED NULL,
  rows_count    BIGINT UNSIGNED NULL,
  started_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at   DATETIME(3)  NULL,
  created_by    INT UNSIGNED NULL,
  created_by_name VARCHAR(120) NOT NULL,
  error         VARCHAR(255) NULL,
  last_verified_at DATETIME(3) NULL,
  verify_result VARCHAR(120) NULL,
  deleted_at    DATETIME(3)  NULL,
  deleted_by_name VARCHAR(120) NULL,
  KEY idx_backup_started (started_at),
  KEY idx_backup_status (status),
  CONSTRAINT fk_backup_admin FOREIGN KEY (created_by) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. Fare and discount rules (Stage 2). route_id NULL = the default rule for every route that has no rule of its own.
-- A rule is "in force" on a day when is_active = 1 and effective_from <= day <= effective_until (NULL = no end). The discount inside
-- a rule has its own on/off switch and optional start / end dates. Scans copy the amounts they were charged, so editing a rule never rewrites history.
CREATE TABLE IF NOT EXISTS fare_rules (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  route_id         INT UNSIGNED NULL,
  regular_fare     DECIMAL(8,2) NOT NULL,
  discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
  discount_active  TINYINT(1)   NOT NULL DEFAULT 1,
  discount_start   DATE NULL,
  discount_end     DATE NULL,
  effective_from   DATE NOT NULL,
  effective_until  DATE NULL,
  is_active        TINYINT(1)   NOT NULL DEFAULT 1,
  notes            VARCHAR(255) NULL,
  created_by       INT UNSIGNED NULL,
  updated_by       INT UNSIGNED NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_fare_lookup (is_active, route_id, effective_from),
  CONSTRAINT fk_fare_route   FOREIGN KEY (route_id)   REFERENCES transit_routes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fare_creator FOREIGN KEY (created_by) REFERENCES admins (id) ON DELETE SET NULL,
  CONSTRAINT fk_fare_updater FOREIGN KEY (updated_by) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
