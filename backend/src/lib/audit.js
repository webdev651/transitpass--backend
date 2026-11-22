'use strict';
// One-line audit trail for the admin modules: who (id + name), what, and which record. Never throws (see activity.log).
const activity = require('../services/activity');

/** audit(pool, req, 'vehicle', 'vehicle.create', 'Registered vehicle Bus 1', 12) */
const audit = (pool, req, category, action, description, targetId = null, status = 'success') =>
  activity.log(pool, { admin: req.admin, category, action, description, targetId: targetId == null ? null : String(targetId), status, ip: req.ip });

module.exports = { audit };
