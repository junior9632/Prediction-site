'use strict';

/**
 * ODDS SERVICE — extraction, validation and persistence of bookmaker prices.
 *
 * HARD RULES
 *  - the only tradable market is OVER 1.5 GOALS (goal line exactly 1.50)
 *  - a price is used EXACTLY as published (odd_raw is the untouched API string)
 *  - Over 2.5 / Under / half-time / team-total / handicap prices are rejected,
 *    never substituted for the missing Over 1.5 price
 *  - a price is only usable after passing all 14 validation checks
 *  - nothing here ever invents a bookmaker, a price or a fixture
 */

const db = require('../database/queries');
const decimal = require('../utils/decimal');
const time = require('../utils/time');
const logger = require('../utils/logger');
const fixtureStatus = require('../utils/fixtureStatus');
const config = require('../config');
const { ApiFootballUnavailable, apiFootball: defaultApi } = require('./apiFootball');

const log = logger.child('odds');

const MARKET_KEY = config.market.key; // 'over_1_5'
const MARKET_LABEL = config.market.label; // 'Over 1.5 Goals'
const GOAL_LINE = 1.5;
const SOURCE = 'api-football';

/** Every rejection reason the validator can produce. */
const REJECT = {
  FIXTURE_MISSING: 'FIXTURE_MISSING',
  FIXTURE_INVALID: 'FIXTURE_INVALID',
  FIXTURE_STARTED: 'FIXTURE_STARTED',
  FIXTURE_CANCELLED: 'FIXTURE_CANCELLED',
  FIXTURE_POSTPONED: 'FIXTURE_POSTPONED',
  FIXTURE_NOT_PLAYABLE: 'FIXTURE_NOT_PLAYABLE',
  MARKET_NOT_OVER_1_5: 'MARKET_NOT_OVER_1_5',
  MARKET_GOAL_LINE_MISMATCH: 'MARKET_GOAL_LINE_MISMATCH',
  MARKET_NOT_FULL_TIME: 'MARKET_NOT_FULL_TIME',
  MARKET_AMBIGUOUS: 'MARKET_AMBIGUOUS',
  BOOKMAKER_MISSING: 'BOOKMAKER_MISSING',
  ODDS_MISSING: 'ODDS_MISSING',
  ODDS_NOT_NUMERIC: 'ODDS_NOT_NUMERIC',
  ODDS_BELOW_MINIMUM: 'ODDS_BELOW_MINIMUM',
  ODDS_OUT_OF_RANGE: 'ODDS_OUT_OF_RANGE',
  ODDS_STALE: 'ODDS_STALE',
  ODDS_TIMESTAMP_INVALID: 'ODDS_TIMESTAMP_INVALID',
  ODDS_SOURCE_INVALID: 'ODDS_SOURCE_INVALID',
  ODDS_MANUALLY_MODIFIED: 'ODDS_MANUALLY_MODIFIED',
};

/* ---------------------------------------------------------------------- */
/* bet-name / value classification                                         */
/* ---------------------------------------------------------------------- */

const PERIOD_KEYWORDS = [
  '1st half', 'first half', '2nd half', 'second half', 'half time', 'halftime',
  'overtime', 'extra time', 'penalt', 'shootout', '1h ', ' 1h', '2h ', ' 2h',
];
const TEAM_SCOPE_KEYWORDS = ['home team', 'away team', 'team total', 'team goals', 'both teams', 'btts'];
const NON_GOAL_LINE_KEYWORDS = [
  'correct score', 'handicap', 'asian', 'corner', 'card', 'booking', 'player',
  'race to', 'double chance', 'match winner', 'winner', 'draw no bet', 'odd/even',
  'goal range', 'exact goal', 'highest scoring', 'clean sheet', 'method of victory',
  'first goal', 'last goal', 'ht/ft', 'half time/full time', 'to score',
];

const normalizeBetName = (raw) =>
  String(raw || '')
    .toLowerCase()
    .replace(/[_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeValue = (raw) =>
  String(raw || '')
    .toLowerCase()
    .replace(/,/g, '.')
    .replace(/\s+/g, ' ')
    .trim();

function extractLine(text) {
  const match = String(text || '').match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decide whether a bet group can ever contain the full-time Over 1.5 goals price.
 */
function classifyBetName(rawName) {
  const name = normalizeBetName(rawName);
  if (!name) return { allowed: false, reason: REJECT.MARKET_NOT_OVER_1_5 };

  if (PERIOD_KEYWORDS.some((k) => name.includes(k))) {
    return { allowed: false, reason: REJECT.MARKET_NOT_FULL_TIME };
  }
  if (TEAM_SCOPE_KEYWORDS.some((k) => name.includes(k))) {
    return { allowed: false, reason: REJECT.MARKET_NOT_FULL_TIME };
  }
  if (NON_GOAL_LINE_KEYWORDS.some((k) => name.includes(k))) {
    return { allowed: false, reason: REJECT.MARKET_NOT_OVER_1_5 };
  }

  const isOverUnderGroup = /over\s*\/\s*under|over under|over-under|^over$|^under$|\bover\b|\bunder\b/.test(name);
  const isTotalGoalsGroup = /total goals|goals total|goals over|over goals/.test(name);
  if (!isOverUnderGroup && !isTotalGoalsGroup) {
    return { allowed: false, reason: REJECT.MARKET_NOT_OVER_1_5 };
  }
  return { allowed: true, lineInName: extractLine(name) };
}

/**
 * Parse one odds value: direction (over/under) + goal line.
 * Anything ambiguous is rejected — we never guess a market.
 */
function parseOddsValue(rawValue, betInfo) {
  const value = normalizeValue(rawValue);
  if (!value) return { direction: null, line: null, issue: REJECT.MARKET_AMBIGUOUS };

  // a value combining both directions ("over 1.5 & under 2.5") is never used
  const hasOver = /^over\b|^o\s*\d|^o\d/.test(value);
  const hasUnder = /^under\b|^u\s*\d|^u\d/.test(value);
  if (hasOver && hasUnder) return { direction: null, line: null, issue: REJECT.MARKET_AMBIGUOUS };

  let direction = null;
  if (hasOver) direction = 'over';
  else if (hasUnder) direction = 'under';

  const lineInValue = extractLine(value.replace(/^(over|under|o|u)\s*/, ''));
  const line = lineInValue !== null ? lineInValue : null;

  // Direction-less numeric value ("1.5") is ambiguous unless the bet group
  // itself states the line AND the direction ("Over/Under 1.5" + "Over").
  if (!direction) {
    if (line === null && betInfo.lineInName !== null && /^over$|^under$/.test(value)) {
      return { direction: null, line: null, issue: REJECT.MARKET_AMBIGUOUS };
    }
    return { direction: null, line, issue: REJECT.MARKET_AMBIGUOUS };
  }

  if (line === null && betInfo.lineInName !== null && /^(over|under)$/.test(value)) {
    return { direction, line: betInfo.lineInName, issue: null };
  }
  if (line === null) return { direction, line: null, issue: REJECT.MARKET_AMBIGUOUS };

  return { direction, line, issue: null };
}

/* ---------------------------------------------------------------------- */
/* payload parsing                                                         */
/* ---------------------------------------------------------------------- */

/**
 * Turn one API-Football `/odds` response item into a flat list of parsed
 * entries. No validation happens here — parsing only.
 *
 * @param {object} payload API-Football odds item
 * @returns {{fixtureId:*, oddsUpdatedAt:Date|null, entries:Array}}
 */
function parseOddsPayload(payload) {
  const entries = [];
  if (!payload || typeof payload !== 'object') {
    return { fixtureId: null, oddsUpdatedAt: null, entries };
  }

  const fixtureId = payload.fixture && payload.fixture.id !== undefined ? payload.fixture.id : null;
  const oddsUpdatedAt = payload.update ? time.toDate(payload.update) : null;
  const bookmakers = Array.isArray(payload.bookmakers) ? payload.bookmakers : [];

  for (const bookmaker of bookmakers) {
    const bets = Array.isArray(bookmaker?.bets) ? bookmaker.bets : [];
    for (const bet of bets) {
      const betInfo = classifyBetName(bet?.name);
      const values = Array.isArray(bet?.values) ? bet.values : [];
      for (const item of values) {
        const parsedValue = parseOddsValue(item?.value, betInfo);
        entries.push({
          bookmakerId: bookmaker?.id ?? null,
          bookmakerName: bookmaker?.name ?? null,
          betName: String(bet?.name || ''),
          valueName: String(item?.value || ''),
          rawOdd: item?.odd === undefined || item?.odd === null ? null : String(item.odd),
          direction: parsedValue.direction,
          goalLine: parsedValue.line,
          periodOrScopeIssue: betInfo.allowed ? null : betInfo.reason,
          parseIssue: parsedValue.issue,
          oddsUpdatedAt,
        });
      }
    }
  }
  return { fixtureId, oddsUpdatedAt, entries };
}

/** Is this parsed entry claiming to be the full-time Over 1.5 goals market? */
function isOver15Entry(entry) {
  return (
    !entry.periodOrScopeIssue &&
    !entry.parseIssue &&
    entry.direction === 'over' &&
    typeof entry.goalLine === 'number' &&
    Math.abs(entry.goalLine - GOAL_LINE) < 1e-9
  );
}

/* ---------------------------------------------------------------------- */
/* the 14 point validation gate                                            */
/* ---------------------------------------------------------------------- */

/**
 * Validate ONE price against every rule. Returns
 * { ok:true, reason:null } or { ok:false, reason, detail }.
 *
 *  1 fixture exists          8 odds exist
 *  2 fixture is valid        9 odds numeric
 *  3 fixture not started    10 odds > 1.00
 *  4 not cancelled          11 odds fresh
 *  5 not postponed          12 valid timestamp
 *  6 market is Over 1.5     13 came from API-Football
 *  7 bookmaker exists       14 not manually modified
 *
 * @param {object} entry   parsed entry + {source, fetchedAt}
 * @param {object} fixture normalised fixture {id, kickoffAt, statusShort, homeTeamId, awayTeamId, leagueId}
 * @param {object} options {now, settings}
 */
function validateOdd(entry, fixture, options = {}) {
  const now = time.toDate(options.now || new Date()) || new Date();
  const settings = options.settings || {};
  const freshnessMinutes = Number(settings.oddsFreshnessMinutes) || config.odds.freshnessMinutes;
  const minSingle = Number(settings.minSingleOdds ?? 1.01);
  const maxSingle = Number(settings.maxSingleOdds ?? 2.5);

  const fail = (reason, detail) => ({ ok: false, reason, detail: detail || null });

  // 1 + 2 — fixture exists and is structurally valid
  if (!fixture) return fail(REJECT.FIXTURE_MISSING);
  if (!fixture.id) return fail(REJECT.FIXTURE_MISSING, { fixture });
  if (!fixture.homeTeamId || !fixture.awayTeamId || !fixture.kickoffAt) {
    return fail(REJECT.FIXTURE_INVALID, { id: fixture.id });
  }
  const kickoff = time.toDate(fixture.kickoffAt);
  if (!kickoff) return fail(REJECT.FIXTURE_INVALID, { kickoff: fixture.kickoffAt });

  // 3 — fixture must not have started
  if (kickoff.getTime() <= now.getTime()) return fail(REJECT.FIXTURE_STARTED, { kickoff: kickoff.toISOString() });

  // 4 + 5 — cancelled / postponed / otherwise not playable
  const status = fixtureStatus.normalize(fixture.statusShort);
  if (fixtureStatus.isCancelled(status)) return fail(REJECT.FIXTURE_CANCELLED);
  if (fixtureStatus.isPostponed(status)) return fail(REJECT.FIXTURE_POSTPONED);
  if (!fixtureStatus.isPlayable({ statusShort: status, kickoffAt: kickoff }, now)) {
    return fail(REJECT.FIXTURE_NOT_PLAYABLE, { status });
  }

  // 6 — the market must be exactly full-time Over 1.5 goals
  if (entry.periodOrScopeIssue) return fail(entry.periodOrScopeIssue, { betName: entry.betName });
  if (entry.parseIssue) return fail(REJECT.MARKET_AMBIGUOUS, { value: entry.valueName });
  if (entry.direction !== 'over') return fail(REJECT.MARKET_NOT_OVER_1_5, { direction: entry.direction });
  if (entry.goalLine === null || Math.abs(entry.goalLine - GOAL_LINE) > 1e-9) {
    // e.g. Over 2.5 = 1.80 must NEVER be used as Over 1.5
    return fail(REJECT.MARKET_GOAL_LINE_MISMATCH, { goalLine: entry.goalLine, value: entry.valueName });
  }

  // 7 — bookmaker exists
  if (!entry.bookmakerId || !entry.bookmakerName) return fail(REJECT.BOOKMAKER_MISSING);

  // 8 — odds exist
  const raw = entry.rawOdd === undefined || entry.rawOdd === null ? '' : String(entry.rawOdd).trim();
  if (!raw) return fail(REJECT.ODDS_MISSING);

  // 9 — odds numeric (exact decimal parse, no floats)
  const scaled = decimal.toScaled(raw);
  if (scaled === null) return fail(REJECT.ODDS_NOT_NUMERIC, { raw });
  const numeric = decimal.toNumber(scaled);

  // 10 — odds greater than 1.00
  if (decimal.lte(scaled, decimal.scaledFromNumber(1.0))) return fail(REJECT.ODDS_BELOW_MINIMUM, { raw });

  // single leg sanity band (configurable, never widens to force a ticket)
  if (decimal.lt(scaled, decimal.scaledFromNumber(minSingle))) {
    return fail(REJECT.ODDS_OUT_OF_RANGE, { raw, minSingle });
  }
  if (decimal.gt(scaled, decimal.scaledFromNumber(maxSingle))) {
    return fail(REJECT.ODDS_OUT_OF_RANGE, { raw, maxSingle });
  }

  // 12 — odds timestamp valid
  const updatedAt = time.toDate(entry.oddsUpdatedAt);
  if (!updatedAt) return fail(REJECT.ODDS_TIMESTAMP_INVALID, { update: entry.oddsUpdatedAt });

  // 11 — odds fresh
  const ageMinutes = time.minutesBetween(updatedAt, now);
  if (ageMinutes === null || ageMinutes > freshnessMinutes) {
    return fail(REJECT.ODDS_STALE, { ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes), freshnessMinutes });
  }
  if (ageMinutes < -24 * 60) {
    // a timestamp far in the future means the payload cannot be trusted
    return fail(REJECT.ODDS_TIMESTAMP_INVALID, { ageMinutes: Math.round(ageMinutes) });
  }

  // 13 — odds came from API-Football (never from a client request)
  if (entry.source !== SOURCE) return fail(REJECT.ODDS_SOURCE_INVALID, { source: entry.source });

  // 14 — odds not manually modified: the numeric value must be identical to
  //     the untouched raw string, and the stored raw string must be present.
  if (entry.storedOddRaw !== undefined && entry.storedOddRaw !== null && entry.storedOddRaw !== raw) {
    return fail(REJECT.ODDS_MANUALLY_MODIFIED, { raw, storedOddRaw: entry.storedOddRaw });
  }
  if (entry.decimalValue !== undefined && entry.decimalValue !== null) {
    const storedScaled = decimal.toScaled(entry.decimalValue);
    if (storedScaled === null || decimal.compare(storedScaled, scaled) !== 0) {
      return fail(REJECT.ODDS_MANUALLY_MODIFIED, { raw, decimalValue: entry.decimalValue });
    }
  }
  if (entry.manuallyEdited) return fail(REJECT.ODDS_MANUALLY_MODIFIED);

  return {
    ok: true,
    reason: null,
    odds: {
      fixtureId: Number(fixture.id),
      bookmakerId: Number(entry.bookmakerId),
      bookmakerName: String(entry.bookmakerName),
      marketKey: MARKET_KEY,
      marketLabel: MARKET_LABEL,
      betName: entry.betName,
      valueName: entry.valueName,
      goalLine: GOAL_LINE,
      direction: 'over',
      oddRaw: raw,
      oddScaled: scaled,
      oddDecimal: numeric,
      impliedProbability: 1 / numeric,
      oddsUpdatedAt: updatedAt,
      fetchedAt: time.toDate(entry.fetchedAt) || now,
      source: SOURCE,
      ageMinutes: Math.max(0, Math.round(ageMinutes)),
    },
  };
}

/**
 * Validate a whole `/odds` payload for one fixture.
 * @returns {{verified:Array, rejected:Array, stats:object}}
 */
function validateOddsPayload(payload, fixture, options = {}) {
  const parsed = parseOddsPayload(payload);
  const now = time.toDate(options.now || new Date()) || new Date();
  const verified = [];
  const rejected = [];

  for (const entry of parsed.entries) {
    entry.source = SOURCE;
    entry.fetchedAt = now;
    const result = validateOdd(entry, fixture, { ...options, now });
    if (result.ok) verified.push(result.odds);
    else rejected.push({ ...entry, reason: result.reason, detail: result.detail });
  }

  const over15Rejected = rejected.filter(
    (r) => r.periodOrScopeIssue === null && (r.direction === 'over' || r.parseIssue === null)
  );

  return {
    verified,
    rejected,
    stats: {
      fixtureId: parsed.fixtureId,
      bookmakers: new Set(verified.map((v) => v.bookmakerId)).size,
      pricesSeen: parsed.entries.length,
      verifiedPrices: verified.length,
      rejectedPrices: rejected.length,
      over15Rejected: over15Rejected.length,
      oddsUpdatedAt: parsed.oddsUpdatedAt,
    },
  };
}

/**
 * Choose which verified price to publish. The choice is always one of the
 * REAL prices returned by the API — never a computed or adjusted number.
 */
function selectPrice(verified, settings = {}) {
  if (!verified || !verified.length) return null;
  const strategy = settings.oddsSelectionStrategy || 'best_price';
  const preference = Array.isArray(settings.oddsBookmakerPreference)
    ? settings.oddsBookmakerPreference.map((n) => String(n).toLowerCase().trim())
    : String(settings.oddsBookmakerPreference || '')
        .split(',')
        .map((n) => n.toLowerCase().trim())
        .filter(Boolean);

  const rankPreference = (name) => {
    const idx = preference.indexOf(String(name || '').toLowerCase().trim());
    return idx === -1 ? 999 : idx;
  };

  const sorted = [...verified].sort((a, b) => {
    if (strategy === 'preferred_bookmaker') {
      const pa = rankPreference(a.bookmakerName);
      const pb = rankPreference(b.bookmakerName);
      if (pa !== pb) return pa - pb;
    }
    // highest real price first (a real bookmaker price, never inflated)
    if (decimal.compare(b.oddScaled ?? decimal.toScaled(b.oddDecimal), a.oddScaled ?? decimal.toScaled(a.oddDecimal)) !== 0) {
      return decimal.compare(b.oddScaled ?? decimal.toScaled(b.oddDecimal), a.oddScaled ?? decimal.toScaled(a.oddDecimal));
    }
    const pa = rankPreference(a.bookmakerName);
    const pb = rankPreference(b.bookmakerName);
    if (pa !== pb) return pa - pb;
    return Number(a.bookmakerId) - Number(b.bookmakerId);
  });

  const chosen = sorted[0];
  return { ...chosen, alternativesCount: sorted.length - 1, bookmakersOffering: sorted.length };
}

/* ---------------------------------------------------------------------- */
/* persistence                                                             */
/* ---------------------------------------------------------------------- */

/**
 * Store verified Over 1.5 prices (plus their rejected Over 1.5 attempts,
 * for audit). Other goal lines are deliberately NOT stored so a wrong line
 * can never leak into the engine.
 */
async function persistValidatedOdds({ fixtureId, verified, rejected, oddsUpdatedAt, fetchedAt }) {
  let rowsWritten = 0;
  const now = fetchedAt || new Date();

  for (const v of verified) {
    await db.upsertBookmaker({ id: v.bookmakerId, name: v.bookmakerName });
    await db.upsertOdds({
      fixtureId,
      bookmakerId: v.bookmakerId,
      bookmakerName: v.bookmakerName,
      marketKey: MARKET_KEY,
      marketLabel: MARKET_LABEL,
      betName: v.betName,
      valueName: v.valueName,
      goalLine: GOAL_LINE.toFixed(2),
      direction: 'over',
      oddDecimal: v.oddRaw,
      oddRaw: v.oddRaw,
      isVerified: true,
      validationState: 'VERIFIED',
      rejectReason: null,
      oddsUpdatedAt: v.oddsUpdatedAt || oddsUpdatedAt || now,
      fetchedAt: now,
    });
    rowsWritten += 1;
  }

  for (const r of rejected || []) {
    // keep only audit-worthy attempts on the correct market/line
    const isRelevant =
      !r.periodOrScopeIssue &&
      r.direction === 'over' &&
      typeof r.goalLine === 'number' &&
      Math.abs(r.goalLine - GOAL_LINE) < 1e-9;
    if (!isRelevant || !r.bookmakerId) continue;
    await db.upsertBookmaker({ id: r.bookmakerId, name: r.bookmakerName });
    await db.upsertOdds({
      fixtureId,
      bookmakerId: r.bookmakerId,
      bookmakerName: r.bookmakerName,
      marketKey: MARKET_KEY,
      marketLabel: MARKET_LABEL,
      betName: r.betName,
      valueName: r.valueName,
      goalLine: GOAL_LINE.toFixed(2),
      direction: 'over',
      oddDecimal: decimal.toScaled(r.rawOdd) === null ? '0.000' : r.rawOdd,
      oddRaw: r.rawOdd || '',
      isVerified: false,
      validationState: 'REJECTED',
      rejectReason: r.reason,
      oddsUpdatedAt: r.oddsUpdatedAt || oddsUpdatedAt || now,
      fetchedAt: now,
    });
    rowsWritten += 1;
  }

  return rowsWritten;
}

/* ---------------------------------------------------------------------- */
/* fetching                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Pull fresh odds for ONE fixture straight from API-Football, validate them
 * against the fixture and persist the verified rows.
 * @returns {{fixtureId, verified, selected, rejectedCount, stats, unavailable?:boolean}}
 */
async function fetchValidateAndStoreForFixture(fixture, options = {}) {
  const api = options.api || defaultApi;
  const now = options.now ? time.toDate(options.now) : new Date();
  const settings = options.settings || {};

  const payloadResult = await api.getOddsByFixture(fixture.id);
  const payload = (payloadResult.response || []).find(
    (p) => Number(p?.fixture?.id) === Number(fixture.id)
  ) || (payloadResult.response || [])[0] || null;

  if (!payload) {
    // No odds payload at all => the fixture has no Over 1.5 price => reject.
    return {
      fixtureId: Number(fixture.id),
      verified: [],
      selected: null,
      rejectedCount: 0,
      stats: { bookmakers: 0, pricesSeen: 0, verifiedPrices: 0, oddsUpdatedAt: null },
      noOddsData: true,
    };
  }

  const validation = validateOddsPayload(payload, fixture, { now, settings });
  const selected = selectPrice(validation.verified, settings);

  if (!options.skipPersist) {
    await persistValidatedOdds({
      fixtureId: Number(fixture.id),
      verified: validation.verified,
      rejected: validation.rejected,
      oddsUpdatedAt: validation.stats.oddsUpdatedAt,
      fetchedAt: now,
    });
  }

  return {
    fixtureId: Number(fixture.id),
    verified: validation.verified,
    selected,
    rejectedCount: validation.rejected.length,
    stats: validation.stats,
  };
}

/**
 * Bulk odds sync for a date using /odds?date=...&page=N (cheap on quota),
 * falling back to per-fixture requests for fixtures that got nothing.
 */
async function syncOddsForDate(date, options = {}) {
  const api = options.api || defaultApi;
  const settings = options.settings || {};
  const now = options.now ? time.toDate(options.now) : new Date();
  const maxPages = options.maxPages || 12;

  const fixtures = options.fixtures || (await db.getFixturesBetween(time.startOfUtcDay(date), time.addDays(time.startOfUtcDay(date), 1)));
  const playable = fixtures.filter((f) => Number(f.is_playable) === 1);
  const byId = new Map(playable.map((f) => [Number(f.id), f]));

  let endpointCalls = 0;
  let rowsWritten = 0;
  const fixturesWithOdds = new Set();
  const rejectionCounts = {};

  for (let page = 1; page <= maxPages; page += 1) {
    let data;
    try {
      data = await api.getOddsByDate(time.toMysqlDate(date), page);
    } catch (err) {
      if (err instanceof ApiFootballUnavailable) throw err;
      throw err;
    }
    endpointCalls += 1;
    const items = data.response || [];
    if (!items.length) break;

    for (const payload of items) {
      const fixtureId = Number(payload?.fixture?.id);
      const fixtureRow = byId.get(fixtureId);
      if (!fixtureRow) continue; // not a fixture we track for this date

      const fixture = {
        id: fixtureId,
        kickoffAt: fixtureRow.kickoff_at,
        statusShort: fixtureRow.status_short,
        homeTeamId: fixtureRow.home_team_id,
        awayTeamId: fixtureRow.away_team_id,
        leagueId: fixtureRow.league_id,
      };
      const validation = validateOddsPayload(payload, fixture, { now, settings });
      for (const r of validation.rejected) rejectionCounts[r.reason] = (rejectionCounts[r.reason] || 0) + 1;
      if (!validation.verified.length && !validation.rejected.length) continue;

      fixturesWithOdds.add(fixtureId);
      rowsWritten += await persistValidatedOdds({
        fixtureId,
        verified: validation.verified,
        rejected: validation.rejected,
        oddsUpdatedAt: validation.stats.oddsUpdatedAt,
        fetchedAt: now,
      });
    }

    const paging = data.paging || { current: page, total: page };
    if (Number(paging.current) >= Number(paging.total)) break;
  }

  return {
    date: time.toMysqlDate(date),
    fixturesScanned: playable.length,
    fixturesWithOdds: fixturesWithOdds.size,
    endpointCalls,
    rowsWritten,
    rejectionCounts,
  };
}

/**
 * Re-verify the shortlisted fixtures immediately before a ticket is built.
 * Returns a Map(fixtureId -> selected verified price). A fixture whose price
 * cannot be re-verified right now is dropped from the shortlist.
 */
async function refreshVerifiedPrices(fixtureIds, options = {}) {
  const api = options.api || defaultApi;
  const settings = options.settings || {};
  const now = options.now ? time.toDate(options.now) : new Date();
  const out = new Map();
  const failures = [];

  for (const id of fixtureIds || []) {
    const fixtureRow = await db.getFixtureById(id);
    if (!fixtureRow) {
      failures.push({ fixtureId: id, reason: REJECT.FIXTURE_MISSING });
      continue;
    }
    const fixture = {
      id: Number(fixtureRow.id),
      kickoffAt: fixtureRow.kickoff_at,
      statusShort: fixtureRow.status_short,
      homeTeamId: fixtureRow.home_team_id,
      awayTeamId: fixtureRow.away_team_id,
      leagueId: fixtureRow.league_id,
    };
    try {
      const result = await fetchValidateAndStoreForFixture(fixture, { api, settings, now });
      if (result.selected) out.set(Number(id), result.selected);
      else failures.push({ fixtureId: Number(id), reason: result.noOddsData ? REJECT.ODDS_MISSING : REJECT.MARKET_NOT_OVER_1_5 });
    } catch (err) {
      if (err instanceof ApiFootballUnavailable) throw err; // the whole run must stop
      failures.push({ fixtureId: Number(id), reason: err.message });
      log.warn('odds refresh failed for fixture', { fixtureId: id, message: err.message });
    }
  }

  return { prices: out, failures };
}

/**
 * Load verified Over 1.5 prices from the database and re-run the validation
 * gate on them (fixture state + freshness + integrity). Stored rows are never
 * trusted blindly.
 */
async function loadVerifiedPricesFromDb(fixtures, options = {}) {
  const settings = options.settings || {};
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  const ids = fixtures.map((f) => Number(f.id));
  const rows = await db.getVerifiedOver15Odds(ids);
  const fixtureById = new Map(fixtures.map((f) => [Number(f.id), f]));

  const grouped = new Map();
  const rejectionCounts = {};

  for (const row of rows) {
    const fixtureRow = fixtureById.get(Number(row.fixture_id));
    if (!fixtureRow) continue;
    const entry = {
      bookmakerId: Number(row.bookmaker_id),
      bookmakerName: row.bookmaker_name,
      betName: row.bet_name,
      valueName: row.value_name,
      rawOdd: row.odd_raw,
      storedOddRaw: row.odd_raw,
      decimalValue: row.odd_decimal,
      direction: row.direction,
      goalLine: Number(row.goal_line),
      oddsUpdatedAt: row.odds_updated_at,
      fetchedAt: row.fetched_at,
      source: SOURCE,
      periodOrScopeIssue: null,
      parseIssue: null,
    };
    const fixture = {
      id: Number(fixtureRow.id),
      kickoffAt: fixtureRow.kickoff_at,
      statusShort: fixtureRow.status_short,
      homeTeamId: fixtureRow.home_team_id,
      awayTeamId: fixtureRow.away_team_id,
      leagueId: fixtureRow.league_id,
    };
    const result = validateOdd(entry, fixture, { now, settings });
    if (result.ok) {
      const list = grouped.get(Number(row.fixture_id)) || [];
      list.push(result.odds);
      grouped.set(Number(row.fixture_id), list);
    } else {
      rejectionCounts[result.reason] = (rejectionCounts[result.reason] || 0) + 1;
    }
  }

  const selected = new Map();
  for (const [fixtureId, list] of grouped.entries()) {
    const pick = selectPrice(list, settings);
    if (pick) selected.set(fixtureId, pick);
  }
  return { selected, grouped, rejectionCounts };
}

module.exports = {
  MARKET_KEY,
  MARKET_LABEL,
  GOAL_LINE,
  SOURCE,
  REJECT,
  classifyBetName,
  parseOddsValue,
  parseOddsPayload,
  isOver15Entry,
  validateOdd,
  validateOddsPayload,
  selectPrice,
  persistValidatedOdds,
  fetchValidateAndStoreForFixture,
  syncOddsForDate,
  refreshVerifiedPrices,
  loadVerifiedPricesFromDb,
};
