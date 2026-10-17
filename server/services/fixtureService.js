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
  if (!item || !item.fixture || !positiveId(item.fixture.id)) return null;

  const f = item.fixture;
  const league = item.league || {};
  const teams = item.teams || {};
  const home = teams.home || {};
  const away = teams.away || {};
  const goals = item.goals || {};
  const score = item.score || {};
  const fulltime = score.fulltime || {};

  // API-Football's timestamp is UNIX SECONDS, not JavaScript milliseconds.
  const apiTimestamp = unixTimestamp(f.timestamp);
  const kickoffAt = time.toDate(f.date) || apiTimestamp;
  if (!kickoffAt) return null;
  const statusShort = fixtureStatus.normalize(f.status && f.status.short);
  const statusLong = f.status && f.status.long ? String(f.status.long) : null;
  const isFinished = fixtureStatus.isFinished(statusShort);

  // `goals` includes extra time for AET/PEN. Never use it to settle the
  // 90-minute market: absent full-time evidence must remain unavailable.
  const goalsHome = pickGoal(fulltime.home, statusShort === 'FT' ? goals.home : null);
  const goalsAway = pickGoal(fulltime.away, statusShort === 'FT' ? goals.away : null);

  return {
    id: Number(f.id),
    leagueId: positiveId(league.id),
    leagueSeason: positiveId(league.season),
    leagueRound: league.round || null,
    leagueName: league.name || null,
    leagueCountry: league.country || null,
    leagueLogo: league.logo || null,
    homeTeamId: positiveId(home.id),
    awayTeamId: positiveId(away.id),
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
    apiTimestamp: apiTimestamp || kickoffAt,
    fetchedAt: now,
  };
}

function positiveId(value) {
  if (!['number', 'string'].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function unixTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!['number', 'string'].includes(typeof value)) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds > 0 ? time.toDate(seconds * 1000) : null;
  return time.toDate(value);
}

function pickGoal(...values) {
  for (const v of values) {
    if (!['number', 'string'].includes(typeof v) || String(v).trim() === '') continue;
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
  if (options.beforeRequest && !(await options.beforeRequest())) return { date: dateStr, apiResults: 0, rowsWritten: 0, endpointCalls: 0, skippedQuota: true };
  const data = await api.getFixturesByDate(dateStr);
  const items = data.response || [];
  let written = 0;
  let skippedInvalid = 0;
  for (const item of items) {
    const normalized = normalizeFixture(item, now);
    if (!normalized) { skippedInvalid += 1; continue; }
    if (options.leagueIds && options.leagueIds.length && !options.leagueIds.includes(normalized.leagueId)) continue;
    // eslint-disable-next-line no-await-in-loop
    await persistFixture(normalized, now);
    written += 1;
  }
  log.info('fixtures synced', { date: dateStr, items: items.length, written, skippedInvalid });
  return { date: dateStr, apiResults: items.length, rowsWritten: written, skippedInvalid, endpointCalls: 1 };
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
    if (res.skippedQuota) break;
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
  const anchor = time.toDate(options.dateAnchor) || now;
  return syncRange(anchor, time.addDays(anchor, daysAhead), { ...options, now });
}

/** Every UTC day from `from` to `to` inclusive. */
function daysBetween(from, to) {
  const days = [];
  let cursor = time.startOfUtcDay(from);
  const end = time.startOfUtcDay(to);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor);
    cursor = time.addDays(cursor, 1);
  }
  return days;
}

/**
 * The days of the history window whose stored copy is already fresh enough.
 *
 * A finished match does not change, so re-requesting 25 days of history on
 * every cron run spends the plan's daily request budget for nothing. Only the
 * days that are missing or older than `refreshMinutes` are pulled again.
 */
async function freshHistoryDays(days, options = {}) {
  const refreshMinutes = Number(options.refreshMinutes);
  if (!Number.isFinite(refreshMinutes) || refreshMinutes <= 0 || !days.length) return new Set();
  const now = options.nowReference ? time.toDate(options.nowReference) || new Date() : new Date();
  const cutoff = new Date(now.getTime() - refreshMinutes * 60 * 1000);
  const rows = await db.getFixtureFetchTimes(days[0], time.addDays(days[days.length - 1], 1));
  const fresh = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const last = time.toDate(row.last_fetched_at);
    if (!last || Number.isNaN(last.getTime())) continue;
    if (last.getTime() >= cutoff.getTime()) fresh.add(String(row.day));
  }
  return fresh;
}

/**
 * Historical finished matches — the data the form/league models are built on.
 *
 * `refreshMinutes` (settings `history_refresh_minutes`) makes this incremental:
 * day windows fetched more recently than that are skipped, so the history
 * backfill costs one request per day per window instead of one per day per run.
 * 0 keeps the original behaviour (every day, every run).
 */
async function syncHistory(options = {}) {
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  const days = Number.isInteger(options.days) ? options.days : 21;
  const anchor = time.toDate(options.dateAnchor) || now;
  const dates = daysBetween(time.addDays(anchor, -days), time.addDays(anchor, -1));
  if (!dates.length) return { results: [], rowsWritten: 0, endpointCalls: 0, skippedFresh: 0 };

  const fresh = await freshHistoryDays(dates, {
    refreshMinutes: options.refreshMinutes,
    nowReference: options.nowReference || now,
  });
  const wanted = dates.filter((date) => !fresh.has(time.toMysqlDate(date)));
  if (!wanted.length) {
    log.info('history sync skipped: every day is still fresh', { days: dates.length, refreshMinutes: options.refreshMinutes });
    return { results: [], rowsWritten: 0, endpointCalls: 0, skippedFresh: dates.length };
  }

  const results = [];
  for (const date of wanted) {
    // eslint-disable-next-line no-await-in-loop
    const result = await syncDate(date, { ...options, now });
    if (result.skippedQuota) break;
    results.push(result);
  }
  return {
    results,
    rowsWritten: results.reduce((a, r) => a + r.rowsWritten, 0),
    endpointCalls: results.length,
    skippedFresh: dates.length - wanted.length,
  };
}

/** Refresh status/score for a specific set of fixtures (max ~15 ids per call). */
async function syncFixturesByIds(fixtureIds, options = {}) {
  const api = options.api;
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  if (!api) throw new Error('fixtureService.syncFixturesByIds requires an api client');
  const ids = [...new Set((fixtureIds || []).map(positiveId).filter(Boolean))];
  if (!ids.length) return { rowsWritten: 0, endpointCalls: 0 };

  const chunks = [];
  for (let i = 0; i < ids.length; i += 15) chunks.push(ids.slice(i, i + 15));

  let written = 0;
  let endpointCalls = 0;
  for (const chunk of chunks) {
    if (options.beforeRequest && !(await options.beforeRequest())) break;
    // eslint-disable-next-line no-await-in-loop
    const data = await api.getFixturesByIds(chunk);
    endpointCalls += 1;
    for (const item of data.response || []) {
      const normalized = normalizeFixture(item, now);
      if (!normalized) continue;
      // eslint-disable-next-line no-await-in-loop
      await persistFixture(normalized, now);
      written += 1;
    }
  }
  return { rowsWritten: written, endpointCalls };
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
