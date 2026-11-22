'use strict';
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const S = require('../schemas.admin');
const reports = require('../services/reports');
const driverDocs = require('../services/driverDocs');
const driverPortal = require('../services/driverPortal');
const { audit } = require('../lib/audit');
const { notFound } = require('../lib/httpError');
const ser = require('../lib/serialize');

const one = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.uploads.maxDocBytes, files: 1, fields: 8, fieldSize: 10 * 1024 } }).single('file');
const FILE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' };
const pid = (req, name = 'id') => { if (!/^\d{1,12}$/.test(req.params[name])) throw notFound('Not found'); return Number(req.params[name]); };

/**
 * The signed-in driver's own dashboard data. Mounted behind requireAuth + requireRole('driver').
 * Every query is pinned to req.admin.id, so a driver can never read another driver's scans, documents or transactions
 * (a driverId in the URL, query or body is ignored; another driver's document id answers 404).
 */
module.exports = function driverRoutes(pool) {
  const r = express.Router();
  r.get('/me', async (req, res) => res.json({ driver: ser.admin(req.admin), stats: await reports.driverStats(pool, req.admin.id) }));
  r.get('/stats', async (req, res) => res.json(await reports.driverStats(pool, req.admin.id)));
  r.get('/scans', validate(schemas.scanList, 'query'), async (req, res) =>
    res.json(await reports.listScans(pool, { ...req.valid.query, driverId: req.admin.id })));
  r.get('/scans/daily', validate(schemas.dailyQuery, 'query'), async (req, res) =>
    res.json({ days: await reports.daily(pool, { days: req.valid.query.days, driverId: req.admin.id }) }));

  // Dashboard: numbers, last 7 days, assigned service, document status, notifications and fare totals in one call.
  r.get('/dashboard', async (req, res) => res.json(await driverPortal.dashboard(pool, req.admin)));

  // Assigned transportation service: vehicle, routes and trips.
  r.get('/service', validate(S.driverTripList, 'query'), async (req, res) =>
    res.json(await driverPortal.service(pool, req.admin.id, { tripLimit: req.valid.query.limit })));

  // Transaction history (the rides this driver scanned, with fares, discounts and cancelled / refunded status).
  r.get('/transactions', validate(S.driverTxnList, 'query'), async (req, res) =>
    res.json(await driverPortal.ownTransactions(pool, req.admin.id, req.valid.query)));

  // Documents: list, upload / replace, preview. Files are private: only their owner can open them.
  const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `drvdoc:${req.admin.id}`,
    skip: () => config.isTest && !process.env.TEST_RATE_LIMIT,
    message: { error: 'Too many uploads. Try again later.' }
  });
  r.get('/documents', async (req, res) => res.json(await driverDocs.listOwn(pool, req.admin.id)));
  r.post('/documents', uploadLimiter, one, validate(S.driverDocUpload), async (req, res) => {
    const doc = await driverDocs.uploadOwn(pool, req.admin, req.valid.body, req.file);
    await audit(pool, req, 'driver', 'driver.document.upload', `Driver uploaded their ${doc.typeLabel.toLowerCase()} (waiting for review)`, doc.id);
    res.status(201).json({ document: doc });
  });
  r.get('/documents/:id/file', async (req, res) => {
    const f = await driverDocs.fileOwn(pool, req.admin.id, pid(req));
    res.set({ ...FILE_HEADERS, 'Content-Type': f.mime, 'Content-Disposition': 'inline' });
    res.sendFile(f.abs);
  });
  return r;
};
