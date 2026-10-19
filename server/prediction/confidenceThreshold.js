'use strict';

/**
 * CONFIDENCE THRESHOLD — auto-detection (default) with a hard floor.
 *
 * The old behaviour was a single fixed gate (72): on a day whose strongest
 * verified candidates scored 55–70 the run produced NO QUALIFYING TICKET
 * even though perfectly usable picks existed, and on a strong day the gate
 * did nothing at all. The threshold is now detected from the day's own
 * candidate pool:
 *
 *   1. Start from the preferred target (72 — the former fixed gate).
 *   2. If at least a full candidate pool (or, failing that, at least the
 *      minimum number of selections) clears the target, keep it.
 *   3. Otherwise lower the threshold to the confidence of the weakest
 *      candidate needed to fill the pool / reach the minimum selections.
 *   4. NEVER go below the configured floor (`min_confidence`, default 30).
 *      Candidates under the floor are rejected exactly as before.
 *
 * `fixed` mode restores the old behaviour verbatim: `min_confidence` is the
 * exact gate and nothing is detected. Detection is a pure, deterministic
 * function of the pool — same pool, same threshold, every time.
 */

const numbers = require('../utils/numbers');

/** Preferred gate whenever the day's pool is strong enough to fill it. */
const PREFERRED_TARGET = 72;
/** Default hard floor: no candidate below this can ever qualify. */
const DEFAULT_FLOOR = 30;

const MODES = Object.freeze(['auto', 'fixed']);

function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : 'auto';
}

function clampScore(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return numbers.clamp(n, 0, 100);
}

/** Round DOWN so the candidate that set the threshold always clears it. */
function floorTo2(value) {
  return Math.floor((Number(value) + 1e-9) * 100) / 100;
}

/**
 * Detect the effective confidence gate for one run.
 *
 * @param {Array<number>} confidences scores that already passed every
 *   OTHER gate (odds, quality, risk, fixture state) — confidence must not
 *   be lowered because of candidates that would be rejected anyway.
 * @param {object} [options]
 * @param {string} [options.mode='auto'] 'auto' | 'fixed'
 * @param {number} [options.minConfidence] configured value: the exact gate
 *   in fixed mode, the hard floor in auto mode (default 30)
 * @param {number} [options.preferredTarget=72] auto mode's preferred gate
 * @param {number} [options.minSelections=2] legs a ticket needs at minimum
 * @param {number} [options.candidatePoolSize=16] pool the builder works with
 * @returns {{mode:string, floor:number, configured:number, preferredTarget:number,
 *   effective:number, source:string, poolSize:number, passing:number,
 *   enoughForTicket:boolean}}
 */
function detectConfidenceThreshold(confidences, options = {}) {
  const mode = normalizeMode(options.mode ?? options.confidenceMode);
  const configured = clampScore(options.minConfidence, DEFAULT_FLOOR);
  const floor = mode === 'auto' ? Math.min(configured, 100) : configured;
  const preferredTarget = Math.max(floor, clampScore(options.preferredTarget, PREFERRED_TARGET));
  const minSelections = Math.max(1, Math.floor(Number(options.minSelections) || 2));
  const candidatePoolSize = Math.max(minSelections, Math.floor(Number(options.candidatePoolSize) || 16));

  const sorted = (confidences || [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => b - a);

  const result = (effective, source) => {
    const passing = sorted.filter((c) => c >= effective).length;
    return {
      mode,
      floor,
      configured,
      preferredTarget,
      effective: numbers.round(effective, 2),
      source,
      poolSize: sorted.length,
      passing,
      enoughForTicket: passing >= minSelections,
    };
  };

  if (mode === 'fixed') return result(configured, 'FIXED_SETTING');
  if (!sorted.length) return result(floor, 'AUTO_NO_CANDIDATES');

  // Weakest candidate we would like to keep: fill the builder's pool, or
  // at least reach the minimum number of selections.
  const idealCount = Math.min(sorted.length, Math.max(minSelections, candidatePoolSize));
  const idealWeakest = sorted[idealCount - 1];
  if (idealWeakest >= preferredTarget) return result(preferredTarget, 'AUTO_TARGET_MET');
  if (idealWeakest >= floor) return result(floorTo2(idealWeakest), 'AUTO_POOL_FILL');

  // The full pool cannot be filled above the floor — fall back to keeping
  // just enough candidates for a ticket, still never below the floor.
  if (sorted.length >= minSelections) {
    const minimumWeakest = sorted[minSelections - 1];
    if (minimumWeakest >= floor) return result(floorTo2(minimumWeakest), 'AUTO_MINIMUM_SELECTIONS');
  }
  return result(floor, 'AUTO_FLOOR');
}

module.exports = { detectConfidenceThreshold, normalizeMode, PREFERRED_TARGET, DEFAULT_FLOOR, MODES };
