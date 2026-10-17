#!/usr/bin/env node
'use strict';

/**
 * cPanel "Application startup file".
 *
 *   node server.js
 *
 * Everything else lives in ./server (app, routes, services, prediction engine).
 */

require('dotenv').config();

const { start } = require('./server/server');
const logger = require('./server/utils/logger');

const log = logger.child('bootstrap');

start().catch((err) => {
  log.critical('startup failed', { message: err && err.message ? err.message : String(err) });
  process.exit(1);
});
