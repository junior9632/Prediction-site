'use strict';

/**
 * Authentication middleware — JWT bearer tokens delivered through a secure
 * httpOnly cookie (browser) or an Authorization header (CLI / tooling).
 * The secret only ever exists in the server environment.
 */

const jwt = require('jsonwebtoken');
const config = require('../config');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

const log = logger.child('auth');

function readToken(req) {
  const cookieName = config.auth.cookieName;
  if (req.cookies && req.cookies[cookieName]) return { token: String(req.cookies[cookieName]), source: 'cookie' };
  const header = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(header)) return { token: header.replace(/^Bearer\s+/i, '').trim(), source: 'header' };
  return { token: null, source: null };
}

function verifyToken(token) {
  if (!config.auth.jwtSecret) throw AppError.unauthorized('Authentication is not configured', 'AUTH_NOT_CONFIGURED');
  try {
    return jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw AppError.unauthorized('Session expired', 'TOKEN_EXPIRED');
    throw AppError.unauthorized('Invalid session token', 'TOKEN_INVALID');
  }
}

function signToken(payload) {
  if (!config.auth.jwtSecret) throw AppError.internal('JWT_SECRET is not configured', 'AUTH_NOT_CONFIGURED');
  return jwt.sign(payload, config.auth.jwtSecret, { algorithm: 'HS256', expiresIn: config.auth.jwtExpiresIn });
}

/** Attach req.auth when a valid token is present, otherwise continue anonymously. */
function optionalAuth(req, _res, next) {
  const { token } = readToken(req);
  if (!token) return next();
  try {
    const claims = verifyToken(token);
    req.auth = {
      id: Number(claims.sub),
      type: claims.type || 'user',
      role: claims.role || null,
      email: claims.email || null,
      username: claims.username || null,
    };
  } catch (err) {
    req.auth = null;
    log.debug('token rejected', { message: err.message });
  }
  return next();
}

/** Require any authenticated principal (admin or user). */
function requireAuth(req, _res, next) {
  const { token } = readToken(req);
  if (!token) return next(AppError.unauthorized());
  try {
    const claims = verifyToken(token);
    req.auth = {
      id: Number(claims.sub),
      type: claims.type || 'user',
      role: claims.role || null,
      email: claims.email || null,
      username: claims.username || null,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Require an administrator account. */
function requireAdmin(req, _res, next) {
  const { token } = readToken(req);
  if (!token) return next(AppError.unauthorized('Administrator authentication required'));
  try {
    const claims = verifyToken(token);
    if (claims.type !== 'admin') return next(AppError.forbidden('Administrator privileges required', 'ADMIN_ONLY'));
    req.auth = {
      id: Number(claims.sub),
      type: 'admin',
      role: claims.role || 'admin',
      email: claims.email || null,
      username: claims.username || null,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Require a superadmin (destructive / security relevant operations). */
function requireSuperAdmin(req, _res, next) {
  requireAdmin(req, _res, (err) => {
    if (err) return next(err);
    if (req.auth.role !== 'superadmin') return next(AppError.forbidden('Superadmin privileges required', 'SUPERADMIN_ONLY'));
    return next();
  });
}

function clearAuthCookie(res) {
  res.clearCookie(config.auth.cookieName, {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: config.auth.cookieSameSite,
    path: '/',
  });
  res.clearCookie('fp_csrf', { path: '/' });
}

function setAuthCookies(res, token, csrfToken) {
  res.cookie(config.auth.cookieName, token, {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: config.auth.cookieSameSite,
    maxAge: 8 * 60 * 60 * 1000,
    path: '/',
  });
  // readable by our own JavaScript on purpose: double-submit CSRF token
  res.cookie('fp_csrf', csrfToken, {
    httpOnly: false,
    secure: config.auth.cookieSecure,
    sameSite: config.auth.cookieSameSite,
    maxAge: 8 * 60 * 60 * 1000,
    path: '/',
  });
}

module.exports = {
  readToken,
  verifyToken,
  signToken,
  optionalAuth,
  requireAuth,
  requireAdmin,
  requireSuperAdmin,
  setAuthCookies,
  clearAuthCookie,
};
