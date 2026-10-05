#!/usr/bin/env node
'use strict';

/**
 * cPanel cron: fixture + statistics synchronisation.
 *
 * CRON_CONTEXT=1 makes ticket generation impossible from this process.
 */
//   0 * * * * /usr/local/bin/node /home/USER/app/scripts/cron-sync-fixtures.js >> /home/USER/app/logs/cron.log 2>&1


process.env.CRON_CONTEXT = '1';

const syncService = require('../server/services/syncService');
const pool = require('../server/database/connection');
const logger = require('../server/utils/logger');

const log = logger.child('cron');

(async () => {
  const started = Date.now();
  const result = await syncService.syncFixtures({ trigger: 'cron' });
  log.info('cron fixtures sync done', { ms: Date.now() - started, result });
  process.stdout.write(`${JSON.stringify({ job: 'fixtures', ms: Date.now() - started, ...result })}\n`);
})()
  .catch((err) => {
    process.stderr.write(`fixtures sync failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.closePool());
