#!/usr/bin/env node
'use strict';

/**
 * cPanel cron: final scores + settlement of pending Over 1.5 picks.
 *
 * Settlement only records what API-Football reports. A match with 2+ total
 * goals is WON, 0-1 goals is LOST, postponed/cancelled is VOID/POSTPONED.
 */
//   CRON: every 30 minutes
//   */30 * * * * /usr/local/bin/node /home/USER/app/scripts/cron-sync-results.js >> /home/USER/app/logs/cron.log 2>&1


process.env.CRON_CONTEXT = '1';

const syncService = require('../server/services/syncService');
const pool = require('../server/database/connection');
const logger = require('../server/utils/logger');

const log = logger.child('cron');

(async () => {
  const started = Date.now();
  const result = await syncService.syncResults({ trigger: 'cron' });
  log.info('cron results sync done', { ms: Date.now() - started, result });
  process.stdout.write(`${JSON.stringify({ job: 'results', ms: Date.now() - started, ...result })}\n`);
})()
  .catch((err) => {
    process.stderr.write(`results sync failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.closePool());
