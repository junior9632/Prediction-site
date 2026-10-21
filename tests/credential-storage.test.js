'use strict';

/**
 * CREDENTIAL-STORAGE REPAIR — readiness, diagnosis and key-location tests.
 *
 * WHAT IS BEING PROVED
 *   1. "Credential storage is unavailable" is no longer one undifferentiated
 *      sentence: database connectivity, a missing migration, missing grants,
 *      an unusable encryption key, a credential-table read failure and a broken
 *      diagnostics/history query are reported separately.
 *   2. The diagnostic endpoint is admin-only and read-only. It writes nothing
 *      and returns no API key, ciphertext, encryption key, password, cookie or
 *      grant text.
 *   3. The vault never claims to be ready when the key file cannot be read or
 *      created, never regenerates an existing key, and prefers a valid existing
 *      key file over creating another one.
 *   4. A provider connection is independent of storage readiness: the storage
 *      report never uses a connection verdict as evidence.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'credential-storage-test-secret-0123456789abcdef';
process.env.API_CREDENTIALS_ENCRYPTION_KEY = 'f'.repeat(64);
process.env.API_CREDENTIALS_AUTO_KEY = '0';
process.env.ADMIN_RATE_LIMIT_MAX = '500';
delete process.env.API_CREDENTIALS_KEY_FILE;
delete process.env.API_FOOTBALL_KEY;
delete process.env.API_FOOTBALL_HOST;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fakeDb = require('./fakeDb');
const auth = require('../server/middleware/auth');
const settingsService = require('../server/services/settingsService');
const credentialService = require('../server/services/apiCredentialService');
const storage = require('../server/services/credentialStorageService');
const vault = require('../server/utils/credentialVault');
const { createApp } = require('../server/app');

const ADMIN = { id: 1, email: 'storage-admin@test.local', username: 'storageadmin', password_hash: 'x', role: 'superadmin', is_active: 1, locked_until: null, must_change_password: 0 };
const MEMBER = {
  id: 91, email: 'storage-member@test.local', username: 'storagemember', full_name: 'Storage Member',
  password_hash: 'x', role: 'user', is_active: 1, status: 'approved', failed_logins: 0,
  locked_until: null, last_login_at: null, created_at: '2026-09-01 10:00:00', updated_at: '2026-09-01 10:00:00',
};

let server;
let base;
let adminBearer;
let memberBearer;
let installed;

function req(method, urlPath, { token = null, body = null } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';
  return fetch(`${base}${urlPath}`, { method, headers, body: body === null ? undefined : JSON.stringify(body) })
    .then(async (res) => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_err) { json = null; }
      return { status: res.status, text, json };
    });
}

before(async () => {
  installed = fakeDb.install({ admins: [ADMIN], users: [MEMBER], settings: [] });
  settingsService.invalidateCache();
  credentialService.__resetForTests();
  adminBearer = auth.signToken({ sub: ADMIN.id, type: 'admin', role: ADMIN.role, username: ADMIN.username });
  memberBearer = auth.signToken({ sub: MEMBER.id, type: 'user', role: 'user', username: MEMBER.username });
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (installed) installed.restore();
});

/** Reinstall the in-memory database with per-test overrides. */
function withDb(overrides, work) {
  if (installed) installed.restore();
  installed = fakeDb.install({ admins: [ADMIN], users: [MEMBER], settings: [], ...overrides });
  settingsService.invalidateCache();
  credentialService.__resetForTests();
  return work(installed.store);
}

/* ------------------------------------------------------------------ */
/* 1. the diagnostic endpoint                                         */
/* ------------------------------------------------------------------ */

test('storage diagnostic: healthy storage is reported ready and read-only', async () => {
  await withDb({}, async () => {
    const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
    assert.equal(res.status, 200);
    const report = res.json.data;
    assert.equal(report.readOnly, true);
    assert.equal(report.state, 'READY');
    assert.equal(report.ready, true);
    assert.equal(report.canRead, true);
    assert.equal(report.canSave, true);
    assert.equal(report.database.reachable, true);
    assert.equal(report.schema.ready, true);
    assert.equal(report.schema.migration.required, false);
    assert.equal(report.permissions.select, true);
    assert.equal(report.permissions.insert, true);
    assert.equal(report.encryption.canEncrypt, true);
    assert.equal(report.history.ready, true);
    assert.deepEqual(report.issues, []);

    // No secret material and no raw grant text can appear in the payload.
    assert.ok(!res.text.includes(process.env.API_CREDENTIALS_ENCRYPTION_KEY), 'the encryption key never ships');
    assert.ok(!/key_ciphertext|BEGIN PRIVATE KEY|GRANT SELECT|x-apisports-key/i.test(res.text), 'no secret or grant text');
    assert.ok(!res.text.includes('password'), 'no database password');
  });
});

test('storage diagnostic: guests and members cannot read it', async () => {
  await withDb({}, async () => {
    const guest = await req('GET', '/api/admin/api-management/storage-diagnostics');
    assert.equal(guest.status, 401, 'an anonymous caller is refused');
    const member = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: memberBearer });
    assert.equal(member.status, 403, 'a member account is refused');
  });
});

test('storage diagnostic: a missing migration names the missing tables, not a generic error', async () => {
  await withDb({ schema: { api_credentials: [], api_connection_events: [] } }, async () => {
    const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
    assert.equal(res.status, 200);
    const report = res.json.data;
    assert.equal(report.state, 'SCHEMA_OUT_OF_DATE');
    assert.equal(report.canSave, false);
    assert.equal(report.schema.migration.required, true);
    assert.equal(report.schema.migration.file, '003-api-credential-management.sql');
    assert.deepEqual(report.schema.missingTables.sort(), ['api_connection_events', 'api_credentials']);
    assert.ok(report.issues.some((issue) => issue.area === 'schema' && /db:migrate|phpMyAdmin/.test(issue.fix)));
  });
});

test('storage diagnostic: denied schema probes are not misreported as a missing migration', async () => {
  await withDb({ failQueries: { informationSchema: true, schemaProbe: true } }, async () => {
    const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
    assert.equal(res.status, 200);
    const report = res.json.data;
    assert.equal(report.state, 'PERMISSION_DENIED');
    assert.deepEqual(report.schema.missingTables, []);
    assert.equal(report.schema.migration.required, false);
    assert.equal(report.schema.migration.applied, null);
    assert.equal(report.schema.verificationError, 'DATABASE_PERMISSION_DENIED');
    assert.ok(report.issues.some((issue) => issue.area === 'permissions'));
    assert.ok(!report.issues.some((issue) => issue.area === 'schema' && /Apply 003/.test(issue.fix || '')));
  });
});

test('storage diagnostic: a broken history degrades the screen without blocking saving', async () => {
  await withDb({ failQueries: { apiConnectionEvents: true, apiSyncLogs: true } }, async () => {
    const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
    assert.equal(res.status, 200);
    const report = res.json.data;
    assert.equal(report.state, 'HISTORY_DEGRADED');
    assert.equal(report.history.ready, false);
    assert.equal(report.history.error, 'SCHEMA_OUT_OF_DATE');
    assert.equal(report.credentials.readable, true);
    assert.equal(report.canSave, true, 'a diagnostics-history failure must not disable saving');
    assert.equal(report.canRead, true);
    assert.ok(report.issues.some((issue) => issue.area === 'history'));

    // The status DTO keeps the old field for compatibility but reports history,
    // not "credential storage is unavailable".
    const status = await req('GET', '/api/admin/api-management', { token: adminBearer });
    assert.equal(status.status, 200);
    assert.equal(status.json.data.databaseManaged, true);
    assert.equal(status.json.data.storage.state, 'HISTORY_DEGRADED');
    assert.equal(status.json.data.degradedReason, 'HISTORY_UNAVAILABLE');
  });
});

test('storage diagnostic: an unreachable database is distinct from a missing migration', async () => {
  await withDb({ failQueries: { database: true } }, async () => {
    const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
    assert.equal(res.status, 200);
    const report = res.json.data;
    assert.equal(report.state, 'DATABASE_UNREACHABLE');
    assert.equal(report.database.reachable, false);
    assert.equal(report.schema.checked, false);
    assert.equal(report.canSave, false);
    assert.ok(report.issues.some((issue) => issue.area === 'database' && /DB_HOST/.test(issue.fix)));
  });
});

test('storage diagnostic: missing write privileges are reported as a permission problem', async () => {
  await withDb({ grants: 'GRANT SELECT ON `testdb`.* TO `test`@`localhost`' }, async () => {
    const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
    assert.equal(res.status, 200);
    const report = res.json.data;
    assert.equal(report.state, 'PERMISSION_DENIED');
    assert.equal(report.permissions.select, true);
    assert.equal(report.permissions.insert, false);
    assert.equal(report.canSave, false);
    assert.ok(report.issues.some((issue) => issue.area === 'permissions'));
    assert.ok(!res.text.includes('GRANT SELECT'), 'the raw grant text is never returned');
  });
});

test('storage diagnostic: grants on another database do not prove this database can save', async () => {
  await withDb({ grants: 'GRANT SELECT, INSERT, UPDATE ON `anotherdb`.* TO `test`@`localhost`' }, async () => {
    const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
    assert.equal(res.status, 200);
    const report = res.json.data;
    assert.equal(report.state, 'PERMISSION_DENIED');
    assert.equal(report.permissions.checked, true);
    assert.equal(report.permissions.select, false);
    assert.equal(report.permissions.insert, false);
    assert.equal(report.canSave, false);
    assert.ok(!res.text.includes('anotherdb'), 'database grant scope is not disclosed');
  });
});

test('storage diagnostic: unavailable SHOW GRANTS means save readiness is unknown, not yes', async () => {
  await withDb({ grants: null }, async () => {
    const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
    assert.equal(res.status, 200);
    const report = res.json.data;
    assert.equal(report.state, 'PERMISSIONS_UNVERIFIED');
    assert.equal(report.ready, false);
    assert.equal(report.canRead, true, 'the read-only credential query did succeed');
    assert.equal(report.canSave, null, 'no write was attempted, so write permission remains unknown');
    assert.equal(report.permissions.checked, false);
    assert.ok(report.issues.some((issue) => issue.code === 'DATABASE_PERMISSIONS_UNVERIFIED'));
  });
});

test('storage diagnostic: an access denied during a database query is a permission failure', async () => {
  const info = storage.classifyError({ code: 'ER_ACCESS_DENIED_ERROR' }, 'credentials');
  assert.equal(info.state, 'PERMISSION_DENIED');
  assert.equal(storage.classifyError({ code: 'ER_ACCESS_DENIED_ERROR' }, 'database').state, 'DATABASE_UNREACHABLE');
});

test('storage diagnostic: a missing encryption key does not turn into a fake database problem', async () => {
  const key = process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  try {
    await withDb({}, async () => {
      const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
      assert.equal(res.status, 200);
      const report = res.json.data;
      assert.equal(report.state, 'ENCRYPTION_NOT_READY');
      assert.equal(report.database.reachable, true);
      assert.equal(report.schema.ready, true);
      assert.equal(report.encryption.canEncrypt, false);
      assert.equal(report.canSave, false);
      assert.ok(report.issues.some((issue) => issue.area === 'encryption'));
    });
  } finally {
    process.env.API_CREDENTIALS_ENCRYPTION_KEY = key;
  }
});

test('storage report: a provider connection verdict is not evidence of storage readiness', async () => {
  const report = await withDb({ failQueries: { database: true } }, async () => {
    const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
    return res.json.data;
  });
  assert.equal(report.state, 'DATABASE_UNREACHABLE');
  assert.ok(!Object.prototype.hasOwnProperty.call(report, 'connection'), 'the report cannot inherit a connection state');
  assert.ok(!Object.prototype.hasOwnProperty.call(report, 'liveProbe'));
  assert.equal(report.canSave, false);
});

/* ------------------------------------------------------------------ */
/* 2. the vault's readiness and key handling                          */
/* ------------------------------------------------------------------ */

test('vault: an environment key is ready, and its value never appears in status JSON', () => {
  const status = vault.status();
  assert.equal(status.state, 'ENV_READY');
  assert.equal(status.configured, true);
  assert.equal(status.canEncrypt, true);
  assert.equal(status.canDecrypt, true);
  assert.ok(!JSON.stringify(status).includes(process.env.API_CREDENTIALS_ENCRYPTION_KEY));
});

test('vault: a pending key file becomes ready only when it can actually be created', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-storage-'));
  const keyFile = path.join(dir, 'nested', 'api-credentials.key');
  const previousKey = process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  const previousAuto = process.env.API_CREDENTIALS_AUTO_KEY;
  delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  process.env.API_CREDENTIALS_AUTO_KEY = '1';
  process.env.API_CREDENTIALS_KEY_FILE = keyFile;
  try {
    const pending = vault.status();
    assert.equal(pending.state, 'PENDING');
    assert.equal(pending.pending, true);
    assert.equal(pending.canEncrypt, true);
    assert.equal(pending.canDecrypt, false);
    assert.equal(pending.keyPath, keyFile);
    assert.equal(fs.existsSync(keyFile), false, 'status must not create anything');

    const first = fs.existsSync(keyFile);
    vault.encryptSecret('storage-test-key-1', { provider: 'api_football' });
    assert.equal(first, false);
    const created = fs.readFileSync(keyFile, 'utf8');
    assert.match(created.trim(), /^[0-9a-f]{64}$/);
    assert.equal(vault.status().state, 'FILE_READY');
    assert.equal(vault.status().canDecrypt, true);

    vault.encryptSecret('storage-test-key-2', { provider: 'api_football' });
    assert.equal(fs.readFileSync(keyFile, 'utf8'), created, 'an existing key is never regenerated');
    assert.ok(!JSON.stringify(vault.status()).includes(created.trim().slice(0, 16)), 'key bytes never appear in status');
  } finally {
    delete process.env.API_CREDENTIALS_KEY_FILE;
    if (previousAuto === undefined) delete process.env.API_CREDENTIALS_AUTO_KEY;
    else process.env.API_CREDENTIALS_AUTO_KEY = previousAuto;
    if (previousKey === undefined) delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.API_CREDENTIALS_ENCRYPTION_KEY = previousKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vault: the default key file is outside the application root, and an env key wins', () => {
  const appRoot = path.resolve(__dirname, '..');
  assert.equal(vault.LEGACY_KEY_FILE, path.join(appRoot, 'storage', 'api-credentials.key'));
  assert.equal(vault.PERSISTENT_KEY_FILE.startsWith(`${appRoot}${path.sep}`), false, 'the new default is outside the app folder');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-env-wins-'));
  const invalid = path.join(dir, 'api-credentials.key');
  fs.writeFileSync(invalid, 'not-a-key\n');
  const previousPath = process.env.API_CREDENTIALS_KEY_FILE;
  process.env.API_CREDENTIALS_KEY_FILE = invalid;
  try {
    // The environment variable is authoritative even when the file is invalid.
    assert.equal(vault.status().state, 'ENV_READY');
    assert.equal(vault.status().source, 'env');
    assert.equal(vault.decryptSecret(
      (() => {
        const enc = vault.encryptSecret('env-wins-value', { provider: 'api_football' });
        return { key_ciphertext: enc.ciphertext, key_iv: enc.iv, key_tag: enc.tag };
      })(),
      { provider: 'api_football' }
    ), 'env-wins-value');
  } finally {
    if (previousPath === undefined) delete process.env.API_CREDENTIALS_KEY_FILE;
    else process.env.API_CREDENTIALS_KEY_FILE = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vault: a key is never placed inside a served web folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-webroot-'));
  const publicHtml = path.join(root, 'public_html');
  const appRoot = path.join(publicHtml, 'app');
  fs.mkdirSync(appRoot, { recursive: true });
  const previousHome = process.env.HOME;
  try {
    // cPanel layout: /home/USER/public_html/app -> the key must not sit in public_html.
    const resolved = vault.defaultPersistentKeyFile(appRoot);
    assert.equal(resolved.endsWith(path.join('.goalpredict', 'api-credentials.key')), true);
    assert.equal(resolved.startsWith(`${publicHtml}${path.sep}`), false, 'the key must not sit inside public_html');

    // Even when $HOME points inside the served folder, the key steps out of it.
    process.env.HOME = path.join(publicHtml, 'nested');
    const nestedHome = vault.defaultPersistentKeyFile(appRoot);
    assert.equal(nestedHome.startsWith(`${publicHtml}${path.sep}`), false, 'the key must never be web-served');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('vault: an invalid existing key file fails closed and is left untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-invalid-'));
  const keyFile = path.join(dir, 'api-credentials.key');
  fs.writeFileSync(keyFile, 'this-is-not-a-valid-key\n');
  const previousKey = process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  process.env.API_CREDENTIALS_KEY_FILE = keyFile;
  try {
    const status = vault.status();
    assert.equal(status.state, 'KEY_FILE_INVALID');
    assert.equal(status.configured, false);
    assert.equal(status.canEncrypt, false);
    assert.throws(
      () => vault.encryptSecret('should-not-be-stored', { provider: 'api_football' }),
      (err) => err.code === 'ENCRYPTION_KEY_MISSING' && err.details.reason === 'KEY_FILE_INVALID'
    );
    assert.equal(fs.readFileSync(keyFile, 'utf8'), 'this-is-not-a-valid-key\n', 'the file is never replaced');
  } finally {
    delete process.env.API_CREDENTIALS_KEY_FILE;
    if (previousKey === undefined) delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.API_CREDENTIALS_ENCRYPTION_KEY = previousKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vault: an unreadable key file is reported honestly, not treated as missing', { skip: process.getuid && process.getuid() === 0 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-unreadable-'));
  const keyFile = path.join(dir, 'api-credentials.key');
  fs.writeFileSync(keyFile, `${'a'.repeat(64)}\n`);
  fs.chmodSync(keyFile, 0o000);
  const previousKey = process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  process.env.API_CREDENTIALS_KEY_FILE = keyFile;
  try {
    assert.equal(vault.status().state, 'KEY_FILE_UNREADABLE');
    assert.equal(vault.isConfigured(), false);
  } finally {
    fs.chmodSync(keyFile, 0o600);
    delete process.env.API_CREDENTIALS_KEY_FILE;
    if (previousKey === undefined) delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.API_CREDENTIALS_ENCRYPTION_KEY = previousKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vault: a key location that cannot be created is not reported as ready', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-blocked-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file, not a directory');
  const previousKey = process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  const previousAuto = process.env.API_CREDENTIALS_AUTO_KEY;
  delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  process.env.API_CREDENTIALS_AUTO_KEY = '1';
  process.env.API_CREDENTIALS_KEY_FILE = path.join(blocker, 'api-credentials.key');
  try {
    const status = vault.status();
    assert.equal(status.state, 'KEY_FILE_UNWRITABLE');
    assert.equal(status.configured, false);
    assert.equal(status.pending, undefined, 'a pending key that cannot be created is not ready');
    assert.equal(status.writable.writable, false);
  } finally {
    delete process.env.API_CREDENTIALS_KEY_FILE;
    if (previousAuto === undefined) delete process.env.API_CREDENTIALS_AUTO_KEY;
    else process.env.API_CREDENTIALS_AUTO_KEY = previousAuto;
    if (previousKey === undefined) delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.API_CREDENTIALS_ENCRYPTION_KEY = previousKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vault: a relative key path resolves against the application root, not the process cwd', () => {
  const previousKey = process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  process.env.API_CREDENTIALS_KEY_FILE = 'var/credentials/api-credentials.key';
  try {
    assert.equal(vault.keyFilePath(), path.join(path.resolve(__dirname, '..'), 'var', 'credentials', 'api-credentials.key'));
  } finally {
    delete process.env.API_CREDENTIALS_KEY_FILE;
    if (previousKey === undefined) delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.API_CREDENTIALS_ENCRYPTION_KEY = previousKey;
  }
});

/* ------------------------------------------------------------------ */
/* 3. classification stays stable                                     */
/* ------------------------------------------------------------------ */

test('storage classification: driver errors map to distinct, safe states', () => {
  const cases = [
    [{ code: 'ECONNREFUSED' }, 'DATABASE_UNREACHABLE'],
    [{ code: 'ER_NO_SUCH_TABLE' }, 'SCHEMA_OUT_OF_DATE'],
    [{ code: 'ER_TABLEACCESS_DENIED_ERROR' }, 'PERMISSION_DENIED'],
    [{ code: 'ER_LOCK_WAIT_TIMEOUT' }, 'QUERY_FAILED'],
  ];
  for (const [err, state] of cases) {
    const info = storage.classifyError(err);
    assert.equal(info.state, state);
    assert.ok(!/database password|SELECT \*|GRANT .* TO /i.test(info.message), 'classification never includes SQL or a secret');
  }
});

test('storage diagnostic: cPanel escaped database grant is not a false denial', async () => {
  await withDb({ databaseName: 'account_goalpredict', grants: [
    'GRANT USAGE ON *.* TO `app`@`localhost`',
    'GRANT ALL PRIVILEGES ON `account\\_goalpredict`.* TO `app`@`localhost`',
  ] }, async () => {
    const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
    assert.equal(res.json.data.state, 'READY');
    assert.equal(res.json.data.canSave, true);
    assert.equal(res.json.data.permissions.select, true);
    assert.ok(!res.text.includes('GRANT '));
    assert.ok(!res.text.includes('account_goalpredict'));
  });
});

for (const grants of [
  'unrecognized metadata',
  'GRANT `writer_role` TO `app`@`localhost`',
  'GRANT SELECT (id), UPDATE (host) ON `testdb`.`api_credentials` TO `app`@`localhost`',
  'GRANT ALL PRIVILEGES ON `test%`.* TO `app`@`localhost`',
  ['GRANT ALL PRIVILEGES ON *.* TO `app`@`localhost`', 'REVOKE INSERT ON `testdb`.* FROM `app`@`localhost`'],
]) {
  test(`storage diagnostic: unsupported grant metadata is unknown (${JSON.stringify(grants)})`, async () => {
    await withDb({ grants }, async () => {
      const res = await req('GET', '/api/admin/api-management/storage-diagnostics', { token: adminBearer });
      assert.equal(res.json.data.state, 'PERMISSIONS_UNVERIFIED');
      assert.equal(res.json.data.canSave, null);
      assert.equal(res.json.data.canRead, true);
      assert.equal(res.json.data.permissions.checked, false);
    });
  });
}
