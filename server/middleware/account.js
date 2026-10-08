'use strict';

/**
 * ACCOUNT STATE GUARD — used by every member-only API.
 *
 * `requireAuth` (middleware/auth.js) proves the token is genuine. This guard
 * goes one step further and re-reads the account from the database on every
 * request, so a deleted, deactivated or locked account loses access
 * immediately — exactly like `requireActiveAdmin` does for the console.
 *
 * It also normalises the principal into `req.member`: the handlers only ever
 * see an account that exists and is active, and the actor type/id they use to
 * scope member data come from the database row, never from the request. A
 * `userId`/`actorId` supplied by the browser can therefore never widen what a
 * caller is allowed to read.
 *
 * `memberApiGuard` is the single composition every prediction-facing router
 * mounts: no-store + requireAuth + requireActiveAccount. Mounting it in the
 * ROUTER (not in the frontend) is what makes the boundary real — a guest who
 * opens DevTools and calls /api/predictions directly is answered 401 with no
 * payload, no matter which page they came from.
 */

const db = require('../database/queries');
const { AppError } = require('../utils/errors');
const auth = require('./auth');

/** Throw unless the row exists and the account may still be used. */
function assertAccountUsable(row, kind) {
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
      assertAccountUsable(admin, 'Administrator');
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
    assertAccountUsable(user, 'Member');
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

/**
 * Member data must never be stored by a browser cache, a shared proxy or a
 * CDN — neither the payload nor the refusal. A cached 200 replayed to a guest
 * would leak exactly what this guard exists to protect.
 */
function neverCache(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

/**
 * The composed member guard: cache disabled, session verified, account
 * re-validated from the database. Applied to every prediction, ticket, odds,
 * fixture and analytics endpoint.
 */
const memberApiGuard = [neverCache, auth.requireAuth, requireActiveAccount];

module.exports = { requireActiveAccount, assertAccountUsable, neverCache, memberApiGuard };
