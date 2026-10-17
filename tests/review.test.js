'use strict';

/**
 * PR REVIEW REGRESSIONS — each test pins a defect found during the full
 * review of the branch. They must keep failing if the defect is reintroduced.
 *
 *  R1  stale team form is detected (days-since-last-match sign)
 *  R2  an odds payload that belongs to another fixture is rejected
 *  R3  missing real statistics are never replaced by invented defaults
 *  R4  a published ticket whose matches have kicked off cannot be replaced
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const over15 = require('../server/prediction/over15');
const oddsService = require('../server/services/oddsService');
const settingsService = require('../server/services/settingsService');
const ticketService = require('../server/services/ticketService');
const fakeDb = require('./fakeDb');
const { buildScenario, FakeApi } = require('./synthetic');

const NOW = new Date();
const SETTINGS = settingsService.toEngineSettings(settingsService.defaults());
const ADMIN = { id: 1, username: 'admin', role: 'superadmin', is_active: 1 };
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** A complete, real-looking team row. Callers override single fields. */
function teamRow(overrides = {}) {
  return {
    matchesPlayed: 10,
    avgGoalsFor: 1.6,
    avgGoalsAgainst: 1.1,
    over15Rate: 80,
    over25Rate: 50,
    cleanSheetRate: 30,
    failedToScoreRate: 10,
    totalGoalsStddev: 1.3,
    formString: 'WWDWL',
    lastMatchAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
    ...overrides,
  };
}

/** Minimal but complete engine input for one fixture. */
function engineInput({ home = {}, away = {} } = {}) {
  const homeAll = teamRow(home);
  const awayAll = teamRow({ avgGoalsFor: 1.3, avgGoalsAgainst: 1.4, ...away });
  return {
    fixture: {
      id: 900001,
      kickoffAt: new Date(NOW.getTime() + 6 * HOUR).toISOString(),
      isPlayable: true,
    },
    odds: { oddDecimal: 1.28, oddRaw: '1.28', ageMinutes: 5, bookmakerName: 'Bet365', bookmakersOffering: 3 },
    form: {
      home: { all: homeAll, venue: { ...homeAll, matchesPlayed: 5 }, last5: homeAll },
      away: { all: awayAll, venue: { ...awayAll, matchesPlayed: 5 }, last5: awayAll },
    },
    leagueEnv: { sufficient: true, avgHomeGoals: 1.5, avgAwayGoals: 1.2, avgTotalGoals: 2.7, over15Rate: 75, sampleMatches: 200 },
    h2h: { available: false, sample: 0 },
    injuries: { available: false, home: null, away: null },
    settings: SETTINGS,
    now: NOW,
  };
}

/* ------------------------------------------------------------------ */
/* R1 — stale form                                                     */
/* ------------------------------------------------------------------ */

test('R1: a team whose last match is 60 days old is rejected as stale form', () => {
  const stale = new Date(NOW.getTime() - 60 * DAY).toISOString();
  const result = over15.analyze(engineInput({ home: { lastMatchAt: stale } }));
  assert.equal(result.eligible, false);
  assert.equal(result.rejectReason, over15.REJECT.INSUFFICIENT_DATA);
  assert.match(result.detail.reason, /stale/);
});

test('R1: days since the last match is reported as a positive number', () => {
  const result = over15.analyze(engineInput());
  assert.equal(result.eligible, true);
  assert.equal(result.features.homeDaysSinceLastMatch, 3);
  assert.equal(result.features.awayDaysSinceLastMatch, 3);
});

/* ------------------------------------------------------------------ */
/* R2 — odds must belong to the fixture being validated                */
/* ------------------------------------------------------------------ */

test('R2: an odds payload for another fixture is rejected, never attached', () => {
  const scn = buildScenario({ oddsValues: ['1.28', '1.30', '1.32'] });
  const row = scn.fixtures[0];
  const payload = JSON.parse(JSON.stringify(scn.oddsPayloads[0]));
  payload.fixture.id = Number(row.id) + 999999;

  const validation = oddsService.validateOddsPayload(
    payload,
    { id: row.id, homeTeamId: row.home_team_id, awayTeamId: row.away_team_id, kickoffAt: row.kickoff_at, statusShort: row.status_short },
    { settings: SETTINGS, now: NOW }
  );
  assert.equal(validation.verified.length, 0, 'no price may be verified for the wrong fixture');
  assert.ok(validation.rejected.length > 0);
  assert.ok(validation.rejected.every((r) => r.reason === oddsService.REJECT.ODDS_FIXTURE_MISMATCH));
});

/* ------------------------------------------------------------------ */
/* R3 — no invented statistics                                         */
/* ------------------------------------------------------------------ */

test('R3: missing goal standard deviation is INSUFFICIENT_DATA, not an assumed 1.35', () => {
  const input = engineInput({ home: { totalGoalsStddev: undefined } });
  const result = over15.analyze(input);
  assert.equal(result.eligible, false);
  assert.equal(result.rejectReason, over15.REJECT.INSUFFICIENT_DATA);
});

test('R3: missing clean-sheet or failed-to-score rate is INSUFFICIENT_DATA', () => {
  for (const field of ['cleanSheetRate', 'failedToScoreRate']) {
    const result = over15.analyze(engineInput({ away: { [field]: null } }));
    assert.equal(result.eligible, false, field);
    assert.equal(result.rejectReason, over15.REJECT.INSUFFICIENT_DATA, field);
  }
});

test('R3: a complete statistics row is still eligible', () => {
  assert.equal(over15.analyze(engineInput()).eligible, true);
});

/* ------------------------------------------------------------------ */
/* R4 — a published ticket cannot be replaced once a leg has kicked off */
/* ------------------------------------------------------------------ */

async function waitForRun(runId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let progress = await ticketService.getGenerationProgress(runId);
  while (progress && progress.status === 'RUNNING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    progress = await ticketService.getGenerationProgress(runId);
  }
  return progress;
}

test('R4: regenerating a ticket whose matches have already kicked off is refused', async () => {
  const scn = buildScenario({ oddsValues: ['1.28', '1.30', '1.32'] });
  const { store, restore } = fakeDb.install({
    admins: [ADMIN],
    settings: [],
    fixtures: scn.fixtures,
    teamForms: scn.teamForms,
    leagues: scn.leagueEnvs,
  });
  settingsService.invalidateCache();
  try {
    const api = new FakeApi(scn);
    const first = await ticketService.startGeneration({ adminId: ADMIN.id, source: 'admin_ui', date: scn.ticketDate, api });
    await waitForRun(first.runId);
    assert.equal(store.tickets.length, 1);
    const firstId = Number(store.tickets[0].id);

    // the published legs kick off in the past
    for (const s of store.selections) {
      if (Number(s.ticket_id) === firstId) s.kickoff_at = new Date(NOW.getTime() - HOUR);
    }

    const second = await ticketService.startGeneration({ adminId: ADMIN.id, source: 'admin_ui', date: scn.ticketDate, api });
    const progress = await waitForRun(second.runId);
    assert.notEqual(progress.status, 'QUALIFIED');
    assert.equal(store.tickets.length, 1, 'the started ticket must survive');
    assert.equal(Number(store.tickets[0].id), firstId, 'the original snapshot is untouched');
  } finally {
    restore();
    settingsService.invalidateCache();
  }
});

/* ------------------------------------------------------------------ */
/* R5 — prices are stored without rounding                             */
/* ------------------------------------------------------------------ */

test('R5: price columns keep up to six decimals (baseline schema and migration 001 agree)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'server', 'database', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'database', 'migrations', '001-widen-odds-precision.sql'),
    'utf8'
  );
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS `odds`');
  const oddsBlock = schema.slice(start, schema.indexOf(') ENGINE=', start));
  assert.match(oddsBlock, /`odd_decimal`\s+DECIMAL\(12,6\)/);
  assert.doesNotMatch(schema, /`odd_decimal`\s+DECIMAL\(8,3\)/);
  assert.doesNotMatch(schema, /`selected_odds`\s+DECIMAL\(8,3\)/);
  assert.match(migration, /MODIFY `odd_decimal` DECIMAL\(12,6\)/);
  assert.match(migration, /MODIFY `selected_odds` DECIMAL\(12,6\)/);
});

/* ------------------------------------------------------------------ */
/* R6 — display: selection prices exact, totals to two decimals         */
/* ------------------------------------------------------------------ */

test('R6: a selection price is displayed exactly as verified; only totals are rounded', () => {
  const decimal = require('../server/utils/decimal');
  assert.equal(decimal.exactOddsText('1.285'), '1.285');
  assert.equal(decimal.exactOddsText('1.25'), '1.25');
  assert.equal(decimal.exactOddsText('1.5'), '1.50');
  assert.equal(decimal.exactOddsText('1.2800'), '1.2800');
  // spec example: 1.25 x 1.30 x 1.35 = 2.19375 — exact internally, 2.19 for display
  const total = decimal.product(['1.25', '1.30', '1.35']);
  assert.equal(decimal.format(total, 2), '2.19');
  assert.equal(decimal.format(total, 5), '2.19375');
});

/* ------------------------------------------------------------------ */
/* R7 — no intermediate rounding can move a total across 2.00           */
/* ------------------------------------------------------------------ */

test('R7: 1.1111 x 1.8 = 1.99998 stays below 2.00 (no intermediate rounding)', () => {
  const decimal = require('../server/utils/decimal');
  const total = decimal.product(['1.1111', '1.8']);
  assert.equal(decimal.format(total, 5), '1.99998');
  assert.equal(decimal.lt(total, decimal.scaledFromNumber(2)), true, 'must be rejected as below the minimum');
  // a bound supplied as a plain setting is exact, not a binary approximation
  assert.equal(decimal.scaledFromNumber(2.1), decimal.toScaled('2.1'));
});
