'use strict';

/**
 * Versioned migration engine.
 *
 * `schema.sql` stays the idempotent BASELINE (safe to re-apply forever).
 * Everything that changes an existing live database afterwards lives in
 * `server/database/migrations/NNN-description.sql`, applied in numeric
 * order exactly once and recorded in the `schema_migrations` table.
 *
 * The functions here are pure / dependency-injected so the planner can be
 * unit tested without MySQL; scripts/db-migrate.js wires in the real
 * connection.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** NNN-anything.sql (three or more digits, dash or underscore separator). */
const FILENAME_RE = /^(\d{3,})[-_][\w.-]+\.sql$/;

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS \`schema_migrations\` (
  \`filename\`   VARCHAR(255) NOT NULL,
  \`checksum\`   CHAR(64)     NOT NULL,
  \`applied_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`filename\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

function checksum(sqlText) {
  return crypto.createHash('sha256').update(sqlText, 'utf8').digest('hex');
}

/**
 * List migration files in a directory, sorted by numeric prefix.
 * Non-SQL files (README.md, .gitkeep) are ignored; a .sql file that does not
 * match the naming convention or a duplicate sequence number is an error —
 * silently skipping either would mean a migration never runs in production.
 */
function listMigrationFiles(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.sql'));

  const files = entries.map((name) => {
    const match = FILENAME_RE.exec(name);
    if (!match) {
      throw new Error(
        `Migration file "${name}" does not match NNN-description.sql (e.g. 001-add-notify-column.sql)`,
      );
    }
    return { filename: name, sequence: parseInt(match[1], 10), path: path.join(dir, name) };
  });

  files.sort((a, b) => a.sequence - b.sequence || a.filename.localeCompare(b.filename));

  const seen = new Map();
  for (const file of files) {
    if (seen.has(file.sequence)) {
      throw new Error(
        `Duplicate migration sequence ${file.sequence}: "${seen.get(file.sequence)}" and "${file.filename}"`,
      );
    }
    seen.set(file.sequence, file.filename);
  }
  return files;
}

/**
 * Decide what to run.
 * @param {Array<{filename,sequence,path}>} available  files on disk (sorted)
 * @param {Array<{filename,checksum}>}      applied    rows from schema_migrations
 * @param {Object<string,string>}           contents   filename -> SQL text
 * @returns {{ pending: Array, warnings: string[] }}
 */
function plan(available, applied, contents) {
  const appliedByName = new Map(applied.map((row) => [row.filename, row]));
  const availableNames = new Set(available.map((f) => f.filename));
  const warnings = [];

  // An applied migration that disappeared from disk usually means a renamed
  // file — the record would never match again, so say it loudly.
  for (const row of applied) {
    if (!availableNames.has(row.filename)) {
      warnings.push(`applied migration "${row.filename}" no longer exists on disk (renamed or deleted?)`);
    }
  }

  const pending = [];
  let maxApplied = -1;
  for (const file of available) {
    if (appliedByName.has(file.filename)) maxApplied = Math.max(maxApplied, file.sequence);
  }

  for (const file of available) {
    const record = appliedByName.get(file.filename);
    if (record) {
      const current = checksum(contents[file.filename]);
      if (record.checksum !== current) {
        warnings.push(
          `"${file.filename}" was edited AFTER being applied (checksum mismatch) — ` +
            'write a new migration instead of editing an applied one',
        );
      }
      continue;
    }
    if (file.sequence < maxApplied) {
      warnings.push(
        `"${file.filename}" is pending but a later migration was already applied — it will run now, out of order`,
      );
    }
    pending.push(file);
  }

  return { pending, warnings };
}

/**
 * Apply all pending migrations through the given mysql2 connection.
 * Each file runs as one multi-statement batch and is recorded on success.
 * Stops at the first failure so the operator sees exactly where it broke.
 */
async function applyMigrations(connection, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  await connection.query(MIGRATIONS_TABLE_SQL);

  const available = listMigrationFiles(dir);
  const contents = {};
  for (const file of available) contents[file.filename] = fs.readFileSync(file.path, 'utf8');

  const [rows] = await connection.query('SELECT filename, checksum FROM `schema_migrations`');
  const { pending, warnings } = plan(available, rows, contents);

  for (const warning of warnings) log(`WARNING: ${warning}`);

  const appliedNow = [];
  for (const file of pending) {
    const sql = contents[file.filename];
    log(`applying ${file.filename} ...`);
    await connection.query(sql);
    await connection.query('INSERT INTO `schema_migrations` (filename, checksum) VALUES (?, ?)', [
      file.filename,
      checksum(sql),
    ]);
    appliedNow.push(file.filename);
  }

  return { applied: appliedNow, alreadyApplied: rows.length, warnings };
}

/** Read-only view for `db:migrate -- --status`. */
async function migrationStatus(connection, { dir = MIGRATIONS_DIR } = {}) {
  await connection.query(MIGRATIONS_TABLE_SQL);
  const available = listMigrationFiles(dir);
  const contents = {};
  for (const file of available) contents[file.filename] = fs.readFileSync(file.path, 'utf8');
  const [rows] = await connection.query(
    'SELECT filename, checksum, applied_at FROM `schema_migrations` ORDER BY filename',
  );
  const { pending, warnings } = plan(available, rows, contents);
  return { applied: rows, pending, warnings };
}

module.exports = {
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE_SQL,
  checksum,
  listMigrationFiles,
  plan,
  applyMigrations,
  migrationStatus,
};
