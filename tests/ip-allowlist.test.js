'use strict';

/**
 * “This IP is not allowed to call the API” — the regression suite for the
 * incident where every sync job answered
 *
 *   DATA_SOURCE_UNAVAILABLE · the provider rejected the request
 *   hint: "The plan may not include this endpoint/season, or the request
 *          parameters are outside the plan's range."
 *
 * while the provider had actually answered HTTP 200 with
 *
 *   {"Ip": "This IP is not allowed to call the API, check the list of allowed
 *           IPs in the dashboard."}
 *
 * Nothing was wrong with the key, the plan or the parameters: the account's
 * IP/domain allowlist did not contain the address the server calls from. The
 * generic hint sent the operator to look at seasons and parameters, which is
 * exactly where the problem is not.
 *
 * Covered here:
 *   1. the exact provider wording (and close variants) is classified as its own
 *      reason, with the key/plan/parameter classifications untouched;
 *   2. the sync payload carries the reason, the fix and — when it can be
 *      learned — this server's outbound address, without any retry;
 *   3. the client stops repeating a call that cannot succeed, keeps reporting
 *      the real reason instead of a generic breaker state, and still lets an
 *      explicit “Test connection” verify the repair immediately;
 *   4. address discovery never invents an address and never breaks a request.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'ip-allowlist-test-secret-0123456789ab';
delete process.env.SERVER_PUBLIC_IP;

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fakeDb = require('./fakeDb');
const settingsService = require('../server/services/settingsService');
const syncService = require('../server/services/syncService');

const {
  ApiFootballClient,
  ApiFootballUnavailable,
  CONNECTION_STATES,
  UNAVAILABLE_REASONS,
  REASON_INFO,
  classifyProviderError,
  describeUnavailable,
  ipNotAllowedHint,
  reasonInfo,
} = require('../server/services/apiFootball');
const egressIp = require('../server/utils/egressIp');

const DIRECT_HOST = 'v3.football.api-sports.io';
const PROVIDER_MESSAGE = 'This IP is not allowed to call the API, check the list of allowed IPs in the dashboard.';
const ALLOWLIST_URL = 'https://dashboard.api-football.com/profile?access';

/** The provider's documented answer: HTTP 200, empty response, one soft error. */
const ipBlockBody = () => ({ get: null, parameters: [], errors: { Ip: PROVIDER_MESSAGE }, results: 0, response: [] });

function answer(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), headers: { get: () => null } };
}

/**
 * A real client with an injected transport. Address discovery is stubbed by
 * default: the suite must never depend on (or wait for) a public IP service.
 */
function make(handler, options = {}) {
  const calls = [];
  const client = new ApiFootballClient({
    key: 'ip-allowlist-test-key',
    host: DIRECT_HOST,
    manageCredential: false,
    maxRetries: 2,
    serverAddressLookup: async () => ({ ips: ['203.0.113.42'], source: 'public address lookup', checkedAt: '2026-10-21T00:00:00.000Z' }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
    ...options,
  });
  client._backoff = async () => {};
  return { client, calls };
}

/* ---------------------------------------------------------------------- */
/* 1. classification                                                       */
/* ---------------------------------------------------------------------- */

test('the provider’s allowlist wording has its own reason, not “rejected request”', () => {
  assert.equal(classifyProviderError({ httpStatus: 200, errors: { Ip: PROVIDER_MESSAGE } }), CONNECTION_STATES.IP_NOT_ALLOWED);
  assert.equal(classifyProviderError({ httpStatus: 200, message: PROVIDER_MESSAGE }), CONNECTION_STATES.IP_NOT_ALLOWED);
  // close variants the provider/hosts have used
  for (const text of [
    'This IP is not allowed to call the API.',
    'Your IP address is not allowed to access this API.',
    'The IP address is blocked.',
    'Access denied: this IP is not permitted.',
    'check the list of allowed IPs in the dashboard',
  ]) {
    assert.equal(classifyProviderError({ httpStatus: 200, message: text }), CONNECTION_STATES.IP_NOT_ALLOWED, text);
  }
});

test('existing classifications are untouched by the allowlist rule', () => {
  const cases = [
    [{ httpStatus: 200, errors: { token: 'Error/Missing application key' } }, 'INVALID_KEY'],
    [{ httpStatus: 401 }, 'INVALID_KEY'],
    [{ httpStatus: 403, message: 'Invalid API key.' }, 'INVALID_KEY'],
    [{ httpStatus: 200, errors: { ids: 'Invalid parameter' } }, 'REQUEST_REJECTED'],
    [{ httpStatus: 200, errors: { plan: 'This season is not supported by your plan' } }, 'REQUEST_REJECTED'],
    [{ httpStatus: 200, errors: { subscription: 'You are not subscribed to this API.' } }, 'SUBSCRIPTION_INACTIVE'],
    [{ httpStatus: 429, message: 'You have reached the limit of requests per minute of your subscription.' }, 'RATE_LIMITED'],
    [{ httpStatus: 200, errors: { requests: 'You have reached the limit for the day' } }, 'QUOTA_EXCEEDED'],
    [{ httpStatus: 500, message: 'Internal server error' }, 'PROVIDER_UNAVAILABLE'],
    // A server error mentioning an IP is still an outage (retryable), not an
    // allowlist decision — the refusal word is what makes it one.
    [{ httpStatus: 502, message: 'Upstream could not resolve the IP address' }, 'PROVIDER_UNAVAILABLE'],
    [{ httpStatus: 200, message: 'The IP address could not be resolved' }, 'REQUEST_REJECTED'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(classifyProviderError(input), expected, JSON.stringify(input));
  }
});

test('the reason carries the exact dashboard screen and the precise fix', () => {
  const info = reasonInfo(UNAVAILABLE_REASONS.IP_NOT_ALLOWED);
  assert.match(info.label, /IP/i);
  assert.match(info.hint, new RegExp(ALLOWLIST_URL.replace(/[.?]/g, '\\$&')));
  assert.match(info.hint, /ADD/);
  assert.match(info.hint, /empty list means no restriction/);
  // the generic hint must NOT be reused: that is the bug being fixed
  assert.notEqual(info.hint, REASON_INFO.REQUEST_REJECTED.hint);
  assert.match(info.hint, /api:check|Test connection/);
});

/* ---------------------------------------------------------------------- */
/* 2. the client                                                           */
/* ---------------------------------------------------------------------- */

test('HTTP 200 + errors.Ip fails once, with the reason, the fix and this server’s address', async () => {
  const { client, calls } = make(() => answer(ipBlockBody()));
  await assert.rejects(() => client.getFixturesByDate('2026-10-21'), (err) => {
    assert.ok(err instanceof ApiFootballUnavailable);
    assert.equal(err.details.reason, 'IP_NOT_ALLOWED');
    assert.equal(err.details.status, 200);
    assert.equal(err.details.egressIp.ips[0], '203.0.113.42');
    assert.match(err.message, /IP address/i);
    assert.match(err.message, /203\.0\.113\.42/);
    assert.match(err.details.hint, /dashboard\.api-football\.com\/profile\?access/);
    assert.match(err.details.hint, /203\.0\.113\.42/);
    // a rejected request must not be cached as data
    assert.equal(client._cache.size, 0);
    // ... and it is a configuration fact, not a transport outage
    assert.equal(client._breaker.failures, 0);
    return true;
  });
  assert.equal(calls.length, 1, 'an allowlist rejection is never retried');
});

test('the top-level `{"Ip": ...}` shape is a rejection too, never “empty response” or zero fixtures', async () => {
  const { client } = make(() => answer({ Ip: PROVIDER_MESSAGE }));
  await assert.rejects(() => client.getFixturesByDate('2026-10-21'), (err) => {
    assert.equal(err.details.reason, 'IP_NOT_ALLOWED');
    assert.match(err.message, /IP address/i);
    return true;
  });
});

test('the sync payload says WHAT to change, instead of “parameters outside the plan’s range”', async () => {
  const { client } = make(() => answer(ipBlockBody()));
  const err = await client.getFixturesByDate('2026-10-21').catch((e) => e);
  const report = describeUnavailable(err);
  assert.equal(report.reason, 'IP_NOT_ALLOWED');
  assert.equal(report.httpStatus, 200);
  assert.deepEqual(report.egressIp.ips, ['203.0.113.42']);
  assert.match(report.hint, /profile\?access/);
  assert.doesNotMatch(report.hint, /season|parameters are outside/i);
  // exactly what syncService.unavailableResult exposes to the dashboard
  const payload = {
    status: 'DATA_SOURCE_UNAVAILABLE',
    error: err.message,
    reason: report.reason,
    label: report.label,
    hint: report.hint,
    httpStatus: report.httpStatus,
    resetAt: report.resetAt,
    egressIp: report.egressIp,
  };
  assert.equal(payload.label, 'this server’s IP address is not allowed by the provider');
  assert.match(payload.hint, /203\.0\.113\.42/);
});

test('the fixtures sync job itself returns the reason, the fix and the address — never zero fixtures', async () => {
  const ctx = fakeDb.install({ fixtures: [], leagues: [], teamForms: [] });
  try {
    const { client } = make(() => answer(ipBlockBody()));
    const base = settingsService.toEngineSettings(settingsService.defaults());
    const result = await syncService.syncFixtures({
      api: client,
      now: new Date('2026-10-21T12:00:00Z'),
      includeHistory: false,
      settings: { ...base, syncDaysAhead: 0, syncLeagues: [], apiQuotaReserve: 0 },
    });
    assert.equal(result.status, 'DATA_SOURCE_UNAVAILABLE');
    assert.equal(result.reason, 'IP_NOT_ALLOWED');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.upcoming, undefined, 'no fixture count is invented');
    assert.match(result.hint, /dashboard\.api-football\.com\/profile\?access/);
    assert.match(result.hint, /203\.0\.113\.42/);
    assert.deepEqual(result.egressIp.ips, ['203.0.113.42']);

    const row = ctx.store.apiSyncLogs[0];
    assert.equal(row.status, 'FAILED');
    assert.match(row.message, /not allowed by the provider/i);
    assert.match(row.error_detail, /IP address/i);
  } finally {
    ctx.restore();
  }
});

test('a blocked address is not hammered, but the reason survives and a test still gets through', async () => {
  let mode = 'blocked';
  const { client, calls } = make(() => (mode === 'blocked' ? answer(ipBlockBody()) : answer({ get: 'status', parameters: [], errors: [], results: 1, response: { requests: { current: 5, limit_day: 100 }, subscription: { plan: 'Pro', active: true } } })));

  await assert.rejects(() => client.getFixturesByDate('2026-10-21'), (e) => e.details.reason === 'IP_NOT_ALLOWED');
  assert.equal(calls.length, 1);

  // The next background call inside the cooldown is refused locally — with the
  // real reason (never a generic CIRCUIT_OPEN) and the same fix.
  await assert.rejects(() => client.getOddsByFixture(1234), (err) => {
    assert.equal(err.details.reason, 'IP_NOT_ALLOWED');
    assert.match(err.details.hint, /profile\?access/);
    assert.ok(err.details.retryAt);
    return true;
  });
  assert.equal(calls.length, 1, 'no request is spent on a call that cannot succeed yet');
  assert.equal(client.breakerState().state, 'IP_BLOCKED');
  assert.equal(client.breakerState().available, false);
  assert.equal(client.breakerState().reason, 'IP_NOT_ALLOWED');

  // An explicit credential test must be able to prove the repair immediately.
  mode = 'ok';
  const probe = await client.probeCredentials();
  assert.equal(probe.ok, true);
  assert.equal(calls.length, 2, 'Test connection bypasses the local cooldown');
});

test('the allowlist reason is reported without an address when none can be learned', async () => {
  const { client } = make(() => answer(ipBlockBody()), { serverAddressLookup: async () => null });
  await assert.rejects(() => client.getFixturesByDate('2026-10-21'), (err) => {
    assert.equal(err.details.reason, 'IP_NOT_ALLOWED');
    assert.equal(err.details.egressIp, null);
    // the fix is never a dead end: the dashboard screen is still named
    assert.match(err.details.hint, /profile\?access/);
    assert.doesNotMatch(err.details.hint, /This server reports/);
    return true;
  });
});

test('ProbeCredentials names the allowlist state and its fix', async () => {
  const { client } = make(() => answer(ipBlockBody()));
  const probe = await client.probeCredentials();
  assert.equal(probe.ok, false);
  assert.equal(probe.state, CONNECTION_STATES.IP_NOT_ALLOWED);
  assert.equal(probe.reason, 'IP_NOT_ALLOWED');
  assert.equal(probe.label, 'This server’s IP is not on the provider allowlist');
  assert.equal(probe.httpStatus, 200);
  assert.deepEqual(probe.egressIp.ips, ['203.0.113.42']);
  assert.match(probe.hint, /profile\?access/);
});

/* ---------------------------------------------------------------------- */
/* 3. this server's address                                                */
/* ---------------------------------------------------------------------- */

test('address discovery prefers a declared value, then a lookup, then local interfaces', async () => {
  egressIp.resetAddressCache();

  const declared = await egressIp.discoverServerAddresses({ declaredIp: '198.51.100.7', skipLookup: true });
  assert.deepEqual(declared.ips, ['198.51.100.7']);
  assert.equal(declared.source, 'SERVER_PUBLIC_IP');

  // A declaration that is not routable is ignored rather than reported.
  const bogus = await egressIp.discoverServerAddresses({ declaredIp: '10.0.0.5', skipLookup: true });

  const looked = await egressIp.discoverServerAddresses({
    declaredIp: '',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ ip: '192.0.2.10' }) }),
  });
  assert.equal(looked.ips[0], '192.0.2.10');
  assert.equal(looked.source, 'public address lookup');

  egressIp.resetAddressCache();
  const plainText = await egressIp.discoverServerAddresses({
    declaredIp: '',
    fetchImpl: async () => ({ ok: true, text: async () => '192.0.2.11\n' }),
  });
  assert.equal(plainText.ips[0], '192.0.2.11');

  // nothing learned: null, never an invented address
  egressIp.resetAddressCache();
  const nothing = await egressIp.discoverServerAddresses({
    declaredIp: '',
    lookupEnabled: false,
  });
  if (!egressIp.localPublicAddresses().length) assert.equal(nothing, null);
  assert.ok(bogus === null || bogus.source === 'network interfaces' || bogus.source === 'public address lookup');
});

test('a failing address lookup is swallowed — the rejection still explains itself', async () => {
  egressIp.resetAddressCache();
  const offline = await egressIp.discoverServerAddresses({
    declaredIp: '',
    fetchImpl: async () => {
      throw new Error('ENETUNREACH');
    },
  });
  if (!egressIp.localPublicAddresses().length) assert.equal(offline, null);

  // ... and the client keeps working without an address
  const { client } = make(() => answer(ipBlockBody()), {
    serverAddressLookup: (options) => egressIp.discoverServerAddresses({ ...options, declaredIp: '', fetchImpl: async () => { throw new Error('offline'); } }),
  });
  await assert.rejects(() => client.getFixturesByDate('2026-10-21'), (err) => {
    assert.equal(err.details.reason, 'IP_NOT_ALLOWED');
    assert.match(err.details.hint, /profile\?access/);
    return true;
  });
});

test('private addresses are never presented as an allowlist entry', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.5', '169.254.10.10', '100.64.0.9', '::1', 'fe80::1', 'fd00::1', 'not-an-ip', '']) {
    assert.equal(egressIp.isPublicAddress(address), false, address);
  }
  for (const address of ['203.0.113.42', '8.8.8.8', '2001:4860:4860::8888', '::ffff:203.0.113.42']) {
    assert.equal(egressIp.isPublicAddress(address), true, address);
  }
  // 172.32/12 and 100.128/10 are public
  assert.equal(egressIp.isPublicAddress('172.32.0.1'), true);
  assert.equal(egressIp.isPublicAddress('100.128.0.1'), true);
});

test('the hint reads naturally for one and for several addresses', () => {
  const one = ipNotAllowedHint({ ips: ['203.0.113.42'], source: 'SERVER_PUBLIC_IP' });
  assert.match(one, /This server reports 203\.0\.113\.42/);
  assert.match(one, /add that address/);
  const two = ipNotAllowedHint({ ips: ['203.0.113.42', '2001:db8::42'], source: 'network interfaces' });
  assert.match(two, /203\.0\.113\.42 and 2001:db8::42/);
  assert.match(two, /add those addresses/);
  assert.equal(ipNotAllowedHint(null), REASON_INFO.IP_NOT_ALLOWED.hint);
});
