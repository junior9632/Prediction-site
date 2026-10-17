'use strict';

/** Small numeric helpers. All prediction maths is deterministic — nothing random. */

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

const round = (v, dp = 2) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

const sum = (arr) => (arr || []).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

const mean = (arr) => {
  const list = (arr || []).filter((v) => Number.isFinite(v));
  if (!list.length) return null;
  return sum(list) / list.length;
};

/** Population standard deviation — used for goal volatility (risk input). */
const stddev = (arr) => {
  const list = (arr || []).filter((v) => Number.isFinite(v));
  if (list.length < 2) return null;
  const m = mean(list);
  const variance = sum(list.map((v) => (v - m) ** 2)) / list.length;
  return Math.sqrt(variance);
};

const safeDiv = (numerator, denominator, fallback = 0) => {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return fallback;
  }
  return numerator / denominator;
};

/** Linear rescale of `v` from [inMin,inMax] into [outMin,outMax], clamped. */
const rescale = (v, inMin, inMax, outMin = 0, outMax = 100) => {
  if (!Number.isFinite(v)) return outMin;
  if (inMax === inMin) return outMin;
  const t = clamp((v - inMin) / (inMax - inMin), 0, 1);
  return outMin + t * (outMax - outMin);
};

/** Weighted sum of {value, weight} parts; weights are normalised. */
function weighted(parts) {
  const usable = (parts || []).filter(
    (p) => p && Number.isFinite(p.value) && Number.isFinite(p.weight) && p.weight > 0
  );
  const totalWeight = sum(usable.map((p) => p.weight));
  if (!totalWeight) return null;
  return sum(usable.map((p) => p.value * p.weight)) / totalWeight;
}

/**
 * Poisson helpers. P(total goals >= 2) is computed by convolving two
 * independent Poisson distributions (home lambda, away lambda) and adding
 * the optional Dixon-Coles low score correction.
 */
function poissonPmf(k, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i += 1) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Exact P(home + away goals >= 2) for independent Poisson scoring models.
 * maxGoals truncation of 12 per side is far beyond any realistic lambda.
 */
function probabilityOverGoals(lambdaHome, lambdaAway, line = 1.5, maxGoals = 12, rho = 0) {
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) return null;
  if (lambdaHome <= 0 || lambdaAway <= 0) return null;

  const needed = Math.ceil(line); // Over 1.5 -> 2 goals
  let p = 0;
  for (let h = 0; h <= maxGoals; h += 1) {
    const ph = poissonPmf(h, lambdaHome);
    if (ph <= 0) continue;
    for (let a = 0; a <= maxGoals; a += 1) {
      if (h + a < needed) continue;
      const pa = poissonPmf(a, lambdaAway);
      if (pa <= 0) continue;
      let adj = 1;
      if (rho !== 0) {
        // Dixon-Coles (1997) low-score dependence correction
        if (h === 0 && a === 0) adj = 1 - lambdaHome * lambdaAway * rho;
        else if (h === 0 && a === 1) adj = 1 + lambdaHome * rho;
        else if (h === 1 && a === 0) adj = 1 + lambdaAway * rho;
        else if (h === 1 && a === 1) adj = 1 - rho;
      }
      p += ph * pa * adj;
    }
  }
  return clamp(p, 0, 1);
}

module.exports = {
  clamp,
  round,
  sum,
  mean,
  stddev,
  safeDiv,
  rescale,
  weighted,
  poissonPmf,
  probabilityOverGoals,
};
