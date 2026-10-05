'use strict';

/**
 * OVER 1.5 GOALS MODEL
 *
 * Estimates P(total goals >= 2) for one fixture using ONLY real data:
 *   - each team's scoring / conceding profile (venue split + recency)
 *   - the league goal environment (computed from stored finished matches)
 *   - head-to-head history when a sufficient sample exists
 *   - verified bookmaker price (as an independent market estimate)
 *   - injuries when the API actually returns them
 *
 * Nothing is randomised. If a required input is missing the candidate is
 * rejected with INSUFFICIENT_DATA / DATA_UNAVAILABLE instead of being
 * estimated from a made-up baseline.
 */

const numbers = require('../utils/numbers');
const time = require('../utils/time');

const REJECT = {
  NO_OVER15_ODDS: 'NO_OVER15_ODDS',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  FIXTURE_STARTED: 'FIXTURE_STARTED',
  FIXTURE_NOT_PLAYABLE: 'FIXTURE_NOT_PLAYABLE',
};

const DEFAULTS = {
  formWindowMatches: 10,
  minFormMatches: 5,
  minVenueFormMatches: 3,
  poissonWeight: 0.6,
  historyWeight: 0.4,
  h2hWeight: 0.1,
  h2hMinMeetings: 3,
  recencyWeight: 0.5,
  injuryImpactPerPlayer: 0.015,
  injuryMaxImpact: 0.08,
  strengthMin: 0.35,
  strengthMax: 2.6,
  dixonColesRho: 0,
  maxDaysSinceLastMatch: 45,
};

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * Blend a venue-specific rate with the overall rate, weighting each by the
 * number of real matches behind it. Never fabricates a sample.
 */
function blendedRate(venueForm, allForm, field, settings) {
  const venueSample = num(venueForm && venueForm.matchesPlayed, 0);
  const allSample = num(allForm && allForm.matchesPlayed, 0);
  const venueValue = venueForm ? num(venueForm[field], null) : null;
  const allValue = allForm ? num(allForm[field], null) : null;

  if (venueSample >= settings.minVenueFormMatches && venueValue !== null) {
    if (allSample <= venueSample || allValue === null) return { value: venueValue, sample: venueSample, source: 'venue' };
    const wVenue = venueSample / (venueSample + allSample * 0.5);
    return {
      value: venueValue * wVenue + allValue * (1 - wVenue),
      sample: venueSample + allSample,
      source: 'venue+overall',
    };
  }
  if (allSample >= settings.minFormMatches && allValue !== null) {
    return { value: allValue, sample: allSample, source: 'overall' };
  }
  return { value: null, sample: Math.max(venueSample, allSample), source: 'insufficient' };
}

/** Recency multiplier from last-5 vs window form (real matches only). */
function recencyFactor(form5, formWindow, field, settings) {
  const recent = num(form5 && form5[field], null);
  const base = num(formWindow && formWindow[field], null);
  if (recent === null || base === null || base <= 0) return { factor: 1, applied: false };
  const raw = recent / base;
  const weight = settings.recencyWeight;
  const blended = 1 + (raw - 1) * weight;
  return { factor: numbers.clamp(blended, 0.7, 1.4), applied: true, raw };
}

/**
 * Build the model input bundle for one fixture.
 * @returns {{eligible:boolean, rejectReason:string|null, ...}}
 */
function analyze(context) {
  const settings = { ...DEFAULTS, ...(context.settings || {}) };
  const now = time.toDate(context.now || new Date()) || new Date();
  const fixture = context.fixture || {};
  const form = context.form || {};
  const odds = context.odds || null;

  const rejection = (reason, detail) => ({
    eligible: false,
    rejectReason: reason,
    detail: detail || null,
    modelProbability: null,
    expectedGoalsHome: null,
    expectedGoalsAway: null,
    expectedTotalGoals: null,
    features: {},
  });

  /* --- fixture state ------------------------------------------------ */
  const kickoff = time.toDate(fixture.kickoffAt || fixture.kickoff_at);
  if (!kickoff) return rejection(REJECT.INSUFFICIENT_DATA, { reason: 'missing kickoff' });
  if (kickoff.getTime() <= now.getTime()) return rejection(REJECT.FIXTURE_STARTED);
  if (fixture.isPlayable === false) return rejection(REJECT.FIXTURE_NOT_PLAYABLE);

  /* --- verified Over 1.5 odds are mandatory ------------------------- */
  if (!odds || !Number.isFinite(num(odds.oddDecimal, NaN)) || num(odds.oddDecimal, 0) <= 1) {
    return rejection(REJECT.NO_OVER15_ODDS, { reason: 'no verified Over 1.5 price' });
  }

  /* --- form --------------------------------------------------------- */
  const homeAll = form.home && form.home.all;
  const homeVenue = form.home && form.home.venue;
  const homeLast5 = form.home && form.home.last5;
  const awayAll = form.away && form.away.all;
  const awayVenue = form.away && form.away.venue;
  const awayLast5 = form.away && form.away.last5;

  const homeSample = num(homeAll && homeAll.matchesPlayed, 0);
  const awaySample = num(awayAll && awayAll.matchesPlayed, 0);
  if (homeSample < settings.minFormMatches || awaySample < settings.minFormMatches) {
    return rejection(REJECT.INSUFFICIENT_DATA, {
      reason: 'form sample too small',
      homeSample,
      awaySample,
      required: settings.minFormMatches,
    });
  }

  // staleness guard: a team that has not played for a long time cannot be
  // modelled from that sample
  const homeLastMatch = time.toDate(homeAll && homeAll.lastMatchAt);
  const awayLastMatch = time.toDate(awayAll && awayAll.lastMatchAt);
  const homeDaysSince = homeLastMatch ? Math.round(-time.minutesBetween(homeLastMatch, now) / 1440) : null;
  const awayDaysSince = awayLastMatch ? Math.round(-time.minutesBetween(awayLastMatch, now) / 1440) : null;
  if (homeDaysSince !== null && homeDaysSince > settings.maxDaysSinceLastMatch) {
    return rejection(REJECT.INSUFFICIENT_DATA, { reason: 'home team form is stale', homeDaysSince });
  }
  if (awayDaysSince !== null && awayDaysSince > settings.maxDaysSinceLastMatch) {
    return rejection(REJECT.INSUFFICIENT_DATA, { reason: 'away team form is stale', awayDaysSince });
  }

  /* --- league baseline ---------------------------------------------- */
  const leagueEnv = context.leagueEnv || {};
  let baselineHome = num(leagueEnv.avgHomeGoals, null);
  let baselineAway = num(leagueEnv.avgAwayGoals, null);
  let baselineSource = 'league';
  let baselineSample = num(leagueEnv.sampleMatches, 0);

  const goalsForHome = blendedRate(homeVenue, homeAll, 'avgGoalsFor', settings);
  const goalsAgainstHome = blendedRate(homeVenue, homeAll, 'avgGoalsAgainst', settings);
  const goalsForAway = blendedRate(awayVenue, awayAll, 'avgGoalsFor', settings);
  const goalsAgainstAway = blendedRate(awayVenue, awayAll, 'avgGoalsAgainst', settings);

  if (goalsForHome.value === null || goalsAgainstHome.value === null || goalsForAway.value === null || goalsAgainstAway.value === null) {
    return rejection(REJECT.INSUFFICIENT_DATA, { reason: 'goal profile incomplete' });
  }

  if (!leagueEnv.sufficient || baselineHome === null || baselineAway === null || baselineHome <= 0 || baselineAway <= 0) {
    // No league environment: derive the baseline from the two teams' own
    // numbers (still real data) and flag the reduced data quality.
    baselineHome = (goalsForHome.value + goalsAgainstAway.value) / 2;
    baselineAway = (goalsForAway.value + goalsAgainstHome.value) / 2;
    baselineSource = 'derived_from_teams';
    baselineSample = Math.min(goalsForHome.sample, goalsForAway.sample);
    if (!(baselineHome > 0) || !(baselineAway > 0)) {
      return rejection(REJECT.INSUFFICIENT_DATA, { reason: 'baseline could not be derived' });
    }
  }

  /* --- strengths ----------------------------------------------------- */
  const attackHome = numbers.clamp(goalsForHome.value / baselineHome, settings.strengthMin, settings.strengthMax);
  const defenceAway = numbers.clamp(goalsAgainstAway.value / baselineAway, settings.strengthMin, settings.strengthMax);
  const attackAway = numbers.clamp(goalsForAway.value / baselineAway, settings.strengthMin, settings.strengthMax);
  const defenceHome = numbers.clamp(goalsAgainstHome.value / baselineHome, settings.strengthMin, settings.strengthMax);

  const recencyHomeFor = recencyFactor(homeLast5, homeAll, 'avgGoalsFor', settings);
  const recencyHomeAgainst = recencyFactor(homeLast5, homeAll, 'avgGoalsAgainst', settings);
  const recencyAwayFor = recencyFactor(awayLast5, awayAll, 'avgGoalsFor', settings);
  const recencyAwayAgainst = recencyFactor(awayLast5, awayAll, 'avgGoalsAgainst', settings);

  let lambdaHome = baselineHome * attackHome * defenceAway * recencyHomeFor.factor * recencyAwayAgainst.factor;
  let lambdaAway = baselineAway * attackAway * defenceHome * recencyAwayFor.factor * recencyHomeAgainst.factor;

  /* --- head to head (only with a real, sufficient sample) ------------- */
  const h2h = context.h2h || { available: false };
  let h2hApplied = false;
  if (h2h.available && num(h2h.sample, 0) >= settings.h2hMinMeetings && num(h2h.avgTotalGoals, 0) > 0) {
    const modelTotal = lambdaHome + lambdaAway;
    const blendedTotal = modelTotal * (1 - settings.h2hWeight) + num(h2h.avgTotalGoals, modelTotal) * settings.h2hWeight;
    const scale = modelTotal > 0 ? blendedTotal / modelTotal : 1;
    lambdaHome *= scale;
    lambdaAway *= scale;
    h2hApplied = true;
  }

  /* --- injuries (only when the API returned reliable data) ------------ */
  const injuries = context.injuries || { available: false };
  let injuryFactor = 1;
  if (injuries.available) {
    const missing = num(injuries.home, 0) + num(injuries.away, 0);
    injuryFactor = numbers.clamp(1 - missing * settings.injuryImpactPerPlayer, 1 - settings.injuryMaxImpact, 1);
    lambdaHome *= injuryFactor;
    lambdaAway *= injuryFactor;
  }

  lambdaHome = numbers.clamp(lambdaHome, 0.05, 6);
  lambdaAway = numbers.clamp(lambdaAway, 0.05, 6);

  /* --- probabilities -------------------------------------------------- */
  const poissonProbability = numbers.probabilityOverGoals(lambdaHome, lambdaAway, 1.5, 12, num(settings.dixonColesRho, 0));
  if (poissonProbability === null) return rejection(REJECT.INSUFFICIENT_DATA, { reason: 'model could not be evaluated' });

  // historical Over 1.5 frequency of both teams (real matches)
  const homeOver15 = num(homeAll && homeAll.over15Rate, null);
  const awayOver15 = num(awayAll && awayAll.over15Rate, null);
  let historyProbability = null;
  if (homeOver15 !== null && awayOver15 !== null) {
    const wHome = num(homeAll.matchesPlayed, 1);
    const wAway = num(awayAll.matchesPlayed, 1);
    historyProbability = ((homeOver15 * wHome + awayOver15 * wAway) / (wHome + wAway)) / 100;
  }

  let modelProbability;
  let probabilitySource;
  if (historyProbability !== null) {
    const wP = settings.poissonWeight;
    const wH = settings.historyWeight;
    modelProbability = (poissonProbability * wP + historyProbability * wH) / (wP + wH);
    probabilitySource = 'poisson+history';
  } else {
    modelProbability = poissonProbability;
    probabilitySource = 'poisson';
  }
  modelProbability = numbers.clamp(modelProbability, 0, 1);

  const marketProbability = 1 / num(odds.oddDecimal, 0);

  return {
    eligible: true,
    rejectReason: null,
    modelProbability: numbers.round(modelProbability, 4),
    poissonProbability: numbers.round(poissonProbability, 4),
    historyProbability: historyProbability === null ? null : numbers.round(historyProbability, 4),
    marketProbability: numbers.round(marketProbability, 4),
    probabilitySource,
    expectedGoalsHome: numbers.round(lambdaHome, 3),
    expectedGoalsAway: numbers.round(lambdaAway, 3),
    expectedTotalGoals: numbers.round(lambdaHome + lambdaAway, 3),
    features: {
      baselineHome: numbers.round(baselineHome, 3),
      baselineAway: numbers.round(baselineAway, 3),
      baselineSource,
      baselineSample,
      attackHome: numbers.round(attackHome, 3),
      defenceHome: numbers.round(defenceHome, 3),
      attackAway: numbers.round(attackAway, 3),
      defenceAway: numbers.round(defenceAway, 3),
      goalsForHome: numbers.round(goalsForHome.value, 3),
      goalsAgainstHome: numbers.round(goalsAgainstHome.value, 3),
      goalsForAway: numbers.round(goalsForAway.value, 3),
      goalsAgainstAway: numbers.round(goalsAgainstAway.value, 3),
      homeSample,
      awaySample,
      homeVenueSample: num(homeVenue && homeVenue.matchesPlayed, 0),
      awayVenueSample: num(awayVenue && awayVenue.matchesPlayed, 0),
      homeOver15Rate: homeOver15,
      awayOver15Rate: awayOver15,
      homeOver25Rate: num(homeAll && homeAll.over25Rate, null),
      awayOver25Rate: num(awayAll && awayAll.over25Rate, null),
      homeCleanSheetRate: num(homeAll && homeAll.cleanSheetRate, null),
      awayCleanSheetRate: num(awayAll && awayAll.cleanSheetRate, null),
      homeFailedToScoreRate: num(homeAll && homeAll.failedToScoreRate, null),
      awayFailedToScoreRate: num(awayAll && awayAll.failedToScoreRate, null),
      homeFormString: homeAll ? homeAll.formString : null,
      awayFormString: awayAll ? awayAll.formString : null,
      homeTotalGoalsStddev: num(homeAll && homeAll.totalGoalsStddev, null),
      awayTotalGoalsStddev: num(awayAll && awayAll.totalGoalsStddev, null),
      homeDaysSinceLastMatch: homeDaysSince,
      awayDaysSinceLastMatch: awayDaysSince,
      recencyHomeFor: numbers.round(recencyHomeFor.factor, 3),
      recencyAwayFor: numbers.round(recencyAwayFor.factor, 3),
      leagueOver15Rate: num(leagueEnv.over15Rate, null),
      leagueAvgTotalGoals: num(leagueEnv.avgTotalGoals, null),
      leagueSample: baselineSource === 'league' ? baselineSample : num(leagueEnv.sampleMatches, 0),
      h2hApplied,
      h2hSample: num(h2h.sample, 0),
      h2hOver15Rate: num(h2h.over15Rate, null),
      injuriesAvailable: Boolean(injuries.available),
      injuriesHome: injuries.available ? num(injuries.home, 0) : null,
      injuriesAway: injuries.available ? num(injuries.away, 0) : null,
      injuryFactor: numbers.round(injuryFactor, 4),
      odds: num(odds.oddDecimal, null),
      oddsAgeMinutes: num(odds.ageMinutes, null),
      bookmaker: odds.bookmakerName || null,
      bookmakersOffering: num(odds.bookmakersOffering, null),
    },
  };
}

module.exports = { analyze, DEFAULTS, REJECT };
