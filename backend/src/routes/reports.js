'use strict';
const express = require('express');
const { validate } = require('../middleware/validate');
const { notFound } = require('../lib/httpError');
const schemas = require('../schemas');
const reports = require('../services/reports');
const ser = require('../lib/serialize');

/** Dashboard, scan history, notification log, weekly volume and the operator ledger. */
module.exports = function reportRoutes(pool) {
  const r = express.Router();

  r.get('/dashboard', async (req, res) => {
    const [k, feed] = await Promise.all([reports.kpis(pool), reports.feed(pool, 10)]);
    res.json({ kpis: k.kpis, raw: k.raw, asOf: k.asOf, feed });
  });
  r.get('/scans', validate(schemas.scanList, 'query'), async (req, res) => res.json(await reports.listScans(pool, req.valid.query)));
  r.get('/scans/daily', validate(schemas.dailyQuery, 'query'), async (req, res) => res.json({ days: await reports.daily(pool, req.valid.query) }));
  r.get('/scans/feed', validate(schemas.feedQuery, 'query'), async (req, res) => res.json({ items: await reports.feed(pool, req.valid.query.limit) }));
  r.get('/emails', validate(schemas.emailList, 'query'), async (req, res) => res.json(await reports.listEmails(pool, req.valid.query)));
  r.get('/reports/weekly', async (req, res) => res.json({ days: await reports.weekly(pool) }));

  r.get('/operators', async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM operators ORDER BY name');
    res.json({ items: rows.map(ser.operator) });
  });
  r.post('/operators', validate(schemas.operatorCreate), async (req, res) => {
    const d = req.valid.body;
    const [ins] = await pool.query('INSERT INTO operators (name, trips, discount_amount, status) VALUES (?, ?, ?, ?)', [d.name, d.trips, d.discount, d.status]);
    const [rows] = await pool.query('SELECT * FROM operators WHERE id = ?', [ins.insertId]);
    res.status(201).json({ operator: ser.operator(rows[0]) });
  });
  r.patch('/operators/:id', validate(schemas.operatorUpdate), async (req, res) => {
    const d = req.valid.body;
    const map = { name: 'name', trips: 'trips', discount: 'discount_amount', status: 'status' };
    const cols = Object.keys(d).filter((k) => map[k]);
    await pool.query(`UPDATE operators SET ${cols.map((c) => `${map[c]} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => d[c]), req.params.id]);
    const [rows] = await pool.query('SELECT * FROM operators WHERE id = ?', [req.params.id]);
    if (!rows[0]) throw notFound('Operator not found');
    res.json({ operator: ser.operator(rows[0]) });
  });
  r.delete('/operators/:id', async (req, res) => {
    const [d] = await pool.query('DELETE FROM operators WHERE id = ?', [req.params.id]);
    if (!d.affectedRows) throw notFound('Operator not found');
    res.status(204).end();
  });

  return r;
};
