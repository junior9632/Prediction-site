#!/usr/bin/env node
'use strict';

/**
 * Database migration runner.
 *
 *   npm run db:migrate              baseline schema + all pending migrations
 *   npm run db:migrate -- --status  read-only: list applied/pending and exit
 *
 * Two layers:
 *  1. server/database/schema.sql — idempotent baseline (CREATE TABLE IF NOT
 *     EXISTS), re-applied on every run; the source of truth for fresh installs.
 *  2. server/database/migrations/NNN-*.sql — versioned changes for existing
 *     live databases, applied exactly once in order and recorded (with a
 *     SHA-256 checksum) in the `schema_migrations` table.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../server/config');
const migrate = require('../server/database/migrate');

const statusOnly = process.argv.includes('--status');

async function main() {
  const schemaPath = path.join(__dirname, '..', 'server', 'database', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  process.stdout.write(`Connecting to ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}\n`);

  const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
    charset: config.db.charset,
  });

  try {
    if (statusOnly) {
      const status = await migrate.migrationStatus(connection);
      process.stdout.write(`Applied migrations: ${status.applied.length}\n`);
      for (const row of status.applied) {
        process.stdout.write(`  ✔ ${row.filename} (applied ${row.applied_at instanceof Date ? row.applied_at.toISOString() : row.applied_at})\n`);
      }
      process.stdout.write(`Pending migrations: ${status.pending.length}\n`);
      for (const file of status.pending) process.stdout.write(`  … ${file.filename}\n`);
      for (const warning of status.warnings) process.stdout.write(`  WARNING: ${warning}\n`);
      return;
    }

    process.stdout.write('Applying baseline schema (schema.sql) ...\n');
    await connection.query(sql);

    const outcome = await migrate.applyMigrations(connection, {
      log: (line) => process.stdout.write(`  ${line}\n`),
    });
    if (outcome.applied.length === 0) {
      process.stdout.write(`Migrations: nothing pending (${outcome.alreadyApplied} previously applied).\n`);
    } else {
      process.stdout.write(`Migrations applied now: ${outcome.applied.join(', ')}\n`);
    }

    const [tables] = await connection.query('SHOW TABLES');
    process.stdout.write(`Schema applied. Tables present: ${tables.length}\n`);
    for (const row of tables) process.stdout.write(`  - ${Object.values(row)[0]}\n`);
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  process.stderr.write(`Migration failed: ${err.message}\n`);
  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    process.stderr.write('Check DB_USER / DB_PASSWORD / DB_NAME in .env and the cPanel database privileges.\n');
  }
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
    process.stderr.write('Check DB_HOST / DB_PORT. On cPanel this is usually localhost:3306.\n');
  }
  process.exit(1);
});
