'use strict';
/*
  Driver document verification: licence and government ID. An administrator uploads (or receives) the document, opens it,
  and approves or rejects it with a reason. Files are stored under UPLOAD_DIR/drivers (outside the public folder), named
  randomly, type-checked by their first bytes, and only streamed to signed-in administrators (every view is audited).
  A newer upload of the same type replaces the old one as the "current" document; the old row stays for history.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { withTransaction } = require('../db');
const { notFound, conflict, badRequest } = require('../lib/httpError');
const { escapeLike } = require('../lib/sql');
const { toDate } = require('../lib/time');
const { todayYmd, isRealDate } = require('../lib/dates');
const uploads = require('../lib/uploads');
const notifications = require('./notifications');

const TYPES = { license: 'Driver licence', government_id: 'Government ID' };
const EXPIRY_WARNING_DAYS = 30;
const iso = (v) => (v ? toDate(v).toISOString() : null);
const ymd = (v) => (v ? (v instanceof Date ? `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}` : String(v).slice(0, 10)) : null);

/** What the administrator sees: the stored decision, except that an approved document past its date is "expired". */
function effective(r, today = todayYmd()) {
  const exp = ymd(r.expires_on);
  if (r.status === 'verified' && exp && exp < today) return 'expired';
  return r.status;
}
function expiryInfo(r, today = todayYmd()) {
  const exp = ymd(r.expires_on);
  if (!exp) return { expiresOn: null, daysToExpiry: null, expiryState: 'none' };
  const days = Math.round((Date.parse(exp) - Date.parse(today)) / 86400000);
  return { expiresOn: exp, daysToExpiry: days, expiryState: days < 0 ? 'expired' : days <= EXPIRY_WARNING_DAYS ? 'expiring' : 'valid' };
}
function present(r, today) {
  return {
    id: r.id, driverId: r.driver_id, driver: r.driver_name, driverUnit: r.driver_unit || null, type: r.doc_type, typeLabel: TYPES[r.doc_type], documentNo: r.document_no,
    ...expiryInfo(r, today), status: effective(r, today), storedStatus: r.status, reason: r.reason, current: !r.superseded,
    fileName: r.original_name, mime: r.mime_type, sizeBytes: r.size_bytes,
    uploadedAt: iso(r.uploaded_at), uploadedBy: r.uploaded_by_name, reviewedAt: iso(r.reviewed_at), reviewedBy: r.reviewed_by_name || null
  };
}
const BASE = "SELECT d.*, a.name AS driver_name, a.unit AS driver_unit FROM driver_documents d JOIN admins a ON a.id = d.driver_id";

async function getDriver(db, id) {
  const [rows] = await db.query("SELECT * FROM admins WHERE id = ? AND role = 'driver'", [id]);
  if (!rows[0]) throw notFound('Driver not found');
  return rows[0];
}
async function getDoc(db, id) {
  const [rows] = await db.query(`${BASE} WHERE d.id = ?`, [id]);
  if (!rows[0]) throw notFound('Document not found');
  return rows[0];
}

async function list(pool, { status, type, driverId, expiry, q, history, limit, offset }) {
  const today = todayYmd();
  const where = [];
  const args = [];
  if (!history) where.push('d.superseded = 0');
  if (driverId) { where.push('d.driver_id = ?'); args.push(driverId); }
  if (type && type !== 'all') { where.push('d.doc_type = ?'); args.push(type); }
  if (status && status !== 'all') {
    if (status === 'expired') { where.push("d.status = 'verified' AND d.expires_on < ?"); args.push(today); }
    else if (status === 'verified') { where.push("d.status = 'verified' AND (d.expires_on IS NULL OR d.expires_on >= ?)"); args.push(today); }
    else { where.push('d.status = ?'); args.push(status); }
  }
  if (expiry === 'expiring') { where.push('d.expires_on >= ? AND d.expires_on <= ?'); args.push(today, todayYmd(EXPIRY_WARNING_DAYS)); }
  if (expiry === 'expired') { where.push('d.expires_on < ?'); args.push(today); }
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(a.name LIKE ? OR a.username LIKE ? OR d.document_no LIKE ?)'); args.push(like, like, like); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM driver_documents d JOIN admins a ON a.id = d.driver_id ${clause}`, args);
  const [rows] = await pool.query(`${BASE} ${clause} ORDER BY (d.status = 'pending') DESC, d.uploaded_at DESC, d.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { total: Number(total), items: rows.map((r) => present(r, today)) };
}

async function upload(pool, admin, { driverId, type, documentNo, expiresOn }, file) {
  const driver = await getDriver(pool, driverId);
  if (!TYPES[type]) throw badRequest('Choose a document type.');
  const doc = uploads.checkDocument(file, TYPES[type]);
  if (expiresOn !== undefined && expiresOn !== '' && !isRealDate(expiresOn)) throw badRequest('Use a real expiry date in the format YYYY-MM-DD.');
  if (type === 'license' && !expiresOn) throw badRequest('Enter the licence expiry date.');
  if (expiresOn && expiresOn < todayYmd()) throw badRequest('That document has already expired. Upload a valid one.');
  const dir = path.join(path.resolve(config.uploads.dir), 'drivers', String(driver.id));
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `${type}-${crypto.randomBytes(12).toString('hex')}.${doc.ext}`;
  await fs.promises.writeFile(path.join(dir, name), doc.buffer, { flag: 'wx', mode: 0o600 });
  const rel = path.posix.join('drivers', String(driver.id), name);
  const mime = uploads.mimeForFile(name);
  try {
    const id = await withTransaction(pool, async (conn) => {
      await conn.query("SELECT id FROM admins WHERE id = ? FOR UPDATE", [driver.id]);
      await conn.query('UPDATE driver_documents SET superseded = 1 WHERE driver_id = ? AND doc_type = ? AND superseded = 0', [driver.id, type]);
      const [res] = await conn.query(
        `INSERT INTO driver_documents (driver_id, doc_type, document_no, expires_on, file_path, original_name, mime_type, size_bytes, uploaded_by, uploaded_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [driver.id, type, documentNo || null, expiresOn || null, rel, file.originalname ? String(file.originalname).replace(/[^\w.\- ]/g, '_').slice(0, 160) : null, mime, doc.buffer.length, admin.id, admin.name]);
      return res.insertId;
    });
    return present(await getDoc(pool, id));
  } catch (e) { await uploads.removeStored(rel); throw e; }
}

async function file(pool, id) {
  const r = await getDoc(pool, id);
  const abs = uploads.resolveStored(r.file_path);
  if (!abs || !fs.existsSync(abs)) throw notFound('The file for this document is missing on the server.');
  return { abs, mime: r.mime_type, driverName: r.driver_name, typeLabel: TYPES[r.doc_type], row: r };
}

async function review(pool, admin, id, { decision, reason }) {
  const r = await getDoc(pool, id);
  if (r.superseded) throw conflict('A newer document was uploaded for this driver. Review the newer one.');
  if (decision === 'verified' && effective({ ...r, status: 'verified' }) === 'expired') throw conflict('This document has expired and cannot be approved.');
  await pool.query(
    'UPDATE driver_documents SET status = ?, reason = ?, reviewed_by = ?, reviewed_by_name = ?, reviewed_at = ? WHERE id = ?',
    [decision, decision === 'rejected' ? reason : (reason || null), admin.id, admin.name, new Date(), id]);
  const driver = await getDriver(pool, r.driver_id);
  await notifications.accountStatus(pool, driver, 'driver', {
    admin, title: decision === 'verified' ? `Your ${TYPES[r.doc_type]} was approved` : `Your ${TYPES[r.doc_type]} was not approved`,
    body: decision === 'verified' ? `Your ${TYPES[r.doc_type].toLowerCase()} was checked and approved.` : `Your ${TYPES[r.doc_type].toLowerCase()} was not accepted. Reason: ${reason}. Please submit a new document to the administrator.`
  });
  return present(await getDoc(pool, id));
}

/** One row per driver with the state of the two required documents and the overall verification status. */
async function driverStatuses(pool, { q, status, limit, offset, driverId }) {
  const today = todayYmd();
  const where = ["a.role = 'driver'"];
  const args = [];
  if (driverId) { where.push('a.id = ?'); args.push(driverId); }
  if (q) { const like = `%${escapeLike(q)}%`; where.push('(a.name LIKE ? OR a.username LIKE ? OR a.unit LIKE ?)'); args.push(like, like, like); }
  const [drivers] = await pool.query(`SELECT a.id, a.name, a.username, a.unit, a.status FROM admins a WHERE ${where.join(' AND ')} ORDER BY a.name`, args);
  const ids = drivers.map((d) => d.id);
  const [docs] = ids.length ? await pool.query('SELECT * FROM driver_documents WHERE superseded = 0 AND driver_id IN (?)', [ids]) : [[]];
  const byDriver = new Map();
  docs.forEach((d) => { if (!byDriver.has(d.driver_id)) byDriver.set(d.driver_id, {}); byDriver.get(d.driver_id)[d.doc_type] = d; });
  let out = drivers.map((d) => {
    const set = byDriver.get(d.id) || {};
    const states = Object.fromEntries(Object.keys(TYPES).map((t) => [t, set[t] ? { id: set[t].id, status: effective(set[t], today), ...expiryInfo(set[t], today) } : { status: 'missing' }]));
    const all = Object.values(states).map((s) => s.status);
    const overall = all.includes('rejected') ? 'rejected' : all.includes('expired') ? 'expired' : all.includes('missing') ? 'incomplete' : all.includes('pending') ? 'pending' : 'verified';
    return { id: d.id, name: d.name, username: d.username, unit: d.unit, accountStatus: d.status, documents: states, verification: overall };
  });
  if (status && status !== 'all') out = out.filter((d) => d.verification === status);
  return { total: out.length, items: out.slice(offset, offset + limit) };
}

async function summary(pool) {
  const today = todayYmd();
  const all = (await driverStatuses(pool, { limit: 5000, offset: 0 })).items;
  const count = (s) => all.filter((d) => d.verification === s).length;
  const [[e]] = await pool.query(
    `SELECT COALESCE(SUM(expires_on < ?), 0) AS expired, COALESCE(SUM(expires_on >= ? AND expires_on <= ?), 0) AS expiring
       FROM driver_documents WHERE superseded = 0 AND status <> 'rejected'`, [today, today, todayYmd(EXPIRY_WARNING_DAYS)]);
  const [[p]] = await pool.query("SELECT COUNT(*) AS n FROM driver_documents WHERE superseded = 0 AND status = 'pending'");
  return { drivers: all.length, verified: count('verified'), pending: count('pending'), rejected: count('rejected'), expired: count('expired'), incomplete: count('incomplete'),
    documentsAwaitingReview: Number(p.n), documentsExpired: Number(e.expired), documentsExpiringSoon: Number(e.expiring), warningDays: EXPIRY_WARNING_DAYS };
}

/** Tell drivers whose documents are about to expire. Once per document (dedupe_key). */
async function notifyExpiring(pool) {
  const [rows] = await pool.query(
    `SELECT d.id, d.doc_type, d.expires_on, a.id AS driver_id, a.name FROM driver_documents d JOIN admins a ON a.id = d.driver_id
      WHERE d.superseded = 0 AND d.status = 'verified' AND d.expires_on >= ? AND d.expires_on <= ? AND a.status = 'active'`, [todayYmd(), todayYmd(EXPIRY_WARNING_DAYS)]);
  let n = 0;
  for (const r of rows) {
    const made = await notifications.notifyDriver(pool, { id: r.driver_id, name: r.name }, {
      category: 'account_status', dedupeKey: `drvdoc:${r.id}`, title: `Your ${TYPES[r.doc_type]} expires soon`,
      body: `Your ${TYPES[r.doc_type].toLowerCase()} expires on ${ymd(r.expires_on)}. Please give the administrator an updated copy before then.`
    });
    if (made) n++;
  }
  return { notified: n };
}


/* ---- driver self-service: a driver sees, uploads, previews and replaces ONLY their own documents ---- */

/** What the driver sees for one document: the same fields as the administrator view, minus the account internals. */
function presentOwn(r, today) {
  const d = present(r, today);
  return {
    id: d.id, type: d.type, typeLabel: d.typeLabel, documentNo: d.documentNo, expiresOn: d.expiresOn, daysToExpiry: d.daysToExpiry, expiryState: d.expiryState,
    status: d.status, remarks: d.status === 'rejected' ? d.reason : null, note: d.status === 'verified' ? d.reason : null, current: d.current,
    fileName: d.fileName, mime: d.mime, sizeBytes: d.sizeBytes, uploadedAt: d.uploadedAt, reviewedAt: d.reviewedAt, reviewedBy: d.reviewedBy
  };
}

/** The driver's two required documents (current version, or a "missing" placeholder), the history of replaced uploads, and the overall state. */
async function listOwn(pool, driverId) {
  const today = todayYmd();
  const [rows] = await pool.query(`${BASE} WHERE d.driver_id = ? ORDER BY d.uploaded_at DESC, d.id DESC`, [driverId]);
  const current = {};
  const history = [];
  for (const r of rows) {
    if (!r.superseded && !current[r.doc_type]) current[r.doc_type] = presentOwn(r, today);
    else history.push(presentOwn(r, today));
  }
  const items = Object.keys(TYPES).map((t) => current[t] || { id: null, type: t, typeLabel: TYPES[t], status: 'missing', expiryState: 'none', expiresOn: null, daysToExpiry: null, remarks: null });
  const overall = (await driverStatuses(pool, { driverId, limit: 1, offset: 0 })).items[0];
  return { items, history, verification: overall ? overall.verification : 'incomplete', warningDays: EXPIRY_WARNING_DAYS };
}

/** A driver uploads a first document or replaces the current one. The new file is "pending" until an administrator reviews it. */
async function uploadOwn(pool, driver, body, fileObj) {
  const doc = await upload(pool, driver, { driverId: driver.id, ...body }, fileObj);
  return presentOwn(await getDoc(pool, doc.id));
}

/** File of one of the driver's OWN documents. Someone else's document id answers "not found", exactly like an id that does not exist. */
async function fileOwn(pool, driverId, id) {
  const r = await getDoc(pool, id);
  if (Number(r.driver_id) !== Number(driverId)) throw notFound('Document not found');
  const abs = uploads.resolveStored(r.file_path);
  if (!abs || !fs.existsSync(abs)) throw notFound('The file for this document is missing on the server.');
  return { abs, mime: r.mime_type, typeLabel: TYPES[r.doc_type], row: r };
}

module.exports = { TYPES, EXPIRY_WARNING_DAYS, list, upload, file, review, driverStatuses, summary, notifyExpiring, listOwn, uploadOwn, fileOwn };
