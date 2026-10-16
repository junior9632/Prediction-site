#!/usr/bin/env node
'use strict';

/**
 * ONE COMMAND DIAGNOSIS FOR "DATA SOURCE TEMPORARILY UNAVAILABLE".
 *
 *   npm run api:check           (human readable)
 *   npm run api:check -- --json (machine readable, for support tickets)
 *
 * It resolves the credential exactly the way the running application does
 * (an ACTIVE row in `api_credentials`, otherwise API_FOOTBALL_KEY), performs
 * ONE real request to API-Football's `/status` endpoint and reports what the
 * provider answered:
 *
 *   * which credential is in force (never the key itself, only a mask);
 *   * the connection verdict (CONNECTED / INVALID_KEY / QUOTA_EXCEEDED /
 *     RATE_LIMITED / NETWORK_ERROR / TIMEOUT / PROVIDER_UNAVAILABLE /
 *     CONFIG_INCOMPLETE);
 *   * the daily request budget the provider reports (used / limit);
 *   * the exact fix for that verdict.
 *
 * `/status` does not count against the daily quota, so this check is free.
 * Exit code 0 = the data source works, 1 = it does not (safe for cron/monitor).
 */

process.env.CRON_CONTEXT = process.env.CRON_CONTEXT || '1';
// The report below IS the output: the process logger's structured JSON lines
// would only bury it. Set LOG_LEVEL yourself to inspect the internals.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'silent';

const { resolveActiveCredential } = require('../server/services/apiCredentialService');
const { ApiFootballClient, describeUnavailable, reasonInfo, UNAVAILABLE_REASONS } = require('../server/services/apiFootball');
const pool = require('../server/database/connection');

const asJson = process.argv.includes('--json');

function line(label, value) {
  if (value === null || value === undefined || value === '') return;
  process.stdout.write(`${label.padEnd(22)} ${value}\n`);
}

(async () => {
  const resolved = await resolveActiveCredential({ force: true });
  const report = {
    checkedAt: new Date().toISOString(),
    credentialSource: resolved.source,
    host: resolved.host || null,
    maskedKey: resolved.maskedKey || null,
    providerId: resolved.providerId || null,
    ok: false,
    state: null,
    reason: null,
    message: null,
    hint: null,
    quota: null,
    plan: null,
    httpStatus: null,
    latencyMs: null,
  };

  if (resolved.error) {
    // A stored credential that cannot be used is a hard stop — never masked by
    // silently testing a different key.
    report.state = resolved.error.code === 'ENCRYPTION_KEY_MISSING' ? 'CREDENTIAL_UNREADABLE' : 'CREDENTIAL_UNREADABLE';
    report.reason = resolved.error.code || UNAVAILABLE_REASONS.CREDENTIAL_UNREADABLE;
    report.message = resolved.error.message;
    report.hint = reasonInfo(UNAVAILABLE_REASONS.CREDENTIAL_UNREADABLE).hint;
  } else if (!resolved.key) {
    report.state = 'CONFIG_INCOMPLETE';
    report.reason = UNAVAILABLE_REASONS.NO_API_KEY;
    report.message = 'No API key is configured for this application.';
    report.hint = reasonInfo(UNAVAILABLE_REASONS.NO_API_KEY).hint;
  } else {
    // manageCredential:false — this client tests the resolved credential, it
    // must not re-resolve (or fall back to) a different one mid-check.
    const client = new ApiFootballClient({
      key: resolved.key,
      host: resolved.host,
      baseUrl: resolved.baseUrl,
      manageCredential: false,
    });
    const probe = await client.probeCredentials();
    report.ok = probe.ok;
    report.state = probe.state;
    report.reason = probe.reason || null;
    report.message = probe.message;
    report.hint = probe.hint || null;
    report.quota = probe.quota || null;
    report.plan = probe.plan || null;
    report.httpStatus = probe.httpStatus;
    report.latencyMs = probe.latencyMs;
    if (probe.ok) report.hint = null;
    else {
      const info = describeUnavailable({ message: probe.message, details: { reason: probe.reason, status: probe.httpStatus } });
      if (!report.hint) report.hint = info.hint;
    }
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write('API-Football data source check\n');
    line('Credential source', report.credentialSource);
    line('Host', report.host);
    line('Key', report.maskedKey);
    line('Verdict', report.state);
    line('Provider said', report.message);
    line('HTTP status', report.httpStatus);
    line('Latency', report.latencyMs === null ? null : `${report.latencyMs} ms`);
    if (report.quota) line('Requests used today', `${report.quota.current}${report.quota.limitDay ? ` / ${report.quota.limitDay}` : ''}`);
    if (report.plan && report.plan.name) line('Plan', `${report.plan.name}${report.plan.active === false ? ' (inactive)' : ''}`);
    if (report.hint) {
      process.stdout.write(`\nWhat to do: ${report.hint}\n`);
    }
    if (report.ok) process.stdout.write('\nOK — the data source answered and accepted the credential.\n');
    else process.stdout.write('\nThe data source cannot be used right now: every sync job and ticket generation will end DATA_SOURCE_UNAVAILABLE until this is fixed.\n');
  }

  process.exitCode = report.ok ? 0 : 1;
})()
  .catch((err) => {
    process.stderr.write(`api check failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (typeof pool.closePool === 'function') pool.closePool();
  });
