'use strict';

/**
 * STATISTICS SERVICE — form, league goal environment, head-to-head and injuries.
 *
 * All numbers are derived from fixtures actually stored in the database
 * (synced from API-Football). When the sample is too small the function
 * returns null so the caller reports DATA UNAVAILABLE instead of inventing
 * a statistic.
 */

const db = require('../database/queries');
const numbers = require('../utils/numbers');
const logger = require('../utils/logger');

const log = logger.child('stats');

const MIN_FORM_SAMPLE = 5; // below this the model refuses to estimate
const MIN_H2H_SAMPLE = 3;

/* ---------------------------------------------------------------------- */
/* team form                                                               */
/* ---------------------------------------------------------------------- */

/**
 * Pure form calculation.
 * @param {Array} matches finished matches, most recent first
 *        {id, kickoff_at, home_team_id, away_team_id, goals_home, goals_away}
 * @param {number} teamId
 * @param {'all'|'home'|'away'} scope
 * @param {number} windowMatches
 */
function computeTeamForm(matches, teamId, scope = 'all', windowMatches = 10) {
  const list = (matches || [])
    .filter((m) => Number.isInteger(m.goals_home) && Number.isInteger(m.goals_away))
    .filter((m) => Number(m.home_team_id) === Number(teamId) || Number(m.away_team_id) === Number(teamId))
    .filter((m) => (scope === 'all' ? true : scope === 'home' ? Number(m.home_team_id) === Number(teamId) : Number(m.away_team_id) === Number(teamId)))
    .slice(0, windowMatches);

  const played = list.length;
  if (!played) {
    return {
      teamId: Number(teamId),
      scope,
      windowMatches,
      matchesPlayed: 0,
      sufficient: false,
    };
  }

  let goalsFor = 0;
  let goalsAgainst = 0;
  let over15Hits = 0;
  let over25Hits = 0;
  let cleanSheets = 0;
  let failedToScore = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  const totals = [];
  const formChars = [];

  for (const m of list) {
    const isHome = Number(m.home_team_id) === Number(teamId);
    const gf = isHome ? m.goals_home : m.goals_away;
    const ga = isHome ? m.goals_away : m.goals_home;
    const total = m.goals_home + m.goals_away;

    goalsFor += gf;
    goalsAgainst += ga;
    totals.push(total);
    if (total >= 2) over15Hits += 1;
    if (total >= 3) over25Hits += 1;
    if (ga === 0) cleanSheets += 1;
    if (gf === 0) failedToScore += 1;
    if (gf > ga) { wins += 1; formChars.push('W'); }
    else if (gf === ga) { draws += 1; formChars.push('D'); }
    else { losses += 1; formChars.push('L'); }
  }

  return {
    teamId: Number(teamId),
    scope,
    windowMatches,
    matchesPlayed: played,
    sufficient: played >= MIN_FORM_SAMPLE,
    goalsFor,
    goalsAgainst,
    avgGoalsFor: numbers.round(goalsFor / played, 3),
    avgGoalsAgainst: numbers.round(goalsAgainst / played, 3),
    avgTotalGoals: numbers.round(numbers.mean(totals) ?? 0, 3),
    over15Hits,
    over15Rate: numbers.round((over15Hits / played) * 100, 2),
    over25Hits,
    over25Rate: numbers.round((over25Hits / played) * 100, 2),
    cleanSheets,
    cleanSheetRate: numbers.round((cleanSheets / played) * 100, 2),
    failedToScore,
    failedToScoreRate: numbers.round((failedToScore / played) * 100, 2),
    wins,
    draws,
    losses,
    formString: formChars.reverse().join(''), // most recent last
    totalGoalsStddev: numbers.round(numbers.stddev(totals) ?? 0, 3),
    lastMatchAt: list[0] ? list[0].kickoff_at : null,
    totals,
  };
}

/** Recompute + store form rows for a set of teams (scopes: all/home/away). */
async function refreshTeamForms(teamIds, options = {}) {
  const before = options.before || new Date();
  const windows = options.windows || [5, 10];
  const scopes = options.scopes || ['all', 'home', 'away'];
  const ids = [...new Set((teamIds || []).map(Number).filter(Number.isFinite))];
  const forms = new Map();

  for (const teamId of ids) {
    const maxWindow = Math.max(...windows);
    // eslint-disable-next-line no-await-in-loop
    const matches = await db.getRecentFinishedByTeam(teamId, before, maxWindow, 'all');
    for (const scope of scopes) {
      for (const window of windows) {
        const form = computeTeamForm(matches, teamId, scope, window);
        forms.set(`${teamId}:${scope}:${window}`, form);
        if (!form.matchesPlayed) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.upsertTeamForm({
          teamId,
          scope,
          windowMatches: window,
          matchesPlayed: form.matchesPlayed,
          goalsFor: form.goalsFor,
          goalsAgainst: form.goalsAgainst,
          avgGoalsFor: form.avgGoalsFor,
          avgGoalsAgainst: form.avgGoalsAgainst,
          over15Hits: form.over15Hits,
          over15Rate: form.over15Rate,
          over25Hits: form.over25Hits,
          cleanSheets: form.cleanSheets,
          failedToScore: form.failedToScore,
          wins: form.wins,
          draws: form.draws,
          losses: form.losses,
          formString: form.formString,
          totalGoalsStddev: form.totalGoalsStddev,
          lastMatchAt: form.lastMatchAt,
        });
      }
    }
  }
  return forms;
}

/**
 * Form for one fixture, using ONLY matches played before its kickoff
 * (no future-data leakage). Falls back to computing on the fly when the
 * stored form rows are missing or older than the kickoff.
 */
async function getFixtureForm(fixture, options = {}) {
  const windowMatches = options.windowMatches || 10;
  const before = fixture.kickoffAt || fixture.kickoff_at || new Date();
  const homeId = Number(fixture.homeTeamId || fixture.home_team_id);
  const awayId = Number(fixture.awayTeamId || fixture.away_team_id);

  const [homeMatches, awayMatches, homeVenueMatches, awayVenueMatches] = await Promise.all([
    db.getRecentFinishedByTeam(homeId, before, windowMatches, 'all'),
    db.getRecentFinishedByTeam(awayId, before, windowMatches, 'all'),
    db.getRecentFinishedByTeam(homeId, before, windowMatches, 'home'),
    db.getRecentFinishedByTeam(awayId, before, windowMatches, 'away'),
  ]);

  return {
    home: {
      all: computeTeamForm(homeMatches, homeId, 'all', windowMatches),
      venue: computeTeamForm(homeVenueMatches, homeId, 'home', windowMatches),
      last5: computeTeamForm(homeMatches, homeId, 'all', 5),
    },
    away: {
      all: computeTeamForm(awayMatches, awayId, 'all', windowMatches),
      venue: computeTeamForm(awayVenueMatches, awayId, 'away', windowMatches),
      last5: computeTeamForm(awayMatches, awayId, 'all', 5),
    },
    before,
  };
}

/* ---------------------------------------------------------------------- */
/* league goal environment                                                 */
/* ---------------------------------------------------------------------- */

/** Pure calculation of a league's scoring environment from finished matches. */
function computeLeagueEnvironment(rows) {
  const matches = (rows || [])
    .filter((r) => Number.isInteger(Number(r.goals_home)) && Number.isInteger(Number(r.goals_away)) && r.goals_home !== null)
    .map((r) => ({ home: Number(r.goals_home), away: Number(r.goals_away) }));
  if (matches.length < 10) return { sufficient: false, sampleMatches: matches.length };

  const totals = matches.map((m) => m.home + m.away);
  const over15 = totals.filter((t) => t >= 2).length;
  return {
    sufficient: true,
    sampleMatches: matches.length,
    avgTotalGoals: numbers.round(numbers.mean(totals) ?? 0, 3),
    avgHomeGoals: numbers.round(numbers.mean(matches.map((m) => m.home)) ?? 0, 3),
    avgAwayGoals: numbers.round(numbers.mean(matches.map((m) => m.away)) ?? 0, 3),
    over15Rate: numbers.round((over15 / matches.length) * 100, 2),
    totalGoalsStddev: numbers.round(numbers.stddev(totals) ?? 0, 3),
  };
}

async function refreshLeagueEnvironment(leagueId, options = {}) {
  const before = options.before || new Date();
  const rows = await db.getLeagueFinishedMatches(leagueId, before, options.limit || 300);
  const env = computeLeagueEnvironment(rows);
  if (env.sufficient) {
    await db.updateLeagueGoalEnvironment(leagueId, {
      avgTotalGoals: env.avgTotalGoals,
      avgHomeGoals: env.avgHomeGoals,
      avgAwayGoals: env.avgAwayGoals,
      over15Rate: env.over15Rate,
      sampleMatches: env.sampleMatches,
    });
  }
  return env;
}

async function getLeagueEnvironments(leagueIds, options = {}) {
  const out = new Map();
  for (const id of new Set((leagueIds || []).map(Number).filter(Number.isFinite))) {
    if (options.refresh) {
      // eslint-disable-next-line no-await-in-loop
      out.set(id, await refreshLeagueEnvironment(id, options));
    } else {
      // eslint-disable-next-line no-await-in-loop
      const row = await db.getLeagueById(id);
      out.set(
        id,
        row && row.avg_total_goals !== null
          ? {
              sufficient: Number(row.sample_matches) >= 10,
              sampleMatches: Number(row.sample_matches),
              avgTotalGoals: Number(row.avg_total_goals),
              avgHomeGoals: Number(row.avg_home_goals),
              avgAwayGoals: Number(row.avg_away_goals),
              over15Rate: Number(row.over15_rate),
            }
          : { sufficient: false, sampleMatches: Number(row?.sample_matches || 0) }
      );
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* head to head                                                            */
/* ---------------------------------------------------------------------- */

function computeH2H(rows, homeId, awayId, minSample = MIN_H2H_SAMPLE) {
  const meetings = (rows || [])
    .filter((r) => Number.isInteger(Number(r.goals_home)) && r.goals_home !== null && r.goals_away !== null)
    .slice(0, 10);
  if (meetings.length < minSample) {
    return { available: false, sample: meetings.length };
  }
  const totals = meetings.map((m) => Number(m.goals_home) + Number(m.goals_away));
  const over15 = totals.filter((t) => t >= 2).length;
  const over25 = totals.filter((t) => t >= 3).length;
  return {
    available: true,
    sample: meetings.length,
    over15Hits: over15,
    over15Rate: numbers.round((over15 / meetings.length) * 100, 2),
    over25Rate: numbers.round((over25 / meetings.length) * 100, 2),
    avgTotalGoals: numbers.round(numbers.mean(totals) ?? 0, 3),
    totalGoalsStddev: numbers.round(numbers.stddev(totals) ?? 0, 3),
    matches: meetings.map((m) => ({
      fixtureId: Number(m.id),
      kickoffAt: m.kickoff_at,
      homeTeamId: Number(m.home_team_id),
      awayTeamId: Number(m.away_team_id),
      goalsHome: Number(m.goals_home),
      goalsAway: Number(m.goals_away),
    })),
  };
}

async function getH2H(fixture, options = {}) {
  const homeId = Number(fixture.homeTeamId || fixture.home_team_id);
  const awayId = Number(fixture.awayTeamId || fixture.away_team_id);
  const before = fixture.kickoffAt || fixture.kickoff_at || new Date();
  const rows = await db.getH2HFixtures(homeId, awayId, before, options.limit || 10);
  return computeH2H(rows, homeId, awayId, options.minSample || MIN_H2H_SAMPLE);
}

/**
 * Optional API enrichment: pull the official head-to-head history and store
 * those fixtures so the local calculation has a bigger sample.
 */
async function syncH2HFromApi(homeId, awayId, options = {}) {
  const api = options.api;
  if (!api) throw new Error('statsService.syncH2HFromApi requires an api client');
  const fixtureService = require('./fixtureService');
  const data = await api.getHeadToHead(homeId, awayId, options.last || 10);
  let written = 0;
  for (const item of data.response || []) {
    const normalized = fixtureService.normalizeFixture(item, options.now || new Date());
    if (!normalized) continue;
    // eslint-disable-next-line no-await-in-loop
    await fixtureService.persistFixture(normalized, options.now || new Date());
    written += 1;
  }
  return { rowsWritten: written, endpointCalls: 1 };
}

/* ---------------------------------------------------------------------- */
/* injuries                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Injury counts for a fixture. `available:false` means the API did not give
 * us reliable injury data for this fixture — callers must then report
 * DATA UNAVAILABLE and must NOT assume "no injuries".
 */
function parseInjuries(payloadItems, fixture) {
  const items = Array.isArray(payloadItems) ? payloadItems : [];
  const homeId = Number(fixture.homeTeamId || fixture.home_team_id);
  const awayId = Number(fixture.awayTeamId || fixture.away_team_id);
  if (!items.length) return { available: false, home: null, away: null, players: [] };

  let home = 0;
  let away = 0;
  const players = [];
  for (const item of items) {
    const teamId = Number(item?.team?.id);
    const player = {
      teamId,
      teamName: item?.team?.name || null,
      playerId: item?.player?.id ?? null,
      playerName: item?.player?.name || null,
      type: item?.player?.type || null,
      reason: item?.player?.reason || null,
    };
    players.push(player);
    if (teamId === homeId) home += 1;
    else if (teamId === awayId) away += 1;
  }
  return { available: true, home, away, players };
}

async function getInjuriesForFixture(fixture, options = {}) {
  const api = options.api;
  if (!api || options.enabled === false) return { available: false, home: null, away: null };
  try {
    const data = await api.getInjuriesByFixture(Number(fixture.id));
    return parseInjuries(data.response || [], fixture);
  } catch (err) {
    log.warn('injuries unavailable', { fixtureId: fixture.id, message: err.message });
    return { available: false, home: null, away: null, error: err.message };
  }
}

module.exports = {
  MIN_FORM_SAMPLE,
  MIN_H2H_SAMPLE,
  computeTeamForm,
  refreshTeamForms,
  getFixtureForm,
  computeLeagueEnvironment,
  refreshLeagueEnvironment,
  getLeagueEnvironments,
  computeH2H,
  getH2H,
  syncH2HFromApi,
  parseInjuries,
  getInjuriesForFixture,
};
