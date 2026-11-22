'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const env = process.env;
const nodeEnv = env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

function num(name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number (got "${raw}")`);
  return n;
}

let jwtSecret = env.JWT_SECRET;
if (!jwtSecret) {
  if (isProd) throw new Error('JWT_SECRET is required in production');
  jwtSecret = 'dev-only-insecure-secret-change-me-0123456789';        // tests only
  if (!isTest) {
    // Not set in .env: never fall back to a secret that is written in the source code (anyone could forge sign-in tokens with it).
    // A random one is generated once and kept in backend/.jwt-secret (git-ignored), so sessions survive restarts.
    const file = path.join(__dirname, '..', '.jwt-secret');
    try {
      jwtSecret = fs.readFileSync(file, 'utf8').trim();
      if (jwtSecret.length < 32) throw new Error('too short');
    } catch (_) {
      jwtSecret = require('crypto').randomBytes(48).toString('hex');
      try { fs.writeFileSync(file, jwtSecret + '\n', { mode: 0o600 }); console.warn('[config] JWT_SECRET is not set: generated a random one in backend/.jwt-secret. Set JWT_SECRET in .env to manage it yourself.'); }
      catch (e) { console.warn('[config] JWT_SECRET is not set and backend/.jwt-secret could not be written; sessions will end when the server restarts.'); }
    }
  }
} else if (isProd && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

// Aiven for MySQL (and most managed MySQL providers) require encrypted connections.
// DB_SSL=true  -> TLS without CA verification (quick setup, connection still encrypted).
// DB_SSL_CA    -> PEM certificate contents (or a path to a .pem file) for full verification.
function dbSsl() {
  const ca = env.DB_SSL_CA;
  if (ca) {
    // A path to a CA file (relative paths resolve against the backend folder, so it
    // works from any working directory, e.g. Render) or inline PEM contents.
    const file = path.isAbsolute(ca) ? ca : path.join(__dirname, '..', ca);
    return { ca: fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : ca };
  }
  return String(env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined;
}

const config = {
  nodeEnv, isProd, isTest,
  port: num('PORT', 3000) || null,
  httpsPort: num('HTTPS_PORT', 3443) || null,
  host: env.HOST || '0.0.0.0', // 0.0.0.0 = reachable from other devices on your Wi-Fi (e.g. your phone); use 127.0.0.1 for this computer only
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: num('DB_PORT', 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'transitpass',
    connectionLimit: num('DB_POOL_SIZE', 10),
    ssl: dbSsl()
  },
  jwt: { secret: jwtSecret, expiresIn: env.JWT_EXPIRES_IN || '8h' },
  corsOrigins: (env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
  // If FRONTEND_DIR isn't set, serve the sibling ../frontend folder when it exists (so one command runs everything).
  frontendDir: env.FRONTEND_DIR || (fs.existsSync(path.join(__dirname, '..', '..', 'frontend')) ? path.join(__dirname, '..', '..', 'frontend') : null),
  fare: {
    full: num('FULL_FARE', 16.25),
    discountRate: num('DISCOUNT_RATE', 0.2),
    defaultValidity: env.DEFAULT_VALIDITY || '31 Mar 2027'
  },
  qr: { validityDays: num('QR_VALIDITY_DAYS', 180) },        // how long a generated QR code stays valid
  renewal: { validityDays: num('RENEWAL_VALIDITY_DAYS', 180) }, // how long an approved discount renewal runs for
  registrar: { mode: (env.REGISTRAR_MODE || 'manual').toLowerCase(), url: env.REGISTRAR_API_URL || '' }, // 'manual' = admin-assisted verification
  faceMatchThreshold: num('FACE_MATCH_THRESHOLD', 0.6),
  timezone: env.APP_TIMEZONE || 'Asia/Manila',
  email: {
    mode: (env.EMAIL_MODE || 'log').toLowerCase(),
    smtp: {
      host: env.SMTP_HOST, port: num('SMTP_PORT', 587),
      user: env.SMTP_USER, pass: env.SMTP_PASS,
      from: env.SMTP_FROM || 'TransitPass <no-reply@transitpass.local>'
    }
  },
  // Student portal: uploaded files live OUTSIDE the public frontend folder and are only served to their owner.
  uploads: {
    dir: env.UPLOAD_DIR ? path.resolve(env.UPLOAD_DIR) : path.join(__dirname, '..', 'uploads'),
    maxPhotoBytes: num('MAX_PHOTO_KB', 1024) * 1024,
    maxDocBytes: num('MAX_DOC_MB', 5) * 1024 * 1024
  },
  // Database backups: stored OUTSIDE the public frontend folder and only ever served to signed-in administrators.
  backups: { dir: env.BACKUP_DIR ? path.resolve(env.BACKUP_DIR) : path.join(__dirname, '..', 'backups') },
  // Used ONLY to build the link inside password-reset emails (never taken from the request, so it cannot be spoofed).
  publicUrl: (env.PUBLIC_URL || `http://localhost:${num('PORT', 3000)}`).replace(/\/+$/, ''),
  passwordReset: {
    ttlMinutes: num('RESET_TOKEN_MINUTES', 60),
    showLink: !isProd && String(env.SHOW_RESET_LINK || '').toLowerCase() === 'true' // development helper: returns the link in the API reply
  },
  renewalWindowDays: num('RENEWAL_WINDOW_DAYS', 30),         // how many days before expiry a student is reminded / may request renewal
  loginRateLimit: { windowMs: 15 * 60 * 1000, max: num('LOGIN_RATE_MAX', 10) },
  registerRateLimit: { windowMs: 60 * 60 * 1000, max: num('REGISTER_RATE_MAX', 20) }, // new student accounts per IP per hour
  seedStudentPassword: env.STUDENT_DEMO_PASSWORD || (isProd ? '' : 'student1234'),     // only used by `npm run seed:demo`
  seedAdmin: {
    username: env.ADMIN_USERNAME || 'admin',
    password: env.ADMIN_PASSWORD || (isProd ? '' : 'admin1234'), // dev default; production must set ADMIN_PASSWORD
    name: env.ADMIN_NAME || 'Administrator',
    email: env.ADMIN_EMAIL || 'admin@transitpass.local',
    node: env.ADMIN_NODE || 'verification.node-04'
  }
};

if (config.qr.validityDays < 1) throw new Error('QR_VALIDITY_DAYS must be at least 1');
if (!['log', 'smtp'].includes(config.email.mode)) throw new Error('EMAIL_MODE must be "log" or "smtp"');
if (config.fare.discountRate < 0 || config.fare.discountRate >= 1) throw new Error('DISCOUNT_RATE must be in [0, 1)');

module.exports = config;
