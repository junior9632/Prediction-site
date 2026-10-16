#!/usr/bin/env node
'use strict';

/**
 * cPanel cron: health probe. Exits non-zero when the database or the data
 * source is down so cron mail alerts the operator.
 *
 * A spent daily request budget counts as "down": the site cannot sync anything
 * until 00:00 UTC. Because this job runs every 15 minutes, a *repeated* alert
 * for the same state would be noise — the previous verdict is read back from
 * `system_logs` and only a changed one is sent (the cron mail still shows the
 * full reason every time).
 */
//   CRON: every 15 minutes
//   */15 * * * * /usr/local/bin/node /home/USER/app/scripts/cron-health-check.js >> /home/USER/app/logs/cron.log 2>&1


process.env.CRON_CONTEXT = '1';

const pool = require('../server/database/connection');
const syncService = require('../server/services/syncService');
const logService = require('../server/services/logService');
const notifyService = require('../server/services/notifyService');

/** The state+reason pair that decides whether an alert is news. */
function stateKey(report) {
  return `${report.database}|${report.dataSource}|${report.reason || ''}`;
}

/** The verdict of the previous run, read back from `system_logs`. */
async function previousVerdict() {
  try {
    const { rows } = await logService.list({ channel: 'cron', event: 'HEALTH_CHECK_FAILED', limit: 1 });
    if (!rows || !rows.length) return null;
    const last = JSON.parse(rows[0].message || '{}');
    return stateKey(last);
  } catch (_) {
    return null; // never let the dedupe itself silence a real alert
  }
}

(async () => {
  const report = { database: 'ok', dataSource: 'unknown', checkedAt: new Date().toISOString() };
  try {
    await pool.ping();
  } catch (err) {
    report.database = 'unavailable';
    report.databaseError = err.message;
  }
  try {
    const status = await syncService.getApiStatus({ probe: true });
    report.dataSource = status.state;
    report.configured = status.configured;
    // WHY the source is not usable + what to do (never an invented quota)
    report.reason = status.reason || null;
    report.label = status.label || null;
    report.hint = status.hint || null;
    report.resetsAt = status.resetsAt || null;
    report.quota = status.quotaState || status.quota || null;
    report.usable = status.available === true;
  } catch (err) {
    report.dataSource = 'error';
    report.dataSourceError = err.message;
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);

  const unusable =
    report.database !== 'ok' ||
    ['OPEN', 'UNCONFIGURED', 'QUOTA_EXHAUSTED', 'error'].includes(report.dataSource);

  if (unusable) {
    const previous = await previousVerdict();
    await logService
      .write({ level: 'critical', channel: 'cron', event: 'HEALTH_CHECK_FAILED', message: JSON.stringify(report) })
      .catch(() => {});
    // Telegram/webhook alert so a dead DB or data source is noticed quickly —
    // but only when the cause changed (a spent plan would otherwise alert
    // every 15 minutes until midnight).
    if (previous !== stateKey(report)) {
      await notifyService.alert('HEALTH_CHECK_FAILED', report).catch(() => {});
    }
    process.exitCode = 1;
  }
})()
  .catch((err) => {
    process.stderr.write(`health check failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.closePool());
