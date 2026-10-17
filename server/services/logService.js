'use strict';

/**
 * LOG SERVICE — audit trail in `system_logs` + API sync history.
 * Database logging never breaks a request: failures are reported to the
 * process logger and swallowed.
 */

const db = require('../database/queries');
const logger = require('../utils/logger');

const log = logger.child('audit');

const LEVELS = ['debug', 'info', 'warn', 'error', 'critical'];

/** Write an audit entry (fire and forget safe). */
async function write(entry = {}) {
  const payload = {
    level: LEVELS.includes(entry.level) ? entry.level : 'info',
    channel: entry.channel || 'app',
    event: String(entry.event || 'unknown').slice(0, 80),
    message: entry.message ? String(entry.message).slice(0, 1000) : null,
    actorType: entry.actorType || null,
    actorId: entry.actorId || null,
    ipAddress: entry.ipAddress || null,
    userAgent: entry.userAgent || null,
    context: entry.context || null,
  };
  try {
    await db.insertSystemLog(payload);
  } catch (err) {
    log.error('unable to persist system log', { event: payload.event, message: err.message });
  }
  return payload;
}

/** Convenience: derive actor/ip context from an Express request. */
function fromRequest(req) {
  const auth = (req && req.auth) || {};
  return {
    actorType: auth.type || (req && req.ip ? 'system' : 'system'),
    actorId: auth.id || null,
    ipAddress: req ? req.ip : null,
    userAgent: req && req.get ? req.get('user-agent') : null,
  };
}

async function audit(req, event, context = {}, level = 'info') {
  return write({ level, channel: 'audit', event, context, ...fromRequest(req) });
}

async function list(filters = {}) {
  const rows = await db.querySystemLogs(filters);
  const total = await db.countSystemLogs(filters);
  return { rows, total };
}

/* ------------------------- api sync logs ---------------------------- */

async function startSync(job, triggerSource = 'cron') {
  const id = await db.insertApiSyncLog({ job, triggerSource, status: 'RUNNING', startedAt: new Date() });
  return { id, job, startedAt: Date.now() };
}

async function finishSync(handle, patch = {}) {
  if (!handle || !handle.id) return null;
  const duration = patch.durationMs ?? Date.now() - handle.startedAt;
  const status = patch.status || 'SUCCESS';
  if (status === 'FAILED' || status === 'PARTIAL') {
    log.warn('sync finished with problems', { job: handle.job, status, message: patch.message });
  }
  return db.finishApiSyncLog(handle.id, { ...patch, durationMs: duration, status, finishedAt: new Date() });
}

async function recentSyncs(limit = 40, job = null) {
  return db.getApiSyncLogs(limit, job);
}

module.exports = { write, audit, fromRequest, list, startSync, finishSync, recentSyncs, LEVELS };
