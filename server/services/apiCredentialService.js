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
const settingsService = require('./settingsService');
const { inspectStorage } = require('./credentialStorageService');
const { normalizeApiKey, redactSecret } = require('../utils/providerConfig');
const {
  ApiFootballClient,
  CONNECTION_STATES,
  CONNECTION_LABELS,
  apiFootball,
  reasonInfo,
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
let probeInFlight = null;
let lastProbeStartedAt = 0;

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
  if (!config.apiFootball.key) return null;
  const provider = providers.get(providerId);
  try {
    const key = normalizeApiKey(config.apiFootball.key);
    const host = providers.requireHost(provider, config.apiFootball.host);
    return { providerId, key, host: host.id, baseUrl: host.baseUrl,
      ratePerMinute: config.apiFootball.ratePerMinute, source: 'environment', savedAt: null, maskedKey: vault.maskSecret(key) };
  } catch (_err) {
    return { providerId, key: '', host: null, baseUrl: null, source: 'environment', maskedKey: null,
      error: new AppError('The environment API host or key is invalid. Select an approved host in API Management or correct API_FOOTBALL_HOST / API_FOOTBALL_KEY.', { code: 'CONFIG_INVALID', status: 503 }) };
  }
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
      ? { ...env, source: 'environment', row: null, error: env.error || null }
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
  if (info.ok && now.getTime() - lastTouchAt < REQUEST_TOUCH_INTERVAL_MS) return;
  lastTouchAt = now.getTime();
  try {
    const resolved = await resolveActiveCredential();
    if (resolved.source !== 'database' || !resolved.row || !resolved.key) return;
    const fingerprint = vault.fingerprint(resolved.key);
    if (info.identity && (info.identity.fingerprint !== fingerprint || info.identity.host !== resolved.host)) return;
    const state = info.errorCode === 'AUTH_REJECTED' ? 'INVALID_KEY' : info.errorCode;
    await db.updateApiCredentialState(resolved.providerId, {
      lastRequestAt: now, lastSuccessAt: info.ok ? now : undefined,
      lastErrorAt: info.ok ? null : now, lastErrorCode: info.ok ? null : state,
      lastErrorMessage: info.ok ? null : info.message,
    }, { fingerprint, host: resolved.host });
  } catch (err) {
    log.debug('unable to persist the last API request time', { message: err.message });
  }
}

function latestProbe(providerId, host, fingerprint) {
  return [lastTest, lastProbe]
    .filter((item) => item.result && item.provider === providerId && item.host === host && item.keyFingerprint === fingerprint)
    .sort((a, b) => b.at - a.at)[0] || null;
}

/** Reconcile a real probe with the live client only if the identity still matches. */
async function applyLiveProbe(result, { providerId, host, fingerprint }) {
  const resolved = await syncClientCredential(apiFootball);
  if (resolved.error || !resolved.key || resolved.providerId !== providerId || resolved.host !== host || vault.fingerprint(resolved.key) !== fingerprint) return;
  if (result.quota) apiFootball._learnQuotaFromStatus({ requests: { current: result.quota.current, limit_day: result.quota.limitDay } });
  if (result.rateLimitPerMinute > 0) {
    apiFootball._quota.perMinuteLimit = result.rateLimitPerMinute;
    apiFootball.ratePerMinute = Math.min(apiFootball.ratePerMinute, result.rateLimitPerMinute);
  }
  if (!result.reused) {
    apiFootball.stats.lastCallAt = result.testedAt;
    if (result.ok) apiFootball._recordSuccess();
    else apiFootball._recordFailure(result.message, { reason: result.reason || result.state, hint: result.hint,
      httpStatus: result.httpStatus, networkCode: result.networkCode, tripBreaker: false });
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
  const resolved = await syncClientCredential(apiFootball);
  const settings = await settingsService.getEngineSettings();
  const provider = providers.get(resolved.providerId) || providers.get(providers.DEFAULT_PROVIDER_ID);

  const asArray = (value) => (Array.isArray(value) ? value : []);
  // Separate, read-only probes replace one try/catch that used to label EVERY
  // failure (database down, migration missing, permission denied, history
  // query broken) as the same "storage unavailable" sentence.
  const { report: storage, data: storageData } = await inspectStorage();
  const rows = asArray(storageData.rows);
  const events = asArray(storageData.events);
  const recentErrors = asArray(storageData.recentErrors);
  const syncs = storageData.lastSyncs || {};
  const pick = (job) => syncs[job] || { lastSuccessAt: null, runs: 0 };
  const lastSyncs = {
    fixtures: { lastSuccessAt: isoOrNull(pick('fixtures').lastSuccessAt), runs: pick('fixtures').runs || 0 },
    odds: { lastSuccessAt: isoOrNull(pick('odds').lastSuccessAt), runs: pick('odds').runs || 0 },
    results: { lastSuccessAt: isoOrNull(pick('results').lastSuccessAt), runs: pick('results').runs || 0 },
  };
  // The credential tables are readable and present. A broken diagnostics
  // history does not make storage unavailable and must not disable saving.
  const databaseManaged = storage.database.reachable && storage.schema.ready && storage.credentials.readable;
  const degradedReason = databaseManaged
    ? storage.history.ready
      ? null
      : 'HISTORY_UNAVAILABLE'
    : storage.state === 'SCHEMA_OUT_OF_DATE'
      ? 'SCHEMA_OUT_OF_DATE'
      : !storage.database.reachable
        ? 'DB_UNAVAILABLE'
        : storage.state;
  if (degradedReason) {
    log.warn('api management storage is degraded', {
      state: storage.state,
      reason: degradedReason,
      databaseReachable: storage.database.reachable,
      schemaReady: storage.schema.ready,
      historyReady: storage.history.ready,
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
  const selectedHost = storedRow ? providers.normalizeHost(storedRow.host) : resolved.host;
  const selectedFingerprint = storedRow ? storedRow.key_fingerprint : resolved.key ? vault.fingerprint(resolved.key) : null;
  const measured = latestProbe(provider.id, selectedHost, selectedFingerprint);
  const measuredResult = measured && measured.result;
  const lastStoredError = storedRow && isoOrNull(storedRow.last_error_at);
  const lastStoredSuccess = storedRow && isoOrNull(storedRow.last_success_at);
  const storedOutcome = isStoredActive && (lastStoredError || lastStoredSuccess)
    ? lastStoredError && (!lastStoredSuccess || lastStoredError >= lastStoredSuccess)
      ? { ok: false, at: lastStoredError, reason: storedRow.last_error_code === 'INVALID_KEY' ? 'AUTH_REJECTED' : storedRow.last_error_code, message: storedRow.last_error_message }
      : { ok: true, at: lastStoredSuccess }
    : null;
  const live = !storedRow || isStoredActive
    ? [apiFootball.stats.lastOutcome, storedOutcome].filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null : null;
  const liveCurrent = live && (!measured || new Date(live.at).getTime() >= measured.at);
  const liveFailed = liveCurrent && !live.ok;
  const liveState = liveFailed ? live.reason === 'AUTH_REJECTED' ? 'INVALID_KEY' : live.reason || 'NETWORK_ERROR' : null;
  const currentQuota = (!storedRow || isStoredActive) ? apiFootball.quotaState() : null;
  const measuredQuota = measuredResult && measuredResult.quota ? { ...measuredResult.quota, checkedAt: measuredResult.testedAt, source: 'provider /status' } : null;
  const storedQuota = storedRow && storedRow.quota_used_today != null ? { current: Number(storedRow.quota_used_today), limitDay: storedRow.quota_limit_day == null ? null : Number(storedRow.quota_limit_day), checkedAt: isoOrNull(storedRow.quota_checked_at), source: 'provider /status' } : null;
  let quota = currentQuota && currentQuota.current !== null ? { current: currentQuota.current, limitDay: currentQuota.limitDay, checkedAt: currentQuota.checkedAt, source: currentQuota.source } : measuredQuota || storedQuota;
  if (quota && (!quota.checkedAt || quota.checkedAt.slice(0, 10) !== new Date().toISOString().slice(0, 10))) quota = null;
  const reason = resolved.error ? resolved.error.code : currentQuota && currentQuota.exhausted ? 'QUOTA_EXCEEDED'
    : liveCurrent ? live.ok ? null : live.reason : measuredResult ? measuredResult.reason || null : null;
  const hint = reason ? liveFailed && live.hint || measuredResult && measuredResult.reason === reason && measuredResult.hint || reasonInfo(reason).hint : null;
  const connectionState = resolved.error
    ? resolved.error.code === 'ENCRYPTION_KEY_MISSING'
      ? 'ENCRYPTION_KEY_MISSING'
      : resolved.error.code === 'CONFIG_INVALID' ? 'CONFIG_INCOMPLETE' : 'CREDENTIAL_UNREADABLE'
    : currentQuota && currentQuota.exhausted ? 'QUOTA_EXCEEDED'
    : liveCurrent ? liveState || 'CONNECTED'
    : measuredResult ? measuredResult.state
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
    effectiveCredential: { source: resolved.source, host: resolved.host, maskedKey: resolved.maskedKey || null },
    databaseManaged,
    degradedReason,
    // Independent of the provider connection: a successful /status test does
    // NOT prove that a credential can be stored. This object does.
    storage,
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
        : currentQuota && currentQuota.exhausted ? 'The daily quota is exhausted; data requests resume after the next reset.'
        : liveCurrent ? live.ok ? 'The provider accepted the latest request.' : live.message
        : measuredResult ? measuredResult.message + (storedRow && !isStoredActive ? ' Saved credential is not active.' : '')
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
      inUse: !storedRow || isStoredActive,
      reason,
      hint,
      networkCode: liveCurrent ? liveFailed ? live.networkCode || null : null : measuredResult ? measuredResult.networkCode || null : null,
      lastTestState: measuredResult ? measuredResult.state : storedRow ? storedRow.connection_state || null : null,
      lastTestMessage: storedRow ? storedRow.connection_message || null : null,
      testedAt: measuredResult ? measuredResult.testedAt : storedRow ? isoOrNull(storedRow.last_test_at) : null,
      latencyMs: measuredResult ? measuredResult.latencyMs :
        storedRow && storedRow.last_test_latency_ms !== null && storedRow.last_test_latency_ms !== undefined
          ? Number(storedRow.last_test_latency_ms)
          : null,
      lastSuccessAt: storedRow ? isoOrNull(storedRow.last_success_at) : apiFootball.stats.lastSuccessAt || null,
      lastErrorAt: storedRow ? isoOrNull(storedRow.last_error_at) : null,
      lastErrorCode: liveFailed ? live.reason : storedRow ? storedRow.last_error_code || null : null,
      lastErrorMessage: liveFailed ? live.message : storedRow ? storedRow.last_error_message || null : null,
      host: selectedHost,
      resolvedFromDatabase: resolved.source === 'database',
    },
    lastRequestAt: apiFootball.stats.lastCallAt || (storedRow ? isoOrNull(storedRow.last_request_at) : null),
    lastSuccessfulSyncs: lastSyncs,
    quota,
    rateLimits: {
      requestsPerMinute: apiFootball.ratePerMinute,
      source: currentQuota && currentQuota.perMinuteLimit ? 'provider response headers' : 'server configuration',
      providerBudgetPerMinute: currentQuota ? currentQuota.perMinuteLimit : null,
    },
    plan: measuredResult && measuredResult.plan ? measuredResult.plan : storedRow && storedRow.plan_name ? { name: storedRow.plan_name } : null,
    encryption: vault.status(),
    client: {
      configured: apiFootball.configured,
      host: apiFootball.host,
      calls: breaker.calls,
      failures: breaker.failures,
      cacheHits: breaker.cacheHits,
      breakerState: breaker.state,
      available: breaker.available,
      // WHY requests are paused (quota / breaker / missing key) and until when
      reason: breaker.reason || null,
      label: breaker.label || null,
      resetsAt: breaker.resetsAt || null,
      retryInMs: breaker.retryInMs === undefined ? null : breaker.retryInMs,
      quotaState: breaker.quotaState || null,
    },
    recentEvents: databaseManaged ? events.map(eventDto) : [],
    recentErrors: databaseManaged ? recentErrors.map(eventDto) : [],
    predictionRules: {
      market: config.market.label,
      marketKey: config.market.key,
      oddsWindow: [Number(settings.minTotalOdds), Number(settings.maxTotalOdds)],
      confidenceMode: settings.confidenceMode || 'auto',
      minConfidence: Number(settings.minConfidence),
      maxRisk: Number(settings.maxRisk),
      minDataQuality: Number(settings.minDataQuality),
      maxSelections: Number(settings.maxSelections),
      oddsFreshnessMinutes: Number(settings.oddsFreshnessMinutes),
      automaticTicketGeneration: false,
      ticketGeneration: 'MANUAL ONLY — API changes never generate a ticket',
    },
    serverTime: new Date().toISOString(),
  };
}

/**
 * Read-only credential-storage diagnostic for the admin console.
 * It never writes, never creates a key and never returns a secret.
 */
async function getStorageDiagnostics() {
  const { report } = await inspectStorage();
  return report;
}

/** Safe quota + connection diagnostics (used by the Refresh API Status button). */
async function getDiagnostics({ probe = false } = {}) {
  let liveProbe = null;
  if (probe) {
    const resolved = await syncClientCredential(apiFootball);
    if (resolved.error || !resolved.key) {
      liveProbe = { ok: false, state: resolved.error ? resolved.error.code : 'CONFIG_INCOMPLETE',
        label: resolved.error ? resolved.error.message : CONNECTION_LABELS.CONFIG_INCOMPLETE,
        message: resolved.error ? resolved.error.message : 'No API credential is configured, so there is nothing to probe.',
        quota: null, skipped: true };
    } else {
      liveProbe = await testConnection({ provider: resolved.providerId, key: resolved.key, host: resolved.host });
      lastProbe = { at: new Date(liveProbe.testedAt).getTime(), keyFingerprint: vault.fingerprint(resolved.key), host: resolved.host, provider: resolved.providerId, result: liveProbe };
    }
  }
  // Re-read AFTER the request so quota, badge, last test and errors agree.
  const status = await getStatus();
  return { quota: status.quota, rateLimits: status.rateLimits, connection: status.connection,
    liveProbe, recentErrors: status.recentErrors, encryption: status.encryption,
    storage: status.storage, serverTime: status.serverTime, status };
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
  const apiKey = normalizeApiKey(key);

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
  const stored = await db.getApiCredential(provider.id).catch(() => null);
  const supplied = key !== undefined && key !== null && String(key).trim() !== '';
  const keyOrigin = supplied ? 'supplied' : stored ? 'stored' : 'environment';
  const rawKey = supplied ? key : stored ? vault.decryptSecret(stored, { provider: provider.id }) : config.apiFootball.key;
  // No host supplied means the host associated with that credential, not an
  // arbitrary direct-host default for a RapidAPI key.
  const hostEntry = providers.requireHost(provider, host || (stored ? stored.host : config.apiFootball.host));
  if (!rawKey) {
    return { ok: false, state: CONNECTION_STATES.CONFIG_INCOMPLETE, label: CONNECTION_LABELS.CONFIG_INCOMPLETE,
      reason: 'NO_API_KEY', message: 'No API key to test: enter one, save it, or configure API_FOOTBALL_KEY on the server.',
      provider: provider.id, host: hostEntry.id, keyOrigin: null, endpoint: provider.testEndpoint,
      httpStatus: null, latencyMs: 0, quota: null, plan: null, testedAt: new Date().toISOString(), reused: false };
  }
  const apiKey = normalizeApiKey(rawKey);
  const fingerprint = vault.fingerprint(apiKey);
  const identity = { providerId: provider.id, host: hostEntry.id, fingerprint };
  const result = await runProbe({ provider, hostEntry, apiKey, keyOrigin, fingerprint });
  // Compare both the key and host. Testing an UNSAVED candidate (or a wrong
  // host) must never overwrite the saved credential's diagnostics. The SQL
  // condition also protects against rotation while the provider is answering.
  if (stored && stored.key_fingerprint === fingerprint && providers.normalizeHost(stored.host) === hostEntry.id) {
    await db.updateApiCredentialState(provider.id, {
      connectionState: result.state, connectionMessage: result.message,
      lastTestAt: new Date(result.testedAt), lastTestLatencyMs: result.latencyMs,
      lastSuccessAt: result.ok ? new Date(result.testedAt) : undefined,
      lastRequestAt: new Date(result.testedAt), lastErrorAt: result.ok ? null : new Date(result.testedAt),
      lastErrorCode: result.ok ? null : result.state, lastErrorMessage: result.ok ? null : result.message,
      quotaUsedToday: result.quota ? result.quota.current : undefined,
      quotaLimitDay: result.quota ? result.quota.limitDay : undefined,
      quotaCheckedAt: result.quota ? new Date(result.testedAt) : undefined,
      planName: result.plan ? result.plan.name : undefined,
    }, { fingerprint, host: stored.host }).catch((err) => log.warn('unable to persist the connection test result', { message: err.message }));
    invalidate();
  }
  await applyLiveProbe(result, identity);
  if (!result.reused) await recordEvent({
    provider: provider.id, event: result.ok ? 'TEST_OK' : 'TEST_FAILED', outcome: result.state,
    httpStatus: result.httpStatus, endpoint: result.endpoint, latencyMs: result.latencyMs, message: result.message,
    context: { host: result.host, keyOrigin, reason: result.reason, networkCode: result.networkCode, quota: result.quota }, adminId, req,
  });
  return result;
}

async function runProbe({ provider, hostEntry, apiKey, keyOrigin, fingerprint }) {
  const identity = `${provider.id}:${hostEntry.id}:${fingerprint}`;
  const cached = latestProbe(provider.id, hostEntry.id, fingerprint);
  if (cached && Date.now() - cached.at < testWindows.reuseMs) return { ...cached.result, keyOrigin, reused: true };
  if (probeInFlight) {
    if (probeInFlight.identity === identity) return { ...await probeInFlight.promise, keyOrigin, reused: true };
    throw AppError.tooMany('A connection test is already running. Please wait for its result.', 'TEST_THROTTLED');
  }
  if (lastProbeStartedAt && Date.now() - lastProbeStartedAt < testWindows.minIntervalMs) {
    throw AppError.tooMany('Please wait a few seconds before testing another credential.', 'TEST_THROTTLED');
  }
  lastProbeStartedAt = Date.now();
  const promise = (async () => {
    const client = clientFactory({ key: apiKey, host: hostEntry.id, baseUrl: hostEntry.baseUrl,
      timeoutMs: config.apiCredentials.testTimeoutMs, maxRetries: 0,
      ratePerMinute: providers.ratePerMinute(provider, null), credentialSource: keyOrigin,
      providerId: provider.id, manageCredential: false });
    const probe = await client.probeCredentials({ endpoint: provider.testEndpoint });
    const result = {
      ok: probe.ok, state: probe.state, label: probe.label,
      message: redactSecret(probe.message, apiKey), reason: probe.reason || null,
      hint: probe.hint ? redactSecret(probe.hint, apiKey) : null, networkCode: probe.networkCode || null,
      resetAt: probe.resetAt || null, provider: provider.id, host: hostEntry.id, keyOrigin,
      endpoint: provider.testEndpoint, httpStatus: probe.httpStatus, latencyMs: probe.latencyMs,
      quota: probe.quota, plan: probe.plan, rateLimitPerMinute: probe.rateLimitPerMinute || null, testedAt: new Date().toISOString(), reused: false,
    };
    lastTest = { at: new Date(result.testedAt).getTime(), keyFingerprint: fingerprint, host: hostEntry.id, provider: provider.id, result };
    return result;
  })();
  probeInFlight = { identity, promise };
  try { return await promise; } finally { if (probeInFlight && probeInFlight.promise === promise) probeInFlight = null; }
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
  lastProbeStartedAt = 0;
  probeInFlight = null;
  testWindows = { ...TEST_WINDOW_DEFAULTS };
}

module.exports = {
  OK_STATES,
  invalidate,
  resolveActiveCredential,
  syncClientCredential,
  recordUpstreamRequest,
  getStatus,
  getStorageDiagnostics,
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
