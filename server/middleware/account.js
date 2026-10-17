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
 *
 * The same chain is exported as `memberGuard` and is what makes every football
 * surface (predictions, ticket, history, analytics, fixtures, odds) member
 * only — see the notes above the export.
 */

const db = require('../database/queries');
const { AppError } = require('../utils/errors');
const { requireAuth } = require('./auth');

/** Throw unless the row exists and the account may still be used. */
function assertAccountUsable(row, kind) {
  if (!row) throw AppError.unauthorized(`${kind} account no longer exists`, 'ACCOUNT_MISSING');
  if (Number(row.is_active) !== 1) throw AppError.forbidden('Account disabled', 'ACCOUNT_DISABLED');
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    throw AppError.forbidden('Account temporarily locked', 'ACCOUNT_LOCKED');
  }
}

/**
 * The exact message a pending applicant sees after registering and after a
 * login attempt — required product copy, kept in one place.
 */
const PENDING_APPROVAL_MESSAGE =
  'Your account has been submitted for approval. You will be able to access your dashboard once an administrator approves your account.';

/**
 * MEMBER-ONLY STATUS GUARD.
 *
 * `assertAccountUsable` proves the row exists and is not disabled/locked.
 * On top of that, a public user account must additionally be APPROVED:
 * `pending`, `rejected` and `suspended` accounts never reach a protected
 * feature — not at login (no session is even issued) and not with an
 * already-issued token, because this runs on every request.
 *
 * The status is read from the database row, never from the request.
 */
function assertUserApproved(user) {
  if (!user) throw AppError.unauthorized('Member account no longer exists', 'ACCOUNT_MISSING');
  if (user.status === 'pending') throw AppError.forbidden(PENDING_APPROVAL_MESSAGE, 'ACCOUNT_PENDING');
  if (user.status === 'rejected') {
    throw AppError.forbidden(
      'This account application was not approved. Please contact support if you believe this is a mistake.',
      'ACCOUNT_REJECTED'
    );
  }
  if (user.status === 'suspended') {
    throw AppError.forbidden(
      'This account has been suspended. Please contact support for more information.',
      'ACCOUNT_SUSPENDED'
    );
  }
  if (Number(user.is_active) !== 1) throw AppError.forbidden('Account disabled', 'ACCOUNT_DISABLED');
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
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
    assertUserApproved(user);
    req.member = {
      type: 'user',
      id: Number(user.id),
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      memberSince: user.created_at,
      lastLoginAt: user.last_login_at,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * PREDICTION-SURFACE GUARD.
 *
 * Every football surface — predictions, today's ticket, ticket history,
 * analytics, fixtures and odds — is member only. The chain is deliberately
 * the same one the member dashboard already uses:
 *
 *   noStore             -> no shared cache may ever replay the answer
 *   requireAuth         -> a verified session token (cookie or bearer) or 401
 *   requireActiveAccount-> the account is re-read from the database, so a
 *                          deleted / disabled / locked account is refused too
 *
 * Nothing about the caller's identity is ever taken from the request body,
 * query string or headers: `req.member` comes from the database row the guard
 * looked up from the token's `sub` claim.
 */
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

const memberGuard = [noStore, requireAuth, requireActiveAccount];

module.exports = { requireActiveAccount, assertAccountUsable, assertUserApproved, PENDING_APPROVAL_MESSAGE, noStore, memberGuard };
