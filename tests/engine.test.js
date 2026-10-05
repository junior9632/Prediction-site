'use strict';

/**
 * ENGINE TESTS — acceptance criteria 1, 2, 3, 4, 5, 10, 11, 12 plus the exact
 * decimal odds arithmetic. Pure functions only: no database, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const decimal = require('../server/utils/decimal');
const oddsService = require('../server/services/oddsService');
const over15 = require('../server/prediction/over15');
const correlation = require('../server/prediction/correlation');
const ticketBuilder = require('../server/prediction/ticketBuilder');
const pipeline = require('../server/prediction/pipeline');
const resultService = require('../server/services/resultService');
const settingsService = require('../server/services/settingsService');
const contextService = require('../server/services/contextService');

const { buildScenario, isoMinutesAgo } = require('./synthetic');

const NOW = new Date();
const SETTINGS = settingsService.toEngineSettings(settingsService.defaults());

/** Build a fresh scenario per test so mutated payloads never leak. */
function scenario(oddsValues = ['1.28', '1.30', '1.32'], updateMinutesAgo = 5) {
  return buildScenario({ oddsValues, updateMinutesAgo });
}

/** The fixture shape the 14-point validator expects. */
function validatorFixture(row) {
  return {
    id: row.id,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    kickoffAt: row.kickoff_at,
    statusShort: row.status_short,
  };
}

function validate(scn, index, options = {}) {
  const row = scn.fixtures[index];
  return oddsService.validateOddsPayload(
    scn.oddsPayloads[index],
    options.fixture || validatorFixture(row),
    { settings: options.settings || SETTINGS, now: options.now || NOW }
  );
}

function over15Rejections(validation) {
  return validation.rejected.filter(
    (r) => r.direction === 'over' && r.goalLine !== null && Math.abs(Number(r.goalLine) - 1.5) < 1e-9
  );
}

/** Context bundle for the engine, built from the synthetic stored rows. */
function makeContext(scn, row) {
  const formRow = (teamId, scope, window) =>
    scn.teamForms.find((r) => r.team_id === teamId && r.scope === scope && r.window_matches === window) || null;
  const shape = (teamId, venueScope) => ({
    all: contextService.teamFormFromRow(formRow(teamId, 'all', 10)),
    venue: contextService.teamFormFromRow(formRow(teamId, venueScope, 10)),
    last5: contextService.teamFormFromRow(formRow(teamId, 'all', 5)),
  });
  return {
    form: { home: shape(row.home_team_id, 'home'), away: shape(row.away_team_id, 'away'), before: row.kickoff_at },
    leagueEnv: contextService.leagueEnvFromRow(scn.leagueEnvs.find((l) => l.id === row.league_id)),
    h2h: { available: false, sample: 0 },
    injuries: { available: false, home: null, away: null },
  };
}

/** Run the whole pipeline over a scenario, exactly like generation does. */
async function generate(scn, { settings = SETTINGS, now = NOW, overrides = [] } = {}) {
  const fixtures = scn.fixtures.map((row) => {
    const patched = overrides.find((o) => o.id === row.id);
    return patched ? { ...row, ...patched } : row;
  });

  const oddsByFixture = new Map();
  fixtures.forEach((row, index) => {
    const validation = oddsService.validateOddsPayload(scn.oddsPayloads[index], validatorFixture(row), { settings, now });
    const price = oddsService.selectPrice(validation.verified, settings);
    if (price) oddsByFixture.set(Number(row.id), price);
  });

  return pipeline.runPipeline({
    fixtures,
    oddsByFixture,
    settings,
    now,
    loadContext: async (fixture) => {
      const row = fixtures.find((r) => Number(r.id) === Number(fixture.id));
      return makeContext(scn, row);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Exact odds arithmetic                                              */
/* ------------------------------------------------------------------ */

test('decimal: exact multiplication with no floating point drift', () => {
  const total = decimal.product(['1.28', '1.30', '1.32']);
  assert.equal(decimal.format(total, 6), '2.196500');
  assert.equal(decimal.format(total, 4), '2.1965');
  assert.equal(decimal.format(total, 2), '2.20');

  // the classic binary float failure: 1.1 * 1.1 * 1.1 !== 1.331 in IEEE754
  assert.equal(decimal.format(decimal.product(['1.1', '1.1', '1.1']), 4), '1.3310');
  assert.notEqual(1.1 * 1.1 * 1.1, 1.331);

  assert.equal(decimal.format(decimal.product(['2.00', '2.00']), 2), '4.00');
  assert.equal(decimal.format(decimal.product([]), 2), '1.00');
  assert.equal(decimal.product(['1.28', 'abc']), null);
  assert.equal(decimal.format(null, 2), null);
});

test('decimal: window comparisons use the exact value', () => {
  const min = decimal.scaledFromNumber(2);
  const max = decimal.scaledFromNumber(4);
  assert.equal(decimal.gte(decimal.product(['1.28', '1.30', '1.32']), min), true);
  assert.equal(decimal.lte(decimal.product(['1.28', '1.30', '1.32']), max), true);
  // 1.995 must NOT sneak under a 2.00 floor because of a rounded display
  assert.equal(decimal.gte(decimal.toScaled('1.995'), min), false);
  assert.equal(decimal.format(decimal.toScaled('1.995'), 2), '2.00');
  assert.equal(decimal.gt(decimal.toScaled('4.001'), max), true);
});

/* ------------------------------------------------------------------ */
/* Acceptance 4 — exact Over 1.5 goal line, never a substitute         */
/* ------------------------------------------------------------------ */

test('acceptance 4: a fixture offering only Over 2.5 is rejected, never substituted', () => {
  const scn = scenario();
  const payload = scn.oddsPayloads[0];
  payload.bookmakers.forEach((bm) => {
    bm.bets.forEach((bet) => {
      bet.values = bet.values.filter((v) => !/1\.5/i.test(String(v.value || '')));
    });
    bm.bets = bm.bets.filter((bet) => bet.values.length);
  });

  const validation = validate(scn, 0);
  assert.equal(validation.verified.length, 0);
  assert.equal(oddsService.selectPrice(validation.verified, SETTINGS), null);

  const goalLineRejections = validation.rejected.filter((r) => r.reason === oddsService.REJECT.MARKET_GOAL_LINE_MISMATCH);
  assert.ok(goalLineRejections.length >= 1);
  const over25 = goalLineRejections.find((r) => Number(r.goalLine) === 2.5);
  assert.ok(over25, 'the Over 2.5 price must be rejected for a wrong goal line');
  assert.equal(over25.rawOdd, '1.80');
  // the Over 2.5 price of 1.80 must never be reused as an Over 1.5 price
  assert.ok(!validation.verified.some((v) => v.oddRaw === '1.80'));
});

test('acceptance 4: under / half-time / team-total markets are rejected as wrong markets', () => {
  const scn = scenario();
  const payload = scn.oddsPayloads[0];
  payload.bookmakers.forEach((bm) => {
    bm.bets.forEach((bet) => {
      bet.values = bet.values.filter((v) => !/^over 1\.5$/i.test(String(v.value || '').trim()));
    });
    bm.bets = bm.bets.filter((bet) => bet.values.length);
  });

  const validation = validate(scn, 0);
  assert.equal(validation.verified.length, 0);
  const reasons = new Set(validation.rejected.map((r) => r.reason));
  assert.ok(reasons.has(oddsService.REJECT.MARKET_NOT_OVER_1_5) || reasons.has(oddsService.REJECT.MARKET_GOAL_LINE_MISMATCH));
});

test('acceptance 5: Over 1.5 = 1.25 is used exactly, never inflated', () => {
  const scn = scenario(['1.25', '1.25', '1.25']);
  scn.oddsPayloads.forEach((payload) => {
    payload.bookmakers.forEach((bm) => {
      bm.bets.forEach((bet) => {
        bet.values.forEach((v) => {
          if (/over 1\.5/i.test(String(v.value || ''))) v.odd = '1.25';
        });
      });
    });
  });

  const validation = validate(scn, 0);
  assert.equal(validation.verified.length, 3);
  const price = oddsService.selectPrice(validation.verified, SETTINGS);
  assert.equal(price.oddRaw, '1.25');
  assert.equal(price.oddDecimal, 1.25);
  assert.equal(decimal.format(price.oddScaled, 4), '1.2500');
  assert.equal(price.goalLine, 1.5);
  assert.equal(price.direction, 'over');
  assert.equal(price.marketKey, 'over_1_5');
  assert.equal(price.bookmakersOffering, 3);

  // a single 1.25 leg can never reach the 2.00 combined floor on its own
  assert.equal(decimal.gte(price.oddScaled, decimal.scaledFromNumber(2)), false);
});

test('validation: stale, started, cancelled and tampered prices are all rejected', () => {
  const stale = validate(scenario(['1.28', '1.30', '1.32'], 240), 0);
  assert.equal(stale.verified.length, 0);
  assert.equal(over15Rejections(stale)[0].reason, oddsService.REJECT.ODDS_STALE);

  const scn = scenario();
  const started = validate(scn, 0, {
    fixture: { ...validatorFixture(scn.fixtures[0]), kickoffAt: isoMinutesAgo(40), statusShort: '1H' },
  });
  assert.equal(started.verified.length, 0);
  assert.equal(over15Rejections(started)[0].reason, oddsService.REJECT.FIXTURE_STARTED);

  const cancelled = validate(scn, 0, {
    fixture: { ...validatorFixture(scn.fixtures[0]), statusShort: 'CANC' },
  });
  assert.equal(cancelled.verified.length, 0);
  assert.equal(over15Rejections(cancelled)[0].reason, oddsService.REJECT.FIXTURE_CANCELLED);

  const postponed = validate(scn, 0, {
    fixture: { ...validatorFixture(scn.fixtures[0]), statusShort: 'PST' },
  });
  assert.equal(over15Rejections(postponed)[0].reason, oddsService.REJECT.FIXTURE_POSTPONED);

  // a stored price that no longer matches the API string is treated as tampered
  const entry = { ...validate(scn, 0).verified[0] };
  const tampered = oddsService.validateOdd(
    {
      betName: entry.betName,
      valueName: entry.valueName,
      bookmakerId: entry.bookmakerId,
      bookmakerName: entry.bookmakerName,
      rawOdd: '1.28',
      goalLine: 1.5,
      direction: 'over',
      periodOrScopeIssue: null,
      parseIssue: null,
      oddsUpdatedAt: entry.oddsUpdatedAt,
      source: 'api-football',
      storedOddRaw: '9.99',
    },
    validatorFixture(scn.fixtures[0]),
    { settings: SETTINGS, now: NOW }
  );
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, oddsService.REJECT.ODDS_MANUALLY_MODIFIED);

  const wrongSource = oddsService.validateOdd(
    { ...entry, rawOdd: entry.oddRaw, source: 'client' },
    validatorFixture(scn.fixtures[0]),
    { settings: SETTINGS, now: NOW }
  );
  assert.equal(wrongSource.ok, false);
  assert.equal(wrongSource.reason, oddsService.REJECT.ODDS_SOURCE_INVALID);

  const belowMinimum = oddsService.validateOdd(
    { ...entry, rawOdd: '1.00', source: 'api-football' },
    validatorFixture(scn.fixtures[0]),
    { settings: SETTINGS, now: NOW }
  );
  assert.equal(belowMinimum.reason, oddsService.REJECT.ODDS_BELOW_MINIMUM);
});

/* ------------------------------------------------------------------ */
/* Acceptance 1 — a qualified ticket inside the 2.00 - 4.00 window     */
/* ------------------------------------------------------------------ */

test('acceptance 1: qualified ticket keeps combined odds inside 2.00 - 4.00', async () => {
  const result = await generate(scenario(['1.28', '1.30', '1.32']));

  assert.equal(result.status, 'QUALIFIED');
  assert.ok(result.ticket);
  assert.equal(result.ticket.selections.length, 3);
  assert.equal(result.counters.selectedPicks, 3);
  assert.equal(result.ticket.totalOddsExact, '2.1965');
  assert.equal(result.ticket.totalOddsDisplay, '2.20');
  assert.equal(decimal.gte(result.ticket.totalOddsScaled, decimal.scaledFromNumber(2)), true);
  assert.equal(decimal.lte(result.ticket.totalOddsScaled, decimal.scaledFromNumber(4)), true);

  for (const sel of result.ticket.selections) {
    assert.equal(sel.odds.marketKey, 'over_1_5');
    assert.equal(sel.odds.marketLabel, 'Over 1.5 Goals');
    assert.equal(sel.odds.goalLine, 1.5);
    assert.equal(sel.odds.direction, 'over');
    assert.ok(decimal.gte(sel.odds.oddScaled, decimal.scaledFromNumber(SETTINGS.minSingleOdds)));
    assert.ok(decimal.lte(sel.odds.oddScaled, decimal.scaledFromNumber(SETTINGS.maxSingleOdds)));
    assert.ok(sel.confidence >= SETTINGS.minConfidence);
    assert.ok(sel.riskScore <= SETTINGS.maxRisk);
    assert.ok(sel.qualityScore >= SETTINGS.minDataQuality);
    assert.ok(sel.odds.bookmakerName && sel.odds.bookmakerId);
  }
});

test('acceptance 1: engine scores are computed from the real evidence only', async () => {
  const result = await generate(scenario(['1.28', '1.30', '1.32']));
  const eligible = result.predictions.filter((p) => p.isEligible);
  assert.equal(eligible.length, 3);

  for (const p of eligible) {
    assert.ok(p.confidence >= 0 && p.confidence <= 100, `confidence ${p.confidence}`);
    assert.ok(p.modelProbability > 0.5 && p.modelProbability < 1);
    assert.ok(p.marketProbability > 0.5 && p.marketProbability < 1);
    assert.ok(p.expectedTotalGoals > 2);
    assert.ok(p.dataQuality >= SETTINGS.minDataQuality);
    assert.equal(p.marketKey, 'over_1_5');
    assert.ok(['1.28', '1.30', '1.32'].includes(p.odds.oddRaw));
    // no fabricated evidence: h2h and injuries stay unavailable
    assert.equal(p.features.h2hApplied, false);
    assert.equal(p.features.injuriesAvailable, false);
    assert.ok(p.features.homeSample >= SETTINGS.minFormMatches);
  }
  assert.equal(result.counters.rejectedMatches, 0);
});

/* ------------------------------------------------------------------ */
/* Acceptance 2 & 3 — never force a ticket                            */
/* ------------------------------------------------------------------ */

function candidate(fixtureId, oddsRaw, extra = {}) {
  return {
    fixtureId,
    leagueId: 30 + fixtureId,
    leagueCountry: `Country ${fixtureId}`,
    homeTeamId: fixtureId * 10,
    awayTeamId: fixtureId * 10 + 1,
    kickoffAt: `2026-10-05 ${10 + fixtureId}:00:00`,
    odds: { oddRaw: oddsRaw, oddScaled: decimal.toScaled(oddsRaw), oddDecimal: Number(oddsRaw), marketKey: 'over_1_5', goalLine: 1.5 },
    confidence: 85,
    qualityScore: 88,
    riskScore: 8,
    probability: 0.85,
    ...extra,
  };
}

test('acceptance 2: every combination below the minimum -> NO QUALIFYING TICKET', () => {
  const result = ticketBuilder.buildTicket([candidate(1, '1.10'), candidate(2, '1.15')], {
    minTotalOdds: 2.0,
    maxTotalOdds: 4.0,
    minSelections: 2,
    maxSelections: 6,
  });

  assert.equal(result.status, ticketBuilder.STATUS.NO_QUALIFYING_TICKET);
  assert.equal(result.report.reason, 'ALL_COMBINATIONS_BELOW_MINIMUM');
  assert.equal(result.selections.length, 0);
  assert.equal(result.report.highestPossibleOdds, '1.27');
  assert.equal(result.report.qualifiedCombinations, 0);
  assert.match(pipeline.describeNoTicket(result.report), /below the 2\.00 minimum/i);
});

test('acceptance 3: every combination above the maximum -> NO QUALIFYING TICKET', () => {
  const result = ticketBuilder.buildTicket([candidate(1, '2.40'), candidate(2, '2.60'), candidate(3, '2.10')], {
    minTotalOdds: 2.0,
    maxTotalOdds: 4.0,
    minSelections: 2,
    maxSelections: 6,
  });

  assert.equal(result.status, ticketBuilder.STATUS.NO_QUALIFYING_TICKET);
  assert.equal(result.report.reason, 'ALL_COMBINATIONS_ABOVE_MAXIMUM');
  assert.equal(result.selections.length, 0);
  assert.equal(result.report.lowestPossibleOdds, '5.04');
  assert.equal(result.report.qualifiedCombinations, 0);
});

test('acceptance 2/3: an empty or too-small candidate pool never fabricates picks', () => {
  const empty = ticketBuilder.buildTicket([], { minTotalOdds: 2.0, maxTotalOdds: 4.0, minSelections: 2 });
  assert.equal(empty.status, ticketBuilder.STATUS.NO_QUALIFYING_TICKET);
  assert.equal(empty.report.reason, 'INSUFFICIENT_CANDIDATES');

  const single = ticketBuilder.buildTicket([candidate(1, '2.50')], { minTotalOdds: 2.0, maxTotalOdds: 4.0, minSelections: 2 });
  assert.equal(single.status, ticketBuilder.STATUS.NO_QUALIFYING_TICKET);
  assert.equal(single.selections.length, 0);
});

test('acceptance 2: the pipeline reports NO QUALIFYING TICKET end to end', async () => {
  const result = await generate(scenario(['1.15', '1.18', '1.20']));
  assert.equal(result.status, 'NO_QUALIFYING_TICKET');
  assert.equal(result.ticket, null);
  assert.equal(result.selections.length, 0);
  assert.equal(result.counters.finalCandidates, 3);
  assert.equal(result.counters.qualifiedCombinations, 0);
  assert.equal(result.report.reason, 'ALL_COMBINATIONS_BELOW_MINIMUM');
  assert.ok(pipeline.describeNoTicket(result.report).length > 20);
});

test('acceptance 3: the pipeline refuses to publish an over-maximum accumulator', async () => {
  // A narrowed (still legal) window of 2.00-2.10 with a 3 leg minimum: the only
  // reachable combination is 1.28 x 1.30 x 1.32 = 2.1965, which is above it.
  const result = await generate(scenario(['1.28', '1.30', '1.32']), {
    settings: { ...SETTINGS, minSelections: 3, maxTotalOdds: 2.1 },
  });
  assert.equal(result.status, 'NO_QUALIFYING_TICKET');
  assert.equal(result.ticket, null);
  assert.equal(result.selections.length, 0);
  assert.equal(result.counters.finalCandidates, 3);
  assert.equal(result.counters.qualifiedCombinations, 0);
  assert.equal(result.report.reason, 'ALL_COMBINATIONS_ABOVE_MAXIMUM');
  assert.equal(result.report.lowestPossibleOdds, '2.20');
  assert.match(pipeline.describeNoTicket(result.report), /exceeds the 2\.10 maximum|exceeds the 4\.00 maximum|maximum total odds/i);
});

test('acceptance 1: the odds window is applied to the exact total, not the rounded display', async () => {
  const inside = await generate(scenario(['1.28', '1.30', '1.32']), {
    settings: { ...SETTINGS, maxTotalOdds: 2.2 },
  });
  assert.equal(inside.status, 'QUALIFIED');
  assert.equal(inside.ticket.totalOddsExact, '2.1965');
  assert.equal(inside.ticket.totalOddsDisplay, '2.20');

  const outside = await generate(scenario(['1.28', '1.30', '1.32']), {
    settings: { ...SETTINGS, maxTotalOdds: 2.19 },
  });
  assert.equal(outside.status, 'NO_QUALIFYING_TICKET');
  assert.equal(outside.selections.length, 0);
  assert.equal(outside.counters.finalCandidates, 3);
});

/* ------------------------------------------------------------------ */
/* Correlation protection                                             */
/* ------------------------------------------------------------------ */

test('correlation: duplicate fixtures, teams, leagues and kickoff windows are refused', () => {
  const rules = { enabled: true, maxPerLeague: 1, maxPerCountry: 3, maxPerTeam: 1, maxPerKickoffWindow: 1, kickoffWindowMinutes: 45 };
  const first = candidate(1, '1.30');
  const picked = [{ candidate: first, keys: correlation.keysOf(first, rules) }];

  assert.equal(correlation.canAdd(first, picked, rules).rule, 'DUPLICATE_FIXTURE');

  const sameLeague = { ...candidate(2, '1.32'), leagueId: first.leagueId };
  assert.equal(correlation.canAdd(sameLeague, picked, rules).rule, 'MAX_PER_LEAGUE');

  const sameTeam = { ...candidate(3, '1.31'), leagueId: 99, homeTeamId: first.homeTeamId };
  assert.equal(correlation.canAdd(sameTeam, picked, rules).rule, 'SAME_TEAM');

  const sameWindow = { ...candidate(4, '1.33'), leagueId: 98, kickoffAt: first.kickoffAt };
  assert.equal(correlation.canAdd(sameWindow, picked, rules).rule, 'MAX_PER_KICKOFF_WINDOW');

  const distinct = candidate(5, '1.34');
  assert.equal(correlation.canAdd(distinct, picked, rules).ok, true);

  const combo = correlation.checkCombination([first, { ...candidate(2, '1.30'), leagueId: first.leagueId }], rules);
  assert.equal(combo.ok, false);
  assert.equal(combo.rule, 'MAX_PER_LEAGUE');
});

test('correlation: the builder counts correlation rejections', () => {
  const sameLeague = [
    candidate(1, '1.40'),
    { ...candidate(2, '1.45'), leagueId: 31 },
    { ...candidate(3, '1.50'), leagueId: 31 },
  ];
  const result = ticketBuilder.buildTicket(sameLeague, {
    minTotalOdds: 2.0,
    maxTotalOdds: 4.0,
    minSelections: 2,
    maxSelections: 6,
    correlation: { enabled: true, maxPerLeague: 1, maxPerCountry: 3, maxPerTeam: 1, maxPerKickoffWindow: 2, kickoffWindowMinutes: 45 },
  });
  assert.equal(result.status, ticketBuilder.STATUS.NO_QUALIFYING_TICKET);
  assert.equal(result.report.correlationRejected, 2);
  assert.equal(result.report.poolSize, 1);
});

/* ------------------------------------------------------------------ */
/* Acceptance 10 — matches that already started                        */
/* ------------------------------------------------------------------ */

test('acceptance 10: a match that already started cannot be selected', () => {
  const scn = scenario();
  const row = scn.fixtures[1];
  const started = pipeline.normalizeFixtureRow({
    ...row,
    kickoff_at: isoMinutesAgo(40).replace('T', ' '),
    status_long: 'First Half',
    status_short: '1H',
    status_elapsed: 40,
    is_playable: 1,
    is_finished: 0,
  });
  const price = oddsService.selectPrice(validate(scn, 0).verified, SETTINGS);

  const prediction = pipeline.analyzeFixture({
    fixture: started,
    odds: price,
    context: makeContext(scn, row),
    settings: SETTINGS,
    now: NOW,
  });
  assert.equal(prediction.isEligible, false);
  assert.equal(prediction.rejectReason, over15.REJECT.FIXTURE_STARTED);
  assert.equal(prediction.confidence, null);
});

test('acceptance 10: finished and non playable fixtures are excluded from the run', async () => {
  const scn = scenario(['1.60', '1.90', '2.10']);
  const result = await generate(scn, {
    overrides: [
      {
        id: 1003,
        kickoff_at: isoMinutesAgo(140).replace('T', ' '),
        status_long: 'Match Finished',
        status_short: 'FT',
        goals_home: 2,
        goals_away: 1,
        is_playable: 0,
        is_finished: 1,
      },
    ],
  });

  const byId = new Map(result.predictions.map((p) => [Number(p.fixtureId), p]));
  assert.equal(byId.get(1003).isEligible, false);
  assert.ok(['FIXTURE_NOT_PLAYABLE', over15.REJECT.NO_OVER15_ODDS].includes(byId.get(1003).rejectReason));
  assert.ok(result.counters.rejectedMatches >= 1);
  for (const sel of result.selections) assert.notEqual(Number(sel.fixtureId), 1003);
});

test('data guard: a fixture with no verified Over 1.5 price is rejected, not estimated', async () => {
  const scn = scenario();
  const result = await pipeline.runPipeline({
    fixtures: scn.fixtures,
    oddsByFixture: new Map(),
    settings: SETTINGS,
    now: NOW,
    loadContext: async (fixture) => makeContext(scn, scn.fixtures.find((r) => Number(r.id) === Number(fixture.id))),
  });
  assert.equal(result.status, 'NO_QUALIFYING_TICKET');
  assert.equal(result.counters.rejectedNoOdds, 3);
  assert.equal(result.counters.finalCandidates, 0);
  for (const p of result.predictions) assert.equal(p.rejectReason, over15.REJECT.NO_OVER15_ODDS);
});

test('data guard: missing form data produces INSUFFICIENT_DATA, never a guess', async () => {
  const scn = scenario();
  const result = await pipeline.runPipeline({
    fixtures: scn.fixtures.slice(0, 2),
    oddsByFixture: new Map(
      scn.fixtures.slice(0, 2).map((row, i) => [Number(row.id), oddsService.selectPrice(validate(scn, i).verified, SETTINGS)])
    ),
    settings: SETTINGS,
    now: NOW,
    loadContext: async () => ({ form: {}, leagueEnv: { sufficient: false, sampleMatches: 0 }, h2h: { available: false }, injuries: { available: false } }),
  });
  assert.equal(result.counters.finalCandidates, 0);
  for (const p of result.predictions) assert.equal(p.rejectReason, over15.REJECT.INSUFFICIENT_DATA);
});

/* ------------------------------------------------------------------ */
/* Acceptance 11 & 12 — settlement                                     */
/* ------------------------------------------------------------------ */

test('acceptance 11: total goals of 2 or more settles WON', () => {
  for (const [home, away] of [[2, 0], [1, 1], [3, 2], [0, 2], [5, 1]]) {
    assert.equal(resultService.evaluateOver15({ statusShort: 'FT', goalsHome: home, goalsAway: away }), 'WON', `${home}-${away}`);
  }
});

test('acceptance 12: total goals of 0 or 1 settles LOST', () => {
  for (const [home, away] of [[0, 0], [1, 0], [0, 1]]) {
    assert.equal(resultService.evaluateOver15({ statusShort: 'FT', goalsHome: home, goalsAway: away }), 'LOST', `${home}-${away}`);
  }
});

test('settlement: postponed and cancelled matches are never settled as WON or LOST', () => {
  for (const status of ['PST']) {
    assert.equal(resultService.evaluateOver15({ statusShort: status, goalsHome: 2, goalsAway: 1 }), resultService.OUTCOME.POSTPONED);
  }
  for (const status of ['CANC', 'ABD', 'WO', 'AWD']) {
    assert.equal(resultService.evaluateOver15({ statusShort: status, goalsHome: 2, goalsAway: 1 }), resultService.OUTCOME.VOID);
  }
  assert.equal(resultService.evaluateOver15({ statusShort: 'NS', goalsHome: null, goalsAway: null }), resultService.OUTCOME.PENDING);
  // a finished match with a missing scoreline is never guessed
  assert.equal(resultService.evaluateOver15({ statusShort: 'FT', goalsHome: 2, goalsAway: null }), resultService.OUTCOME.PENDING);
});

/* ------------------------------------------------------------------ */
/* Locked product rules                                                */
/* ------------------------------------------------------------------ */

test('settings: market and automatic generation are locked in code', () => {
  const engine = settingsService.toEngineSettings({
    ...settingsService.defaults(),
    market_key: 'over_2_5',
    market_label: 'Over 2.5 Goals',
    auto_ticket_generation: true,
  });
  assert.equal(engine.marketKey, 'over_1_5');
  assert.equal(engine.marketLabel, 'Over 1.5 Goals');
  assert.equal(engine.autoTicketGeneration, false);
  assert.deepEqual(settingsService.LOCKED_KEYS.sort(), ['auto_ticket_generation', 'market_key', 'market_label', 'results_settle_mode']);
});

test('settings: out of range and contradictory updates are rejected', async () => {
  const fakeDb = require('./fakeDb');
  const ctx = fakeDb.install({ settings: [] });
  try {
    /* ---- individually invalid, locked and unknown keys ---- */
    const first = await settingsService.updateSettings({
      min_total_odds: '5.00', // above the product rule maximum of 3.99
      max_total_odds: '2.00', // below the product rule minimum of 2.01
      min_selections: '7',
      max_selections: '6', // individually valid, contradicted by min_selections
      min_single_odds: '2.00',
      max_single_odds: '1.50',
      max_risk: '120',
      max_selections_per_league: '99',
      market_key: 'over_2_5',
      auto_ticket_generation: '1',
      unknown_key: '1',
      min_confidence: '60',
    });
    const rejected = new Map(first.rejected.map((r) => [r.key, r.reason]));
    assert.equal(rejected.get('min_total_odds'), 'ABOVE_MAXIMUM_3.99');
    assert.equal(rejected.get('max_total_odds'), 'BELOW_MINIMUM_2.01');
    assert.equal(rejected.get('min_selections'), 'SELECTION_RANGE_INVALID');
    assert.equal(rejected.get('max_selections'), 'SELECTION_RANGE_INVALID');
    assert.equal(rejected.get('min_single_odds'), 'SINGLE_ODDS_RANGE_INVALID');
    assert.equal(rejected.get('max_single_odds'), 'SINGLE_ODDS_RANGE_INVALID');
    assert.equal(rejected.get('max_risk'), 'ABOVE_MAXIMUM_100');
    assert.equal(rejected.get('max_selections_per_league'), 'ABOVE_MAXIMUM_10');
    assert.equal(rejected.get('market_key'), 'LOCKED_SETTING');
    assert.equal(rejected.get('auto_ticket_generation'), 'LOCKED_SETTING');
    assert.equal(rejected.get('unknown_key'), 'UNKNOWN_SETTING');
    assert.deepEqual(first.applied, [{ key: 'min_confidence', value: '60' }]);
    // the odds window in the database is untouched by the rejected patch
    assert.equal(first.settings.min_total_odds, 2);
    assert.equal(first.settings.max_total_odds, 4);

    /* ---- two individually valid values that contradict each other ---- */
    const second = await settingsService.updateSettings({ min_total_odds: '3.50', max_total_odds: '3.00' });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(
      second.rejected.map((r) => `${r.key}:${r.reason}`).sort(),
      ['max_total_odds:ODDS_WINDOW_INVALID', 'min_total_odds:ODDS_WINDOW_INVALID'],
    );
    assert.equal(second.settings.min_total_odds, 2);
    assert.equal(second.settings.max_total_odds, 4);
  } finally {
    ctx.restore();
    settingsService.invalidateCache();
  }
});
/* ------------------------------------------------------------------ */
/* Review scenarios — the exact products named in the product spec    */
/* ------------------------------------------------------------------ */

const WINDOW = { minTotalOdds: 2.0, maxTotalOdds: 4.0, minSelections: 2, maxSelections: 6 };

test('review 4: 1.30 x 1.50 = 1.95 is below the window and must be rejected', () => {
  const result = ticketBuilder.buildTicket([candidate(1, '1.30'), candidate(2, '1.50')], WINDOW);
  assert.equal(result.status, ticketBuilder.STATUS.NO_QUALIFYING_TICKET);
  assert.equal(result.report.reason, 'ALL_COMBINATIONS_BELOW_MINIMUM');
  assert.equal(result.report.lowestPossibleOdds, '1.95');
  assert.equal(result.selections.length, 0);
});

test('review 5: 1.40 x 1.50 = 2.10 qualifies inside the window', () => {
  const result = ticketBuilder.buildTicket([candidate(1, '1.40'), candidate(2, '1.50')], WINDOW);
  assert.equal(result.status, ticketBuilder.STATUS.QUALIFIED);
  assert.equal(result.totalOddsExact, '2.1000');
  assert.equal(result.totalOddsDisplay, '2.10');
  assert.equal(result.selections.length, 2);
});

test('review 6: 1.50 x 1.50 x 1.50 = 3.375 is an acceptable, qualified combination', () => {
  const result = ticketBuilder.buildTicket(
    [candidate(1, '1.50'), candidate(2, '1.50'), candidate(3, '1.50')],
    WINDOW,
  );
  // A three-leg product of 3.375 sits inside the window, so it must be tested
  // and must qualify. The engine then publishes the STRONGEST qualified
  // combination (spec item 11), which here is a two-leg 2.25 — same candidate
  // set, higher estimated probability, fewer legs.
  assert.equal(result.status, ticketBuilder.STATUS.QUALIFIED);
  assert.ok(
    result.report.combinationsTested >= 4,
    `all 4 reachable combinations must be tested, got ${result.report.combinationsTested}`,
  );
  assert.ok(
    result.report.qualifiedCombinations >= 4,
    `the 3.375 three-leg combo must qualify too, got ${result.report.qualifiedCombinations}`,
  );
  // whatever is published must equal the exact product of its own legs
  const product = result.selections.reduce(
    (acc, s) => decimal.multiply(acc, s.odds.oddScaled),
    decimal.scaledFromNumber(1),
  );
  assert.equal(decimal.format(product, decimal.SCALE_DIGITS), result.totalOddsExact);
});

test('review 6b: a three-leg accumulator is published when only three legs reach 2.00', () => {
  // 1.30 x 1.30 = 1.69 (below the window) but 1.30^3 = 2.197 (inside it), so
  // the only qualifying combination is the three-leg one.
  const result = ticketBuilder.buildTicket(
    [candidate(1, '1.30'), candidate(2, '1.30'), candidate(3, '1.30')],
    WINDOW,
  );
  assert.equal(result.status, ticketBuilder.STATUS.QUALIFIED);
  assert.equal(result.selections.length, 3);
  assert.equal(result.totalOddsExact, '2.1970');
  assert.equal(result.totalOddsDisplay, '2.20');
});
