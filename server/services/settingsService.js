'use strict';

/**
 * SETTINGS SERVICE
 *
 * Single source of truth for every tunable rule. Defaults are seeded into the
 * `settings` table; the admin dashboard can change them, EXCEPT the locked
 * ones (market = Over 1.5 only, automatic ticket generation = OFF) which can
 * never be weakened from the UI or the API.
 */

const db = require('../database/queries');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const config = require('../config');
const time = require('../utils/time');
const confidenceDefaults = require('../prediction/confidence').DEFAULTS;
const riskDefaults = require('../prediction/risk').DEFAULT_WEIGHTS;
const qualityDefaults = require('../prediction/quality').DEFAULT_WEIGHTS;
const ticketDefaults = require('../prediction/ticketBuilder').DEFAULTS;

const log = logger.child('settings');

/** key -> definition */
const DEFINITIONS = {
  /* ---------------- market (LOCKED) ---------------- */
  market_key: { value: 'over_1_5', type: 'string', group: 'market', label: 'Prediction Market', description: 'The only market this platform predicts.', locked: true },
  market_label: { value: 'Over 1.5 Goals', type: 'string', group: 'market', label: 'Market Label', description: 'Displayed on every prediction card.', locked: true },
  auto_ticket_generation: { value: '0', type: 'boolean', group: 'market', label: 'Automatic Ticket Generation', description: 'Permanently OFF. Tickets are created only by an administrator clicking GENERATE TODAY\'S TICKET.', locked: true },

  /* ---------------- odds window ---------------- */
  min_total_odds: { value: '2.00', type: 'number', group: 'odds_window', label: 'Minimum Total Odds', min: 2, max: 3.99, description: 'Combined odds below this never qualify. The product rule keeps the window inside 2.00-4.00.' },
  max_total_odds: { value: '4.00', type: 'number', group: 'odds_window', label: 'Maximum Total Odds', min: 2.01, max: 4, description: 'Combined odds above this never qualify. The product rule keeps the window inside 2.00-4.00.' },
  min_single_odds: { value: '1.01', type: 'number', group: 'odds_window', label: 'Minimum Single Odds', min: 1.01, max: 2, description: 'A leg must pay more than this.' },
  max_single_odds: { value: '2.50', type: 'number', group: 'odds_window', label: 'Maximum Single Odds', min: 1.05, max: 10, description: 'An Over 1.5 price above this means the market expects few goals.' },
  odds_selection_strategy: { value: 'best_price', type: 'enum', options: ['best_price', 'preferred_bookmaker'], group: 'odds_window', label: 'Odds Selection Strategy', description: 'Which real bookmaker price is published for a fixture.' },
  odds_bookmaker_preference: { maxLength: 1000, value: 'Bet365,Pinnacle,William Hill,Unibet,bwin', type: 'string', group: 'odds_window', label: 'Preferred Bookmakers', description: 'Comma separated, used for tie-breaks and the preferred strategy.' },

  /* ---------------- filters ---------------- */
  confidence_mode: { value: 'auto', type: 'enum', options: ['auto', 'fixed'], group: 'filters', label: 'Confidence Mode', description: 'auto (default): the effective confidence gate is detected from each day\'s candidate pool, starting at 72 and lowering only as far as needed to fill the pool. fixed: min_confidence is the exact gate.' },
  min_confidence: { value: '30', type: 'number', group: 'filters', label: 'Minimum Confidence', min: 1, max: 99, description: 'In auto mode this is the hard floor (default 30): the detected gate never drops below it and candidates under it never enter the ticket builder. In fixed mode it is the exact gate.' },
  max_risk: { value: '35', type: 'number', group: 'filters', label: 'Maximum Risk', min: 1, max: 100, description: 'Candidates above this risk score are rejected.' },
  min_data_quality: { value: '60', type: 'number', group: 'filters', label: 'Minimum Data Quality', min: 1, max: 100, description: 'Minimum completeness/freshness of the real evidence.' },
  min_selections: { integer: true, value: '2', type: 'number', group: 'filters', label: 'Minimum Selections', min: 1, max: 20 },
  max_selections: { integer: true, value: '6', type: 'number', group: 'filters', label: 'Maximum Selections', min: 1, max: 20 },
  candidate_pool_size: { integer: true, value: '16', type: 'number', group: 'filters', label: 'Candidate Pool Size', min: 2, max: 40 },
  max_combinations_tested: { integer: true, value: '250000', type: 'number', group: 'filters', label: 'Maximum Combinations Tested', min: 100, max: 5000000 },
  odds_freshness_minutes: { integer: true, value: String(config.odds.freshnessMinutes), type: 'number', group: 'filters', label: 'Odds Freshness (minutes)', min: 1, max: 1440, description: 'Prices older than this are rejected as stale.' },
  odds_reverify_before_generation: { value: '1', type: 'boolean', group: 'filters', label: 'Re-verify Odds Before Generation', description: 'Pull fresh prices for the shortlist at generation time.' },

  /* ---------------- model ---------------- */
  form_window_matches: { integer: true, value: '10', type: 'number', group: 'model', label: 'Form Window (matches)', min: 3, max: 30 },
  min_form_matches: { integer: true, value: '5', type: 'number', group: 'model', label: 'Minimum Form Matches', min: 2, max: 20 },
  min_venue_form_matches: { integer: true, value: '3', type: 'number', group: 'model', label: 'Minimum Venue Form Matches', min: 1, max: 15 },
  poisson_weight: { value: '0.6', type: 'number', group: 'model', label: 'Poisson Model Weight', min: 0, max: 1 },
  history_weight: { value: '0.4', type: 'number', group: 'model', label: 'Historical Over 1.5 Weight', min: 0, max: 1 },
  h2h_weight: { value: '0.10', type: 'number', group: 'model', label: 'Head To Head Weight', min: 0, max: 0.5 },
  h2h_min_meetings: { integer: true, value: '3', type: 'number', group: 'model', label: 'Minimum H2H Meetings', min: 1, max: 10 },
  recency_weight: { value: '0.5', type: 'number', group: 'model', label: 'Recency Weight (last 5)', min: 0, max: 1 },
  injury_impact_per_player: { value: '0.015', type: 'number', group: 'model', label: 'Injury Impact Per Player', min: 0, max: 0.05 },
  injury_max_impact: { value: '0.08', type: 'number', group: 'model', label: 'Maximum Injury Impact', min: 0, max: 0.3 },
  max_days_since_last_match: { integer: true, value: '45', type: 'number', group: 'model', label: 'Maximum Days Since Last Match', min: 7, max: 365 },
  dixon_coles_rho: { value: '0', type: 'number', group: 'model', label: 'Dixon-Coles Rho', min: -0.2, max: 0.2 },
  enable_h2h_api: { value: '1', type: 'boolean', group: 'model', label: 'Fetch Head To Head From API' },
  enable_injuries_api: { value: '1', type: 'boolean', group: 'model', label: 'Fetch Injuries From API' },

  /* ---------------- scoring weights (JSON) ---------------- */
  confidence_weights: { value: JSON.stringify(confidenceDefaults), type: 'json', group: 'scoring', label: 'Confidence Weights' },
  risk_weights: { value: JSON.stringify(riskDefaults), type: 'json', group: 'scoring', label: 'Risk Weights' },
  quality_weights: { value: JSON.stringify(qualityDefaults), type: 'json', group: 'scoring', label: 'Data Quality Weights' },
  combination_weights: { value: JSON.stringify(ticketDefaults.weights), type: 'json', group: 'scoring', label: 'Combination Weights' },
  combination_leg_penalty: { value: String(ticketDefaults.legPenalty), type: 'number', group: 'scoring', label: 'Leg Penalty', min: 0, max: 25 },

  /* ---------------- correlation ---------------- */
  correlation_protection: { value: '1', type: 'boolean', group: 'correlation', label: 'Correlation Protection', description: 'ON/OFF for league, country and kickoff window caps. Same fixture/team is always blocked.' },
  max_selections_per_league: { integer: true, value: '2', type: 'number', group: 'correlation', label: 'Maximum Picks Per League', min: 1, max: 10 },
  max_selections_per_country: { integer: true, value: '3', type: 'number', group: 'correlation', label: 'Maximum Picks Per Country', min: 1, max: 15 },
  max_same_kickoff_window: { integer: true, value: '2', type: 'number', group: 'correlation', label: 'Maximum Picks Per Kickoff Window', min: 1, max: 10 },
  kickoff_window_minutes: { integer: true, value: '45', type: 'number', group: 'correlation', label: 'Kickoff Window (minutes)', min: 5, max: 240 },

  /* ---------------- sync ---------------- */
  sync_leagues: { maxLength: 2000, value: '', type: 'string', group: 'sync', label: 'Tracked League Ids', description: 'Comma separated API-Football league ids. Empty = every fixture returned for the date.' },
  sync_days_ahead: { integer: true, value: '2', type: 'number', group: 'sync', label: 'Sync Days Ahead', min: 0, max: 14 },
  sync_history_days: { integer: true, value: '25', type: 'number', group: 'sync', label: 'Sync History Days', min: 7, max: 120 },
  history_refresh_minutes: {
    integer: true,
    value: '360',
    type: 'number',
    group: 'sync',
    label: 'History Refresh (minutes)',
    min: 0,
    max: 1440,
    description: 'A history day whose stored fixtures were fetched more recently than this is not requested again — finished matches do not change. 0 = re-pull every history day on every run (spends much more of the daily request budget).',
  },
  api_quota_reserve: {
    integer: true,
    value: '25',
    type: 'number',
    group: 'sync',
    label: 'Requests Reserved For Manual Generation',
    min: 0,
    max: 500,
    description: 'Background sync pauses when the API plan has this many requests (or fewer) left today, so an administrator can still generate today\'s ticket. 0 = no reserve.',
  },
  h2h_sync_max_calls: {
    integer: true,
    value: '20',
    type: 'number',
    group: 'sync',
    label: 'Head-To-Head Requests Per Sync',
    min: 0,
    max: 200,
    description: 'Upper bound on head-to-head requests per fixtures sync. Only fixtures whose stored H2H sample is still too small are requested. 0 disables these requests.',
  },
  sync_timezone: { value: 'UTC', type: 'string', group: 'sync', label: 'Sync Timezone', required: true, maxLength: 64, description: 'IANA timezone used to choose sync calendar dates, for example UTC or Africa/Lagos. Stored timestamps remain UTC.' },
  odds_sync_max_pages: { integer: true, value: '12', type: 'number', group: 'sync', label: 'Odds Sync Max Pages', min: 1, max: 50 },

  /* ---------------- site ---------------- */
  site_name: { required: true, maxLength: 100, value: 'GoalPredict', type: 'string', group: 'site', label: 'Site Name' },
  site_tagline: { maxLength: 200, value: 'Smarter Football Picks', type: 'string', group: 'site', label: 'Tagline' },
  display_timezone: { required: true, maxLength: 64, value: 'auto', type: 'string', group: 'site', label: 'Display Timezone', description: 'Use auto for the visitor timezone, or an IANA timezone such as Africa/Lagos or UTC.' },
  results_settle_mode: { value: 'fulltime', type: 'enum', options: ['fulltime'], group: 'site', label: 'Result Settlement', description: 'Over 1.5 settles on the 90 minute score, exactly like the bookmaker market.', locked: true },
};

const LOCKED_KEYS = Object.entries(DEFINITIONS).filter(([, d]) => d.locked).map(([k]) => k);

let cache = { version: null, values: null, at: 0 };

/** Validate and serialise one value identically on reads and writes. */
function normalizeValue(key, raw) {
  const definition = DEFINITIONS[key];
  const fail = (reason, message) => ({ reason, message });
  if (definition.type === 'number') {
    if (!['number', 'string'].includes(typeof raw) || String(raw).trim() === '') {
      return fail('NOT_A_NUMBER', 'Enter a number; an empty value is not zero.');
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return fail('NOT_A_NUMBER', 'Enter a finite number.');
    if (definition.integer && !Number.isSafeInteger(n)) return fail('NOT_AN_INTEGER', 'Enter a whole number.');
    if (n < definition.min) return fail(`BELOW_MINIMUM_${definition.min}`, `Minimum: ${definition.min}.`);
    if (n > definition.max) return fail(`ABOVE_MAXIMUM_${definition.max}`, `Maximum: ${definition.max}.`);
    return { value: String(n) };
  }
  if (definition.type === 'boolean') {
    if (!['boolean', 'number', 'string'].includes(typeof raw)) return fail('INVALID_BOOLEAN', 'Choose on or off.');
    const value = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(value)) return { value: '1' };
    if (['0', 'false', 'no', 'off'].includes(value)) return { value: '0' };
    return fail('INVALID_BOOLEAN', 'Choose on or off.');
  }
  if (definition.type === 'json') {
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
      return fail('INVALID_JSON', 'Enter valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('INVALID_WEIGHTS', 'Weights must be a JSON object with named numeric values.');
    }
    const baseline = JSON.parse(definition.value);
    for (const [name, value] of Object.entries(parsed)) {
      if (!Object.prototype.hasOwnProperty.call(baseline, name)) return fail('UNKNOWN_WEIGHT', `Unknown weight: ${name}.`);
      const max = key !== 'confidence_weights' || ['modelWeight', 'marketWeight', 'disagreementThreshold', 'capSlope'].includes(name)
        ? 1 : name === 'disagreementPenaltyScale' ? 1000 : 100;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (name === 'absoluteMax' && value < 1)) {
        return fail('INVALID_WEIGHT', `${name} must be a number between ${name === 'absoluteMax' ? 1 : 0} and ${max}.`);
      }
    }
    const merged = { ...baseline, ...parsed };
    const total = key === 'confidence_weights' ? merged.modelWeight + merged.marketWeight : Object.values(merged).reduce((sum, value) => sum + value, 0);
    if (total <= 0) return fail('ZERO_WEIGHT_TOTAL', 'At least one scoring weight must be greater than zero.');
    return { value: JSON.stringify(parsed) };
  }
  if (typeof raw !== 'string') return fail('NOT_A_STRING', 'Enter text.');
  const value = raw.trim();
  if (definition.type === 'enum') {
    return definition.options.includes(value) ? { value } : fail('INVALID_OPTION', 'Choose one of the listed options.');
  }
  if (definition.required && !value) return fail('REQUIRED', 'This value is required.');
  if (value.length > (definition.maxLength || 200)) return fail('TOO_LONG', `Use at most ${definition.maxLength || 200} characters.`);
  if (/[\u0000-\u001F\u007F]/.test(value)) return fail('INVALID_TEXT', 'Control characters are not allowed.');
  if ((key === 'sync_timezone' || key === 'display_timezone') && !(key === 'display_timezone' && value === 'auto') && !time.isValidTimeZone(value)) {
    return fail('INVALID_TIMEZONE', 'Use a valid timezone, for example UTC or Africa/Lagos.' + (key === 'display_timezone' ? ' auto uses the visitor timezone.' : ''));
  }
  if (key === 'sync_leagues' && value) {
    const parts = value.split(',').map((part) => part.trim());
    if (parts.some((part) => !/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) <= 0)) {
      return fail('INVALID_LEAGUE_IDS', 'Use positive league IDs separated by commas, or leave empty for all leagues.');
    }
    return { value: [...new Set(parts.map(Number))].join(',') };
  }
  return { value };
}

function castValue(definition, raw) {
  const value = raw === null || raw === undefined ? definition.value : raw;
  if (definition.type === 'number') return Number(value);
  if (definition.type === 'boolean') return String(value) === '1';
  if (definition.type === 'json') return JSON.parse(value);
  return String(value);
}

/** Related values must agree, even when only one of them is being edited. */
function crossChecks(s) {
  return [
    { invalid: s.min_total_odds >= s.max_total_odds, keys: ['min_total_odds', 'max_total_odds'], reason: 'ODDS_WINDOW_INVALID', message: 'Minimum total odds must be less than maximum total odds.' },
    { invalid: s.min_single_odds >= s.max_single_odds, keys: ['min_single_odds', 'max_single_odds'], reason: 'SINGLE_ODDS_RANGE_INVALID', message: 'Minimum single odds must be less than maximum single odds.' },
    { invalid: s.min_selections > s.max_selections, keys: ['min_selections', 'max_selections'], reason: 'SELECTION_RANGE_INVALID', message: 'Minimum selections cannot exceed maximum selections.' },
    { invalid: s.min_selections > s.candidate_pool_size, keys: ['min_selections', 'candidate_pool_size'], reason: 'CANDIDATE_POOL_TOO_SMALL', message: 'The candidate pool must hold at least the minimum number of selections.' },
    { invalid: s.min_form_matches > s.form_window_matches, keys: ['min_form_matches', 'form_window_matches'], reason: 'FORM_WINDOW_TOO_SMALL', message: 'The form window must hold at least the minimum form sample.' },
    { invalid: s.min_venue_form_matches > s.form_window_matches, keys: ['min_venue_form_matches', 'form_window_matches'], reason: 'VENUE_WINDOW_TOO_SMALL', message: 'The form window must hold at least the minimum venue sample.' },
    { invalid: s.poisson_weight + s.history_weight <= 0, keys: ['poisson_weight', 'history_weight'], reason: 'ZERO_MODEL_WEIGHTS', message: 'Poisson and historical weights cannot both be zero.' },
  ];
}

/** Invalid legacy values fall back safely and are flagged on the settings screen. */
function resolveRows(rows) {
  const values = defaults();
  const issues = new Map();
  for (const row of rows) {
    const key = row.setting_key;
    if (!Object.prototype.hasOwnProperty.call(DEFINITIONS, key) || DEFINITIONS[key].locked) continue;
    const result = normalizeValue(key, row.setting_value);
    if (result.reason) issues.set(key, result.message);
    else values[key] = castValue(DEFINITIONS[key], result.value);
  }
  // Restoring one field can expose a second relationship. Repeat until all
  // relationships hold (the code defaults themselves are always consistent).
  let invalid;
  while ((invalid = crossChecks(values).filter((check) => check.invalid)).length) {
    for (const check of invalid) {
      for (const key of check.keys) {
        values[key] = castValue(DEFINITIONS[key], DEFINITIONS[key].value);
        issues.set(key, check.message);
      }
    }
  }
  return { values, issues };
}

/** Defaults only (used when the DB is unreachable). */
function defaults() {
  const out = {};
  for (const [key, definition] of Object.entries(DEFINITIONS)) out[key] = castValue(definition, definition.value);
  return out;
}

/** Ensure every definition exists in the table (idempotent). */
async function ensureDefaults() {
  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await db.getSetting(key);
    if (existing) {
      // keep locked settings pinned to their safe value
      if (definition.locked && String(existing.setting_value) !== String(definition.value)) {
        // eslint-disable-next-line no-await-in-loop
        await db.updateSettingValue(key, definition.value, null);
        log.warn('locked setting restored to its safe value', { key });
      }
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await db.upsertSetting(
      {
        key,
        value: definition.value,
        type: definition.type,
        group: definition.group,
        label: definition.label || key,
        description: definition.description || null,
        isLocked: Boolean(definition.locked),
        min: definition.min,
        max: definition.max,
      },
      null
    );
  }
  cache = { version: null, values: null, at: 0 };
}

/**
 * Effective settings, typed and cached for 30s (invalidated on version change).
 * @param {boolean} force bypass cache
 */
async function getEffectiveSettings(force = false) {
  if (!force && cache.values && Date.now() - cache.at < 30000) return cache.values;
  let rows = [];
  try {
    rows = await db.getAllSettings();
  } catch (err) {
    log.error('settings unavailable, falling back to defaults', { message: err.message });
    return { ...defaults(), __source: 'defaults', __error: err.message };
  }
  const { values } = resolveRows(rows);

  cache = { version: rows.length, values: { ...values, __source: 'database' }, at: Date.now() };
  return cache.values;
}

/**
 * Pure mapper: effective settings -> the exact shape the prediction engine
 * expects. Exported so the engine can be tested without a database.
 *
 * The locked product rules are pinned here as well as in `getEffectiveSettings`,
 * so no caller — including a hand built settings object — can ever run the
 * engine on a different market or with automatic generation enabled.
 */
function toEngineSettings(effective) {
  const s = { ...defaults(), ...effective };
  // the odds window is a product rule: it can never be widened past 2.00-4.00
  const minTotal = Math.max(Number(s.min_total_odds) || config.odds.minTotalOdds, config.odds.minTotalOdds);
  const maxTotal = Math.min(Number(s.max_total_odds) || config.odds.maxTotalOdds, config.odds.maxTotalOdds);
  return {
    marketKey: DEFINITIONS.market_key.value,
    marketLabel: DEFINITIONS.market_label.value,
    minTotalOdds: minTotal >= maxTotal ? config.odds.minTotalOdds : minTotal,
    maxTotalOdds: minTotal >= maxTotal ? config.odds.maxTotalOdds : maxTotal,
    minSingleOdds: s.min_single_odds,
    maxSingleOdds: s.max_single_odds,
    oddsSelectionStrategy: s.odds_selection_strategy,
    oddsBookmakerPreference: s.odds_bookmaker_preference,
    oddsFreshnessMinutes: s.odds_freshness_minutes,
    reverifyOddsBeforeGeneration: s.odds_reverify_before_generation,
    confidenceMode: s.confidence_mode,
    minConfidence: s.min_confidence,
    maxRisk: s.max_risk,
    minDataQuality: s.min_data_quality,
    minSelections: s.min_selections,
    maxSelections: s.max_selections,
    candidatePoolSize: s.candidate_pool_size,
    maxCombinationsTested: s.max_combinations_tested,
    formWindowMatches: s.form_window_matches,
    minFormMatches: s.min_form_matches,
    minVenueFormMatches: s.min_venue_form_matches,
    poissonWeight: s.poisson_weight,
    historyWeight: s.history_weight,
    h2hWeight: s.h2h_weight,
    h2hMinMeetings: s.h2h_min_meetings,
    recencyWeight: s.recency_weight,
    injuryImpactPerPlayer: s.injury_impact_per_player,
    injuryMaxImpact: s.injury_max_impact,
    maxDaysSinceLastMatch: s.max_days_since_last_match,
    dixonColesRho: s.dixon_coles_rho,
    confidence: s.confidence_weights,
    riskWeights: s.risk_weights,
    qualityWeights: s.quality_weights,
    combinationWeights: s.combination_weights,
    legPenalty: s.combination_leg_penalty,
    correlationProtection: s.correlation_protection,
    maxSelectionsPerLeague: s.max_selections_per_league,
    maxSelectionsPerCountry: s.max_selections_per_country,
    maxSameKickoffWindow: s.max_same_kickoff_window,
    kickoffWindowMinutes: s.kickoff_window_minutes,
    syncLeagues: String(s.sync_leagues || '')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0),
    syncDaysAhead: s.sync_days_ahead,
    syncHistoryDays: s.sync_history_days,
    syncTimezone: s.sync_timezone,
    historyRefreshMinutes: s.history_refresh_minutes,
    apiQuotaReserve: s.api_quota_reserve,
    h2hSyncMaxCalls: s.h2h_sync_max_calls,
    oddsSyncMaxPages: s.odds_sync_max_pages,
    enableH2hApi: s.enable_h2h_api,
    enableInjuriesApi: s.enable_injuries_api,
    siteName: s.site_name,
    siteTagline: s.site_tagline,
    displayTimezone: s.display_timezone,
    resultsSettleMode: DEFINITIONS.results_settle_mode.value,
    autoTicketGeneration: false, // hard rule: never automatic
  };
}

/** Settings in the exact shape the prediction engine expects. */
async function getEngineSettings(force = false) {
  return toEngineSettings(await getEffectiveSettings(force));
}

/** Full list for the admin settings screen (with metadata). */
async function listSettingsForAdmin() {
  const rows = await db.getAllSettings();
  const byKey = new Map(rows.map((r) => [r.setting_key, r]));
  const { issues } = resolveRows(rows);
  return Object.entries(DEFINITIONS).map(([key, definition]) => {
    const row = byKey.get(key);
    return {
      key,
      label: definition.label || key,
      description: definition.description || null,
      group: definition.group,
      type: definition.type,
      options: definition.options || null,
      min: definition.min ?? null,
      max: definition.max ?? null,
      locked: Boolean(definition.locked),
      integer: Boolean(definition.integer),
      required: definition.type === 'number' || definition.type === 'json' || Boolean(definition.required),
      maxLength: definition.maxLength || (definition.type === 'string' ? 200 : null),
      value: definition.locked || !row || issues.has(key) ? definition.value : normalizeValue(key, row.setting_value).value,
      warning: issues.has(key) ? `${issues.get(key)} The safe default is shown; save to repair the stored value.` : null,
      needsRepair: issues.has(key),
      updatedAt: row ? row.updated_at : null,
    };
  });
}

/**
 * Update settings from the admin dashboard.
 * Locked keys, out-of-range values and market changes are rejected.
 */
async function updateSettings(patch, adminId = null) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw AppError.badRequest('A settings object is required');
  if (!Object.keys(patch).length) throw AppError.badRequest('No settings supplied', 'EMPTY_PATCH');

  // Lock the current settings while validating related fields, then commit
  // the accepted subset together. A missing/new setting is INSERTed rather
  // than reporting success after an UPDATE that touched zero rows.
  const result = await db.withSettingsTransaction(async ({ rows, upsert }) => {
    const applied = [];
    const rejected = [];
    const proposed = {};
    const current = resolveRows(rows).values;
    for (const [key, raw] of Object.entries(patch)) {
      if (!Object.prototype.hasOwnProperty.call(DEFINITIONS, key)) {
        rejected.push({ key, reason: 'UNKNOWN_SETTING', message: 'Unknown setting.' });
      } else if (DEFINITIONS[key].locked) {
        rejected.push({ key, reason: 'LOCKED_SETTING', message: 'This product rule is locked.' });
      } else {
        const normalized = normalizeValue(key, raw);
        if (normalized.reason) rejected.push({ key, ...normalized });
        else proposed[key] = normalized.value;
      }
    }

    const merge = () => {
      const merged = { ...current };
      for (const [key, stored] of Object.entries(proposed)) merged[key] = castValue(DEFINITIONS[key], stored);
      return merged;
    };
    // Re-evaluate after rejections: rolling back one proposed value can make
    // another previously-valid relationship invalid.
    let invalid;
    while ((invalid = crossChecks(merge()).filter((check) => check.invalid)).length) {
      for (const check of invalid) {
        for (const key of check.keys) {
          if (!Object.prototype.hasOwnProperty.call(proposed, key)) continue;
          delete proposed[key];
          rejected.push({ key, reason: check.reason, message: check.message });
        }
      }
    }

    for (const [key, value] of Object.entries(proposed)) {
      const d = DEFINITIONS[key];
      await upsert({ key, value, type: d.type, group: d.group, label: d.label, description: d.description, isLocked: false, min: d.min, max: d.max }, adminId);
      applied.push({ key, value });
    }
    return { applied, rejected, settings: { ...merge(), __source: 'database' } };
  });
  invalidateCache();
  return result;
}

function invalidateCache() {
  cache = { version: null, values: null, at: 0 };
}

module.exports = {
  DEFINITIONS,
  LOCKED_KEYS,
  defaults,
  toEngineSettings,
  ensureDefaults,
  getEffectiveSettings,
  getEngineSettings,
  listSettingsForAdmin,
  updateSettings,
  invalidateCache,
};
