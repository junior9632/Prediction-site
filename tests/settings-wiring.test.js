'use strict';

/**
 * SETTINGS WIRING — every admin-editable setting must actually reach the code
 * that claims to honour it. A setting that the Settings screen accepts and
 * nothing reads is worse than no setting at all: it silently lies to the
 * operator.
 *
 * Covered here:
 *   * combination_weights / combination_leg_penalty -> the combination builder
 *   * results_settle_mode -> the settlement guard (locked, enforced)
 *   * sync_timezone -> the calendar day the sync jobs pull (UTC storage kept)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const decimal = require('../server/utils/decimal');
const time = require('../server/utils/time');
const ticketBuilder = require('../server/prediction/ticketBuilder');
const pipeline = require('../server/prediction/pipeline');
const resultService = require('../server/services/resultService');
const settingsService = require('../server/services/settingsService');
const syncService = require('../server/services/syncService');
const oddsService = require('../server/services/oddsService');
const contextService = require('../server/services/contextService');
const fakeDb = require('./fakeDb');
const { buildScenario, FakeApi } = require('./synthetic');

const NOW = new Date();
const BASE = settingsService.toEngineSettings(settingsService.defaults());

/* ------------------------------------------------------------------ */
/* combination scoring                                                 */
/* ------------------------------------------------------------------ */

/** Run the pipeline with `buildTicket` spied on, so we can see what it got. */
async function captureBuilderSettings(settings) {
  const original = ticketBuilder.buildTicket;
  let received = null;
  ticketBuilder.buildTicket = (candidates, rawSettings) => {
    received = rawSettings;
    return original(candidates, rawSettings);
  };
  try {
    const scn = buildScenario({ oddsValues: ['1.28', '1.30', '1.32'], updateMinutesAgo: 5 });
    const fixtures = scn.fixtures;
    const oddsByFixture = new Map();
    fixtures.forEach((row, index) => {
      const validation = oddsService.validateOddsPayload(
        scn.oddsPayloads[index],
        {
          id: row.id,
          homeTeamId: row.home_team_id,
          awayTeamId: row.away_team_id,
          kickoffAt: row.kickoff_at,
          statusShort: row.status_short,
        },
        { settings, now: NOW }
      );
      const price = oddsService.selectPrice(validation.verified, settings);
      if (price) oddsByFixture.set(Number(row.id), price);
    });

    await pipeline.runPipeline({
      fixtures,
      oddsByFixture,
      settings,
      now: NOW,
      loadContext: async (fixture) => {
        const row = fixtures.find((r) => Number(r.id) === Number(fixture.id));
        const formRow = (teamId, scope) =>
          scn.teamForms.find((r) => r.team_id === teamId && r.scope === scope && r.window_matches === 10) || null;
        const shape = (teamId, venueScope) => ({
          all: contextService.teamFormFromRow(formRow(teamId, 'all')),
          venue: contextService.teamFormFromRow(formRow(teamId, venueScope)),
          last5: contextService.teamFormFromRow(formRow(teamId, 'all', 5)),
        });
        return {
          form: { home: shape(row.home_team_id, 'home'), away: shape(row.away_team_id, 'away'), before: row.kickoff_at },
          leagueEnv: contextService.leagueEnvFromRow(scn.leagueEnvs.find((l) => l.id === row.league_id)),
          h2h: { available: false, sample: 0 },
          injuries: { available: false, home: null, away: null },
        };
      },
    });
  } finally {
    ticketBuilder.buildTicket = original;
  }
  return received;
}

test('combination_weights: the admin weights reach the combination builder', async () => {
  const custom = { avgConfidence: 0.5, minConfidence: 0.1, avgQuality: 0.05, risk: 0.1, probability: 0.2, diversity: 0.05 };
  const received = await captureBuilderSettings({ ...BASE, combinationWeights: custom });
  assert.ok(received, 'the pipeline called the builder');
  assert.deepEqual(received.weights, custom, 'the builder scored with the configured weights');
});

test('combination_leg_penalty: the admin penalty reaches the combination builder', async () => {
  const received = await captureBuilderSettings({ ...BASE, legPenalty: 17 });
  assert.ok(received);
  assert.equal(received.legPenalty, 17, 'the builder penalised extra legs with the configured value');
});

test('combination_leg_penalty: the builder keeps its own default when nothing is configured', async () => {
  const received = await captureBuilderSettings({ ...BASE, legPenalty: undefined, combinationWeights: undefined });
  assert.ok(received);
  assert.ok(!('legPenalty' in received), 'an unset penalty is not forwarded');
  assert.ok(!('weights' in received), 'unset weights are not forwarded');
});

test('combination_leg_penalty: the penalty changes the combination score exactly', () => {
  const weights = { avgConfidence: 0.3, minConfidence: 0.15, avgQuality: 0.1, risk: 0.15, probability: 0.2, diversity: 0.05 };
  const combo = [
    { confidence: 90, qualityScore: 90, riskScore: 10, probability: 0.8, leagueId: 1, country: 'X', kickoffAt: '2026-10-08T12:00:00Z' },
    { confidence: 88, qualityScore: 88, riskScore: 12, probability: 0.79, leagueId: 2, country: 'Y', kickoffAt: '2026-10-08T14:00:00Z' },
    { confidence: 86, qualityScore: 86, riskScore: 14, probability: 0.78, leagueId: 3, country: 'Z', kickoffAt: '2026-10-08T16:00:00Z' },
  ];
  const total = decimal.scaledFromNumber(2.73);
  const base = { minSelections: 2, weights };
  const light = ticketBuilder.scoreCombination(combo, total, { ...base, legPenalty: 0 });
  const heavy = ticketBuilder.scoreCombination(combo, total, { ...base, legPenalty: 5 });

  // the penalty applies per leg above minSelections, so the delta is exact
  assert.equal(light.strength - heavy.strength, 5, 'legPenalty must move the score by penalty x extra legs');
  assert.ok(heavy.strength < light.strength);
});

/* ------------------------------------------------------------------ */
/* settlement mode                                                     */
/* ------------------------------------------------------------------ */

test('results_settle_mode: only the 90 minute (fulltime) mode is accepted', () => {
  assert.deepEqual(resultService.SUPPORTED_SETTLE_MODES, ['fulltime']);
  assert.equal(resultService.assertSettleMode({ resultsSettleMode: 'fulltime' }), 'fulltime');
  assert.equal(resultService.assertSettleMode({ resultsSettleMode: 'FULLTIME' }), 'fulltime');
  assert.equal(resultService.assertSettleMode({}), 'fulltime', 'an absent value means the documented default');
  assert.throws(
    () => resultService.assertSettleMode({ resultsSettleMode: 'halftime' }),
    (err) => err.code === 'SETTLE_MODE_UNSUPPORTED'
  );
});

test('results_settle_mode: settlement refuses a tampered mode before touching a row', async () => {
  // Even with a working database, an unsupported mode must stop the run: a
  // silent settlement against the wrong scoreline is the one thing this
  // platform must never do.
  const ctx = fakeDb.install({ settings: [] });
  try {
    await assert.rejects(
      () => resultService.settlePendingSelections({ settings: { resultsSettleMode: 'halftime' } }),
      (err) => err.code === 'SETTLE_MODE_UNSUPPORTED'
    );
    // the supported mode still runs normally
    const res = await resultService.settlePendingSelections({ settings: { resultsSettleMode: 'fulltime' } });
    assert.equal(res.pending, 0);
  } finally {
    ctx.restore();
  }
});

test('results_settle_mode: the sync result reports the mode it settled with', async () => {
  const ctx = fakeDb.install({ settings: [] });
  try {
    const res = await resultService.syncResults({ now: new Date(), settings: { resultsSettleMode: 'fulltime' } });
    assert.equal(res.settleMode, 'fulltime');
  } finally {
    ctx.restore();
  }
});

/* ------------------------------------------------------------------ */
/* sync timezone                                                       */
/* ------------------------------------------------------------------ */

test('time: the calendar day is derived in the requested timezone', () => {
  const lateUtc = '2026-10-08T23:30:00Z';
  assert.equal(time.dateInZone(lateUtc, 'UTC'), '2026-10-08');
  assert.equal(time.dateInZone(lateUtc, 'Africa/Lagos'), '2026-10-09');
  assert.equal(time.dateInZone(lateUtc, 'America/New_York'), '2026-10-08');
  // an unknown zone must never silently shift the window
  assert.equal(time.dateInZone(lateUtc, 'Bogus/Zone'), '2026-10-08');
  assert.equal(time.isValidTimeZone('Africa/Lagos'), true);
  assert.equal(time.isValidTimeZone('Bogus/Zone'), false);
  assert.equal(time.zoneDateAnchor(lateUtc, 'Africa/Lagos').toISOString(), '2026-10-09T00:00:00.000Z');
});

test('sync_timezone: the odds sync pulls the operator calendar day, storage stays UTC', async () => {
  const ctx = fakeDb.install({ settings: [], fixtures: [] });
  try {
    const scn = buildScenario({ oddsValues: ['1.30'], updateMinutesAgo: 5 });
    const api = new FakeApi(scn);

    // 23:30 UTC is already the next day in Lagos
    const lateEvening = new Date('2026-10-08T23:30:00Z');

    const utc = await syncService.syncOdds({
      api,
      now: lateEvening,
      settings: { ...BASE, syncTimezone: 'UTC', syncDaysAhead: 0, syncLeagues: [], oddsSyncMaxPages: 1 },
    });
    const lagos = await syncService.syncOdds({
      api,
      now: lateEvening,
      settings: { ...BASE, syncTimezone: 'Africa/Lagos', syncDaysAhead: 0, syncLeagues: [], oddsSyncMaxPages: 1 },
    });

    assert.equal(utc.syncTimezone, 'UTC');
    assert.equal(lagos.syncTimezone, 'Africa/Lagos');
    assert.equal(utc.syncTimezoneValid, true);
    assert.equal(lagos.syncTimezoneValid, true);

    assert.equal(utc.perDate[0].date, '2026-10-08', 'the UTC run keeps the historical window');
    assert.equal(lagos.perDate[0].date, '2026-10-09', 'the Lagos run pulls the operator calendar day');
  } finally {
    ctx.restore();
  }
});

test('sync_timezone: an unknown zone is reported and falls back to UTC', async () => {
  const ctx = fakeDb.install({ settings: [], fixtures: [] });
  try {
    const scn = buildScenario({ oddsValues: ['1.30'], updateMinutesAgo: 5 });
    const res = await syncService.syncOdds({
      api: new FakeApi(scn),
      now: new Date('2026-10-08T23:30:00Z'),
      settings: { ...BASE, syncTimezone: 'Nowhere/Nothing', syncDaysAhead: 0, syncLeagues: [], oddsSyncMaxPages: 1 },
    });
    assert.equal(res.syncTimezone, 'UTC', 'an unusable zone falls back to the documented default');
    assert.equal(res.syncTimezoneValid, false, 'and says so, instead of silently moving the window');
    assert.equal(res.perDate[0].date, '2026-10-08');
  } finally {
    ctx.restore();
  }
});

test('sync_timezone: the fixtures sync anchors on the same calendar day', async () => {
  const ctx = fakeDb.install({ settings: [], fixtures: [], leagues: [], teamForms: [] });
  try {
    const scn = buildScenario({ oddsValues: ['1.30'], updateMinutesAgo: 5 });
    const res = await syncService.syncFixtures({
      api: new FakeApi(scn),
      now: new Date('2026-10-08T23:30:00Z'),
      includeHistory: false,
      settings: { ...BASE, syncTimezone: 'Africa/Lagos', syncDaysAhead: 0, syncHistoryDays: 0, syncLeagues: [] },
    });
    assert.equal(res.syncTimezone, 'Africa/Lagos');
    assert.equal(res.syncedFromDate, '2026-10-09');
  } finally {
    ctx.restore();
  }
});

/* ------------------------------------------------------------------ */
/* no inert settings remain                                            */
/* ------------------------------------------------------------------ */

test('settings: every declared setting has a consumer outside settingsService', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const camel = (key) => key.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

  /**
   * Three settings are consumed under a name that is not the camelCase form of
   * the key. They are listed explicitly (instead of loosening the check) so a
   * NEW setting that nothing reads still fails this test.
   */
  const CONSUMED_AS = {
    odds_reverify_before_generation: 'reverifyOddsBeforeGeneration',
    confidence_weights: 'confidence',
    combination_leg_penalty: 'legPenalty',
  };

  const files = [];
  for (const dir of ['server', 'scripts']) {
    for (const entry of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      const full = path.join(root, dir, String(entry));
      if (full.endsWith('.js') && !full.includes('settingsService.js')) files.push(fs.readFileSync(full, 'utf8'));
    }
  }
  const haystack = files.join('\n');

  const inert = [];
  for (const key of Object.keys(settingsService.DEFINITIONS)) {
    const names = [camel(key)];
    if (CONSUMED_AS[key]) names.push(CONSUMED_AS[key]);
    if (!names.some((name) => new RegExp(`\\b${name}\\b`).test(haystack))) inert.push(`${key} (${names.join(' / ')})`);
  }
  assert.deepEqual(inert, [], `settings accepted by the admin screen but read by nothing: ${inert.join(', ')}`);
});
