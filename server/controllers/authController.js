'use strict';

/**
 * Authentication controller (admins + optional public users).
 *
 *  - bcrypt password hashing (cost from BCRYPT_ROUNDS)
 *  - JWT in an httpOnly, secure, SameSite cookie + double submit CSRF token
 *  - account lockout after repeated failures
 *  - constant-time comparison, generic error messages (no user enumeration)
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database/queries');
const config = require('../config');
const auth = require('../middleware/auth');
const { newCsrfToken } = require('../middleware/adminAuth');
const { assertAccountUsable } = require('../middleware/account');
const logService = require('../services/logService');
const { assertValid } = require('../utils/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/errors');
const time = require('../utils/time');

const GENERIC = 'Invalid credentials';

const loginSchema = {
  login: { type: 'string', required: true, maxLength: 190 },
  password: { type: 'string', required: true, minLength: 6, maxLength: 200 },
};

const registerSchema = {
  email: { type: 'email', required: true },
  username: { type: 'string', required: true, minLength: 3, maxLength: 40, pattern: /^[a-zA-Z0-9_.-]+$/ },
  password: { type: 'string', required: true, minLength: 8, maxLength: 200 },
};

async function hashPassword(password) {
  return bcrypt.hash(password, config.auth.bcryptRounds);
}

function isLocked(row) {
  return Boolean(row && row.locked_until && new Date(row.locked_until).getTime() > Date.now());
}

async function handleFailure(row, req, kind) {
  if (!row) return;
  const attempts = Number(row.failed_logins || 0) + 1;
  const lockUntil =
    attempts >= config.auth.loginMaxAttempts
      ? time.addMinutes(new Date(), config.auth.loginLockMinutes)
      : null;
  if (kind === 'admin') await db.recordAdminLoginFailure(Number(row.id), req.ip, lockUntil);
  else await db.recordUserLoginFailure(Number(row.id), req.ip, lockUntil);
  await logService.write({
    level: 'warn',
    channel: 'auth',
    event: lockUntil ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
    message: `Failed ${kind} login for ${row.username || row.email}`,
    actorType: kind,
    actorId: Number(row.id),
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    context: { attempts, lockedUntil: lockUntil ? lockUntil.toISOString() : null },
  });
}

function publicAdmin(admin) {
  return {
    id: Number(admin.id),
    username: admin.username,
    email: admin.email,
    role: admin.role,
    mustChangePassword: Number(admin.must_change_password) === 1,
  };
}

/** POST /api/auth/admin/login */
const adminLogin = asyncHandler(async (req, res) => {
  const { login, password } = assertValid(loginSchema, req.body || {});
  const row = await db.getAdminByLogin(login.toLowerCase());
  if (!row) {
    // burn comparable time to avoid enumeration via response timing
    await bcrypt.hash(password, 4);
    throw AppError.unauthorized(GENERIC, 'INVALID_CREDENTIALS');
  }
  if (Number(row.is_active) !== 1) throw AppError.forbidden('Account disabled', 'ACCOUNT_DISABLED');
  if (isLocked(row)) throw AppError.forbidden('Account temporarily locked after too many failed attempts', 'ACCOUNT_LOCKED');

  const matches = await bcrypt.compare(password, row.password_hash);
  if (!matches) {
    await handleFailure(row, req, 'admin');
    throw AppError.unauthorized(GENERIC, 'INVALID_CREDENTIALS');
  }

  await db.recordAdminLoginSuccess(Number(row.id), req.ip);
  const token = auth.signToken({
    sub: row.id,
    type: 'admin',
    role: row.role,
    email: row.email,
    username: row.username,
  });
  const csrf = newCsrfToken();
  auth.setAuthCookies(res, token, csrf);

  // Written with an explicit actor: the login request itself carries no
  // session yet, so the dashboard activity feed must be told whose event this is.
  await logService.write({
    level: 'info',
    channel: 'audit',
    event: 'ADMIN_LOGIN',
    message: `Administrator ${row.username} signed in`,
    actorType: 'admin',
    actorId: Number(row.id),
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    context: { adminId: Number(row.id) },
  });
  res.json({ ok: true, data: { admin: publicAdmin(row), token, csrfToken: csrf } });
});

/** POST /api/auth/logout — any session type (admin or user). */
const logout = asyncHandler(async (req, res) => {
  if (req.auth && req.auth.type === 'admin') {
    await logService.audit(req, 'ADMIN_LOGOUT', { adminId: req.auth.id });
  } else if (req.auth && req.auth.type === 'user') {
    await logService.write({ level: 'info', channel: 'auth', event: 'USER_LOGOUT', actorType: 'user', actorId: req.auth.id, ipAddress: req.ip });
  }
  auth.clearAuthCookie(res);
  res.json({ ok: true, data: { loggedOut: true } });
});

/** POST /api/auth/admin/logout — kept as an alias of the generic logout. */
const adminLogout = logout;

/** POST /api/auth/admin/change-password */
const changePassword = asyncHandler(async (req, res) => {
  if (!req.auth || req.auth.type !== 'admin') throw AppError.unauthorized();
  const { currentPassword, newPassword } = assertValid(
    {
      currentPassword: { type: 'string', required: true, maxLength: 200 },
      newPassword: { type: 'string', required: true, minLength: 10, maxLength: 200 },
    },
    req.body || {}
  );
  const row = await db.getAdminById(req.auth.id);
  if (!row) throw AppError.unauthorized();
  const ok = await bcrypt.compare(currentPassword, row.password_hash);
  if (!ok) throw AppError.badRequest('Current password is incorrect', 'INVALID_CREDENTIALS');
  if (currentPassword === newPassword) throw AppError.badRequest('New password must be different', 'SAME_PASSWORD');

  await db.updateAdminPassword(Number(row.id), await hashPassword(newPassword));
  await logService.audit(req, 'ADMIN_PASSWORD_CHANGED', { adminId: Number(row.id) });
  res.json({ ok: true, data: { changed: true } });
});

/** POST /api/auth/change-password — public user account. */
const userChangePassword = asyncHandler(async (req, res) => {
  if (!req.auth || req.auth.type !== 'user') throw AppError.unauthorized();
  const { currentPassword, newPassword } = assertValid(
    {
      currentPassword: { type: 'string', required: true, maxLength: 200 },
      newPassword: { type: 'string', required: true, minLength: 8, maxLength: 200 },
    },
    req.body || {}
  );
  const row = await db.getUserById(req.auth.id);
  if (!row) throw AppError.unauthorized();
  const ok = await bcrypt.compare(currentPassword, row.password_hash);
  if (!ok) throw AppError.badRequest('Current password is incorrect', 'INVALID_CREDENTIALS');
  if (currentPassword === newPassword) throw AppError.badRequest('New password must be different', 'SAME_PASSWORD');

  await db.updateUserPassword(Number(row.id), await hashPassword(newPassword));
  await logService.write({ level: 'info', channel: 'auth', event: 'USER_PASSWORD_CHANGED', actorType: 'user', actorId: Number(row.id), ipAddress: req.ip });
  res.json({ ok: true, data: { changed: true } });
});

/** GET /api/auth/me */
const me = asyncHandler(async (req, res) => {
  if (!req.auth) throw AppError.unauthorized();
  if (req.auth.type === 'admin') {
    const row = await db.getAdminById(req.auth.id);
    // A disabled or locked account is refused here too, so no page can paint a
    // "signed in" header for a session that may no longer read member data.
    assertAccountUsable(row, 'Administrator');
    return res.json({ ok: true, data: { type: 'admin', account: publicAdmin(row) } });
  }
  const row = await db.getUserById(req.auth.id);
  assertAccountUsable(row, 'Member');
  return res.json({
    ok: true,
    data: {
      type: 'user',
      account: {
        id: Number(row.id),
        username: row.username,
        email: row.email,
        role: row.role,
        memberSince: time.toIso(row.created_at),
        lastLoginAt: time.toIso(row.last_login_at),
      },
    },
  });
});

/** POST /api/auth/register — optional public account */
const register = asyncHandler(async (req, res) => {
  const { email, username, password } = assertValid(registerSchema, req.body || {});
  const existing = await db.getUserByLogin(email);
  if (existing) {
    await bcrypt.hash(crypto.randomBytes(8).toString('hex'), 4);
    throw AppError.conflict('That account already exists', 'ACCOUNT_EXISTS');
  }
  const id = await db.createUser({ email, username, passwordHash: await hashPassword(password) });
  await logService.write({ level: 'info', channel: 'auth', event: 'USER_REGISTERED', actorType: 'user', actorId: id, ipAddress: req.ip });
  res.status(201).json({ ok: true, data: { id: Number(id), username, email } });
});

/** POST /api/auth/login — public account */
const userLogin = asyncHandler(async (req, res) => {
  const { login, password } = assertValid(loginSchema, req.body || {});
  const row = await db.getUserByLogin(login.toLowerCase());
  if (!row) {
    await bcrypt.hash(password, 4);
    throw AppError.unauthorized(GENERIC, 'INVALID_CREDENTIALS');
  }
  if (Number(row.is_active) !== 1) throw AppError.forbidden('Account disabled', 'ACCOUNT_DISABLED');
  if (isLocked(row)) throw AppError.forbidden('Account temporarily locked', 'ACCOUNT_LOCKED');

  const matches = await bcrypt.compare(password, row.password_hash);
  if (!matches) {
    await handleFailure(row, req, 'user');
    throw AppError.unauthorized(GENERIC, 'INVALID_CREDENTIALS');
  }
  await db.recordUserLoginSuccess(Number(row.id), req.ip);
  // Feeds the member's own dashboard activity (GET /api/dashboard/activity).
  await logService.write({
    level: 'info',
    channel: 'auth',
    event: 'USER_LOGIN',
    message: `Member ${row.username} signed in`,
    actorType: 'user',
    actorId: Number(row.id),
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  const token = auth.signToken({ sub: row.id, type: 'user', role: row.role, email: row.email, username: row.username });
  const csrf = newCsrfToken();
  auth.setAuthCookies(res, token, csrf);
  res.json({
    ok: true,
    data: { user: { id: Number(row.id), username: row.username, email: row.email, role: row.role }, token, csrfToken: csrf },
  });
});

module.exports = { adminLogin, adminLogout, logout, changePassword, userChangePassword, me, register, userLogin, hashPassword };
