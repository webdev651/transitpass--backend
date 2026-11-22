'use strict';
// Background jobs (started by server.js only, never in tests). Every job is wrapped so one failure cannot stop the others.
const announcements = require('./announcements');
const notifications = require('./notifications');
const suspicious = require('./suspicious');
const driverDocs = require('./driverDocs');
const backups = require('./backups');

function start(pool) {
  const safe = (name, fn) => async () => { try { await fn(); } catch (e) { console.error(`[scheduler] ${name} failed:`, e.message); } };
  const timers = [
    setInterval(safe('announcements', () => announcements.publishDue(pool)), 30 * 1000),
    setInterval(safe('backups', () => backups.tick(pool)), 60 * 1000),
    setInterval(safe('suspicious', () => suspicious.detect(pool)), 5 * 60 * 1000),
    setInterval(safe('expiry reminders', async () => { await notifications.expireAndNotify(pool); await notifications.generateExpiryNotifications(pool); await driverDocs.notifyExpiring(pool); }), 60 * 60 * 1000)
  ];
  timers.forEach((t) => t.unref());
  return () => timers.forEach(clearInterval);
}
module.exports = { start };
