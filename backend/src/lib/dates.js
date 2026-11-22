'use strict';
// Calendar-date helpers in the application's time zone (APP_TIMEZONE, default Asia/Manila).
const { localParts, tzOffsetMinutes } = require('./time');

const pad = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' for today (or today + offsetDays) in the app time zone. */
function todayYmd(offsetDays = 0, now = new Date()) {
  const p = localParts(now);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day) + offsetDays * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** True for a real calendar date written YYYY-MM-DD (rejects 2026-02-31). */
function isRealDate(s) {
  if (!YMD.test(String(s))) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
/** UTC instant at which a local calendar day (YYYY-MM-DD) starts / the next one starts. */
function dayStartUtc(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return new Date(guess - tzOffsetMinutes(new Date(guess + 12 * 3600000)) * 60000);
}
module.exports = { todayYmd, isRealDate, dayStartUtc, YMD };
