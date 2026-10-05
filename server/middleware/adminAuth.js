'use strict';

/**
 * Admin authorization layer.
 *
 *  - `requireActiveAdmin` re-reads the account from the database so a
 *    deactivated or locked administrator loses access immediately, even with
 *    a valid token
 *  - `requireCsrf` blocks cross-site forged state changing requests for
 *    cookie authenticated sessions (double submit token)
 *  - bearer token clients (CLI) are exempt from CSRF because they are not
 *    cookie bound
 */

const crypto = require('crypto');
const db = require('../database/queries');
const { AppError } = require('../utils/errors');
const auth = require('./auth');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Double-submit CSRF check for cookie authenticated mutations. */
function requireCsrf(req, _res, next) {
  if (!MUTATING.has(req.method)) return next();
  if (auth.readToken(req).source === 'header') return next();

  const cookieToken = req.cookies ? req.cookies.fp_csrf : null;
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken) return next(AppError.forbidden('Missing CSRF token', 'CSRF_MISSING'));

  const a = Buffer.from(String(cookieToken));
  const b = Buffer.from(String(headerToken));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(AppError.forbidden('Invalid CSRF token', 'CSRF_INVALID'));
  }
  return next();
}

/** Re-validate the admin account on every privileged request. */
async function requireActiveAdmin(req, _res, next) {
  try {
    if (!req.auth || req.auth.type !== 'admin') {
      throw AppError.forbidden('Administrator privileges required', 'ADMIN_ONLY');
    }
    const admin = await db.getAdminById(req.auth.id);
    if (!admin) throw AppError.unauthorized('Administrator account no longer exists', 'ADMIN_MISSING');
    if (Number(admin.is_active) !== 1) throw AppError.forbidden('Administrator account is disabled', 'ADMIN_DISABLED');
    if (admin.locked_until && new Date(admin.locked_until).getTime() > Date.now()) {
      throw AppError.forbidden('Administrator account is temporarily locked', 'ADMIN_LOCKED');
    }
    req.admin = {
      id: Number(admin.id),
      email: admin.email,
      username: admin.username,
      role: admin.role,
      mustChangePassword: Number(admin.must_change_password) === 1,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Composed guards used by the /api/admin routes. */
const adminGuard = [auth.requireAdmin, requireActiveAdmin, requireCsrf];
const superAdminGuard = [auth.requireSuperAdmin, requireActiveAdmin, requireCsrf];

function newCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { requireCsrf, requireActiveAdmin, adminGuard, superAdminGuard, newCsrfToken };
