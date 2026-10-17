'use strict';

/** Rate limiting. Every limiter answers with the same JSON error envelope. */

const rateLimit = require('express-rate-limit');
const config = require('../config');
const logger = require('../utils/logger');

const log = logger.child('ratelimit');

function handlerFactory(name) {
  return (req, res, _next, options) => {
    log.warn('rate limit hit', { limiter: name, ip: req.ip, path: req.originalUrl });
    res.status(options.statusCode).json({
      ok: false,
      error: {
        code: 'RATE_LIMITED',
        message:
          name === 'auth'
            ? 'Too many login attempts. Please try again later.'
            : name === 'generate'
              ? 'Ticket generation is rate limited. Please wait before generating again.'
              : 'Too many requests. Please slow down.',
        retryAfterSeconds: Math.ceil((options.windowMs || config.security.rateLimitWindowMs) / 1000),
      },
    });
  };
}

const common = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  windowMs: config.security.rateLimitWindowMs,
};

/** Public API traffic. */
const apiLimiter = rateLimit({
  ...common,
  limit: config.security.rateLimitMax,
  handler: handlerFactory('api'),
});

/** Login / register endpoints: brute force protection. */
const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: config.security.authRateLimitMax,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}:${String((req.body && (req.body.login || req.body.email)) || '').toLowerCase()}`,
  handler: handlerFactory('auth'),
});

/** Admin dashboard traffic. */
const adminLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: config.security.adminRateLimitMax,
  handler: handlerFactory('admin'),
});

/** Ticket generation: expensive, must stay rare. */
const generateLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: config.security.generateRateLimitMax,
  handler: handlerFactory('generate'),
});

module.exports = { apiLimiter, authLimiter, adminLimiter, generateLimiter };
