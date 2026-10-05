#!/usr/bin/env node
'use strict';

/**
 * Database migration runner.
 *   npm run db:migrate
 * Idempotent: every statement is CREATE TABLE IF NOT EXISTS.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../server/config');

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
    await connection.query(sql);
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
