'use strict';
/*
  Administrator activity logging + the "Recent system activities" feed.

  Two kinds of records feed the dashboard, and they never overlap:
   1. activity_logs      what STAFF did: sign in / out, failed sign-ins, and every change an administrator makes
                         (written by the activityLogger middleware below and by routes/auth.js).
   2. existing tables    what happened WITHOUT an administrator: students registering online, students generating
                         their own QR code, drivers registering, and transactions (scans).
*/
const { toDate } = require('../lib/time');
const { txnReference } = require('../lib/studentStatus');

const cut = (s, n) => String(s ?? '').slice(0, n);

// Log writes that were started when a response finished but have not been committed yet. The feed waits for them, so an
// administrator (or a test) that reads the activity list right after an action - including a refused one - always sees it.
const pending = new Set();
const track = (p) => { pending.add(p); const done = () => pending.delete(p); p.then(done, done); return p; };

/** Writes one log row. Never throws: a logging problem must not break the action being logged. */
async function log(pool, { admin = null, name, role, category, action, description, targetId = null, status = 'success', ip = null }) {
  try {
    await pool.query(
      `INSERT INTO activity_logs (admin_id, actor_name, actor_role, category, action, description, target_id, status, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [admin ? admin.id : null, cut(name || (admin && admin.name) || 'Unknown', 120), role || (admin && admin.role) || 'admin',
        category, cut(action, 60), cut(description, 255), targetId ? cut(targetId, 64) : null, status, ip ? cut(ip, 45) : null]);
  } catch (e) {
    console.error('[activity] could not write log:', e.message);
  }
}

/* ---------- describing admin API calls in plain words ---------- */

const STUDENT_ACTIONS = {
  approve: ['verification', 'Approved student'], reject: ['verification', 'Rejected student'], reinstate: ['student', 'Reinstated student'],
  flag: ['student', 'Flagged for review:'], revoke: ['student', 'Revoked pass of'], 'activate-qr': ['qr', 'Activated QR code of'],
  'deactivate-qr': ['qr', 'Deactivated QR code of'], 'regenerate-qr': ['qr', 'Regenerated QR code for'],
  'mark-eligible': ['student', 'Marked eligible for the discount:'], 'mark-ineligible': ['student', 'Marked not eligible for the discount:'],
  'set-validity': ['student', 'Updated discount validity of']
};
const DRIVER_ACTIONS = { approve: 'Approved driver', activate: 'Activated driver', deactivate: 'Deactivated driver' };

// [method, path pattern, kind of thing the id points to, builder(ids, target, req) -> [category, action, description]]
const RULES = [
  ['POST', /^\/students$/, null, (m, t, req) => ['student', 'student.create', `Registered student ${cut(req.body && req.body.name, 80) || 'record'}`]],
  ['PATCH', /^\/students\/([^/]+)$/, 'student', (m, t) => ['student', 'student.update', `Updated student record: ${t}`]],
  ['DELETE', /^\/students\/([^/]+)$/, 'student', (m, t) => ['student', 'student.delete', `Deleted student record: ${t}`]],
  ['POST', /^\/students\/([^/]+)\/email-qr$/, 'student', (m, t) => ['qr', 'qr.email', `Emailed QR code to ${t}`]],
  ['POST', /^\/students\/([^/]+)\/actions\/([^/]+)$/, 'student', (m, t) => {
    const [cat, text] = STUDENT_ACTIONS[m[2]] || ['student', `Ran "${cut(m[2], 30)}" on`];
    return [cat, `student.${m[2]}`.slice(0, 60), `${text} ${t}`];
  }],
  ['POST', /^\/admin\/verifications\/([^/]+)\/(approve|reject|reopen)$/, 'student', (m, t) =>
    ['verification', `verification.${m[2]}`, `${{ approve: 'Approved', reject: 'Rejected', reopen: 'Reopened the verification of' }[m[2]]} student ${t}`]],
  ['POST', /^\/admin\/verifications\/([^/]+)\/documents\/(id|enrollment)\/review$/, 'student', (m, t, req) =>
    ['verification', `document.${req.body && req.body.decision === 'rejected' ? 'reject' : 'verify'}`,
      `${req.body && req.body.decision === 'rejected' ? 'Rejected' : 'Verified'} the ${m[2] === 'id' ? 'student ID document' : 'enrollment document'} of ${t}`]],
  ['POST', /^\/admin\/correction-requests\/(\d+)\/(approve|reject)$/, 'request', (m, t) =>
    ['student', `correction.${m[2]}`, `${m[2] === 'approve' ? 'Approved' : 'Rejected'} information correction request: ${t}`]],
  ['POST', /^\/admin\/qr-codes\/(\d+)\/(revoke|reactivate)$/, 'qr', (m, t) => ['qr', `qr.${m[2]}`, `${m[2] === 'revoke' ? 'Deactivated' : 'Reactivated'} QR code of ${t}`]],
  ['POST', /^\/admin\/drivers$/, null, (m, t, req) => ['driver', 'driver.create', `Registered driver ${cut(req.body && req.body.name, 80) || 'account'}`]],
  ['PATCH', /^\/admin\/drivers\/([^/]+)$/, 'driver', (m, t) => ['driver', 'driver.update', `Updated driver ${t}`]],
  ['POST', /^\/admin\/drivers\/([^/]+)\/actions\/([^/]+)$/, 'driver', (m, t) => ['driver', `driver.${cut(m[2], 30)}`, `${DRIVER_ACTIONS[m[2]] || `Ran "${cut(m[2], 30)}" on driver`} ${t}`]],
  ['POST', /^\/admin\/drivers\/([^/]+)\/password$/, 'driver', (m, t) => ['driver', 'driver.password', `Reset the password of driver ${t}`]],
  // req.auditNote is set by the route when it knows more (which fields changed, why a change was refused)
  ['PATCH', /^\/admin\/account$/, null, (m, t, req) => ['account', 'account.update', req.auditNote || 'Updated own account details']],
  ['POST', /^\/admin\/account\/password$/, null, (m, t, req) => ['account', 'account.password', req.auditNote || 'Changed own password']],
  ['DELETE', /^\/admin\/account$/, null, (m, t, req) => ['account', 'account.delete_refused', req.auditNote || 'Refused: tried to delete the administrator account']],
  ['POST', /^\/admin\/account\/deactivate$/, null, (m, t, req) => ['account', 'account.deactivate_refused', req.auditNote || 'Refused: tried to deactivate the administrator account']],
  ['POST', /^\/operators$/, null, () => ['system', 'operator.create', 'Added a transport operator']],
  ['PATCH', /^\/operators\/[^/]+$/, null, () => ['system', 'operator.update', 'Updated a transport operator']],
  ['DELETE', /^\/operators\/[^/]+$/, null, () => ['system', 'operator.delete', 'Removed a transport operator']]
];

/** Finds the rule for a request, or null (not logged). */
function match(method, path) {
  for (const [m, re, kind, build] of RULES) {
    if (m !== method) continue;
    const found = re.exec(path);
    if (found) return { found, kind, build };
  }
  return null;
}

/** "Name (School ID)" for the student / driver / QR code the URL points to; falls back to the raw id. */
async function targetLabel(pool, kind, id) {
  if (!kind || !id) return id || '';
  try {
    if (kind === 'student') { const [r] = await pool.query('SELECT name, school_id FROM students WHERE id = ?', [id]); return r[0] ? `${r[0].name} (${r[0].school_id})` : id; }
    if (kind === 'driver') { const [r] = await pool.query("SELECT name FROM admins WHERE id = ? AND role = 'driver'", [id]); return r[0] ? r[0].name : `#${id}`; }
    if (kind === 'request') { const [r] = await pool.query('SELECT s.name, s.school_id, q.field_name FROM student_requests q JOIN students s ON s.id = q.student_id WHERE q.id = ?', [id]); return r[0] ? `${r[0].name} (${r[0].school_id}), ${r[0].field_name}` : `#${id}`; }
    if (kind === 'qr') { const [r] = await pool.query('SELECT s.name, s.school_id FROM qr_codes q JOIN students s ON s.id = q.student_id WHERE q.id = ?', [id]); return r[0] ? `${r[0].name} (${r[0].school_id})` : `#${id}`; }
  } catch (_) { /* fall through */ }
  return id;
}

/**
 * Express middleware (put it AFTER the auth guard). For every change made through the API (POST / PATCH / DELETE)
 * it writes a log row once the response is sent: success for 2xx/3xx, failed for 4xx/5xx (so refused attempts are
 * recorded too). Reading data (GET) is not logged.
 */
function activityLogger(pool) {
  return async (req, res, next) => {
    if (!['POST', 'PATCH', 'DELETE'].includes(req.method) || !req.admin) return next();
    const path = req.originalUrl.split('?')[0].replace(/^\/api/, '');
    const hit = match(req.method, path);
    if (!hit) return next();
    const admin = req.admin;
    const targetId = hit.kind ? hit.found[1] : null;
    const label = await targetLabel(pool, hit.kind, targetId);   // looked up BEFORE the change, so a delete still has a name
    let written = false;
    const write = (status) => {
      if (written) return Promise.resolve();
      written = true;
      if (status === 401) return Promise.resolve();
      const [category, action, description] = hit.build(hit.found, label, req);
      return log(pool, { admin, category, action, description, targetId, status: status < 400 ? 'success' : 'failed', ip: req.ip });
    };
    res.on('finish', () => { if (!written) track(write(res.statusCode)); });
    // JSON responses are logged before they leave, so the audit row already exists for anyone who reads the log right
    // after the action. Streams / sendFile still use the finish handler above.
    const json = res.json.bind(res);
    res.json = (body) => { write(res.statusCode).then(() => json(body), () => json(body)); return res; };
    next();
  };
}

/* ---------- the feed ---------- */

const REG_LABEL = { verified: 'Approved', rejected: 'Rejected', pending: 'Pending' };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Newest first, merged from activity_logs and the tables above.
 * Each item: { id, category, description, user, role, at, status, statusKey }.
 */
async function feed(pool, { limit = 10, offset = 0 } = {}) {
  if (pending.size) await Promise.allSettled([...pending]);   // let in-flight log writes land first
  const n = Math.min(limit + offset + 1, 200);
  const [logs] = await pool.query('SELECT * FROM activity_logs ORDER BY created_at DESC, id DESC LIMIT ?', [n]);
  const [regs] = await pool.query(
    `SELECT s.id, s.name, s.school_id, s.created_at, COALESCE(v.verification_status, 'pending') AS vs
       FROM students s LEFT JOIN student_verifications v ON v.student_id = s.id
      WHERE s.password_hash IS NOT NULL ORDER BY s.created_at DESC LIMIT ?`, [n]);
  const [qrs] = await pool.query(
    `SELECT q.id, q.generated_at, q.status, q.generated_by_name, s.school_id FROM qr_codes q JOIN students s ON s.id = q.student_id
      WHERE q.generated_by_type = 'student' ORDER BY q.generated_at DESC LIMIT ?`, [n]);
  const [drv] = await pool.query(
    "SELECT id, name, status, created_at FROM admins WHERE role = 'driver' AND created_by IS NULL ORDER BY created_at DESC LIMIT ?", [n]);
  const [scans] = await pool.query(
    `SELECT id, student_name, school_id, driver_name, result, scanned_at FROM scans WHERE result IN ('granted','review')
      ORDER BY scanned_at DESC, id DESC LIMIT ?`, [n]);

  const items = [
    ...logs.map((r) => ({ id: `log-${r.id}`, category: r.category, description: r.description, user: r.actor_name, role: r.actor_role, at: toDate(r.created_at), statusKey: r.status, status: cap(r.status) })),
    ...regs.map((r) => ({ id: `reg-${r.id}`, category: 'registration', description: `Student registered online: ${r.name} (${r.school_id})`, user: r.name, role: 'student', at: toDate(r.created_at), statusKey: r.vs, status: REG_LABEL[r.vs] })),
    ...qrs.map((r) => ({ id: `qr-${r.id}`, category: 'qr', description: `QR code generated for ${r.generated_by_name} (${r.school_id})`, user: r.generated_by_name, role: 'student', at: toDate(r.generated_at), statusKey: r.status, status: cap(r.status) })),
    ...drv.map((r) => ({ id: `drv-${r.id}`, category: 'driver', description: `Driver registered: ${r.name}`, user: r.name, role: 'driver', at: toDate(r.created_at), statusKey: r.status, status: cap(r.status) })),
    ...scans.map((r) => ({ id: `txn-${r.id}`, category: 'transaction', description: `Transaction ${txnReference(r.id)}${r.student_name ? ` for ${r.student_name}` : ''}`, user: r.driver_name || 'Scanner', role: 'driver', at: toDate(r.scanned_at), statusKey: r.result === 'granted' ? 'completed' : 'review', status: r.result === 'granted' ? 'Completed' : 'Under review' }))
  ].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));

  const page = items.slice(offset, offset + limit);
  return { items: page.map((i) => ({ ...i, at: i.at.toISOString() })), hasMore: items.length > offset + limit };
}

module.exports = { log, activityLogger, feed, flushPending: async () => { if (pending.size) await Promise.allSettled([...pending]); } };
