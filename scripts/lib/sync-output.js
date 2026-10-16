'use strict';

/**
 * CRON OUTPUT — the one line an operator reads in `logs/cron.log` or in the
 * cron mail.
 *
 * The JSON line that follows it is for machines, but the incident this exists
 * for was an operator staring at three identical
 * "DATA SOURCE TEMPORARILY UNAVAILABLE" lines with no way to tell a spent daily
 * quota from a rejected key. The result objects now carry `reason`, `label`,
 * `hint`, `resetAt` and the recorded budget; this turns them into a sentence.
 */

/** @returns {null|string} null when the run was healthy. */
function describeRun(job, result) {
  if (!result || !result.status) return null;

  if (result.status === 'SKIPPED') {
    return `[${job}] paused — ${result.message || result.label || result.reason}`;
  }

  if (result.status === 'DATA_SOURCE_UNAVAILABLE') {
    const parts = [`[${job}] DATA SOURCE UNAVAILABLE`];
    if (result.reason) parts.push(`(${result.reason}${result.label ? `: ${result.label}` : ''})`);
    if (result.error) parts.push(`— ${result.error}`);
    if (result.hint) parts.push(`FIX: ${result.hint}`);
    if (result.resetAt) parts.push(`(retry after ${result.resetAt})`);
    return parts.join(' ');
  }

  if (result.status === 'FAILED') {
    return `[${job}] failed — ${result.message || result.error || 'unknown error'}`;
  }

  return null;
}

/** Exit code 2 = the data source could not be used (cron mail flags it). */
function runExitCode(result) {
  return result && result.status === 'DATA_SOURCE_UNAVAILABLE' ? 2 : 0;
}

module.exports = { describeRun, runExitCode };
