'use strict';

/**
 * VERSIONED MIGRATION ENGINE TESTS (no MySQL needed)
 *  - file discovery: numeric ordering, convention + duplicate enforcement
 *  - planner: fresh db, partially applied, checksum drift, missing files,
 *    out-of-order warnings
 *  - applyMigrations: executes pending files in order, records each one,
 *    is a no-op on the second run (via a fake mysql2 connection)
 */

process.env.NODE_ENV = 'test';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migrate = require('../server/database/migrate');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name, sql) => fs.writeFileSync(path.join(dir, name), sql);

/** Minimal mysql2-shaped double: tracks executed SQL + schema_migrations rows. */
function fakeConnection() {
  const executed = [];
  const records = [];
  return {
    executed,
    records,
    async query(sql, params) {
      executed.push({ sql, params });
      if (/^SELECT filename/i.test(sql.trim())) return [records.map((r) => ({ ...r }))];
      if (/^INSERT INTO `schema_migrations`/i.test(sql.trim())) {
        records.push({ filename: params[0], checksum: params[1], applied_at: new Date() });
        return [{}];
      }
      return [{}];
    },
  };
}

test('migrate: files are discovered in numeric order, non-SQL files ignored', () => {
  write('010-later.sql', 'SELECT 10;');
  write('002-second.sql', 'SELECT 2;');
  write('001-first.sql', 'SELECT 1;');
  write('README.md', 'not a migration');
  const files = migrate.listMigrationFiles(dir);
  assert.deepEqual(files.map((f) => f.filename), ['001-first.sql', '002-second.sql', '010-later.sql']);
});

test('migrate: a stray .sql file that breaks the convention is an error, never skipped', () => {
  write('fix-stuff.sql', 'SELECT 1;');
  assert.throws(() => migrate.listMigrationFiles(dir), /does not match NNN-description\.sql/);
});

test('migrate: duplicate sequence numbers are an error', () => {
  write('001-a.sql', 'SELECT 1;');
  write('001-b.sql', 'SELECT 2;');
  assert.throws(() => migrate.listMigrationFiles(dir), /Duplicate migration sequence 1/);
});

test('migrate: a missing migrations directory means zero migrations, not a crash', () => {
  assert.deepEqual(migrate.listMigrationFiles(path.join(dir, 'does-not-exist')), []);
});

test('migrate: planner — fresh database runs everything, applied database runs nothing', () => {
  write('001-a.sql', 'SELECT 1;');
  write('002-b.sql', 'SELECT 2;');
  const available = migrate.listMigrationFiles(dir);
  const contents = { '001-a.sql': 'SELECT 1;', '002-b.sql': 'SELECT 2;' };

  const fresh = migrate.plan(available, [], contents);
  assert.deepEqual(fresh.pending.map((f) => f.filename), ['001-a.sql', '002-b.sql']);
  assert.deepEqual(fresh.warnings, []);

  const done = migrate.plan(
    available,
    [
      { filename: '001-a.sql', checksum: migrate.checksum('SELECT 1;') },
      { filename: '002-b.sql', checksum: migrate.checksum('SELECT 2;') },
    ],
    contents,
  );
  assert.deepEqual(done.pending, []);
  assert.deepEqual(done.warnings, []);
});

test('migrate: planner warns when an applied file was edited afterwards', () => {
  write('001-a.sql', 'SELECT 1 /* edited */;');
  const available = migrate.listMigrationFiles(dir);
  const contents = { '001-a.sql': 'SELECT 1 /* edited */;' };
  const { pending, warnings } = migrate.plan(
    available,
    [{ filename: '001-a.sql', checksum: migrate.checksum('SELECT 1;') }],
    contents,
  );
  assert.deepEqual(pending, [], 'an edited migration is NOT silently re-run');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /checksum mismatch/);
});

test('migrate: planner warns about renamed/deleted applied files and out-of-order arrivals', () => {
  write('002-b.sql', 'SELECT 2;');
  write('001-late-arrival.sql', 'SELECT 1;');
  const available = migrate.listMigrationFiles(dir);
  const contents = { '002-b.sql': 'SELECT 2;', '001-late-arrival.sql': 'SELECT 1;' };
  const { pending, warnings } = migrate.plan(
    available,
    [
      { filename: '002-b.sql', checksum: migrate.checksum('SELECT 2;') },
      { filename: '000-gone.sql', checksum: migrate.checksum('SELECT 0;') },
    ],
    contents,
  );
  assert.deepEqual(pending.map((f) => f.filename), ['001-late-arrival.sql']);
  assert.ok(warnings.some((w) => /no longer exists on disk/.test(w)));
  assert.ok(warnings.some((w) => /out of order/.test(w)));
});

test('migrate: applyMigrations runs pending files in order, records them, then no-ops', async () => {
  write('001-a.sql', 'CREATE TABLE a (id INT);');
  write('002-b.sql', 'CREATE TABLE b (id INT);');
  const conn = fakeConnection();

  const first = await migrate.applyMigrations(conn, { dir });
  assert.deepEqual(first.applied, ['001-a.sql', '002-b.sql']);
  assert.deepEqual(first.warnings, []);

  const ran = conn.executed.map((e) => e.sql);
  assert.ok(ran.some((s) => /CREATE TABLE IF NOT EXISTS `schema_migrations`/.test(s)));
  assert.ok(
    ran.indexOf('CREATE TABLE a (id INT);') < ran.indexOf('CREATE TABLE b (id INT);'),
    'migrations execute in sequence order',
  );
  assert.equal(conn.records.length, 2);
  assert.equal(conn.records[0].checksum, migrate.checksum('CREATE TABLE a (id INT);'));

  // second run: everything already recorded -> nothing executes again
  const before = conn.executed.length;
  const second = await migrate.applyMigrations(conn, { dir });
  assert.deepEqual(second.applied, []);
  assert.equal(second.alreadyApplied, 2);
  const newSql = conn.executed.slice(before).map((e) => e.sql);
  assert.ok(!newSql.includes('CREATE TABLE a (id INT);'), 'an applied migration never re-runs');
});

test('migrate: the real migrations directory is valid (convention check)', () => {
  // Throws on bad names / duplicates; an empty or missing dir is fine.
  assert.doesNotThrow(() => migrate.listMigrationFiles());
});
