'use strict';

/**
 * MEMBER ACTIVITY SERVICE — the "Dashboard Activity" feed.
 *
 * The feed is built from `system_logs`, but ONLY the rows belonging to the
 * signed-in principal. The actor type and actor id are taken from the account
 * that the server re-read from the database (see middleware/account.js); a
 * request can never ask for somebody else's activity, and the endpoint that
 * calls this service answers 401 to a visitor with no session.
 *
 * Nothing user specific ever enters a public payload: this service is only
 * reachable from `/api/dashboard/*`, and the browser receives plain labels —
 * the raw audit context is never echoed back.
 */

const db = require('../database/queries');
const time = require('../utils/time');

const MAX_ITEMS = 25;

/** Human labels for the audit events a member or an admin can produce. */
const EVENTS = {
  USER_REGISTERED: {
    title: 'Account created',
    detail: 'Your member account was created.',
    tone: 'good',
  },
  USER_LOGIN: { title: 'Signed in', detail: 'Successful sign-in to your member account.', tone: 'info' },
  USER_LOGOUT: { title: 'Signed out', detail: 'You ended your session.', tone: 'info' },
  USER_PASSWORD_CHANGED: { title: 'Password changed', detail: 'Your account password was updated.', tone: 'warn' },
  LOGIN_FAILED: {
    title: 'Failed sign-in attempt',
    detail: 'A sign-in attempt with the wrong password was recorded on this account.',
    tone: 'warn',
  },
  ACCOUNT_LOCKED: {
    title: 'Account temporarily locked',
    detail: 'Too many failed attempts — the account was locked for a short period.',
    tone: 'warn',
  },
  ADMIN_LOGIN: { title: 'Administrator signed in', detail: 'Successful sign-in to the management console.', tone: 'info' },
  ADMIN_LOGOUT: { title: 'Administrator signed out', detail: 'You ended your administrator session.', tone: 'info' },
  ADMIN_PASSWORD_CHANGED: {
    title: 'Administrator password changed',
    detail: 'The console password for this account was updated.',
    tone: 'warn',
  },
  ACCOUNT_DISABLED: { title: 'Account disabled', detail: 'This account is no longer active.', tone: 'warn' },
};

const FALLBACK = { title: 'Account activity', detail: 'A recorded event on your account.', tone: 'info' };

function labelFor(event) {
  return EVENTS[event] || { ...FALLBACK, title: `Account event: ${String(event).replace(/_/g, ' ').toLowerCase()}` };
}

/** One feed entry — safe, presentation-ready fields only. */
function toItem(row) {
  const label = labelFor(row.event);
  return {
    id: Number(row.id),
    event: String(row.event),
    title: label.title,
    detail: label.detail,
    tone: label.tone,
    level: String(row.level || 'info'),
    channel: String(row.channel || 'app'),
    at: time.toIso(row.created_at),
  };
}

function daysSince(value) {
  const then = time.toDate(value);
  if (!then) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
}

function planLabel(member) {
  if (member.type === 'admin') return member.role === 'superadmin' ? 'Superadmin' : 'Administrator';
  return member.role === 'premium' ? 'Premium member' : 'Member';
}

/**
 * The dashboard activity payload for one verified principal.
 * @param {{type:'user'|'admin', id:number, username:string, email:string, role:string, memberSince:*, lastLoginAt:*}} member
 */
async function getDashboardActivity(member) {
  const actorType = member.type === 'admin' ? 'admin' : 'user';
  const actorId = Number(member.id);

  const [rows, total] = await Promise.all([
    db.listActorSystemLogs(actorType, actorId, MAX_ITEMS),
    db.countActorSystemLogs(actorType, actorId),
  ]);

  const items = rows.map(toItem);
  const latest = items.length ? items[0].at : null;

  return {
    // explicit marker: this payload is session scoped and is never served to a visitor
    audience: 'authenticated',
    scope: 'self',
    generatedAt: new Date().toISOString(),
    account: {
      type: actorType,
      id: actorId,
      username: member.username || null,
      email: member.email || null,
      plan: planLabel(member),
      memberSince: time.toIso(member.memberSince),
      lastLoginAt: time.toIso(member.lastLoginAt),
    },
    summary: {
      recordedEvents: total,
      shownEvents: items.length,
      lastActivityAt: latest,
      accountAgeDays: daysSince(member.memberSince),
    },
    items,
  };
}

module.exports = { getDashboardActivity, MAX_ITEMS, EVENTS };
