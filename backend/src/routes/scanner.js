'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const scanner = require('../services/scanner');

/**
 * Passenger verification. Mounted behind requireAuth + requireRole('driver', 'admin').
 * Every attempt is logged with the authenticated account that made it; the result is always HTTP 200 with a `code`.
 */
module.exports = function scannerRoutes(pool) {
  const r = express.Router();
  // Per account, not per IP: many drivers can share one bus-station network. Stops token guessing and runaway scripts.
  r.use(rateLimit({
    windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `staff-${req.admin.id}`, validate: { keyGeneratorIpFallback: false },
    skip: () => config.isTest && !process.env.TEST_RATE_LIMIT,
    message: { error: 'Scanning too fast. Wait a moment and try again.' }
  }));
  r.post('/scan', validate(schemas.scannerScan), async (req, res) => res.json(await scanner.scanQr(pool, req.admin, req.valid.body)));
  r.post('/lookup', validate(schemas.scannerLookup), async (req, res) => res.json(await scanner.lookupSchoolId(pool, req.admin, req.valid.body)));
  // Checks a driver recorded while offline. Idempotent per device key; always 200 so the device knows which items to keep.
  r.post('/sync', validate(schemas.scannerSync), async (req, res) => res.json(await scanner.syncBatch(pool, req.admin, req.valid.body)));
  return r;
};
