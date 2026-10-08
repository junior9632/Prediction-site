#!/usr/bin/env node
'use strict';

/**
 * DOCTOR — deployment diagnosis. Run it on the host (cPanel Terminal / SSH) or
 * locally whenever the site answers with errors:
 *
 *   npm run doctor              # human readable report
 *   npm run doctor -- --json    # machine readable
 *   npm run doctor -- --skip-site   # environment + database only
 *
 * It checks, in order:
 *   1. Node version, NODE_ENV and the presence of every required environment
 *      variable (values are never printed — only set/missing and lengths)
 *   2. a real MySQL connection (`SELECT 1`) with the SAME credentials the app
 *      uses, and translates the MySQL error code into the exact cause and the
 *      cPanel screen that fixes it
 *   3. that the schema is applied (every table from schema.sql exists)
 *   4. that settings are seeded and at least one active administrator exists
 *   5. the running site's own answers: /api/health, /api/meta, and the guest
 *      boundary — every prediction API and the member feed must answer 401,
 *      and every member page must redirect to the sign-in door
 *
 * Exit code is 1 when anything is wrong, so it can gate a deployment.
 * No secret is ever printed: passwords and keys are shown masked, by length.
 */

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const config = require('../server/config');

const ROOT = path.join(__dirname, '..');
const results = [];
let failed = 0;
let group = 'environment';
const GROUP_TITLES = { environment: 'ENVIRONMENT', database: 'DATABASE & SCHEMA', site: 'RUNNING SITE' };

function record(name, ok, detail = '', fix = '') {
  results.push({ group, name, ok: Boolean(ok), detail: String(detail), fix: String(fix) });
  if (!ok) failed += 1;
}

/** MySQL failure -> the actual cause and where it is fixed. */
const DB_DIAGNOSIS = {
  ER_ACCESS_DENIED_ERROR: {
    cause: 'the MySQL user or password is wrong (the server refused the login)',
    fix: 'cPanel → MySQL® Databases → Current Users → change the password, then update DB_USER/DB_PASSWORD in the Node.js app environment and Restart.',
  },
  ER_DBACCESS_DENIED_ERROR: {
    cause: 'the MySQL user exists but was never granted access to this database',
    fix: 'cPanel → MySQL® Databases → Add User To Database → pick the user + the database → ALL PRIVILEGES → Make Changes. This is the most common cause of "SQL_ER_DBACCESS_DENIED_ERROR".',
  },
  ER_BAD_DB_ERROR: {
    cause: 'DB_NAME does not exist on the server',
    fix: 'cPanel → MySQL® Databases → the exact name is usually cpaneluser_dbname. Copy it, update DB_NAME and Restart.',
  },
  ER_NO_SUCH_TABLE: {
    cause: 'the schema was never applied to this database',
    fix: 'run `npm run db:setup` (db:migrate + db:seed) on the host.',
  },
  ECONNREFUSED: {
    cause: 'nothing is listening on DB_HOST:DB_PORT',
    fix: 'on cPanel the database host is almost always `localhost` (not 127.0.0.1 from inside the app). Check DB_HOST/DB_PORT.',
  },
  ENOTFOUND: {
    cause: 'DB_HOST does not resolve',
    fix: 'fix the hostname; use `localhost` for a database on the same server.',
  },
  ETIMEDOUT: {
    cause: 'the connection timed out (firewall, or a remote database that does not allow this server)',
    fix: 'cPanel → Remote MySQL® → add the app server\'s IP; or run the database locally (DB_HOST=localhost).',
  },
  EHOSTUNREACH: {
    cause: 'DB_HOST is not reachable from the app server',
    fix: 'use `localhost` when MySQL runs on the same machine.',
  },
  PROTOCOL_CONNECTION_LOST: {
    cause: 'the connection was dropped by the server (restart, timeout or max_connections)',
    fix: 'check MySQL is running and the connection limit in cPanel; retry.',
  },
};

function diagnose(err) {
  const code = (err && err.code) || 'UNKNOWN';
  const known = DB_DIAGNOSIS[code];
  return {
    code,
    cause: (known && known.cause) || 'an unknown database error',
    fix: (known && known.fix) || 'inspect the app log (stderr) for the full MySQL message.',
    raw: (err && err.message) || String(err),
  };
}

/* ------------------------------------------------------------------ */
/* 1. environment                                                      */
/* ------------------------------------------------------------------ */

function checkEnvironment() {
  group = 'environment';
  const [major, minor] = process.version.replace(/^v/, '').split('.').map(Number);
  const nodeOk = major > 18 || (major === 18 && minor >= 17);
  record(
    `Node.js ${process.version} (>= 18.17 required)`,
    nodeOk,
    nodeOk ? '' : 'too old',
    'cPanel → Setup Node.js App → Node version → pick 18.17+ (22 recommended) and Restart.'
  );

  record(
    'NODE_ENV is set to production',
    config.isProduction,
    `NODE_ENV=${config.env}`,
    'set NODE_ENV=production so secure cookies are enforced and internals stay hidden.'
  );

  const secret = config.auth && config.auth.jwtSecret ? String(config.auth.jwtSecret) : '';
  record(
    'JWT_SECRET is present and long enough (32+)',
    secret.length >= 32,
    secret ? `${secret.length} characters` : 'missing',
    "generate one: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\" and set JWT_SECRET, then Restart."
  );

  const dbUser = config.db.user ? String(config.db.user) : '';
  record('DB_USER is set', Boolean(dbUser) && dbUser !== 'root', dbUser || 'missing', 'cPanel → MySQL® Databases → Current Users → create a dedicated user (never root).');
  record('DB_PASSWORD is set', Boolean(config.db.password), config.db.password ? '*** (set)' : 'missing', 'set DB_PASSWORD to the password created in cPanel.');
  record('DB_NAME is set', Boolean(config.db.database), config.db.database || 'missing', 'cPanel → MySQL® Databases → database name (usually cpaneluser_dbname).');
  record('DB_HOST looks local', Boolean(config.db.host), `${config.db.host}:${config.db.port}`, 'use `localhost` when MySQL runs on the same server.');

  const key = config.apiFootball && config.apiFootball.key ? String(config.apiFootball.key) : '';
  record(
    'API_FOOTBALL_KEY is configured',
    Boolean(key),
    key ? `*** (${key.length} chars)` : 'missing',
    'set API_FOOTBALL_KEY (server side only — it must never appear in public/).'
  );
}

/* ------------------------------------------------------------------ */
/* 2. database + schema + seed                                         */
/* ------------------------------------------------------------------ */

function expectedTables() {
  const sql = fs.readFileSync(path.join(ROOT, 'server', 'database', 'schema.sql'), 'utf8');
  const tables = [];
  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?/gi)) tables.push(match[1]);
  return tables;
}

async function checkDatabase() {
  group = 'database';
  let connection;
  try {
    connection = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      connectTimeout: 8000,
      charset: 'utf8mb4_unicode_ci',
    });
    await connection.query('SELECT 1');
    record(`MySQL connection to ${config.db.host}:${config.db.port}/${config.db.database}`, true, `user ${config.db.user}`);
  } catch (err) {
    const d = diagnose(err);
    record(`MySQL connection to ${config.db.host}:${config.db.port}/${config.db.database}`, false, `${d.code}: ${d.cause}`, d.fix);
    record('schema applied', false, 'not checked — no database connection', 'fix the connection first, then re-run `npm run doctor`.');
    record('settings seeded', false, 'not checked — no database connection', 'fix the connection first, then re-run `npm run doctor`.');
    record('an active administrator exists', false, 'not checked — no database connection', 'fix the connection first, then re-run `npm run doctor`.');
    return;
  }

  try {
    const expected = expectedTables();
    const [rows] = await connection.query('SHOW TABLES');
    const present = rows.map((row) => Object.values(row)[0]);
    const missing = expected.filter((table) => !present.includes(table));
    record(
      `schema applied (${expected.length} tables)`,
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `${present.length} tables present`,
      'run `npm run db:migrate` on the host (it applies schema.sql + any pending migrations).'
    );
  } catch (err) {
    const d = diagnose(err);
    record('schema applied', false, `${d.code}: ${d.cause}`, d.fix);
  }

  try {
    const [rows] = await connection.query('SELECT setting_key FROM settings');
    const seeded = rows.length;
    record(
      'settings seeded',
      seeded > 0,
      `${seeded} row(s)`,
      'run `npm run db:seed` — it writes every setting and creates the first administrator from ADMIN_USERNAME/ADMIN_PASSWORD.'
    );
  } catch (err) {
    const d = diagnose(err);
    record('settings seeded', false, `${d.code}: ${d.cause}`, d.fix);
  }

  try {
    const [rows] = await connection.query('SELECT COUNT(*) AS total FROM admins WHERE is_active = 1');
    const total = Number((rows[0] || {}).total || 0);
    record(
      'an active administrator exists',
      total > 0,
      `${total} active administrator(s)`,
      'run `npm run db:seed` with ADMIN_USERNAME/ADMIN_EMAIL/ADMIN_PASSWORD set, or re-activate the account in MySQL.'
    );
  } catch (err) {
    const d = diagnose(err);
    record('an active administrator exists', false, `${d.code}: ${d.cause}`, d.fix);
  }

  await connection.end();
}

/* ------------------------------------------------------------------ */
/* 3. the running site                                                 */
/* ------------------------------------------------------------------ */

async function checkSite() {
  group = 'site';
  const base = (process.env.DOCTOR_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, '');
  const timeoutMs = Number(process.env.DOCTOR_TIMEOUT_MS || 8000);

  async function get(path, { redirect = 'manual' } = {}) {
    const res = await fetch(`${base}${path}`, { redirect, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  try {
    const health = await get('/api/health');
    const ok = health.status === 200 && health.json && health.json.ok === true;
    const data = (health.json && health.json.data) || {};
    record(
      `GET /api/health (${base})`,
      ok,
      ok ? `status=${data.status} database=${data.database} source=${data.dataSource ? data.dataSource.state : '?'}` : `got ${health.status}`,
      'the process is not serving: check the cPanel Node.js app log and that the startup file is server.js.'
    );
  } catch (err) {
    record(`GET /api/health (${base})`, false, err.message, 'nothing answered: is the Node.js app running (cPanel → Setup Node.js App)?');
  }

  try {
    const meta = await get('/api/meta');
    const configured = meta.json && meta.json.data && meta.json.data.dataSource && meta.json.data.dataSource.configured;
    record('GET /api/meta reports the data source', meta.status === 200, `got ${meta.status}`, 'check the app log for the failure.');
    record(
      'API-Football key is visible to the server',
      Boolean(configured),
      configured ? 'configured' : 'not configured',
      'set API_FOOTBALL_KEY in the app environment and Restart. Without it every generation ends DATA_SOURCE_UNAVAILABLE (never a fabricated ticket).'
    );
  } catch (err) {
    record('GET /api/meta reports the data source', false, err.message, 'nothing answered on /api/meta.');
  }

  // The guest boundary on the member API: a site that answers 200 here leaks.
  try {
    const guest = await get('/api/dashboard/activity');
    record(
      'guest: /api/dashboard/activity is 401',
      guest.status === 401,
      `got ${guest.status}`,
      'do not deploy: the member feed must never answer a visitor. Check that routes/dashboard.js is mounted behind requireAuth.'
    );
  } catch (err) {
    record('guest: /api/dashboard/activity is 401', false, err.message, 'nothing answered — the app may not be running.');
  }

  // The guest boundary on the PREDICTION surface. Football predictions, odds,
  // tickets, fixtures and analytics are login-only; a 200 here means the
  // deployed build is publishing the product to the whole internet.
  for (const url of ['/api/predictions', '/api/ticket/today', '/api/tickets/history', '/api/analytics', '/api/fixtures', '/api/odds']) {
    try {
      const res = await get(url);
      record(
        `guest: ${url} is 401`,
        res.status === 401,
        `got ${res.status}`,
        `do not deploy: ${url} must never answer a visitor. Check that the router mounts memberApiGuard from middleware/account.js.`
      );
    } catch (err) {
      record(`guest: ${url} is 401`, false, err.message, 'nothing answered — the app may not be running.');
    }
  }

  // ... and the pages that render them must redirect instead of serving data.
  for (const url of ['/predictions', '/ticket', '/history', '/analytics']) {
    try {
      const res = await get(url);
      const location = res.headers.get('location') || '';
      record(
        `guest: ${url} redirects to sign-in`,
        res.status === 302 && location.startsWith('/login'),
        `got ${res.status}${location ? ` -> ${location}` : ''}`,
        `do not deploy: ${url} must redirect a visitor instead of serving the page. Check the page guards in server/app.js.`
      );
    } catch (err) {
      record(`guest: ${url} redirects to sign-in`, false, err.message, 'nothing answered — the app may not be running.');
    }
  }

  try {
    const dashboard = await get('/dashboard');
    record(
      'guest: /dashboard redirects to sign-in',
      dashboard.status === 302,
      `got ${dashboard.status}`,
      'do not deploy: the member page must redirect a visitor instead of serving content.'
    );
  } catch (err) {
    record('guest: /dashboard redirects to sign-in', false, err.message, 'nothing answered — the app may not be running.');
  }
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

function printReport(asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: failed === 0, failed, results }, null, 2)}\n`);
    return;
  }

  let current = null;
  for (const r of results) {
    if (r.group !== current) {
      current = r.group;
      process.stdout.write(`\n${GROUP_TITLES[current] || current.toUpperCase()}\n`);
    }
    process.stdout.write(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}${r.detail ? `  —  ${r.detail}` : ''}\n`);
    if (!r.ok && r.fix) process.stdout.write(`        fix: ${r.fix}\n`);
  }

  process.stdout.write(
    failed === 0
      ? '\nEverything checked out.\n'
      : `\n${failed} problem(s) found — fix the items marked FAIL above.\n`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const skipSite = argv.includes('--skip-site') || process.env.DOCTOR_SKIP_SITE === '1';

  checkEnvironment();
  await checkDatabase();
  if (!skipSite) await checkSite();

  printReport(asJson);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`doctor failed: ${err.message}\n`);
  process.exitCode = 1;
});
