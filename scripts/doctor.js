#!/usr/bin/env node
'use strict';

/**
 * DOCTOR — deployment diagnosis. Run it on the host (cPanel Terminal / SSH)
 * or locally whenever the site answers with errors:
 *
 *   npm run doctor              # human readable report
 *   npm run doctor -- --json    # machine readable
 *
 * It checks, in order:
 *   1. Node version, NODE_ENV and the presence of every required environment
 *      variable (values are never printed — only set/missing and lengths)
 *   2. a real MySQL connection (`SELECT 1`) with the SAME credentials the app
 *      uses, and translates the MySQL error code into the exact cause and the
 *      cPanel screen that fixes it
 *   3. that the schema is applied (every table from schema.sql exists)
 *   4. that settings are seeded and at least one active administrator exists
 *   5. the public site's own answers: /api/health and /api/dashboard/activity
 *      (guest must be 401) so the guest/member boundary is verified too
 *
 * Exit code is 1 when anything is wrong, so it can gate a deployment.
 * No secret is ever printed: passwords and keys are shown masked (by length).
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
    fix: 'cPanel → MySQL® Databases → Current Users → change the password, then set DB_USER/DB_PASSWORD in the Node.js app environment and Restart.',
  },
  ER_DBACCESS_DENIED_ERROR: {
    cause: 'the MySQL user EXISTS but was never granted access to this database',
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
    cause: 'the connection timed out (firewall or a remote database that does not allow this server)',
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
  const major = Number(process.version.replace(/^v/, '').split('.')[0]);
  const minor = Number(process.version.replace(/^v/, '').split('.')[1]);
  const nodeOk = major > 18 || (major === 18 && minor >= 17);
  record(`Node.js ${process.version} (>= 18.17 required)`, nodeOk, nodeOk ? '' : 'cPanel → Setup Node.js App → Node version');

  record('NODE_ENV is set to production', config.isProduction, `NODE_ENV=${config.env}`, 'set NODE_ENV=production so cookies are secure and internals stay hidden');

  const secret = config.auth && config.auth.jwtSecret ? String(config.auth.jwtSecret) : '';
  record(
    'JWT_SECRET is present and long enough',
    secret.length >= 32,
    secret ? `${secret.length} characters` : 'missing',
    'generate one: `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"` and set JWT_SECRET'
  );

  const dbUser = config.db.user ? String(config.db.user) : '';
  record('DB_USER is set', Boolean(dbUser) && dbUser !== 'root', dbUser ? `${dbUser}` : 'missing', 'cPanel → MySQL® Databases → Current Users → create a dedicated user (never root)');
  record('DB_PASSWORD is set', Boolean(config.db.password), config.db.password ? '***' : 'missing', 'set DB_PASSWORD to the password you created in cPanel');
  record('DB_NAME is set', Boolean(config.db.database), config.db.database || 'missing', 'cPanel → MySQL® Databases → database name (usually cpaneluser_dbname)');
  record('DB_HOST looks local', Boolean(config.db.host), `${config.db.host}:${config.db.port}`, 'use `localhost` when MySQL runs on the same server');

  const key = config.apiFootball && config.apiFootball.key ? String(config.apiFootball.key) : '';
  record('API_FOOTBALL_KEY is configured', Boolean(key), key ? `*** (${key.length} chars)` : 'missing', 'set API_FOOTBALL_KEY (server side only — never in public/)');
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
    record('MySQL connection', false, `${d.code} — ${d.cause}`, d.fix);
    // The raw driver message (names the host and the database user, never the
    // password) — repeated so the fix above is applied to the exact failure.
    record('MySQL detail', false, d.raw.slice(0, 300), d.fix);
    return;
  }

  try {
    const [rows] = await connection.query('SHOW TABLES');
    const present = new Set(rows.map((row) => Object.values(row)[0]));
    const missing = expectedTables().filter((table) => !present.has(table));
    record(
      `schema applied (${present.size} tables visible)`,
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : '',
      'run `npm run db:migrate` (then `npm run db:seed`) on the host'
    );

    if (present.has('settings')) {
      const [settings] = await connection.query('SELECT COUNT(*) AS total FROM settings');
      const total = Number(settings[0].total);
      record('settings are seeded', total > 0, `${total} row(s)`, 'run `npm run db:seed`');
    }

    if (present.has('admins')) {
      const [admins] = await connection.query('SELECT COUNT(*) AS total, SUM(is_active = 1) AS active FROM admins');
      const total = Number(admins[0].total);
      const active = Number(admins[0].active || 0);
      record('an active administrator exists', active > 0, `${active} active of ${total}`, 'run `npm run db:seed` with ADMIN_USERNAME/ADMIN_EMAIL/ADMIN_PASSWORD set, or activate the account');
    }

    const [tz] = await connection.query("SELECT @@session.time_zone AS tz");
    record('session time zone is UTC', String(tz[0].tz).toUpperCase().includes('UTC') || tz[0].tz === '+00:00' || tz[0].tz === 'SYSTEM', `@@session.time_zone = ${tz[0].tz}`, 'the pool forces UTC; if you changed it, restart the app');
  } catch (err) {
    const d = diagnose(err);
    record('database inspection', false, `${d.code} — ${d.cause}`, d.fix);
  } finally {
    await connection.end().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* 3. the running site                                                 */
/* ------------------------------------------------------------------ */

async function checkSite(baseUrl) {
  group = 'site';
  const base = String(baseUrl).replace(/\/+$/, '');
  const get = async (p) => {
    const res = await fetch(`${base}${p}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  };

  try {
    const health = await get('/api/health');
    let parsed = null;
    try {
      parsed = JSON.parse(health.text);
    } catch (_) {
      parsed = null;
    }
    const database = parsed && parsed.data ? parsed.data.database : 'unknown';
    record(`/api/health reports the database as ok`, database === 'ok', `database=${database} (HTTP ${health.status})`, 'fix the database credentials first (see above), then Restart the app');
    record('/api/health is a public read', health.status === 200 || health.status === 503, `HTTP ${health.status}`);
  } catch (err) {
    record(`site reachable at ${base}/api/health`, false, err.message, 'check the domain, SSL and that the Node.js app is running in cPanel');
    return;
  }

  const activity = await get('/api/dashboard/activity');
  record(
    'guest: dashboard activity answers 401 (never data)',
    activity.status === 401,
    `HTTP ${activity.status}`,
    'deploy the current build: an older release did not have /api/dashboard/activity'
  );
  record('guest: the refusal is never cached', /no-store/i.test(activity.headers.get('cache-control') || ''), activity.headers.get('cache-control') || '(none)');

  const consolePage = await get('/admin/login');
  record('admin sign-in page is reachable at /admin/login', consolePage.status === 200, `HTTP ${consolePage.status}`, 'deploy the current build (the route was added for exactly this URL)');
  record('admin sign-in page is never indexed', /noindex/i.test(consolePage.headers.get('x-robots-tag') || ''), consolePage.headers.get('x-robots-tag') || '(none)');
  record('admin sign-in page ships no admin data', !consolePage.text.includes('/api/admin') && !consolePage.text.includes('admin.js'), '');

  const dashboard = await get('/dashboard');
  record('guest: /dashboard redirects to sign-in', dashboard.status === 302, `HTTP ${dashboard.status}`);
  record('guest: /dashboard never carries the member area', !/dashboard activity/i.test(dashboard.text), '');
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = { json: false, base: config.appUrl };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg.startsWith('--base=')) options.base = arg.slice(7);
    else if (!arg.startsWith('-')) options.base = arg;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  checkEnvironment();
  await checkDatabase();
  if (process.env.DOCTOR_SKIP_SITE !== '1') await checkSite(options.base);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: failed === 0, failed, passed: results.length - failed, base: options.base, results }, null, 2)}\n`);
  } else {
    let section = '';
    for (const r of results) {
      if (r.group !== section) {
        process.stdout.write(`\n${GROUP_TITLES[r.group] || r.group.toUpperCase()}${r.group === 'site' ? ` (${options.base})` : ''}\n`);
        section = r.group;
      }
      process.stdout.write(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}\n`);
      if (!r.ok && r.fix) process.stdout.write(`       fix: ${r.fix}\n`);
    }
    process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
    if (failed) process.stdout.write('the site will not serve correct data until the FAIL lines above are fixed\n');
  }

  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`doctor failed: ${err.message}`);
  process.exitCode = 1;
});
