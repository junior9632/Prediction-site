'use strict';

/**
 * CONTEXT SERVICE — assembles the real evidence bundle used by the
 * prediction engine for every candidate fixture.
 *
 * Everything here is read from the local database (which is filled from
 * API-Football) or fetched from API-Football for a bounded shortlist.
 * Missing evidence stays missing: it is reported as unavailable and lowers
 * data quality, it is never replaced by a made-up number.
 */

const db = require('../database/queries');
const statsService = require('./statsService');
const time = require('../utils/time');
const logger = require('../utils/logger');
const { ApiFootballUnavailable } = require('./apiFootball');

const log = logger.child('context');

/** Convert a stored `team_form` row into the feature shape the model uses. */
function teamFormFromRow(row) {
  if (!row) return null;
  const played = Number(row.matches_played) || 0;
  if (!played) return { matchesPlayed: 0, sufficient: false };
  const pct = (n) => Math.round(((Number(n) || 0) / played) * 10000) / 100;
  return {
    teamId: Number(row.team_id),
    scope: row.scope,
    windowMatches: Number(row.window_matches),
    matchesPlayed: played,
    goalsFor: Number(row.goals_for),
    goalsAgainst: Number(row.goals_against),
    avgGoalsFor: Number(row.avg_goals_for),
    avgGoalsAgainst: Number(row.avg_goals_against),
    over15Hits: Number(row.over15_hits),
    over15Rate: Number(row.over15_rate),
    over25Hits: Number(row.over25_hits),
    over25Rate: pct(row.over25_hits),
    cleanSheets: Number(row.clean_sheets),
    cleanSheetRate: pct(row.clean_sheets),
    failedToScore: Number(row.failed_to_score),
    failedToScoreRate: pct(row.failed_to_score),
    wins: Number(row.wins),
    draws: Number(row.draws),
    losses: Number(row.losses),
    formString: row.form_string || null,
    totalGoalsStddev: row.total_goals_stddev === null ? null : Number(row.total_goals_stddev),
    lastMatchAt: row.last_match_at,
    sufficient: true,
  };
}

/** League row -> environment feature object. */
function leagueEnvFromRow(row) {
  if (!row) return { sufficient: false, sampleMatches: 0 };
  const sample = Number(row.sample_matches) || 0;
  if (row.avg_total_goals === null || sample < 10) return { sufficient: false, sampleMatches: sample };
  return {
    sufficient: true,
    sampleMatches: sample,
    avgTotalGoals: Number(row.avg_total_goals),
    avgHomeGoals: Number(row.avg_home_goals),
    avgAwayGoals: Number(row.avg_away_goals),
    over15Rate: Number(row.over15_rate),
  };
}

/**
 * Build every context bundle for a list of fixtures.
 *
 * @param {Array} fixtures normalised fixture rows
 * @param {object} options
 * @param {object} options.settings          engine settings
 * @param {Set|Array} [options.deepFixtureIds] fixtures that get h2h + injuries
 * @param {object} [options.api]             API client (only used for injuries)
 * @param {Date} [options.now]
 * @returns {Promise<Map<number, object>>}
 */
async function buildContexts(fixtures, options = {}) {
  const settings = options.settings || {};
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  const window = Number(settings.formWindowMatches) || 10;
  const windows = [5, window].filter((v, i, a) => a.indexOf(v) === i);
  const deepSource =
    options.deepFixtureIds instanceof Set ? [...options.deepFixtureIds] : options.deepFixtureIds || [];
  const deepIds = new Set(deepSource.map(Number));
  const contexts = new Map();
  const counters = { formsComputed: 0, leagueRefreshed: 0, h2hLoaded: 0, injuryChecks: 0 };

  const teamIds = [...new Set(fixtures.flatMap((f) => [Number(f.homeTeamId), Number(f.awayTeamId)]).filter((v) => Number.isFinite(v) && v > 0))];
  const leagueIds = [...new Set(fixtures.map((f) => Number(f.leagueId)).filter((v) => Number.isFinite(v) && v > 0))];

  /* ---------------- team form ---------------- */
  const formMap = new Map(); // `${teamId}:${scope}:${window}` -> features
  const scopes = ['all', 'home', 'away'];
  for (const scope of scopes) {
    for (const w of windows) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await db.getTeamForms(teamIds, scope, w);
      for (const row of rows) formMap.set(`${row.team_id}:${scope}:${w}`, teamFormFromRow(row));
    }
  }

  // teams with no stored form -> compute now from stored finished fixtures
  const missing = teamIds.filter((id) => !formMap.has(`${id}:all:${window}`));
  if (missing.length) {
    const before = time.startOfUtcDay(now);
    const bounded = missing.slice(0, Number(settings.formRefreshLimit) || 120);
    // eslint-disable-next-line no-await-in-loop
    await statsService.refreshTeamForms(bounded, { before, windows, scopes });
    counters.formsComputed = bounded.length;
    for (const scope of scopes) {
      for (const w of windows) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await db.getTeamForms(bounded, scope, w);
        for (const row of rows) formMap.set(`${row.team_id}:${scope}:${w}`, teamFormFromRow(row));
      }
    }
    if (missing.length > bounded.length) {
      log.warn('form refresh bounded', { missing: missing.length, computed: bounded.length });
    }
  }

  /* ---------------- league goal environment ---------------- */
  const leagueRows = await db.getAllLeagues();
  const leagueMap = new Map(leagueRows.map((r) => [Number(r.id), r]));
  const leagueEnvs = new Map();
  for (const id of leagueIds) {
    let env = leagueEnvFromRow(leagueMap.get(id));
    if (!env.sufficient) {
      // eslint-disable-next-line no-await-in-loop
      const fresh = await statsService.refreshLeagueEnvironment(id, { before: time.startOfUtcDay(now), limit: 300 });
      counters.leagueRefreshed += 1;
      if (fresh && fresh.sufficient) env = fresh;
    }
    leagueEnvs.set(id, env);
  }

  /* ---------------- h2h + injuries (shortlist only) ---------------- */
  const injuryLimit = Number(settings.injuryFetchLimit) || 25;
  let injuryCalls = 0;

  for (const fixture of fixtures) {
    const homeId = Number(fixture.homeTeamId);
    const awayId = Number(fixture.awayTeamId);
    const form = {
      home: {
        all: formMap.get(`${homeId}:all:${window}`) || { matchesPlayed: 0, sufficient: false },
        venue: formMap.get(`${homeId}:home:${window}`) || { matchesPlayed: 0, sufficient: false },
        last5: formMap.get(`${homeId}:all:5`) || { matchesPlayed: 0, sufficient: false },
      },
      away: {
        all: formMap.get(`${awayId}:all:${window}`) || { matchesPlayed: 0, sufficient: false },
        venue: formMap.get(`${awayId}:away:${window}`) || { matchesPlayed: 0, sufficient: false },
        last5: formMap.get(`${awayId}:all:5`) || { matchesPlayed: 0, sufficient: false },
      },
      before: fixture.kickoffAt,
    };

    const context = {
      form,
      leagueEnv: leagueEnvs.get(Number(fixture.leagueId)) || { sufficient: false, sampleMatches: 0 },
      h2h: { available: false, sample: 0 },
      injuries: { available: false, home: null, away: null },
    };

    const isDeep = deepIds.size === 0 || deepIds.has(Number(fixture.id));
    if (isDeep) {
      // eslint-disable-next-line no-await-in-loop
      const h2h = await statsService.getH2H(
        { id: fixture.id, homeTeamId: homeId, awayTeamId: awayId, kickoffAt: fixture.kickoffAt },
        { minSample: Number(settings.h2hMinMeetings) || 3 }
      );
      context.h2h = h2h;
      if (h2h.available) counters.h2hLoaded += 1;

      if (options.api && settings.enableInjuriesApi && injuryCalls < injuryLimit) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const injuries = await statsService.getInjuriesForFixture(
            { id: fixture.id, homeTeamId: homeId, awayTeamId: awayId },
            { api: options.api, enabled: true }
          );
          context.injuries = injuries;
          injuryCalls += 1;
          counters.injuryChecks += 1;
        } catch (err) {
          if (err instanceof ApiFootballUnavailable) {
            log.warn('injury enrichment stopped: API unavailable');
          } else {
            log.warn('injury enrichment failed', { fixtureId: fixture.id, message: err.message });
          }
        }
      }
    }

    contexts.set(Number(fixture.id), context);
  }

  return { contexts, counters };
}

module.exports = { buildContexts, teamFormFromRow, leagueEnvFromRow };
