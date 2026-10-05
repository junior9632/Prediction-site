'use strict';

/**
 * FIXTURE SERVICE — turns API-Football fixture payloads into database rows.
 *
 * Everything stored here comes from the API. If a field is missing it stays
 * NULL ("DATA UNAVAILABLE") — it is never guessed or defaulted to a
 * plausible-looking value.
 */

const db = require('../database/queries');
const time = require('../utils/time');
const logger = require('../utils/logger');
const fixtureStatus = require('../utils/fixtureStatus');

const log = logger.child('fixtures');

/**
 * Normalise one API-Football fixture item.
 * Goals are the FULL TIME (90 minute) score — that is what an Over 1.5
 * goals market settles on, so extra time / penalties are kept separately.
 */
function normalizeFixture(item, now = new Date()) {
  if (!item || !item.fixture || item.fixture.id === undefined) return null;

  const f = item.fixture;
  const league = item.league || {};
  const teams = item.teams || {};
  const home = teams.home || {};
  const away = teams.away || {};
  const goals = item.goals || {};
  const score = item.score || {};
  const fulltime = score.fulltime || {};

  const kickoffAt = time.toDate(f.date || f.timestamp);
  const statusShort = fixtureStatus.normalize(f.status && f.status.short);
  const statusLong = f.status && f.status.long ? String(f.status.long) : null;
  const isFinished = fixtureStatus.isFinished(statusShort);

  const goalsHome = pickGoal(goals.home, fulltime.home);
  const goalsAway = pickGoal(goals.away, fulltime.away);

  return {
    id: Number(f.id),
    leagueId: league.id !== undefined && league.id !== null ? Number(league.id) : null,
    leagueSeason: league.season !== undefined && league.season !== null ? Number(league.season) : null,
    leagueRound: league.round || null,
    leagueName: league.name || null,
    leagueCountry: league.country || null,
    leagueLogo: league.logo || null,
    homeTeamId: home.id !== undefined && home.id !== null ? Number(home.id) : null,
    awayTeamId: away.id !== undefined && away.id !== null ? Number(away.id) : null,
    homeTeamName: home.name || null,
    awayTeamName: away.name || null,
    homeTeamLogo: home.logo || null,
    awayTeamLogo: away.logo || null,
    venueName: (f.venue && f.venue.name) || null,
    venueCity: (f.venue && f.venue.city) || null,
    referee: f.referee || null,
    kickoffAt,
    kickoffTz: f.timezone || null,
    statusLong,
    statusShort: statusShort || null,
    statusElapsed: f.status && Number.isFinite(f.status.elapsed) ? Number(f.status.elapsed) : null,
    isPlayable: fixtureStatus.isPlayable({ statusShort, kickoffAt }, now),
    isFinished,
    goalsHome: isFinished ? goalsHome : null,
    goalsAway: isFinished ? goalsAway : null,
    halftimeHome: pickGoal(score.halftime && score.halftime.home),
    halftimeAway: pickGoal(score.halftime && score.halftime.away),
    extraHome: pickGoal(score.extratime && score.extratime.home),
    extraAway: pickGoal(score.extratime && score.extratime.away),
    penaltyHome: pickGoal(score.penalty && score.penalty.home),
    penaltyAway: pickGoal(score.penalty && score.penalty.away),
    apiTimestamp: time.toDate(f.timestamp) || kickoffAt,
    fetchedAt: now,
  };
}

function pickGoal(...values) {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n < 100) return n;
  }
  return null;
}

/** Write league + teams + fixture for one normalised item. */
async function persistFixture(normalized, now = new Date()) {
  if (!normalized || !normalized.id) return false;

  if (normalized.leagueId) {
    await db.upsertLeague({
      id: normalized.leagueId,
      name: normalized.leagueName || `League ${normalized.leagueId}`,
      country: normalized.leagueCountry,
      logoUrl: normalized.leagueLogo,
      season: normalized.leagueSeason,
      syncedAt: now,
    });
  }
  if (normalized.homeTeamId) {
    await db.upsertTeam({
      id: normalized.homeTeamId,
      name: normalized.homeTeamName || `Team ${normalized.homeTeamId}`,
      logoUrl: normalized.homeTeamLogo,
      syncedAt: now,
    });
  }
  if (normalized.awayTeamId) {
    await db.upsertTeam({
      id: normalized.awayTeamId,
      name: normalized.awayTeamName || `Team ${normalized.awayTeamId}`,
      logoUrl: normalized.awayTeamLogo,
      syncedAt: now,
    });
  }
  await db.upsertFixture(normalized);
  return true;
}

/** Sync every fixture of one UTC date. One API request. */
async function syncDate(date, options = {}) {
  const api = options.api;
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  if (!api) throw new Error('fixtureService.syncDate requires an api client');

  const dateStr = time.toMysqlDate(date);
  const data = await api.getFixturesByDate(dateStr);
  const items = data.response || [];
  let written = 0;
  for (const item of items) {
    const normalized = normalizeFixture(item, now);
    if (!normalized) continue;
    if (options.leagueIds && options.leagueIds.length && !options.leagueIds.includes(normalized.leagueId)) continue;
    // eslint-disable-next-line no-await-in-loop
    await persistFixture(normalized, now);
    written += 1;
  }
  log.info('fixtures synced', { date: dateStr, items: items.length, written });
  return { date: dateStr, apiResults: items.length, rowsWritten: written, endpointCalls: 1 };
}

/** Sync a range of UTC dates (inclusive). */
async function syncRange(fromDate, toDate, options = {}) {
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  const results = [];
  let cursor = time.startOfUtcDay(fromDate);
  const end = time.startOfUtcDay(toDate);
  while (cursor.getTime() <= end.getTime()) {
    // eslint-disable-next-line no-await-in-loop
    const res = await syncDate(cursor, { ...options, now });
    results.push(res);
    cursor = time.addDays(cursor, 1);
  }
  return {
    results,
    rowsWritten: results.reduce((a, r) => a + r.rowsWritten, 0),
    endpointCalls: results.length,
  };
}

/** Upcoming fixtures (today + N days ahead) — the ticket candidate pool. */
async function syncUpcoming(options = {}) {
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  const daysAhead = Number.isInteger(options.daysAhead) ? options.daysAhead : 2;
  return syncRange(now, time.addDays(now, daysAhead), options);
}

/** Historical finished matches — the data the form/league models are built on. */
async function syncHistory(options = {}) {
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  const days = Number.isInteger(options.days) ? options.days : 21;
  return syncRange(time.addDays(now, -days), time.addDays(now, -1), options);
}

/** Refresh status/score for a specific set of fixtures (max ~15 ids per call). */
async function syncFixturesByIds(fixtureIds, options = {}) {
  const api = options.api;
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  if (!api) throw new Error('fixtureService.syncFixturesByIds requires an api client');
  const ids = (fixtureIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id));
  if (!ids.length) return { rowsWritten: 0, endpointCalls: 0 };

  const chunks = [];
  for (let i = 0; i < ids.length; i += 15) chunks.push(ids.slice(i, i + 15));

  let written = 0;
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const data = await api.getFixturesByIds(chunk);
    for (const item of data.response || []) {
      const normalized = normalizeFixture(item, now);
      if (!normalized) continue;
      // eslint-disable-next-line no-await-in-loop
      await persistFixture(normalized, now);
      written += 1;
    }
  }
  return { rowsWritten: written, endpointCalls: chunks.length };
}

/**
 * Candidate fixtures for a ticket date: playable, not started, inside the
 * date window. Read from the database only (already synced from the API).
 */
async function getCandidateFixtures(ticketDate, options = {}) {
  const start = time.startOfUtcDay(ticketDate);
  const end = time.addDays(start, 1);
  return db.getPlayableFixturesBetween(start, end, options.leagueIds || null);
}

/** DB row -> the compact fixture shape the odds validator expects. */
function toValidatorShape(row) {
  return {
    id: Number(row.id),
    kickoffAt: row.kickoff_at,
    statusShort: row.status_short,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    leagueId: row.league_id,
  };
}

module.exports = {
  normalizeFixture,
  persistFixture,
  syncDate,
  syncRange,
  syncUpcoming,
  syncHistory,
  syncFixturesByIds,
  getCandidateFixtures,
  toValidatorShape,
};
