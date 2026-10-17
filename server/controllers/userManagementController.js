'use strict';

/**
 * ADMIN USER MANAGEMENT controller — the approval workflow.
 *
 * Every handler runs behind the /api/admin guard chain (requireAdmin +
 * requireActiveAdmin + requireCsrf), so only a verified, active
 * administrator can reach any of these endpoints; cookie sessions
 * additionally need the double-submit CSRF token.
 *
 * Rules enforced here:
 *  - the affected account is always re-read from the database; nothing about
 *    the target comes from the request except the numeric id;
 *  - only regular member accounts (users table) can be managed —
 *    administrators live in the separate `admins` table and can never be
 *    locked out through these endpoints;
 *  - every decision is a validated state transition, applied in a database
 *    transaction together with its audit row (admin id, action, previous and
 *    new status, optional reason, ip, timestamp);
 *  - password hashes are never selected for output and never returned;
 *  - the status change is effective immediately: the account guard re-reads
 *    the row on every request, so an existing session of a suspended user is
 *    refused from the very next request.
 */

const db = require('../database/queries');
const time = require('../utils/time');
const { assertValid } = require('../utils/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/errors');
const logService = require('../services/logService');
const notifyService = require('../services/notifyService');

const USER_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
/** Only ordinary member roles may be managed through this controller. */
const MANAGEABLE_ROLES = ['user', 'premium'];

/**
 * The approval state machine. `from` lists the statuses the action may be
 * applied to; anything else is a 409 conflict, never a silent no-op.
 */
const TRANSITIONS = {
  approve: { from: ['pending', 'rejected'], to: 'approved', action: 'approved', event: 'USER_APPROVED' },
  reject: { from: ['pending'], to: 'rejected', action: 'rejected', event: 'USER_REJECTED' },
  suspend: { from: ['pending', 'approved'], to: 'suspended', action: 'suspended', event: 'USER_SUSPENDED' },
  reactivate: { from: ['suspended'], to: 'approved', action: 'reactivated', event: 'USER_REACTIVATED' },
};

const AVAILABLE_ACTIONS = {
  pending: ['view', 'approve', 'reject', 'suspend'],
  approved: ['view', 'suspend'],
  rejected: ['view', 'approve'],
  suspended: ['view', 'reactivate'],
};

/** Map of admin id -> username, built once per request (tiny table). */
async function adminUsernameMap() {
  const admins = await db.listAdmins();
  const map = new Map();
  for (const a of admins) map.set(Number(a.id), a.username);
  return map;
}

/** The only shape a user row may leave the server in — no password hash. */
function publicUser(row, adminsById) {
  return {
    id: Number(row.id),
    username: row.username,
    fullName: row.full_name || '',
    email: row.email,
    role: row.role,
    status: row.status,
    active: Number(row.is_active) === 1,
    registeredAt: time.toIso(row.created_at),
    lastLoginAt: time.toIso(row.last_login_at),
    approvedAt: time.toIso(row.approved_at),
    approvedByAdminId: row.approved_by_admin_id === null ? null : Number(row.approved_by_admin_id),
    approvedBy: row.approved_by_admin_id === null ? null : adminsById.get(Number(row.approved_by_admin_id)) || null,
    statusReason: row.status_reason || null,
    statusChangedAt: time.toIso(row.status_changed_at),
    availableActions: AVAILABLE_ACTIONS[row.status] || ['view'],
  };
}

function publicAuditEntry(row, adminsById) {
  return {
    id: Number(row.id),
    action: row.action,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    reason: row.reason || null,
    adminId: row.admin_id === null ? null : Number(row.admin_id),
    adminUsername: row.admin_id === null ? null : adminsById.get(Number(row.admin_id)) || null,
    ipAddress: row.ip_address || null,
    createdAt: time.toIso(row.created_at),
  };
}

/** GET /api/admin/users/summary */
const summary = asyncHandler(async (_req, res) => {
  const counts = await db.getUserSummary();
  res.json({ ok: true, data: counts });
});

/** GET /api/admin/users?status=&search=&page=&limit= */
const list = asyncHandler(async (req, res) => {
  const params = assertValid(
    {
      status: { type: 'enum', values: USER_STATUSES },
      search: { type: 'string', maxLength: 120 },
      page: { type: 'int', default: 1, min: 1, max: 100000 },
      limit: { type: 'int', default: 20, min: 1, max: 100 },
    },
    req.query
  );
  const filters = { status: params.status || null, search: params.search || null };
  const [rows, total, adminsById] = await Promise.all([
    db.listUsers({ ...filters, limit: params.limit, offset: (params.page - 1) * params.limit }),
    db.countUsers(filters),
    adminUsernameMap(),
  ]);
  res.json({
    ok: true,
    data: {
      page: params.page,
      limit: params.limit,
      total,
      pages: Math.max(1, Math.ceil(total / params.limit)),
      status: filters.status || 'all',
      search: filters.search || '',
      items: rows.map((r) => publicUser(r, adminsById)),
    },
  });
});

/** GET /api/admin/users/:id — account details + administrative action history */
const detail = asyncHandler(async (req, res) => {
  const { id } = assertValid({ id: { type: 'int', required: true, min: 1 } }, req.params);
  const row = await db.getUserById(id);
  if (!row) throw AppError.notFound('User not found', 'USER_NOT_FOUND');
  const [adminsById, auditRows] = await Promise.all([adminUsernameMap(), db.listUserAuditLogs(id, 50)]);
  res.json({
    ok: true,
    data: {
      user: publicUser(row, adminsById),
      audit: auditRows.map((r) => publicAuditEntry(r, adminsById)),
    },
  });
});

/**
 * Shared implementation for approve / reject / suspend / reactivate.
 * The decision is applied in one transaction together with its audit row.
 */
async function applyAction(req, res, actionKey) {
  const { id } = assertValid({ id: { type: 'int', required: true, min: 1 } }, req.params);
  const { reason } = assertValid({ reason: { type: 'string', maxLength: 255 } }, req.body || {});
  const transition = TRANSITIONS[actionKey];

  const row = await db.getUserById(id);
  if (!row) throw AppError.notFound('User not found', 'USER_NOT_FOUND');
  if (!MANAGEABLE_ROLES.includes(row.role)) {
    // Defensive: this controller manages member accounts only. Administrator
    // accounts live in the separate `admins` table and can never be modified
    // (or locked out) through user management.
    throw AppError.forbidden('This account type cannot be managed here', 'ACCOUNT_NOT_MANAGEABLE');
  }
  if (!transition.from.includes(row.status)) {
    throw AppError.conflict(
      `Cannot ${actionKey} a user whose status is "${row.status}"`,
      'INVALID_STATUS_TRANSITION',
      { from: row.status, action: actionKey, allowedFrom: transition.from }
    );
  }

  const previousStatus = row.status;
  const approved = actionKey === 'approve' || actionKey === 'reactivate';
  const auditId = await db.applyUserStatusDecision(
    id,
    {
      status: transition.to,
      isActive: approved,
      approvedAt: approved ? new Date() : null,
      approvedByAdminId: approved ? req.admin.id : null,
      reason: actionKey === 'approve' || actionKey === 'reactivate' ? null : reason || null,
    },
    {
      userId: id,
      adminId: req.admin.id,
      action: transition.action,
      previousStatus,
      newStatus: transition.to,
      reason: reason || null,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }
  );

  const updated = await db.getUserById(id);
  const adminsById = await adminUsernameMap();

  await logService.audit(
    req,
    transition.event,
    { userId: id, username: updated.username, previousStatus, newStatus: transition.to, reason: reason || null, auditId }
  );

  // Fire-and-forget notification through the configured channel (Telegram /
  // webhook). Never blocks, never pretends an e-mail was sent.
  const notification = await notifyService.accountStatusChanged(transition.event, {
    user: { id: Number(updated.id), username: updated.username, email: updated.email },
    admin: req.admin,
    reason: reason || null,
  });

  res.json({
    ok: true,
    data: {
      user: publicUser(updated, adminsById),
      auditId: Number(auditId),
      notification,
      note: notification.telegram || notification.webhook
        ? 'The account owner was notified through the configured channel.'
        : 'No notification channel is configured (TELEGRAM_BOT_TOKEN / NOTIFY_WEBHOOK_URL) — the decision is still fully applied and audited.',
    },
  });
}

/** POST /api/admin/users/:id/approve */
const approve = asyncHandler((req, res) => applyAction(req, res, 'approve'));

/** POST /api/admin/users/:id/reject — body may carry an optional reason */
const reject = asyncHandler((req, res) => applyAction(req, res, 'reject'));

/** POST /api/admin/users/:id/suspend — body may carry an optional reason */
const suspend = asyncHandler((req, res) => applyAction(req, res, 'suspend'));

/** POST /api/admin/users/:id/reactivate */
const reactivate = asyncHandler((req, res) => applyAction(req, res, 'reactivate'));

module.exports = { summary, list, detail, approve, reject, suspend, reactivate, USER_STATUSES };
