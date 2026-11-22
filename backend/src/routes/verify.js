'use strict';
const express = require('express');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const v = require('../services/verification');

/** Verification terminal. All outcomes (granted / review / denied / unknown) are HTTP 200 with a `result` field. */
module.exports = function verifyRoutes(pool) {
  const r = express.Router();
  r.post('/scan', validate(schemas.verifyScan), async (req, res) => res.json(await v.scanPass(pool, req.admin, req.valid.body)));
  r.post('/face', validate(schemas.verifyFace), async (req, res) => res.json(await v.verifyFace(pool, req.admin, req.valid.body)));
  r.post('/face-skip', validate(schemas.verifyFaceSkip), async (req, res) => res.json(await v.skipFace(pool, req.admin, req.valid.body)));
  r.post('/identify', validate(schemas.verifyIdentify), async (req, res) => res.json(await v.identify(pool, req.admin, req.valid.body)));
  return r;
};
