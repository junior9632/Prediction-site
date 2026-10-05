'use strict';

/**
 * SERVICE LEVEL ACCEPTANCE TESTS — criteria 6, 7, 8, 9, 11, 12.
 *
 * The database is replaced by tests/fakeDb.js (the SQL still comes from
 * server/database/queries.js) and API-Football by tests/synthetic.js, so these
 * tests exercise the real generation, guard and settlement code paths without
 * a server or a network connection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fakeDb = require('./fakeDb');
const { buildScenario, FakeApi } = require('./synthetic');

const db = require('../server/database/queries');
const ticketService = require('../server/services/ticketService');
const settingsService = require('../server/services/settingsService');
const resultService = require('../server/services/resultService');
const decimal = require('../server/utils/decimal');

const ADMIN = { id: 1, username: 'admin', role: 'superadmin', is_active: 1 };

/** Install the double with a full day of synthetic fixtures + statistics. */
function installDay(overrides = {}) {
  const scn = buildScenario(overrides.oddsValues || ['1.28', '1.30', '1.32']);
  const ctx = fakeDb.install({
    admins: [ADMIN],
    settings: [],
    fixtures: overrides.fixtures || scn.fixtures,
    teamForms: scn.teamForms,
    leagues: scn.leagueEnvs,
    ...overrides.extra,
  });
  settingsService.invalidateCache();
  return { scn, ...ctx };
}

async function waitForRun(runId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let progress = await ticketService.getGenerationProgress(runId);
  while (progress && progress.status === 'RUNNING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    progress = await ticketService.getGenerationProgress(runId);
  }
  return progress;
}

/* ------------------------------------------------------------------ */
/* Acceptance 8 — generation is manual only                            */
/* ------------------------------------------------------------------ */

test('acceptance 8: cron, scheduler and anonymous triggers are refused', () => {
  for (const source of ['cron', 'scheduler', 'auto', 'system', 'background', '']) {
    assert.throws(
      () => ticketService.assertManualTrigger({ source, adminId: 1 }),
      (err) => err.code === 'AUTOMATIC_GENERATION_DISABLED',
      `source ${source} must be refused`,
    );
  }
  assert.throws(
    () => ticketService.assertManualTrigger({ source: 'admin_api', adminId: null }),
    (err) => err.code === 'ADMIN_REQUIRED',
  );
  assert.doesNotThrow(() => ticketService.assertManualTrigger({ source: 'admin_ui', adminId: 1 }));
  assert.doesNotThrow(() => ticketService.assertManualTrigger({ source: 'admin_api', adminId: 7 }));
  assert.doesNotThrow(() => ticketService.assertManualTrigger({ source: 'cli_manual', adminId: null }));
});

test('acceptance 8: generation is refused inside a cron context even for an admin', () => {
  process.env.CRON_CONTEXT = '1';
  try {
    assert.throws(
      () => ticketService.assertManualTrigger({ source: 'admin_ui', adminId: 1 }),
      (err) => err.code === 'CRON_GENERATION_FORBIDDEN',
    );
  } finally {
    delete process.env.CRON_CONTEXT;
  }

  process.env.FP_CRON = '1';
  try {
    assert.throws(
      () => ticketService.assertManualTrigger({ source: 'cli_manual', adminId: null }),
      (err) => err.code === 'CRON_GENERATION_FORBIDDEN',
    );
  } finally {
    delete process.env.FP_CRON;
  }
});

test('acceptance 8: the locked rules are re-checked on every run', async () => {
  await assert.rejects(
    () =>
      ticketService.runGeneration({
        source: 'admin_api',
        adminId: 1,
        runId: null,
        settings: { marketKey: 'over_2_5', autoTicketGeneration: false, minTotalOdds: 2, maxTotalOdds: 4 },
        api: { configured: false, isAvailable: () => false },
      }),
    (err) => err.code === 'MARKET_LOCKED',
  );

  await assert.rejects(
    () =>
      ticketService.runGeneration({
        source: 'admin_api',
        adminId: 1,
        runId: null,
        settings: { marketKey: 'over_1_5', autoTicketGeneration: true, minTotalOdds: 2, maxTotalOdds: 4 },
        api: { configured: false, isAvailable: () => false },
      }),
    (err) => err.code === 'AUTO_GENERATION_LOCKED',
  );
});

/* ------------------------------------------------------------------ */
/* Acceptance 7 — data source unavailable                              */
/* ------------------------------------------------------------------ */

test('acceptance 7: no API key -> DATA SOURCE TEMPORARILY UNAVAILABLE and no ticket', async () => {
  const { scn, store, restore } = installDay();
  try {
    const runId = await db.insertGenerationLog({
      ticketDate: scn.ticketDate,
      triggerSource: 'admin_api',
      adminId: 1,
      status: 'RUNNING',
      progressStep: 'LOADING_FIXTURES',
      progressJson: [],
      settingsSnapshot: {},
      startedAt: new Date(),
    });

    const outcome = await ticketService.runGeneration({
      runId,
      adminId: 1,
      source: 'admin_api',
      date: scn.ticketDate,
      api: { configured: false, isAvailable: () => false, breakerState: () => ({ state: 'OPEN' }) },
    });

    assert.equal(outcome.status, 'DATA_SOURCE_UNAVAILABLE');
    assert.equal(outcome.report.message, 'DATA SOURCE TEMPORARILY UNAVAILABLE');
    assert.equal(store.tickets.length, 0, 'no ticket may be created without the data source');
    assert.equal(store.selections.length, 0);

    const logRow = store.generationLogs.find((g) => g.id === runId);
    assert.equal(logRow.status, 'DATA_SOURCE_UNAVAILABLE');
    assert.ok(logRow.finished_at);

    // the public page shows the unavailable state, never invented picks
    const publicTicket = await ticketService.getTicketForDate(scn.ticketDate);
    assert.equal(publicTicket.status, 'DATA_SOURCE_UNAVAILABLE');
    assert.equal(publicTicket.headline, 'DATA SOURCE TEMPORARILY UNAVAILABLE');
    assert.equal(publicTicket.selections.length, 0);
    assert.equal(publicTicket.totalOdds, null);
  } finally {
    restore();
    settingsService.invalidateCache();
  }
});

test('acceptance 7: an unreachable API (circuit breaker open) also produces no ticket', async () => {
  const { scn, store, restore } = installDay();
  try {
    const api = new FakeApi(scn, { configured: true, available: false });
    const outcome = await ticketService.runGeneration({
      runId: null,
      adminId: 1,
      source: 'admin_api',
      date: scn.ticketDate,
      api,
    });
    assert.equal(outcome.status, 'DATA_SOURCE_UNAVAILABLE');
    assert.equal(outcome.report.reason, 'CIRCUIT_OPEN');
    assert.equal(outcome.report.message, 'DATA SOURCE TEMPORARILY UNAVAILABLE');
    assert.equal(store.tickets.length, 0);
  } finally {
    restore();
    settingsService.invalidateCache();
  }
});

test('acceptance 7: a run with no fixtures at all never fabricates a ticket', async () => {
  const { scn, store, restore } = installDay({ fixtures: [] });
  try {
    const api = new FakeApi(scn); // odds endpoint would answer, but there is nothing to price
    api.getFixturesByDate = async () => ({ response: [], results: 0, paging: { current: 1, total: 1 } });
    const outcome = await ticketService.runGeneration({
      runId: null,
      adminId: 1,
      source: 'admin_api',
      date: scn.ticketDate,
      api,
    });
    assert.equal(outcome.status, 'NO_QUALIFYING_TICKET');
    assert.equal(store.tickets.length, 1, 'the no-ticket outcome is recorded, without picks');
    assert.equal(store.tickets[0].status, 'NO_QUALIFYING_TICKET');
    assert.equal(Number(store.tickets[0].selection_count), 0);
    assert.equal(store.selections.length, 0);
  } finally {
    restore();
    settingsService.invalidateCache();
  }
});

/* ------------------------------------------------------------------ */
/* Acceptance 9 — the administrator generates the ticket               */
/* ------------------------------------------------------------------ */

test('acceptance 9: an administrator generates a qualified ticket from verified data', async () => {
  const { scn, store, restore } = installDay();
  try {
    const api = new FakeApi(scn);
    const started = await ticketService.startGeneration({
      adminId: ADMIN.id,
      source: 'admin_ui',
      date: scn.ticketDate,
      api,
    });
    assert.ok(started.runId);
    assert.equal(started.status, 'RUNNING');

    const progress = await waitForRun(started.runId);
    assert.equal(progress.status, 'QUALIFIED', String(progress.error || ''));
    // every value the dashboard receives must be JSON serialisable (BigInt
    // scaled odds stay internal)
    assert.doesNotThrow(() => JSON.stringify(progress));
    assert.doesNotThrow(() => JSON.stringify(progress.report));
    assert.ok(progress.progress.length >= 5, 'the dashboard receives step by step progress');
    assert.equal(progress.progress[progress.progress.length - 1].step, 'CREATING_TICKET');

    /* --- the stored ticket --- */
    assert.equal(store.tickets.length, 1);
    const ticket = store.tickets[0];
    assert.equal(ticket.status, 'QUALIFIED');
    assert.equal(ticket.market_key, 'over_1_5');
    assert.equal(Number(ticket.selection_count), 3);
    assert.equal(ticket.total_odds_display, '2.20');
    assert.equal(decimal.format(decimal.toScaled(String(ticket.total_odds)), 4), '2.1965');
    assert.equal(ticket.result, 'PENDING');
    assert.equal(ticket.generated_by_admin_id, ADMIN.id);
    assert.equal(Number(ticket.min_total_odds), 2);
    assert.equal(Number(ticket.max_total_odds), 4);

    /* --- the stored legs carry the untouched bookmaker prices --- */
    assert.equal(store.selections.length, 3);
    const raws = store.selections.map((s) => String(s.odd_raw)).sort();
    assert.deepEqual(raws, ['1.28', '1.30', '1.32']);
    for (const sel of store.selections) {
      assert.equal(sel.market_key, 'over_1_5');
      assert.equal(sel.market_label, 'Over 1.5 Goals');
      assert.ok(sel.bookmaker_name, 'a real bookmaker is recorded');
      assert.ok(sel.bookmaker_id);
      assert.ok(sel.odds_verified_at, 'the immutable snapshot records when it was verified');
      assert.ok(sel.snapshot_json, 'the odds snapshot is frozen with the pick');
      assert.equal(sel.result, 'PENDING');
      const snapshot = typeof sel.snapshot_json === 'string' ? JSON.parse(sel.snapshot_json) : sel.snapshot_json;
      assert.equal(snapshot.odds.raw, String(sel.odd_raw), 'the snapshot freezes the published price');
      assert.equal(snapshot.market.key, 'over_1_5');
      assert.equal(snapshot.market.goalLine, 1.5);
      assert.ok(snapshot.odds.bookmakerName);
      assert.ok(snapshot.scoring.confidence >= 72);
      assert.equal(Number(snapshot.settings.minTotalOdds), 2);
      assert.equal(Number(snapshot.settings.maxTotalOdds), 4);
    }

    /* --- only verified Over 1.5 rows are stored --- */
    assert.ok(store.odds.length >= 3);
    for (const row of store.odds) {
      assert.equal(row.market_key, 'over_1_5');
      assert.equal(Number(row.goal_line), 1.5);
      assert.equal(row.direction, 'over');
      if (Number(row.is_verified) === 1) assert.equal(row.reject_reason, null);
    }
    assert.ok(
      !store.odds.some((row) => Number(row.is_verified) === 1 && String(row.value_name).toLowerCase().includes('2.5')),
      'an Over 2.5 price must never be stored as verified Over 1.5',
    );

    /* --- predictions and the generation report --- */
    assert.equal(store.predictions.length, 3);
    assert.ok(store.predictions.every((p) => Number(p.is_eligible) === 1));

    const logRow = store.generationLogs.find((g) => g.id === started.runId);
    assert.equal(logRow.status, 'QUALIFIED');
    assert.equal(Number(logRow.selected_picks), 3);
    assert.equal(logRow.ticket_id, ticket.id);
    const report = typeof logRow.report_json === 'string' ? JSON.parse(logRow.report_json) : logRow.report_json;
    assert.equal(report.selectedPicks, 3);
    assert.equal(report.totalOdds, '2.20');
    assert.ok(report.fixturesScanned >= 3);
    assert.equal(report.status, 'QUALIFIED');
    assert.equal(report.qualifiedCombinations, 1);
    assert.ok(Array.isArray(report.alternatives));
    assert.doesNotThrow(() => JSON.stringify(report.alternatives));

    /* --- the public payload is derived from the stored rows --- */
    const publicTicket = await ticketService.getTicketForDate(scn.ticketDate);
    assert.equal(publicTicket.status, 'QUALIFIED');
    assert.equal(publicTicket.market.label, 'Over 1.5 Goals');
    assert.equal(publicTicket.totalOdds, '2.20');
    assert.equal(publicTicket.selectionCount, 3);
    assert.equal(publicTicket.selections.length, 3);
    for (const pick of publicTicket.selections) {
      assert.equal(pick.market?.label || pick.marketLabel, 'Over 1.5 Goals');
      // `value` is the untouched published string, `display` the 2dp rendering
      assert.equal(pick.odds.display, Number(pick.odds.value).toFixed(2));
      assert.equal(decimal.format(decimal.toScaled(pick.odds.value), 4).slice(0, 4), String(pick.odds.value).slice(0, 4));
      assert.ok(['1.28', '1.30', '1.32'].includes(pick.odds.display));
      assert.ok(pick.confidence >= 72);
      assert.equal(pick.result, 'PENDING');
    }
    assert.ok(publicTicket.generatedAt);

    /* --- the odds really came from the API client --- */
    assert.ok(api.calls.some((c) => c.startsWith('/odds?date=')));
  } finally {
    restore();
    settingsService.invalidateCache();
  }
});

test('acceptance 9: regenerating for the same date replaces the ticket instead of duplicating it', async () => {
  const { scn, store, restore } = installDay();
  try {
    const api = new FakeApi(scn);
    const first = await ticketService.startGeneration({ adminId: ADMIN.id, source: 'admin_ui', date: scn.ticketDate, api });
    await waitForRun(first.runId);
    assert.equal(store.tickets.length, 1);
    const firstId = store.tickets[0].id;

    const second = await ticketService.startGeneration({ adminId: ADMIN.id, source: 'admin_ui', date: scn.ticketDate, api });
    const progress = await waitForRun(second.runId);
    assert.equal(progress.status, 'QUALIFIED');
    assert.equal(store.tickets.length, 1, 'one published ticket per date');
    assert.notEqual(store.tickets[0].id, firstId);
    assert.equal(store.selections.filter((s) => Number(s.ticket_id) === Number(store.tickets[0].id)).length, 3);
  } finally {
    restore();
    settingsService.invalidateCache();
  }
});

test('acceptance 2 (service level): weak odds produce a recorded NO QUALIFYING TICKET', async () => {
  const weak = ['1.15', '1.18', '1.20'];
  const { scn, store, restore } = installDay({ oddsValues: weak });
  try {
    const api = new FakeApi(buildScenario({ oddsValues: weak }));
    const runId = await db.insertGenerationLog({
      ticketDate: scn.ticketDate,
      triggerSource: 'admin_api',
      adminId: ADMIN.id,
      status: 'RUNNING',
      progressStep: 'LOADING_FIXTURES',
      progressJson: [],
      settingsSnapshot: {},
      startedAt: new Date(),
    });
    const outcome = await ticketService.runGeneration({
      runId,
      adminId: ADMIN.id,
      source: 'admin_api',
      date: scn.ticketDate,
      api,
    });
    assert.equal(outcome.status, 'NO_QUALIFYING_TICKET');
    assert.equal(store.tickets.length, 1);
    assert.equal(store.tickets[0].status, 'NO_QUALIFYING_TICKET');
    assert.equal(store.selections.length, 0);
    assert.equal(store.tickets[0].total_odds_display, '0.00');
    assert.equal(Number(store.tickets[0].total_odds) || 0, 0, 'a rejected ticket publishes no odds');

    const logRow = store.generationLogs.find((g) => g.id === runId);
    assert.equal(logRow.status, 'NO_QUALIFYING_TICKET');
    assert.equal(Number(logRow.final_candidates), 3);
    assert.equal(Number(logRow.selected_picks), 0);
    const report = typeof logRow.report_json === 'string' ? JSON.parse(logRow.report_json) : logRow.report_json;
    assert.equal(report.reason, 'ALL_COMBINATIONS_BELOW_MINIMUM');
    assert.match(report.message, /minimum total odds/i);
    assert.doesNotThrow(() => JSON.stringify(report));

    const publicTicket = await ticketService.getTicketForDate(scn.ticketDate);
    assert.equal(publicTicket.status, 'NO_QUALIFYING_TICKET');
    assert.equal(publicTicket.headline, 'NO QUALIFYING TICKET');
    assert.equal(publicTicket.selections.length, 0);
    assert.equal(publicTicket.totalOdds, null);
    assert.ok(publicTicket.noTicket && publicTicket.noTicket.message);
    assert.ok(publicTicket.noTicket.diagnostics, 'the diagnostics explain why nothing qualified');
    assert.equal(publicTicket.noTicket.diagnostics.fixturesAnalyzed, 3);
    assert.equal(publicTicket.noTicket.diagnostics.qualifiedCombinations, 0);
  } finally {
    restore();
    settingsService.invalidateCache();
  }
});

/* ------------------------------------------------------------------ */
/* Acceptance 11 & 12 — settlement end to end                          */
/* ------------------------------------------------------------------ */

function settledFixture(row, { status, home, away }) {
  return {
    ...row,
    status_long: status === 'FT' ? 'Match Finished' : status === 'PST' ? 'Postponed' : 'Cancelled',
    status_short: status,
    goals_home: home,
    goals_away: away,
    is_playable: status === 'FT' ? 0 : 1,
    is_finished: status === 'FT' ? 1 : 0,
    kickoff_at: new Date(Date.now() - 7200000).toISOString().replace('T', ' ').slice(0, 19),
  };
}

function seededTicket(scn, outcomes) {
  const ticketId = 5001;
  const fixtures = scn.fixtures.map((row, i) => settledFixture(row, outcomes[i]));
  const selections = scn.fixtures.map((row, i) => ({
    id: 6001 + i,
    ticket_id: ticketId,
    fixture_id: row.id,
    prediction_id: null,
    position: i + 1,
    league_id: row.league_id,
    league_name: row.league_name,
    league_country: row.league_country,
    home_team_id: row.home_team_id,
    away_team_id: row.away_team_id,
    home_team_name: row.home_team_name,
    away_team_name: row.away_team_name,
    kickoff_at: row.kickoff_at,
    market_key: 'over_1_5',
    market_label: 'Over 1.5 Goals',
    bookmaker_id: 8,
    bookmaker_name: 'Bet365',
    odd_decimal: Number(row.oddValue),
    odd_raw: row.oddValue,
    confidence: 84,
    quality_score: 90,
    risk_score: 12,
    result: 'PENDING',
    settled_at: null,
    snapshot_json: JSON.stringify({ oddsRaw: row.oddValue, goalLine: 1.5 }),
  }));
  const tickets = [
    {
      id: ticketId,
      ticket_date: scn.ticketDate,
      market_key: 'over_1_5',
      market_label: 'Over 1.5 Goals',
      status: 'QUALIFIED',
      selection_count: selections.length,
      total_odds: decimal.format(decimal.product(selections.map((s) => s.odd_raw)), 6),
      total_odds_display: decimal.format(decimal.product(selections.map((s) => s.odd_raw)), 2),
      result: 'PENDING',
      settled_odds: null,
      settled_at: null,
      result_note: null,
      published: 1,
      generation_id: null,
    },
  ];
  return { fixtures, selections, tickets };
}

test('acceptance 11: every leg with 2+ goals settles WON and the ticket wins', async () => {
  const scn = buildScenario();
  const seed = seededTicket(scn, [
    { status: 'FT', home: 2, away: 1 },
    { status: 'FT', home: 1, away: 1 },
    { status: 'FT', home: 3, away: 0 },
  ]);
  const { store, restore } = fakeDb.install({ ...seed, admins: [ADMIN], settings: [], teamForms: scn.teamForms, leagues: scn.leagueEnvs });
  try {
    const outcome = await resultService.settlePendingSelections({ refreshFromApi: false });
    assert.equal(outcome.settled.length, 3);
    assert.ok(outcome.settled.every((s) => s.outcome === 'WON'));
    assert.ok(store.selections.every((s) => s.result === 'WON'));
    assert.deepEqual(
      store.selections.map((s) => Number(s.final_total_goals)),
      [3, 2, 3],
    );
    assert.equal(store.tickets[0].result, 'WON');
    assert.equal(store.tickets[0].settled_odds, '2.196500');
    assert.ok(store.tickets[0].settled_at);
    assert.equal(store.results.length, 3);
    assert.ok(store.results.every((r) => r.over15_result === 'WON' && Number(r.settled) === 1));
  } finally {
    restore();
  }
});

test('acceptance 12: one leg with 0-1 goals loses the whole ticket', async () => {
  const scn = buildScenario();
  const seed = seededTicket(scn, [
    { status: 'FT', home: 2, away: 0 },
    { status: 'FT', home: 1, away: 0 },
    { status: 'NS', home: null, away: null },
  ]);
  const { store, restore } = fakeDb.install({ ...seed, admins: [ADMIN], settings: [], teamForms: scn.teamForms, leagues: scn.leagueEnvs });
  try {
    const outcome = await resultService.settlePendingSelections({ refreshFromApi: false });
    assert.equal(outcome.settled.length, 2, 'the unplayed leg stays pending');
    const byFixture = new Map(store.selections.map((s) => [Number(s.fixture_id), s.result]));
    assert.equal(byFixture.get(1001), 'WON');
    assert.equal(byFixture.get(1002), 'LOST');
    assert.equal(byFixture.get(1003), 'PENDING');
    assert.equal(store.tickets[0].result, 'LOST', 'a lost leg loses the accumulator immediately');
  } finally {
    restore();
  }
});

test('settlement: postponed and cancelled legs are void, never won or lost', async () => {
  const scn = buildScenario();
  const seed = seededTicket(scn, [
    { status: 'FT', home: 2, away: 2 },
    { status: 'PST', home: null, away: null },
    { status: 'CANC', home: null, away: null },
  ]);
  const { store, restore } = fakeDb.install({ ...seed, admins: [ADMIN], settings: [], teamForms: scn.teamForms, leagues: scn.leagueEnvs });
  try {
    await resultService.settlePendingSelections({ refreshFromApi: false });
    const byFixture = new Map(store.selections.map((s) => [Number(s.fixture_id), s.result]));
    assert.equal(byFixture.get(1001), 'WON');
    assert.equal(byFixture.get(1002), 'POSTPONED');
    assert.equal(byFixture.get(1003), 'VOID');
    assert.equal(store.tickets[0].result, 'PARTIAL_VOID');
    // the settled odds drop the void legs: only the winning 1.28 remains
    assert.equal(store.tickets[0].settled_odds, '1.280000');
    assert.match(String(store.tickets[0].result_note), /void/i);
  } finally {
    restore();
  }
});

test('settlement: an all-void ticket is VOID with no payout claim', async () => {
  const scn = buildScenario();
  const seed = seededTicket(scn, [
    { status: 'PST', home: null, away: null },
    { status: 'CANC', home: null, away: null },
    { status: 'ABD', home: null, away: null },
  ]);
  const { store, restore } = fakeDb.install({ ...seed, admins: [ADMIN], settings: [], teamForms: scn.teamForms, leagues: scn.leagueEnvs });
  try {
    await resultService.settlePendingSelections({ refreshFromApi: false });
    assert.equal(store.tickets[0].result, 'VOID');
    assert.ok(store.selections.every((s) => ['VOID', 'POSTPONED'].includes(s.result)));
  } finally {
    restore();
  }
});
