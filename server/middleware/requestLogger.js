'use strict';

/** Lightweight request logging (stdout only — no personal data beyond IP). */

const config = require('../config');
const logger = require('../utils/logger');

const log = logger.child('http');
const SKIP = new Set(['/health', '/api/health', '/favicon.ico']);

function requestLogger(req, res, next) {
  if (!config.logging.requestLogging || SKIP.has(req.path)) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const line = { method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(ms) };
    if (res.statusCode >= 500) log.error('request', line);
    else if (res.statusCode >= 400) log.warn('request', line);
    else log.debug('request', line);
  });
  return next();
}

module.exports = { requestLogger };
