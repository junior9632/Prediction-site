'use strict';

/**
 * ACCOUNT STATE GUARD — used by the member dashboard API.
 *
 * `requireAuth` (middleware/auth.js) proves the token is genuine. This guard
 * goes one step further and re-reads the account from the database on every
 * request, so a deleted, deactivated or locked account loses access
 * immediately — exactly like `requireActiveAdmin` does for the console.
 *
 * It also normalises the principal into `req.member`: the handlers only ever
 * see an account that exists and is active, and the actor type/id they use to
 * scope dashboard data come from the database row, never from the request.
 */

const db = require('../database/queries');
const { AppError } = require('../utils/errors');

function assertUsable(row, kind) {
  if (!row) throw AppError.unauthorized(`${kind} account no longer exists`, 'ACCOUNT_MISSING');
  if (Number(row.is_active) !== 1) throw AppError.forbidden('Account disabled', 'ACCOUNT_DISABLED');
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    throw AppError.forbidden('Account temporarily locked', 'ACCOUNT_LOCKED');
  }
}

async function requireActiveAccount(req, _res, next) {
  try {
    if (!req.auth) throw AppError.unauthorized();
    if (req.auth.type === 'admin') {
      const admin = await db.getAdminById(req.auth.id);
      assertUsable(admin, 'Administrator');
      req.member = {
        type: 'admin',
        id: Number(admin.id),
        username: admin.username,
        email: admin.email,
        role: admin.role,
        memberSince: admin.created_at,
        lastLoginAt: admin.last_login_at,
      };
      return next();
    }
    const user = await db.getUserById(req.auth.id);
    assertUsable(user, 'Member');
    req.member = {
      type: 'user',
      id: Number(user.id),
      username: user.username,
      email: user.email,
      role: user.role,
      memberSince: user.created_at,
      lastLoginAt: user.last_login_at,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireActiveAccount };
