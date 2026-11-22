'use strict';
// You do NOT need this to sign in: `npm start` creates the first administrator account by itself.
// npm run seed        -> administrator account (if missing) + operator ledger (idempotent)
// npm run seed:demo   -> also loads the demo students, scan history and notifications from the prototype
const bcrypt = require('bcryptjs');
const { ensureDriver } = require('../src/lib/ensureDriver');
const config = require('../src/config');
const { createPool } = require('../src/db');
const { tzOffsetMinutes } = require('../src/lib/time');
const { round2 } = require('../src/lib/fare');

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** "05 Aug 2026" + "07:36:44" in the app timezone -> UTC Date */
function localToUtc(dateStr, timeStr) {
  const [d, mon, y] = dateStr.split(' ');
  const [h, mi, s] = timeStr.split(':').map(Number);
  const guess = Date.UTC(+y, MONTHS[mon], +d, h, mi, s);
  return new Date(guess - tzOffsetMinutes(new Date(guess)) * 60000);
}
const peso = (t) => Number(String(t).replace(/[^0-9.]/g, '')) || 0;

const OPERATORS = [
  ['Metro Bus Consortium', 48220, 612400, 'Cleared'],
  ['LRT Line 1 Authority', 31905, 402180, 'Cleared'],
  ['LRT Line 2 Authority', 22640, 281050, 'For review'],
  ['Provincial UV Express', 9410, 118900, 'Pending docs']
];

const STUDENTS = [
  ['STD-2026-04182', '2023-1182', 'Alonzo M. Reyes', 'Pamantasan ng Lungsod Central', 'BS Information Technology', '3rd Year', 'active', '31 Mar 2027', 148, 'alonzo.reyes@student.plc.edu.ph', '0917 214 5590'],
  ['STD-2026-04183', '2024-0592', 'Bianca L. Soriano', 'St. Andrew Senior High', 'STEM Strand', 'Grade 12', 'active', '31 Mar 2027', 92, 'bianca.soriano@student.sash.edu.ph', '0918 445 2201'],
  ['STD-2026-04184', '2025-0184', 'Cristian D. Villamor', 'Metro Polytechnic Institute', 'Dip. Mechanical Tech', '2nd Year', 'pending', 'Awaiting registrar', 0, 'cristian.villamor@student.mpi.edu.ph', '0921 330 9042'],
  ['STD-2025-03910', '2021-0910', 'Dianne P. Aguilar', 'Pamantasan ng Lungsod Central', 'BS Accountancy', 'Graduated', 'expired', '31 Mar 2026', 613, 'dianne.aguilar@student.plc.edu.ph', '0915 667 1183', false],
  ['STD-2026-04121', '2025-0121', 'Emilio R. Tanada', 'St. Andrew Senior High', 'ABM Strand', 'Grade 11', 'flagged', 'Under review', 41, 'emilio.tanada@student.sash.edu.ph', '0928 774 6635']
];

// [schoolId, date, time, route, operator, fare, result, reason]
const SCANS = [
  ['2023-1182', '05 Aug 2026', '07:36:44', 'LRT-2 Recto', 'Turnstile B-1', '₱11.00 (−20%)', 'granted'],
  ['2023-1182', '04 Aug 2026', '17:12:03', 'Cubao — Lawton', 'Bus 118 · Unit 4', '₱13.00 (−20%)', 'granted'],
  ['2023-1182', '04 Aug 2026', '07:41:09', 'LRT-2 Recto', 'Turnstile B-1', '₱11.00 (−20%)', 'granted'],
  ['2023-1182', '01 Aug 2026', '18:02:37', 'Ayala — Fairview', 'Bus 077 · Unit 1', '₱14.00 (−20%)', 'granted'],
  ['2023-1182', '29 Jul 2026', '07:38:51', 'LRT-2 Recto', 'Turnstile B-1', '₱11.00 (−20%)', 'granted'],
  ['2023-1182', '27 Jul 2026', '08:10:22', 'Cubao — Lawton', 'Bus 118 · Unit 4', 'Full fare', 'review', '3 scans in 4 minutes — possible pass sharing'],
  ['2024-0592', '05 Aug 2026', '07:41:58', 'LRT-1 Monumento', 'Turnstile G-2', '₱12.00 (−20%)', 'granted'],
  ['2024-0592', '04 Aug 2026', '16:48:15', 'LRT-1 Monumento', 'Turnstile G-2', '₱12.00 (−20%)', 'granted'],
  ['2024-0592', '03 Aug 2026', '07:39:40', 'LRT-1 Monumento', 'Turnstile G-2', '₱12.00 (−20%)', 'granted'],
  ['2024-0592', '31 Jul 2026', '17:55:02', 'LRT-1 Monumento', 'Turnstile G-2', '₱12.00 (−20%)', 'granted'],
  ['2021-0910', '05 Aug 2026', '07:38:07', 'Ayala — Fairview', 'Bus 077 · Unit 1', 'Full fare', 'denied', 'Pass expired 31 Mar 2026'],
  ['2021-0910', '02 Aug 2026', '08:14:29', 'Ayala — Fairview', 'Bus 077 · Unit 1', 'Full fare', 'denied', 'Pass expired 31 Mar 2026'],
  ['2021-0910', '15 Mar 2026', '07:50:18', 'Ayala — Fairview', 'Bus 077 · Unit 1', '₱14.00 (−20%)', 'granted'],
  ['2025-0121', '05 Aug 2026', '07:40:22', 'Cubao — Lawton', 'Bus 118 · Unit 4', 'Full fare', 'review', '3 scans in 4 minutes — possible pass sharing'],
  ['2025-0121', '04 Aug 2026', '07:44:11', 'Cubao — Lawton', 'Bus 118 · Unit 4', '₱13.00 (−20%)', 'granted'],
  ['2025-0121', '03 Aug 2026', '07:37:52', 'Cubao — Lawton', 'Bus 118 · Unit 4', '₱13.00 (−20%)', 'granted']
];

const EMAILS = [
  ['alonzo.reyes@student.plc.edu.ph', 'Alonzo M. Reyes', '2023-1182', 'Your TransitPass has been approved', 'Hi Alonzo M. Reyes, your discount pass (School ID 2023-1182) is now active and valid until 31 Mar 2027.', '31 Mar 2026', '09:12:04'],
  ['emilio.tanada@student.sash.edu.ph', 'Emilio R. Tanada', '2025-0121', 'Your TransitPass has been flagged for review', 'Hi Emilio R. Tanada, unusual activity was detected on your pass (School ID 2025-0121) and it has been flagged for registrar review. Full fare will apply until resolved.', '05 Aug 2026', '07:40:23']
];

async function seed({ demo = false, pool = createPool(), quiet = false } = {}) {
  const log = (m) => { if (!quiet) console.log(m); };
  await ensureDriver(pool, log);

  const [[{ n: opCount }]] = await pool.query('SELECT COUNT(*) AS n FROM operators');
  if (!opCount) {
    await pool.query('INSERT IGNORE INTO operators (name, trips, discount_amount, status) VALUES ?', [OPERATORS]);
    log(`Inserted ${OPERATORS.length} operators.`);
  }

  if (demo) {
    const [[{ n: stCount }]] = await pool.query('SELECT COUNT(*) AS n FROM students');
    if (stCount) { log('Students already present — skipping demo data.'); }
    else {
      // Demo students all share one password (STUDENT_DEMO_PASSWORD, default student1234) so you can try the student login.
      const demoHash = config.seedStudentPassword ? await bcrypt.hash(config.seedStudentPassword, 12) : null;
      for (const [id, schoolId, name, school, program, level, status, validUntil, scans, email, phone, eligible] of STUDENTS) {
        await pool.query(
          `INSERT INTO students (id, school_id, name, school, program, level, status, valid_until, scans, email, phone, discount_eligible, password_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, schoolId, name, school, program, level, status, validUntil, scans, email, phone, eligible === false ? 0 : 1, demoHash]);
      }
      // Same rule as the migration: approved demo students count as verified, pending ones stay pending.
      await pool.query(`INSERT IGNORE INTO student_verifications (student_id, verification_status, method, verification_date, note)
        SELECT id, IF(status = 'pending', 'pending', 'verified'), IF(status = 'pending', 'admin_review', 'legacy'),
               IF(status = 'pending', NULL, UTC_TIMESTAMP(3)), IF(status = 'pending', NULL, 'Demo data') FROM students`);
      const [students] = await pool.query('SELECT id, name, school_id FROM students');
      const bySchool = Object.fromEntries(students.map((s) => [s.school_id, s]));
      for (const [schoolId, date, time, route, operator, fare, result, reason] of SCANS) {
        const s = bySchool[schoolId];
        const discounted = fare.includes('(−');
        const amount = discounted ? peso(fare) : config.fare.full;
        await pool.query(
          `INSERT INTO scans (student_id, student_name, school_id, route, operator, fare, fare_amount, discount_amount, result, reason, scanned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [s.id, s.name, schoolId, route, operator, fare, amount, discounted ? round2(amount * config.fare.discountRate / (1 - config.fare.discountRate)) : 0,
            result, reason || null, localToUtc(date, time)]);
      }
      await pool.query("UPDATE scans SET verification_result = IF(result = 'granted', 'VERIFIED_STUDENT', 'FLAGGED_REVIEW') WHERE verification_result IS NULL AND result IN ('granted', 'review')");
      for (const [to, name, schoolId, subject, bodyText, date, time] of EMAILS) {
        const s = bySchool[schoolId];
        await pool.query(
          'INSERT INTO email_log (student_id, to_email, student_name, school_id, subject, body, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [s.id, to, name, schoolId, subject, bodyText, localToUtc(date, time)]);
      }
      log(`Inserted demo data: ${STUDENTS.length} students, ${SCANS.length} scans, ${EMAILS.length} notifications.`);
    }
  }
  return pool;
}

module.exports = { seed };
if (require.main === module) {
  seed({ demo: process.argv.includes('--demo') })
    .then((pool) => pool.end())
    .catch((e) => { console.error(e.message); process.exit(1); });
}
