'use strict';

/**
 * SCHEMA DRIFT — the regression suite for the live "/admin/users answers
 * Internal server error" incident.
 *
 * WHAT BROKE
 *   The Users page renders (its guard only reads the `admins` table), but
 *   GET /api/admin/users/summary and GET /api/admin/users both failed with
 *   HTTP 500 and the body `{"error":{"message":"Internal server error"}}`.
 *   The cause was a LIVE DATABASE OLDER THAN THE CODE: migration
 *   002-user-approval-system.sql had not been applied, so every statement that
 *   selects `users.status` was refused by MySQL with
 *   ER_BAD_FIELD_ERROR (1054) "Unknown column 'status' in 'field list'".
 *   server/database/connection.js wrapped that into an AppError with
 *   `expose: !config.isProduction`, so in production the browser only ever saw
 *   "Internal server error" — true, but useless to the operator.
 *
 * WHAT THIS PROVES
 *   1. the failure is reproduced through the REAL query layer (only the MySQL
 *      wire protocol is simulated, with the exact error a 5.7/10.3 server
 *      returns) — not through a re-implementation of the logic;
 *   2. the response still FAILS (no empty 200, the root cause is never hidden)
 *      but carries the stable code SCHEMA_OUT_OF_DATE and a message that says
 *      exactly what to run;
 *   3. the exact missing column is in the server log, and no SQL, table name,
 *      credential, token or cookie is in the response;
 *   4. the transaction path (approve / reject / suspend / reactivate) is
 *      reported the same way;
 *   5. other SQL failures stay opaque — this did not turn into a general SQL
 *      error leak;
 *   6. `npm run doctor` detects the missing COLUMNS, not just missing tables.
 */

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'schema-drift-test-secret-0123456789abcdef';
process.env.DB_HOST = 'localhost';
process.env.DB_USER = 'cpanel_app';
process.env.DB_PASSWORD = 'hunter2-not-a-real-password';
process.env.DB_NAME = 'cpanel_goalpredict';
delete process.env.API_FOOTBALL_KEY;

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const connection = require('../server/database/connection');
const { createApp } = require('../server/app');
const auth = require('../server/middleware/auth');

const ADMIN_ROW = {
  id: 1,
  email: 'admin@live.local',
  username: 'admin',
  password_hash: bcrypt.hashSync('not-used-here', 4),
  role: 'superadmin',
  is_active: 1,
  failed_logins: 0,
  locked_until: null,
  must_change_password: 0,
  last_login_at: null,
  last_login_ip: null,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};

/** A MySQL error exactly as mysql2 surfaces it. */
function driverError(code, errno, sqlMessage, sqlState) {
  const err = new Error(sqlMessage);
  err.code = code;
  err.errno = errno;
  err.sqlMessage = sqlMessage;
  err.sqlState = sqlState;
  return err;
}

const NO_STATUS_COLUMN = () =>
  driverError('ER_BAD_FIELD_ERROR', 1054, "Unknown column 'status' in 'field list'", '42S22');
/** The same account as the live database would return once 002 is applied. */
const USER_ROW = {
  id: 55,
  username: 'approvedann',
  full_name: 'Ann Approved',
  email: 'approved@live.local',
  role: 'user',
  status: 'approved',
  is_active: 1,
  approved_at: '2026-10-05 09:00:00',
  approved_by_admin_id: 1,
  status_reason: null,
  status_changed_at: '2026-10-05 09:00:00',
  last_login_at: '2026-10-05 10:00:00',
  created_at: '2026-10-05 09:00:00',
};

const NO_AUDIT_TABLE = () =>
  driverError('ER_NO_SUCH_TABLE', 1146, "Table 'cpanel_goalpredict.user_audit_logs' doesn't exist", '42S02');

/**
 * A stand-in for the live MySQL server. The `admins` table is healthy (which
 * is why the page itself renders); every statement against `users` fails the
 * way a database without migration 002 fails. `failure` can be swapped to
 * simulate a migrated database or a different error.
 */
function makeStub({ usersFailure = NO_STATUS_COLUMN, auditFailure = NO_AUDIT_TABLE } = {}) {
  const executed = [];
  const stub = {
    executed,
    usersFailure,
    auditFailure,
    async execute(sql) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      executed.push(s);
      if (/^SELECT \* FROM admins WHERE id = \?/.test(s)) return [[ADMIN_ROW], []];
      if (/^SELECT id, email, username, role, is_active/.test(s)) return [[ADMIN_ROW], []];
      if (/^UPDATE users\b/.test(s)) {
        if (stub.usersFailure) throw stub.usersFailure();
        return [{ affectedRows: 1 }, []];
      }
      if (/\bFROM users\b/.test(s) || /\bINTO users\b/.test(s)) {
        if (stub.usersFailure) throw stub.usersFailure();
        // a migrated database: the single-row lookup answers with the account
        return /^SELECT \* FROM users WHERE id = \?/.test(s) ? [[USER_ROW], []] : [[], []];
      }
      if (/\buser_audit_logs\b/.test(s)) {
        if (stub.auditFailure) throw stub.auditFailure();
        return [{ insertId: 7, affectedRows: 1 }, []];
      }
      return [[], []];
    },
    async query(sql) {
      return stub.execute(sql);
    },
    async getConnection() {
      return {
        ping: async () => {},
        release() {},
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        execute: async (sql, params) => stub.execute(sql, params),
      };
    },
    async end() {},
  };
  return stub;
}

let server;
let base;
let adminBearer;
let stub;
const stderrLines = [];
let realStderrWrite;

/** Capture what the logger writes to stderr (where cPanel collects app logs). */
function captureStderr() {
  stderrLines.length = 0;
  realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrLines.push(String(chunk));
    return realStderrWrite(chunk, ...rest);
  };
}

function restoreStderr() {
  if (realStderrWrite) {
    process.stderr.write = realStderrWrite;
    realStderrWrite = null;
  }
  return stderrLines.join('');
}

async function request(method, urlPath, { body = null } = {}) {
  const headers = { Authorization: `Bearer ${adminBearer}`, Accept: 'application/json' };
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: res.status, text, json };
}

before(async () => {
  stub = makeStub();
  mock.method(mysql, 'createPool', () => stub);
  adminBearer = auth.signToken({ sub: ADMIN_ROW.id, type: 'admin', role: ADMIN_ROW.role, username: ADMIN_ROW.username });
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  restoreStderr();
  if (server) await new Promise((resolve) => server.close(resolve));
  mock.restoreAll();
  await connection.closePool();
});

test('the production failure is real: the admin guard passes and only the users queries fail', async () => {
  captureStderr();
  const res = await request('GET', '/api/admin/users/summary');
  restoreStderr();

  // the admins table answered, so the page and its guard work
  assert.ok(stub.executed.some((s) => /FROM admins WHERE id = \?/.test(s)), 'the admin account was re-read');
  assert.equal(res.status, 500, 'the summary request genuinely fails — it must not be turned into an empty 200');
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, 'SCHEMA_OUT_OF_DATE', 'a stable, machine readable code replaces the anonymous 500');
});

test('every users endpoint names the fix instead of "Internal server error"', async () => {
  const endpoints = [
    ['GET', '/api/admin/users/summary'],
    ['GET', '/api/admin/users?page=1&limit=20'],
    ['GET', '/api/admin/users/55'],
  ];
  for (const [method, urlPath] of endpoints) {
    const res = await request(method, urlPath);
    assert.equal(res.status, 500, `${urlPath} still fails`);
    assert.equal(res.json.error.code, 'SCHEMA_OUT_OF_DATE', `${urlPath} reports schema drift`);
    assert.match(res.json.error.message, /npm run db:migrate/, `${urlPath} tells the operator what to run`);
    assert.doesNotMatch(res.json.error.message, /Internal server error/, `${urlPath} is no longer anonymous`);
  }
});

test('the administrative action endpoints report schema drift through the transaction path too', async () => {
  const res = await request('POST', '/api/admin/users/55/approve', { body: {} });
  assert.equal(res.status, 500, 'the approval still fails loudly');
  assert.equal(res.json.error.code, 'SCHEMA_OUT_OF_DATE');
  assert.match(res.json.error.message, /npm run db:migrate/);
});

test('a missing table is reported the same way (user_audit_logs predates migration 002)', async () => {
  stub.usersFailure = null; // migrated `users`, but the audit table is absent
  captureStderr();
  const res = await request('GET', '/api/admin/users/55');
  const log = restoreStderr();
  stub.usersFailure = NO_STATUS_COLUMN;

  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, 'SCHEMA_OUT_OF_DATE');
  assert.match(log, /user_audit_logs/, 'the log names the missing table');
});

test('the response leaks no SQL, schema identifiers or credentials — the log carries them', async () => {
  captureStderr();
  const res = await request('GET', '/api/admin/users/summary');
  const log = restoreStderr();

  for (const secret of ['hunter2-not-a-real-password', 'cpanel_app', 'SELECT', 'FROM users', 'status', 'cpanel_goalpredict', 'stack']) {
    assert.ok(!res.text.includes(secret), `the browser never sees "${secret}"`);
  }
  assert.ok(!('details' in res.json.error), 'production responses carry no internal details');

  // the root cause is NOT hidden: it is in the server log, with the fix hint
  assert.match(log, /database schema is out of date/);
  assert.match(log, /ER_BAD_FIELD_ERROR/);
  assert.match(log, /Unknown column 'status' in 'field list'/);
  assert.match(log, /column: status/);
  assert.match(log, /npm run db:migrate/);
  assert.ok(!log.includes('hunter2-not-a-real-password'), 'the password is never logged');
});

test('other SQL failures stay opaque — this is not a general error leak', async () => {
  stub.usersFailure = () => driverError('ER_LOCK_DEADLOCK', 1213, 'Deadlock found when trying to get lock', '40001');
  const res = await request('GET', '/api/admin/users/summary');
  stub.usersFailure = NO_STATUS_COLUMN;

  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, 'SQL_ER_LOCK_DEADLOCK');
  assert.equal(res.json.error.message, 'Internal server error', 'an unrelated SQL error is still hidden in production');
  assert.ok(!res.text.includes('Deadlock'), 'the driver message does not reach the browser');
});

test('connection.toAppError maps each driver error to the right contract', () => {
  const schemaError = connection.toAppError(NO_STATUS_COLUMN(), 'SELECT status FROM users');
  assert.equal(schemaError.status, 500);
  assert.equal(schemaError.code, 'SCHEMA_OUT_OF_DATE');
  assert.equal(schemaError.expose, true, 'safe in production: the message contains no SQL or identifier');
  assert.equal(schemaError.details, null, 'no details are attached in production');

  const missingTable = connection.describeSchemaError(NO_AUDIT_TABLE());
  assert.deepEqual(missingTable, { kind: 'table', object: 'cpanel_goalpredict.user_audit_logs' });
  assert.deepEqual(connection.describeSchemaError(NO_STATUS_COLUMN()), { kind: 'column', object: 'status' });
  assert.deepEqual(connection.describeSchemaError(driverError('ER_BAD_TABLE_ERROR', 1051, "Unknown table 'users'", '42S02')), {
    kind: 'table',
    object: 'users',
  });

  const unrelated = connection.toAppError(driverError('ER_PARSE_ERROR', 1064, "You have an error in your SQL syntax", '42000'), 'SELECT 1');
  assert.equal(unrelated.code, 'SQL_ER_PARSE_ERROR');
  assert.equal(unrelated.expose, false, 'unrelated SQL errors stay hidden in production');
});

test('doctor detects missing COLUMNS, not just missing tables', () => {
  // A database that never received migration 002 still HAS a `users` table, so
  // the old table-only check reported "schema applied" while every users query
  // failed. The column map is what makes `npm run doctor` tell the truth.
  const doctor = require('../scripts/doctor');
  const schema = doctor.expectedSchema();

  assert.ok(Object.keys(schema).length >= 18, 'every table in schema.sql is parsed');
  for (const column of ['status', 'full_name', 'approved_at', 'approved_by_admin_id', 'status_reason', 'status_changed_at']) {
    assert.ok(schema.users.includes(column), `users.${column} is expected on a current database`);
  }
  assert.deepEqual(Object.keys(schema).includes('user_audit_logs') && schema.user_audit_logs, [
    'id',
    'user_id',
    'admin_id',
    'action',
    'previous_status',
    'new_status',
    'reason',
    'ip_address',
    'user_agent',
    'created_at',
  ]);
});

/* ------------------------------------------------------------------ */
/* `npm run doctor` against a simulated live database                   */
/* ------------------------------------------------------------------ */

/**
 * A read-only stand-in for the cPanel MySQL server, answering only the
 * statements `doctor` issues. `drifted` reproduces the incident: a `users`
 * table from before migration 002, no `user_audit_logs`, no migration ledger.
 */
function fakeMysql({ drifted }) {
  const migrate = require('../server/database/migrate');
  const doctor = require('../scripts/doctor');
  const schema = doctor.expectedSchema();
  const PRE_002_USERS = ['id', 'email', 'username', 'password_hash', 'role', 'is_active',
    'failed_logins', 'locked_until', 'last_login_at', 'last_login_ip', 'created_at', 'updated_at'];

  // `schema_migrations` is created by the runner, not by schema.sql. A live
  // database that received 001 has the ledger with 001 recorded and 002 pending
  // — exactly the state of the incident.
  const tables = [
    ...Object.keys(schema).filter((t) => !(drifted && t === 'user_audit_logs')),
    'schema_migrations',
  ];
  const columnsFor = (table) => (drifted && table === 'users' ? PRE_002_USERS : schema[table] || []);

  return async function createConnection() {
    return {
      // every statement doctor issues is parameter-free, so params are unused
      async query(sql) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/^SELECT 1/.test(s)) return [[{ 1: 1 }], []];
        if (/^SHOW TABLES/.test(s)) return [tables.map((t) => ({ Tables_in_db: t })), []];
        const columns = /^SHOW COLUMNS FROM `(\w+)`/.exec(s);
        if (columns) return [columnsFor(columns[1]).map((Field) => ({ Field })), []];
        if (/^SELECT setting_key FROM settings/.test(s)) return [[{ setting_key: 'min_confidence' }], []];
        if (/FROM admins WHERE is_active = 1/.test(s)) return [[{ total: 1 }], []];
        if (/^CREATE TABLE IF NOT EXISTS `schema_migrations`/.test(s)) return [[], []];
        if (/FROM `schema_migrations`/.test(s)) {
          const fs = require('node:fs');
          const row = (file) => ({
            filename: file.filename,
            checksum: migrate.checksum(fs.readFileSync(file.path, 'utf8')),
            applied_at: '2026-10-10 09:00:00',
          });
          const files = migrate.listMigrationFiles();
          // drifted: only 001 is recorded, 002 is still pending
          return [drifted ? files.filter((f) => f.sequence < 2).map(row) : files.map(row), []];
        }
        return [[], []];
      },
      async end() {},
    };
  };
}

test('doctor fails a database that never received migration 002 — the old table-only check said OK', async () => {
  const doctor = require('../scripts/doctor');
  doctor.resetResults();
  await doctor.checkDatabase(fakeMysql({ drifted: true }));
  const report = doctor.getResults();

  const byName = (needle) => report.find((r) => r.name.includes(needle));
  const columns = byName('every expected column exists');
  assert.ok(columns, 'the column check ran');
  assert.equal(columns.ok, false, 'a pre-002 database must fail the column check');
  for (const missing of ['status', 'full_name', 'approved_at', 'approved_by_admin_id', 'status_reason', 'status_changed_at']) {
    assert.ok(columns.detail.includes(missing), `the report names users.${missing}`);
  }
  assert.match(columns.fix, /npm run db:migrate/, 'the report says how to fix it');

  const tables = byName('schema applied');
  assert.equal(tables.ok, false, 'the missing user_audit_logs table is reported');
  assert.match(tables.detail, /user_audit_logs/);

  const migrations = byName('versioned migrations');
  assert.equal(migrations.ok, false, 'the pending migration is reported');
  assert.match(migrations.detail, /002-user-approval-system\.sql/);
});

test('doctor passes a fully migrated database', async () => {
  const doctor = require('../scripts/doctor');
  doctor.resetResults();
  await doctor.checkDatabase(fakeMysql({ drifted: false }));
  const report = doctor.getResults();

  for (const name of ['every expected column exists', 'schema applied', 'versioned migrations']) {
    const row = report.find((r) => r.name.includes(name));
    assert.ok(row, `${name} was checked`);
    assert.equal(row.ok, true, `${name} passes on a current database (${row.detail})`);
  }
  assert.equal(report.filter((r) => !r.ok).length, 0, 'a healthy database produces no failures');
});

test('the phpMyAdmin runbook cannot drift from the migration it tells the operator to paste', async () => {
  // This deployment has no Terminal: docs/DEPLOYMENT-CPANEL.md §9b IS the
  // deployment tool. A stale checksum or a rewritten column definition in the
  // documented SQL would be applied straight to the live database, so both are
  // pinned to the shipped artefacts.
  const fs = require('node:fs');
  const path = require('node:path');
  const migrate = require('../server/database/migrate');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'DEPLOYMENT-CPANEL.md'), 'utf8');
  const migration = fs.readFileSync(path.join(migrate.MIGRATIONS_DIR, '002-user-approval-system.sql'), 'utf8');
  const norm = (text) => String(text).replace(/\s+/g, ' ').trim();

  assert.ok(doc.includes('9b.'), 'the no-Terminal runbook section exists');
  assert.ok(!/## 9b[\s\S]*?npm run db:migrate[\s\S]*?## 10\./.test(doc), 'the runbook never requires a Terminal');

  // the ledger DDL the operator pastes must be the runner's own definition
  assert.ok(norm(doc).includes(norm(migrate.MIGRATIONS_TABLE_SQL)), 'the schema_migrations DDL matches migrate.js');

  // the checksum the operator inserts must be the checksum of the shipped file
  assert.ok(doc.includes(migrate.checksum(migration)), 'the documented checksum is the current one');

  // the "only some columns are missing" fallback must define `status` exactly
  // as migration 002 does, or a manual repair would diverge from the baseline
  const shipped = norm(/ADD COLUMN `status`[\s\S]*?AFTER `is_active`/.exec(migration)[0]);
  const documented = norm(/ADD COLUMN `status`[\s\S]*?AFTER `is_active`/.exec(doc)[0]);
  assert.equal(documented, shipped, 'the documented fallback ALTER matches migration 002');
});
