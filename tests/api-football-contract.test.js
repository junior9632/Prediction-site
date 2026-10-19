'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MockAgent } = require('undici');
const { ApiFootballClient, describeUnavailable, classifyProviderError } = require('../server/services/apiFootball');
const { createProviderDispatcher, networkFailure } = require('../server/utils/providerTransport');
const { normalizeHost, baseUrlForHost, normalizeApiKey, DIRECT_HOST, RAPID_HOST } = require('../server/utils/providerConfig');
const providers = require('../server/services/apiProviders');

// Documented /status shape: response is an OBJECT, not an array.
const statusBody = (current = 12, limit = 100, active = true) => ({
  get: 'status', parameters: [], errors: [], results: 1,
  response: { account: { firstname: 'Test' }, subscription: { plan: 'Test', active, end: '2099-01-01' }, requests: { current, limit_day: limit } },
});
function answer(body, status = 200, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), headers: { get: (k) => lower[k.toLowerCase()] ?? null } };
}
function make(handler, options = {}) {
  const calls = [];
  const waits = [];
  const client = new ApiFootballClient({ key: 'contract-test-key', host: DIRECT_HOST, manageCredential: false, maxRetries: 0,
    fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init); }, ...options });
  client._backoff = async (_attempt, wait) => { waits.push(wait); };
  return { client, calls, waits };
}

test('documented object-shaped /status works through native fetch and a private dispatcher', async (t) => {
  const dispatcher = new MockAgent(); dispatcher.disableNetConnect();
  t.after(() => dispatcher.close());
  dispatcher.get(`https://${DIRECT_HOST}`).intercept({ path: '/status', method: 'GET', headers: { 'x-apisports-key': 'contract-test-key' } })
    .reply(200, statusBody(), { headers: { 'X-RateLimit-Limit': '10' } });
  const client = new ApiFootballClient({ key: 'contract-test-key', host: DIRECT_HOST, dispatcher, manageCredential: false });
  const result = await client.probeCredentials();
  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.plan.name, 'Test');
  assert.deepEqual(result.quota, { current: 12, limitDay: 100 });
  assert.equal(client.quotaState().remaining, 88);
  assert.equal(result.rateLimitPerMinute, 10);
  dispatcher.assertNoPendingInterceptors();
});

test('provider transport falls back from an unreachable IPv6 address to IPv4', async (t) => {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(statusBody())); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let usedAll = false;
  const dispatcher = createProviderDispatcher('auto', (_host, options, callback) => {
    usedAll = options.all === true;
    if (options.all) callback(null, [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]);
    else callback(null, '::1', 6);
  });
  t.after(async () => { await dispatcher.close(); await new Promise((resolve) => server.close(resolve)); });
  const client = new ApiFootballClient({ key: 'local-test-key', host: DIRECT_HOST,
    baseUrl: `http://transport.test:${server.address().port}`, dispatcher, manageCredential: false, timeoutMs: 3000 });
  const result = await client.probeCredentials();
  assert.equal(result.ok, true, result.message);
  assert.equal(usedAll, true, 'only the provider dispatcher enables multi-address resolution');
});

test('a direct host pasted as a URL is normalized without double https or /v3', () => {
  for (const input of [DIRECT_HOST, ` https://${DIRECT_HOST}/ `, `"https://${DIRECT_HOST}/v3/"`]) {
    assert.equal(normalizeHost(input), DIRECT_HOST);
    assert.equal(baseUrlForHost(input), `https://${DIRECT_HOST}`);
  }
  assert.equal(normalizeHost('https://API-FOOTBALL-V1.P.RAPIDAPI.COM/'), RAPID_HOST);
  assert.equal(baseUrlForHost(RAPID_HOST), `https://${RAPID_HOST}`);
  for (const bad of ['http://127.0.0.1', `${DIRECT_HOST}.attacker.test`, `${DIRECT_HOST}@attacker.test`, `${DIRECT_HOST}/fixtures`, `${DIRECT_HOST}?host=evil`]) {
    assert.equal(baseUrlForHost(bad), null);
    assert.throws(() => providers.requireHost(providers.get('api_football'), bad), { code: 'HOST_NOT_ALLOWED' });
  }
  assert.equal(providers.get('__proto__'), null);
});

test('keys are trimmed/unquoted, but headers and control characters are rejected locally', () => {
  assert.equal(normalizeApiKey(' "test-key-123" '), 'test-key-123');
  for (const key of ['x-apisports-key: abcdefghi', 'abc\nabcdefghi', '********abcd', 'short']) {
    assert.throws(() => normalizeApiKey(key), { code: 'API_KEY_MALFORMED' });
  }
});

test('getStatus preserves quota and a forced probe never uses an older TTL cache entry', async () => {
  let n = 0;
  const { client, calls } = make(() => answer(statusBody(++n)));
  assert.equal((await client.getStatus()).requests.current, 1);
  assert.equal((await client.getStatus()).requests.current, 1);
  assert.equal(calls.length, 1);
  assert.equal((await client.probeCredentials()).quota.current, 2);
  assert.equal(calls.length, 2);
});

test('an explicit recovery probe can close an open circuit after the provider recovers', async () => {
  const { client, calls } = make(() => answer(statusBody()));
  client._breaker.failures = 4; client._breaker.openedAt = Date.now();
  await assert.rejects(() => client.request('/fixtures'), (e) => e.details.reason === 'CIRCUIT_OPEN');
  assert.equal((await client.probeCredentials()).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(client.breakerState().state, 'OK');
});

test('full quota and inactive subscriptions are not labelled as a working data source', async () => {
  for (const [body, state] of [[statusBody(100, 100), 'QUOTA_EXCEEDED'], [statusBody(12, 100, false), 'SUBSCRIPTION_INACTIVE']]) {
    const { client } = make(() => answer(body));
    const result = await client.probeCredentials();
    assert.equal(result.ok, false);
    assert.equal(result.state, state);
    assert.ok(result.hint);
    assert.equal(result.httpStatus, 200);
    assert.deepEqual(result.quota, { current: body.response.requests.current, limitDay: 100 });
  }
});

test('batch fixtures use documented ids (up to 20), not singular id with a joined string', async () => {
  const { client, calls } = make(() => answer({ errors: [], response: [] }));
  await client.getFixturesByIds([1, 2, '2', 3]);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('ids'), '1-2-3');
  assert.equal(url.searchParams.has('id'), false);
  assert.equal(url.searchParams.get('timezone'), 'UTC');
  for (const bad of [[true], [0], ['1 OR 1'], Array.from({ length: 21 }, (_, i) => i + 1)]) {
    await assert.rejects(() => client.getFixturesByIds(bad), { code: 'INVALID_FIXTURE_IDS' });
  }
  assert.equal(calls.length, 1);
});

test('odds requests use one integer fixture and the full-time Goals Over/Under market', async () => {
  const { client, calls } = make((url) => answer({ errors: [], response: [{ fixture: { id: Number(new URL(url).searchParams.get('fixture')) } }] }));
  const result = await client.getOddsByFixtures([10, 20, 10]);
  assert.equal(result.endpointCalls, 2);
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('fixture')), ['10', '20']);
  assert.ok(calls.every((c) => new URL(c.url).searchParams.get('bet') === '5'));
  await client.getOddsByDate('2026-10-16', 2);
  assert.equal(new URL(calls[2].url).searchParams.get('page'), '2');
});

test('both host authentication styles work and a redirect is never followed with the key', async () => {
  const { client, calls } = make(() => answer(null, 302, { location: 'https://attacker.test/' }), { host: RAPID_HOST });
  await assert.rejects(() => client.request('/status'), (e) => e.details.reason === 'REQUEST_REJECTED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['x-rapidapi-host'], 'api-football-v1.p.rapidapi.com');
  assert.equal(calls[0].init.headers['x-apisports-key'], undefined);
});

test('HTTP 200 auth and parameter errors fail closed instead of becoming zero fixtures', async () => {
  for (const [errors, reason] of [[{ token: 'Error/Missing application key' }, 'AUTH_REJECTED'], [{ ids: 'Invalid parameter' }, 'REQUEST_REJECTED'], [{ plan: 'This season is not supported by your plan' }, 'REQUEST_REJECTED']]) {
    const { client, calls } = make(() => answer({ errors, response: [] }), { maxRetries: 2 });
    await assert.rejects(() => client.getFixturesByIds([1, 2]), (e) => e.details.reason === reason && e.details.status === 200);
    assert.equal(calls.length, 1);
    assert.equal(client._cache.size, 0, 'a rejected payload must not enter the success cache');
    assert.equal(client._breaker.failures, 0, 'a parameter or auth rejection is not a transport outage');
  }
});

test('not subscribed responses are subscription failures, not invalid keys', async () => {
  for (const [body, status] of [
    [{ message: 'You are not subscribed to this API.' }, 403],
    [{ errors: { subscription: 'You are not subscribed to this API.' }, response: [] }, 200],
    [{ message: 'An active subscription is required.' }, 403],
    [{ errors: { subscription: 'No active subscription found.' } }, 403],
    [{ message: 'Your subscription has expired.' }, 403],
  ]) {
    assert.equal(classifyProviderError({ httpStatus: status, errors: body.errors, message: body.message }), 'SUBSCRIPTION_INACTIVE');
    const { client, calls, waits } = make(() => answer(body, status), { host: RAPID_HOST, maxRetries: 2 });
    const result = await client.probeCredentials();
    assert.equal(result.ok, false);
    assert.equal(result.state, 'SUBSCRIPTION_INACTIVE');
    assert.equal(result.reason, 'SUBSCRIPTION_INACTIVE');
    assert.equal(result.httpStatus, status);
    assert.match(result.hint, /RapidAPI/);
    assert.match(result.hint, /subscrib/i);
    assert.match(result.hint, /v3\.football\.api-sports\.io/);
    assert.equal(result.quota, null, 'no budget is invented for a rejected subscription');
    assert.equal(calls.length, 1, 'subscription failures are never retried or sent to another host');
    assert.equal(calls[0].url, `https://${RAPID_HOST}/status`);
    assert.deepEqual(waits, []);
    assert.equal(client._breaker.failures, 0, 'a missing subscription is not a network outage');
  }
  assert.equal(classifyProviderError({ httpStatus: 403, message: 'Invalid API key.' }), 'INVALID_KEY');
  assert.equal(classifyProviderError({ httpStatus: 401 }), 'INVALID_KEY');
  assert.equal(classifyProviderError({ httpStatus: 429, message: 'You have reached the limit of requests per minute of your subscription.' }), 'RATE_LIMITED');
  assert.equal(classifyProviderError({ httpStatus: 200, errors: { plan: 'This season is not supported by your plan' } }), 'REQUEST_REJECTED');
});

test('per-minute errors are not confused with daily quota exhaustion', async () => {
  const errors = { rateLimit: 'You have reached the limit of requests per minute of your subscription.' };
  assert.equal(classifyProviderError({ errors, httpStatus: 429 }), 'RATE_LIMITED');
  const { client, calls } = make(() => answer({ errors, response: [] }));
  await assert.rejects(() => client.request('/fixtures'), (e) => e.details.reason === 'RATE_LIMITED');
  assert.equal(client.quotaState().exhausted, false);
  assert.equal(calls.length, 1);
});

test('Retry-After is respected without sleeping after the final no-retry probe', async () => {
  const { client, calls, waits } = make(() => answer({ errors: { rateLimit: 'Too many requests' } }, 429, { 'retry-after': '60' }));
  const result = await client.probeCredentials();
  assert.equal(result.state, 'RATE_LIMITED');
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
  assert.equal(client._retryAfterMs(answer({}, 429, { 'retry-after': '60' })), 60000);
  await assert.rejects(() => client.request('/fixtures'), (e) => e.details.reason === 'RATE_LIMITED');
  assert.equal(calls.length, 1, 'an explicit provider cooldown blocks a second immediate request');
});

test('daily quota rolls over in a long-lived worker without restart', () => {
  const { client } = make(() => answer(statusBody()));
  client._quota = { ...client._quota, limitDay: 100, current: 100, remaining: 0, exhaustedUntil: Date.now() - 1,
    checkedAt: new Date(Date.now() - 86400000).toISOString(), exhaustedReason: 'yesterday' };
  const quota = client.quotaState();
  assert.equal(quota.exhausted, false);
  assert.equal(quota.remaining, null, 'today’s unknown usage is not invented as 100 remaining');
  assert.equal(quota.current, null);
});

test('a fresh positive /status quota clears a prior exhaustion after a plan upgrade', async () => {
  const { client } = make(() => answer(statusBody(100, 7500)));
  client._markQuotaExhausted('old plan spent');
  assert.equal(client.quotaState().exhausted, true);
  await client.getStatus();
  assert.equal(client.quotaState().exhausted, false);
  assert.equal(client.quotaState().remaining, 7400);
});

test('refreshing an unchanged credential cannot overwrite the learned per-minute limit', () => {
  const { client } = make(() => answer(statusBody()));
  client._learnQuotaFromHeaders(answer({}, 200, { 'X-RateLimit-Limit': '10' }));
  client.applyCredential({ key: 'contract-test-key', host: DIRECT_HOST, baseUrl: `https://${DIRECT_HOST}`, ratePerMinute: 60 });
  assert.equal(client.ratePerMinute, 10);
  client.applyCredential({ key: 'different-test-key', host: DIRECT_HOST, baseUrl: `https://${DIRECT_HOST}`, ratePerMinute: 60 });
  assert.equal(client._quota.perMinuteLimit, null);
  assert.equal(client.ratePerMinute, 60);
  client.applyCredential({ key: 'different-test-key', host: DIRECT_HOST, ratePerMinute: -10 });
  assert.equal(client.ratePerMinute, 60, 'a malformed budget cannot deadlock the request limiter');
});

test('DNS, connection, TLS and timeout causes survive fetch wrappers without leaking secrets', async () => {
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
    const nested = new TypeError('secret-bearing fetch failure: contract-test-key', { cause: new AggregateError([Object.assign(new Error('secret contract-test-key'), { code })]) });
    const { client } = make(() => { throw nested; });
    const result = await client.probeCredentials();
    assert.equal(result.networkCode, code);
    assert.equal(result.state, code.includes('TIMEOUT') ? 'TIMEOUT' : 'NETWORK_ERROR');
    assert.ok(result.hint);
    assert.ok(!JSON.stringify(result).includes('contract-test-key'));
    assert.ok(!JSON.stringify(client.stats).includes('contract-test-key'));
  }
  assert.match(networkFailure({ code: 'CERT_HAS_EXPIRED' }).hint, /Never disable TLS/);
});

test('provider errors that echo a key are redacted in diagnostics, exceptions and stats', async () => {
  const { client } = make(() => answer({ errors: { token: 'Invalid key contract-test-key' }, response: [] }));
  await assert.rejects(() => client.request('/fixtures'), (e) => {
    assert.equal(e.details.reason, 'AUTH_REJECTED');
    assert.ok(!JSON.stringify(e).includes('contract-test-key'));
    assert.ok(!e.message.includes('contract-test-key'));
    return true;
  });
  assert.ok(!JSON.stringify(client.stats).includes('contract-test-key'));
});

test('malformed data is not success, while a genuine empty array is a valid no-data answer', async () => {
  for (const body of [null, {}, { response: { unexpected: true } }]) {
    const { client } = make(() => answer(body));
    await assert.rejects(() => client.request('/fixtures'), (e) => e.details.reason === 'EMPTY_RESPONSE');
  }
  const { client } = make(() => answer({ errors: [], response: [] }));
  assert.deepEqual((await client.request('/fixtures')).response, []);
  const malformedStatus = make(() => answer({ response: { requests: { current: false } } }));
  assert.equal((await malformedStatus.client.probeCredentials()).ok, false);
});

test('network details have actionable hints and never turn a null HTTP status into zero', () => {
  const info = describeUnavailable({ message: 'connection failed', details: { reason: 'NETWORK_ERROR', networkCode: 'ENOTFOUND', hint: 'Check DNS', status: null } });
  assert.equal(info.httpStatus, null);
  assert.match(info.label, /ENOTFOUND/);
  assert.equal(info.hint, 'Check DNS');
});
