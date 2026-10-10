'use strict';

/**
 * The operator scripts are part of the product: the SQL validator keeps the
 * schema and the repository in sync, and the secret scanner proves that no key
 * is ever shipped to the browser. Both must pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** The file-name patterns the test runner discovers when given no path argument. */
const DISCOVERED_PATTERNS = [
  /(^|[\\/])test\.(js|cjs|mjs)$/,
  /(^|[\\/])test-.+\.(js|cjs|mjs)$/,
  /\.(test|-test|_test)\.(js|cjs|mjs)$/,
];

const isDiscovered = (file) => DISCOVERED_PATTERNS.some((re) => re.test(file));

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
  assert.match(result.stdout, /18 tables/);
  assert.ok(!/error/.test(result.stdout), result.stdout);
});

test('scripts: no secret, key or upstream host ships in public/', () => {
  const result = run('check-no-secrets.js');
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /no secrets found/i);
});

test('scripts: the access verifier is wired up and fails loudly on an unreachable site', () => {
  const { scripts } = require('../package.json');
  assert.equal(scripts['verify:access'], 'node scripts/verify-access.js', 'npm run verify:access is wired up');

  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-access.js'), 'utf8');
  // it must check the guest boundary, both signed-in states and the cache rules
  for (const marker of [
    "check('guest: GET /api/dashboard/activity is 401'",
    "'member: GET /api/dashboard/activity is 200'",
    "'admin: the console API keeps its permissions'",
    "'guest: /admin/login serves the sign-in page'",
    'no-store',
  ]) {
    assert.ok(source.includes(marker), `verify-access.js must keep the check: ${marker}`);
  }

  // Against a dead address it must exit non-zero — a verifier that silently
  // "passes" when the site is unreachable would be worse than no verifier.
  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'verify-access.js'), '--base=http://127.0.0.1:1'],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, stdio: 'pipe', timeout: 30000 }
    );
  } catch (err) {
    exitCode = err.status ?? 1;
    output = `${err.stdout || ''}${err.stderr || ''}`;
  }
  assert.notEqual(exitCode, 0, `an unreachable site must fail the verifier: ${output}`);
  assert.match(output, /cannot reach http:\/\/127\.0\.0\.1:1/);
});

test('scripts: the doctor diagnoses a broken database instead of hiding it', () => {
  const { scripts } = require('../package.json');
  assert.equal(scripts.doctor, 'node scripts/doctor.js', 'npm run doctor is wired up');

  // Point it at a port where nothing listens and skip the running-site section:
  // it must fail loudly and name the cause + the fix, never pass silently.
  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'doctor.js'), '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DOCTOR_SKIP_SITE: '1',
        DB_HOST: '127.0.0.1',
        DB_PORT: '1',
        DB_USER: 'nobody',
        DB_PASSWORD: 'nope',
        DB_NAME: 'nothing',
      },
      timeout: 60000,
    });
  } catch (err) {
    exitCode = err.status ?? 1;
    output = `${err.stdout || ''}${err.stderr || ''}`;
  }
  assert.notEqual(exitCode, 0, `a broken database must fail the doctor: ${output}`);

  const report = JSON.parse(output);
  assert.equal(report.ok, false);
  const failedChecks = report.results.filter((r) => !r.ok);
  assert.ok(
    failedChecks.some((r) => r.group === 'database' && /MySQL connection/.test(r.name)),
    'the connection failure is reported'
  );
  assert.ok(
    failedChecks.every((r) => r.group !== 'database' || r.fix.length > 0),
    'every database failure ships an actionable fix'
  );
  // and it never prints a secret
  assert.ok(!output.includes('nope'), 'the database password never appears in the report');
});

test('package.json: the test script runs on Node 18 and 20, not just 22', () => {
  const { scripts, engines } = require('../package.json');

  // Glob positionals were only added to `node --test` in Node 21. On 18 and 20
  // the pattern is treated as a literal path, the runner reports
  // "Could not find '.../tests/**/*.test.js'" and exits 1 before a single test
  // executes. package.json advertises support for >=18.17, so the script has
  // to use the form that has behaved identically since Node 18: no path
  // argument at all, letting the runner apply its own default discovery.
  assert.ok(!scripts.test.includes('*'), `test script must not use a glob: ${scripts.test}`);
  assert.equal(scripts.test, 'node --test');
  assert.match(engines.node, /18/);
});

test('package.json: default discovery picks up the tests but never the helpers', () => {
  const files = fs.readdirSync(path.join(ROOT, 'tests'));
  const discovered = files.filter(isDiscovered);

  // Every test file must be found by the default patterns, otherwise dropping
  // the path argument would silently stop running it.
  assert.deepEqual(
    discovered.sort(),
    files.filter((f) => f.endsWith('.test.js')).sort(),
  );
  assert.ok(discovered.length >= 4, `expected the test files, found ${discovered.join(', ')}`);

  // fakeDb.js and synthetic.js are fixtures, not tests. If either were ever
  // executed as a test file the run would fail on a bare require, which is
  // exactly what `node --test tests/` (the directory form) does.
  assert.ok(files.includes('fakeDb.js') && files.includes('synthetic.js'));
  assert.ok(!isDiscovered('fakeDb.js'), 'fakeDb.js must not match a discovery pattern');
  assert.ok(!isDiscovered('synthetic.js'), 'synthetic.js must not match a discovery pattern');
});
