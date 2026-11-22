'use strict';
const config = require('../config');
const { HttpError } = require('../lib/httpError');

const DUP_MESSAGES = [
  ['uq_students_email', 'An account with that email already exists.'],
  ['uq_students_school_id', 'An account with that School ID already exists.'],
  ['uq_admins_username', 'That username is already taken.'],
  ['uq_admins_email', 'That email is already used by another staff account.'],
  ['uq_operators_name', 'An operator with that name already exists.']
];

function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl.split('?')[0]}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err.name === 'MulterError') { // file upload limits (student portal)
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Unexpected file field.' : 'The upload could not be read.';
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
  }
  if (err.code === 'ER_DUP_ENTRY') {
    const hit = DUP_MESSAGES.find(([key]) => (err.sqlMessage || '').includes(key));
    return res.status(409).json({ error: hit ? hit[1] : 'That record already exists.' });
  }
  if (!config.isTest) console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { notFoundHandler, errorHandler };
