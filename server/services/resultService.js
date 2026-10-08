'use strict';

/**
 * RESULT SERVICE — settlement of Over 1.5 Goals picks.
 *
 * Rules (exactly like the bookmaker market, settled on the 90 minute score):
 *   total goals >= 2  -> WON
 *   total goals <= 1  -> LOST
 *   postponed         -> POSTPONED (leg is void)
 *   cancelled/abandoned/walkover -> VOID
 *
 * A result is only ever written when API-Football reports the fixture as
 * finished with a real score. Nothing is estimated, projected or invented.
 */

const db = require('../database/queries');
const decimal = require('../utils/decimal');
const time = require('../utils/time');
const logger = require('../utils/logger');
const fixtureStatus = require('../utils/fixtureStatus');
const fixtureService = require('./fixtureService');
const settingsService = require('./settingsService');
const { ApiFootballUnavailable, apiFootball: defaultApi } = require('./apiFootball');

const log = logger.child('results');

const OUTCOME = { WON: 'WON', LOST: 'LOST', VOID: 'VOID', POSTPONED: 'POSTPONED', PENDING: 'PENDING' };

/**
 * Settlement mode — the ONLY supported value is `fulltime` (the 90 minute
 * score, exactly like the bookmaker market). `results_settle_mode` is locked in
 * code, but the value is read back and asserted here as well: if a row is ever
 * edited straight in the database to something the engine cannot honour,
 * settlement refuses loudly instead of quietly settling against a scoreline the
 * market does not use.
 */
const SUPPORTED_SETTLE_MODES = ['fulltime'];

function assertSettleMode(settings) {
  const mode = String((settings && settings.resultsSettleMode) || 'fulltime').toLowerCase();
  if (!SUPPORTED_SETTLE_MODES.includes(mode)) {
    const err = new Error(`Unsupported results_settle_mode "${mode}" — only ${SUPPORTED_SETTLE_MODES.join(', ')} is valid`);
    err.code = 'SETTLE_MODE_UNSUPPORTED';
    throw err;
  }
  return mode;
}

/** The settle mode actually in force (read from the settings service). */
async function currentSettleMode() {
  return assertSettleMode(await settingsService.getEngineSettings());
}

/**
 * Pure settlement rule for one finished fixture.
 * @returns {'WON'|'LOST'|'VOID'|'POSTPONED'|'PENDING'}
 */
function evaluateOver15({ statusShort, goalsHome, goalsAway }) {
  const status = fixtureStatus.normalize(statusShort);
  if (status === 'PST') return OUTCOME.POSTPONED;
  if (status === 'CANC' || status === 'ABD' || status === 'WO' || status === 'AWD') return OUTCOME.VOID;
  if (!fixtureStatus.isFinished(status)) return OUTCOME.PENDING;
  if (!Number.isInteger(goalsHome) || !Number.isInteger(goalsAway)) return OUTCOME.PENDING;
  const total = goalsHome + goalsAway;
  return total >= 2 ? OUTCOME.WON : OUTCOME.LOST;
}

/** Store the result row for a fixture (source is always the API). */
async function recordResult(fixtureRow, rawItem = null) {
  const goalsHome = fixtureRow.goals_home === null ? null : Number(fixtureRow.goals_home);
  const goalsAway = fixtureRow.goals_away === null ? null : Number(fixtureRow.goals_away);
  const total = goalsHome !== null && goalsAway !== null ? goalsHome + goalsAway : null;
  const outcome = evaluateOver15({
    statusShort: fixtureRow.status_short,
    goalsHome,
    goalsAway,
  });
  const settled = outcome !== OUTCOME.PENDING;

  await db.upsertResult({
    fixtureId: Number(fixtureRow.id),
    statusShort: fixtureRow.status_short || null,
    statusLong: fixtureRow.status_long || null,
    goalsHome,
    goalsAway,
    totalGoals: total,
    over15Result: settled ? outcome : null,
    settled: settled ? 1 : 0,
    settledAt: settled ? new Date() : null,
    rawJson: rawItem ? { fixture: rawItem.fixture || null, goals: rawItem.goals || null, score: rawItem.score || null } : null,
  });
  return { fixtureId: Number(fixtureRow.id), outcome, totalGoals: total, settled };
}

/** Recompute a ticket's result once its legs are settled. */
async function recomputeTicketResult(ticketId) {
  const selections = await db.getSelectionsByTicket(ticketId);
  if (!selections.length) return null;

  const results = selections.map((s) => s.result);
  const pending = results.filter((r) => r === OUTCOME.PENDING).length;
  const lost = results.filter((r) => r === OUTCOME.LOST).length;
  const won = results.filter((r) => r === OUTCOME.WON).length;
  const voided = results.filter((r) => r === OUTCOME.VOID || r === OUTCOME.POSTPONED).length;

  let ticketResult = OUTCOME.PENDING;
  if (pending === 0) {
    if (lost > 0) ticketResult = OUTCOME.LOST;
    else if (voided === results.length) ticketResult = OUTCOME.VOID;
    else if (won === results.length) ticketResult = OUTCOME.WON;
    else ticketResult = 'PARTIAL_VOID';
  } else if (lost > 0) {
    // the ticket can no longer win even though some legs are pending
    ticketResult = OUTCOME.LOST;
  }

  // effective odds after void legs are removed (odds-1.00 convention)
  const activeOdds = selections.filter((s) => s.result !== OUTCOME.VOID && s.result !== OUTCOME.POSTPONED);
  const settledOdds = activeOdds.length ? decimal.product(activeOdds.map((s) => s.odd_raw || s.odd_decimal)) : decimal.scaledFromNumber(1);

  await db.updateTicketResult(ticketId, {
    result: ticketResult,
    settledOdds: ticketResult === OUTCOME.PENDING ? null : decimal.format(settledOdds, 6),
    settledAt: ticketResult === OUTCOME.PENDING ? null : new Date(),
    resultNote:
      ticketResult === 'PARTIAL_VOID'
        ? `${voided} leg(s) void, remaining legs won`
        : ticketResult === OUTCOME.VOID
          ? 'every leg was void or postponed'
          : null,
  });

  return { ticketId, result: ticketResult, won, lost, voided, pending, settledOdds: decimal.format(settledOdds, 2) };
}

/** Settle every pending leg whose fixture is finished. */
async function settlePendingSelections(options = {}) {
  // Refuse an unsupported settlement mode before a single row is touched.
  assertSettleMode(options.settings || (await settingsService.getEngineSettings()));
  const api = options.api || defaultApi;
  const limit = Number(options.limit) || 200;
  const pending = await db.getPendingSelections(limit);
  const touchedTickets = new Set();
  const settled = [];

  // group by fixture so each fixture is refreshed once
  const fixtureIds = [...new Set(pending.map((p) => Number(p.fixture_id)))];
  if (fixtureIds.length && options.refreshFromApi !== false && api && api.configured) {
    try {
      await fixtureService.syncFixturesByIds(fixtureIds, { api, now: options.now || new Date() });
    } catch (err) {
      if (err instanceof ApiFootballUnavailable) {
        log.warn('result refresh skipped: API unavailable');
        return { settled: [], pending: pending.length, skipped: 'DATA_SOURCE_UNAVAILABLE' };
      }
      log.warn('result refresh failed', { message: err.message });
    }
  }

  for (const selection of pending) {
    // eslint-disable-next-line no-await-in-loop
    const fixtureRow = await db.getFixtureById(Number(selection.fixture_id));
    if (!fixtureRow) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await recordResult(fixtureRow);
    if (!result.settled) continue;

    // eslint-disable-next-line no-await-in-loop
    await db.updateSelectionResult(Number(selection.id), {
      result: result.outcome,
      finalHomeGoals: fixtureRow.goals_home,
      finalAwayGoals: fixtureRow.goals_away,
      finalTotalGoals: result.totalGoals,
      settledAt: new Date(),
    });
    touchedTickets.add(Number(selection.ticket_id));
    settled.push({ selectionId: Number(selection.id), fixtureId: result.fixtureId, outcome: result.outcome, totalGoals: result.totalGoals });
  }

  const ticketResults = [];
  for (const ticketId of touchedTickets) {
    // eslint-disable-next-line no-await-in-loop
    ticketResults.push(await recomputeTicketResult(ticketId));
  }

  return { settled, tickets: ticketResults, pending: pending.length };
}

/**
 * Sync results for a date range: refresh fixtures from the API, store results,
 * then settle any affected picks.
 */
async function syncResults(options = {}) {
  const settleMode = assertSettleMode(options.settings || (await settingsService.getEngineSettings()));
  const api = options.api || defaultApi;
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  const from = time.startOfUtcDay(options.from || time.addDays(now, -(Number(options.days) || 3)));
  const to = time.startOfUtcDay(options.to || now);

  const awaiting = await db.getFixturesAwaitingResult(from, time.addDays(to, 1), options.limit || 200);
  const ids = awaiting.map((f) => Number(f.id));
  let endpointCalls = 0;
  let rowsWritten = 0;

  if (ids.length) {
    const refreshed = await fixtureService.syncFixturesByIds(ids, { api, now });
    endpointCalls += refreshed.endpointCalls;
    rowsWritten += refreshed.rowsWritten;
  }

  const settledRows = [];
  for (const row of awaiting) {
    // eslint-disable-next-line no-await-in-loop
    const fresh = await db.getFixtureById(Number(row.id));
    if (!fresh) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await recordResult(fresh);
    if (result.settled) settledRows.push(result);
  }

  const settlement = await settlePendingSelections({ api, now, refreshFromApi: false });

  return {
    fixturesChecked: ids.length,
    endpointCalls,
    rowsWritten,
    resultsRecorded: settledRows.length,
    selectionsSettled: settlement.settled.length,
    ticketsUpdated: (settlement.tickets || []).length,
    settleMode,
  };
}

module.exports = {
  OUTCOME,
  SUPPORTED_SETTLE_MODES,
  assertSettleMode,
  currentSettleMode,
  evaluateOver15,
  recordResult,
  recomputeTicketResult,
  settlePendingSelections,
  syncResults,
};
