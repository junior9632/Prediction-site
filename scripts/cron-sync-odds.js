#!/usr/bin/env node
'use strict';

/**
 * cPanel cron: verified Over 1.5 odds synchronisation.
 */
//   CRON: every 20 minutes
//   */20 * * * * /usr/local/bin/node /home/USER/app/scripts/cron-sync-odds.js >> /home/USER/app/logs/cron.log 2>&1


process.env.CRON_CONTEXT = '1';

const syncService = require('../server/services/syncService');
const pool = require('../server/database/connection');
const logger = require('../server/utils/logger');
const { describeRun, runExitCode } = require('./lib/sync-output');

const log = logger.child('cron');

(async () => {
  const started = Date.now();
  const result = await syncService.syncOdds({ trigger: 'cron' });
  log.info('cron odds sync done', { ms: Date.now() - started, result });
  process.stdout.write(`${JSON.stringify({ job: 'odds', ms: Date.now() - started, ...result })}\n`);
  // plain-language line for logs/cron.log — never a bare "unavailable"
  const why = describeRun('odds', result);
  if (why) process.stdout.write(`${why}\n`);
  process.exitCode = runExitCode(result);
})()
  .catch((err) => {
    process.stderr.write(`odds sync failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.closePool());
