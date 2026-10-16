'use strict';

/**
 * API CREDENTIAL SERVICE — the single source of truth for "which API key and
 * host is the platform using right now".
 *
 * RESOLUTION ORDER (never a guess, always reported)
 *   1. an ACTIVE row in `api_credentials` (saved + activated from the admin
 *      API Management screen) — the key is decrypted in memory only;
 *   2. otherwise the existing environment configuration
 *      (API_FOOTBALL_KEY / API_FOOTBALL_HOST) — so a deployment that never
 *      touches the new screen keeps working exactly as before;
 *   3. otherwise "none": the client reports NO_API_KEY and nothing is invented.
 *
 * A stored credential that cannot be decrypted (missing/rotated
 * API_CREDENTIALS_ENCRYPTION_KEY) is a HARD error for upstream calls: the
 * platform refuses to silently fall back to a different key, because that
 * would sync data with a credential the operator did not choose. The admin
 * screen reports exactly that, with the fix.
 *
 * WHAT THIS MODULE NEVER DOES
 *   * return, log or transmit a plaintext key (only masked fragments do);
 *   * fabricate quota, plan, latency or connection state — every value comes
 *     from a real provider response that was actually received;
 *   * create, publish or replace a prediction ticket. Testing credentials is
 *     completely decoupled from the ticket engine (ticketService is not even
 *     imported here).
 */

const db = require('../database/queries');
const config = require('../config');
const logger = require('../utils/logger');
const vault = require('../utils/credentialVault');
const { AppError } = require('../utils/errors');
const providers = require('./apiProviders');
const {
  ApiFootballClient,
  CONNECTION_STATES,
  CONNECTION_LABELS,
  apiFootball,
} = require('./apiFootball');

const log = logger.child('api-credentials');

/** Every connection state that means "the credential works". */
const OK_STATES = new Set([CONNECTION_STATES.CONNECTED]);

/** Short cache: an admin action invalidates it, so it only avoids re-reading
 * the same row on every upstream request. */
const CACHE_TTL_MS = 15 * 1000;

/**
 * Throttling windows for credential tests (operator tunable through the
 * environment, overridable in tests through `setTestWindowsForTests`):
 *   * minIntervalMs — never hammer the provider from the same process;
 *   * reuseMs — the same credential + host tested inside this window is
 *     reported from the recorded verdict instead of a second provider call.
 */
const TEST_WINDOW_DEFAULTS = Object.freeze({
  minIntervalMs: config.apiCredentials.testMinIntervalMs,
  reuseMs: config.apiCredentials.testReuseMs,
});
let testWindows = { ...TEST_WINDOW_DEFAULTS };
/** Throttle for persisting "last API request time". */
const REQUEST_TOUCH_INTERVAL_MS = 30 * 1000;

let cache = { at: 0, value: null };
let lastTest = { at: 0, keyFingerprint: null, host: null, provider: null, result: null };
// The Refresh button probes the provider too. The same reuse window applies so
// an impatient operator cannot burn the daily quota with repeat clicks.
let lastProbe = { at: 0, keyFingerprint: null, host: null, provider: null, result: null };
let lastTouchAt = 0;

/** Test hook: build the client used for a probe (tests inject a stub fetch). */
let clientFactory = (options) => new ApiFootballClient(options);

function setClientFactory(factory) {
  clientFactory = typeof factory === 'function' ? factory : (options) => new ApiFootballClient(options);
}

/** Adjust the test throttling windows (tests; operators use the environment). */
function setTestWindowsForTests(windows = {}) {
  testWindows = { ...TEST_WINDOW_DEFAULTS, ...windows };
}

/** Invalidate the resolution cache (called after every configuration write). */
function invalidate() {
  cache = { at: 0, value: null };
}

/* ---------------------------------------------------------------------- */
/* resolution                                                             */
/* ---------------------------------------------------------------------- */

function environmentCredential(providerId = providers.DEFAULT_PROVIDER_ID) {
  const provider = providers.get(providerId);
  const key = (config.apiFootball.key || '').trim();
  if (!key) return null;
  const host = providers.normalizeHost(config.apiFootball.host) || (provider && provider.defaultHostId) || null;
  return {
    providerId,
    key,
    host,
    baseUrl: config.apiFootball.baseUrl,
    ratePerMinute: config.apiFootball.ratePerMinute,
    source: 'environment',
    savedAt: null,
    maskedKey: vault.maskSecret(key),
  };
}

/**
 * Resolve the credential the platform must use right now.
 * @param {{force?: boolean}} options
 * @returns {Promise<{source: 'database'|'environment'|'none', providerId: string,
 *   key: string, host: string, baseUrl: string, ratePerMinute: number,
 *   maskedKey: string|null, row?: object|null, error?: AppError|null,
 *   disabled?: boolean}>}
 */
async function resolveActiveCredential({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let row = null;
  let rowsAvailable = true;
  try {
    row = await db.getActiveApiCredential();
  } catch (err) {
    rowsAvailable = false;
    // An older live database that has not received migration 003 must keep
    // working with the environment credential — reported, never hidden.
    log.warn('api_credentials is not readable — falling back to the environment credential', {
      code: err.code,
      message: err.message,
    });
  }

  let resolved;
  if (row && rowsAvailable) {
    const provider = providers.get(row.provider);
    try {
      if (!provider || !provider.implemented) {
        throw new AppError(`Provider "${row.provider}" is not implemented in this build`, {
          status: 400,
          code: 'PROVIDER_NOT_IMPLEMENTED',
        });
      }
      const hostEntry = providers.requireHost(provider, row.host);
      const key = vault.decryptSecret(row, { provider: row.provider });
      resolved = {
        source: 'database',
        providerId: row.provider,
        key,
        host: hostEntry.id,
        baseUrl: hostEntry.baseUrl,
        ratePerMinute: providers.ratePerMinute(provider, row.rate_limit_per_minute),
        maskedKey: vault.maskFromStoredParts({ last4: row.key_last4, length: row.key_length }),
        row,
      };
    } catch (err) {
      // Hard failure: the operator chose a stored credential, so substituting
      // a different one silently would misrepresent which key is in use.
      const code = err.code || 'CREDENTIAL_UNREADABLE';
      resolved = {
        source: row ? 'database' : 'none',
        providerId: row.provider,
        key: '',
        host: row.host,
        baseUrl: config.apiFootball.baseUrl,
        ratePerMinute: config.apiFootball.ratePerMinute,
        maskedKey: vault.maskFromStoredParts({ last4: row.key_last4, length: row.key_length }),
        row,
        error: err instanceof AppError ? err : new AppError(err.message, { status: 500, code }),
      };
    }
  } else {
    const env = environmentCredential();
    resolved = env
      ? { ...env, source: 'environment', row: null, error: null }
      : {
          source: 'none',
          providerId: providers.DEFAULT_PROVIDER_ID,
          key: '',
          host: config.apiFootball.host,
          baseUrl: config.apiFootball.baseUrl,
          ratePerMinute: config.apiFootball.ratePerMinute,
          maskedKey: null,
          row: null,
          error: null,
        };
  }

  cache = { at: Date.now(), value: resolved };
  return resolved;
}

/**
 * Push the resolved credential into a client instance. Registered as the
 * client's refresh handler and also called directly after every admin write,
 * so a credential change takes effect immediately (no app restart).
 */
async function syncClientCredential(client = apiFootball) {
  const resolved = await resolveActiveCredential({ force: true });
  client.applyCredential({
    key: resolved.key,
    host: resolved.host,
    baseUrl: resolved.baseUrl,
    source: resolved.source,
    providerId: resolved.providerId,
    ratePerMinute: resolved.ratePerMinute,
    error: resolved.error || null,
  });
  if (typeof client.onRequest !== 'function') client.onRequest = recordUpstreamRequest;
  return resolved;
}

/** Persist "last API request time" at most once every REQUEST_TOUCH_INTERVAL_MS. */
async function recordUpstreamRequest(info = {}) {
  const now = new Date();
  if (now.getTime() - lastTouchAt < REQUEST_TOUCH_INTERVAL_MS) return;
  lastTouchAt = now.getTime();
  try {
    const resolved = await resolveActiveCredential();
    if (resolved.source !== 'database' || !resolved.row) return;
    await db.updateApiCredentialState(resolved.providerId, {
      lastRequestAt: now,
      lastSuccessAt: info.ok ? now : undefined,
    });
  } catch (err) {
    log.debug('unable to persist the last API request time', { message: err.message });
  }
}

/* ---------------------------------------------------------------------- */
/* status (safe DTO for the dashboard)                                    */
/* ---------------------------------------------------------------------- */

function eventDto(row) {
  return {
    id: Number(row.id),
    provider: row.provider,
    event: row.event,
    outcome: row.outcome,
    httpStatus: row.http_status === null || row.http_status === undefined ? null : Number(row.http_status),
    endpoint: row.endpoint || null,
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    message: row.message || null,
    adminId: row.admin_id === null || row.admin_id === undefined ? null : Number(row.admin_id),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The complete, credential-free status payload behind
 * `GET /api/admin/api-management`.
 */
async function getStatus() {
  const resolved = await resolveActiveCredential({ force: true });
  const provider = providers.get(resolved.providerId) || providers.get(providers.DEFAULT_PROVIDER_ID);

  const asArray = (value) => (Array.isArray(value) ? value : []);
  let rows = [];
  let events = [];
  let recentErrors = [];
  let lastSyncs = {
    fixtures: { lastSuccessAt: null, runs: 0 },
    odds: { lastSuccessAt: null, runs: 0 },
    results: { lastSuccessAt: null, runs: 0 },
  };
  let databaseManaged = false;
  let degradedReason = null;

  try {
    rows = asArray(await db.listApiCredentials());
    events = asArray(await db.listApiConnectionEvents({ limit: 12 }));
    recentErrors = asArray(await db.listApiConnectionEvents({ limit: 12, errorsOnly: true }));
    const syncs = (await db.getLastSuccessfulSyncs(['fixtures', 'odds', 'results'])) || {};
    const pick = (job) => syncs[job] || { lastSuccessAt: null, runs: 0 };
    lastSyncs = {
      fixtures: { lastSuccessAt: isoOrNull(pick('fixtures').lastSuccessAt), runs: pick('fixtures').runs || 0 },
      odds: { lastSuccessAt: isoOrNull(pick('odds').lastSuccessAt), runs: pick('odds').runs || 0 },
      results: { lastSuccessAt: isoOrNull(pick('results').lastSuccessAt), runs: pick('results').runs || 0 },
    };
    databaseManaged = true;
  } catch (err) {
    degradedReason = err.code === 'SCHEMA_OUT_OF_DATE' ? 'SCHEMA_OUT_OF_DATE' : err.code || 'DB_UNAVAILABLE';
    log.warn('api management status could not read the credential tables', {
      code: err.code,
      message: err.message,
    });
  }

  const activeRow = databaseManaged ? rows.find((r) => Number(r.is_active) === 1) || null : null;
  // The row the admin configured for this provider — whether or not it is
  // currently the active one. A saved-but-not-active credential MUST still be
  // visible (that is how the screen shows "saved, not active yet").
  const storedRow =
    (databaseManaged ? rows.find((r) => r.provider === resolved.providerId) || null : null) || resolved.row || null;
  const breaker = apiFootball.breakerState();

  const isStoredActive = Boolean(storedRow) && Number(storedRow.is_active) === 1;
  const connectionState = resolved.error
    ? resolved.error.code === 'ENCRYPTION_KEY_MISSING'
      ? 'ENCRYPTION_KEY_MISSING'
      : 'CREDENTIAL_UNREADABLE'
    : storedRow && !isStoredActive
      ? // saved but never switched on: show the verdict of the last real test
        // when there is one, otherwise "disabled" — a saved key alone is never
        // presented as connected
        storedRow.connection_state && storedRow.connection_state !== CONNECTION_STATES.NOT_TESTED
        ? storedRow.connection_state
        : CONNECTION_STATES.DISABLED
      : storedRow
        ? storedRow.connection_state || CONNECTION_STATES.NOT_TESTED
        : resolved.source === 'environment'
          ? 'ENVIRONMENT'
          : CONNECTION_STATES.NOT_TESTED;

  return {
    provider: provider.id,
    providers: providers.list(),
    activeProviderId: activeRow ? activeRow.provider : null,
    credentialSource: resolved.source,
    databaseManaged,
    degradedReason,
    credential: storedRow
      ? {
          provider: storedRow.provider,
          host: storedRow.host,
          maskedKey: vault.maskFromStoredParts({ last4: storedRow.key_last4, length: storedRow.key_length }),
          keyLength: storedRow.key_length === null || storedRow.key_length === undefined ? null : Number(storedRow.key_length),
          isActive: Number(storedRow.is_active) === 1,
          algorithm: storedRow.key_algorithm,
          savedAt: isoOrNull(storedRow.created_at),
          updatedAt: isoOrNull(storedRow.updated_at),
          location: 'database (encrypted)',
        }
      : null,
    environment: config.apiFootball.key
      ? {
          keyConfigured: true,
          host: config.apiFootball.host,
          maskedKey: vault.maskSecret(config.apiFootball.key),
          isActive: resolved.source === 'environment',
        }
      : { keyConfigured: false, host: null, maskedKey: null, isActive: false },
    connection: {
      // One derived state drives both the badge and its label, so the two can
      // never disagree. `ENVIRONMENT` means no stored credential is in use —
      // the platform is running on API_FOOTBALL_KEY, exactly as before.
      state: connectionState,
      label: resolved.error
        ? resolved.error.message
        : connectionState === 'ENVIRONMENT'
          ? 'Environment credential in use (API_FOOTBALL_KEY)'
          : CONNECTION_LABELS[connectionState] || connectionState,
      message: resolved.error
        ? resolved.error.message
        : storedRow && !isStoredActive
          ? `Saved, not active.${
              resolved.source === 'environment'
                ? ' The platform is still using the environment credential (API_FOOTBALL_KEY).'
                : ' No credential is in use — activate this one, or configure API_FOOTBALL_KEY.'
            }`
          : connectionState === 'ENVIRONMENT'
            ? 'Using the environment credential (API_FOOTBALL_KEY). Run Test Connection for a live check.'
            : storedRow
              ? storedRow.connection_message || 'Saved. Run Test Connection for a live check.'
              : 'No API credential is configured yet.',
      // what the last real test measured — reported even while the stored
      // credential is not the active one
      lastTestState: storedRow ? storedRow.connection_state || null : null,
      lastTestMessage: storedRow ? storedRow.connection_message || null : null,
      testedAt: storedRow ? isoOrNull(storedRow.last_test_at) : null,
      latencyMs:
        storedRow && storedRow.last_test_latency_ms !== null && storedRow.last_test_latency_ms !== undefined
          ? Number(storedRow.last_test_latency_ms)
          : null,
      lastSuccessAt: storedRow ? isoOrNull(storedRow.last_success_at) : null,
      lastErrorAt: storedRow ? isoOrNull(storedRow.last_error_at) : null,
      lastErrorCode: storedRow ? storedRow.last_error_code || null : null,
      lastErrorMessage: storedRow ? storedRow.last_error_message || null : null,
      host: resolved.host,
      resolvedFromDatabase: resolved.source === 'database',
    },
    lastRequestAt: apiFootball.stats.lastCallAt || (storedRow ? isoOrNull(storedRow.last_request_at) : null),
    lastSuccessfulSyncs: lastSyncs,
    quota:
      storedRow && storedRow.quota_used_today !== null && storedRow.quota_used_today !== undefined
        ? {
            current: Number(storedRow.quota_used_today),
            limitDay: storedRow.quota_limit_day === null ? null : Number(storedRow.quota_limit_day),
            checkedAt: isoOrNull(storedRow.quota_checked_at),
            source: 'provider /status',
          }
        : null,
    rateLimits: {
      requestsPerMinute: apiFootball.ratePerMinute,
      source: 'server configuration',
      providerBudgetPerMinute: provider && provider.defaultRatePerMinute ? provider.defaultRatePerMinute : null,
    },
    plan: storedRow && storedRow.plan_name ? { name: storedRow.plan_name } : null,
    encryption: vault.status(),
    client: {
      configured: apiFootball.configured,
      host: apiFootball.host,
      calls: breaker.calls,
      failures: breaker.failures,
      cacheHits: breaker.cacheHits,
      breakerState: breaker.state,
      available: breaker.available,
    },
    recentEvents: databaseManaged ? events.map(eventDto) : [],
    recentErrors: databaseManaged ? recentErrors.map(eventDto) : [],
    predictionRules: {
      market: config.market.label,
      marketKey: config.market.key,
      oddsWindow: [config.odds.minTotalOdds, config.odds.maxTotalOdds],
      minConfidence: config.odds.minConfidence,
      maxRisk: config.odds.maxRisk,
      minDataQuality: config.odds.minDataQuality,
      maxSelections: config.odds.maxSelections,
      oddsFreshnessMinutes: config.odds.freshnessMinutes,
      automaticTicketGeneration: false,
      ticketGeneration: 'MANUAL ONLY — API changes never generate a ticket',
    },
    serverTime: new Date().toISOString(),
  };
}

/** Safe quota + connection diagnostics (used by the Refresh API Status button). */
async function getDiagnostics({ probe = false } = {}) {
  const status = await getStatus();
  let liveProbe = null;

  if (probe) {
    const resolved = await resolveActiveCredential();
    const persistProbe = async (result) => {
      if (!result.ok || !result.quota || resolved.source !== 'database') return;
      await db
        .updateApiCredentialState(resolved.providerId, {
          quotaUsedToday: result.quota.current,
          quotaLimitDay: result.quota.limitDay,
          quotaCheckedAt: new Date(),
          planName: result.plan ? result.plan.name : undefined,
          connectionState: CONNECTION_STATES.CONNECTED,
          connectionMessage: result.message,
          lastSuccessAt: new Date(),
        })
        .catch((err) => log.warn('unable to persist the probe quota', { message: err.message }));
      invalidate();
    };
    if (resolved.error) {
      liveProbe = {
        ok: false,
        state: resolved.error.code === 'ENCRYPTION_KEY_MISSING' ? 'ENCRYPTION_KEY_MISSING' : 'CREDENTIAL_UNREADABLE',
        label: resolved.error.message,
        message: resolved.error.message,
        quota: null,
        skipped: true,
      };
    } else if (!apiFootball.configured) {
      liveProbe = {
        ok: false,
        state: CONNECTION_STATES.CONFIG_INCOMPLETE,
        label: CONNECTION_LABELS.CONFIG_INCOMPLETE,
        message: 'No API credential is configured, so there is nothing to probe.',
        quota: null,
        skipped: true,
      };
    } else {
      // One real request to the provider's /status endpoint. Pressing Refresh
      // again inside the reuse window returns the verdict that was just
      // measured (flagged `reused`) instead of making a second call — the
      // client's own TTL cache covers the longer window after that.
      const fingerprint = resolved.key ? vault.fingerprint(resolved.key) : null;
      const now = Date.now();
      const comparable =
        lastProbe.result &&
        lastProbe.provider === resolved.providerId &&
        lastProbe.host === resolved.host &&
        lastProbe.keyFingerprint === fingerprint;
      if (comparable && now - lastProbe.at < testWindows.reuseMs) {
        liveProbe = { ...lastProbe.result, reused: true, testedAt: new Date(lastProbe.at).toISOString() };
      } else {
        liveProbe = await apiFootball.probeCredentials();
        lastProbe = { at: now, keyFingerprint: fingerprint, host: resolved.host, provider: resolved.providerId, result: liveProbe };
        await persistProbe(liveProbe);
      }
    }
  }

  return {
    quota: liveProbe && liveProbe.quota ? { ...liveProbe.quota, source: 'provider /status' } : status.quota,
    rateLimits: status.rateLimits,
    connection: status.connection,
    liveProbe,
    recentErrors: status.recentErrors,
    encryption: status.encryption,
    serverTime: status.serverTime,
  };
}

/* ---------------------------------------------------------------------- */
/* writes                                                                 */
/* ---------------------------------------------------------------------- */

async function recordEvent({ provider, event, outcome, httpStatus = null, endpoint = null, latencyMs = null, message = null, context = null, adminId = null, req = null }) {
  try {
    await db.insertApiConnectionEvent({
      provider,
      event,
      outcome,
      httpStatus,
      endpoint,
      latencyMs,
      message,
      context,
      adminId,
      ipAddress: req ? req.ip : null,
    });
  } catch (err) {
    // Diagnostics must never break an administrative action.
    log.warn('unable to persist an API connection event', { event, outcome, message: err.message });
  }
}

/**
 * Save (or replace) the credential of a provider, encrypted at rest.
 * Saving NEVER activates the credential and never touches a ticket.
 */
async function saveCredential({ provider: providerId, key, host }, { adminId = null, req = null } = {}) {
  const provider = providers.requireProvider(providerId);
  const hostEntry = providers.requireHost(provider, host);
  const apiKey = String(key || '').trim();
  if (!apiKey) throw AppError.badRequest('An API key is required', 'API_KEY_REQUIRED');
  if (apiKey.length < 8) throw AppError.badRequest('That API key is too short to be valid', 'API_KEY_TOO_SHORT');
  if (apiKey.length > 256) throw AppError.badRequest('That API key is too long', 'API_KEY_TOO_LONG');
  if (/[\s\r\n]/.test(apiKey)) {
    throw AppError.badRequest('The API key must not contain spaces or line breaks', 'API_KEY_MALFORMED');
  }

  // With no usable master key this throws ENCRYPTION_KEY_MISSING:
  // nothing is written and the plaintext key is never persisted.
  const encrypted = vault.encryptSecret(apiKey, { provider: provider.id, field: 'api_key' });

  const existing = await db.getApiCredential(provider.id);
  await db.upsertApiCredential({
    provider: provider.id,
    host: hostEntry.id,
    keyCiphertext: encrypted.ciphertext,
    keyIv: encrypted.iv,
    keyTag: encrypted.tag,
    keyAlgorithm: encrypted.algorithm,
    keyId: encrypted.keyId,
    keyLast4: vault.lastFour(apiKey),
    keyLength: apiKey.length,
    keyFingerprint: vault.fingerprint(apiKey),
    connectionState: CONNECTION_STATES.NOT_TESTED,
    connectionMessage: 'Credential saved — run Test Connection for a live check. Saving does not mark the provider connected.',
    rateLimitPerMinute: providers.ratePerMinute(provider, existing ? existing.rate_limit_per_minute : null),
    createdByAdminId: adminId,
    updatedByAdminId: adminId,
  });

  invalidate();
  await recordEvent({
    provider: provider.id,
    event: 'SAVED',
    outcome: 'SUCCESS',
    message: existing ? 'API credential replaced' : 'API credential saved',
    context: { host: hostEntry.id, replaced: Boolean(existing), keyLength: apiKey.length },
    adminId,
    req,
  });

  // The stored credential only becomes effective once it is activated; the
  // environment configuration (or an already active credential) stays in force.
  const resolved = await resolveActiveCredential({ force: true });
  if (resolved.source === 'database') await syncClientCredential(apiFootball);

  const status = await getStatus();
  return {
    saved: true,
    provider: provider.id,
    host: hostEntry.id,
    maskedKey: vault.maskFromStoredParts({ last4: vault.lastFour(apiKey), length: apiKey.length }),
    replaced: Boolean(existing),
    isActive: Boolean(status.credential && status.credential.isActive),
    status,
  };
}

/**
 * REAL connection test. It performs one server-side request to the provider's
 * official /status endpoint — nothing else. It never saves, never activates,
 * never generates a ticket.
 */
async function testConnection({ provider: providerId, key, host }, { adminId = null, req = null } = {}) {
  const provider = providers.requireProvider(providerId);
  const hostEntry = providers.requireHost(provider, host);

  const providedKey = key === undefined || key === null ? '' : String(key).trim();
  let apiKey = providedKey;
  let keyOrigin = 'supplied';

  if (!apiKey) {
    const existing = await db.getApiCredential(provider.id).catch(() => null);
    if (existing) {
      apiKey = vault.decryptSecret(existing, { provider: provider.id });
      keyOrigin = 'stored';
    } else if (config.apiFootball.key) {
      apiKey = config.apiFootball.key;
      keyOrigin = 'environment';
    }
  }

  if (!apiKey) {
    const result = {
      ok: false,
      state: CONNECTION_STATES.CONFIG_INCOMPLETE,
      label: CONNECTION_LABELS.CONFIG_INCOMPLETE,
      message: 'No API key to test: enter one, save it, or configure API_FOOTBALL_KEY on the server.',
      provider: provider.id,
      host: hostEntry.id,
      keyOrigin: null,
      endpoint: provider.testEndpoint,
      httpStatus: null,
      latencyMs: 0,
      quota: null,
      plan: null,
      testedAt: new Date().toISOString(),
      reused: false,
    };
    await recordEvent({
      provider: provider.id,
      event: 'TEST_FAILED',
      outcome: result.state,
      endpoint: provider.testEndpoint,
      message: result.message,
      adminId,
      req,
    });
    return result;
  }

  const fingerprint = vault.fingerprint(apiKey);
  const now = Date.now();

  // 1. Do not repeat the very same test microseconds later (double click,
  //    two open tabs): report the cached verdict instead of a second call.
  if (
    lastTest.result &&
    lastTest.provider === provider.id &&
    lastTest.host === hostEntry.id &&
    lastTest.keyFingerprint === fingerprint &&
    now - lastTest.at < testWindows.reuseMs
  ) {
    return { ...lastTest.result, reused: true, testedAt: new Date(lastTest.at).toISOString() };
  }

  // 2. Hard floor between two real provider tests from this process.
  if (now - lastTest.at < testWindows.minIntervalMs && lastTest.result) {
    throw AppError.tooMany(
      `Please wait ${Math.ceil((testWindows.minIntervalMs - (now - lastTest.at)) / 1000)}s before testing the connection again.`,
      'TEST_THROTTLED'
    );
  }

  const client = clientFactory({
    key: apiKey,
    host: hostEntry.id,
    baseUrl: hostEntry.baseUrl,
    timeoutMs: config.apiCredentials.testTimeoutMs,
    maxRetries: 0,
    ratePerMinute: providers.ratePerMinute(provider, null),
    credentialSource: keyOrigin,
    providerId: provider.id,
    // candidate credential: never let the live-credential resolver replace it
    manageCredential: false,
  });

  const probe = await client.probeCredentials({ endpoint: provider.testEndpoint });
  const result = {
    ok: probe.ok,
    state: probe.state,
    label: probe.label,
    message: probe.message,
    provider: provider.id,
    host: hostEntry.id,
    keyOrigin,
    endpoint: provider.testEndpoint,
    httpStatus: probe.httpStatus,
    latencyMs: probe.latencyMs,
    quota: probe.quota,
    plan: probe.plan,
    testedAt: new Date().toISOString(),
    reused: false,
  };

  lastTest = { at: Date.now(), keyFingerprint: fingerprint, host: hostEntry.id, provider: provider.id, result };

  // Persist the verdict for the provider whose credential this is: a test with
  // a typed-but-unsaved key must not overwrite the diagnostics of a stored one.
  const stored = await db.getApiCredential(provider.id).catch(() => null);
  if (stored) {
    await db
      .updateApiCredentialState(provider.id, {
        connectionState: result.state,
        connectionMessage: result.message,
        lastTestAt: new Date(),
        lastTestLatencyMs: result.latencyMs,
        lastSuccessAt: probe.ok ? new Date() : undefined,
        lastRequestAt: new Date(),
        lastErrorAt: probe.ok ? undefined : new Date(),
        lastErrorCode: probe.ok ? undefined : result.state,
        lastErrorMessage: probe.ok ? undefined : result.message,
        quotaUsedToday: probe.quota ? probe.quota.current : undefined,
        quotaLimitDay: probe.quota ? probe.quota.limitDay : undefined,
        quotaCheckedAt: probe.quota ? new Date() : undefined,
        planName: probe.plan && probe.plan.name ? probe.plan.name : undefined,
      })
      .catch((err) => log.warn('unable to persist the connection test result', { message: err.message }));
    invalidate();
  }

  await recordEvent({
    provider: provider.id,
    event: probe.ok ? 'TEST_OK' : 'TEST_FAILED',
    outcome: result.state,
    httpStatus: result.httpStatus,
    endpoint: result.endpoint,
    latencyMs: result.latencyMs,
    message: result.message,
    context: { host: result.host, keyOrigin, quota: result.quota || null },
    adminId,
    req,
  });

  return result;
}

/**
 * Activate a saved provider (the server starts using the database-managed
 * credential). Refuses when nothing has been saved yet — activation is not a
 * substitute for configuring a key.
 */
async function activateProvider(providerId, { adminId = null, req = null } = {}) {
  const provider = providers.requireProvider(providerId);
  const row = await db.getApiCredential(provider.id);
  if (!row) {
    throw AppError.badRequest(
      'Save an API key for this provider before activating it.',
      'NOTHING_TO_ACTIVATE'
    );
  }
  // Prove the stored credential is readable BEFORE switching the platform to
  // it: activating an undecryptable credential would take the data source down.
  vault.decryptSecret(row, { provider: provider.id });

  await db.activateApiProvider(provider.id, adminId);
  await db.updateApiCredentialState(provider.id, { updatedByAdminId: adminId });
  invalidate();
  await syncClientCredential(apiFootball);
  await recordEvent({
    provider: provider.id,
    event: 'ACTIVATED',
    outcome: 'SUCCESS',
    message: 'Database-managed credential activated',
    context: { host: row.host },
    adminId,
    req,
  });
  return { activated: true, provider: provider.id, status: await getStatus() };
}

/**
 * Stop using the stored credential. The credential stays encrypted in the
 * database so it can be re-activated; the platform falls back to the
 * environment configuration exactly as before this feature existed.
 */
async function disableProvider(providerId, { adminId = null, req = null } = {}) {
  const provider = providers.requireProvider(providerId);
  const row = await db.getApiCredential(provider.id);
  if (!row) {
    throw AppError.badRequest('No saved credential exists for this provider.', 'NOTHING_TO_DISABLE');
  }
  await db.deactivateApiProvider(provider.id, adminId);
  invalidate();
  await syncClientCredential(apiFootball);
  await recordEvent({
    provider: provider.id,
    event: 'DISABLED',
    outcome: 'SUCCESS',
    message: 'Database-managed credential disabled — the server falls back to the environment configuration',
    adminId,
    req,
  });
  const resolved = await resolveActiveCredential({ force: true });
  return {
    disabled: true,
    provider: provider.id,
    credentialSource: resolved.source,
    status: await getStatus(),
  };
}

/** Reset module state (tests only — never used by a request path). */
function __resetForTests() {
  invalidate();
  lastTest = { at: 0, keyFingerprint: null, host: null, provider: null, result: null };
  lastProbe = { at: 0, keyFingerprint: null, host: null, provider: null, result: null };
  lastTouchAt = 0;
  testWindows = { ...TEST_WINDOW_DEFAULTS };
}

module.exports = {
  OK_STATES,
  invalidate,
  resolveActiveCredential,
  syncClientCredential,
  recordUpstreamRequest,
  getStatus,
  getDiagnostics,
  saveCredential,
  testConnection,
  activateProvider,
  disableProvider,
  environmentCredential,
  setClientFactory,
  setTestWindowsForTests,
  __resetForTests,
};
