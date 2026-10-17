'use strict';

/**
 * DATA SOURCE REASONS — the regression suite for the incident where EVERY
 * failing sync job reported the same sentence ("DATA SOURCE TEMPORARILY
 * UNAVAILABLE") while the panel showed a fixture sync FAILING and a results
 * sync SUCCEEDING with zeros.
 *
 * The results job succeeds because it makes no upstream call when nothing is
 * awaiting settlement — the fixtures job is the one that really fails. What the
 * operator could not see was WHY: a spent daily quota, a rejected key, a
 * provider outage and an unreachable host were all reported identically.
 *
 * Covered here:
 *   1. one stable reason per cause (quota / rate limit / auth / outage /
 *      network), with the exact fix and, for a quota, the reset time;
 *   2. the daily request budget the provider advertises on every answer is
 *      learned, persisted in the sync log and shown by /api/health;
 *   3. a spent quota stops the client immediately instead of retrying (the
 *      documented way to get an API key firewalled) — while the free `/status`
 *      probe stays available for diagnosis;
 *   4. background sync pauses before it eats the requests a manual generation
 *      needs (api_quota_reserve) and says so with status SKIPPED;
 *   5. the history backfill only re-requests days whose data is stale;
 *   6. head-to-head enrichment only runs when the local sample is insufficient
 *      and never exceeds h2h_sync_max_calls.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'data-source-reasons-test-secret';
delete process.env.API_FOOTBALL_KEY;
delete process.env.API_FOOTBALL_HOST;

const test = require('node:test');
const assert = require('node:assert/strict');

const fakeDb = require('./fakeDb');
const settingsService = require('../server/services/settingsService');
const syncService = require('../server/services/syncService');
const fixtureService = require('../server/services/fixtureService');
const statsService = require('../server/services/statsService');
const healthController = require('../server/controllers/healthController');
const {
  ApiFootballClient,
  ApiFootballUnavailable,
  UNAVAILABLE_REASONS,
  describeUnavailable,
  unavailableMessage,
  reasonInfo,
  apiFootball,
} = require('../server/services/apiFootball');

const BASE = settingsService.toEngineSettings(settingsService.defaults());

/** The next 00:00 UTC — exactly the rule the client uses (`nextDailyReset`). */
function nextDailyReset(from = new Date()) {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1)).toISOString();
}

/**
 * Assert the daily-reset instant the client reported for an action that started
 * at `startedAt`.
 *
 * These four assertions used to compare against a hard-coded `RESET_AT`, so they
 * only passed on the day that date was written: the client reports the NEXT
 * 00:00 UTC, computed at the moment it gives up. `nextDailyReset()` is a step
 * function that changes exactly at 00:00 UTC, so an action that began at
 * `startedAt` can only legitimately report one of two values: the next midnight
 * after it started, or — when the test itself straddles midnight — the next
 * midnight after the assertion. Both are accepted, nothing else is, and the
 * production quota behaviour is untouched: the test follows the contract, it
 * does not dictate it.
 */
function assertDailyReset(actual, startedAt, message) {
  const allowed = new Set([nextDailyReset(startedAt), nextDailyReset(new Date())]);
  assert.match(String(actual), /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/, `${message}: an exact 00:00 UTC instant`);
  assert.ok(allowed.has(actual), `${message}: expected ${[...allowed].join(' or ')}, got ${actual}`);
  assert.ok(new Date(actual).getTime() > startedAt.getTime(), `${message}: requests have not resumed yet`);
}

// Synthetic fixtures carry a fixed reset so the message-formatting assertions
// stay deterministic; nothing here depends on today's date.
const RESET_AT = '2026-10-17T00:00:00.000Z';

/** Minimal provider answer with the headers API-Football sends on every call. */
function jsonResponse(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

/** A real client with an injected transport (no network, no credential refresh). */
function clientWith(handler, options = {}) {
  const calls = [];
  const waits = [];
  const client = new ApiFootballClient({ key: 'test-key', maxRetries: 1, ...options, fetch: handler });
  client.manageCredential = false;
  client._backoff = async (_attempt, waitMs) => {
    waits.push(waitMs);
  };
  const original = client.fetchImpl;
  client.fetchImpl = async (url, init) => {
    calls.push(String(url));
    return original(url, init);
  };
  return { client, calls, waits };
}

/** The exact error the real client throws when the plan's day is spent. */
function quotaError(limitDay = 100) {
  const quota = {
    known: true,
    limitDay,
    current: limitDay,
    remaining: 0,
    source: 'test',
    checkedAt: null,
    exhausted: true,
    resetsAt: RESET_AT,
  };
  return new ApiFootballUnavailable('API-Football daily quota reached', {
    reason: UNAVAILABLE_REASONS.QUOTA_EXCEEDED,
    resetAt: RESET_AT,
    quota,
  });
}

/* ------------------------------------------------------------------ */
/* 1. one reason per cause                                             */
/* ------------------------------------------------------------------ */

test('quota: a spent daily budget is reported as QUOTA_EXCEEDED with the reset time', async () => {
  const { client, calls } = clientWith(async () =>
    jsonResponse(200, { get: 'fixtures', errors: { requests: 'You have reached the request limit for the day' }, response: [] })
  );

  const startedAt = new Date();
  await assert.rejects(client.request('/fixtures', { date: '2026-10-16' }), (err) => {
    const info = describeUnavailable(err);
    assert.equal(info.reason, UNAVAILABLE_REASONS.QUOTA_EXCEEDED);
    assert.match(info.label, /quota/i);
    assert.match(info.hint, /00:00 UTC/);
    assertDailyReset(info.resetAt, startedAt, 'the client says when requests resume');
    return true;
  });

  const message = unavailableMessage(quotaError());
  assert.match(message, /^DATA SOURCE TEMPORARILY UNAVAILABLE · daily request quota exhausted/);
  assert.match(message, /retry after 2026-10-17T00:00:00\.000Z/);

  // It really was one provider call — the quota answer is not retried.
  assert.equal(calls.length, 1);
});

test('quota: once the day is spent, calls stop — but the free /status probe still works', async () => {
  let upstream = 0;
  const { client } = clientWith(async (url) => {
    upstream += 1;
    if (String(url).endsWith('/status')) {
      return jsonResponse(200, { get: 'status', errors: [], results: 1, response: [{ requests: { current: 100, limit_day: 100 } }] });
    }
    return jsonResponse(200, { errors: { requests: 'limit reached' }, response: [] });
  });

  const startedAt = new Date();
  await assert.rejects(client.request('/odds', { date: '2026-10-16' }), /quota/i);
  assert.equal(upstream, 1);

  await assert.rejects(client.request('/odds', { date: '2026-10-16' }), (err) => {
    assert.equal(err.details.reason, UNAVAILABLE_REASONS.QUOTA_EXCEEDED);
    assertDailyReset(err.details.resetAt, startedAt, 'the paused client keeps the reset it first reported');
    return true;
  });
  assert.equal(upstream, 1, 'the second call never reached the provider');

  // `/status` does not count against the daily quota — keep it usable so the
  // operator can see the real usage while everything else is paused.
  const status = await client.getStatus();
  assert.equal(upstream, 2);
  assert.equal(status.requests.limit_day, 100);
});

test('quota: the per-minute rate limit is a different reason and honours Retry-After', async () => {
  const { client, calls, waits } = clientWith(async () =>
    jsonResponse(429, { errors: { rate: 'Too many requests' } }, { 'retry-after': '2' })
  );

  await assert.rejects(client.request('/fixtures', { date: '2026-10-16' }), (err) => {
    const info = describeUnavailable(err);
    assert.equal(info.reason, UNAVAILABLE_REASONS.RATE_LIMITED);
    assert.equal(info.httpStatus, 429);
    assert.match(info.hint, /per minute/i);
    return true;
  });
  // at most one retry, waiting exactly what the provider asked for
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
});

test('quota: the provider headers teach the daily budget without an extra request', async () => {
  const { client } = clientWith(async () =>
    jsonResponse(200, { response: [] }, { 'x-ratelimit-requests-limit': '100', 'x-ratelimit-requests-remaining': '7', 'x-ratelimit-limit': '10' })
  );

  await client.request('/fixtures', { date: '2026-10-16' });
  const quota = client.quotaState();
  assert.equal(quota.known, true);
  assert.equal(quota.limitDay, 100);
  assert.equal(quota.remaining, 7);
  assert.equal(quota.current, 93);
  assert.equal(quota.exhausted, false);
  assert.equal(client.ratePerMinute, 10, 'the client never exceeds the per-minute budget the provider advertises');
});

test('quota: 429 with 0 requests left is the daily quota, not a per-minute burst', async () => {
  const { client, calls } = clientWith(async () =>
    jsonResponse(429, { errors: { requests: 'daily limit' } }, { 'x-ratelimit-requests-limit': '100', 'x-ratelimit-requests-remaining': '0' })
  );

  const startedAt = new Date();
  await assert.rejects(client.request('/fixtures', { date: '2026-10-16' }), (err) => {
    assert.equal(err.details.reason, UNAVAILABLE_REASONS.QUOTA_EXCEEDED);
    return true;
  });
  assert.equal(calls.length, 1, 'no retry storm against an exhausted plan');
  assert.equal(client.breakerState().state, 'QUOTA_EXHAUSTED');
  assert.equal(client.breakerState().available, false);
  assertDailyReset(client.breakerState().resetsAt, startedAt, 'the breaker says when the plan resumes');
});

test('quota: the reset expectation survives a UTC-midnight crossing inside the test', () => {
  // The action ran "yesterday": the client reported today's 00:00 UTC. If the
  // assertion happens after midnight, the naive `nextDailyReset()` comparison
  // rejects the correct answer — the exact flake that made these tests fail on
  // every day after the frozen date. The helper must accept both sides.
  const startedAt = new Date(Date.now() - 86_400_000);
  const reportedBeforeMidnight = nextDailyReset(startedAt);
  assertDailyReset(reportedBeforeMidnight, startedAt, 'a reset computed before midnight is accepted');
  assertDailyReset(nextDailyReset(), startedAt, 'a reset computed after midnight is accepted too');

  const unrelated = new Date(nextDailyReset());
  unrelated.setUTCDate(unrelated.getUTCDate() + 2);
  assert.throws(
    () => assertDailyReset(unrelated.toISOString(), startedAt, 'an invented reset'),
    /expected/,
    'an unrelated midnight is still rejected'
  );
});

test('auth, outage and network failures are distinguishable', async () => {
  const cases = [
    [() => jsonResponse(403, { errors: { token: 'invalid key' } }), UNAVAILABLE_REASONS.AUTH_REJECTED, /API_FOOTBALL_HOST/],
    [() => jsonResponse(503, { errors: { server: 'Service Unavailable' }, response: [] }), UNAVAILABLE_REASONS.PROVIDER_UNAVAILABLE, null],
    [
      () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
      },
      UNAVAILABLE_REASONS.NETWORK_ERROR,
      /api:check/,
    ],
  ];
  for (const [handler, reason, hintPattern] of cases) {
    const { client } = clientWith(handler);
    await assert.rejects(client.request('/fixtures', { date: '2026-10-16' }), (err) => {
      const info = describeUnavailable(err);
      assert.equal(info.reason, reason, `${reason}: classified`);
      assert.ok(info.hint, `${reason}: carries the fix`);
      if (hintPattern) assert.match(info.hint, hintPattern);
      return true;
    });
  }
});

test('every reason has an operator-facing label and fix', () => {
  for (const reason of Object.values(UNAVAILABLE_REASONS)) {
    const info = reasonInfo(reason);
    assert.ok(info.label && info.label.length > 3, `${reason} has a label`);
    assert.ok(info.hint && info.hint.length > 10, `${reason} tells the operator what to do`);
  }
});

/* ------------------------------------------------------------------ */
/* 2/4. what a failing sync job records and when it pauses             */
/* ------------------------------------------------------------------ */

/** A client double that fails like the real one and reports a known budget. */
function quotaClient({ remaining = 0, limitDay = 100, calls = [] } = {}) {
  return {
    configured: true,
    host: 'v3.football.api-sports.io',
    ratePerMinute: 60,
    stats: { calls: 0, failures: 0, cacheHits: 0, lastCallAt: null, lastError: null, quota: null },
    calls,
    isAvailable: () => true,
    quotaState: () => ({
      known: true,
      limitDay,
      current: limitDay - remaining,
      remaining,
      source: 'response headers',
      checkedAt: null,
      exhausted: remaining <= 0,
      resetsAt: RESET_AT,
    }),
    breakerState: () => ({ state: remaining <= 0 ? 'QUOTA_EXHAUSTED' : 'OK', available: remaining > 0, quota: null }),
    async getFixturesByDate(date) {
      calls.push(date);
      throw quotaError(limitDay);
    },
  };
}

test('sync: a quota failure says WHY in the log, the payload and the budget columns', async () => {
  const ctx = fakeDb.install({ fixtures: [], leagues: [], teamForms: [] });
  try {
    const api = quotaClient({ remaining: 9, limitDay: 100 });
    const result = await syncService.syncFixtures({
      api,
      now: new Date('2026-10-16T12:00:00Z'),
      includeHistory: false,
      settings: { ...BASE, syncDaysAhead: 0, syncLeagues: [], apiQuotaReserve: 0 },
    });

    assert.equal(result.status, 'DATA_SOURCE_UNAVAILABLE');
    assert.equal(result.reason, UNAVAILABLE_REASONS.QUOTA_EXCEEDED);
    assert.equal(result.resetAt, RESET_AT);
    assert.match(result.hint, /00:00 UTC/);

    const row = ctx.store.apiSyncLogs[0];
    assert.equal(row.status, 'FAILED');
    assert.match(row.message, /DATA SOURCE TEMPORARILY UNAVAILABLE · daily request quota exhausted/);
    assert.equal(row.error_detail, 'API-Football daily quota reached', "the provider's own words are kept");
    assert.equal(row.requests_used, 91, 'the daily budget the provider reported is recorded');
    assert.equal(row.requests_limit, 100);
  } finally {
    ctx.restore();
  }
});

test('sync: background jobs pause before eating the reserve a manual generation needs', async () => {
  const ctx = fakeDb.install({ fixtures: [], leagues: [], teamForms: [] });
  try {
    const calls = [];
    const api = quotaClient({ remaining: 12, limitDay: 100, calls });

    const result = await syncService.syncFixtures({
      api,
      now: new Date('2026-10-16T12:00:00Z'),
      includeHistory: false,
      settings: { ...BASE, apiQuotaReserve: 25, syncLeagues: [] },
    });

    assert.equal(result.status, 'SKIPPED');
    assert.equal(result.reason, UNAVAILABLE_REASONS.QUOTA_RESERVED);
    assert.equal(calls.length, 0, 'not a single provider request was spent');

    const row = ctx.store.apiSyncLogs[0];
    assert.equal(row.status, 'SKIPPED', 'the panel shows a pause, not a failure');
    assert.match(row.message, /REQUEST BUDGET RESERVED/);
    assert.match(row.message, /12 of 100 request\(s\) left/);
    assert.equal(row.requests_used, 88);
  } finally {
    ctx.restore();
  }
});

test('sync: with reserve 0 (or plenty of budget left) the job runs normally', async () => {
  const ctx = fakeDb.install({ fixtures: [], leagues: [], teamForms: [] });
  try {
    const calls = [];
    const api = quotaClient({ remaining: 60, limitDay: 100, calls });
    api.getFixturesByDate = async (date) => {
      calls.push(date);
      return { get: 'fixtures', errors: null, results: 0, paging: { current: 1, total: 1 }, response: [] };
    };

    const result = await syncService.syncFixtures({
      api,
      now: new Date('2026-10-16T12:00:00Z'),
      includeHistory: false,
      settings: { ...BASE, apiQuotaReserve: 25, syncDaysAhead: 0, syncLeagues: [] },
    });

    assert.equal(result.status, undefined, 'a normal run');
    assert.equal(calls.length, 1);
    const row = ctx.store.apiSyncLogs[0];
    assert.equal(row.status, 'SUCCESS');
    assert.equal(row.requests_used, 40);
  } finally {
    ctx.restore();
  }
});

/* ------------------------------------------------------------------ */
/* 2b. a NEW cron process only knows the budget the last run recorded   */
/* ------------------------------------------------------------------ */

/**
 * A client double for a process that has not spoken to the provider yet: it
 * reports no quota at all, exactly like a freshly started cron script. Any
 * upstream call it serves is counted in `calls`.
 */
function unknownQuotaClient(calls = []) {
  const empty = { get: 'fixtures', errors: null, results: 0, paging: { current: 1, total: 1 }, response: [] };
  return {
    configured: true,
    host: 'v3.football.api-sports.io',
    ratePerMinute: 60,
    stats: { calls: 0, failures: 0, cacheHits: 0, lastCallAt: null, lastError: null, quota: null },
    isAvailable: () => true,
    quotaState: () => ({
      known: false,
      limitDay: null,
      current: null,
      remaining: null,
      source: null,
      checkedAt: null,
      exhausted: false,
      exhaustedReason: null,
      resetsAt: RESET_AT,
    }),
    breakerState: () => ({ state: 'OK', available: true, quota: null }),
    async getFixturesByDate(date) {
      calls.push(`fixtures:${date}`);
      return empty;
    },
    async getOddsByDate(date) {
      calls.push(`odds:${date}`);
      return { ...empty, get: 'odds' };
    },
  };
}

test('sync: a new cron process remembers the budget the previous run recorded', async () => {
  const ctx = fakeDb.install({ fixtures: [], leagues: [], teamForms: [] });
  try {
    // 22:00 — the plan's day is spent, and this run has no reserve configured:
    // it spends its last request, learns the budget and records it.
    const spent = quotaClient({ remaining: 0, limitDay: 100 });
    const first = await syncService.syncFixtures({
      api: spent,
      now: new Date('2026-10-16T22:00:00Z'),
      includeHistory: false,
      settings: { ...BASE, apiQuotaReserve: 0, syncDaysAhead: 0, syncLeagues: [] },
    });
    assert.equal(first.reason, UNAVAILABLE_REASONS.QUOTA_EXCEEDED);
    assert.equal(ctx.store.apiSyncLogs[0].requests_used, 100, 'the spent budget is on record');

    // 23:00 — cron starts a NEW process: its client knows nothing yet, so only
    // the recorded budget can stop the jobs from piling failure on failure.
    const calls = [];
    const fresh = unknownQuotaClient(calls);
    const settings = { ...BASE, apiQuotaReserve: 25, syncDaysAhead: 0, syncLeagues: [] };
    const jobs = [
      ['fixtures', await syncService.syncFixtures({ api: fresh, now: new Date('2026-10-16T23:00:00Z'), includeHistory: false, settings })],
      ['odds', await syncService.syncOdds({ api: fresh, now: new Date('2026-10-16T23:00:00Z'), settings })],
      ['results', await syncService.syncResults({ api: fresh, now: new Date('2026-10-16T23:00:00Z'), settings })],
    ];
    for (const [name, job] of jobs) {
      assert.equal(job.status, 'SKIPPED', `${name} pauses instead of failing again`);
      assert.equal(job.reason, UNAVAILABLE_REASONS.QUOTA_RESERVED);
    }
    assert.equal(calls.length, 0, 'not one request was sent against a spent plan');

    const paused = ctx.store.apiSyncLogs.find((row) => row.job === 'results');
    assert.equal(paused.status, 'SKIPPED');
    assert.equal(paused.requests_used, 100);
    assert.equal(paused.requests_limit, 100);
    assert.match(paused.message, /0 of 100 request\(s\) left today/);
    assert.match(paused.message, /resets 2026-10-17T00:00:00\.000Z/);
  } finally {
    ctx.restore();
  }
});

test('sync: a budget recorded on a previous day does not stop today (the counter reset)', async () => {
  const ctx = fakeDb.install({
    fixtures: [],
    apiSyncLogs: [
      {
        id: 1,
        job: 'fixtures',
        status: 'FAILED',
        endpoint_calls: 1,
        rows_written: 0,
        rows_read: 0,
        requests_used: 100,
        requests_limit: 100,
        message: 'DATA SOURCE TEMPORARILY UNAVAILABLE · daily request quota exhausted',
        error_detail: 'API-Football daily quota reached',
        duration_ms: 900,
        started_at: '2026-10-15 21:00:00',
        finished_at: '2026-10-15 21:00:00',
      },
    ],
  });
  try {
    const calls = [];
    const fresh = unknownQuotaClient(calls);
    const result = await syncService.syncFixtures({
      api: fresh,
      now: new Date('2026-10-16T09:00:00Z'),
      includeHistory: false,
      settings: { ...BASE, apiQuotaReserve: 25, syncDaysAhead: 0, syncLeagues: [] },
    });
    assert.notEqual(result.status, 'SKIPPED', "yesterday's spent budget must not pause today");
    assert.equal(calls.length, 1, 'the job ran normally');
  } finally {
    ctx.restore();
  }
});

test('sync: a results job with nothing to settle says so instead of looking broken', async () => {
  const ctx = fakeDb.install({ fixtures: [] });
  try {
    const result = await syncService.syncResults({
      api: unknownQuotaClient([]),
      now: new Date('2026-10-16T22:00:00Z'),
      settings: { ...BASE, apiQuotaReserve: 0 },
    });
    assert.equal(result.fixturesChecked, 0);
    const row = ctx.store.apiSyncLogs[0];
    assert.equal(row.status, 'SUCCESS');
    assert.match(row.message, /results=0 settled=0 tickets=0 checked=0/, 'zeros are explained, not hidden');
  } finally {
    ctx.restore();
  }
});

test('cron output: one plain-language line per failed or paused job', () => {
  const { describeRun, runExitCode } = require('../scripts/lib/sync-output');

  const quota = {
    job: 'fixtures',
    status: 'DATA_SOURCE_UNAVAILABLE',
    reason: UNAVAILABLE_REASONS.QUOTA_EXCEEDED,
    label: 'daily request quota exhausted',
    error: 'API-Football daily quota reached',
    hint: 'Raise the API-Football plan or lower the sync range.',
    resetAt: RESET_AT,
  };
  const line = describeRun('fixtures', quota);
  assert.match(line, /^\[fixtures\] DATA SOURCE UNAVAILABLE \(QUOTA_EXCEEDED: daily request quota exhausted\)/);
  assert.match(line, /API-Football daily quota reached/, "the provider's own words are kept");
  assert.match(line, /FIX: Raise the API-Football plan/);
  assert.match(line, /retry after 2026-10-17T00:00:00\.000Z/);
  assert.equal(runExitCode(quota), 2, 'cron mail flags an unusable data source');

  const paused = describeRun('odds', {
    status: 'SKIPPED',
    reason: UNAVAILABLE_REASONS.QUOTA_RESERVED,
    message: 'REQUEST BUDGET RESERVED · 0 of 100 request(s) left today',
  });
  assert.match(paused, /^\[odds\] paused — REQUEST BUDGET RESERVED/);
  assert.equal(runExitCode({ status: 'SKIPPED' }), 0, 'a deliberate pause is not an alert');

  assert.equal(describeRun('fixtures', { status: 'SUCCESS', rowsWritten: 3 }), null, 'a healthy run prints nothing');
});

/* ------------------------------------------------------------------ */
/* 3. /api/health carries the reason, never an invented quota          */
/* ------------------------------------------------------------------ */

test('health: /api/health names the reason and the reset time when the source is unusable', async () => {
  const ctx = fakeDb.install({ fixtures: [] });
  const previous = { quota: { ...apiFootball._quota }, key: apiFootball.key };
  try {
    // a configured client whose plan's day is spent (the production case)
    apiFootball.key = 'test-key';
    const startedAt = new Date();
    apiFootball._markQuotaExhausted('test: daily budget spent');

    let resolveBody;
    const answered = new Promise((resolve) => {
      resolveBody = resolve;
    });
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolveBody();
        return this;
      },
    };
    healthController.health({}, res);
    await answered;

    assert.equal(res.statusCode, 200, 'the database is fine, so the endpoint still answers');
    assert.equal(res.body.data.dataSource.state, 'QUOTA_EXHAUSTED');
    assert.equal(res.body.data.dataSource.available, false);
    assert.equal(res.body.data.dataSource.reason, UNAVAILABLE_REASONS.QUOTA_EXCEEDED);
    assert.match(res.body.data.dataSource.hint, /quota|plan/i);
    assertDailyReset(res.body.data.dataSource.resetsAt, startedAt, 'the health endpoint reports the quota reset');
    assert.equal(res.body.data.status, 'degraded');
  } finally {
    apiFootball._quota = previous.quota;
    apiFootball.key = previous.key;
    ctx.restore();
  }
});

/* ------------------------------------------------------------------ */
/* 5. the history backfill stops re-requesting fresh days              */
/* ------------------------------------------------------------------ */

test('history: only stale days are requested again', async () => {
  const recent = new Date('2026-10-15T06:00:00Z');
  const old = new Date('2026-10-05T06:00:00Z');
  const ctx = fakeDb.install({
    fixtures: [
      { id: 1, kickoff_at: '2026-10-14 18:00:00', fetched_at: recent, is_playable: 0 },
      { id: 2, kickoff_at: '2026-10-13 18:00:00', fetched_at: recent, is_playable: 0 },
      { id: 3, kickoff_at: '2026-10-09 18:00:00', fetched_at: old, is_playable: 0 },
    ],
  });
  const requested = [];
  const api = {
    async getFixturesByDate(date) {
      requested.push(date);
      return { get: 'fixtures', errors: null, results: 0, paging: { current: 1, total: 1 }, response: [] };
    },
  };
  try {
    const res = await fixtureService.syncHistory({
      api,
      days: 7,
      now: new Date('2026-10-15T12:00:00Z'),
      nowReference: new Date('2026-10-15T12:00:00Z'),
      refreshMinutes: 360,
      leagueIds: null,
    });

    // 2026-10-09 .. 2026-10-15 → the two days already fetched today are skipped
    assert.equal(res.skippedFresh, 2);
    assert.equal(res.endpointCalls, 5);
    assert.deepEqual(requested, ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
    assert.ok(!requested.includes('2026-10-13') && !requested.includes('2026-10-14'));
  } finally {
    ctx.restore();
  }
});

test('history: refreshMinutes 0 keeps the old behaviour (every day, every run)', async () => {
  const ctx = fakeDb.install({
    fixtures: [{ id: 1, kickoff_at: '2026-10-13 18:00:00', fetched_at: new Date(), is_playable: 0 }],
  });
  const requested = [];
  const api = {
    async getFixturesByDate(date) {
      requested.push(date);
      return { response: [] };
    },
  };
  try {
    const res = await fixtureService.syncHistory({
      api,
      days: 3,
      now: new Date('2026-10-15T12:00:00Z'),
      refreshMinutes: 0,
      leagueIds: null,
    });
    assert.equal(res.skippedFresh, 0);
    assert.equal(requested.length, 3);
  } finally {
    ctx.restore();
  }
});

/* ------------------------------------------------------------------ */
/* 6. head-to-head enrichment is bounded and only when it is needed     */
/* ------------------------------------------------------------------ */

function h2hScenario() {
  return fakeDb.install({
    settings: [],
    leagues: [],
    teamForms: [],
    fixtures: [
      {
        id: 901, kickoff_at: '2026-10-16 18:00:00', is_playable: 1, is_finished: 0, status_short: 'NS',
        league_id: 39, home_team_id: 100, away_team_id: 101, goals_home: null, goals_away: null,
      },
      {
        id: 902, kickoff_at: '2026-10-16 20:00:00', is_playable: 1, is_finished: 0, status_short: 'NS',
        league_id: 39, home_team_id: 200, away_team_id: 201, goals_home: null, goals_away: null,
      },
    ],
  });
}

test('h2h: a fixture whose stored sample is already large enough costs no request', async () => {
  const ctx = h2hScenario();
  const original = statsService.getH2H;
  const pairs = [];
  try {
    statsService.getH2H = async (fixture) => ({ available: Number(fixture.homeTeamId) === 100, sample: 5 });
    const api = {
      configured: true,
      isAvailable: () => true,
      async getHeadToHead(home, away) {
        pairs.push(`${home}-${away}`);
        return { response: [] };
      },
    };

    const res = await syncService.refreshModelInputs(new Date('2026-10-16T10:00:00Z'), {
      api,
      settings: { ...BASE, enableH2hApi: true, h2hMinMeetings: 3, h2hSyncMaxCalls: 20 },
    });

    assert.deepEqual(pairs, ['200-201'], 'only the fixture without a local sample was enriched');
    assert.equal(res.h2hCalls, 1);
    assert.equal(res.h2hSkippedSufficient, 1);
  } finally {
    statsService.getH2H = original;
    ctx.restore();
  }
});

test('h2h: the per-run ceiling is respected', async () => {
  const ctx = h2hScenario();
  const original = statsService.getH2H;
  let calls = 0;
  try {
    statsService.getH2H = async () => ({ available: false, sample: 0 });
    const api = {
      configured: true,
      isAvailable: () => true,
      async getHeadToHead() {
        calls += 1;
        return { response: [] };
      },
    };

    const res = await syncService.refreshModelInputs(new Date('2026-10-16T10:00:00Z'), {
      api,
      settings: { ...BASE, enableH2hApi: true, h2hMinMeetings: 3, h2hSyncMaxCalls: 1 },
    });

    assert.equal(calls, 1, 'h2h_sync_max_calls bounds the requests per sync');
    assert.equal(res.h2hCalls, 1);
  } finally {
    statsService.getH2H = original;
    ctx.restore();
  }
});
