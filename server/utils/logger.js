'use strict';

/**
 * Minimal structured logger (stdout + optional rotating file).
 * Persistent audit records go to the `system_logs` table via
 * services/logService.js — this logger is for process output only.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, critical: 50, silent: 99 };
const threshold = LEVELS[config.logging.level] || LEVELS.info;

let stream = null;
if (config.logging.file) {
  try {
    const file = path.isAbsolute(config.logging.file)
      ? config.logging.file
      : path.join(config.rootDir, config.logging.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch (err) {
    // never let logging configuration crash the app
    process.stdout.write(`[logger] unable to open log file: ${err.message}\n`);
    stream = null;
  }
}

function write(level, message, meta) {
  if ((LEVELS[level] || 0) < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta && Object.keys(meta).length ? { meta } : {}),
  };
  const text = `${JSON.stringify(line)}\n`;
  const out = level === 'error' || level === 'critical' ? process.stderr : process.stdout;
  try {
    out.write(text);
    if (stream) stream.write(text);
  } catch (_) {
    /* ignore */
  }
}

function scrub(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/key|secret|password|token|authorization|cookie/i.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = scrub(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = {
  debug: (msg, meta) => write('debug', msg, scrub(meta)),
  info: (msg, meta) => write('info', msg, scrub(meta)),
  warn: (msg, meta) => write('warn', msg, scrub(meta)),
  error: (msg, meta) => write('error', msg, scrub(meta)),
  critical: (msg, meta) => write('critical', msg, scrub(meta)),
  child: (channel) => ({
    debug: (msg, meta) => write('debug', msg, { channel, ...scrub(meta || {}) }),
    info: (msg, meta) => write('info', msg, { channel, ...scrub(meta || {}) }),
    warn: (msg, meta) => write('warn', msg, { channel, ...scrub(meta || {}) }),
    error: (msg, meta) => write('error', msg, { channel, ...scrub(meta || {}) }),
  }),
};
