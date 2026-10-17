'use strict';

/**
 * RISK SCORE (0-100, higher = riskier) for an Over 1.5 Goals candidate.
 *
 * Every component is computed from real data. Candidates above the
 * configurable `maxRisk` threshold are rejected — the threshold is never
 * relaxed in order to produce a ticket.
 */

const numbers = require('../utils/numbers');
const time = require('../utils/time');

const DEFAULT_WEIGHTS = {
  goalVolatility: 0.16,
  sampleSize: 0.12,
  defensiveSolidity: 0.16,
  leagueEnvironment: 0.14,
  marketImplied: 0.14,
  modelMarketDisagreement: 0.1,
  historicalOver15: 0.08,
  injuries: 0.04,
  headToHead: 0.03,
  kickoffProximity: 0.03,
};

const LEVELS = [
  { max: 20, label: 'LOW' },
  { max: 35, label: 'MEDIUM' },
  { max: 50, label: 'ELEVATED' },
  { max: 101, label: 'HIGH' },
];

function levelFor(score) {
  for (const l of LEVELS) if (score < l.max) return l.label;
  return 'HIGH';
}

/**
 * @param {object} model   output of prediction/over15.js analyze()
 * @param {object} context {odds, leagueEnv, h2h, injuries, fixture, settings, now}
 */
function computeRisk(model, context = {}) {
  const settings = context.settings || {};
  const weights = { ...DEFAULT_WEIGHTS, ...(settings.riskWeights || {}) };
  const features = (model && model.features) || {};
  const odds = context.odds || {};
  const leagueEnv = context.leagueEnv || {};
  const h2h = context.h2h || {};
  const injuries = context.injuries || {};
  const components = [];

  const push = (component, score, detail) =>
    components.push({ component, score: numbers.round(numbers.clamp(score, 0, 100), 2), weight: weights[component] || 0, detail: detail || {} });

  // 1. goal volatility — erratic totals make a 2+ goal game less predictable
  const stds = [features.homeTotalGoalsStddev, features.awayTotalGoalsStddev].filter((v) => Number.isFinite(v));
  // Fail closed: a missing statistic is maximum risk, never an assumed average.
  const avgStd = stds.length ? numbers.mean(stds) : null;
  push('goalVolatility', avgStd === null ? 100 : numbers.rescale(avgStd, 0.9, 2.0, 5, 85), { avgStddev: avgStd === null ? null : numbers.round(avgStd, 3) });

  // 2. sample size
  const minSample = Math.min(Number(features.homeSample) || 0, Number(features.awaySample) || 0);
  const minVenueSample = Math.min(Number(features.homeVenueSample) || 0, Number(features.awayVenueSample) || 0);
  const sampleRisk = 0.6 * numbers.rescale(minSample, 10, 5, 0, 70) + 0.4 * numbers.rescale(minVenueSample, 6, 2, 0, 75);
  push('sampleSize', sampleRisk, { minSample, minVenueSample });

  // 3. defensive solidity / failure to score — the classic 0-0 and 1-0 traps
  const cleanSheets = [features.homeCleanSheetRate, features.awayCleanSheetRate].filter((v) => Number.isFinite(v));
  const failedToScore = [features.homeFailedToScoreRate, features.awayFailedToScoreRate].filter((v) => Number.isFinite(v));
  // Fail closed: missing statistics are maximum risk, never an assumed average.
  const avgCleanSheet = cleanSheets.length ? numbers.mean(cleanSheets) : null;
  const avgFailed = failedToScore.length ? numbers.mean(failedToScore) : null;
  const defensiveRisk =
    avgCleanSheet === null || avgFailed === null
      ? 100
      : 0.55 * numbers.rescale(avgCleanSheet, 15, 50, 5, 80) + 0.45 * numbers.rescale(avgFailed, 5, 35, 0, 75);
  push('defensiveSolidity', defensiveRisk, {
    avgCleanSheet: avgCleanSheet === null ? null : numbers.round(avgCleanSheet, 2),
    avgFailedToScore: avgFailed === null ? null : numbers.round(avgFailed, 2),
  });

  // 4. league goal environment
  const leagueAvg = Number(leagueEnv.avgTotalGoals);
  let leagueRisk = Number.isFinite(leagueAvg) ? numbers.rescale(leagueAvg, 3.2, 2.1, 0, 85) : 60;
  if (features.baselineSource === 'derived_from_teams') leagueRisk = Math.min(100, leagueRisk + 15);
  push('leagueEnvironment', leagueRisk, { leagueAvgTotalGoals: Number.isFinite(leagueAvg) ? leagueAvg : null, source: features.baselineSource || null });

  // 5. market implied risk — a high Over 1.5 price means the market expects goals to be scarce
  const price = Number(odds.oddDecimal);
  const implied = Number.isFinite(price) && price > 1 ? 1 / price : null;
  push('marketImplied', implied === null ? 70 : numbers.rescale(implied, 0.9, 0.5, 0, 95), { odds: price, implied: implied === null ? null : numbers.round(implied, 4) });

  // 6. model vs market disagreement
  const pModel = Number(model && model.modelProbability);
  const disagreement = Number.isFinite(pModel) && implied !== null ? Math.abs(pModel - implied) : 0.2;
  push('modelMarketDisagreement', numbers.rescale(disagreement, 0.02, 0.25, 0, 85), { disagreement: numbers.round(disagreement, 4) });

  // 7. historical Over 1.5 frequency of both teams
  const rates = [features.homeOver15Rate, features.awayOver15Rate].filter((v) => Number.isFinite(v));
  const avgRate = rates.length ? numbers.mean(rates) : null;
  push('historicalOver15', avgRate === null ? 60 : numbers.rescale(avgRate, 85, 50, 0, 90), { avgOver15Rate: avgRate === null ? null : numbers.round(avgRate, 2) });

  // 8. injuries
  let injuryRisk = 20; // unknown
  if (injuries.available) {
    const missing = (Number(injuries.home) || 0) + (Number(injuries.away) || 0);
    if (missing === 0) injuryRisk = 0;
    else if (missing <= 2) injuryRisk = 20;
    else if (missing <= 4) injuryRisk = 40;
    else if (missing <= 7) injuryRisk = 60;
    else injuryRisk = 75;
  }
  push('injuries', injuryRisk, { available: Boolean(injuries.available), home: injuries.available ? injuries.home : null, away: injuries.available ? injuries.away : null });

  // 9. head to head
  let h2hRisk = 25;
  if (h2h.available && Number.isFinite(Number(h2h.over15Rate))) {
    h2hRisk = numbers.rescale(Number(h2h.over15Rate), 80, 45, 0, 80);
  }
  push('headToHead', h2hRisk, { available: Boolean(h2h.available), sample: Number(h2h.sample) || 0, over15Rate: h2h.available ? Number(h2h.over15Rate) : null });

  // 10. kickoff proximity — team news and prices can still move
  const kickoff = time.toDate((context.fixture && (context.fixture.kickoff_at || context.fixture.kickoffAt)) || null);
  const now = time.toDate(context.now || new Date()) || new Date();
  const minutesToKickoff = kickoff ? Math.round(time.minutesBetween(now, kickoff)) : null;
  let proximityRisk = 0;
  if (minutesToKickoff !== null) {
    if (minutesToKickoff < 45) proximityRisk = 55;
    else if (minutesToKickoff < 120) proximityRisk = 35;
    else if (minutesToKickoff < 360) proximityRisk = 15;
  }
  push('kickoffProximity', proximityRisk, { minutesToKickoff });

  const total = numbers.weighted(components.map((c) => ({ value: c.score, weight: c.weight })));
  const riskScore = total === null ? 100 : numbers.clamp(total, 0, 100);

  return {
    riskScore: numbers.round(riskScore, 2),
    level: levelFor(riskScore),
    components,
  };
}

module.exports = { computeRisk, DEFAULT_WEIGHTS, LEVELS, levelFor };
