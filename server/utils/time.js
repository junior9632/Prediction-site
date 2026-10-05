'use strict';

/**
 * Time helpers. The database stores everything in UTC; API-Football
 * timestamps are ISO-8601 with an offset. Display formatting happens in
 * the browser (so visitors see their own kickoff time).
 */

const pad = (n, len = 2) => String(n).padStart(len, '0');

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string' && value.trim()) {
    let s = value.trim();
    // MySQL DATETIME strings have no timezone marker -> treat as UTC
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** 'YYYY-MM-DD HH:MM:SS' in UTC — safe for MySQL DATETIME parameters. */
function toMysqlDateTime(value) {
  const d = toDate(value);
  if (!d) return null;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** 'YYYY-MM-DD' in UTC. */
function toMysqlDate(value) {
  const d = toDate(value);
  if (!d) return null;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function toIso(value) {
  const d = toDate(value);
  return d ? d.toISOString() : null;
}

function startOfUtcDay(value) {
  const d = toDate(value);
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function addDays(value, days) {
  const d = toDate(value);
  if (!d) return null;
  return new Date(d.getTime() + days * 86400000);
}

function addMinutes(value, minutes) {
  const d = toDate(value);
  if (!d) return null;
  return new Date(d.getTime() + minutes * 60000);
}

/** Whole minutes between two instants (b - a). */
function minutesBetween(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return null;
  return (db.getTime() - da.getTime()) / 60000;
}

const isFuture = (value, now = new Date()) => {
  const d = toDate(value);
  return d ? d.getTime() > toDate(now).getTime() : false;
};

const isPast = (value, now = new Date()) => !isFuture(value, now);

/** Human friendly age, e.g. "12 minutes ago" — used by "ODDS VERIFIED". */
function humanizeAge(value, now = new Date()) {
  const d = toDate(value);
  const n = toDate(now);
  if (!d || !n) return null;
  const diffMs = n.getTime() - d.getTime();
  const abs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? 'ago' : 'from now';
  const mins = Math.floor(abs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ${suffix}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ${suffix}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ${suffix}`;
}

/** '04 Oct 2026' — used in the generation report header. */
function formatReportDate(value) {
  const d = toDate(value);
  if (!d) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

module.exports = {
  toDate,
  toMysqlDateTime,
  toMysqlDate,
  toIso,
  startOfUtcDay,
  addDays,
  addMinutes,
  minutesBetween,
  isFuture,
  isPast,
  humanizeAge,
  formatReportDate,
};
