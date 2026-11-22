'use strict';
const { badRequest } = require('../lib/httpError');

/** Parses req[source] with a zod schema; result lands in req.valid[source] (Express 5 makes req.query read-only). */
const validate = (schema, source = 'body') => (req, res, next) => {
  const r = schema.safeParse(req[source] ?? {});
  if (!r.success) {
    throw badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  req.valid = req.valid || {};
  req.valid[source] = r.data;
  next();
};

module.exports = { validate };
