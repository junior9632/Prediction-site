'use strict';

/**
 * API MANAGEMENT + API SETTINGS — security and behaviour suite.
 *
 * WHAT IS BEING PROVED
 *   1. only an authenticated, ACTIVE administrator can read or change the API
 *      configuration, and a cookie session additionally needs the CSRF token;
 *   2. a saved API key is stored ENCRYPTED (AES-256-GCM) and never returned —
 *      the browser only ever sees a masked form;
 *   3. Test Connection makes a REAL server-side request and honestly
 *      distinguishes success / invalid key / quota / rate limit / timeout /
 *      network failure / provider down / incomplete configuration;
 *   4. the environment configuration (API_FOOTBALL_KEY) keeps working when no
 *      database credential is saved, and is restored the moment the stored one
 *      is disabled;
 *   5. no endpoint accepts an arbitrary API host (SSRF) or an unimplemented
 *      provider;
 *   6. testing or switching a credential NEVER generates, publishes or
 *      replaces a prediction ticket, and the Over 1.5 product rules are
 *      untouched.
 *
 * The upstream provider is a stub `fetch` that answers like API-Football's
 * /status endpoint (the repo's established pattern: the code under test is the
 * real server, only the environment is faked — see tests/fakeDb.js).
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'api-management-test-secret-0123456789abcdef';
process.env.API_CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(63) + 'b';
process.env.API_CREDENTIALS_AUTO_KEY = '0'; // the "missing key" tests below need the file fallback off
process.env.API_CREDENTIALS_TEST_TIMEOUT_MS = '300';
process.env.API_CREDENTIALS_TEST_MIN_INTERVAL_MS = '0';
process.env.API_CREDENTIALS_TEST_REUSE_MS = '0';
process.env.ADMIN_RATE_LIMIT_MAX = '500'; // this suite exercises many authenticated actions
delete process.env.API_FOOTBALL_KEY;
delete process.env.API_FOOTBALL_HOST;

/* The upstream stub must be in place BEFORE the server modules are required:
 * the API-Football client captures `globalThis.fetch` when it is built. */
const realFetch = globalThis.fetch;
const UPSTREAM = 'https://v3.football.api-sports.io';
const UPSTREAM_RAPIDAPI = 'https://api-football-v1.p.rapidapi.com/v3';
let upstream = { mode: 'ok' };
const upstreamCalls = [];

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (!target.startsWith(UPSTREAM) && !target.startsWith(UPSTREAM_RAPIDAPI)) return realFetch(url, options);
  upstreamCalls.push({ url: target, headers: options.headers || {} });
  if (upstream.entered) upstream.entered();
  if (upstream.wait) await upstream.wait;

  if (upstream.mode === 'hang') {
    // never resolves on its own: only the client's AbortController can stop it
    await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      setTimeout(resolve, 5000);
    });
  }
  if (upstream.mode === 'network') throw new TypeError('fetch failed', { cause: Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' }) });
  if (upstream.mode === 'down') return jsonResponse(503, { errors: { server: 'Service Unavailable' }, response: [] });
  if (upstream.mode === 'rate_limited') return jsonResponse(429, { errors: { rate: 'Too many requests' }, response: [] });
  if (upstream.mode === 'invalid_key') {
    return jsonResponse(200, { get: 'status', errors: { token: 'Error/Missing application key. Go to https://www.api-football.com to get your key.' }, response: [] });
  }
  if (upstream.mode === 'quota') {
    return jsonResponse(200, { get: 'status', errors: { requests: 'You have reached the request limit for the day' }, response: [] });
  }
  if (upstream.mode === 'rejected') return jsonResponse(403, { errors: { token: 'invalid key' }, response: [] });
  return jsonResponse(200, {
    get: 'status',
    errors: [],
    results: 1,
    response: {
        account: { firstname: 'Goal', lastname: 'Predict' },
        subscription: { plan: 'Pro', active: true, end: '2027-01-01T00:00:00+00:00' },
        requests: { current: 120, limit_day: 7500 },
    },
  });
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fakeDb = require('./fakeDb');
const auth = require('../server/middleware/auth');
const settingsService = require('../server/services/settingsService');
const vault = require('../server/utils/credentialVault');
const providers = require('../server/services/apiProviders');
const credentialService = require('../server/services/apiCredentialService');
const { createApp, PUBLIC_DIR } = require('../server/app');

const ADMIN = { id: 1, email: 'admin@test.local', username: 'admin', password_hash: 'x', role: 'superadmin', is_active: 1, locked_until: null, must_change_password: 0 };
const DISABLED_ADMIN = { id: 2, email: 'off@test.local', username: 'offadmin', password_hash: 'x', role: 'admin', is_active: 0, locked_until: null, must_change_password: 0 };
const MEMBER = {
  id: 77, email: 'member@test.local', username: 'memberfan', full_name: 'Member Fan', password_hash: 'x', role: 'user',
  is_active: 1, status: 'approved', failed_logins: 0, locked_until: null, last_login_at: null,
  created_at: '2026-09-01 10:00:00', updated_at: '2026-09-01 10:00:00',
};

const API_KEY = 'live-test-key-9f3c2a71d4b8';
const SESSION = 'b'.repeat(64);

let server;
let base;
let store;
let adminBearer;
let memberBearer;
let disabledAdminBearer;

async function req(method, urlPath, { token = null, cookie = null, csrf = null, body = null } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await realFetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let jsonPayload = null;
  try {
    jsonPayload = JSON.parse(text);
  } catch (_) {
    jsonPayload = null;
  }
  return { status: res.status, text, json: jsonPayload, headers: res.headers };
}

const get = (p, o) => req('GET', p, o);
const put = (p, body, o) => req('PUT', p, { ...o, body });
const post = (p, body, o) => req('POST', p, { ...o, body });

function resetUpstream(mode = 'ok') {
  upstream = { mode };
  upstreamCalls.length = 0;
  credentialService.__resetForTests();
}

async function saveKey(key = API_KEY, host = 'v3.football.api-sports.io') {
  return put('/api/admin/api-management/credentials', { provider: 'api_football', key, host }, { token: adminBearer });
}

before(async () => {
  const installed = fakeDb.install({
    admins: [ADMIN, DISABLED_ADMIN],
    users: [MEMBER],
    settings: [],
  });
  store = installed.store;
  settingsService.invalidateCache();

  adminBearer = auth.signToken({ sub: ADMIN.id, type: 'admin', role: ADMIN.role, username: ADMIN.username });
  disabledAdminBearer = auth.signToken({ sub: DISABLED_ADMIN.id, type: 'admin', role: 'admin', username: DISABLED_ADMIN.username });
  memberBearer = auth.signToken({ sub: MEMBER.id, type: 'user', role: 'user', username: MEMBER.username });

  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = realFetch;
  fakeDb.install().restore && null;
});

/* ------------------------------------------------------------------ */
/* 1. encryption at rest                                              */
/* ------------------------------------------------------------------ */

test('credential vault: AES-256-GCM round trip, tamper detection and masking', () => {
  const encrypted = vault.encryptSecret(API_KEY, { provider: 'api_football' });

  assert.equal(encrypted.algorithm, 'aes-256-gcm');
  assert.notEqual(encrypted.ciphertext.toString('utf8'), API_KEY);
  assert.ok(!encrypted.ciphertext.includes(Buffer.from(API_KEY)), 'the plaintext key must not appear in the ciphertext');
  assert.equal(encrypted.iv.length, 12);

  const record = {
    key_ciphertext: encrypted.ciphertext,
    key_iv: encrypted.iv,
    key_tag: encrypted.tag,
  };
  assert.equal(vault.decryptSecret(record, { provider: 'api_football' }), API_KEY);

  // AAD: the same ciphertext must not decrypt for another provider.
  assert.throws(
    () => vault.decryptSecret(record, { provider: 'someone_else' }),
    (err) => err.code === 'CREDENTIAL_UNREADABLE'
  );

  // GCM authentication: a flipped byte is detected, never silently accepted.
  const tampered = { ...record, key_tag: Buffer.from(encrypted.tag) };
  tampered.key_tag[0] ^= 0xff;
  assert.throws(
    () => vault.decryptSecret(tampered, { provider: 'api_football' }),
    (err) => err.code === 'CREDENTIAL_UNREADABLE'
  );

  assert.equal(vault.maskSecret(API_KEY), '********d4b8'.slice(0, 8) + API_KEY.slice(-4));
  assert.equal(vault.maskSecret(API_KEY).includes(API_KEY.slice(0, 8)), false);
  assert.equal(vault.maskFromStoredParts({ last4: 'd4b8', length: API_KEY.length }), '********d4b8');
  assert.match(vault.status().algorithm, /aes-256-gcm/);
  assert.equal(vault.status().configured, true);
});

test('credential vault: a missing encryption key refuses to save instead of storing plaintext', () => {
  const original = process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  try {
    assert.equal(vault.isConfigured(), false);
    assert.throws(
      () => vault.encryptSecret(API_KEY, { provider: 'api_football' }),
      (err) => err.code === 'ENCRYPTION_KEY_MISSING' && err.details.envVar === 'API_CREDENTIALS_ENCRYPTION_KEY'
    );
    const status = vault.status();
    assert.equal(status.configured, false);
    assert.match(status.message, /API_CREDENTIALS_ENCRYPTION_KEY/);
    assert.match(status.generate, /randomBytes/);
  } finally {
    process.env.API_CREDENTIALS_ENCRYPTION_KEY = original;
  }
  assert.equal(vault.isConfigured(), true);
});

test('saving without an encryption key is refused over HTTP and stores nothing', async () => {
  const original = process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  delete process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  try {
    const res = await saveKey('another-live-key-abcdef');
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, 'ENCRYPTION_KEY_MISSING');
    assert.ok(!res.text.includes('another-live-key-abcdef'), 'the submitted key never echoes back');
    assert.equal(store.apiCredentials.length, 0, 'nothing may be written when encryption is unavailable');
  } finally {
    process.env.API_CREDENTIALS_ENCRYPTION_KEY = original;
  }
});

/* ------------------------------------------------------------------ */
/* 2. authorization + CSRF                                            */
/* ------------------------------------------------------------------ */

test('authorization: guests, members and disabled admins cannot read or change the configuration', async () => {
  for (const [label, options] of [
    ['guest', {}],
    ['member', { token: memberBearer }],
    ['disabled admin', { token: disabledAdminBearer }],
  ]) {
    const read = await get('/api/admin/api-management', options);
    assert.ok(read.status === 401 || read.status === 403, `${label} read must be refused (got ${read.status})`);

    const write = await put('/api/admin/api-management/credentials', { provider: 'api_football', key: 'x'.repeat(20) }, options);
    assert.ok(write.status === 401 || write.status === 403, `${label} write must be refused (got ${write.status})`);

    const activation = await post('/api/admin/api-management/activate', { provider: 'api_football' }, options);
    assert.ok(activation.status === 401 || activation.status === 403, `${label} activation must be refused`);

    const testCall = await post('/api/admin/api-management/test', { provider: 'api_football' }, options);
    assert.ok(testCall.status === 401 || testCall.status === 403, `${label} connection test must be refused`);
  }
  assert.equal(store.apiCredentials.length, 0, 'a refused request may not write a credential');
});

test('CSRF: a cookie session without the double-submit token cannot change credentials', async () => {
  resetUpstream('ok');
  const cookie = `fp_token=${encodeURIComponent(adminBearer)}`;

  const missing = await put('/api/admin/api-management/credentials', { provider: 'api_football', key: 'cookie-key-123456' }, { cookie });
  assert.equal(missing.status, 403);
  assert.equal(missing.json.error.code, 'CSRF_MISSING');

  const wrong = await put(
    '/api/admin/api-management/credentials',
    { provider: 'api_football', key: 'cookie-key-123456' },
    { cookie: `${cookie}; fp_csrf=${'c'.repeat(64)}`, csrf: 'not-the-token' }
  );
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error.code, 'CSRF_INVALID');

  // the double-submit pair is accepted
  const sessionCookie = `fp_token=${encodeURIComponent(adminBearer)}; fp_csrf=${SESSION}`;
  const ok = await put(
    '/api/admin/api-management/credentials',
    { provider: 'api_football', key: 'cookie-key-123456' },
    { cookie: sessionCookie, csrf: SESSION }
  );
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(store.apiCredentials.length, 1);
  store.apiCredentials.length = 0; // keep the suite independent
});

/* ------------------------------------------------------------------ */
/* 3. saving, masking, never returning the key                        */
/* ------------------------------------------------------------------ */

test('saving: the key is encrypted at rest, masked in every response and never echoed', async () => {
  resetUpstream('ok');
  store.apiCredentials.length = 0;

  const res = await saveKey(API_KEY);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.saved, true);
  assert.equal(res.json.data.maskedKey, '********d4b8');
  assert.ok(!res.text.includes(API_KEY), 'the API key must never come back in a response body');
  assert.ok(!res.text.includes('key_ciphertext'), 'the ciphertext is not part of the API surface');
  assert.equal(res.json.data.isActive, false, 'saving must not activate the provider automatically');

  const row = store.apiCredentials[0];
  assert.equal(row.provider, 'api_football');
  assert.equal(row.host, 'v3.football.api-sports.io');
  assert.ok(Buffer.isBuffer(row.key_ciphertext) || row.key_ciphertext.length > 0, 'a ciphertext is stored');
  assert.ok(!String(row.key_ciphertext).includes(API_KEY), 'the plaintext key is never in the database record');
  assert.equal(row.key_last4, 'd4b8');
  assert.equal(row.key_length, API_KEY.length);
  assert.equal(row.key_algorithm, 'aes-256-gcm');
  assert.notEqual(row.key_fingerprint, API_KEY, 'only a hash is stored for change detection');

  // decryption through the vault returns the key — proof it was stored reversibly
  assert.equal(vault.decryptSecret(row, { provider: 'api_football' }), API_KEY);

  // the status endpoint exposes the masked form only
  const status = await get('/api/admin/api-management', { token: adminBearer });
  assert.equal(status.status, 200);
  assert.equal(status.json.data.credential.maskedKey, '********d4b8');
  assert.equal(status.json.data.credential.location, 'database (encrypted)');
  assert.ok(!status.text.includes(API_KEY));
  assert.equal(status.json.data.activeProviderId, null, 'still not activated');
  assert.equal(status.json.data.credentialSource, 'none', 'no environment key and no active credential');

  // updating replaces the stored credential
  const updated = await saveKey('rotated-key-5521zz');
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.replaced, true);
  assert.equal(store.apiCredentials.length, 1, 'one row per provider');
  assert.equal(store.apiCredentials[0].key_last4, '21zz');
  assert.equal(vault.decryptSecret(store.apiCredentials[0], { provider: 'api_football' }), 'rotated-key-5521zz');
});

test('validation: unknown provider, unimplemented provider and arbitrary host are refused', async () => {
  const unknown = await put('/api/admin/api-management/credentials', { provider: 'mystery_api', key: API_KEY }, { token: adminBearer });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, 'UNKNOWN_PROVIDER');

  const notImplemented = await put('/api/admin/api-management/credentials', { provider: 'sportmonks', key: API_KEY }, { token: adminBearer });
  assert.equal(notImplemented.status, 400);
  assert.equal(notImplemented.json.error.code, 'PROVIDER_NOT_IMPLEMENTED');

  const ssrf = await put(
    '/api/admin/api-management/credentials',
    { provider: 'api_football', key: API_KEY, host: 'attacker.example.com' },
    { token: adminBearer }
  );
  assert.equal(ssrf.status, 400);
  assert.equal(ssrf.json.error.code, 'HOST_NOT_ALLOWED');
  assert.deepEqual(ssrf.json.error.details.allowedHosts, ['v3.football.api-sports.io', 'api-football-v1.p.rapidapi.com/v3']);

  // …and the SSRF attempt is refused for the connection test as well
  const ssrfTest = await post(
    '/api/admin/api-management/test',
    { provider: 'api_football', key: API_KEY, host: 'http://127.0.0.1:9999' },
    { token: adminBearer }
  );
  assert.equal(ssrfTest.status, 400);
  assert.equal(ssrfTest.json.error.code, 'HOST_NOT_ALLOWED');
  assert.equal(upstreamCalls.length, 0, 'no request may be made to an unapproved host');
});

test('validation: the registry only offers hosts that are allowlisted and hides unimplemented providers', async () => {
  const res = await get('/api/admin/api-management/providers', { token: adminBearer });
  assert.equal(res.status, 200);
  const implemented = res.json.data.providers.filter((p) => p.implemented);
  const declared = res.json.data.providers.filter((p) => !p.implemented);
  assert.equal(implemented.length, 1);
  assert.equal(implemented[0].id, 'api_football');
  assert.deepEqual(implemented[0].hosts.map((h) => h.id), ['v3.football.api-sports.io', 'api-football-v1.p.rapidapi.com/v3']);
  assert.ok(declared.length >= 1, 'unimplemented providers are declared for extension only');
  for (const provider of declared) assert.deepEqual(provider.hosts, [], 'no host is offered for an unimplemented provider');
  assert.equal(providers.requireHost(providers.get('api_football'), 'v3.football.api-sports.io').id, 'v3.football.api-sports.io');
});

/* ------------------------------------------------------------------ */
/* 4. real connection testing, honestly classified                    */
/* ------------------------------------------------------------------ */

test('test connection: success reports the provider plan and quota from a real response', async () => {
  resetUpstream('ok');
  await saveKey(API_KEY);

  const res = await post('/api/admin/api-management/test', { provider: 'api_football', key: API_KEY }, { token: adminBearer });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.ok, true);
  assert.equal(res.json.data.state, 'CONNECTED');
  assert.equal(res.json.data.httpStatus, 200);
  assert.equal(res.json.data.endpoint, '/status');
  assert.deepEqual(res.json.data.quota, { current: 120, limitDay: 7500 });
  assert.equal(res.json.data.plan.name, 'Pro');
  assert.equal(upstreamCalls.length, 1, 'exactly one real provider request');
  assert.equal(upstreamCalls[0].url, `${UPSTREAM}/status`);
  assert.equal(upstreamCalls[0].headers['x-apisports-key'], API_KEY, 'the direct API-Sports header carries the key');
  assert.ok(!res.text.includes(API_KEY), 'the key never echoes back');
  assert.equal(res.json.data.reused, false);

  // the verdict is persisted as diagnostics, not as a claim of "connected"
  const status = await get('/api/admin/api-management', { token: adminBearer });
  assert.equal(status.json.data.connection.state, 'CONNECTED');
  assert.equal(status.json.data.connection.latencyMs !== null, true);
  assert.equal(status.json.data.quota.current, 120);
  assert.equal(status.json.data.credential.isActive, false, 'a test never activates the credential');
});

test('test connection: invalid key, quota, rate limit, provider down, timeout and network are distinguished', async () => {
  const cases = [
    ['invalid_key', 'INVALID_KEY'],
    ['quota', 'QUOTA_EXCEEDED'],
    ['rate_limited', 'RATE_LIMITED'],
    ['down', 'PROVIDER_UNAVAILABLE'],
    ['hang', 'TIMEOUT'],
    ['network', 'NETWORK_ERROR'],
    ['rejected', 'INVALID_KEY'],
  ];
  for (const [mode, expected] of cases) {
    resetUpstream(mode);
    const res = await post('/api/admin/api-management/test', { provider: 'api_football', key: API_KEY }, { token: adminBearer });
    assert.equal(res.status, 200, `${mode}: the endpoint answers 200 with an honest verdict`);
    assert.equal(res.json.data.ok, false, `${mode} must never be reported as a success`);
    assert.equal(res.json.data.state, expected, `${mode} classified as ${expected}`);
    assert.ok(res.json.data.message && res.json.data.message.length > 0, `${mode} carries an explanation`);
    assert.equal(res.json.data.quota, null, `${mode} must not invent a quota`);
    assert.ok(!res.text.includes(API_KEY), `${mode}: the key never echoes back`);
  }
});

test('test connection: incomplete configuration is reported instead of a fake success', async () => {
  resetUpstream('ok');
  store.apiCredentials.length = 0;
  const res = await post('/api/admin/api-management/test', { provider: 'api_football' }, { token: adminBearer });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.ok, false);
  assert.equal(res.json.data.state, 'CONFIG_INCOMPLETE');
  assert.equal(upstreamCalls.length, 0, 'no provider request without a key');
});

test('test connection: repeated tests are throttled/reused instead of hammering the provider', async () => {
  resetUpstream('ok');
  credentialService.setTestWindowsForTests({ reuseMs: 60000, minIntervalMs: 0 });
  const first = await post('/api/admin/api-management/test', { provider: 'api_football', key: API_KEY }, { token: adminBearer });
  const second = await post('/api/admin/api-management/test', { provider: 'api_football', key: API_KEY }, { token: adminBearer });
  assert.equal(first.json.data.reused, false);
  assert.equal(second.json.data.reused, true, 'the second test reports the cached verdict');
  assert.equal(upstreamCalls.length, 1, 'only one real provider request was made');

  // with reuse disabled, the hard floor between real provider tests applies
  credentialService.__resetForTests();
  credentialService.setTestWindowsForTests({ reuseMs: 0, minIntervalMs: 5000 });
  await post('/api/admin/api-management/test', { provider: 'api_football', key: API_KEY }, { token: adminBearer });
  const throttled = await post('/api/admin/api-management/test', { provider: 'api_football', key: 'different-key-0001' }, { token: adminBearer });
  assert.equal(throttled.status, 429, 'a different key inside the floor window is throttled');
  assert.equal(throttled.json.error.code, 'TEST_THROTTLED');
  credentialService.setTestWindowsForTests();
});

/* ------------------------------------------------------------------ */
/* 5. activation, disabling and the environment fallback              */
/* ------------------------------------------------------------------ */

test('activation: an unsaved provider cannot be activated, and a saved one switches the client over', async () => {
  resetUpstream('ok');
  store.apiCredentials.length = 0;

  const nothing = await post('/api/admin/api-management/activate', { provider: 'api_football' }, { token: adminBearer });
  assert.equal(nothing.status, 400);
  assert.equal(nothing.json.error.code, 'NOTHING_TO_ACTIVATE');

  await saveKey(API_KEY);
  const activated = await post('/api/admin/api-management/activate', { provider: 'api_football' }, { token: adminBearer });
  assert.equal(activated.status, 200, JSON.stringify(activated.json));
  assert.equal(activated.json.data.activated, true);
  assert.equal(activated.json.data.status.credentialSource, 'database');
  assert.equal(activated.json.data.status.activeProviderId, 'api_football');
  assert.equal(activated.json.data.status.credential.isActive, true);
  assert.ok(!activated.text.includes(API_KEY));

  // the running client now uses the stored credential
  const { apiFootball } = require('../server/services/apiFootball');
  assert.equal(apiFootball.key, API_KEY);
  assert.equal(apiFootball.credentialSource, 'database');
  assert.equal(apiFootball.host, 'v3.football.api-sports.io');

  const disabled = await post('/api/admin/api-management/disable', { provider: 'api_football' }, { token: adminBearer });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.data.disabled, true);
  assert.equal(disabled.json.data.credentialSource, 'none');
  assert.equal(apiFootball.key, '', 'after disabling, no credential is in use (none was configured in the environment)');
  assert.equal(store.apiCredentials.length, 1, 'the credential is kept, encrypted, for re-activation');
});

test('environment fallback: the existing API_FOOTBALL_KEY setup keeps working until a stored credential is activated', async () => {
  resetUpstream('ok');
  store.apiCredentials.length = 0;
  process.env.API_FOOTBALL_KEY = 'environment-key-1234567890';

  // config is read once at require time, so simulate a restart for this case
  const configPath = require.resolve('../server/config');
  const clientPath = require.resolve('../server/services/apiFootball');
  const servicePath = require.resolve('../server/services/apiCredentialService');
  const savedModules = new Map();
  for (const p of [configPath, clientPath, servicePath]) {
    savedModules.set(p, require.cache[p]);
    delete require.cache[p];
  }

  const freshConfig = require('../server/config');
  assert.equal(freshConfig.apiFootball.key, 'environment-key-1234567890');
  const freshService = require('../server/services/apiCredentialService');
  const resolved = await freshService.resolveActiveCredential({ force: true });
  assert.equal(resolved.source, 'environment');
  assert.equal(resolved.key, 'environment-key-1234567890');
  assert.equal(resolved.host, 'v3.football.api-sports.io', 'the environment host is preserved');

  const status = await freshService.getStatus();
  assert.equal(status.credentialSource, 'environment');
  assert.equal(status.credential, null, 'no database credential is claimed');
  assert.equal(status.environment.keyConfigured, true);
  assert.equal(status.environment.maskedKey, '********7890');
  assert.equal(status.connection.state, 'ENVIRONMENT');

  // ...and the environment credential is what a connection test uses
  delete process.env.API_CREDENTIALS_TEST_REUSE_MS;
  const tested = await freshService.testConnection({ provider: 'api_football' }, {});
  assert.equal(tested.state, 'CONNECTED');
  assert.equal(tested.keyOrigin, 'environment');

  // restore the original module graph
  delete process.env.API_FOOTBALL_KEY;
  for (const [p, cachedModule] of savedModules) {
    if (cachedModule) require.cache[p] = cachedModule;
    else delete require.cache[p];
  }
});

test('a stored credential that cannot be decrypted is reported, never silently replaced', async () => {
  resetUpstream('ok');
  store.apiCredentials.length = 0;

  // encrypt with key A, then rotate the master key so the row is unreadable
  const keyA = 'f'.repeat(64);
  const previous = process.env.API_CREDENTIALS_ENCRYPTION_KEY;
  process.env.API_CREDENTIALS_ENCRYPTION_KEY = keyA;
  await saveKey(API_KEY);
  await post('/api/admin/api-management/activate', { provider: 'api_football' }, { token: adminBearer });

  process.env.API_CREDENTIALS_ENCRYPTION_KEY = 'e'.repeat(64);
  credentialService.__resetForTests();
  const status = await get('/api/admin/api-management', { token: adminBearer });
  assert.equal(status.status, 200, 'the dashboard still renders — it explains the problem instead of failing');
  assert.equal(status.json.data.connection.state, 'CREDENTIAL_UNREADABLE');
  assert.match(status.json.data.connection.message, /cannot be decrypted/i);
  assert.ok(!status.text.includes(API_KEY));
  assert.ok(!status.text.includes(keyA), 'the master key is never in a response');

  // …and the live probe refuses to call the provider with an unusable credential
  const diagnostics = await get('/api/admin/api-management/diagnostics?probe=1', { token: adminBearer });
  assert.equal(diagnostics.status, 200);
  assert.equal(diagnostics.json.data.liveProbe.ok, false);
  assert.equal(diagnostics.json.data.liveProbe.skipped, true);
  assert.equal(upstreamCalls.length, 0, 'no provider request is made with an unreadable credential');

  // disable and clean up for the following tests
  process.env.API_CREDENTIALS_ENCRYPTION_KEY = keyA;
  credentialService.__resetForTests();
  await post('/api/admin/api-management/disable', { provider: 'api_football' }, { token: adminBearer });
  process.env.API_CREDENTIALS_ENCRYPTION_KEY = previous;
  credentialService.__resetForTests();
  store.apiCredentials.length = 0;
});

test('RapidAPI compatibility: the marketplace host uses its own auth headers and the same client', async () => {
  resetUpstream('ok');
  store.apiCredentials.length = 0;

  const saved = await put(
    '/api/admin/api-management/credentials',
    { provider: 'api_football', key: API_KEY, host: 'api-football-v1.p.rapidapi.com/v3' },
    { token: adminBearer }
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.data.host, 'api-football-v1.p.rapidapi.com/v3');

  const activated = await post('/api/admin/api-management/activate', { provider: 'api_football' }, { token: adminBearer });
  assert.equal(activated.status, 200, JSON.stringify(activated.json));

  const { apiFootball } = require('../server/services/apiFootball');
  assert.equal(apiFootball.baseUrl, UPSTREAM_RAPIDAPI, 'the version stays in the base URL, exactly like the env configuration');
  assert.equal(apiFootball.isRapidApi, true);
  assert.equal(apiFootball.host, 'api-football-v1.p.rapidapi.com/v3');

  const probe = await apiFootball.probeCredentials();
  assert.equal(probe.ok, true, JSON.stringify(probe));
  const call = upstreamCalls[upstreamCalls.length - 1];
  assert.equal(call.url, `${UPSTREAM_RAPIDAPI}/status`);
  assert.equal(call.headers['x-rapidapi-key'], API_KEY, 'RapidAPI uses x-rapidapi-key');
  assert.equal(call.headers['x-rapidapi-host'], 'api-football-v1.p.rapidapi.com');
  assert.equal(call.headers['x-apisports-key'], undefined, 'the direct host header is not sent to RapidAPI');

  // back to the official direct host for the remaining tests
  await post('/api/admin/api-management/disable', { provider: 'api_football' }, { token: adminBearer });
  store.apiCredentials.length = 0;
  credentialService.__resetForTests();
});

/* ------------------------------------------------------------------ */
/* 6. prediction rules + no automatic ticket generation               */
/* ------------------------------------------------------------------ */

test('product rules: the Over 1.5 constraints are untouched by API configuration', async () => {
  const settings = await settingsService.getEngineSettings(true);
  assert.equal(settings.marketKey, 'over_1_5');
  assert.equal(settings.marketLabel, 'Over 1.5 Goals');
  assert.equal(settings.minTotalOdds, 2.0);
  assert.equal(settings.maxTotalOdds, 4.0);
  assert.equal(Number(settings.minConfidence), 72);
  assert.equal(Number(settings.maxRisk), 35);
  assert.equal(Number(settings.minDataQuality), 60);
  assert.equal(Number(settings.maxSelections), 6);
  assert.equal(Number(settings.oddsFreshnessMinutes), 90);
  assert.equal(settings.autoTicketGeneration, false);

  const status = await get('/api/admin/api-management', { token: adminBearer });
  assert.equal(status.json.data.predictionRules.marketKey, 'over_1_5');
  assert.equal(status.json.data.predictionRules.automaticTicketGeneration, false);
  assert.match(status.json.data.predictionRules.ticketGeneration, /MANUAL ONLY/);
});

test('no automatic ticket generation: saving, testing, activating and disabling never touches the ticket engine', async () => {
  resetUpstream('ok');
  store.apiCredentials.length = 0;
  const ticketsBefore = store.tickets.length;
  const generationLogsBefore = store.generationLogs.length;

  await saveKey(API_KEY);
  await post('/api/admin/api-management/test', { provider: 'api_football', key: API_KEY }, { token: adminBearer });
  await post('/api/admin/api-management/activate', { provider: 'api_football' }, { token: adminBearer });
  await get('/api/admin/api-management/diagnostics?probe=1', { token: adminBearer });
  await post('/api/admin/api-management/disable', { provider: 'api_football' }, { token: adminBearer });

  assert.equal(store.tickets.length, ticketsBefore, 'no ticket may be created by an API action');
  assert.equal(store.generationLogs.length, generationLogsBefore, 'no generation run may be started by an API action');

  // …and the module cannot even reach the ticket engine
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'apiCredentialService.js'), 'utf8');
  const imports = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.ok(!imports.some((i) => /ticketService/.test(i)), 'the credential service must not import the ticket engine');
  assert.ok(!imports.some((i) => /prediction/.test(i)), 'the credential service must not reach the prediction engine');

  const controllerSource = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'controllers', 'apiManagementController.js'),
    'utf8'
  );
  const controllerImports = [...controllerSource.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.ok(!controllerImports.some((i) => /ticketService/.test(i)), 'the controller must not import the ticket engine');
});

/* ------------------------------------------------------------------ */
/* 8. a live database without migration 003 must not break the site    */
/* ------------------------------------------------------------------ */

test('schema drift: without migration 003 the deployment keeps working on the environment credential', async () => {
  // Reproduces the exact production situation this repository has been bitten
  // by before: the code is newer than the live database. The API Management
  // tables do not exist yet, so the screen must degrade HONESTLY instead of
  // answering "Internal server error" — and the existing environment
  // configuration must keep driving syncs.
  const connection = require('../server/database/connection');
  const restore = { query: connection.query, queryOne: connection.queryOne };

  const driverError = () => {
    const err = new Error("Table 'db.api_credentials' doesn't exist");
    err.code = 'ER_NO_SUCH_TABLE';
    err.errno = 1146;
    err.sqlMessage = "Table 'db.api_credentials' doesn't exist";
    err.sqlState = '42S02';
    return err;
  };
  const guard = (fn) => async (sql, params) => {
    if (/api_credentials|api_connection_events/.test(String(sql))) {
      throw connection.toAppError(driverError(), String(sql));
    }
    return fn(sql, params);
  };
  connection.query = guard(restore.query);
  connection.queryOne = guard(restore.queryOne);
  credentialService.__resetForTests();

  try {
    const status = await get('/api/admin/api-management', { token: adminBearer });
    assert.equal(status.status, 200, 'the dashboard still renders');
    assert.equal(status.json.data.databaseManaged, false);
    assert.equal(status.json.data.degradedReason, 'SCHEMA_OUT_OF_DATE');
    assert.equal(status.json.data.credential, null, 'no database credential is claimed');
    assert.equal(status.json.data.recentErrors.length, 0);
    assert.deepEqual(status.json.data.lastSuccessfulSyncs.fixtures, { lastSuccessAt: null, runs: 0 });

    // a credential write is refused with the actionable message, not a 500 stack
    const save = await put('/api/admin/api-management/credentials', { provider: 'api_football', key: API_KEY }, { token: adminBearer });
    assert.equal(save.status, 500);
    assert.equal(save.json.error.code, 'SCHEMA_OUT_OF_DATE');
    assert.match(save.json.error.message, /migration/i);

    // …and the rest of the platform is untouched: the public surfaces answer
    const health = await get('/api/health');
    assert.ok([200, 503].includes(health.status), 'the site keeps serving');
  } finally {
    connection.query = restore.query;
    connection.queryOne = restore.queryOne;
    credentialService.__resetForTests();
  }
});

/* ------------------------------------------------------------------ */
/* 7. admin console wiring                                            */
/* ------------------------------------------------------------------ */

test('admin console: the API Management page exists, is admin-guarded and ships without secrets', async () => {
  const adminHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8');
  assert.match(adminHtml, /data-view="api-management"/, 'the navigation item exists');
  assert.match(adminHtml, /\/js\/admin-api-management\.js/, 'the view script is loaded');

  const adminJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'admin.js'), 'utf8');
  assert.match(adminJs, /'api-management':/, 'the view is registered in the console router');
  assert.match(adminJs, /AdminApiManagement\.load/, 'the view delegates to the module');

  const viewJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'admin-api-management.js'), 'utf8');
  for (const button of ['apiSaveBtn', 'apiTestBtn', 'apiActivateBtn', 'apiDisableBtn', 'apiRefreshBtn']) {
    assert.ok(viewJs.includes(button), `${button} is rendered`);
  }
  for (const forbidden of [/api-sports\.io/i, /rapidapi/i, /API_FOOTBALL_KEY/, /x-apisports-key/i]) {
    assert.ok(!forbidden.test(viewJs), `the admin view must not embed ${forbidden}`);
  }
  assert.ok(!/localStorage|sessionStorage/.test(viewJs), 'credentials are never kept in browser storage');

  // the script is a privileged asset: 404 for guests, 200 for an administrator
  const guest = await get('/js/admin-api-management.js');
  assert.equal(guest.status, 404, 'guests cannot fetch the console script');
  const asAdmin = await get('/js/admin-api-management.js', { token: adminBearer });
  assert.equal(asAdmin.status, 200);
  assert.match(asAdmin.headers.get('cache-control') || '', /no-store/);
});

test('diagnostics: the refresh button gets safe quota/connection data and never a key', async () => {
  resetUpstream('ok');
  store.apiCredentials.length = 0;
  await saveKey(API_KEY);
  await post('/api/admin/api-management/activate', { provider: 'api_football' }, { token: adminBearer });

  const res = await get('/api/admin/api-management/diagnostics?probe=1', { token: adminBearer });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.liveProbe.ok, true);
  assert.equal(res.json.data.quota.source, 'provider /status');
  assert.equal(res.json.data.rateLimits.requestsPerMinute > 0, true);
  assert.ok(Array.isArray(res.json.data.recentErrors));
  assert.equal(res.json.data.encryption.configured, true);
  assert.ok(!res.text.includes(API_KEY));
  assert.ok(!/x-apisports-key/i.test(res.text), 'no credential header is ever echoed');

  // the quota read from the live probe is persisted for the dashboard
  const status = await get('/api/admin/api-management', { token: adminBearer });
  assert.equal(status.json.data.quota.current, 120);
  assert.equal(status.json.data.lastSuccessfulSyncs.fixtures.lastSuccessAt, null, 'no sync has run in this suite');

  // pressing Refresh again straight away must not make a second upstream call:
  // the verdict that was just measured is returned, flagged as reused
  credentialService.setTestWindowsForTests({ reuseMs: 60000, minIntervalMs: 0 });
  const callsBefore = upstreamCalls.length;
  const again = await get('/api/admin/api-management/diagnostics?probe=1', { token: adminBearer });
  assert.equal(again.status, 200);
  assert.equal(again.json.data.liveProbe.ok, true);
  assert.equal(again.json.data.liveProbe.reused, true, 'the repeat probe is flagged as a reused measurement');
  assert.equal(upstreamCalls.length, callsBefore, 'no duplicate request is sent to the provider');
  assert.ok(!again.text.includes(API_KEY));

  // a *changed* credential is never answered from the previous measurement:
  // reusing a verdict measured against a different key would be a lie
  credentialService.setTestWindowsForTests({ reuseMs: 60000, minIntervalMs: 0 });
  const callsBeforeChange = upstreamCalls.length;
  await put('/api/admin/api-management/credentials', { provider: 'api_football', key: 'live-test-key-rotated-77aa' }, { token: adminBearer });
  const changed = await get('/api/admin/api-management/diagnostics?probe=1', { token: adminBearer });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.data.liveProbe.reused, false, 'a different credential is probed for real');
  assert.equal(upstreamCalls.length, callsBeforeChange + 1, 'the rotated credential gets its own real request');
  credentialService.__resetForTests();
});

test('audit: configuration changes are recorded in the audit trail', async () => {
  const events = store.apiConnectionEvents.map((e) => `${e.event}:${e.outcome}`);
  assert.ok(events.includes('SAVED:SUCCESS'), 'saving is audited');
  assert.ok(events.includes('TEST_OK:CONNECTED'), 'a successful test is audited');
  assert.ok(events.includes('TEST_FAILED:INVALID_KEY'), 'a failed test is audited with its outcome');
  assert.ok(events.includes('ACTIVATED:SUCCESS'));
  assert.ok(events.includes('DISABLED:SUCCESS'));
  for (const event of store.apiConnectionEvents) {
    assert.ok(!String(event.message || '').includes(API_KEY), 'no audit row may contain a key');
    assert.ok(!String(event.endpoint || '').includes('http'), 'the audit stores the endpoint path only');
  }
});

/* Repairs against the actual v3 contract and real DOM workflow. */
test('repair: an unsaved candidate cannot overwrite the stored credential verdict or quota', async () => {
  resetUpstream('ok'); store.apiCredentials.length = 0;
  await saveKey(API_KEY);
  await post('/api/admin/api-management/activate', { provider: 'api_football' }, { token: adminBearer });
  await post('/api/admin/api-management/test', { provider: 'api_football' }, { token: adminBearer });
  const before = { ...store.apiCredentials[0] };
  resetUpstream('invalid_key');
  const candidate = await post('/api/admin/api-management/test', { provider: 'api_football', key: 'unsaved-invalid-candidate' }, { token: adminBearer });
  assert.equal(candidate.json.data.state, 'INVALID_KEY');
  assert.equal(store.apiCredentials[0].connection_state, before.connection_state);
  assert.equal(store.apiCredentials[0].last_test_at, before.last_test_at);
  assert.equal(store.apiCredentials[0].quota_used_today, before.quota_used_today);
  const status = await get('/api/admin/api-management', { token: adminBearer });
  assert.equal(status.json.data.connection.state, 'CONNECTED');
});

test('repair: a test against a different host does not overwrite the stored host diagnostics', async () => {
  resetUpstream('ok'); store.apiCredentials.length = 0;
  await saveKey(API_KEY);
  await post('/api/admin/api-management/test', { provider: 'api_football' }, { token: adminBearer });
  resetUpstream('invalid_key');
  await post('/api/admin/api-management/test', { provider: 'api_football', host: 'api-football-v1.p.rapidapi.com/v3' }, { token: adminBearer });
  assert.equal(store.apiCredentials[0].connection_state, 'CONNECTED');
  assert.equal(store.apiCredentials[0].host, 'v3.football.api-sports.io');
});

test('repair: omitted host uses the saved marketplace host, not the direct-host default', async () => {
  resetUpstream('ok'); store.apiCredentials.length = 0;
  await saveKey(API_KEY, 'api-football-v1.p.rapidapi.com/v3');
  const tested = await post('/api/admin/api-management/test', { provider: 'api_football' }, { token: adminBearer });
  assert.equal(tested.json.data.ok, true);
  assert.equal(upstreamCalls[0].url, UPSTREAM_RAPIDAPI + '/status');
  assert.equal(upstreamCalls[0].headers['x-rapidapi-key'], API_KEY);
});

test('repair: environment-only tests survive status reload and report the real quota', async () => {
  const config = require('../server/config');
  const original = { ...config.apiFootball };
  resetUpstream('ok'); store.apiCredentials.length = 0;
  try {
    config.apiFootball.key = 'environment-test-only';
    config.apiFootball.host = 'https://api-football-v1.p.rapidapi.com/';
    const tested = await post('/api/admin/api-management/test', { provider: 'api_football' }, { token: adminBearer });
    assert.equal(tested.json.data.ok, true);
    const status = await get('/api/admin/api-management', { token: adminBearer });
    assert.equal(status.json.data.credentialSource, 'environment');
    assert.equal(status.json.data.connection.state, 'CONNECTED');
    assert.equal(status.json.data.quota.current, 120);
    assert.equal(status.json.data.plan.name, 'Pro');
    assert.equal(status.json.data.connection.host, 'api-football-v1.p.rapidapi.com/v3');
    assert.ok(!status.text.includes('environment-test-only'));
  } finally { Object.assign(config.apiFootball, original); credentialService.__resetForTests(); }
});

test('repair: refresh persists failures, exposes the DNS cause, then clears errors on recovery', async () => {
  resetUpstream('ok'); store.apiCredentials.length = 0;
  await saveKey(API_KEY);
  await post('/api/admin/api-management/activate', { provider: 'api_football' }, { token: adminBearer });
  await get('/api/admin/api-management/diagnostics?probe=1', { token: adminBearer });
  resetUpstream('network');
  const failed = await get('/api/admin/api-management/diagnostics?probe=1', { token: adminBearer });
  assert.equal(failed.json.data.liveProbe.networkCode, 'ENOTFOUND');
  assert.equal(failed.json.data.connection.state, 'NETWORK_ERROR');
  assert.match(failed.json.data.connection.hint, /DNS/);
  assert.equal(store.apiCredentials[0].last_error_code, 'NETWORK_ERROR');
  resetUpstream('ok');
  const recovered = await get('/api/admin/api-management/diagnostics?probe=1', { token: adminBearer });
  assert.equal(recovered.json.data.connection.state, 'CONNECTED');
  assert.equal(store.apiCredentials[0].last_error_code, null);
  assert.equal(store.apiCredentials[0].last_error_message, null);
  assert.equal(store.apiCredentials[0].last_error_at, null);
});

test('repair: concurrent identical tests share one real request; different concurrent keys are throttled', async () => {
  resetUpstream('ok'); store.apiCredentials.length = 0;
  let release;
  let entered;
  upstream.wait = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  upstream.entered = entered;
  const first = post('/api/admin/api-management/test', { provider: 'api_football', key: API_KEY }, { token: adminBearer });
  await started;
  const same = post('/api/admin/api-management/test', { provider: 'api_football', key: API_KEY }, { token: adminBearer });
  const different = await post('/api/admin/api-management/test', { provider: 'api_football', key: 'a-different-test-key' }, { token: adminBearer });
  assert.equal(different.status, 429);
  release();
  const [a, b] = await Promise.all([first, same]);
  assert.equal(a.json.data.ok, true);
  assert.equal(b.json.data.ok, true);
  assert.equal(b.json.data.reused, true);
  assert.equal(upstreamCalls.length, 1);
});

test('repair: rotating a saved credential while its test is pending ignores the old verdict', async () => {
  resetUpstream('ok'); store.apiCredentials.length = 0;
  await saveKey(API_KEY);
  let release;
  let entered;
  upstream.wait = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; }); upstream.entered = entered;
  const pending = post('/api/admin/api-management/test', { provider: 'api_football' }, { token: adminBearer });
  await started;
  await saveKey('rotated-while-testing-12345');
  release();
  assert.equal((await pending).json.data.ok, true, 'the old key really did work, but is no longer the saved key');
  assert.equal(store.apiCredentials[0].key_fingerprint, vault.fingerprint('rotated-while-testing-12345'));
  assert.equal(store.apiCredentials[0].connection_state, 'NOT_TESTED');
  assert.equal(store.apiCredentials[0].quota_used_today, null);
  assert.equal(store.apiCredentials[0].last_test_at, null);
});

test('repair: refresh and test share the same reuse window rather than calling twice', async () => {
  resetUpstream('ok'); store.apiCredentials.length = 0;
  await saveKey(API_KEY);
  await post('/api/admin/api-management/activate', { provider: 'api_football' }, { token: adminBearer });
  credentialService.setTestWindowsForTests({ reuseMs: 60000, minIntervalMs: 0 });
  await post('/api/admin/api-management/test', { provider: 'api_football' }, { token: adminBearer });
  const refreshed = await get('/api/admin/api-management/diagnostics?probe=1', { token: adminBearer });
  assert.equal(refreshed.json.data.liveProbe.reused, true);
  assert.equal(upstreamCalls.length, 1);
});

test('repair: API Management shows the saved prediction thresholds, not environment defaults', async () => {
  await settingsService.updateSettings({ min_confidence: 80, max_risk: 25 });
  try {
    const status = await get('/api/admin/api-management', { token: adminBearer });
    assert.equal(status.json.data.predictionRules.minConfidence, 80);
    assert.equal(status.json.data.predictionRules.maxRisk, 25);
    assert.equal(status.json.data.predictionRules.automaticTicketGeneration, false);
  } finally { await settingsService.updateSettings({ min_confidence: 72, max_risk: 35 }); }
});

test('repair: invalid environment URLs are configuration errors, not fake network outages', async () => {
  const config = require('../server/config');
  const original = { ...config.apiFootball };
  resetUpstream('ok'); store.apiCredentials.length = 0;
  try {
    config.apiFootball.key = 'environment-test-only';
    config.apiFootball.host = 'https://attacker.test/path';
    const status = await credentialService.getStatus();
    assert.equal(status.connection.state, 'CONFIG_INCOMPLETE');
    assert.equal(status.connection.reason, 'CONFIG_INVALID');
    assert.equal(upstreamCalls.length, 0);
  } finally { Object.assign(config.apiFootball, original); credentialService.__resetForTests(); }
});

test('repair: production can boot without an environment API key so a DB key can be configured', () => {
  const config = require('../server/config');
  const oldProduction = config.isProduction; const oldKey = config.apiFootball.key;
  try {
    config.isProduction = true; config.apiFootball.key = '';
    assert.ok(!config.validate().some((problem) => /API_FOOTBALL_KEY/.test(problem)));
    assert.ok(config.auth.jwtSecret.length >= 32, 'session authentication remains required');
  } finally { config.isProduction = oldProduction; config.apiFootball.key = oldKey; }
});

test('repair: a newer successful data request supersedes a failed probe without falsifying its history', async () => {
  resetUpstream('network'); store.apiCredentials.length = 0;
  await saveKey(API_KEY);
  await post('/api/admin/api-management/activate', { provider: 'api_football' }, { token: adminBearer });
  await post('/api/admin/api-management/test', { provider: 'api_football' }, { token: adminBearer });
  assert.equal(store.apiCredentials[0].connection_state, 'NETWORK_ERROR');
  const { apiFootball } = require('../server/services/apiFootball');
  apiFootball._recordSuccess(); // the request client observed a new valid provider payload
  await credentialService.recordUpstreamRequest({ ok: true });
  const status = await credentialService.getStatus();
  assert.equal(status.connection.state, 'CONNECTED');
  assert.equal(status.connection.reason, null);
  assert.equal(status.connection.hint, null);
  assert.equal(status.connection.lastTestState, 'NETWORK_ERROR', 'the historical failed test stays historical');
  assert.equal(store.apiCredentials[0].connection_state, 'NETWORK_ERROR', 'a data request does not rewrite test history');
});
