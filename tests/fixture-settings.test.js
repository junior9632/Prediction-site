'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'fixtures-settings-test-only-secret-0123456789';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fakeDb = require('./fakeDb');
const { buildScenario, FakeApi } = require('./synthetic');
const fixtures = require('../server/services/fixtureService');
const settings = require('../server/services/settingsService');
const sync = require('../server/services/syncService');
const results = require('../server/services/resultService');
const odds = require('../server/services/oddsService');
const { validate } = require('../server/utils/validate');
const time = require('../server/utils/time');
const auth = require('../server/middleware/auth');
const { apiFootball, ApiFootballUnavailable } = require('../server/services/apiFootball');
const { createApp } = require('../server/app');

const NOW = new Date('2026-10-16T15:30:00Z');
const BASE = { ...settings.toEngineSettings(settings.defaults()), enableH2hApi: false, apiQuotaReserve: 0 };
let ctx;
beforeEach(() => { ctx = fakeDb.install({ settings: [] }); settings.invalidateCache(); });
afterEach(() => { ctx.restore(); settings.invalidateCache(); });

function fixtureItem({ id = 123, date = '2026-10-16T18:00:00Z', status = 'NS', goals = {}, fulltime = {} } = {}) {
  return {
    fixture: { id, date, timestamp: Math.floor(new Date(date).getTime() / 1000), status: { short: status }, timezone: 'UTC' },
    league: { id: 39, name: 'Test League', country: 'Testland' },
    teams: { home: { id: 1, name: 'Home Test FC' }, away: { id: 2, name: 'Away Test FC' } },
    goals,
    score: { fulltime },
  };
}

const fixtureApi = (response) => ({
  configured: true, isAvailable: () => true,
  getFixturesByDate: async () => ({ response }),
  getHeadToHead: async () => ({ response: [] }),
});

test('fixture timestamps use UNIX seconds and fall back from a missing/invalid ISO date', () => {
  const item = fixtureItem();
  const expected = new Date(item.fixture.date).toISOString();
  for (const date of [item.fixture.date, undefined, 'bad-date']) {
    const normalized = fixtures.normalizeFixture({ ...item, fixture: { ...item.fixture, date } }, NOW);
    assert.equal(normalized.kickoffAt.toISOString(), expected);
    assert.equal(normalized.apiTimestamp.toISOString(), expected);
  }
  assert.equal(fixtures.normalizeFixture({ ...item, fixture: { ...item.fixture, id: 'bad' } }, NOW), null);
  assert.equal(fixtures.normalizeFixture({ fixture: { id: 1 } }, NOW), null);
});

test('AET/PEN settle only on the 90-minute score; total goals must not leak extra-time goals', () => {
  for (const status of ['FT', 'AET', 'PEN']) {
    const normalized = fixtures.normalizeFixture(fixtureItem({ status, goals: { home: 2, away: 1 }, fulltime: { home: 0, away: 0 } }), NOW);
    assert.equal(normalized.goalsHome, 0);
    assert.equal(normalized.goalsAway, 0);
    assert.equal(results.evaluateOver15({ statusShort: status, goalsHome: normalized.goalsHome, goalsAway: normalized.goalsAway }), 'LOST');
  }
  for (const status of ['AET', 'PEN']) {
    const normalized = fixtures.normalizeFixture(fixtureItem({ status, goals: { home: 2, away: 1 } }), NOW);
    assert.equal(normalized.goalsHome, null);
    assert.equal(normalized.goalsAway, null);
  }
  const fulltime = fixtures.normalizeFixture(fixtureItem({ status: 'FT', goals: { home: 1, away: 2 } }), NOW);
  assert.deepEqual([fulltime.goalsHome, fulltime.goalsAway], [1, 2]);
});

test('fixture sync stamps real fetch time and does not mark already-started NS fixtures playable', async () => {
  const response = [fixtureItem({ id: 1, date: '2026-10-16T12:00:00Z' }), fixtureItem({ id: 2 }), { fixture: { id: 'bad' } }];
  const result = await sync.syncFixtures({ api: fixtureApi(response), settings: { ...BASE, syncDaysAhead: 0 }, includeHistory: false, now: NOW });
  assert.equal(result.upcoming, 2);
  assert.equal(result.endpointCalls, 1);
  assert.equal(ctx.store.fixtures.length, 2);
  assert.equal(ctx.store.fixtures.find((row) => row.id === 1).is_playable, 0);
  assert.equal(ctx.store.fixtures.find((row) => row.id === 2).is_playable, 1);
  for (const row of ctx.store.fixtures) assert.equal(row.fetched_at, '2026-10-16 15:30:00');
});

test('sync_timezone selects the calendar date without moving fetched_at into the future', async () => {
  const now = new Date('2026-10-16T23:30:00Z');
  const requested = [];
  const api = fixtureApi([fixtureItem({ date: '2026-10-17T10:00:00Z' })]);
  api.getFixturesByDate = async (date) => { requested.push(date); return { response: [fixtureItem({ date: `${date}T10:00:00Z` })] }; };
  await sync.syncFixtures({ api, now, includeHistory: false, settings: { ...BASE, syncDaysAhead: 0, syncTimezone: 'Africa/Lagos' } });
  assert.deepEqual(requested, ['2026-10-17']);
  assert.equal(ctx.store.fixtures[0].fetched_at, '2026-10-16 23:30:00');
});

test('history refresh uses the real clock, not midnight, and skips recently fetched days', async () => {
  const today = time.toMysqlDate(NOW);
  for (let i = 1; i <= 7; i += 1) ctx.store.fixtures.push({ id: i, kickoff_at: `${time.toMysqlDate(time.addDays(NOW, -i))} 18:00:00`, fetched_at: '2026-10-16 14:00:00' });
  const requested = [];
  const api = fixtureApi([]);
  api.getFixturesByDate = async (date) => { requested.push(date); return { response: [] }; };
  const result = await sync.syncFixtures({ api, now: NOW, settings: { ...BASE, syncDaysAhead: 0, syncHistoryDays: 7, historyRefreshMinutes: 360 } });
  assert.deepEqual(requested, [today]);
  assert.equal(result.historySkippedFresh, 7);
});

test('selected-date fixture sync refreshes only that date, not the history/upcoming windows', async () => {
  const requested = [];
  const api = fixtureApi([]);
  api.getFixturesByDate = async (date) => { requested.push(date); return { response: [] }; };
  const result = await sync.syncFixtures({ api, now: NOW, date: '2026-10-12', settings: { ...BASE, syncDaysAhead: 5, syncHistoryDays: 30 } });
  assert.deepEqual(requested, ['2026-10-12']);
  assert.equal(result.syncedFromDate, '2026-10-12');
  assert.equal(result.history, 0);
  assert.equal(ctx.store.tickets.length, 0);
  assert.equal(ctx.store.generationLogs.length, 0);
});

async function seedH2hCandidates() {
  for (const id of [1, 2, 3]) await fixtures.persistFixture(fixtures.normalizeFixture(fixtureItem({ id }), NOW), NOW);
}

test('H2H cap=0 and an explicit h2hLimit=0 perform no requests', async () => {
  await seedH2hCandidates();
  let calls = 0;
  const api = fixtureApi([]);
  api.getHeadToHead = async () => { calls += 1; return { response: [] }; };
  for (const options of [{ settings: { ...BASE, enableH2hApi: true, h2hSyncMaxCalls: 0 } }, { settings: { ...BASE, enableH2hApi: true }, h2hLimit: 0 }]) {
    const result = await sync.refreshModelInputs(NOW, { ...options, api, now: NOW });
    assert.equal(result.h2hCalls, 0);
  }
  assert.equal(calls, 0);
});

test('failed H2H requests count toward the cap and requested sample honours h2h_min_meetings', async () => {
  await seedH2hCandidates();
  const samples = [];
  const api = fixtureApi([]);
  api.getHeadToHead = async (_home, _away, last) => { samples.push(last); throw new Error('temporary failure'); };
  const result = await sync.refreshModelInputs(NOW, { api, now: NOW, settings: { ...BASE, enableH2hApi: true, h2hSyncMaxCalls: 1, h2hMinMeetings: 10 } });
  assert.equal(result.h2hCalls, 1);
  assert.deepEqual(samples, [10]);
});

test('result sync separates its date window from the real observation time', async () => {
  const original = results.syncResults;
  let received;
  results.syncResults = async (options) => { received = options; return { resultsRecorded: 0, selectionsSettled: 0, endpointCalls: 0 }; };
  try {
    const now = new Date('2026-10-16T23:30:00Z');
    await sync.syncResults({ api: fixtureApi([]), now, settings: { ...BASE, syncTimezone: 'Africa/Lagos' } });
    assert.equal(received.now.toISOString(), now.toISOString());
    assert.equal(time.toMysqlDate(received.to), '2026-10-17');
    assert.equal(time.toMysqlDate(received.from), '2026-10-10');
  } finally { results.syncResults = original; }
});

test('fixture dates and identifiers reject rollover dates and truncated/fractional IDs', () => {
  for (const bad of ['2026-02-30', '2026-02-29', '2026-10-16extra', ['2026-10-16']]) assert.equal(validate({ date: { type: 'date' } }, { date: bad }).ok, false, String(bad));
  assert.equal(validate({ date: { type: 'date' } }, { date: '2028-02-29' }).ok, true);
  for (const bad of ['123junk', '1.5', true, [], 9007199254740992]) assert.equal(validate({ id: { type: 'int' } }, { id: bad }).ok, false, String(bad));
});

test('HTTP: fixtures honour current settings, stale/start-time gates and protected scripts', async () => {
  const admin = { id: 1, role: 'superadmin', username: 'test', is_active: 1, must_change_password: 0 };
  ctx.store.admins.push(admin);
  const scn = buildScenario();
  ctx.store.fixtures.push(...scn.fixtures);
  const seedApi = new FakeApi(scn);
  await odds.syncOddsForDate(scn.ticketDate, { api: seedApi, settings: BASE });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = auth.signToken({ sub: admin.id, type: 'admin', role: admin.role });
  const request = (path, options = {}) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...options });
  try {
    await settings.updateSettings({ odds_selection_strategy: 'preferred_bookmaker', odds_bookmaker_preference: 'Pinnacle', min_single_odds: '1.01' });
    const list = await (await request(`/api/fixtures?date=${scn.ticketDate}`)).json();
    assert.equal(list.data.items[0].over15.bookmaker, 'Pinnacle');
    const detail = await (await request('/api/fixtures/1001')).json();
    assert.equal(detail.data.fixture.over15.bookmaker, 'Pinnacle');
    assert.ok(detail.data.over15Odds.length > 0);
    await settings.updateSettings({ min_single_odds: '1.50' });
    const limited = await (await request('/api/fixtures/1001')).json();
    assert.equal(limited.data.fixture.over15.available, false);
    assert.deepEqual(limited.data.over15Odds, []);
    await settings.updateSettings({ min_single_odds: '1.01' });
    ctx.store.odds.forEach((price) => { price.odds_updated_at = time.toMysqlDateTime(time.addMinutes(new Date(), -180)); });
    const stale = await (await request('/api/fixtures/1001')).json();
    assert.equal(stale.data.fixture.over15.available, false);
    assert.deepEqual(stale.data.over15Odds, []);

    const past = { ...scn.fixtures[0], id: 9, kickoff_at: time.toMysqlDateTime(time.addMinutes(new Date(), -10)), is_playable: 1, status_short: 'NS' };
    ctx.store.fixtures.push(past);
    const day = past.kickoff_at.slice(0, 10);
    const adminRows = await (await request(`/api/admin/fixtures?date=${day}`)).json();
    assert.equal(adminRows.data.items.find((item) => item.id === 9).playable, false);
    const playable = await (await request(`/api/fixtures?date=${day}&playable=1`)).json();
    assert.ok(!playable.data.items.some((item) => item.id === 9));

    for (const script of ['admin-settings.js', 'admin-fixtures.js']) {
      assert.equal((await fetch(`${base}/js/${script}`)).status, 404);
      const response = await request(`/js/${script}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
    assert.equal((await request('/api/admin/fixtures?date=2026-02-30')).status, 400);
    assert.equal((await request('/api/fixtures/1001oops')).status, 400);

    // The selected-date action uses the existing authenticated, CSRF-guarded
    // sync endpoint, forwards the date, and cannot trigger ticket generation.
    const originalSync = sync.syncFixtures;
    const originalKey = apiFootball.key;
    const originalManagement = apiFootball.manageCredential;
    apiFootball.manageCredential = false;
    let forwarded;
    sync.syncFixtures = async (options) => { forwarded = options; return { upcoming: 0 }; };
    apiFootball.key = 'test-only-key';
    try {
      assert.equal((await request('/api/admin/sync', { method: 'POST', body: JSON.stringify({ job: 'fixtures', date: '2026-10-12' }) })).status, 200);
      assert.equal(forwarded.date, '2026-10-12');
      assert.equal((await request('/api/admin/sync', { method: 'POST', body: JSON.stringify({ job: 'all', date: '2026-10-12' }) })).status, 400);
      const cookie = `fp_token=${token}`;
      assert.equal((await fetch(`${base}/api/admin/sync`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"job":"fixtures"}' })).status, 403);
    } finally { sync.syncFixtures = originalSync; apiFootball.key = originalKey; apiFootball.manageCredential = originalManagement; }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});


function withBudget(api, remaining = 27) {
  api.quotaState = () => ({ known: true, remaining, limitDay: 100, current: 100 - remaining, resetsAt: '2026-10-17T00:00:00Z' });
  for (const key of ['getFixturesByDate', 'getHeadToHead', 'getOddsByDate', 'getFixturesByIds']) {
    if (!api[key]) continue;
    const request = api[key];
    api[key] = async (...args) => { remaining -= 1; return request(...args); };
  }
  return api;
}

test('the quota reserve is rechecked between fixture dates, preserving partial progress', async () => {
  const requested = [];
  const api = withBudget({ ...fixtureApi([]), getFixturesByDate: async (date) => { requested.push(date); return { response: [fixtureItem({ id: requested.length, date: `${date}T18:00:00Z` })] }; } });
  const result = await sync.syncFixtures({ api, now: NOW, includeHistory: false, settings: { ...BASE, apiQuotaReserve: 25, syncDaysAhead: 4 } });
  assert.equal(requested.length, 2);
  assert.equal(result.endpointCalls, 2);
  assert.equal(result.upcoming, 2);
  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.reason, 'QUOTA_RESERVED');
  assert.equal(result.quota.remaining, 25);
  assert.equal(ctx.store.apiSyncLogs[0].status, 'SKIPPED');
  assert.equal(Number(ctx.store.apiSyncLogs[0].endpoint_calls), 2);
});

test('H2H enrichment cannot spend the remaining reserve after the fixture date is synced', async () => {
  let calls = 0;
  const api = withBudget({ ...fixtureApi([1, 2, 3].map((id) => fixtureItem({ id }))), getHeadToHead: async () => { calls += 1; return { response: [] }; } });
  const result = await sync.syncFixtures({ api, now: NOW, includeHistory: false, settings: { ...BASE, apiQuotaReserve: 25, syncDaysAhead: 0, enableH2hApi: true } });
  assert.equal(calls, 1);
  assert.equal(result.endpointCalls, 2, 'date request and H2H request are both counted');
  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.quota.remaining, 25);
});

test('odds pagination cannot consume the reserve midway through a date', async () => {
  let calls = 0;
  const scn = buildScenario();
  const api = withBudget({ ...fixtureApi([]), getOddsByDate: async (_date, page) => { calls += 1; return { response: scn.oddsPayloads, paging: { current: page, total: 10 } }; } });
  const result = await sync.syncOdds({ api, now: NOW, settings: { ...BASE, apiQuotaReserve: 25, syncDaysAhead: 2, oddsSyncMaxPages: 10 } });
  assert.equal(calls, 2);
  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.endpointCalls, 2);
  assert.equal(result.quota.remaining, 25);
});

test('result refresh checks the reserve between fixture-ID batches and reports actual calls', async () => {
  const ids = Array.from({ length: 31 }, (_, i) => i + 1);
  for (const id of ids) await fixtures.persistFixture(fixtures.normalizeFixture(fixtureItem({ id, date: '2026-10-16T10:00:00Z' }), NOW), NOW);
  let calls = 0;
  const api = withBudget({ ...fixtureApi([]), getFixturesByIds: async (batch) => {
    calls += 1;
    return { response: batch.map((id) => fixtureItem({ id, date: '2026-10-16T10:00:00Z', status: 'FT', fulltime: { home: 1, away: 1 } })) };
  } });
  const result = await sync.syncResults({ api, now: NOW, settings: { ...BASE, apiQuotaReserve: 25 } });
  assert.equal(calls, 2);
  assert.equal(result.endpointCalls, 2);
  assert.equal(result.resultsRecorded, 30);
  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.quota.remaining, 25);
  assert.equal(ctx.store.fixtures.find((f) => f.id === 31).is_finished, 0);
});

test('quota/auth/network errors on a later odds page are not mistaken for end-of-pagination', async () => {
  const scn = buildScenario();
  for (const details of [{ status: 429, reason: 'QUOTA_EXCEEDED' }, { status: 401, reason: 'AUTH_REJECTED' }, { reason: 'NETWORK_ERROR' }]) {
    let calls = 0;
    const api = { getOddsByDate: async () => {
      calls += 1;
      if (calls > 1) throw new ApiFootballUnavailable('provider failure', details);
      return { response: scn.oddsPayloads, paging: { current: 1, total: 3 } };
    } };
    await assert.rejects(() => odds.syncOddsForDate(scn.ticketDate, { api, settings: BASE }), (error) => error instanceof ApiFootballUnavailable && error.details.reason === details.reason);
  }
});
