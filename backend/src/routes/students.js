'use strict';
const express = require('express');
const { validate } = require('../middleware/validate');
const { notFound } = require('../lib/httpError');
const schemas = require('../schemas');
const students = require('../services/students');

module.exports = function studentRoutes(pool) {
  const r = express.Router();

  r.get('/', validate(schemas.studentList, 'query'), async (req, res) => res.json(await students.list(pool, req.valid.query)));
  r.get('/stats', async (req, res) => res.json(await students.stats(pool)));
  r.post('/', validate(schemas.studentCreate), async (req, res) => res.status(201).json({ student: await students.create(pool, { ...req.valid.body, verifiedBy: req.admin.id }) }));

  r.get('/:id', async (req, res) => res.json({ student: await students.get(pool, req.params.id) }));
  r.patch('/:id', validate(schemas.studentUpdate), async (req, res) => res.json({ student: await students.update(pool, req.params.id, req.valid.body) }));
  r.delete('/:id', async (req, res) => { await students.remove(pool, req.params.id); res.status(204).end(); });

  r.get('/:id/qr', async (req, res) => res.json(await students.qrPayload(pool, req.params.id)));
  r.post('/:id/email-qr', async (req, res) => { await students.emailQr(pool, req.params.id); res.json({ message: 'QR code email logged.' }); });
  r.get('/:id/scans', validate(schemas.page, 'query'), async (req, res) => res.json(await students.scansFor(pool, req.params.id, req.valid.query)));

  // POST /api/students/:id/actions/:action — approve | reject | reinstate | flag | revoke | activate-qr | deactivate-qr |
  //                                          regenerate-qr | mark-eligible | mark-ineligible | set-validity
  r.post('/:id/actions/:action', validate(schemas.studentAction), async (req, res) => {
    if (!students.ACTION_NAMES.includes(req.params.action)) throw notFound(`Unknown action: ${req.params.action}`);
    res.json({ student: await students.act(pool, req.params.id, req.params.action, req.valid.body, req.admin) });
  });

  return r;
};
