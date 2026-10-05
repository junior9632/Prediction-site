'use strict';

/**
 * HTTP bootstrap (cPanel "Application startup file" -> /server.js -> here).
 *
 *   node server.js
 */

const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');
const { createApp } = require('./app');
const scheduler = require('./jobs/scheduler');
const db = require('./database/connection');

const log = logger.child('server');

let server = null;

async function start() {
  const problems = config.validate();
  if (problems.length) {
    for (const p of problems) log.critical(`configuration problem: ${p}`);
    if (config.isProduction) {
      log.critical('refusing to start in production with an invalid configuration');
      process.exit(1);
    }
  }

  const app = createApp();
  server = http.createServer(app);

  // shared hosting: allow long generation runs but drop dead sockets
  server.requestTimeout = 0;
  server.headersTimeout = 65000;
  server.keepAliveTimeout = 61000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  log.info('server listening', {
    url: config.appUrl,
    bind: `${config.host}:${config.port}`,
    env: config.env,
    market: `${config.market.label} ONLY`,
    oddsWindow: `${config.odds.minTotalOdds.toFixed(2)}-${config.odds.maxTotalOdds.toFixed(2)}`,
    ticketGeneration: 'MANUAL ONLY',
  });

  // database reachability (non fatal: the API reports a degraded state)
  db.ping()
    .then(() => log.info('database connection ok'))
    .catch((err) => log.error('database connection failed', { message: err.message, hint: 'check DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env' }));

  scheduler.start();

  return server;
}

async function shutdown(signal) {
  log.info('shutting down', { signal });
  scheduler.stop();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await db.closePool().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.critical('unhandled rejection', { message: reason && reason.message ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  log.critical('uncaught exception', { message: err.message, stack: err.stack });
  // keep the process alive on shared hosting; the request already failed
});

if (require.main === module) {
  start().catch((err) => {
    log.critical('unable to start server', { message: err.message });
    process.exit(1);
  });
}

module.exports = { start, shutdown };
