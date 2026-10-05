'use strict';

/**
 * CORRELATION PROTECTION
 *
 *  - a fixture can never appear twice
 *  - a team can never appear twice
 *  - configurable caps per league / country / kickoff window
 *
 * When the caps prevent a valid ticket the answer is NO QUALIFYING TICKET.
 * The rules are never weakened automatically.
 */

const numbers = require('../utils/numbers');
const time = require('../utils/time');

const DEFAULTS = {
  enabled: true,
  maxPerLeague: 2,
  maxPerCountry: 3,
  maxPerTeam: 1,
  kickoffWindowMinutes: 45,
  maxPerKickoffWindow: 2,
};

const kickoffBucket = (kickoffAt, windowMinutes) => {
  const d = time.toDate(kickoffAt);
  if (!d) return null;
  const step = Math.max(1, Number(windowMinutes) || 45) * 60000;
  return Math.floor(d.getTime() / step) * step;
};

/** Describe a candidate for correlation bookkeeping. */
function keysOf(candidate, settings) {
  const s = { ...DEFAULTS, ...settings };
  return {
    fixtureId: Number(candidate.fixtureId ?? candidate.fixture_id),
    leagueId: candidate.leagueId ?? candidate.league_id ?? null,
    country: (candidate.leagueCountry || candidate.league_country || 'UNKNOWN').toString().toLowerCase(),
    homeTeamId: Number(candidate.homeTeamId ?? candidate.home_team_id ?? 0),
    awayTeamId: Number(candidate.awayTeamId ?? candidate.away_team_id ?? 0),
    kickoffBucket: kickoffBucket(candidate.kickoffAt || candidate.kickoff_at, s.kickoffWindowMinutes),
  };
}

/** Correlation keys for an entry that may or may not have them precomputed. */
function entryKeys(entry, settings) {
  return entry && entry.keys ? entry.keys : keysOf(entry, settings);
}

/**
 * Can `candidate` be added to `picked` without breaking a correlation rule?
 * @returns {{ok:boolean, rule:string|null}}
 */
function canAdd(candidate, picked, settings = {}) {
  const s = { ...DEFAULTS, ...(settings.correlation || settings) };
  const keys = keysOf(candidate, s);
  const pickedKeys = (picked || []).map((p) => entryKeys(p, s));

  // same fixture twice — always forbidden, even when protection is disabled
  if (pickedKeys.some((k) => k.fixtureId === keys.fixtureId)) return { ok: false, rule: 'DUPLICATE_FIXTURE' };
  // same team twice (in any combination of home/away slots)
  if (
    pickedKeys.some(
      (k) =>
        k.homeTeamId === keys.homeTeamId ||
        k.awayTeamId === keys.homeTeamId ||
        k.homeTeamId === keys.awayTeamId ||
        k.awayTeamId === keys.awayTeamId
    )
  ) {
    return { ok: false, rule: 'SAME_TEAM' };
  }

  if (!s.enabled) return { ok: true, rule: null };

  const leagueCount = pickedKeys.filter((k) => k.leagueId !== null && k.leagueId === keys.leagueId).length;
  if (leagueCount >= s.maxPerLeague) return { ok: false, rule: 'MAX_PER_LEAGUE' };

  const countryCount = pickedKeys.filter((k) => k.country === keys.country).length;
  if (countryCount >= s.maxPerCountry) return { ok: false, rule: 'MAX_PER_COUNTRY' };

  const windowCount = pickedKeys.filter((k) => k.kickoffBucket !== null && k.kickoffBucket === keys.kickoffBucket).length;
  if (windowCount >= s.maxPerKickoffWindow) return { ok: false, rule: 'MAX_PER_KICKOFF_WINDOW' };

  return { ok: true, rule: null };
}

/** Validate a finished combination. */
function checkCombination(combination, settings = {}) {
  const s = { ...DEFAULTS, ...(settings.correlation || settings) };
  const picked = [];
  for (const candidate of combination) {
    const res = canAdd(candidate, picked, s);
    if (!res.ok) return { ok: false, rule: res.rule, fixtureId: candidate.fixtureId ?? candidate.fixture_id };
    picked.push({ candidate, keys: keysOf(candidate, s) });
  }
  return { ok: true, rule: null };
}

/**
 * Greedy, strength ordered pool construction that already respects the caps.
 * Returns the accepted pool plus the number of candidates rejected purely
 * because of correlation (reported in the generation report).
 */
function buildPool(candidates, settings = {}) {
  const s = { ...DEFAULTS, ...(settings.correlation || settings) };
  const ordered = [...candidates].sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));
  const picked = [];
  const rejected = [];

  for (const candidate of ordered) {
    const res = canAdd(candidate, picked, s);
    if (res.ok) {
      picked.push({ ...candidate, keys: keysOf(candidate, s) });
    } else {
      rejected.push({ fixtureId: candidate.fixtureId ?? candidate.fixture_id, rule: res.rule });
    }
  }
  return { pool: picked, correlationRejected: rejected.length, rejected };
}

/** League spread bonus used by the combination scorer (0-100). */
function diversityScore(combination) {
  if (!combination.length) return 0;
  const leagues = new Set(combination.map((c) => c.leagueId ?? c.league_id ?? null));
  return numbers.round((leagues.size / combination.length) * 100, 2);
}

module.exports = { DEFAULTS, keysOf, canAdd, checkCombination, buildPool, diversityScore, kickoffBucket };
