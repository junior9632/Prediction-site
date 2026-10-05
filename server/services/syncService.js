'use strict';

/**
 * SYNC SERVICE — background data synchronisation.
 *
 * Allowed to run automatically (cron / internal scheduler):
 *   fixtures, odds, statistics, results.
 *
 * FORBIDDEN here, by design: creating or publishing a prediction ticket.
 * This module deliberately does not import ticketService at all — ticket
 * generation is reachable only from an authenticated admin action.
 */

const db = require('../database/queries');
const time = require('../utils/time');
const logger = require('../utils/logger');
const settingsService = require('./settingsService');
const fixtureService = require('./fixtureService');
const oddsService = require('./oddsService');
const statsService = require('./statsService');
const resultService = require('./resultService');
const logService = require('./logService');
const { ApiFootballUnavailable, apiFootball: defaultApi } = require('./apiFootball');

const log = logger.child('sync');

/** Keep the model inputs (team form + league environment) up to date. */
async function refreshModelInputs(ticketDate, options = {}) {
  const settings = options.settings || (await settingsService.getEngineSettings());
  const api = options.api || defaultApi;
  const start = time.startOfUtcDay(ticketDate);
  const end = time.addDays(start, 1);
  const fixtures = await db.getPlayableFixturesBetween(start, end, settings.syncLeagues.length ? settings.syncLeagues : null);

  const teamIds = new Set();
  const leagueIds = new Set();
  for (const f of fixtures) {
    if (f.home_team_id) teamIds.add(Number(f.home_team_id));
    if (f.away_team_id) teamIds.add(Number(f.away_team_id));
    if (f.league_id) leagueIds.add(Number(f.league_id));
  }

  // Form is always computed STRICTLY BEFORE the ticket date, so a fixture can
  // never see its own day's results (no future-data leakage).
  await statsService.refreshTeamForms([...teamIds], {
    before: start,
    windows: [5, Number(settings.formWindowMatches) || 10],
  });

  let leagueRefreshed = 0;
  for (const leagueId of leagueIds) {
    // eslint-disable-next-line no-await-in-loop
    await statsService.refreshLeagueEnvironment(leagueId, { before: start });
    leagueRefreshed += 1;
  }

  // optional head-to-head enrichment for the day's fixtures (bounded)
  let h2hCalls = 0;
  if (settings.enableH2hApi && api && api.configured && api.isAvailable()) {
    const limit = Math.min(fixtures.length, Number(options.h2hLimit) || 40);
    for (const f of fixtures.slice(0, limit)) {
      if (!f.home_team_id || !f.away_team_id) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await statsService.syncH2HFromApi(Number(f.home_team_id), Number(f.away_team_id), { api, last: 6, now: new Date() });
        h2hCalls += 1;
      } catch (err) {
        if (err instanceof ApiFootballUnavailable) {
          log.warn('h2h enrichment stopped: API unavailable');
          break;
        }
        log.warn('h2h enrichment failed', { fixtureId: f.id, message: err.message });
      }
    }
  }

  return { teams: teamIds.size, leagues: leagueRefreshed, fixtures: fixtures.length, h2hCalls };
}

/** Fixtures for today + the configured number of days ahead (+ history). */
async function syncFixtures(options = {}) {
  const settings = options.settings || (await settingsService.getEngineSettings());
  const api = options.api || defaultApi;
  const trigger = options.trigger || 'manual';
  const handle = await logService.startSync('fixtures', trigger);

  try {
    const upcoming = await fixtureService.syncUpcoming({
      api,
      daysAhead: Number(settings.syncDaysAhead) || 2,
      leagueIds: settings.syncLeagues.length ? settings.syncLeagues : null,
      now: options.now,
    });

    let history = { rowsWritten: 0, endpointCalls: 0 };
    if (options.includeHistory !== false) {
      history = await fixtureService.syncHistory({
        api,
        days: Number(settings.syncHistoryDays) || 25,
        leagueIds: settings.syncLeagues.length ? settings.syncLeagues : null,
        now: options.now,
      });
    }

    const modelInputs = await refreshModelInputs(options.now || new Date(), { settings, api });

    await logService.finishSync(handle, {
      status: 'SUCCESS',
      endpointCalls: upcoming.endpointCalls + history.endpointCalls,
      rowsWritten: upcoming.rowsWritten + history.rowsWritten,
      message: `upcoming=${upcoming.rowsWritten} history=${history.rowsWritten} teams=${modelInputs.teams} leagues=${modelInputs.leagues}`,
    });
    return {
      job: 'fixtures',
      upcoming: upcoming.rowsWritten,
      history: history.rowsWritten,
      endpointCalls: upcoming.endpointCalls + history.endpointCalls,
      modelInputs,
    };
  } catch (err) {
    await logService.finishSync(handle, {
      status: 'FAILED',
      errorDetail: err.message,
      message: err instanceof ApiFootballUnavailable ? 'DATA SOURCE TEMPORARILY UNAVAILABLE' : 'fixture sync failed',
    });
    if (err instanceof ApiFootballUnavailable) return { job: 'fixtures', status: 'DATA_SOURCE_UNAVAILABLE', error: err.message };
    throw err;
  }
}

/** Odds for today + days ahead. One bulk request per page per date. */
async function syncOdds(options = {}) {
  const settings = options.settings || (await settingsService.getEngineSettings());
  const api = options.api || defaultApi;
  const trigger = options.trigger || 'manual';
  const handle = await logService.startSync('odds', trigger);

  try {
    const days = Number(settings.syncDaysAhead) || 2;
    let totalRows = 0;
    let totalCalls = 0;
    const perDate = [];
    for (let i = 0; i <= days; i += 1) {
      const date = time.addDays(options.now || new Date(), i);
      // eslint-disable-next-line no-await-in-loop
      const res = await oddsService.syncOddsForDate(date, {
        api,
        settings,
        maxPages: Number(settings.oddsSyncMaxPages) || 12,
        now: options.now,
      });
      totalRows += res.rowsWritten;
      totalCalls += res.endpointCalls;
      perDate.push(res);
    }
    await logService.finishSync(handle, {
      status: 'SUCCESS',
      endpointCalls: totalCalls,
      rowsWritten: totalRows,
      message: `dates=${perDate.length} rows=${totalRows}`,
    });
    return { job: 'odds', rowsWritten: totalRows, endpointCalls: totalCalls, perDate };
  } catch (err) {
    await logService.finishSync(handle, {
      status: 'FAILED',
      errorDetail: err.message,
      message: err instanceof ApiFootballUnavailable ? 'DATA SOURCE TEMPORARILY UNAVAILABLE' : 'odds sync failed',
    });
    if (err instanceof ApiFootballUnavailable) return { job: 'odds', status: 'DATA_SOURCE_UNAVAILABLE', error: err.message };
    throw err;
  }
}

/** Final scores + settlement of pending picks. */
async function syncResults(options = {}) {
  const settings = options.settings || (await settingsService.getEngineSettings());
  const api = options.api || defaultApi;
  const trigger = options.trigger || 'manual';
  const handle = await logService.startSync('results', trigger);

  try {
    const res = await resultService.syncResults({
      api,
      days: Number(options.days) || Math.min(7, Number(settings.syncHistoryDays) || 7),
      now: options.now,
    });
    await logService.finishSync(handle, {
      status: 'SUCCESS',
      endpointCalls: res.endpointCalls,
      rowsWritten: res.resultsRecorded + res.selectionsSettled,
      message: `results=${res.resultsRecorded} settled=${res.selectionsSettled} tickets=${res.ticketsUpdated}`,
    });
    return { job: 'results', ...res };
  } catch (err) {
    await logService.finishSync(handle, {
      status: 'FAILED',
      errorDetail: err.message,
      message: err instanceof ApiFootballUnavailable ? 'DATA SOURCE TEMPORARILY UNAVAILABLE' : 'result sync failed',
    });
    if (err instanceof ApiFootballUnavailable) return { job: 'results', status: 'DATA_SOURCE_UNAVAILABLE', error: err.message };
    throw err;
  }
}

/** Run every allowed sync job in sequence (used by cron scripts). */
async function syncAll(options = {}) {
  const results = {};
  results.fixtures = await syncFixtures(options);
  results.odds = await syncOdds(options);
  results.results = await syncResults(options);
  const unavailable = Object.values(results).some((r) => r && r.status === 'DATA_SOURCE_UNAVAILABLE');
  return { ...results, dataSourceAvailable: !unavailable };
}

/** Health / quota information for the admin "API Status" panel. */
async function getApiStatus(options = {}) {
  const api = options.api || defaultApi;
  const breaker = api.breakerState();
  let quota = breaker.quota;
  let plan = null;
  if (api.configured && api.isAvailable() && options.probe !== false) {
    try {
      const status = await api.getStatus();
      if (status) {
        quota = status.requests ? { current: status.requests.current, limit_day: status.requests.limit_day } : quota;
        plan = {
          subscription: status.subscription ? status.subscription.name || status.subscription.plan : null,
          active: Boolean(status.active ?? true),
        };
      }
    } catch (err) {
      log.warn('api status probe failed', { message: err.message });
    }
  }
  const syncs = await logService.recentSyncs(12);
  return {
    configured: api.configured,
    keyConfigured: api.configured, // never expose the key itself
    ...breaker,
    quota,
    plan,
    host: api.host,
    recentSyncs: syncs.map((s) => ({
      id: Number(s.id),
      job: s.job,
      status: s.status,
      trigger: s.trigger_source,
      message: s.message,
      durationMs: s.duration_ms === null ? null : Number(s.duration_ms),
      startedAt: s.started_at,
    })),
  };
}

module.exports = { syncFixtures, syncOdds, syncResults, syncAll, refreshModelInputs, getApiStatus };
