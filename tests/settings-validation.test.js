'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../server/services/settingsService');
const connection = require('../server/database/connection');
const fakeDb = require('./fakeDb');

let ctx;
beforeEach(() => { ctx = fakeDb.install({ settings: [] }); settings.invalidateCache(); });
afterEach(() => { ctx.restore(); settings.invalidateCache(); });

const row = (key) => ctx.store.settings.find((item) => item.setting_key === key);
const reasons = (result) => Object.fromEntries(result.rejected.map((entry) => [entry.key, entry.reason]));

test('every editable default can be saved and read back from a previously unseeded database', async () => {
  const patch = Object.fromEntries(Object.entries(settings.DEFINITIONS).filter(([, def]) => !def.locked).map(([key, def]) => [key, def.value]));
  const result = await settings.updateSettings(patch, 7);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.applied.length, Object.keys(patch).length);
  assert.equal(ctx.store.settings.length, result.applied.length);
  assert.ok(ctx.store.settings.every((item) => item.updated_by === 7));
  assert.deepEqual(await settings.getEffectiveSettings(true), { ...settings.defaults(), __source: 'database' });
  const listing = await settings.listSettingsForAdmin();
  assert.equal(listing.length, Object.keys(settings.DEFINITIONS).length);
  assert.equal(listing.filter((item) => item.needsRepair).length, 0);
  assert.equal(listing.find((item) => item.key === 'sync_days_ahead').integer, true);
  assert.equal(listing.find((item) => item.key === 'poisson_weight').integer, false);
});

test('saving only changed settings preserves every other value and invalidates the read cache', async () => {
  await settings.getEffectiveSettings();
  await settings.updateSettings({ min_confidence: '80', sync_leagues: '39, 140,39', display_timezone: 'Africa/Lagos' });
  await settings.updateSettings({ max_risk: '30' });
  const effective = await settings.getEffectiveSettings();
  assert.equal(effective.min_confidence, 80);
  assert.equal(effective.max_risk, 30);
  assert.equal(effective.sync_leagues, '39,140');
  assert.equal(effective.display_timezone, 'Africa/Lagos');
  assert.equal(ctx.store.settings.length, 4);
});

test('JSON objects are serialised as JSON, not [object Object], and reach all four consumers', async () => {
  const patch = {
    confidence_weights: { modelWeight: 0.7, marketWeight: 0.3 },
    risk_weights: { injuries: 0.1 },
    quality_weights: { fixtureFreshness: 0.1 },
    combination_weights: { avgConfidence: 0.5 },
  };
  const result = await settings.updateSettings(patch);
  assert.deepEqual(result.rejected, []);
  for (const [key, value] of Object.entries(patch)) assert.deepEqual(JSON.parse(row(key).setting_value), value);
  const engine = await settings.getEngineSettings(true);
  assert.deepEqual(engine.confidence, patch.confidence_weights);
  assert.deepEqual(engine.riskWeights, patch.risk_weights);
  assert.deepEqual(engine.qualityWeights, patch.quality_weights);
  assert.deepEqual(engine.combinationWeights, patch.combination_weights);
});

test('zero is a real value for sync budgets and model settings, not an absent/default value', async () => {
  const result = await settings.updateSettings({ sync_days_ahead: 0, h2h_sync_max_calls: '0', api_quota_reserve: 0, history_refresh_minutes: 0, poisson_weight: 0, combination_leg_penalty: 0 });
  assert.deepEqual(result.rejected, []);
  const engine = await settings.getEngineSettings(true);
  for (const key of ['syncDaysAhead', 'h2hSyncMaxCalls', 'apiQuotaReserve', 'historyRefreshMinutes', 'poissonWeight', 'legPenalty']) assert.equal(engine[key], 0, key);
});

test('empty, null, arrays, booleans and non-finite inputs cannot silently become numeric zero', async () => {
  for (const bad of ['', ' ', null, true, [], {}, 'NaN', 'Infinity']) {
    const result = await settings.updateSettings({ h2h_sync_max_calls: bad });
    assert.equal(result.applied.length, 0, JSON.stringify(bad));
    assert.equal(reasons(result).h2h_sync_max_calls, 'NOT_A_NUMBER');
  }
  assert.equal(ctx.store.settings.length, 0);
});

test('count/day/window settings reject fractions while probability settings keep precision', async () => {
  const keys = Object.entries(settings.DEFINITIONS).filter(([, def]) => def.integer).map(([key]) => key);
  for (const key of keys) {
    const result = await settings.updateSettings({ [key]: Number(settings.DEFINITIONS[key].value) + 0.5 });
    assert.equal(reasons(result)[key], 'NOT_AN_INTEGER', key);
  }
  const result = await settings.updateSettings({ injury_impact_per_player: '0.0125', dixon_coles_rho: '-0.05' });
  assert.equal(result.applied.length, 2);
  assert.equal(result.settings.injury_impact_per_player, 0.0125);
});

test('booleans accept only explicit on/off values, never arbitrary strings or objects', async () => {
  for (const bad of ['sometimes', '', 2, null, {}, []]) {
    assert.equal(reasons(await settings.updateSettings({ enable_h2h_api: bad })).enable_h2h_api, 'INVALID_BOOLEAN');
  }
  for (const good of [true, 1, 'TRUE', ' on ']) assert.equal((await settings.updateSettings({ enable_h2h_api: good })).settings.enable_h2h_api, true);
  for (const good of [false, 0, 'FALSE', 'off']) assert.equal((await settings.updateSettings({ enable_h2h_api: good })).settings.enable_h2h_api, false);
});

test('timezone and league validation refuse typos instead of silently choosing different fixtures', async () => {
  const result = await settings.updateSettings({ sync_timezone: 'Bogus/Zone', display_timezone: 'Lagos', sync_leagues: '39,broken,140' });
  assert.deepEqual(reasons(result), { sync_timezone: 'INVALID_TIMEZONE', display_timezone: 'INVALID_TIMEZONE', sync_leagues: 'INVALID_LEAGUE_IDS' });
  for (const bad of ['0', '-1', '1.5', '39,,140', '39,', '9007199254740993']) {
    assert.equal(reasons(await settings.updateSettings({ sync_leagues: bad })).sync_leagues, 'INVALID_LEAGUE_IDS', bad);
  }
  assert.deepEqual((await settings.updateSettings({ sync_timezone: 'Africa/Lagos', display_timezone: 'auto', sync_leagues: '' })).rejected, []);
});

test('strings, options and patch shape are validated without altering unrelated values', async () => {
  const result = await settings.updateSettings({ site_name: ' ', site_tagline: 'x'.repeat(201), odds_bookmaker_preference: ['Bet365'], odds_selection_strategy: 'invented', max_risk: '32' });
  assert.deepEqual(reasons(result), { site_name: 'REQUIRED', site_tagline: 'TOO_LONG', odds_bookmaker_preference: 'NOT_A_STRING', odds_selection_strategy: 'INVALID_OPTION' });
  assert.deepEqual(result.applied, [{ key: 'max_risk', value: '32' }]);
  for (const patch of [null, [], 'not an object', 7, {}]) await assert.rejects(() => settings.updateSettings(patch), (err) => err.status === 400);
  const unknown = await settings.updateSettings(JSON.parse('{"__proto__":"bad","constructor":"bad"}'));
  assert.equal(unknown.rejected.length, 2);
  assert.ok(unknown.rejected.every((entry) => entry.reason === 'UNKNOWN_SETTING'));
});

test('scoring weights reject malformed JSON, arrays, primitives, negative and unknown weights', async () => {
  const cases = [
    ['{', 'INVALID_JSON'], ['null', 'INVALID_WEIGHTS'], ['[]', 'INVALID_WEIGHTS'], ['4', 'INVALID_WEIGHTS'],
    [{ modelWeight: -0.1 }, 'INVALID_WEIGHT'], [{ modelWeight: '0.5' }, 'INVALID_WEIGHT'],
    [{ absoluteMax: 101 }, 'INVALID_WEIGHT'], [{ absoluteMax: 0 }, 'INVALID_WEIGHT'],
    [{ modelWeigth: 0.5 }, 'UNKNOWN_WEIGHT'], [{ modelWeight: 0, marketWeight: 0 }, 'ZERO_WEIGHT_TOTAL'],
  ];
  for (const [value, reason] of cases) assert.equal(reasons(await settings.updateSettings({ confidence_weights: value })).confidence_weights, reason);
  for (const key of ['risk_weights', 'quality_weights', 'combination_weights']) {
    const zero = Object.fromEntries(Object.keys(JSON.parse(settings.DEFINITIONS[key].value)).map((name) => [name, 0]));
    assert.equal(reasons(await settings.updateSettings({ [key]: zero }))[key], 'ZERO_WEIGHT_TOTAL');
  }
  assert.equal(ctx.store.settings.length, 0);
});

test('cross-field validation checks the merged current values and rechecks after a rejection', async () => {
  const result = await settings.updateSettings({ min_total_odds: 3.5, max_total_odds: 2.5, min_selections: 8, max_selections: 7, max_risk: 30 });
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].key, 'max_risk');
  assert.equal(reasons(result).min_total_odds, 'ODDS_WINDOW_INVALID');
  assert.equal(reasons(result).max_total_odds, 'ODDS_WINDOW_INVALID');
  assert.equal(reasons(result).min_selections, 'SELECTION_RANGE_INVALID');

  // Form min=8 was initially valid against proposed window=9. The window is
  // rejected because venue min=10 does not fit, so min=8 must be rejected too
  // against the current window=5, not committed as an inconsistent pair.
  await settings.updateSettings({ form_window_matches: 5, min_form_matches: 4 });
  const cascade = await settings.updateSettings({ form_window_matches: 9, min_form_matches: 8, min_venue_form_matches: 10 });
  assert.equal(cascade.applied.length, 0);
  assert.ok(cascade.rejected.some((entry) => entry.key === 'min_form_matches'));
  assert.equal((await settings.getEffectiveSettings(true)).form_window_matches, 5);
  assert.equal(reasons(await settings.updateSettings({ poisson_weight: 0, history_weight: 0 })).poisson_weight, 'ZERO_MODEL_WEIGHTS');
  assert.equal(reasons(await settings.updateSettings({ min_selections: 5, candidate_pool_size: 3 })).candidate_pool_size, 'CANDIDATE_POOL_TOO_SMALL');
});

test('locked values are pinned in the admin listing, effective settings and engine mapper', async () => {
  ctx.store.settings.push({ setting_key: 'market_key', setting_value: 'over_2_5' }, { setting_key: 'auto_ticket_generation', setting_value: '1' }, { setting_key: 'results_settle_mode', setting_value: 'halftime' });
  const result = await settings.updateSettings({ market_key: 'over_2_5', auto_ticket_generation: true, results_settle_mode: 'halftime' });
  assert.equal(result.applied.length, 0);
  assert.ok(result.rejected.every((entry) => entry.reason === 'LOCKED_SETTING'));
  const listing = await settings.listSettingsForAdmin();
  for (const key of settings.LOCKED_KEYS) assert.equal(listing.find((item) => item.key === key).value, settings.DEFINITIONS[key].value);
  const engine = settings.toEngineSettings({ market_key: 'bad', auto_ticket_generation: true, results_settle_mode: 'halftime', min_total_odds: 3, max_total_odds: 3 });
  assert.equal(engine.marketKey, 'over_1_5');
  assert.equal(engine.autoTicketGeneration, false);
  assert.equal(engine.resultsSettleMode, 'fulltime');
  assert.deepEqual([engine.minTotalOdds, engine.maxTotalOdds], [2, 4]);
});

test('invalid legacy settings display a repair warning and the same safe values the engine uses', async () => {
  ctx.store.settings.push(
    { setting_key: 'sync_timezone', setting_value: 'Invalid/Zone' },
    { setting_key: 'risk_weights', setting_value: '[object Object]' },
    { setting_key: 'min_selections', setting_value: '9' },
    { setting_key: 'h2h_sync_max_calls', setting_value: null },
  );
  const listing = await settings.listSettingsForAdmin();
  const effective = await settings.getEffectiveSettings(true);
  for (const key of ['sync_timezone', 'risk_weights', 'min_selections', 'max_selections', 'h2h_sync_max_calls']) {
    const item = listing.find((entry) => entry.key === key);
    assert.equal(item.value, settings.DEFINITIONS[key].value);
    assert.equal(item.needsRepair, true, key);
    assert.ok(item.warning);
    assert.deepEqual(effective[key], settings.defaults()[key]);
  }
});

test('a database error during a multi-setting save rolls back the accepted subset', async () => {
  await settings.updateSettings({ site_name: 'Existing site', min_confidence: 80 });
  const snapshot = structuredClone(ctx.store.settings);
  const transaction = connection.transaction;
  const sql = [];
  connection.transaction = (work) => transaction(async (tx) => {
    let writes = 0;
    const execute = tx.execute;
    const query = tx.query;
    tx.query = (statement, params) => { sql.push(statement); return query(statement, params); };
    tx.execute = (statement, params) => {
      writes += 1;
      if (writes === 2) throw new Error('simulated database failure');
      return execute(statement, params);
    };
    return work(tx);
  });
  await assert.rejects(() => settings.updateSettings({ site_name: 'Changed site', min_confidence: 85 }), /simulated database failure/);
  assert.deepEqual(ctx.store.settings, snapshot);
  assert.ok(sql.some((statement) => /FOR UPDATE/.test(statement)), 'validation uses locked current settings');
});
