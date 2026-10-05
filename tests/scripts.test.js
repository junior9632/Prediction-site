'use strict';

/**
 * The operator scripts are part of the product: the SQL validator keeps the
 * schema and the repository in sync, and the secret scanner proves that no key
 * is ever shipped to the browser. Both must pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function run(script) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

test('scripts: the schema and every query in queries.js agree', () => {
  const result = run('validate-sql.js');
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^OK/m);
  assert.match(result.stdout, /17 tables/);
  assert.ok(!/error/.test(result.stdout), result.stdout);
});

test('scripts: no secret, key or upstream host ships in public/', () => {
  const result = run('check-no-secrets.js');
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /no secrets found/i);
});
