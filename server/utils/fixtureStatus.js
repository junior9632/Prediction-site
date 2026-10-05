'use strict';

/**
 * API-Football fixture status handling.
 *
 * A fixture may only enter the ticket pipeline when it is genuinely
 * NOT STARTED. Live, finished, postponed, cancelled, abandoned, suspended,
 * interrupted, awarded and walk-over fixtures are all rejected.
 */

// Not started
const UPCOMING = new Set(['NS', 'TBD']);
// Finished (full time, after extra time, after penalties)
const FINISHED = new Set(['FT', 'AET', 'PEN']);
// In play
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);
// Will not be played as scheduled
const NOT_PLAYABLE = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO', 'DEL', 'INT', 'SUSP', 'TBD_OUT']);

const STATUS_LABELS = {
  NS: 'Not Started',
  TBD: 'Time To Be Defined',
  '1H': 'First Half',
  HT: 'Half Time',
  '2H': 'Second Half',
  ET: 'Extra Time',
  BT: 'Break Time',
  P: 'Penalties',
  LIVE: 'In Play',
  FT: 'Match Finished',
  AET: 'Finished After Extra Time',
  PEN: 'Finished After Penalties',
  PST: 'Postponed',
  CANC: 'Cancelled',
  ABD: 'Abandoned',
  AWD: 'Technical Defeat / Awarded',
  WO: 'WalkOver',
  INT: 'Interrupted',
  SUSP: 'Suspended',
  DEL: 'Delayed',
};

const normalize = (code) => String(code || '').trim().toUpperCase();

const isUpcoming = (code) => UPCOMING.has(normalize(code));
const isFinished = (code) => FINISHED.has(normalize(code));
const isLive = (code) => LIVE.has(normalize(code));
const isPostponed = (code) => normalize(code) === 'PST';
const isCancelled = (code) => normalize(code) === 'CANC';
const isAbandoned = (code) => normalize(code) === 'ABD';

/**
 * Playable = scheduled in the future and not cancelled/postponed/abandoned.
 * `now` and the kickoff time decide the "has not started" rule, so a fixture
 * that is still flagged NS by the API but already past kickoff is rejected.
 */
function isPlayable(fixture, now = new Date()) {
  const code = normalize(fixture && fixture.statusShort);
  if (!UPCOMING.has(code)) return false;
  if (NOT_PLAYABLE.has(code)) return false;
  const kickoff = fixture && fixture.kickoffAt ? new Date(fixture.kickoffAt) : null;
  if (!kickoff || Number.isNaN(kickoff.getTime())) return false;
  return kickoff.getTime() > now.getTime();
}

/** Postponed / cancelled / abandoned => the pick is VOID, never WON or LOST. */
function isVoidStatus(code) {
  const c = normalize(code);
  return c === 'PST' || c === 'CANC' || c === 'ABD' || c === 'WO' || c === 'AWD';
}

function label(code) {
  return STATUS_LABELS[normalize(code)] || normalize(code) || 'UNKNOWN';
}

module.exports = {
  UPCOMING,
  FINISHED,
  LIVE,
  NOT_PLAYABLE,
  STATUS_LABELS,
  normalize,
  isUpcoming,
  isFinished,
  isLive,
  isPostponed,
  isCancelled,
  isAbandoned,
  isVoidStatus,
  isPlayable,
  label,
};
