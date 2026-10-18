'use strict';

/**
 * Odds-sync metrics that land on the stored generation report.
 *
 * Fixture-level counts stay separate from offer-level rejection maps.
 * Nothing here weakens Over 1.5 / line 1.50 validation, the 90-minute
 * freshness rule, or the 2.00-4.00 combined-odds window.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'odds-sync-report-test-only-secret-0123456789';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const fakeDb = require('./fakeDb');
const { buildScenario, FakeApi } = require('./synthetic');
const odds = require('../server/services/oddsService');
const ticketService = require('../server/services/ticketService');
const settings = require('../server/services/settingsService');
const { ApiFootballUnavailable } = require('../server/services/apiFootball');

const BASE = settings.toEngineSettings(settings.defaults());
let ctx;

beforeEach(() => {
  ctx = fakeDb.install({ settings: [] });
  settings.invalidateCache();
});
afterEach(() => {
  ctx.restore();
  settings.invalidateCache();
});

function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  assert.doesNotThrow(() => JSON.parse(text));
  assert.equal(/x-apisports-key|api-key|authorization|bearer |SUPERSECRET/i.test(text), false);
}

test('summarizeOddsSync: requested fields are copied and credentials never are', () => {
  const summary = odds.summarizeOddsSync({
    date: '2026-10-18',
    endpointCalls: 3,
    rowsWritten: 12,
    fixturesScanned: 37,
    fixturesWithAnyOffers: 8,
    fixturesWithRejectedOffers: 6,
    fixturesWithVerifiedOver15: 2,
    unmatchedProviderItems: 90,
    providerItemsSeen: 98,
    pagesFetched: 3,
    pagingTotal: 40,
    stoppedReason: 'max_pages',
    rejectionCounts: { ODDS_STALE: 4, MARKET_NOT_OVER_1_5: 80 },
    over15OfferRejectionCounts: { ODDS_STALE: 4 },
    providerErrors: [{
      page: 3,
      status: 400,
      reason: 'REQUEST_REJECTED',
      message: 'page rejected',
      headers: { 'x-apisports-key': 'SUPERSECRET', authorization: 'Bearer SUPERSECRET' },
      errors: { payload: { key: 'SUPERSECRET' } },
    }],
  });

  assert.equal(summary.endpointCalls, 3);
  assert.equal(summary.rowsWritten, 12);
  assert.equal(summary.fixturesScanned, 37);
  assert.equal(summary.fixturesWithAnyOffers, 8);
  assert.equal(summary.fixturesWithRejectedOffers, 6);
  assert.equal(summary.fixturesWithVerifiedOver15, 2);
  assert.equal(summary.offerRejectionCounts.ODDS_STALE, 4);
  assert.equal(summary.offerRejectionCounts.MARKET_NOT_OVER_1_5, 80);
  assert.equal(summary.over15OfferRejectionCounts.ODDS_STALE, 4);
  assert.equal(summary.providerErrors.length, 1);
  assert.equal(summary.providerErrors[0].page, 3);
  assert.equal(summary.providerErrors[0].status, 400);
  assert.equal(summary.providerErrors[0].headers, undefined);
  assert.equal(summary.stoppedReason, 'max_pages');
  assertNoSecrets(summary);
  assert.equal(odds.summarizeOddsSync(null), null);
});

test('summarizeOddsSync: fixture-level counts are not mixed into offer-level maps', () => {
  const summary = odds.summarizeOddsSync({
    fixturesScanned: 2,
    fixturesWithAnyOffers: 2,
    fixturesWithRejectedOffers: 2,
    fixturesWithVerifiedOver15: 1,
    offerRejectionCounts: { ODDS_STALE: 5, MARKET_NOT_OVER_1_5: 40 },
    over15OfferRejectionCounts: { ODDS_STALE: 5 },
  });
  assert.equal(typeof summary.fixturesWithRejectedOffers, 'number');
  assert.equal(typeof summary.offerRejectionCounts, 'object');
  assert.notEqual(summary.fixturesWithRejectedOffers, summary.offerRejectionCounts.ODDS_STALE);
  assert.ok(summary.offerRejectionCounts.MARKET_NOT_OVER_1_5 > summary.fixturesWithAnyOffers);
  assert.ok(summary.over15OfferRejectionCounts.ODDS_STALE > summary.fixturesWithVerifiedOver15);
});

test('sanitizeProviderPageError drops headers and raw provider payloads', () => {
  const err = new ApiFootballUnavailable('request rejected', {
    status: 400,
    reason: 'REQUEST_REJECTED',
    headers: { 'x-apisports-key': 'SUPERSECRET' },
    errors: { bet: 'full payload' },
    hint: 'not copied as a header, but also not required',
  });
  const sanitized = odds.sanitizeProviderPageError(err, 2);
  assert.deepEqual(Object.keys(sanitized).sort(), ['message', 'page', 'reason', 'status']);
  assert.equal(sanitized.page, 2);
  assert.equal(sanitized.status, 400);
  assert.equal(sanitized.reason, 'REQUEST_REJECTED');
  assertNoSecrets(sanitized);
});

test('syncOddsForDate: a matched playable fixture records fixture-level and offer-level counts separately', async () => {
  const scn = buildScenario();
  const api = new FakeApi(scn);
  const result = await odds.syncOddsForDate(scn.ticketDate, {
    api,
    settings: BASE,
    fixtures: scn.fixtures,
    now: new Date(),
  });

  assert.equal(result.endpointCalls, 1);
  assert.equal(result.fixturesScanned, 3);
  assert.equal(result.fixturesWithAnyOffers, 3);
  assert.equal(result.fixturesWithVerifiedOver15, 3);
  assert.equal(result.fixturesWithRejectedOffers, 3);
  assert.equal(result.providerItemsSeen, 3);
  assert.equal(result.unmatchedProviderItems, 0);
  assert.equal(result.stoppedReason, 'complete');
  assert.ok(result.rowsWritten >= 3);
  assert.ok(result.offerRejectionCounts.MARKET_NOT_OVER_1_5 > 0, 'non Over 1.5 offers are counted at offer level');
  assert.ok(
    result.offerRejectionCounts.MARKET_NOT_OVER_1_5 > result.fixturesWithRejectedOffers,
    'offer-level rejections outnumber the fixtures they came from'
  );
  assert.deepEqual(result.over15OfferRejectionCounts, {});
  assert.equal(ctx.store.odds.filter((row) => Number(row.is_verified) === 1).length >= 3, true);
  assert.equal(
    ctx.store.odds.some((row) => Number(row.is_verified) === 1 && String(row.value_name).toLowerCase().includes('2.5')),
    false,
    'Over 2.5 is never stored as verified Over 1.5'
  );
});

test('syncOddsForDate: provider items for unknown fixture ids are unmatched, not verified', async () => {
  const scn = buildScenario();
  const tracked = [scn.fixtures[0]];
  const api = {
    async getOddsByDate() {
      return {
        response: [
          scn.oddsPayloads[0],
          { ...scn.oddsPayloads[1], fixture: { id: 999999 } },
        ],
        paging: { current: 1, total: 1 },
      };
    },
  };
  const result = await odds.syncOddsForDate(scn.ticketDate, {
    api,
    settings: BASE,
    fixtures: tracked,
    now: new Date(),
  });
  assert.equal(result.fixturesScanned, 1);
  assert.equal(result.providerItemsSeen, 2);
  assert.equal(result.unmatchedProviderItems, 1);
  assert.equal(result.fixturesWithAnyOffers, 1);
  assert.equal(result.fixturesWithVerifiedOver15, 1);
  assert.equal(ctx.store.odds.some((row) => Number(row.fixture_id) === 999999), false);
});

test('syncOddsForDate: stale Over 1.5 offers are rejected, never verified, and counted at offer level', async () => {
  const scn = buildScenario({ updateMinutesAgo: 240 });
  const api = new FakeApi(scn);
  const result = await odds.syncOddsForDate(scn.ticketDate, {
    api,
    settings: BASE,
    fixtures: scn.fixtures,
    now: new Date(),
  });
  assert.equal(result.fixturesWithVerifiedOver15, 0);
  assert.equal(result.fixturesWithRejectedOffers, 3);
  assert.ok(result.over15OfferRejectionCounts.ODDS_STALE >= 3);
  assert.ok(result.offerRejectionCounts.ODDS_STALE >= result.over15OfferRejectionCounts.ODDS_STALE);
  assert.equal(ctx.store.odds.filter((row) => Number(row.is_verified) === 1).length, 0);
  const load = await odds.loadVerifiedPricesFromDb(scn.fixtures, { settings: BASE, now: new Date() });
  assert.equal(load.fixturesWithVerifiedOver15, 0);
  assert.equal(load.verifiedRowsRead, 0);
  assert.equal(load.fixturesQueried, 3);
});

test('syncOddsForDate: a later-page 4xx is recorded as a provider error without headers', async () => {
  const scn = buildScenario();
  let calls = 0;
  const api = {
    async getOddsByDate(_date, page) {
      calls += 1;
      if (page > 1) {
        throw new ApiFootballUnavailable('page rejected', {
          status: 400,
          reason: 'REQUEST_REJECTED',
          headers: { 'x-apisports-key': 'SUPERSECRET' },
          errors: { page: 'does not exist' },
        });
      }
      return { response: scn.oddsPayloads, paging: { current: 1, total: 3 } };
    },
  };
  const result = await odds.syncOddsForDate(scn.ticketDate, {
    api,
    settings: { ...BASE, oddsSyncMaxPages: 12 },
    fixtures: scn.fixtures,
    maxPages: 12,
    now: new Date(),
  });
  assert.equal(calls, 2);
  assert.equal(result.stoppedReason, 'provider_page_error');
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.providerErrors.length, 1);
  assert.equal(result.providerErrors[0].page, 2);
  assert.equal(result.providerErrors[0].status, 400);
  assert.equal(result.providerErrors[0].headers, undefined);
  assertNoSecrets(result);
});

test('syncOddsForDate: hitting the page cap records max_pages and the provider paging total', async () => {
  const scn = buildScenario();
  const api = {
    async getOddsByDate(_date, page) {
      return { response: [scn.oddsPayloads[0]], paging: { current: page, total: 10 } };
    },
  };
  const result = await odds.syncOddsForDate(scn.ticketDate, {
    api,
    settings: BASE,
    fixtures: scn.fixtures,
    maxPages: 2,
    now: new Date(),
  });
  assert.equal(result.endpointCalls, 2);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.pagingTotal, 10);
  assert.equal(result.stoppedReason, 'max_pages');
  assert.equal(result.providerItemsSeen, 2);
});

test('buildReport: oddsSync and oddsLoad are persisted in the public report shape', () => {
  const bulkSync = {
    date: '2026-10-18',
    endpointCalls: 4,
    rowsWritten: 0,
    fixturesScanned: 37,
    fixturesWithAnyOffers: 0,
    fixturesWithRejectedOffers: 0,
    fixturesWithVerifiedOver15: 0,
    unmatchedProviderItems: 120,
    providerItemsSeen: 120,
    pagesFetched: 12,
    pagingTotal: 80,
    stoppedReason: 'max_pages',
    offerRejectionCounts: {},
    over15OfferRejectionCounts: {},
    providerErrors: [],
  };
  const report = ticketService.buildReport({
    ticketDate: '2026-10-18',
    counters: {
      fixturesScanned: 1668,
      playableFixtures: 37,
      over15Candidates: 0,
      verifiedOdds: 0,
      rejectedMatches: 37,
      rejectedNoOdds: 37,
      rejectedFixtureState: 0,
      rejectedInsufficientData: 0,
      rejectedStaleOdds: 0,
      rejectedLowQuality: 0,
      confidenceQualified: 0,
      rejectedLowConfidence: 0,
      riskQualified: 0,
      rejectedHighRisk: 0,
      finalCandidates: 0,
      correlationRejected: 0,
      combinationsTested: 0,
      qualifiedCombinations: 0,
    },
    result: { status: 'NO_QUALIFYING_TICKET', report: { reason: 'INSUFFICIENT_CANDIDATES' } },
    settings: BASE,
    reverify: null,
    bulkSync,
    oddsLoad: { fixturesQueried: 37, verifiedRowsRead: 0, selected: new Map(), rejectionCounts: {} },
    ticketId: 9,
  });

  assert.equal(report.reason, 'INSUFFICIENT_CANDIDATES');
  assert.equal(report.oddsSync.endpointCalls, 4);
  assert.equal(report.oddsSync.rowsWritten, 0);
  assert.equal(report.oddsSync.fixturesScanned, 37);
  assert.equal(report.oddsSync.fixturesWithAnyOffers, 0);
  assert.equal(report.oddsSync.fixturesWithRejectedOffers, 0);
  assert.equal(report.oddsSync.fixturesWithVerifiedOver15, 0);
  assert.equal(report.oddsSync.unmatchedProviderItems, 120);
  assert.equal(report.oddsSync.stoppedReason, 'max_pages');
  assert.equal(report.oddsLoad.fixturesQueried, 37);
  assert.equal(report.oddsLoad.verifiedRowsRead, 0);
  assert.equal(report.oddsLoad.fixturesWithVerifiedOver15, 0);
  assert.equal(report.oddsWindow.min, 2);
  assert.equal(report.oddsWindow.max, 4);
  assert.equal(report.thresholds.minConfidence, Number(BASE.minConfidence));
  assertNoSecrets(report);
});

test('product rules: exact Over 1.5, 90-minute freshness and 2.00-4.00 window stay in force', () => {
  assert.equal(odds.GOAL_LINE, 1.5);
  assert.equal(odds.MARKET_KEY, 'over_1_5');
  assert.equal(BASE.oddsFreshnessMinutes, 90);
  assert.equal(Number(BASE.minTotalOdds), 2);
  assert.equal(Number(BASE.maxTotalOdds), 4);
  assert.equal(BASE.autoTicketGeneration, false);
  assert.equal(BASE.marketKey, 'over_1_5');
});
