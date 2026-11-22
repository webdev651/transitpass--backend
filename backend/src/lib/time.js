'use strict';
const config = require('../config');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localParts(date, timeZone = config.timezone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** Offset (minutes) of timeZone from UTC at the given instant. */
function tzOffsetMinutes(date, timeZone = config.timezone) {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** The UTC instant at which the local calendar day containing `date` began. */
function startOfLocalDay(date, timeZone = config.timezone) {
  const off = tzOffsetMinutes(date, timeZone);
  const local = new Date(date.getTime() + off * 60000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - off * 60000);
}

const pad = (n) => String(n).padStart(2, '0');

/** Formats like the frontend's nowParts(): { day:"Thu", date:"06 Aug 2026", time:"14:23:07", dateWithDay } */
function displayParts(date, timeZone = config.timezone) {
  const p = localParts(date, timeZone);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const day = DAYS[dow];
  const d = `${pad(p.day)} ${MONTHS[p.month - 1]} ${p.year}`;
  return { day, date: d, time: `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`, dateWithDay: `${day}, ${d}` };
}

/** Converts a mysql2 DATETIME (returned as a Date because timezone:'Z') to a Date. */
const toDate = (v) => (v instanceof Date ? v : new Date(v));

module.exports = { tzOffsetMinutes, startOfLocalDay, displayParts, localParts, toDate, DAYS, MONTHS };
