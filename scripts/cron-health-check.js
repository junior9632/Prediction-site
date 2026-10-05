#!/usr/bin/env node
'use strict';

/**
 * cPanel cron: health probe. Exits non-zero when the database or the data
 * source is down so cron mail alerts the operator.
 */
//   CRON: every 15 minutes
//   */15 * * * * /usr/local/bin/node /home/USER/app/scripts/cron-health-check.js >> /home/USER/app/logs/cron.log 2>&1


process.env.CRON_CONTEXT = '1';

const pool = require('../server/database/connection');
const syncService = require('../server/services/syncService');
const logService = require('../server/services/logService');
const notifyService = require('../server/services/notifyService');

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
    report.quota = status.quota || null;
    report.configured = status.configured;
  } catch (err) {
    report.dataSource = 'error';
    report.dataSourceError = err.message;
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);

  if (report.database !== 'ok' || report.dataSource === 'OPEN' || report.dataSource === 'UNCONFIGURED') {
    await logService
      .write({ level: 'critical', channel: 'cron', event: 'HEALTH_CHECK_FAILED', message: JSON.stringify(report) })
      .catch(() => {});
    // Telegram/webhook alert so a dead DB or data source is noticed quickly.
    await notifyService.alert('HEALTH_CHECK_FAILED', report).catch(() => {});
    process.exitCode = 1;
  }
})()
  .catch((err) => {
    process.stderr.write(`health check failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.closePool());
