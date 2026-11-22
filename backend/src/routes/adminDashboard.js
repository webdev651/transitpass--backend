'use strict';
const express = require('express');
const { validate } = require('../middleware/validate');
const { notFound } = require('../lib/httpError');
const schemas = require('../schemas');
const dash = require('../services/adminDashboard');
const activity = require('../services/activity');

/**
 * Administrator dashboard (administrators only; the guard + role check live in app.js).
 *   GET /api/admin/dashboard/summary        the seven statistic cards
 *   GET /api/admin/dashboard/charts         daily / weekly / monthly transactions + discount statistics
 *   GET /api/admin/dashboard/activities     recent system activities
 *   GET /api/admin/dashboard/transactions   recent transactions (search + pagination)
 *   GET /api/admin/dashboard/transactions/:id
 */
module.exports = function adminDashboardRoutes(pool) {
  const r = express.Router();
  r.get('/summary', async (req, res) => res.json(await dash.summary(pool)));
  r.get('/charts', async (req, res) => res.json(await dash.charts(pool)));
  r.get('/activities', validate(schemas.dashActivities, 'query'), async (req, res) => res.json(await activity.feed(pool, req.valid.query)));
  r.get('/transactions', validate(schemas.dashTransactions, 'query'), async (req, res) => res.json(await dash.transactions(pool, req.valid.query)));
  r.get('/transactions/:id', async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('Transaction not found');
    res.json({ transaction: await dash.transaction(pool, req.params.id) });
  });
  return r;
};
