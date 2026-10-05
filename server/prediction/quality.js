'use strict';

/**
 * DATA QUALITY — how complete and how fresh the real evidence behind a
 * candidate is. Quality gates the ticket: a match with thin or stale data
 * never enters the accumulator, no matter how attractive its price looks.
 */

const numbers = require('../utils/numbers');

const DEFAULT_WEIGHTS = {
  formSample: 0.24,
  venueSample: 0.14,
  leagueEnvironment: 0.16,
  oddsAvailability: 0.18,
  oddsFreshness: 0.14,
  headToHead: 0.07,
  injuries: 0.04,
  fixtureFreshness: 0.03,
};

/**
 * @param {object} model result of prediction/over15.js analyze()
 * @param {object} context {odds, leagueEnv, h2h, injuries, fixture, settings}
 */
function computeDataQuality(model, context = {}) {
  const settings = context.settings || {};
  const weights = { ...DEFAULT_WEIGHTS, ...(settings.qualityWeights || {}) };
  const features = (model && model.features) || {};
  const odds = context.odds || {};
  const leagueEnv = context.leagueEnv || {};
  const h2h = context.h2h || {};
  const injuries = context.injuries || {};

  const formWindow = Number(settings.formWindowMatches) || 10;
  const minVenue = Number(settings.minVenueFormMatches) || 3;
  const freshnessMinutes = Number(settings.oddsFreshnessMinutes) || 90;

  const components = [];

  // 1. overall form sample for both teams
  const minSample = Math.min(Number(features.homeSample) || 0, Number(features.awaySample) || 0);
  const formSampleScore = numbers.clamp(numbers.rescale(minSample, formWindow * 0.5, formWindow, 0, 100), 0, 100);
  components.push({ component: 'form_sample', score: numbers.round(formSampleScore, 2), weight: weights.formSample, detail: { minSample, formWindow } });

  // 2. venue specific sample (home team at home, away team away)
  const minVenueSample = Math.min(Number(features.homeVenueSample) || 0, Number(features.awayVenueSample) || 0);
  const venueScore = numbers.clamp(numbers.rescale(minVenueSample, minVenue * 0.6, minVenue * 2, 0, 100), 0, 100);
  components.push({ component: 'venue_sample', score: numbers.round(venueScore, 2), weight: weights.venueSample, detail: { minVenueSample } });

  // 3. league goal environment
  let leagueScore = 0;
  const leagueSample = Number(leagueEnv.sampleMatches) || 0;
  if (leagueEnv.sufficient && leagueSample >= 100) leagueScore = 100;
  else if (leagueEnv.sufficient && leagueSample >= 40) leagueScore = 85;
  else if (leagueEnv.sufficient) leagueScore = 70;
  else if (features.baselineSource === 'derived_from_teams') leagueScore = 40;
  components.push({ component: 'league_environment', score: leagueScore, weight: weights.leagueEnvironment, detail: { leagueSample, sufficient: Boolean(leagueEnv.sufficient) } });

  // 4. odds availability (how many real bookmakers quote Over 1.5)
  const bookmakers = Number(odds.bookmakersOffering || odds.alternativesCount + 1 || 0);
  let oddsScore = 0;
  if (bookmakers >= 6) oddsScore = 100;
  else if (bookmakers >= 4) oddsScore = 90;
  else if (bookmakers >= 3) oddsScore = 80;
  else if (bookmakers === 2) oddsScore = 65;
  else if (bookmakers === 1) oddsScore = 45;
  components.push({ component: 'odds_availability', score: oddsScore, weight: weights.oddsAvailability, detail: { bookmakers } });

  // 5. odds freshness
  const age = Number(odds.ageMinutes);
  let freshnessScore = 0;
  if (Number.isFinite(age)) {
    if (age <= 10) freshnessScore = 100;
    else if (age <= 30) freshnessScore = 90;
    else if (age <= 60) freshnessScore = 75;
    else if (age <= freshnessMinutes) freshnessScore = 55;
  }
  components.push({ component: 'odds_freshness', score: freshnessScore, weight: weights.oddsFreshness, detail: { ageMinutes: Number.isFinite(age) ? age : null } });

  // 6. head to head
  let h2hScore = 35;
  const h2hSample = Number(h2h.sample) || 0;
  if (h2h.available && h2hSample >= 6) h2hScore = 100;
  else if (h2h.available && h2hSample >= Number(settings.h2hMinMeetings || 3)) h2hScore = 80;
  else if (h2hSample > 0) h2hScore = 55;
  components.push({ component: 'head_to_head', score: h2hScore, weight: weights.headToHead, detail: { h2hSample } });

  // 7. injuries availability
  const injuryScore = injuries.available ? 100 : 45;
  components.push({ component: 'injuries_available', score: injuryScore, weight: weights.injuries, detail: { available: Boolean(injuries.available) } });

  // 8. fixture record freshness (when we last synced it)
  const fixtureFetched = context.fixture && (context.fixture.fetched_at || context.fixture.fetchedAt);
  let fixtureScore = 40;
  if (fixtureFetched) {
    const ageMinutes = Math.abs(Number(numbers.round(timeAgeMinutes(fixtureFetched, context.now), 0)) || 0);
    if (ageMinutes <= 60) fixtureScore = 100;
    else if (ageMinutes <= 360) fixtureScore = 85;
    else if (ageMinutes <= 1440) fixtureScore = 65;
  }
  components.push({ component: 'fixture_freshness', score: fixtureScore, weight: weights.fixtureFreshness, detail: {} });

  const total = numbers.weighted(components.map((c) => ({ value: c.score, weight: c.weight })));
  const quality = total === null ? 0 : numbers.clamp(total, 0, 100);

  return {
    dataQuality: numbers.round(quality, 2),
    components,
    flags: {
      leagueEnvironmentDerived: features.baselineSource === 'derived_from_teams',
      singleBookmaker: bookmakers <= 1,
      noHeadToHead: !h2h.available,
      injuriesUnavailable: !injuries.available,
    },
  };
}

function timeAgeMinutes(value, now) {
  const t = require('../utils/time');
  const age = t.minutesBetween(value, t.toDate(now || new Date()) || new Date());
  return age === null ? null : -age; // positive = how long ago
}

module.exports = { computeDataQuality, DEFAULT_WEIGHTS };
