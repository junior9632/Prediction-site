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
  odds_bookmaker_preference: { value: 'Bet365,Pinnacle,William Hill,Unibet,bwin', type: 'string', group: 'odds_window', label: 'Preferred Bookmakers', description: 'Comma separated, used for tie-breaks and the preferred strategy.' },

  /* ---------------- filters ---------------- */
  min_confidence: { value: '72', type: 'number', group: 'filters', label: 'Minimum Confidence', min: 1, max: 99, description: 'Candidates below this never enter the ticket builder.' },
  max_risk: { value: '35', type: 'number', group: 'filters', label: 'Maximum Risk', min: 1, max: 100, description: 'Candidates above this risk score are rejected.' },
  min_data_quality: { value: '60', type: 'number', group: 'filters', label: 'Minimum Data Quality', min: 1, max: 100, description: 'Minimum completeness/freshness of the real evidence.' },
  min_selections: { value: '2', type: 'number', group: 'filters', label: 'Minimum Selections', min: 1, max: 20 },
  max_selections: { value: '6', type: 'number', group: 'filters', label: 'Maximum Selections', min: 1, max: 20 },
  candidate_pool_size: { value: '16', type: 'number', group: 'filters', label: 'Candidate Pool Size', min: 2, max: 40 },
  max_combinations_tested: { value: '250000', type: 'number', group: 'filters', label: 'Maximum Combinations Tested', min: 100, max: 5000000 },
  odds_freshness_minutes: { value: String(config.odds.freshnessMinutes), type: 'number', group: 'filters', label: 'Odds Freshness (minutes)', min: 1, max: 1440, description: 'Prices older than this are rejected as stale.' },
  odds_reverify_before_generation: { value: '1', type: 'boolean', group: 'filters', label: 'Re-verify Odds Before Generation', description: 'Pull fresh prices for the shortlist at generation time.' },

  /* ---------------- model ---------------- */
  form_window_matches: { value: '10', type: 'number', group: 'model', label: 'Form Window (matches)', min: 3, max: 30 },
  min_form_matches: { value: '5', type: 'number', group: 'model', label: 'Minimum Form Matches', min: 2, max: 20 },
  min_venue_form_matches: { value: '3', type: 'number', group: 'model', label: 'Minimum Venue Form Matches', min: 1, max: 15 },
  poisson_weight: { value: '0.6', type: 'number', group: 'model', label: 'Poisson Model Weight', min: 0, max: 1 },
  history_weight: { value: '0.4', type: 'number', group: 'model', label: 'Historical Over 1.5 Weight', min: 0, max: 1 },
  h2h_weight: { value: '0.10', type: 'number', group: 'model', label: 'Head To Head Weight', min: 0, max: 0.5 },
  h2h_min_meetings: { value: '3', type: 'number', group: 'model', label: 'Minimum H2H Meetings', min: 1, max: 10 },
  recency_weight: { value: '0.5', type: 'number', group: 'model', label: 'Recency Weight (last 5)', min: 0, max: 1 },
  injury_impact_per_player: { value: '0.015', type: 'number', group: 'model', label: 'Injury Impact Per Player', min: 0, max: 0.05 },
  injury_max_impact: { value: '0.08', type: 'number', group: 'model', label: 'Maximum Injury Impact', min: 0, max: 0.3 },
  max_days_since_last_match: { value: '45', type: 'number', group: 'model', label: 'Maximum Days Since Last Match', min: 7, max: 365 },
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
  max_selections_per_league: { value: '2', type: 'number', group: 'correlation', label: 'Maximum Picks Per League', min: 1, max: 10 },
  max_selections_per_country: { value: '3', type: 'number', group: 'correlation', label: 'Maximum Picks Per Country', min: 1, max: 15 },
  max_same_kickoff_window: { value: '2', type: 'number', group: 'correlation', label: 'Maximum Picks Per Kickoff Window', min: 1, max: 10 },
  kickoff_window_minutes: { value: '45', type: 'number', group: 'correlation', label: 'Kickoff Window (minutes)', min: 5, max: 240 },

  /* ---------------- sync ---------------- */
  sync_leagues: { value: '', type: 'string', group: 'sync', label: 'Tracked League Ids', description: 'Comma separated API-Football league ids. Empty = every fixture returned for the date.' },
  sync_days_ahead: { value: '2', type: 'number', group: 'sync', label: 'Sync Days Ahead', min: 0, max: 14 },
  sync_history_days: { value: '25', type: 'number', group: 'sync', label: 'Sync History Days', min: 7, max: 120 },
  sync_timezone: { value: 'UTC', type: 'string', group: 'sync', label: 'Sync Timezone' },
  odds_sync_max_pages: { value: '12', type: 'number', group: 'sync', label: 'Odds Sync Max Pages', min: 1, max: 50 },

  /* ---------------- site ---------------- */
  site_name: { value: 'GoalPredict', type: 'string', group: 'site', label: 'Site Name' },
  site_tagline: { value: 'Smarter Football Picks', type: 'string', group: 'site', label: 'Tagline' },
  display_timezone: { value: 'auto', type: 'string', group: 'site', label: 'Display Timezone', description: '"auto" renders kickoff times in the visitor timezone.' },
  results_settle_mode: { value: 'fulltime', type: 'enum', options: ['fulltime'], group: 'site', label: 'Result Settlement', description: 'Over 1.5 settles on the 90 minute score, exactly like the bookmaker market.', locked: true },
};

const LOCKED_KEYS = Object.entries(DEFINITIONS).filter(([, d]) => d.locked).map(([k]) => k);

let cache = { version: null, values: null, at: 0 };

function castValue(definition, raw) {
  if (raw === null || raw === undefined) return definition.value;
  switch (definition.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return Number(definition.value);
      if (definition.min !== undefined && n < definition.min) return Number(definition.value);
      if (definition.max !== undefined && n > definition.max) return Number(definition.value);
      return n;
    }
    case 'boolean':
      return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
    case 'json':
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return parsed && typeof parsed === 'object' ? parsed : JSON.parse(definition.value);
      } catch (_) {
        return JSON.parse(definition.value);
      }
    case 'enum':
      return definition.options && definition.options.includes(String(raw)) ? String(raw) : definition.value;
    default:
      return String(raw);
  }
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
  const values = defaults();
  for (const row of rows) {
    const definition = DEFINITIONS[row.setting_key];
    if (!definition) continue;
    if (definition.locked) continue; // locked values are never read from the table
    values[row.setting_key] = castValue(definition, row.setting_value);
  }
  // locked values always come from the code definition
  for (const key of LOCKED_KEYS) values[key] = castValue(DEFINITIONS[key], DEFINITIONS[key].value);

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
  const s = effective || defaults();
  // the odds window is a product rule: it can never be widened past 2.00-4.00
  const minTotal = Math.max(Number(s.min_total_odds) || config.odds.minTotalOdds, config.odds.minTotalOdds);
  const maxTotal = Math.min(Number(s.max_total_odds) || config.odds.maxTotalOdds, config.odds.maxTotalOdds);
  return {
    marketKey: DEFINITIONS.market_key.value,
    marketLabel: DEFINITIONS.market_label.value,
    minTotalOdds: minTotal > maxTotal ? config.odds.minTotalOdds : minTotal,
    maxTotalOdds: minTotal > maxTotal ? config.odds.maxTotalOdds : maxTotal,
    minSingleOdds: s.min_single_odds,
    maxSingleOdds: s.max_single_odds,
    oddsSelectionStrategy: s.odds_selection_strategy,
    oddsBookmakerPreference: s.odds_bookmaker_preference,
    oddsFreshnessMinutes: s.odds_freshness_minutes,
    reverifyOddsBeforeGeneration: s.odds_reverify_before_generation,
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
    oddsSyncMaxPages: s.odds_sync_max_pages,
    enableH2hApi: s.enable_h2h_api,
    enableInjuriesApi: s.enable_injuries_api,
    siteName: s.site_name,
    siteTagline: s.site_tagline,
    displayTimezone: s.display_timezone,
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
      value: row ? row.setting_value : definition.value,
      updatedAt: row ? row.updated_at : null,
    };
  });
}

/**
 * Update settings from the admin dashboard.
 * Locked keys, out-of-range values and market changes are rejected.
 */
async function updateSettings(patch, adminId = null) {
  if (!patch || typeof patch !== 'object') throw AppError.badRequest('A settings object is required');
  const applied = [];
  const rejected = [];
  const proposed = {};
  const current = await getEffectiveSettings(true);

  for (const [key, rawValue] of Object.entries(patch)) {
    const definition = DEFINITIONS[key];
    if (!definition) {
      rejected.push({ key, reason: 'UNKNOWN_SETTING' });
      continue;
    }
    if (definition.locked) {
      rejected.push({ key, reason: 'LOCKED_SETTING' });
      continue;
    }
    if (definition.type === 'number') {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) {
        rejected.push({ key, reason: 'NOT_A_NUMBER' });
        continue;
      }
      if (definition.min !== undefined && n < definition.min) {
        rejected.push({ key, reason: `BELOW_MINIMUM_${definition.min}` });
        continue;
      }
      if (definition.max !== undefined && n > definition.max) {
        rejected.push({ key, reason: `ABOVE_MAXIMUM_${definition.max}` });
        continue;
      }
    }
    if (definition.type === 'enum' && !definition.options.includes(String(rawValue))) {
      rejected.push({ key, reason: 'INVALID_OPTION' });
      continue;
    }
    if (definition.type === 'json') {
      try {
        JSON.parse(typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue));
      } catch (_) {
        rejected.push({ key, reason: 'INVALID_JSON' });
        continue;
      }
    }

    const stored =
      definition.type === 'boolean'
        ? ['1', 'true', 'yes', 'on'].includes(String(rawValue).toLowerCase())
          ? '1'
          : '0'
        : String(rawValue);
    proposed[key] = stored;
  }

  /* ---- cross-field rules are checked BEFORE anything is written ---- */
  const merged = { ...current };
  for (const [key, stored] of Object.entries(proposed)) merged[key] = castValue(DEFINITIONS[key], stored);

  const crossChecks = [
    {
      invalid: Number(merged.min_total_odds) >= Number(merged.max_total_odds),
      keys: ['min_total_odds', 'max_total_odds'],
      reason: 'ODDS_WINDOW_INVALID',
    },
    {
      invalid: Number(merged.min_selections) > Number(merged.max_selections),
      keys: ['min_selections', 'max_selections'],
      reason: 'SELECTION_RANGE_INVALID',
    },
    {
      invalid: Number(merged.min_single_odds) >= Number(merged.max_single_odds),
      keys: ['min_single_odds', 'max_single_odds'],
      reason: 'SINGLE_ODDS_RANGE_INVALID',
    },
  ];
  for (const check of crossChecks) {
    if (!check.invalid) continue;
    for (const key of check.keys) {
      if (proposed[key] === undefined) continue;
      delete proposed[key];
      rejected.push({ key, reason: check.reason });
    }
  }

  for (const [key, stored] of Object.entries(proposed)) {
    // eslint-disable-next-line no-await-in-loop
    await db.updateSettingValue(key, stored, adminId);
    applied.push({ key, value: stored });
  }

  cache = { version: null, values: null, at: 0 };
  return { applied, rejected, settings: await getEffectiveSettings(true) };
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
