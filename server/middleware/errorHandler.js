'use strict';

/**
 * Error handling + 404.
 *
 * Application errors expose a stable machine readable `code` and a safe
 * message. Unexpected errors are logged with their stack but reported to the
 * client as a generic 500 (no internals leak in production).
 */

const config = require('../config');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

const log = logger.child('http');

function notFound(req, _res, next) {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const isAppError = Boolean(err && err.isAppError);
  const status = isAppError ? err.status : err && err.status ? err.status : 500;

  // body parser / malformed JSON
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
  }

  if (!isAppError || status >= 500) {
    log.error('request failed', {
      method: req.method,
      url: req.originalUrl,
      status,
      code: err && err.code,
      message: err && err.message,
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : null,
    });
  } else {
    log.debug('request rejected', { method: req.method, url: req.originalUrl, status, code: err.code, message: err.message });
  }

  const expose = isAppError ? err.expose !== false : !config.isProduction;
  const body = {
    ok: false,
    error: {
      code: (isAppError && err.code) || (err && err.code) || 'INTERNAL_ERROR',
      message: expose ? err.message || 'Request failed' : 'Internal server error',
    },
  };
  if (expose && err && err.details) body.error.details = err.details;
  if (!config.isProduction && err && err.stack) body.error.stack = String(err.stack).split('\n').slice(0, 8);

  if (res.headersSent) return;
  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
