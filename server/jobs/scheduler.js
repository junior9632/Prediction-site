'use strict';

/**
 * In-process scheduler for the ALLOWED background jobs only:
 *   fixtures, odds, results.
 *
 * It can never generate or publish a ticket: this module does not import
 * ticketService at all, and ticketService refuses any non-admin trigger.
 * cPanel cron jobs (scripts/cron-*.js) are the recommended mechanism; this
 * scheduler is a convenience for hosts where cron is unavailable.
 */

const logger = require('../utils/logger');
const config = require('../config');

const log = logger.child('scheduler');

const timers = [];
const locks = new Set();

async function runJob(name, fn) {
  if (locks.has(name)) {
    log.warn('job still running, skipping tick', { job: name });
    return;
  }
  locks.add(name);
  const started = Date.now();
  try {
    // lazy require so a DB failure at boot never prevents the web server
    const syncService = require('../services/syncService');
    const result = await fn(syncService);
    log.info('scheduled job finished', { job: name, ms: Date.now() - started, result: summarize(result) });
  } catch (err) {
    log.error('scheduled job failed', { job: name, message: err.message });
  } finally {
    locks.delete(name);
  }
}

function summarize(result) {
  if (!result || typeof result !== 'object') return result;
  const { job, rowsWritten, endpointCalls, status, resultsRecorded, selectionsSettled } = result;
  return { job, rowsWritten, endpointCalls, status, resultsRecorded, selectionsSettled };
}

function start() {
  if (!config.scheduler.enabled) {
    log.info('internal scheduler disabled (ENABLE_INTERNAL_SCHEDULER=0). Use cPanel cron jobs for sync.');
    return { enabled: false, jobs: [] };
  }

  const jobs = [
    {
      name: 'fixtures',
      minutes: config.scheduler.fixturesMinutes,
      fn: (sync) => sync.syncFixtures({ trigger: 'scheduler' }),
    },
    {
      name: 'odds',
      minutes: config.scheduler.oddsMinutes,
      fn: (sync) => sync.syncOdds({ trigger: 'scheduler' }),
    },
    {
      name: 'results',
      minutes: config.scheduler.resultsMinutes,
      fn: (sync) => sync.syncResults({ trigger: 'scheduler' }),
    },
  ];

  for (const job of jobs) {
    const ms = Math.max(1, Number(job.minutes) || 30) * 60 * 1000;
    const timer = setInterval(() => runJob(job.name, job.fn), ms);
    timer.unref?.();
    timers.push(timer);
    // stagger the first run so boot does not hammer the API
    const initial = setTimeout(() => runJob(job.name, job.fn), 15000 + jobs.indexOf(job) * 20000);
    initial.unref?.();
    timers.push(initial);
  }

  log.info('internal scheduler started', { jobs: jobs.map((j) => `${j.name}:${j.minutes}m`) });
  log.warn('scheduler can only sync data — daily tickets remain manual');
  return { enabled: true, jobs: jobs.map((j) => ({ name: j.name, minutes: j.minutes })) };
}

function stop() {
  while (timers.length) {
    const t = timers.pop();
    clearInterval(t);
    clearTimeout(t);
  }
}

module.exports = { start, stop, runJob };
