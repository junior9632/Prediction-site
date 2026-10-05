#!/usr/bin/env node
'use strict';

/**
 * SQL STATIC VALIDATOR — no database required.
 *
 *   npm run test:sql
 *
 * It reads server/database/schema.sql and server/database/queries.js and checks:
 *   1. every table referenced by a query exists in the schema
 *   2. every column named in an INSERT exists on that table
 *   3. no query interpolates a value into SQL (only `?` placeholders, the
 *      validated `db.limitClause(...)` helper and generated `?` lists)
 *   4. the schema itself is sane: primary keys, InnoDB + utf8mb4, and the
 *      unique keys the upserts rely on
 *
 * Exits non-zero when a check fails, so it can run in CI next to `npm test`.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'server', 'database', 'schema.sql');
const QUERIES_PATH = path.join(ROOT, 'server', 'database', 'queries.js');

const errors = [];
const warnings = [];

/* ------------------------------------------------------------------ */
/* schema                                                              */
/* ------------------------------------------------------------------ */

function parseSchema(sql) {
  const tables = new Map();
  const blocks = sql.split(/CREATE TABLE IF NOT EXISTS/i).slice(1);
  for (const block of blocks) {
    const name = (block.match(/^\s*`?(\w+)`?\s*\(/) || [])[1];
    if (!name) continue;
    const body = block.slice(block.indexOf('(') + 1);
    const columns = new Set();
    let primaryKey = null;
    const unique = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue; // blank lines inside the column list
      if (line.startsWith(')') || /^ENGINE=/i.test(line)) break;
      const column = line.match(/^`(\w+)`\s+/);
      if (column) columns.add(column[1]);
      const pk = line.match(/^PRIMARY KEY \(`(\w+)`/);
      if (pk) primaryKey = pk[1];
      const uq = line.match(/^UNIQUE KEY `\w+` \(([^)]+)\)/);
      if (uq) unique.push(uq[1].replace(/`/g, '').split(',').map((c) => c.trim()));
    }
    tables.set(name, { columns, primaryKey, unique, engine: /ENGINE=InnoDB/i.test(block), utf8mb4: /utf8mb4/i.test(block) });
  }
  return tables;
}

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve the static column-list constants (`${FIXTURE_COLUMNS}`) so INSERT
 * statements can be checked column by column.
 */
function resolveColumnConstants(source) {
  let resolved = source;
  const constant = /const\s+(\w*COLUMNS\w*)\s*=\s*`([^`]*)`/g;
  let match;
  while ((match = constant.exec(source))) {
    const [, name, columns] = match;
    resolved = resolved.split(`\${${name}}`).join(columns.replace(/\s+/g, ' ').trim());
  }
  return resolved;
}

/** Every SQL template literal in queries.js (backtick strings containing SQL keywords). */
function extractSql(source) {
  const out = [];
  const re = /`([^`]*?)`/gs;
  let match;
  while ((match = re.exec(source))) {
    const sql = match[1];
    if (!/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(sql)) continue;
    out.push({ sql, index: match.index });
  }
  return out;
}

function referencedTables(sql) {
  const names = new Set();
  const patterns = [
    /\bFROM\s+`?(\w+)`?/gi,
    /\bJOIN\s+`?(\w+)`?/gi,
    /\bINSERT\s+INTO\s+`?(\w+)`?/gi,
    /^\s*UPDATE\s+`?(\w+)`?/gim,
    /\bDELETE\s+FROM\s+`?(\w+)`?/gi,
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(sql))) names.add(m[1]);
  }
  // SQL keywords and aliases the naive patterns above can pick up
  for (const noise of ['SELECT', 'WHERE', 'SET', 'VALUES', 'DUAL', 'DUAL']) names.delete(noise);
  return [...names].filter((name) => !/^(AND|OR|ON|AS|LEFT|RIGHT|INNER|OUTER)$/i.test(name));
}

function insertColumns(sql) {
  const m = sql.match(/INSERT\s+INTO\s+`?(\w+)`?\s*\(([^)]*)\)/i);
  if (!m) return null;
  return { table: m[1], columns: m[2].split(',').map((c) => c.trim().replace(/`/g, '')).filter(Boolean) };
}

function interpolations(sql) {
  const found = [];
  const re = /\$\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(sql))) found.push(m[1].trim());
  return found;
}

const ALLOWED_INTERPOLATIONS = [
  /^placeholders$/, // generated "?, ?, ?" lists
  /^FIXTURE_COLUMNS$/, // static column list constant
  /^leagueFilter$/, // static fragment, values bound with ?
  /^scopeSql$/, // static fragment, values bound with ?
  /^db\.limitClause\(/, // integer validated LIMIT/OFFSET
  /^where$/, // built from static strings + bound params
  /^extra$/, // static SQL fragments chosen by validated options
  /^fields\.join\(', '\)$/, // `col = ?` pairs built from a fixed field map
  /^window$/, // integer validated inline for INTERVAL
  /^TICKET_SELECT$/i, // a static SQL constant
];

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function main() {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const queriesSource = resolveColumnConstants(fs.readFileSync(QUERIES_PATH, 'utf8'));
  const tables = parseSchema(schemaSql);

  process.stdout.write(`schema.sql: ${tables.size} tables\n`);
  if (tables.size < 15) errors.push(`expected at least 15 tables in the schema, found ${tables.size}`);

  for (const [name, table] of tables) {
    if (!table.primaryKey) errors.push(`table \`${name}\` has no PRIMARY KEY`);
    if (!table.engine) errors.push(`table \`${name}\` is not ENGINE=InnoDB`);
    if (!table.utf8mb4) warnings.push(`table \`${name}\` does not declare utf8mb4`);
  }

  // the upserts rely on these unique keys existing
  const requiredUnique = [
    ['odds', ['fixture_id', 'bookmaker_id', 'market_key']],
    ['predictions', ['fixture_id', 'market_key']],
    ['team_form', ['team_id', 'scope', 'window_matches']],
    ['settings', ['setting_key']],
    ['tickets', ['ticket_date']], // one published outcome per date
  ];
  for (const [table, columns] of requiredUnique) {
    const definition = tables.get(table);
    if (!definition) {
      errors.push(`required table \`${table}\` is missing`);
      continue;
    }
    const has = definition.unique.some((key) => columns.every((c) => key.includes(c)));
    if (!has) errors.push(`table \`${table}\` needs a UNIQUE KEY covering (${columns.join(', ')}) for its upsert`);
    for (const column of columns) {
      if (!definition.columns.has(column)) errors.push(`table \`${table}\` is missing column \`${column}\``);
    }
  }

  const statements = extractSql(queriesSource);
  process.stdout.write(`queries.js: ${statements.length} SQL statements\n`);

  const seenTables = new Set();
  for (const { sql } of statements) {
    for (const table of referencedTables(sql)) {
      seenTables.add(table);
      if (!tables.has(table)) errors.push(`query references unknown table \`${table}\``);
    }

    const insert = insertColumns(sql);
    if (insert && tables.has(insert.table)) {
      for (const column of insert.columns) {
        if (!tables.get(insert.table).columns.has(column)) {
          errors.push(`INSERT INTO \`${insert.table}\` references unknown column \`${column}\``);
        }
      }
    }

    for (const interpolation of interpolations(sql)) {
      if (!ALLOWED_INTERPOLATIONS.some((pattern) => pattern.test(interpolation))) {
        errors.push(`unsafe SQL interpolation \${${interpolation}} — bind the value with ? instead`);
      }
    }
  }

  for (const name of tables.keys()) {
    if (!seenTables.has(name)) warnings.push(`table \`${name}\` is never referenced by queries.js`);
  }

  for (const warning of warnings) process.stdout.write(`  warn  ${warning}\n`);
  for (const error of errors) process.stdout.write(`  error ${error}\n`);

  if (errors.length) {
    process.stdout.write(`\nFAILED — ${errors.length} problem(s), ${warnings.length} warning(s)\n`);
    process.exit(1);
  }
  process.stdout.write(`\nOK — ${tables.size} tables, ${statements.length} statements, ${warnings.length} warning(s)\n`);
}

main();
