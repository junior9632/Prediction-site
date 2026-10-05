#!/usr/bin/env node
'use strict';

/**
 * cPanel cron: run every allowed sync job in one go.
 *
 * This script can NEVER create or publish a ticket.
 */
//   CRON: hourly
//   5 */1 * * * /usr/local/bin/node /home/USER/app/scripts/cron-sync-all.js >> /home/USER/app/logs/cron.log 2>&1


process.env.CRON_CONTEXT = '1';

const syncService = require('../server/services/syncService');
const pool = require('../server/database/connection');

(async () => {
  const started = Date.now();
  const result = await syncService.syncAll({ trigger: 'cron' });
  process.stdout.write(`${JSON.stringify({ job: 'all', ms: Date.now() - started, ...result })}\n`);
  if (!result.dataSourceAvailable) process.exitCode = 2; // alert in cron mail
})()
  .catch((err) => {
    process.stderr.write(`sync all failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.closePool());
