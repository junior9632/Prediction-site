'use strict';

/**
 * PREDICTION PIPELINE (pure orchestration).
 *
 * fixtures + verified odds + real statistics  ->  predictions  ->  candidates
 *   -> combination engine -> QUALIFIED ticket or NO QUALIFYING TICKET
 *
 * This module performs no I/O of its own: the caller supplies the fixtures
 * and a `loadContext` function, which keeps the whole decision process
 * unit-testable and guarantees the numbers come from the data layer.
 */

const over15 = require('./over15');
const confidenceModule = require('./confidence');
const riskModule = require('./risk');
const qualityModule = require('./quality');
const ticketBuilder = require('./ticketBuilder');
const correlation = require('./correlation');
const decimal = require('../utils/decimal');
const numbers = require('../utils/numbers');
const time = require('../utils/time');

const PROGRESS_STEPS = [
  'LOADING_FIXTURES',
  'LOADING_VERIFIED_ODDS',
  'FILTERING_OVER15_MARKETS',
  'CHECKING_DATA_QUALITY',
  'ANALYZING_MATCHES',
  'CALCULATING_CONFIDENCE',
  'FILTERING_RISK',
  'BUILDING_COMBINATIONS',
  'CHECKING_CORRELATION',
  'VALIDATING_FINAL_ODDS',
  'CREATING_TICKET',
];

const PROGRESS_LABELS = {
  LOADING_FIXTURES: 'Loading fixtures...',
  LOADING_VERIFIED_ODDS: 'Loading verified odds...',
  FILTERING_OVER15_MARKETS: 'Filtering Over 1.5 markets...',
  CHECKING_DATA_QUALITY: 'Checking data quality...',
  ANALYZING_MATCHES: 'Analyzing matches...',
  CALCULATING_CONFIDENCE: 'Calculating confidence...',
  FILTERING_RISK: 'Filtering risk...',
  BUILDING_COMBINATIONS: 'Building combinations...',
  CHECKING_CORRELATION: 'Checking correlation...',
  VALIDATING_FINAL_ODDS: 'Validating final odds...',
  CREATING_TICKET: 'Creating ticket...',
};

function emptyCounters() {
  return {
    fixturesScanned: 0,
    over15Candidates: 0,
    verifiedOdds: 0,
    rejectedMatches: 0,
    rejectedNoOdds: 0,
    rejectedFixtureState: 0,
    rejectedInsufficientData: 0,
    rejectedStaleOdds: 0,
    rejectedLowQuality: 0,
    rejectedLowConfidence: 0,
    rejectedHighRisk: 0,
    confidenceQualified: 0,
    riskQualified: 0,
    qualityQualified: 0,
    correlationRejected: 0,
    finalCandidates: 0,
    combinationsTested: 0,
    qualifiedCombinations: 0,
    selectedPicks: 0,
  };
}

/** Map a DB fixture row to the compact shape used by the engine. */
function normalizeFixtureRow(row) {
  return {
    id: Number(row.id),
    kickoffAt: row.kickoff_at || row.kickoffAt,
    statusShort: row.status_short || row.statusShort,
    statusLong: row.status_long || row.statusLong,
    leagueId: Number(row.league_id ?? row.leagueId ?? 0) || null,
    leagueName: row.league_name || row.leagueName || null,
    leagueCountry: row.league_country || row.leagueCountry || null,
    leagueLogo: row.league_logo || row.leagueLogo || null,
    homeTeamId: Number(row.home_team_id ?? row.homeTeamId ?? 0) || null,
    awayTeamId: Number(row.away_team_id ?? row.awayTeamId ?? 0) || null,
    homeTeamName: row.home_team_name || row.homeTeamName || null,
    awayTeamName: row.away_team_name || row.awayTeamName || null,
    homeTeamLogo: row.home_logo || row.homeTeamLogo || null,
    awayTeamLogo: row.away_logo || row.awayTeamLogo || null,
    isPlayable: row.is_playable === undefined ? undefined : Number(row.is_playable) === 1,
    isFinished: row.is_finished === undefined ? undefined : Number(row.is_finished) === 1,
    fetchedAt: row.fetched_at || row.fetchedAt || null,
  };
}

/**
 * Analyse one fixture end to end.
 * @returns {object} prediction record (never persisted here)
 */
function analyzeFixture({ fixture, odds, context, settings, now }) {
  const base = {
    fixtureId: fixture.id,
    kickoffAt: fixture.kickoffAt,
    leagueId: fixture.leagueId,
    leagueName: fixture.leagueName,
    leagueCountry: fixture.leagueCountry,
    homeTeamId: fixture.homeTeamId,
    awayTeamId: fixture.awayTeamId,
    homeTeamName: fixture.homeTeamName,
    awayTeamName: fixture.awayTeamName,
    marketKey: 'over_1_5',
    marketLabel: 'Over 1.5 Goals',
    odds: odds || null,
  };

  const rejected = (reason, extra = {}) => ({
    ...base,
    isEligible: false,
    rejectReason: reason,
    confidence: null,
    qualityScore: null,
    riskScore: null,
    modelProbability: null,
    marketProbability: null,
    dataQuality: null,
    analysis: { reason, ...extra },
  });

  if (!odds || !odds.oddScaled) {
    return rejected(over15.REJECT.NO_OVER15_ODDS, { note: 'no verified Over 1.5 price from the API' });
  }

  const model = over15.analyze({ fixture, odds, settings, now, ...(context || {}) });
  if (!model.eligible) return rejected(model.rejectReason, model.detail || {});

  const quality = qualityModule.computeDataQuality(model, { ...(context || {}), odds, fixture, settings, now });
  const confidence = confidenceModule.computeConfidence({
    modelProbability: model.modelProbability,
    marketProbability: model.marketProbability,
    dataQuality: quality.dataQuality,
    features: model.features,
    formWindowMatches: settings.formWindowMatches,
    minVenueFormMatches: settings.minVenueFormMatches,
    settings: settings.confidence || {},
  });
  const risk = riskModule.computeRisk(model, { ...(context || {}), odds, fixture, settings, now });

  return {
    ...base,
    isEligible: true,
    rejectReason: null,
    confidence: confidence.confidence,
    qualityScore: quality.dataQuality,
    riskScore: risk.riskScore,
    riskLevel: risk.level,
    modelProbability: model.modelProbability,
    poissonProbability: model.poissonProbability,
    historyProbability: model.historyProbability,
    marketProbability: model.marketProbability,
    baseProbability: confidence.baseProbability,
    expectedGoalsHome: model.expectedGoalsHome,
    expectedGoalsAway: model.expectedGoalsAway,
    expectedTotalGoals: model.expectedTotalGoals,
    dataQuality: quality.dataQuality,
    features: model.features,
    confidenceComponents: confidence.components,
    riskComponents: risk.components,
    qualityComponents: quality.components,
    qualityFlags: quality.flags,
    analysis: model.features,
  };
}

/**
 * Run the complete generation pipeline.
 *
 * @param {object} params
 * @param {Array}  params.fixtures        DB rows (or normalised fixtures)
 * @param {Map|object} params.oddsByFixture fixtureId -> selected verified price
 * @param {Function} params.loadContext   async (fixture) => {form, leagueEnv, h2h, injuries}
 * @param {object} params.settings        effective settings
 * @param {Date}   params.now
 * @param {Function} [params.onProgress]  (stepKey, label, detail) => void
 */
async function runPipeline(params) {
  const { fixtures = [], oddsByFixture = new Map(), settings = {}, now = new Date() } = params;
  const loadContext = params.loadContext || (async () => ({}));
  const onProgress = typeof params.onProgress === 'function' ? params.onProgress : () => {};
  const counters = emptyCounters();

  const oddsMap = oddsByFixture instanceof Map ? oddsByFixture : new Map(Object.entries(oddsByFixture || {}));
  const normalized = fixtures.map(normalizeFixtureRow);

  onProgress('LOADING_FIXTURES', PROGRESS_LABELS.LOADING_FIXTURES, { fixtures: normalized.length });
  counters.fixturesScanned = normalized.length;

  onProgress('LOADING_VERIFIED_ODDS', PROGRESS_LABELS.LOADING_VERIFIED_ODDS, { fixturesWithOdds: oddsMap.size });
  for (const [, price] of oddsMap.entries()) {
    counters.verifiedOdds += Number(price.bookmakersOffering || price.alternativesCount + 1 || 1);
  }

  onProgress('FILTERING_OVER15_MARKETS', PROGRESS_LABELS.FILTERING_OVER15_MARKETS, {});

  const predictions = [];
  const candidates = [];

  for (const fixture of normalized) {
    const odds = oddsMap.get(Number(fixture.id)) || oddsMap.get(String(fixture.id)) || null;
    if (odds) counters.over15Candidates += 1;

    // fixture state gate (already validated with the odds, re-checked here)
    if (fixture.isPlayable === false || fixture.isFinished === true) {
      predictions.push({
        fixtureId: fixture.id,
        isEligible: false,
        rejectReason: 'FIXTURE_NOT_PLAYABLE',
        kickoffAt: fixture.kickoffAt,
        leagueName: fixture.leagueName,
        homeTeamName: fixture.homeTeamName,
        awayTeamName: fixture.awayTeamName,
      });
      counters.rejectedMatches += 1;
      counters.rejectedFixtureState += 1;
      continue;
    }

    let context = {};
    try {
      // eslint-disable-next-line no-await-in-loop
      context = (await loadContext(fixture)) || {};
    } catch (err) {
      context = { error: err.message };
    }

    // eslint-disable-next-line no-await-in-loop
    const prediction = analyzeFixture({ fixture, odds, context, settings, now });
    predictions.push(prediction);

    if (!prediction.isEligible) {
      counters.rejectedMatches += 1;
      switch (prediction.rejectReason) {
        case over15.REJECT.NO_OVER15_ODDS:
          counters.rejectedNoOdds += 1;
          break;
        case over15.REJECT.FIXTURE_STARTED:
        case over15.REJECT.FIXTURE_NOT_PLAYABLE:
          counters.rejectedFixtureState += 1;
          break;
        case over15.REJECT.INSUFFICIENT_DATA:
          counters.rejectedInsufficientData += 1;
          break;
        case 'ODDS_STALE':
          counters.rejectedStaleOdds += 1;
          break;
        default:
          counters.rejectedInsufficientData += 1;
      }
      continue;
    }

    onProgress('CHECKING_DATA_QUALITY', PROGRESS_LABELS.CHECKING_DATA_QUALITY, { fixtureId: fixture.id });
    const minQuality = Number(settings.minDataQuality ?? 60);
    if (Number(prediction.qualityScore) < minQuality) {
      prediction.isEligible = false;
      prediction.rejectReason = 'LOW_QUALITY';
      counters.rejectedMatches += 1;
      counters.rejectedLowQuality += 1;
      continue;
    }
    counters.qualityQualified += 1;

    onProgress('CALCULATING_CONFIDENCE', PROGRESS_LABELS.CALCULATING_CONFIDENCE, { fixtureId: fixture.id });
    const minConfidence = Number(settings.minConfidence ?? 72);
    if (Number(prediction.confidence) < minConfidence) {
      prediction.isEligible = false;
      prediction.rejectReason = 'LOW_CONFIDENCE';
      counters.rejectedMatches += 1;
      counters.rejectedLowConfidence += 1;
      continue;
    }
    counters.confidenceQualified += 1;

    onProgress('FILTERING_RISK', PROGRESS_LABELS.FILTERING_RISK, { fixtureId: fixture.id });
    const maxRisk = Number(settings.maxRisk ?? 35);
    if (Number(prediction.riskScore) > maxRisk) {
      prediction.isEligible = false;
      prediction.rejectReason = 'HIGH_RISK';
      counters.rejectedMatches += 1;
      counters.rejectedHighRisk += 1;
      continue;
    }
    counters.riskQualified += 1;

    candidates.push({
      fixtureId: fixture.id,
      predictionId: prediction.predictionId || null,
      leagueId: fixture.leagueId,
      leagueName: fixture.leagueName,
      leagueCountry: fixture.leagueCountry,
      leagueLogo: fixture.leagueLogo,
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
      homeTeamName: fixture.homeTeamName,
      awayTeamName: fixture.awayTeamName,
      homeTeamLogo: fixture.homeTeamLogo,
      awayTeamLogo: fixture.awayTeamLogo,
      kickoffAt: fixture.kickoffAt,
      odds: prediction.odds,
      confidence: prediction.confidence,
      qualityScore: prediction.qualityScore,
      riskScore: prediction.riskScore,
      probability: prediction.baseProbability ?? prediction.modelProbability,
      marketProbability: prediction.marketProbability,
      modelProbability: prediction.modelProbability,
      expectedTotalGoals: prediction.expectedTotalGoals,
      strength: ticketBuilder.candidateStrength({
        confidence: prediction.confidence,
        qualityScore: prediction.qualityScore,
        riskScore: prediction.riskScore,
        probability: prediction.baseProbability ?? prediction.modelProbability,
      }),
    });
  }

  counters.finalCandidates = candidates.length;

  onProgress('BUILDING_COMBINATIONS', PROGRESS_LABELS.BUILDING_COMBINATIONS, { candidates: candidates.length });
  const built = ticketBuilder.buildTicket(candidates, {
    minTotalOdds: Number(settings.minTotalOdds ?? 2.0),
    maxTotalOdds: Number(settings.maxTotalOdds ?? 4.0),
    minSelections: Number(settings.minSelections ?? 2),
    maxSelections: Number(settings.maxSelections ?? 6),
    candidatePoolSize: Number(settings.candidatePoolSize ?? 16),
    maxCombinationsTested: Number(settings.maxCombinationsTested ?? 250000),
    // The admin-editable combination scoring: without these two the builder
    // silently used its own defaults and the Settings screen did nothing.
    ...(settings.combinationWeights ? { weights: settings.combinationWeights } : {}),
    ...(Number.isFinite(Number(settings.legPenalty)) ? { legPenalty: Number(settings.legPenalty) } : {}),
    correlation: {
      enabled: settings.correlationProtection !== false && settings.correlationProtection !== 0,
      maxPerLeague: Number(settings.maxSelectionsPerLeague ?? 2),
      maxPerCountry: Number(settings.maxSelectionsPerCountry ?? 3),
      maxPerKickoffWindow: Number(settings.maxSameKickoffWindow ?? 2),
      kickoffWindowMinutes: Number(settings.kickoffWindowMinutes ?? 45),
    },
  });

  counters.correlationRejected = built.report.correlationRejected;
  counters.combinationsTested = built.report.combinationsTested;
  counters.qualifiedCombinations = built.report.qualifiedCombinations;

  onProgress('CHECKING_CORRELATION', PROGRESS_LABELS.CHECKING_CORRELATION, {
    correlationRejected: built.report.correlationRejected,
  });

  // final odds validation on the chosen combination
  onProgress('VALIDATING_FINAL_ODDS', PROGRESS_LABELS.VALIDATING_FINAL_ODDS, {});
  if (built.status === ticketBuilder.STATUS.QUALIFIED) {
    const finalCheck = validateFinalSelections(built.selections, settings, now);
    if (!finalCheck.ok) {
      return {
        status: 'NO_QUALIFYING_TICKET',
        ticket: null,
        selections: [],
        predictions,
        candidates,
        counters: { ...counters, selectedPicks: 0 },
        report: { ...built.report, reason: finalCheck.reason, detail: finalCheck.detail },
        progress: PROGRESS_STEPS,
      };
    }
  }

  counters.selectedPicks = built.status === ticketBuilder.STATUS.QUALIFIED ? built.selections.length : 0;
  onProgress('CREATING_TICKET', PROGRESS_LABELS.CREATING_TICKET, { status: built.status });

  return {
    status: built.status,
    ticket:
      built.status === ticketBuilder.STATUS.QUALIFIED
        ? {
            status: 'QUALIFIED',
            selections: built.selections,
            totalOddsScaled: built.totalOddsScaled,
            totalOddsExact: decimal.format(built.totalOddsScaled, decimal.SCALE_DIGITS),
            totalOddsDisplay: built.totalOddsDisplay,
            avgConfidence: built.metrics.avgConfidence,
            minConfidence: built.metrics.minConfidence,
            avgQuality: built.metrics.avgQuality,
            maxRisk: built.metrics.maxRisk,
            estimatedProbability: built.metrics.estimatedProbability,
            diversity: built.metrics.diversity,
            strength: built.metrics.strength,
          }
        : null,
    selections: built.selections || [],
    predictions,
    candidates,
    counters,
    report: built.report,
    alternatives: built.alternatives || [],
    progress: PROGRESS_STEPS,
  };
}

/**
 * Last line of defence before a ticket is written: re-verify every leg.
 * The odds must still be the exact verified prices, the fixtures must still be
 * playable and the total must still sit inside the configured window.
 */
function validateFinalSelections(selections, settings, now = new Date()) {
  const minScaled = decimal.scaledFromNumber(Number(settings.minTotalOdds ?? 2));
  const maxScaled = decimal.scaledFromNumber(Number(settings.maxTotalOdds ?? 4));
  const freshness = Number(settings.oddsFreshnessMinutes ?? 90);

  for (const s of selections || []) {
    if (!s || !s.odds) return { ok: false, reason: 'MISSING_ODDS', detail: { fixtureId: s && s.fixtureId } };
    if (s.odds.marketKey && s.odds.marketKey !== 'over_1_5') {
      return { ok: false, reason: 'WRONG_MARKET', detail: { fixtureId: s.fixtureId, marketKey: s.odds.marketKey } };
    }
    if (Math.abs(Number(s.odds.goalLine ?? 1.5) - 1.5) > 1e-9) {
      return { ok: false, reason: 'WRONG_GOAL_LINE', detail: { fixtureId: s.fixtureId, goalLine: s.odds.goalLine } };
    }
    const scaled = decimal.toScaled(s.odds.oddRaw ?? s.odds.oddDecimal);
    if (scaled === null) return { ok: false, reason: 'ODDS_NOT_NUMERIC', detail: { fixtureId: s.fixtureId } };
    if (decimal.lte(scaled, decimal.scaledFromNumber(1))) {
      return { ok: false, reason: 'ODDS_BELOW_MINIMUM', detail: { fixtureId: s.fixtureId } };
    }
    const kickoff = time.toDate(s.kickoffAt);
    if (!kickoff || kickoff.getTime() <= time.toDate(now).getTime()) {
      return { ok: false, reason: 'FIXTURE_STARTED', detail: { fixtureId: s.fixtureId } };
    }
    const age = s.odds.ageMinutes ?? (s.odds.oddsUpdatedAt ? Math.round(time.minutesBetween(s.odds.oddsUpdatedAt, now)) : null);
    if (age === null || age > freshness) {
      return { ok: false, reason: 'ODDS_STALE', detail: { fixtureId: s.fixtureId, age } };
    }
  }

  const ids = new Set((selections || []).map((s) => Number(s.fixtureId)));
  if (ids.size !== (selections || []).length) return { ok: false, reason: 'DUPLICATE_FIXTURE' };

  const total = decimal.product((selections || []).map((s) => s.odds.oddRaw));
  if (total === null) return { ok: false, reason: 'TOTAL_ODDS_INVALID' };
  if (decimal.lt(total, minScaled)) return { ok: false, reason: 'TOTAL_BELOW_MINIMUM', detail: { total: decimal.format(total, 2) } };
  if (decimal.gt(total, maxScaled)) return { ok: false, reason: 'TOTAL_ABOVE_MAXIMUM', detail: { total: decimal.format(total, 2) } };

  const corr = correlation.checkCombination(selections, {
    enabled: settings.correlationProtection !== false && settings.correlationProtection !== 0,
    maxPerLeague: Number(settings.maxSelectionsPerLeague ?? 2),
    maxPerCountry: Number(settings.maxSelectionsPerCountry ?? 3),
    maxPerKickoffWindow: Number(settings.maxSameKickoffWindow ?? 2),
    kickoffWindowMinutes: Number(settings.kickoffWindowMinutes ?? 45),
  });
  if (!corr.ok) return { ok: false, reason: `CORRELATION_${corr.rule}`, detail: { fixtureId: corr.fixtureId } };

  return { ok: true, total, reason: null };
}

/** Human readable summary of why a run produced no ticket. */
function describeNoTicket(report = {}) {
  const reasons = {
    INSUFFICIENT_CANDIDATES: 'Not enough verified Over 1.5 candidates passed the quality, confidence and risk filters.',
    CORRELATION_LIMITS: 'Correlation protection reduced the candidate pool below the minimum number of selections.',
    ALL_COMBINATIONS_BELOW_MINIMUM: `Every possible combination stays below the ${report.oddsWindow ? report.oddsWindow.min : '2.00'} minimum total odds. No weak match was added to force it.`,
    ALL_COMBINATIONS_ABOVE_MAXIMUM: `Every possible combination exceeds the ${report.oddsWindow ? report.oddsWindow.max : '4.00'} maximum total odds.`,
    NO_COMBO_IN_RANGE: 'No combination of qualified selections lands inside the target odds window.',
  };
  return (
    reasons[report.reason] ||
    `No valid Over 1.5 combination was found within the ${report.oddsWindow ? `${report.oddsWindow.min}-${report.oddsWindow.max}` : '2.00-4.00'} target range.`
  );
}

module.exports = {
  PROGRESS_STEPS,
  PROGRESS_LABELS,
  runPipeline,
  analyzeFixture,
  validateFinalSelections,
  describeNoTicket,
  normalizeFixtureRow,
  emptyCounters,
  numbers,
};
