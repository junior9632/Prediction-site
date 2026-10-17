'use strict';

/**
 * CONFIDENCE (0-100) for an Over 1.5 Goals pick.
 *
 * Confidence is a deterministic function of:
 *   - the model probability (Poisson + historical Over 1.5 frequency)
 *   - the market probability implied by the VERIFIED bookmaker price
 *   - how much those two independent estimates agree
 *   - the size and freshness of the real sample behind them
 *   - the data quality score (hard cap: thin data can never look certain)
 *
 * It is never random and never derived from the odds alone.
 */

const numbers = require('../utils/numbers');

const DEFAULTS = {
  modelWeight: 0.62,
  marketWeight: 0.38,
  disagreementThreshold: 0.12,
  disagreementPenaltyScale: 90, // per unit of disagreement above the threshold
  disagreementMaxPenalty: 22,
  samplePenaltyMax: 10,
  venuePenaltyMax: 6,
  capBase: 55, // cap = capBase + capSlope * dataQuality
  capSlope: 0.45,
  probabilityMargin: 5, // confidence may not exceed 100*max(p)+margin
  absoluteMax: 97,
};

/**
 * @param {object} input {modelProbability, marketProbability, dataQuality, features, settings}
 */
function computeConfidence(input = {}) {
  const settings = { ...DEFAULTS, ...(input.settings || {}) };
  const features = input.features || {};

  const pModel = Number(input.modelProbability);
  const pMarket = Number(input.marketProbability);
  if (!Number.isFinite(pModel)) {
    return { confidence: 0, eligible: false, reason: 'MODEL_PROBABILITY_MISSING', components: [] };
  }

  const components = [];
  const marketUsable = Number.isFinite(pMarket) && pMarket > 0 && pMarket < 1;

  // 1. base probability blend
  const baseProbability = marketUsable
    ? numbers.weighted([
        { value: pModel, weight: settings.modelWeight },
        { value: pMarket, weight: settings.marketWeight },
      ])
    : pModel;
  components.push({
    component: 'probability_base',
    score: numbers.round(baseProbability * 100, 2),
    weight: 1,
    detail: { pModel: numbers.round(pModel, 4), pMarket: marketUsable ? numbers.round(pMarket, 4) : null },
  });

  let confidence = baseProbability * 100;

  // 2. model vs market disagreement
  if (marketUsable) {
    const disagreement = Math.abs(pModel - pMarket);
    if (disagreement > settings.disagreementThreshold) {
      const penalty = Math.min(
        settings.disagreementMaxPenalty,
        (disagreement - settings.disagreementThreshold) * settings.disagreementPenaltyScale
      );
      confidence -= penalty;
      components.push({ component: 'market_agreement_penalty', score: -numbers.round(penalty, 2), weight: 1, detail: { disagreement: numbers.round(disagreement, 4) } });
    } else {
      components.push({ component: 'market_agreement_penalty', score: 0, weight: 1, detail: { disagreement: numbers.round(disagreement, 4) } });
    }
  } else {
    // no usable market price => the candidate has already been rejected by the
    // odds validator, but guard anyway
    confidence -= 15;
    components.push({ component: 'market_missing_penalty', score: -15, weight: 1, detail: {} });
  }

  // 3. sample size penalty
  const minSample = Math.min(Number(features.homeSample) || 0, Number(features.awaySample) || 0);
  const formWindow = Number(input.formWindowMatches) || 10;
  const samplePenalty = settings.samplePenaltyMax * numbers.clamp(1 - minSample / formWindow, 0, 1);
  if (samplePenalty > 0.01) {
    confidence -= samplePenalty;
    components.push({ component: 'sample_penalty', score: -numbers.round(samplePenalty, 2), weight: 1, detail: { minSample, formWindow } });
  }

  // 4. venue split penalty
  const minVenueSample = Math.min(Number(features.homeVenueSample) || 0, Number(features.awayVenueSample) || 0);
  const minVenue = Number(input.minVenueFormMatches) || 3;
  const venuePenalty = settings.venuePenaltyMax * numbers.clamp(1 - minVenueSample / (minVenue * 2), 0, 1);
  if (venuePenalty > 0.01) {
    confidence -= venuePenalty;
    components.push({ component: 'venue_penalty', score: -numbers.round(venuePenalty, 2), weight: 1, detail: { minVenueSample } });
  }

  // 5. caps
  const dataQuality = Number.isFinite(Number(input.dataQuality)) ? Number(input.dataQuality) : 0;
  const qualityCap = settings.capBase + settings.capSlope * dataQuality;
  const probabilityCap = 100 * Math.max(pModel, marketUsable ? pMarket : 0) + settings.probabilityMargin;
  const cap = Math.min(qualityCap, probabilityCap, settings.absoluteMax);

  const final = numbers.clamp(confidence, 0, cap);

  components.push({ component: 'data_quality_cap', score: numbers.round(qualityCap, 2), weight: 0, detail: { dataQuality } });
  components.push({ component: 'probability_cap', score: numbers.round(probabilityCap, 2), weight: 0, detail: {} });

  return {
    confidence: numbers.round(final, 2),
    rawConfidence: numbers.round(confidence, 2),
    cap: numbers.round(cap, 2),
    baseProbability: numbers.round(baseProbability, 4),
    eligible: true,
    components,
  };
}

module.exports = { computeConfidence, DEFAULTS };
