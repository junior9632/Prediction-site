'use strict';

/**
 * Exact decimal arithmetic for bookmaker odds.
 *
 * Accumulator totals MUST be the exact product of the real prices
 * (1.25 x 1.30 x 1.35 = 2.19375 -> displayed as 2.19). Binary floating
 * point cannot represent those values exactly, so every odds total in
 * this application is computed with BigInt scaled integers and only
 * rounded for DISPLAY. Internal comparisons against the 2.00-4.00 window
 * also happen on the exact value.
 *
 * Scale: 4 decimal places (bookmakers publish 2, occasionally 3).
 */

const SCALE_DIGITS = 4;
const SCALE_FACTOR = 10n ** BigInt(SCALE_DIGITS);
const HALF = SCALE_FACTOR / 2n;
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;

/**
 * Convert a raw odds value (string preferred — API-Football returns
 * strings such as "1.27") into an exact scaled BigInt.
 * @returns {BigInt|null} null when the value is not a clean decimal number
 */
function toScaled(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;

  let s;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    s = String(value);
  } else {
    s = String(value).trim();
  }
  if (!NUMERIC_RE.test(s)) return null;

  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);
  const [intPart, fracPart = ''] = s.split('.');

  const frac = fracPart.slice(0, SCALE_DIGITS).padEnd(SCALE_DIGITS, '0');
  // round half-up when the source has more precision than our scale
  if (fracPart.length > SCALE_DIGITS) {
    const nextDigit = Number(fracPart[SCALE_DIGITS]);
    let scaled = BigInt(intPart + frac);
    if (nextDigit >= 5) scaled += 1n;
    return negative ? -scaled : scaled;
  }
  const scaled = BigInt(intPart + frac);
  return negative ? -scaled : scaled;
}

/** Exact scaled value of a plain JS number (used for the 2.00 / 4.00 bounds). */
function scaledFromNumber(num) {
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  return toScaled(num.toFixed(SCALE_DIGITS));
}

/** Scaled BigInt -> JS number (for probability maths only, never for totals). */
function toNumber(scaled) {
  if (scaled === null || scaled === undefined) return NaN;
  return Number(scaled) / Number(SCALE_FACTOR);
}

/** Exact product of two scaled values, rounded half-up back to the scale. */
function multiply(a, b) {
  if (a === null || b === null) return null;
  const raw = BigInt(a) * BigInt(b);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const rounded = (abs + HALF) / SCALE_FACTOR;
  return negative ? -rounded : rounded;
}

/** Exact product of a list of scaled odds. Empty list -> 1.0000 */
function product(values) {
  let acc = SCALE_FACTOR;
  for (const v of values || []) {
    const scaled = typeof v === 'bigint' ? v : toScaled(v);
    if (scaled === null) return null;
    acc = multiply(acc, scaled);
    if (acc === null) return null;
  }
  return acc;
}

/** Compare two scaled values: -1, 0, 1 */
function compare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const gte = (a, b) => compare(a, b) >= 0;
const lte = (a, b) => compare(a, b) <= 0;
const gt = (a, b) => compare(a, b) > 0;
const lt = (a, b) => compare(a, b) < 0;

/**
 * Round an exact scaled value to `dp` decimals and render it as a string.
 * This is the ONLY place odds rounding is allowed to happen.
 */
function format(scaled, dp = 2) {
  if (scaled === null || scaled === undefined) return null;
  const digits = Math.max(0, Number.isFinite(Number(dp)) ? Math.trunc(Number(dp)) : 2);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;

  let rounded = abs;
  if (digits < SCALE_DIGITS) {
    const divisor = 10n ** BigInt(SCALE_DIGITS - digits);
    rounded = (abs + divisor / 2n) / divisor; // half-up, the only rounding allowed
  } else if (digits > SCALE_DIGITS) {
    rounded = abs * 10n ** BigInt(digits - SCALE_DIGITS); // exact zero padding
  }

  const str = rounded.toString().padStart(digits + 1, '0');
  const intPart = digits === 0 ? str : str.slice(0, str.length - digits);
  const fracPart = digits === 0 ? '' : `.${str.slice(str.length - digits)}`;
  return `${negative ? '-' : ''}${intPart}${fracPart}`;
}

/** Exact scaled value -> plain number rounded to dp (for JSON output). */
function toRoundedNumber(scaled, dp = 2) {
  const s = format(scaled, dp);
  return s === null ? null : Number(s);
}

module.exports = {
  SCALE_DIGITS,
  SCALE_FACTOR,
  toScaled,
  scaledFromNumber,
  toNumber,
  multiply,
  product,
  compare,
  gte,
  lte,
  gt,
  lt,
  format,
  toRoundedNumber,
};
