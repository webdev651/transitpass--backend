'use strict';
const config = require('../config');
const { withTransaction } = require('../db');
const { notFound, conflict } = require('../lib/httpError');
const { sendEmail } = require('../lib/email');
const { escapeLike } = require('../lib/sql');
const { localParts } = require('../lib/time');
const ser = require('../lib/serialize');
const qrService = require('./qr');
const verification = require('./studentVerification');

// Student row + verification state + whether a live QR code exists (used for every admin-facing student shape).
const FULL = `SELECT s.*, v.verification_status, v.method AS verification_method, v.verification_date, v.rejection_reason,
                     v.note AS verification_note, v.submitted_at, a.name AS verified_by_name,
                     (SELECT q.id FROM qr_codes q WHERE q.student_id = s.id AND q.status = 'active' AND q.expires_at > ? LIMIT 1) AS active_qr_id
                FROM students s
                LEFT JOIN student_verifications v ON v.student_id = s.id
                LEFT JOIN admins a ON a.id = v.verified_by`;

async function getRow(db, id) {
  const [rows] = await db.query('SELECT * FROM students WHERE id = ?', [id]);
  if (!rows[0]) throw notFound('Student not found');
  return rows[0];
}

async function list(pool, { q, status, discount, limit, offset }) {
  const where = [];
  const args = [];
  if (status !== 'all') { where.push('s.status = ?'); args.push(status); }
  if (discount === 'eligible') where.push('s.discount_eligible = 1');
  if (discount === 'ineligible') where.push('s.discount_eligible = 0');
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push('(s.name LIKE ? OR s.id LIKE ? OR s.school_id LIKE ? OR s.school LIKE ? OR s.program LIKE ?)');
    args.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM students s ${clause}`, args);
  const [rows] = await pool.query(
    `${FULL} ${clause} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`, [new Date(), ...args, limit, offset]);
  return { items: rows.map(ser.student), total };
}

async function stats(pool) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'pending'), 0) AS pending,
            COALESCE(SUM(status = 'flagged'), 0) AS flagged,
            COALESCE(SUM(discount_eligible = 0), 0) AS ineligible
       FROM students`);
  return { total: Number(r.total), pending: Number(r.pending), flagged: Number(r.flagged), ineligible: Number(r.ineligible) };
}

async function get(pool, id) {
  const [rows] = await pool.query(`${FULL} WHERE s.id = ?`, [new Date(), id]);
  if (!rows[0]) throw notFound('Student not found');
  return ser.student(rows[0]);
}

async function create(pool, d) {
  const year = localParts(new Date()).year;
  const digits = (d.schoolId.match(/\d/g) || []).join('').slice(-5).padStart(5, '0');
  const base = `STD-${year}-${digits}`;
  const hasFace = Array.isArray(d.faceDescriptor);
  // Registrar-issued passes are "active". A student signing up for themselves passes status "pending" and a
  // passwordHash. (These two fields are set by our own code only - the API schemas strip them from request bodies.)
  const status = d.status || 'active';
  const validUntil = d.validUntil || (status === 'pending' ? 'Awaiting registrar' : config.fare.defaultValidity);
  let id = base;
  let suffix = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    const [taken] = await pool.query('SELECT 1 FROM students WHERE id = ?', [id]);
    if (taken.length) { id = `${base}-${suffix++}`; continue; }
    try {
      await pool.query(
        `INSERT INTO students (id, school_id, name, school, program, level, status, valid_until, email, phone,
                               face_enrolled, face_photo, face_descriptor, password_hash, campus, section)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, d.schoolId, d.name, d.school, d.program, d.level, status, validUntil,
          d.email, d.phone || '—', hasFace ? 1 : 0, d.facePhoto || null, hasFace ? JSON.stringify(d.faceDescriptor) : null,
          d.passwordHash || null, d.campus || '—', d.section || '—']);
    } catch (err) {
      // Lost a race for the generated id: pick the next suffix. Other duplicates (email, school id) surface as 409.
      if (err.code === 'ER_DUP_ENTRY' && /PRIMARY/.test(err.sqlMessage || '')) { id = `${base}-${suffix++}`; continue; }
      throw err;
    }
    // Self-registered students start PENDING. A registrar adding a student counts as that admin verifying them.
    if (status === 'pending') {
      await pool.query("INSERT INTO student_verifications (student_id, verification_status, method) VALUES (?, 'pending', 'admin_review')", [id]);
    } else {
      await pool.query(
        "INSERT INTO student_verifications (student_id, verification_status, method, verified_by, verification_date) VALUES (?, 'verified', 'admin_issued', ?, ?)",
        [id, d.verifiedBy || null, new Date()]);
    }
    const row = await getRow(pool, id);
    if (status === 'pending') {
      await sendEmail(pool, row, 'We received your TransitPass registration',
        `Hi ${row.name}, your account (School ID ${row.school_id}) was created and is waiting for registrar approval. You'll get another email once your pass is active.`);
      return get(pool, id);
    }
    await sendEmail(pool, row, 'Your TransitPass credential is ready',
      `Hi ${row.name}, a registrar has issued your TransitPass discount pass (School ID ${row.school_id}). It's active and valid until ${row.valid_until}.${row.face_enrolled ? ' Face verification is enrolled for boarding checks.' : ''} Visit TransitPass and sign in to generate your QR code.`);
    return get(pool, id);
  }
  throw conflict('Could not allocate a unique student id — please retry');
}

async function update(pool, id, d) {
  const old = await getRow(pool, id);
  const set = [];
  const args = [];
  const assign = (col, val) => { set.push(`${col} = ?`); args.push(val); };

  if (d.name !== undefined) assign('name', d.name);
  if (d.school !== undefined) assign('school', d.school);
  if (d.program !== undefined) assign('program', d.program);
  if (d.level !== undefined) assign('level', d.level);
  if (d.email !== undefined) assign('email', d.email);
  if (d.schoolId !== undefined) assign('school_id', d.schoolId);
  if (d.phone !== undefined) assign('phone', d.phone || '—');
  if (d.validUntil !== undefined) assign('valid_until', d.validUntil);

  let enrolled = !!old.face_enrolled;
  if (d.faceDescriptor === null) {            // remove face
    enrolled = false;
    assign('face_enrolled', 0); assign('face_descriptor', null); assign('face_photo', null);
  } else if (Array.isArray(d.faceDescriptor)) { // enroll / replace
    enrolled = true;
    assign('face_enrolled', 1); assign('face_descriptor', JSON.stringify(d.faceDescriptor));
  }
  if (d.facePhoto !== undefined && d.faceDescriptor !== null) assign('face_photo', d.facePhoto);

  if (set.length) await pool.query(`UPDATE students SET ${set.join(', ')} WHERE id = ?`, [...args, id]);
  const row = await getRow(pool, id);

  const validUntilChanged = d.validUntil !== undefined && d.validUntil !== old.valid_until;
  const faceEnrollmentChanged = enrolled !== !!old.face_enrolled;
  let note = '';
  if (validUntilChanged) note += ` Your discount is now valid until ${row.valid_until}.`;
  if (faceEnrollmentChanged) note += enrolled ? ' Face verification has been enrolled for boarding checks.' : ' Face verification has been removed from your pass.';
  await sendEmail(pool, row, 'Your TransitPass details were updated',
    `Hi ${row.name}, your registrar just updated your TransitPass profile details.${note} If anything looks wrong, contact your school registrar.`);
  return ser.student(row);
}

/* Registrar actions. `guard` returns an error message when the action isn't valid for the current state
   (the UI only offers valid ones, so this protects against stale screens and direct API calls). */
const dv = () => config.fare.defaultValidity;
const ACTIONS = {
  reinstate: {
    guard: (s) => (s.status !== 'flagged' ? 'Only flagged passes can be reinstated' : null),
    set: () => ({ status: 'active', valid_until: dv() }),
    subject: 'Your TransitPass has been reinstated',
    body: (s) => `Hi ${s.name}, your discount pass (School ID ${s.school_id}) is now active and valid until ${dv()}.`
  },
  flag: {
    guard: (s) => (s.status !== 'active' ? 'Only active passes can be flagged' : null),
    set: () => ({ status: 'flagged', valid_until: 'Under review' }),
    subject: 'Your TransitPass has been flagged for review',
    body: (s) => `Hi ${s.name}, unusual activity was detected on your pass (School ID ${s.school_id}) and it has been flagged for registrar review. Full fare will apply until this is resolved.`
  },
  revoke: {
    guard: (s) => (s.status === 'expired' ? 'Pass is already revoked/expired' : null),
    set: () => ({ status: 'expired' }),
    subject: 'Your TransitPass has been revoked',
    body: (s) => `Hi ${s.name}, your discount pass (School ID ${s.school_id}) has been revoked by the registrar. Contact your school registrar for details.`
  },
  'mark-eligible': {
    guard: (s) => (s.discount_eligible ? 'Discount is already active' : null),
    set: () => ({ discount_eligible: 1 }),
    subject: 'Your transportation discount is active',
    body: (s) => `Hi ${s.name}, the registrar has marked your pass (School ID ${s.school_id}) as eligible for the transportation discount. Present your QR code to claim the reduced fare.`
  },
  'mark-ineligible': {
    guard: (s) => (!s.discount_eligible ? 'Discount is already deactivated' : null),
    set: () => ({ discount_eligible: 0 }),
    subject: 'Your transportation discount status has changed',
    body: (s) => `Hi ${s.name}, the registrar has marked your pass (School ID ${s.school_id}) as not eligible for the transportation discount. Full fare will apply until this is reviewed.`
  },
  'set-validity': {
    guard: (s, p) => (!p.validUntil ? 'validUntil is required' : null),
    set: (s, p) => ({ valid_until: p.validUntil }),
    subject: 'Your transportation discount validity date was updated',
    body: (s, p) => `Hi ${s.name}, the registrar updated your discount pass (School ID ${s.school_id}) validity date. Your pass is now valid until ${p.validUntil}.`
  }
};

// Actions that touch verification or QR codes live in their own services so every path (admin menu, verifications page, API) behaves the same.
const DELEGATED = ['approve', 'reject', 'activate-qr', 'deactivate-qr', 'regenerate-qr'];

async function act(pool, id, action, payload = {}, admin = null) {
  if (DELEGATED.includes(action)) {
    if (!admin) throw conflict('This action needs a signed-in administrator');
    const actor = { type: 'admin', id: admin.id, name: admin.name };
    if (action === 'approve') return verification.approve(pool, id, admin, payload.note);
    if (action === 'reject') return verification.reject(pool, id, admin, payload.reason || 'Not confirmed as an enrolled student');
    if (action === 'regenerate-qr') await qrService.issue(pool, id, actor, { replace: true });
    else if (action === 'deactivate-qr') {
      const live = await qrService.currentFor(pool, id);
      if (!live) throw conflict('There is no active QR code to deactivate');
      await qrService.revoke(pool, live.id, actor, payload.reason);
    } else {
      // activate-qr: bring back the most recent revoked, unexpired code
      const [rows] = await pool.query("SELECT id FROM qr_codes WHERE student_id = ? AND status = 'revoked' AND expires_at > ? ORDER BY revoked_at DESC LIMIT 1", [id, new Date()]);
      if (!rows[0]) throw conflict('No revoked QR code can be reactivated. Use Regenerate QR to issue a new one.');
      await qrService.reactivate(pool, rows[0].id, actor);
    }
    return get(pool, id);
  }
  const def = ACTIONS[action];
  if (!def) throw notFound(`Unknown action: ${action}`);
  const row = await withTransaction(pool, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM students WHERE id = ? FOR UPDATE', [id]);
    const s = rows[0];
    if (!s) throw notFound('Student not found');
    const problem = def.guard(s, payload);
    if (problem) throw conflict(problem);
    const changes = def.set(s, payload);
    const cols = Object.keys(changes);
    await conn.query(`UPDATE students SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => changes[c]), id]);
    const [after] = await conn.query('SELECT * FROM students WHERE id = ?', [id]);
    return { before: s, after: after[0] };
  });
  await sendEmail(pool, row.after, def.subject, def.body(row.after, payload));
  return ser.student(row.after);
}

async function remove(pool, id) {
  const [res] = await pool.query('DELETE FROM students WHERE id = ?', [id]);
  if (!res.affectedRows) throw notFound('Student not found');
}

async function emailQr(pool, id) {
  const s = await getRow(pool, id);
  await sendEmail(pool, s, 'Your TransitPass QR code',
    `Hi ${s.name}, attached is your TransitPass QR code (School ID ${s.school_id}). Present it at the turnstile or to the conductor to claim your fare discount.`);
}

/** The student's live QR payload (random token, no personal data) for the admin's View / Download QR. */
async function qrPayload(pool, id) {
  const s = await getRow(pool, id);
  const live = await qrService.currentFor(pool, id);
  return { payload: live ? qrService.payloadOf(live) : null, qrActive: !!live, qrVersion: s.qr_version, schoolId: s.school_id,
    generatedAt: live ? live.generated_at.toISOString() : null, expiresAt: live ? live.expires_at.toISOString() : null };
}

async function scansFor(pool, id, { limit, offset }) {
  await getRow(pool, id);
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM scans WHERE student_id = ?', [id]);
  const [rows] = await pool.query(
    'SELECT * FROM scans WHERE student_id = ? ORDER BY scanned_at DESC, id DESC LIMIT ? OFFSET ?', [id, limit, offset]);
  return { items: rows.map(ser.scan), total };
}

module.exports = { list, stats, get, create, update, act, remove, emailQr, qrPayload, scansFor, ACTION_NAMES: [...Object.keys(ACTIONS), ...DELEGATED] };
