'use strict';

/**
 * COMBINATION ENGINE (accumulator builder) for OVER 1.5 GOALS.
 *
 *  - exact arithmetic: the combined odds are the true product of the verified
 *    prices (BigInt scaled decimals). Rounding happens only for display.
 *  - depth first search with bounds pruning over the strongest
 *    correlation-safe pool (candidatePoolSize, default 16). Every combination
 *    of that pool is tested; candidates outside the pool are never combined.
 *  - the winner is the STRONGEST ticket, not the highest odds ticket:
 *    a 2.15 accumulator of high confidence picks beats a 3.90 accumulator
 *    of marginal picks.
 *  - if nothing lands inside [minTotalOdds, maxTotalOdds] the result is
 *    NO QUALIFYING TICKET. Nothing is ever forced.
 */

const decimal = require('../utils/decimal');
const numbers = require('../utils/numbers');
const correlation = require('./correlation');

const STATUS = {
  QUALIFIED: 'QUALIFIED',
  NO_QUALIFYING_TICKET: 'NO_QUALIFYING_TICKET',
};

const DEFAULTS = {
  minTotalOdds: 2.0,
  maxTotalOdds: 4.0,
  minSelections: 2,
  maxSelections: 6,
  candidatePoolSize: 16,
  maxCombinationsTested: 250000,
  legPenalty: 4,
  keepAlternatives: 5,
  weights: {
    avgConfidence: 0.3,
    minConfidence: 0.15,
    avgQuality: 0.1,
    risk: 0.15,
    probability: 0.2,
    diversity: 0.05,
  },
};

/** Single candidate strength (used to order the pool). */
function candidateStrength(c) {
  const probability = Number(c.probability) || 0;
  return numbers.round(
    0.45 * (Number(c.confidence) || 0) +
      0.2 * (Number(c.qualityScore) || 0) +
      0.2 * (100 - (Number(c.riskScore) || 0)) +
      0.15 * (probability * 100),
    4
  );
}

function withStrength(candidates) {
  return candidates.map((c) => ({ ...c, strength: c.strength ?? candidateStrength(c) }));
}

/** Score a finished combination. */
function scoreCombination(combo, totalScaled, settings) {
  const w = settings.weights;
  const confidences = combo.map((c) => Number(c.confidence) || 0);
  const qualities = combo.map((c) => Number(c.qualityScore) || 0);
  const risks = combo.map((c) => Number(c.riskScore) || 0);
  const probabilities = combo.map((c) => Number(c.probability) || 0);

  const avgConfidence = numbers.mean(confidences) || 0;
  const minConfidence = Math.min(...confidences);
  const avgQuality = numbers.mean(qualities) || 0;
  const maxRisk = Math.max(...risks);
  const estimatedProbability = probabilities.reduce((a, b) => a * b, 1);
  const diversity = correlation.diversityScore(combo);

  const strength =
    w.avgConfidence * avgConfidence +
    w.minConfidence * minConfidence +
    w.avgQuality * avgQuality +
    w.risk * (100 - maxRisk) +
    w.probability * (estimatedProbability * 100) +
    w.diversity * diversity -
    settings.legPenalty * Math.max(0, combo.length - settings.minSelections);

  return {
    strength: numbers.round(strength, 4),
    avgConfidence: numbers.round(avgConfidence, 2),
    minConfidence: numbers.round(minConfidence, 2),
    avgQuality: numbers.round(avgQuality, 2),
    maxRisk: numbers.round(maxRisk, 2),
    estimatedProbability: numbers.round(estimatedProbability, 4),
    diversity,
    legs: combo.length,
    totalOddsScaled: totalScaled,
    totalOddsDisplay: decimal.format(totalScaled, 2),
    totalOddsExact: decimal.format(totalScaled, decimal.SCALE_DIGITS),
  };
}

function compareCombos(a, b) {
  if (b.strength !== a.strength) return b.strength - a.strength;
  if (b.estimatedProbability !== a.estimatedProbability) return b.estimatedProbability - a.estimatedProbability;
  if (a.legs !== b.legs) return a.legs - b.legs; // fewer legs = less variance
  const cmp = decimal.compare(a.totalOddsScaled, b.totalOddsScaled);
  if (cmp !== 0) return cmp; // prefer the lower total at equal strength
  return b.minConfidence - a.minConfidence;
}

/**
 * Build the ticket.
 * @param {Array} candidates already filtered (confidence / risk / quality / verified odds)
 * @param {object} rawSettings
 */
function buildTicket(candidates, rawSettings = {}) {
  const settings = { ...DEFAULTS, ...rawSettings, weights: { ...DEFAULTS.weights, ...(rawSettings.weights || {}) } };
  settings.correlation = { ...correlation.DEFAULTS, ...(rawSettings.correlation || {}) };

  const minScaled = decimal.scaledFromNumber(Number(settings.minTotalOdds));
  const maxScaled = decimal.scaledFromNumber(Number(settings.maxTotalOdds));
  const minSelections = Math.max(1, Number(settings.minSelections) || 2);
  const maxSelections = Math.max(minSelections, Number(settings.maxSelections) || 6);

  const report = {
    inputCandidates: (candidates || []).length,
    poolSize: 0,
    correlationRejected: 0,
    combinationsFormed: 0,
    combinationsTested: 0,
    qualifiedCombinations: 0,
    correlationRejectedCombinations: 0,
    prunedBranches: 0,
    truncated: false,
    reason: null,
    oddsWindow: { min: decimal.format(minScaled, 2), max: decimal.format(maxScaled, 2) },
  };

  const noTicket = (reason, extra = {}) => ({
    status: STATUS.NO_QUALIFYING_TICKET,
    selections: [],
    totalOddsScaled: decimal.scaledFromNumber(0),
    totalOddsDisplay: '0.00',
    metrics: null,
    report: { ...report, reason, ...extra },
    alternatives: [],
  });

  if (!Array.isArray(candidates) || candidates.length < minSelections) {
    return noTicket('INSUFFICIENT_CANDIDATES', { poolSize: (candidates || []).length });
  }

  // 1. rank by strength, keep the strongest pool, respecting correlation caps
  const ranked = withStrength(candidates).sort((a, b) => b.strength - a.strength);
  const poolBuild = correlation.buildPool(ranked.slice(0, Math.max(maxSelections * 3, settings.candidatePoolSize)), settings);
  const pool = poolBuild.pool.slice(0, settings.candidatePoolSize);
  report.poolSize = pool.length;
  report.correlationRejected = poolBuild.correlationRejected;

  if (pool.length < minSelections) {
    return noTicket('CORRELATION_LIMITS', { poolSize: pool.length });
  }

  // 2. order by odds ascending so the DFS bounds are exact
  const ordered = [...pool].sort((a, b) => decimal.compare(a.odds.oddScaled, b.odds.oddScaled));
  const scaledOdds = ordered.map((c) => c.odds.oddScaled);
  const n = ordered.length;

  // suffix products: smallest possible product of k legs starting at index i
  const suffixSmallest = (i, k) => {
    let p = decimal.SCALE_FACTOR;
    for (let j = i; j < Math.min(n, i + k); j += 1) p = decimal.multiply(p, scaledOdds[j]);
    return p;
  };
  const largestAvailable = [...scaledOdds].sort((a, b) => decimal.compare(b, a));
  const prefixLargest = (k) => {
    let p = decimal.SCALE_FACTOR;
    for (let j = 0; j < Math.min(k, largestAvailable.length); j += 1) p = decimal.multiply(p, largestAvailable[j]);
    return p;
  };
  /**
   * Optimistic bound for the branch starting at `index`: the largest product
   * still reachable with at most `k` further legs. Every price is > 1, so the
   * bound is the k most expensive remaining candidates. A branch may only be
   * discarded when even this bound cannot reach the minimum total odds —
   * otherwise a real qualifying ticket would be missed.
   */
  const suffixLargest = (index, k) => {
    const count = Math.max(0, Math.min(k, n - index));
    let p = decimal.SCALE_FACTOR;
    for (let j = n - 1; j >= n - count; j -= 1) p = decimal.multiply(p, scaledOdds[j]);
    return p;
  };

  let best = null;
  const alternatives = [];
  const chosen = [];

  const evaluate = (combo, total) => {
    report.combinationsTested += 1;
    if (decimal.lt(total, minScaled) || decimal.gt(total, maxScaled)) return;
    const check = correlation.checkCombination(combo, settings);
    if (!check.ok) {
      report.correlationRejectedCombinations += 1;
      return;
    }
    report.qualifiedCombinations += 1;
    const metrics = scoreCombination(combo, total, settings);
    const entry = { combo: combo.map((c) => Number(c.fixtureId ?? c.fixture_id)), metrics };
    alternatives.push(entry);
    alternatives.sort(compareEntry);
    if (alternatives.length > settings.keepAlternatives) alternatives.length = settings.keepAlternatives;
    if (!best || compareEntry(entry, best) < 0) best = entry;
  };

  const compareEntry = (a, b) => compareCombos(a.metrics, b.metrics);

  const dfs = (index, product, legs) => {
    if (report.truncated) return;
    if (report.combinationsTested >= settings.maxCombinationsTested) {
      report.truncated = true;
      return;
    }
    // the pool is ordered by odds ascending: once the running product is over
    // the maximum, no further leg can bring it back down
    if (decimal.gt(product, maxScaled)) {
      report.prunedBranches += 1;
      return;
    }
    if (legs >= minSelections) evaluate(chosen.slice(), product);
    if (legs >= maxSelections) return;

    // not enough candidates left to reach the minimum number of legs
    if (legs + (n - index) < minSelections) {
      report.prunedBranches += 1;
      return;
    }
    // even the most expensive reachable combination cannot hit the minimum
    if (legs < minSelections) {
      const bestReachable = decimal.multiply(product, suffixLargest(index, maxSelections - legs));
      if (decimal.lt(bestReachable, minScaled)) {
        report.prunedBranches += 1;
        return;
      }
    }

    for (let i = index; i < n; i += 1) {
      const candidate = ordered[i];
      if (!correlation.canAdd(candidate, chosen, settings.correlation)) continue;

      const nextProduct = decimal.multiply(product, candidate.odds.oddScaled);
      if (decimal.gt(nextProduct, maxScaled)) {
        // ascending order: every later candidate is at least as expensive
        report.prunedBranches += 1;
        break;
      }
      chosen.push(candidate);
      dfs(i + 1, nextProduct, legs + 1);
      chosen.pop();
      if (report.truncated) return;
    }
  };

  dfs(0, decimal.SCALE_FACTOR, 0);

  if (!best) {
    const highestPossible = decimal.multiply(decimal.SCALE_FACTOR, prefixLargest(Math.min(maxSelections, n)));
    const lowestPossible = suffixSmallest(0, Math.min(minSelections, n));
    let reason = 'NO_COMBO_IN_RANGE';
    if (decimal.lt(highestPossible, minScaled)) reason = 'ALL_COMBINATIONS_BELOW_MINIMUM';
    else if (decimal.gt(lowestPossible, maxScaled)) reason = 'ALL_COMBINATIONS_ABOVE_MAXIMUM';
    return noTicket(reason, {
      highestPossibleOdds: decimal.format(highestPossible, 2),
      lowestPossibleOdds: decimal.format(lowestPossible, 2),
      qualifiedCombinations: report.qualifiedCombinations,
    });
  }

  const chosenFixtures = new Set(best.combo);
  const selections = ordered
    .filter((c) => chosenFixtures.has(c.fixtureId))
    .sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt))
    .map((c, i) => ({ ...c, position: i + 1 }));

  // recompute the total from the actual selection order (exact)
  const totalScaled = decimal.product(selections.map((s) => s.odds.oddRaw));

  return {
    status: STATUS.QUALIFIED,
    selections,
    totalOddsScaled: totalScaled,
    totalOddsDisplay: decimal.format(totalScaled, 2),
    totalOddsExact: decimal.format(totalScaled, decimal.SCALE_DIGITS),
    metrics: scoreCombination(selections, totalScaled, settings),
    report: { ...report, reason: null },
    alternatives: alternatives.map((a) => ({ fixtures: a.combo, metrics: a.metrics })),
  };
}

module.exports = { buildTicket, candidateStrength, scoreCombination, compareCombos, STATUS, DEFAULTS };
