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
const {
  ApiFootballUnavailable,
  UNAVAILABLE_REASONS,
  describeUnavailable,
  reasonInfo,
  unavailableMessage,
  nextDailyReset,
  apiFootball: defaultApi,
} = require('./apiFootball');

const log = logger.child('sync');

/**
 * Build the payload every sync job returns (and logs) when the provider could
 * not be used. The reason comes from the client (`describeUnavailable`), so the
 * dashboard can say WHY instead of the same sentence for every cause.
 */
function unavailableResult(job, err, extra = {}) {
  const info = describeUnavailable(err);
  return {
    job,
    status: 'DATA_SOURCE_UNAVAILABLE',
    error: err.message,
    reason: info.reason,
    label: info.label,
    hint: info.hint,
    httpStatus: info.httpStatus,
    resetAt: info.resetAt,
    ...extra,
  };
}

/**
 * The daily request budget (used / limit) as the provider reported it, for the
 * `requests_used` / `requests_limit` columns of `api_sync_logs`. Those columns
 * existed but were never filled, so no operator could see how close a plan was
 * to its ceiling. Empty object when the provider has not told us yet.
 */
function quotaLogFields(source) {
  const quota = source && typeof source.quotaState === 'function' ? source.quotaState() : source;
  if (!quota || !quota.known) return {};
  const limitDay = quota.limitDay === undefined ? null : quota.limitDay;
  let used = quota.current === undefined ? null : quota.current;
  if (used === null && limitDay !== null && quota.remaining !== null && quota.remaining !== undefined) {
    used = Math.max(0, limitDay - quota.remaining);
  }
  const fields = {};
  if (used !== null) fields.requestsUsed = used;
  if (limitDay !== null) fields.requestsLimit = limitDay;
  return fields;
}

/**
 * A numeric setting with a floor, where 0 is a REAL value (not "unset").
 * `Number(x) || fallback` silently turns an operator's explicit 0 into the
 * default — sync_days_ahead: 0 must mean "today only", not "today + 2 days"
 * (each extra day is another request against the daily budget).
 */
function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Requests the operator keeps for a manual generation (0 = no reserve). */
function quotaReserve(settings = {}) {
  const n = Number(settings.apiQuotaReserve);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The daily budget an EARLIER run recorded in `api_sync_logs`.
 *
 * Every cron invocation is a new process, so the client's in-memory quota state
 * starts empty — without this, a plan whose day is spent would answer every
 * hourly run with "DATA SOURCE TEMPORARILY UNAVAILABLE" all night instead of
 * pausing until the 00:00 UTC reset. Only a record from the CURRENT UTC day
 * counts: an older one describes a counter that has since reset.
 *
 * @returns {Promise<null|object>} a quotaState()-shaped object, or null when no usable record exists
 */
async function lastRecordedBudget(now = new Date()) {
  try {
    const rows = (await db.getApiSyncLogs(20)) || [];
    const dayStart = time.startOfUtcDay(now).getTime();
    for (const row of rows) {
      if (row.requests_used === null || row.requests_used === undefined) continue;
      if (row.requests_limit === null || row.requests_limit === undefined) continue;
      const at = time.toDate(row.finished_at || row.started_at);
      if (!at || at.getTime() < dayStart) return null; // that budget belongs to a day that has already reset
      const limit = Number(row.requests_limit);
      const used = Number(row.requests_used);
      const remaining = Math.max(0, limit - used);
      // Shaped like the client's quotaState() so the same consumers (log fields,
      // the pause message, the payload) work with either source.
      return {
        known: true,
        limitDay: limit,
        current: used,
        remaining,
        source: 'api_sync_logs',
        checkedAt: at.toISOString(),
        exhausted: remaining <= 0,
        exhaustedReason: `an earlier run recorded ${used} of ${limit} requests used today`,
        resetsAt: nextDailyReset(now).toISOString(),
      };
    }
    return null;
  } catch (err) {
    log.warn('unable to read the last recorded request budget', { message: err.message });
    return null;
  }
}

/**
 * Background jobs pause BEFORE they eat the whole day's request budget: the
 * manual "GENERATE TODAY'S TICKET" action must always have room to run. Only
 * acts on quota information the provider really reported — never on a guess.
 *
 * @returns {Promise<null|{message: string, hint: string, quota: object}>}
 */
async function quotaPause(api, settings = {}, options = {}) {
  const reserve = quotaReserve(settings);
  if (reserve <= 0) return null;
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();

  const live = typeof api.quotaState === 'function' ? api.quotaState() : null;
  const quota =
    live && live.known && live.remaining !== null && live.remaining !== undefined ? live : await lastRecordedBudget(now);
  if (!quota || quota.remaining === null || quota.remaining === undefined) return null;
  if (quota.remaining > reserve) return null;

  const info = reasonInfo(UNAVAILABLE_REASONS.QUOTA_RESERVED);
  return {
    quota,
    // Short enough for the `message` column (VARCHAR(500)) — the full fix is
    // carried in the returned payload and in `reasonInfo(QUOTA_RESERVED).hint`.
    message: `REQUEST BUDGET RESERVED · ${quota.remaining} of ${quota.limitDay ?? '?'} request(s) left today (api_quota_reserve=${reserve}) — background sync paused so a manual generation can still run (resets ${quota.resetsAt})`,
    hint: info.hint,
  };
}

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

  /**
   * Optional head-to-head enrichment for the day's fixtures.
   *
   * QUOTA: this used to issue one request per fixture on EVERY run (up to 40
   * hourly = ~960 requests/day), which on a small API-Football plan exhausts the
   * daily budget before the operator can generate a ticket. Enrichment is only
   * useful when the local sample is still too small to score with, so that is
   * now the condition — plus a hard per-run ceiling (h2h_sync_max_calls).
   */
  let h2hCalls = 0;
  let h2hSkippedSufficient = 0;
  if (settings.enableH2hApi && api && api.configured && api.isAvailable()) {
    const limit = Math.max(0, Math.min(fixtures.length, Number(options.h2hLimit) || Number(settings.h2hSyncMaxCalls) || 20));
    const minSample = Number(settings.h2hMinMeetings) || 3;
    for (const f of fixtures) {
      if (h2hCalls >= limit) break;
      if (!f.home_team_id || !f.away_team_id) continue;
      try {
        // The local sample decides: a meeting history we already hold is never
        // re-requested (no invented data, no wasted quota).
        // eslint-disable-next-line no-await-in-loop
        const local = await statsService.getH2H(
          { homeTeamId: Number(f.home_team_id), awayTeamId: Number(f.away_team_id), kickoffAt: f.kickoff_at },
          { minSample, limit: 10 }
        );
        if (local && local.available) {
          h2hSkippedSufficient += 1;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await statsService.syncH2HFromApi(Number(f.home_team_id), Number(f.away_team_id), { api, last: 6, now: new Date() });
        h2hCalls += 1;
      } catch (err) {
        if (err instanceof ApiFootballUnavailable) {
          log.warn('h2h enrichment stopped: API unavailable', { reason: (err.details || {}).reason || null });
          break;
        }
        log.warn('h2h enrichment failed', { fixtureId: f.id, message: err.message });
      }
    }
  }

  return {
    teams: teamIds.size,
    leagues: leagueRefreshed,
    fixtures: fixtures.length,
    h2hCalls,
    h2hSkippedSufficient,
  };
}

/**
 * The calendar day the sync jobs call "today", as observed in `sync_timezone`.
 *
 * Storage is always UTC; this only decides which API day windows are pulled, so
 * a host whose operators work in, say, Africa/Lagos stops syncing "yesterday"
 * during the last hour of their evening. `sync_timezone` defaults to `UTC`,
 * which reproduces the original behaviour exactly. An unknown zone is reported
 * and falls back to UTC rather than silently moving the window.
 */
function resolveSyncZone(settings = {}) {
  const requested = String(settings.syncTimezone || 'UTC').trim() || 'UTC';
  if (time.isValidTimeZone(requested)) return { zone: requested, valid: true };
  log.warn('sync_timezone is not a known timezone — falling back to UTC', { requested });
  return { zone: 'UTC', valid: false, requested };
}

/** The date anchor for a sync run: UTC midnight of the zone's calendar day. */
function syncAnchor(now, zone) {
  return time.zoneDateAnchor(now || new Date(), zone) || time.startOfUtcDay(now || new Date());
}

/** Fixtures for today + the configured number of days ahead (+ history). */
async function syncFixtures(options = {}) {
  const settings = options.settings || (await settingsService.getEngineSettings());
  const api = options.api || defaultApi;
  const trigger = options.trigger || 'manual';
  const handle = await logService.startSync('fixtures', trigger);

  try {
    // Never spend the operator's last requests on a background job.
    const paused = await quotaPause(api, settings, { now: options.now });
    if (paused) {
      await logService.finishSync(handle, {
        status: 'SKIPPED',
        message: paused.message,
        ...quotaLogFields(paused.quota),
      });
      return { job: 'fixtures', status: 'SKIPPED', reason: UNAVAILABLE_REASONS.QUOTA_RESERVED, label: reasonInfo(UNAVAILABLE_REASONS.QUOTA_RESERVED).label, hint: paused.hint, quota: paused.quota };
    }

    const { zone, valid, requested } = resolveSyncZone(settings);
    const anchor = syncAnchor(options.now, zone);
    const upcoming = await fixtureService.syncUpcoming({
      api,
      daysAhead: numberOr(settings.syncDaysAhead, 2),
      leagueIds: settings.syncLeagues.length ? settings.syncLeagues : null,
      now: anchor,
    });

    let history = { rowsWritten: 0, endpointCalls: 0, skippedFresh: 0 };
    if (options.includeHistory !== false) {
      history = await fixtureService.syncHistory({
        api,
        days: numberOr(settings.syncHistoryDays, 25),
        leagueIds: settings.syncLeagues.length ? settings.syncLeagues : null,
        now: anchor,
        // History is a backfill, not a live feed: a day whose stored data is
        // still fresh is not requested again (history_refresh_minutes).
        refreshMinutes: Number(settings.historyRefreshMinutes) || 0,
      });
    }

    const modelInputs = await refreshModelInputs(anchor, { settings, api });

    await logService.finishSync(handle, {
      status: 'SUCCESS',
      endpointCalls: upcoming.endpointCalls + history.endpointCalls,
      rowsWritten: upcoming.rowsWritten + history.rowsWritten,
      ...quotaLogFields(api),
      message: `upcoming=${upcoming.rowsWritten} history=${history.rowsWritten}${history.skippedFresh ? ` (${history.skippedFresh} fresh day(s) skipped)` : ''} teams=${modelInputs.teams} leagues=${modelInputs.leagues} h2h=${modelInputs.h2hCalls} tz=${zone}${valid ? '' : ` (unknown: ${requested})`}`,
    });
    return {
      job: 'fixtures',
      upcoming: upcoming.rowsWritten,
      history: history.rowsWritten,
      historySkippedFresh: history.skippedFresh || 0,
      endpointCalls: upcoming.endpointCalls + history.endpointCalls,
      syncTimezone: zone,
      syncTimezoneValid: valid,
      syncedFromDate: time.toMysqlDate(anchor),
      modelInputs,
    };
  } catch (err) {
    await logService.finishSync(handle, {
      status: 'FAILED',
      errorDetail: err.message,
      message: err instanceof ApiFootballUnavailable ? unavailableMessage(err) : 'fixture sync failed',
      ...quotaLogFields(api),
    });
    if (err instanceof ApiFootballUnavailable) return unavailableResult('fixtures', err);
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
    const paused = await quotaPause(api, settings, { now: options.now });
    if (paused) {
      await logService.finishSync(handle, {
        status: 'SKIPPED',
        message: paused.message,
        ...quotaLogFields(paused.quota),
      });
      return { job: 'odds', status: 'SKIPPED', reason: UNAVAILABLE_REASONS.QUOTA_RESERVED, label: reasonInfo(UNAVAILABLE_REASONS.QUOTA_RESERVED).label, hint: paused.hint, quota: paused.quota };
    }

    const days = numberOr(settings.syncDaysAhead, 2);
    const { zone, valid, requested } = resolveSyncZone(settings);
    const anchor = syncAnchor(options.now, zone);
    let totalRows = 0;
    let totalCalls = 0;
    const perDate = [];
    const skipped = [];
    for (let i = 0; i <= days; i += 1) {
      const date = time.addDays(anchor, i);
      let res;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = await oddsService.syncOddsForDate(date, {
          api,
          settings,
          maxPages: Number(settings.oddsSyncMaxPages) || 12,
          now: options.now,
        });
      } catch (err) {
        // A single date being rejected (e.g. no odds window for it) must not
        // throw away the dates that do work. Credential problems, quota and
        // outages still abort the whole job. Any non-auth 4xx rejection is
        // treated as specific to that date, even when the provider (or an older
        // client) omits the structured `reason` field.
        const d = (err && err.details) || {};
        const status = Number(d.status);
        const authRejected = status === 401 || status === 403;
        const dateOnlyRejection =
          err instanceof ApiFootballUnavailable &&
          !authRejected &&
          Number.isFinite(status) &&
          status >= 400 &&
          status < 500;
        if (!dateOnlyRejection) throw err;
        log.warn('odds sync skipped a date rejected by the provider', { date: time.toMysqlDate(date), message: err.message });
        skipped.push({ date: time.toMysqlDate(date), error: err.message, details: d });
        continue;
      }
      totalRows += res.rowsWritten;
      totalCalls += res.endpointCalls;
      perDate.push(res);
    }
    if (!perDate.length && skipped.length) {
      const first = skipped[0] || {};
      const firstDetails = first.details || {};
      throw new ApiFootballUnavailable(first.error || 'API-Football request rejected', {
        reason: 'REQUEST_REJECTED',
        status: firstDetails.status || null,
        endpoint: firstDetails.endpoint || null,
        errors: firstDetails.errors || null,
        hint: firstDetails.hint || null,
        skipped,
      });
    }
    await logService.finishSync(handle, {
      status: 'SUCCESS',
      endpointCalls: totalCalls,
      rowsWritten: totalRows,
      ...quotaLogFields(api),
      message: `dates=${perDate.length} rows=${totalRows} tz=${zone}${valid ? '' : ` (unknown: ${requested})`}${skipped.length ? ` skipped=${skipped.length}` : ''}`,
    });
    return {
      job: 'odds',
      skippedDates: skipped,
      rowsWritten: totalRows,
      endpointCalls: totalCalls,
      syncTimezone: zone,
      syncTimezoneValid: valid,
      perDate,
    };
  } catch (err) {
    await logService.finishSync(handle, {
      status: 'FAILED',
      errorDetail: err.message,
      message: err instanceof ApiFootballUnavailable ? unavailableMessage(err) : 'odds sync failed',
      ...quotaLogFields(api),
    });
    if (err instanceof ApiFootballUnavailable) {
      const d = err.details || {};
      return unavailableResult('odds', err, {
        ...(d.status ? { httpStatus: d.status } : {}),
      });
    }
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
    const paused = await quotaPause(api, settings, { now: options.now });
    if (paused) {
      await logService.finishSync(handle, {
        status: 'SKIPPED',
        message: paused.message,
        ...quotaLogFields(paused.quota),
      });
      return { job: 'results', status: 'SKIPPED', reason: UNAVAILABLE_REASONS.QUOTA_RESERVED, label: reasonInfo(UNAVAILABLE_REASONS.QUOTA_RESERVED).label, hint: paused.hint, quota: paused.quota };
    }

    const { zone, valid, requested } = resolveSyncZone(settings);
    const anchor = syncAnchor(options.now, zone);
    const res = await resultService.syncResults({
      api,
      days: Number(options.days) || Math.min(7, Number(settings.syncHistoryDays) || 7),
      now: anchor,
      settings,
    });
    await logService.finishSync(handle, {
      status: 'SUCCESS',
      endpointCalls: res.endpointCalls,
      rowsWritten: res.resultsRecorded + res.selectionsSettled,
      ...quotaLogFields(api),
      // `checked` explains a SUCCESS with all zeros: nothing was awaiting a
      // result, so the job made no upstream call in the first place.
      message: `results=${res.resultsRecorded} settled=${res.selectionsSettled} tickets=${res.ticketsUpdated} checked=${res.fixturesChecked} tz=${zone}${valid ? '' : ` (unknown: ${requested})`}`,
    });
    return { job: 'results', syncTimezone: zone, syncTimezoneValid: valid, ...res };
  } catch (err) {
    await logService.finishSync(handle, {
      status: 'FAILED',
      errorDetail: err.message,
      message: err instanceof ApiFootballUnavailable ? unavailableMessage(err) : 'result sync failed',
      ...quotaLogFields(api),
    });
    if (err instanceof ApiFootballUnavailable) return unavailableResult('results', err);
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
  const quotaPaused = Object.values(results).some((r) => r && r.status === 'SKIPPED');
  return { ...results, dataSourceAvailable: !unavailable, quotaPaused };
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
  // The most recent run that actually recorded the provider's daily budget.
  const lastBudget = syncs.find((s) => s.requests_used !== null && s.requests_used !== undefined) || null;
  return {
    configured: api.configured,
    keyConfigured: api.configured, // never expose the key itself
    ...breaker,
    quota,
    plan,
    host: api.host,
    /** Daily request budget as the provider reported it (never invented). */
    dailyBudget: lastBudget
      ? {
          used: Number(lastBudget.requests_used),
          limit: lastBudget.requests_limit === null || lastBudget.requests_limit === undefined ? null : Number(lastBudget.requests_limit),
          at: time.toIso(lastBudget.started_at),
          source: 'api_sync_logs.requests_used',
        }
      : null,
    recentSyncs: syncs.map((s) => ({
      id: Number(s.id),
      job: s.job,
      status: s.status,
      trigger: s.trigger_source,
      message: s.message,
      errorDetail: s.error_detail ? String(s.error_detail).slice(0, 300) : null,
      requestsUsed: s.requests_used === null || s.requests_used === undefined ? null : Number(s.requests_used),
      requestsLimit: s.requests_limit === null || s.requests_limit === undefined ? null : Number(s.requests_limit),
      durationMs: s.duration_ms === null ? null : Number(s.duration_ms),
      startedAt: s.started_at,
    })),
  };
}

module.exports = { syncFixtures, syncOdds, syncResults, syncAll, refreshModelInputs, getApiStatus };
