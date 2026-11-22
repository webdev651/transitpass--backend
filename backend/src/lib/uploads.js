'use strict';
// Secure uploads for the student portal.
//  - multer keeps files in memory (nothing touches the disk until we have checked it)
//  - the file TYPE is decided from the file's first bytes, never from its name or the browser's Content-Type
//  - files are saved outside the public folder under a random name, and only their owner can download them
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { badRequest } = require('./httpError');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxDocBytes, files: 3, fields: 30, fieldSize: 20 * 1024, parts: 40 }
});
const FIELDS = upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'idDocument', maxCount: 1 }, { name: 'enrollmentDocument', maxCount: 1 }]);

/** Runs the multipart parser only for multipart requests (JSON requests pass straight through). */
const maybeMultipart = (req, res, next) => (req.is('multipart/form-data') ? FIELDS(req, res, next) : next());
const multipartOnly = (req, res, next) => (req.is('multipart/form-data') ? FIELDS(req, res, next) : next(badRequest('Send the form as multipart/form-data.')));

/** Real type from magic bytes: 'jpeg' | 'png' | 'webp' | 'pdf' | null. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };

/** Returns { dataUrl } for a valid small profile photo, or throws a 400. */
function photoToDataUrl(file) {
  if (!file) throw badRequest('Choose a profile photo.');
  const type = sniff(file.buffer);
  if (!['jpeg', 'png', 'webp'].includes(type)) throw badRequest('The profile photo must be a JPG, PNG or WEBP image.');
  if (file.buffer.length > config.uploads.maxPhotoBytes) throw badRequest(`The profile photo must be under ${Math.round(config.uploads.maxPhotoBytes / 1024)} KB.`);
  return `data:${MIME[type]};base64,${file.buffer.toString('base64')}`;
}

/** Checks a document (image or PDF) and returns { buffer, ext } or throws a 400. */
function checkDocument(file, label) {
  if (!file) throw badRequest(`${label} is required.`);
  const type = sniff(file.buffer);
  if (!type) throw badRequest(`${label} must be a PDF, JPG or PNG file.`);
  if (type === 'webp') throw badRequest(`${label} must be a PDF, JPG or PNG file.`);
  return { buffer: file.buffer, ext: type === 'jpeg' ? 'jpg' : type };
}

const root = () => path.resolve(config.uploads.dir);
const studentDir = (studentId) => path.join(root(), 'students', studentId);

/** Saves a checked document and returns its relative path (what goes in the database). */
async function saveDocument(studentId, kind, { buffer, ext }) {
  const dir = studentDir(studentId);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `${kind}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(dir, name), buffer, { flag: 'wx', mode: 0o600 });
  return path.posix.join('students', studentId, name);
}

/** Absolute path for a stored relative path, refusing anything that escapes the uploads folder. */
function resolveStored(rel) {
  if (!rel) return null;
  const abs = path.resolve(root(), rel);
  return abs.startsWith(root() + path.sep) ? abs : null;
}
const removeStored = (rel) => { const abs = resolveStored(rel); return abs ? fs.promises.unlink(abs).catch(() => {}) : Promise.resolve(); };
const mimeForFile = (file) => MIME[{ '.jpg': 'jpeg', '.png': 'png', '.pdf': 'pdf' }[path.extname(file).toLowerCase()]] || 'application/octet-stream';

module.exports = { maybeMultipart, multipartOnly, photoToDataUrl, checkDocument, saveDocument, resolveStored, removeStored, mimeForFile, sniff };
