'use strict';
const config = require('../config');

let transport = null;
function getTransport() {
  if (transport) return transport;
  const { host, port, user, pass } = config.email.smtp;
  if (!host) throw new Error('EMAIL_MODE=smtp requires SMTP_HOST');
  // Required lazily so log-only deployments never load it.
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: user ? { user, pass } : undefined });
  return transport;
}

/**
 * Records a notification for a student in email_log (always) and, when EMAIL_MODE=smtp,
 * delivers it in the background. Never throws into the calling request.
 * `db` must be the connection pool (not a transaction connection): the SMTP status update runs later.
 */
async function sendEmail(db, student, subject, body, { track = true } = {}) {
  if (!student || !student.email) return null;
  const smtp = config.email.mode === 'smtp';
  const [res] = await db.query(
    `INSERT INTO email_log (student_id, to_email, student_name, school_id, subject, body, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [student.id, student.email, student.name, student.school_id || student.schoolId, subject, body, 'logged']
  );
  const id = res.insertId;
  if (track) { // so the administrator's Notification History lists every message a student receives, whichever feature sent it
    const category = /expire/i.test(subject) ? (/qr/i.test(subject) ? 'qr_expiry' : 'eligibility_expiry') : /refund|transaction/i.test(subject) ? 'refund' : 'account_status';
    await db.query("INSERT INTO notifications (recipient_type, student_id, recipient_name, category, title, body, email_log_id) VALUES ('student', ?, ?, ?, ?, ?, ?)", [student.id, student.name, category, subject.slice(0, 200), body, id]).catch(() => {});
  }
  if (smtp) {
    getTransport().sendMail({ from: config.email.smtp.from, to: student.email, subject, text: body })
      .then(() => db.query('UPDATE email_log SET status = ? WHERE id = ?', ['sent', id]))
      .catch((err) => {
        console.error('[email] delivery failed:', err.message);
        return db.query('UPDATE email_log SET status = ? WHERE id = ?', ['failed', id]).catch(() => {});
      });
  }
  return id;
}

module.exports = { sendEmail };
