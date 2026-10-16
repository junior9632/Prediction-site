'use strict';

/**
 * API-Football PRO client (v3).
 *
 *  - The API key lives ONLY here (server side). It is never rendered into
 *    HTML, never sent to the browser and never logged (see utils/logger scrub).
 *  - Token-bucket rate limiting + short TTL cache keep request usage low.
 *  - A circuit breaker flips the platform into "DATA SOURCE TEMPORARILY
 *    UNAVAILABLE" instead of letting callers invent replacement data.
 */

const config = require('../config');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

const log = logger.child('api-football');

/**
 * How often the client re-asks the credential service which key/host is
 * active. The service caches its own database read, so this is a cheap check
 * that lets an administrator switch credentials from the dashboard without
 * restarting the Node.js application.
 */
const CREDENTIAL_REFRESH_MS = 15 * 1000;

/**
 * Request-outcome classifications used by the admin "Test Connection" screen
 * (see services/apiCredentialService.js). They describe what the PROVIDER
 * really said — never a guess.
 */
const CONNECTION_STATES = Object.freeze({
  CONNECTED: 'CONNECTED',
  INVALID_KEY: 'INVALID_KEY',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  CONFIG_INCOMPLETE: 'CONFIG_INCOMPLETE',
  NOT_TESTED: 'NOT_TESTED',
  DISABLED: 'DISABLED',
});

/** Human readable labels for the dashboard. */
const CONNECTION_LABELS = Object.freeze({
  CONNECTED: 'Connection successful',
  INVALID_KEY: 'Invalid API key or unauthorized',
  QUOTA_EXCEEDED: 'Daily quota exceeded',
  RATE_LIMITED: 'Rate limit exceeded',
  NETWORK_ERROR: 'Network failure',
  TIMEOUT: 'Request timed out',
  PROVIDER_UNAVAILABLE: 'Provider unavailable',
  CONFIG_INCOMPLETE: 'Configuration incomplete',
  NOT_TESTED: 'Not tested yet',
  DISABLED: 'Provider disabled',
});

/**
 * WHY AN UPSTREAM CALL FAILED — one stable reason code per cause.
 *
 * Every failure of the data source used to be reported as the same sentence
 * ("DATA SOURCE TEMPORARILY UNAVAILABLE"), which told an operator nothing: a
 * spent daily quota, a wrong key, a provider outage and a DNS problem all
 * looked identical. These codes make each cause distinguishable in the sync
 * log, the admin dashboard, `/api/health` and `npm run api:check`.
 */
const UNAVAILABLE_REASONS = Object.freeze({
  NO_API_KEY: 'NO_API_KEY',
  CREDENTIAL_UNREADABLE: 'CREDENTIAL_UNREADABLE',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  QUOTA_RESERVED: 'QUOTA_RESERVED',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH_REJECTED: 'AUTH_REJECTED',
  REQUEST_REJECTED: 'REQUEST_REJECTED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
});

/**
 * Operator-facing label + the exact fix for each reason. The label is short
 * enough for a log line, the hint is what the dashboard shows the operator.
 */
const REASON_INFO = Object.freeze({
  NO_API_KEY: {
    label: 'no API key configured',
    hint: 'Set API_FOOTBALL_KEY in the application environment (or save and ACTIVATE a key in Admin -> API Management) and restart the Node.js application.',
  },
  CREDENTIAL_UNREADABLE: {
    label: 'the stored API credential cannot be used',
    hint: 'The saved key cannot be decrypted (usually API_CREDENTIALS_ENCRYPTION_KEY changed). Re-enter and save the key in Admin -> API Management.',
  },
  CIRCUIT_OPEN: {
    label: 'circuit breaker open after repeated upstream failures',
    hint: 'The client stopped calling a failing provider; it half-opens by itself. Read the reason of the earlier failures (quota, network, provider outage).',
  },
  QUOTA_EXCEEDED: {
    label: 'daily request quota exhausted',
    hint: 'The plan\'s request budget for the day is spent. Raise the API-Football plan, lower sync_days_ahead / sync_history_days, or space the cron jobs out (see api_quota_reserve). Requests resume automatically after 00:00 UTC.',
  },
  QUOTA_RESERVED: {
    label: 'request budget reserved for manual generation',
    hint: 'Background sync paused because the remaining daily requests dropped to api_quota_reserve. That reserve exists so an administrator can still generate today\'s ticket.',
  },
  RATE_LIMITED: {
    label: 'per-minute rate limit reached',
    hint: 'Too many requests per minute for this plan (Free = 10/min). Lower API_FOOTBALL_RATE_PER_MINUTE and lower the cron frequency.',
  },
  AUTH_REJECTED: {
    label: 'the provider rejected the credential',
    hint: 'Check API_FOOTBALL_KEY and API_FOOTBALL_HOST: an api-sports.io key needs host v3.football.api-sports.io, a RapidAPI key needs the rapidapi.com host.',
  },
  REQUEST_REJECTED: {
    label: 'the provider rejected the request',
    hint: 'The plan may not include this endpoint/season, or the request parameters are outside the plan\'s range.',
  },
  PROVIDER_UNAVAILABLE: {
    label: 'the provider is temporarily unavailable',
    hint: 'API-Football answered with a server error. Nothing to change on your side — the client retries by itself.',
  },
  NETWORK_ERROR: {
    label: 'the server could not reach the provider',
    hint: 'Outbound HTTPS/DNS from the hosting account failed. Check the host\'s network, then run `npm run api:check`.',
  },
  TIMEOUT: {
    label: 'the provider did not answer in time',
    hint: 'Raise API_FOOTBALL_TIMEOUT_MS, or check the host\'s outbound network.',
  },
  EMPTY_RESPONSE: {
    label: 'the provider returned an empty body',
    hint: 'The request reached the provider but the answer was unreadable. Usually transient — retry with `npm run api:check`.',
  },
});

/** Compare an HTTP status code to a numeric limit handed over as a string. */
function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The moment API-Football resets its daily counter: 00:00 UTC. */
function nextDailyReset(from = new Date()) {
  const d = from instanceof Date ? from : new Date(from);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
}

/** The label/hint pair for a reason code (never throws). */
function reasonInfo(reason) {
  return REASON_INFO[reason] || { label: 'the data source is unavailable', hint: null };
}

/**
 * Turn any `ApiFootballUnavailable` into the structured report the dashboard,
 * the sync log and the CLI diagnostics all render. Pure — no side effects.
 *
 * @returns {{reason: string|null, label: string, hint: string|null, detail: string|null,
 *   httpStatus: number|null, resetAt: string|null, quota: object|null}}
 */
function describeUnavailable(err) {
  const details = (err && err.details) || {};
  const reason = details.reason || null;
  const info = reasonInfo(reason);
  return {
    reason,
    label: info.label,
    hint: info.hint || null,
    detail: err && err.message ? String(err.message) : null,
    httpStatus: Number.isFinite(Number(details.status)) ? Number(details.status) : null,
    resetAt: details.resetAt || null,
    quota: details.quota || null,
  };
}

/**
 * One line for the sync log / activity panel: the documented phrase plus WHY
 * it happened (and until when, when the provider told us).
 */
function unavailableMessage(err) {
  const info = describeUnavailable(err);
  const when = info.resetAt ? ` (retry after ${info.resetAt})` : '';
  return `DATA SOURCE TEMPORARILY UNAVAILABLE · ${info.label}${when}`;
}

/**
 * Classify an API-Football soft error (`errors` object returned with HTTP 200)
 * or an HTTP failure body. The provider phrases these differently depending on
 * plan, so both the wording and the HTTP status are used — and an unrecognised
 * message is reported as a generic failure rather than as a success.
 */
function classifyProviderError({ httpStatus = null, errors = null, message = '' } = {}) {
  const text = [
    message,
    errors && typeof errors === 'object' ? JSON.stringify(errors) : String(errors || ''),
  ]
    .join(' ')
    .toLowerCase();

  // Order matters: the QUOTA wording is checked first, then the HTTP status of
  // the response, and only then the remaining wording. A 5xx body may well say
  // "rate limited" in passing, and reporting that as RATE_LIMITED would be a
  // guess — the status is the fact.
  if (/request[s]? limit|daily limit|quota|limit for the day|reached the limit/.test(text)) {
    return CONNECTION_STATES.QUOTA_EXCEEDED;
  }
  if (httpStatus && httpStatus >= 500) return CONNECTION_STATES.PROVIDER_UNAVAILABLE;
  if (httpStatus === 401 || httpStatus === 403) return CONNECTION_STATES.INVALID_KEY;
  if (/missing application key|no api key|invalid api key|invalid token|token.*invalid|not authorized|unauthorized|incorrect|account suspended|subscription.*(expired|inactive|not active)|invalid.*key/.test(text)) {
    return CONNECTION_STATES.INVALID_KEY;
  }
  if (httpStatus === 429) return CONNECTION_STATES.RATE_LIMITED;
  if (/rate limit|too many requests|per minute/.test(text)) return CONNECTION_STATES.RATE_LIMITED;
  return CONNECTION_STATES.PROVIDER_UNAVAILABLE;
}

/** JSON-safe summary of a provider error — never a credential or a header. */
function summarizeProviderError(errors) {
  if (!errors) return null;
  if (Array.isArray(errors)) return errors.join('; ').slice(0, 300) || null;
  if (typeof errors === 'object') {
    try {
      return JSON.stringify(errors).slice(0, 300);
    } catch (_) {
      return null;
    }
  }
  return String(errors).slice(0, 300) || null;
}

/** Thrown whenever API-Football cannot be used right now. */
class ApiFootballUnavailable extends AppError {
  constructor(message = 'DATA SOURCE TEMPORARILY UNAVAILABLE', details = null) {
    super(message, { status: 503, code: 'DATA_SOURCE_UNAVAILABLE', details });
    this.name = 'ApiFootballUnavailable';
    this.isUpstreamFailure = true;
  }
}

const DEFAULT_TTL = {
  status: 10 * 60 * 1000,
  fixtures: 10 * 60 * 1000,
  odds: 5 * 60 * 1000,
  injuries: 30 * 60 * 1000,
  h2h: 6 * 60 * 60 * 1000,
};

class ApiFootballClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || config.apiFootball.baseUrl;
    this.key = options.key || config.apiFootball.key;
    this.host = options.host || config.apiFootball.host;
    this.isRapidApi = /rapidapi\.com/i.test(this.host);
    this.timeoutMs = options.timeoutMs || config.apiFootball.timeoutMs;
    this.maxRetries = options.maxRetries ?? config.apiFootball.maxRetries;
    this.ratePerMinute = options.ratePerMinute || config.apiFootball.ratePerMinute;
    this.fetchImpl = options.fetch || globalThis.fetch;

    // Where the current key/host came from: 'environment' (API_FOOTBALL_KEY)
    // or 'database' (an active row in api_credentials). Surfaced in the admin
    // status screen so an operator can always tell which one is in force.
    this.credentialSource = options.credentialSource || (this.key ? 'environment' : 'none');
    this.providerId = options.providerId || 'api_football';
    // The shared singleton resolves its credential from
    // services/apiCredentialService.js (database first, environment second).
    // A client built for a one-off credential probe must NOT be overwritten by
    // that resolution — it is testing a candidate key, not the live one.
    this.manageCredential = options.manageCredential !== false;
    // Set when a database-managed credential exists but cannot be used
    // (e.g. the encryption key is missing). Requests then fail loudly instead
    // of silently falling back to a different credential.
    this.credentialError = null;

    this._callTimestamps = [];
    this._cache = new Map();
    this._cacheTtl = options.cacheTtl || DEFAULT_TTL;
    this._breaker = { failures: 0, openedAt: 0, cooldownMs: options.cooldownMs || 60 * 1000 };
    this._maxFailures = options.maxFailures || 4;

    // Daily request budget learned from the provider itself: every API-Football
    // response carries `x-ratelimit-requests-limit` / `-remaining`, and
    // `/status` reports `requests.current` / `limit_day` (that call is free).
    // Knowing it lets the platform stop BEFORE the provider starts answering
    // 429s — the documented behaviour of hammering those limits is a temporary
    // firewall block of the key/IP.
    this._quota = {
      limitDay: toNumberOrNull(options.dailyLimit) || null,
      current: null,
      remaining: null,
      source: null,
      checkedAt: null,
      exhaustedUntil: 0,
      exhaustedReason: null,
      /** Per-minute budget the provider advertised (Free = 10/min). */
      perMinuteLimit: null,
    };

    // credential refresh bookkeeping (see setCredentialRefresh)
    this._credentialCheckedAt = 0;
    this._credentialRefresh = null;
    // optional listener notified after every upstream request (credential
    // service uses it to persist "last API request time"; no-op by default)
    this.onRequest = null;

    // counters surfaced in the admin "API Status" panel
    this.stats = { calls: 0, failures: 0, cacheHits: 0, lastCallAt: null, lastError: null, quota: null };
  }

  /* ------------------------------------------------------------------ */
  /* credentials                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Use a credential resolved elsewhere (environment or the database).
   * Called by services/apiCredentialService.js whenever the admin saves or
   * activates a provider, and by the periodic refresh below.
   *
   * @param {{key?: string|null, host?: string|null, baseUrl?: string|null,
   *          source?: string, providerId?: string, ratePerMinute?: number|null,
   *          error?: Error|null}} credential
   */
  applyCredential(credential = {}) {
    const nextKey = credential.key || '';
    const nextHost = credential.host || config.apiFootball.host;
    const loginChanged =
      nextKey !== this.key || nextHost !== this.host || (credential.baseUrl || null) !== this.baseUrl;

    this.key = nextKey;
    this.host = nextHost;
    this.baseUrl = credential.baseUrl || config.apiFootball.baseUrl;
    this.isRapidApi = /rapidapi\.com/i.test(this.host);
    this.credentialSource = credential.source || (nextKey ? 'environment' : 'none');
    this.providerId = credential.providerId || this.providerId;
    this.credentialError = credential.error || null;
    if (credential.ratePerMinute) this.ratePerMinute = credential.ratePerMinute;

    if (loginChanged) {
      // a different key/host must never be served a cached payload, and the
      // daily budget we learned belongs to the previous credential/plan
      this._cache.clear();
      this._breaker = { ...this._breaker, failures: 0, openedAt: 0 };
      this._quota = { ...this._quota, current: null, remaining: null, limitDay: null, source: null, exhaustedUntil: 0, exhaustedReason: null };
      log.info('API credential changed', {
        source: this.credentialSource,
        host: this.host,
        keyPresent: Boolean(nextKey),
      });
    }
    return this;
  }

  /**
   * Register the function that resolves the active credential (it lives in
   * services/apiCredentialService.js — registered lazily to avoid a
   * require cycle). A refresh handler is optional: without it the client keeps
   * using the environment configuration exactly as before.
   */
  setCredentialRefresh(fn) {
    this._credentialRefresh = typeof fn === 'function' ? fn : null;
    return this;
  }

  /**
   * Re-resolve the credential at most once every CREDENTIAL_REFRESH_MS.
   * Never throws: a database problem must not break the upstream call that is
   * about to be made.
   */
  async _refreshCredential(force = false) {
    if (!this.manageCredential) return;
    if (!force && Date.now() - this._credentialCheckedAt < CREDENTIAL_REFRESH_MS) return;
    this._credentialCheckedAt = Date.now();
    try {
      // deferred require: apiCredentialService depends on this module
      const service = this._credentialRefresh ? null : require('./apiCredentialService');
      const refresh = this._credentialRefresh || service.syncClientCredential;
      await refresh(this);
    } catch (err) {
      log.warn('unable to refresh the API credential from the database', { message: err && err.message });
    }
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                           */
  /* ------------------------------------------------------------------ */

  get configured() {
    return Boolean(this.key);
  }

  /* ------------------------------------------------------------------ */
  /* daily request budget (quota)                                        */
  /* ------------------------------------------------------------------ */

  /**
   * What we know about the plan's daily request budget right now.
   * `known:false` means the provider has not told us yet — nothing is invented.
   */
  quotaState() {
    const exhaustedByProvider = this._quota.remaining !== null && this._quota.remaining <= 0;
    const blocked = Date.now() < this._quota.exhaustedUntil;
    return {
      known: this._quota.limitDay !== null || this._quota.remaining !== null || Boolean(this._quota.exhaustedUntil),
      limitDay: this._quota.limitDay,
      current: this._quota.current,
      remaining: this._quota.remaining,
      source: this._quota.source,
      checkedAt: this._quota.checkedAt,
      exhausted: exhaustedByProvider || blocked,
      exhaustedReason: this._quota.exhaustedReason,
      resetsAt: (blocked ? new Date(this._quota.exhaustedUntil) : nextDailyReset()).toISOString(),
    };
  }

  /** Read the daily/per-minute budget the provider advertises on every answer. */
  _learnQuotaFromHeaders(res) {
    const headers = res && res.headers;
    if (!headers || typeof headers.get !== 'function') return this.quotaState();
    const limit = toNumberOrNull(headers.get('x-ratelimit-requests-limit'));
    const remaining = toNumberOrNull(headers.get('x-ratelimit-requests-remaining'));
    const perMinute = toNumberOrNull(headers.get('x-ratelimit-limit'));
    if (limit !== null) this._quota.limitDay = limit;
    if (remaining !== null) this._quota.remaining = remaining;
    if (limit !== null && remaining !== null) this._quota.current = Math.max(0, limit - remaining);
    if (limit !== null || remaining !== null) {
      this._quota.source = 'response headers';
      this._quota.checkedAt = new Date().toISOString();
    }
    if (perMinute !== null && perMinute > 0) {
      this._quota.perMinuteLimit = perMinute;
      // Never exceed the budget the provider itself advertised (Free = 10/min).
      this.ratePerMinute = Math.min(this.ratePerMinute, perMinute);
    }
    if (remaining !== null && remaining <= 0) this._markQuotaExhausted('the provider reported 0 requests left today');
    return this.quotaState();
  }

  /** Remember a plan quota we were told about (e.g. by `/status`). */
  _learnQuotaFromStatus(info) {
    if (!info || !info.requests) return this.quotaState();
    const current = toNumberOrNull(info.requests.current);
    const limitDay = toNumberOrNull(info.requests.limit_day);
    if (limitDay !== null) this._quota.limitDay = limitDay;
    if (current !== null) this._quota.current = current;
    if (limitDay !== null && current !== null) this._quota.remaining = Math.max(0, limitDay - current);
    this._quota.source = 'provider /status';
    this._quota.checkedAt = new Date().toISOString();
    this.stats.quota = {
      current: current === null ? null : current,
      limit_day: limitDay,
      remaining: this._quota.remaining,
      checkedAt: this._quota.checkedAt,
      source: this._quota.source,
    };
    if (this._quota.remaining !== null && this._quota.remaining <= 0) {
      this._markQuotaExhausted('the provider reported 0 requests left today');
    }
    return this.quotaState();
  }

  /**
   * Stop calling the provider until the daily counter resets. This is NOT a
   * credential/outage failure: the key is fine, the plan is simply out of
   * budget for today, so it must not open the circuit breaker.
   */
  _markQuotaExhausted(reason) {
    const resetsAt = nextDailyReset();
    if (Date.now() >= this._quota.exhaustedUntil) {
      log.warn('daily API request budget exhausted — upstream calls paused until the reset', {
        reason,
        resetsAt: resetsAt.toISOString(),
        limitDay: this._quota.limitDay,
      });
    }
    this._quota.exhaustedUntil = resetsAt.getTime();
    this._quota.exhaustedReason = reason || 'daily request quota exhausted';
    this._quota.remaining = 0;
    this._breaker.failures = 0; // an exhausted plan is not an upstream outage
    return this.quotaState();
  }

  /** Circuit breaker: are we allowed to call the API right now? */
  isAvailable() {
    if (!this.configured) return false;
    if (this._breaker.failures < this._maxFailures) return true;
    const elapsed = Date.now() - this._breaker.openedAt;
    if (elapsed >= this._breaker.cooldownMs) {
      this._breaker.failures = 0; // half-open: allow a probe
      return true;
    }
    return false;
  }

  breakerState() {
    const quota = this.quotaState();
    if (!this.configured) {
      // Not having a key is a REASON, not just a state: the operator asked
      // "why is the data source unavailable", and the answer (plus the fix)
      // must travel with every surface that renders the state.
      return {
        state: 'UNCONFIGURED',
        available: false,
        callable: false,
        reason: UNAVAILABLE_REASONS.NO_API_KEY,
        label: reasonInfo(UNAVAILABLE_REASONS.NO_API_KEY).label,
        hint: reasonInfo(UNAVAILABLE_REASONS.NO_API_KEY).hint,
        resetsAt: null,
        retryInMs: 0,
        quota: this.stats.quota,
        quotaState: quota,
      };
    }
    if (quota.exhausted) {
      return {
        state: 'QUOTA_EXHAUSTED',
        available: false,
        callable: false,
        reason: UNAVAILABLE_REASONS.QUOTA_EXCEEDED,
        label: reasonInfo(UNAVAILABLE_REASONS.QUOTA_EXCEEDED).label,
        hint: reasonInfo(UNAVAILABLE_REASONS.QUOTA_EXCEEDED).hint,
        resetsAt: quota.resetsAt,
        retryInMs: Math.max(0, new Date(quota.resetsAt).getTime() - Date.now()),
        quota: this.stats.quota,
        quotaState: quota,
        consecutiveFailures: this._breaker.failures,
        calls: this.stats.calls,
        failures: this.stats.failures,
        cacheHits: this.stats.cacheHits,
        lastCallAt: this.stats.lastCallAt,
        lastError: this.stats.lastError,
      };
    }
    return {
      state: this.isAvailable() ? (this._breaker.failures ? 'DEGRADED' : 'OK') : 'OPEN',
      available: this.isAvailable(),
      callable: this.isAvailable(),
      reason: this.isAvailable() ? null : UNAVAILABLE_REASONS.CIRCUIT_OPEN,
      label: this.isAvailable() ? null : reasonInfo(UNAVAILABLE_REASONS.CIRCUIT_OPEN).label,
      hint: this.isAvailable() ? null : reasonInfo(UNAVAILABLE_REASONS.CIRCUIT_OPEN).hint,
      resetsAt: null,
      consecutiveFailures: this._breaker.failures,
      retryInMs: this.isAvailable()
        ? 0
        : Math.max(0, this._breaker.cooldownMs - (Date.now() - this._breaker.openedAt)),
      quota: this.stats.quota,
      quotaState: quota,
      calls: this.stats.calls,
      failures: this.stats.failures,
      cacheHits: this.stats.cacheHits,
      lastCallAt: this.stats.lastCallAt,
      lastError: this.stats.lastError,
    };
  }

  _recordSuccess() {
    this._breaker.failures = 0;
  }

  _recordFailure(message) {
    this._breaker.failures += 1;
    this.stats.failures += 1;
    this.stats.lastError = { message, at: new Date().toISOString() };
    if (this._breaker.failures >= this._maxFailures) {
      this._breaker.openedAt = Date.now();
      log.error('circuit breaker opened', { failures: this._breaker.failures, message });
    }
  }

  /** Wait until we are inside the per-minute request budget. */
  async _acquireRateSlot() {
    const windowMs = 60 * 1000;
    for (;;) {
      const now = Date.now();
      this._callTimestamps = this._callTimestamps.filter((t) => now - t < windowMs);
      if (this._callTimestamps.length < this.ratePerMinute) {
        this._callTimestamps.push(now);
        return;
      }
      const waitMs = windowMs - (now - this._callTimestamps[0]) + 25;
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 5000)));
    }
  }

  _headers() {
    if (this.isRapidApi) {
      return {
        'x-rapidapi-key': this.key,
        // the header carries the bare host, never the /v3 path
        'x-rapidapi-host': String(this.host).replace(/\/.*$/, ''),
        accept: 'application/json',
      };
    }
    return { 'x-apisports-key': this.key, accept: 'application/json' };
  }

  _cacheKey(endpoint, params) {
    const qs = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${endpoint}?${qs}`;
  }

  _cacheGet(key) {
    const hit = this._cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this._cache.delete(key);
      return null;
    }
    return hit.value;
  }

  _cacheSet(key, value, ttlMs) {
    if (!ttlMs) return;
    if (this._cache.size > 2000) {
      // drop the oldest entries — bounded memory on shared hosting
      const keys = Array.from(this._cache.keys()).slice(0, 500);
      keys.forEach((k) => this._cache.delete(k));
    }
    this._cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clearCache() {
    this._cache.clear();
  }

  /**
   * Low level GET. Returns the decoded API-Football envelope
   * { get, parameters, errors, results, paging, response }.
   */
  async request(endpoint, params = {}, { ttl = 0, retries = this.maxRetries } = {}) {
    await this._refreshCredential();

    if (this.credentialError) {
      throw new ApiFootballUnavailable(this.credentialError.message, {
        reason: this.credentialError.code || UNAVAILABLE_REASONS.CREDENTIAL_UNREADABLE,
        host: this.host,
      });
    }
    if (!this.configured) {
      throw new ApiFootballUnavailable('API-Football key is not configured', {
        reason: UNAVAILABLE_REASONS.NO_API_KEY,
      });
    }

    // The daily budget guard. `/status` is documented as NOT counting against
    // the daily quota, so it stays callable — it is the only way an operator
    // can see the real usage while everything else is paused.
    const quota = this.quotaState();
    if (quota.exhausted && endpoint !== '/status') {
      throw new ApiFootballUnavailable('API-Football daily request quota exhausted', {
        reason: UNAVAILABLE_REASONS.QUOTA_EXCEEDED,
        endpoint,
        resetAt: quota.resetsAt,
        quota,
      });
    }

    if (!this.isAvailable()) {
      throw new ApiFootballUnavailable('DATA SOURCE TEMPORARILY UNAVAILABLE', {
        reason: UNAVAILABLE_REASONS.CIRCUIT_OPEN,
        ...this.breakerState(),
      });
    }

    const key = this._cacheKey(endpoint, params);
    const cached = this._cacheGet(key);
    if (cached) {
      this.stats.cacheHits += 1;
      return cached;
    }

    const url = new URL(`${this.baseUrl}${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }

    let attempt = 0;
    let rateLimitRetries = 0;
    let lastError = null;

    while (attempt <= retries) {
      attempt += 1;
      await this._acquireRateSlot();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      this.stats.calls += 1;
      this.stats.lastCallAt = new Date().toISOString();

      try {
        const res = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: this._headers(),
          signal: controller.signal,
        });

        const text = await res.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch (_) {
          body = null;
        }

        // Every API-Football answer carries the remaining daily budget.
        this._learnQuotaFromHeaders(res);

        // 429: either the per-minute rate limit or a spent daily quota. Retrying
        // a rate limit more than once (and retrying at all once the day's
        // budget is gone) is what gets an API key firewalled — so the daily
        // case stops immediately and the per-minute case backs off once.
        if (res.status === 429) {
          const state = this.quotaState();
          if (state.exhausted) {
            this._recordFailure('daily request quota exhausted');
            this._notifyRequest({ ok: false, endpoint, httpStatus: 429, errorCode: UNAVAILABLE_REASONS.QUOTA_EXCEEDED });
            throw new ApiFootballUnavailable('API-Football daily request quota exhausted', {
              reason: UNAVAILABLE_REASONS.QUOTA_EXCEEDED,
              status: 429,
              endpoint,
              resetAt: state.resetsAt,
              quota: state,
            });
          }
          lastError = new ApiFootballUnavailable('API-Football rejected the request: rate limit reached', {
            reason: UNAVAILABLE_REASONS.RATE_LIMITED,
            status: 429,
            endpoint,
            params,
            quota: state,
          });
          this._recordFailure(lastError.message);
          this._notifyRequest({ ok: false, endpoint, httpStatus: 429, errorCode: UNAVAILABLE_REASONS.RATE_LIMITED });
          if (rateLimitRetries >= 1) throw lastError;
          rateLimitRetries += 1;
          await this._backoff(attempt, this._retryAfterMs(res));
          continue;
        }

        // 499/408/425 are transient timeouts on the provider side, not a rejected request
        if (res.status >= 500 || res.status === 499 || res.status === 408 || res.status === 425) {
          lastError = new ApiFootballUnavailable('API-Football is temporarily unavailable', {
            reason: UNAVAILABLE_REASONS.PROVIDER_UNAVAILABLE,
            status: res.status,
            endpoint,
          });
          this._recordFailure(lastError.message);
          this._notifyRequest({ ok: false, endpoint, httpStatus: res.status, errorCode: 'UPSTREAM_STATUS' });
          await this._backoff(attempt);
          continue;
        }

        if (!res.ok) {
          const apiErrors = (body && body.errors) || null;
          this._recordFailure(`HTTP ${res.status} on ${endpoint}`);
          this._notifyRequest({ ok: false, endpoint, httpStatus: res.status, errorCode: 'HTTP_ERROR' });
          const providerMessage = summarizeProviderError(apiErrors);
          const authRejected = res.status === 401 || res.status === 403;
          const hint = authRejected
            ? reasonInfo(UNAVAILABLE_REASONS.AUTH_REJECTED).hint
            : null;
          throw new ApiFootballUnavailable(
            `API-Football request rejected (HTTP ${res.status} on ${endpoint}${providerMessage ? `: ${providerMessage}` : ''})`,
            {
              status: res.status,
              endpoint,
              params,
              errors: apiErrors,
              reason: authRejected ? UNAVAILABLE_REASONS.AUTH_REJECTED : UNAVAILABLE_REASONS.REQUEST_REJECTED,
              hint,
            }
          );
        }

        if (!body) {
          this._recordFailure('empty body');
          lastError = new ApiFootballUnavailable('API-Football returned an empty response', {
            reason: UNAVAILABLE_REASONS.EMPTY_RESPONSE,
            status: res.status,
            endpoint,
          });
          this._notifyRequest({ ok: false, endpoint, httpStatus: res.status, errorCode: 'EMPTY_BODY' });
          await this._backoff(attempt);
          continue;
        }

        // API-Football reports soft errors with HTTP 200 + `errors`. A spent
        // daily quota or a per-minute rate limit is a hard stop (the caller
        // must report it, not treat the empty payload as "no data today");
        // anything else stays a warning, exactly as before.
        if (body.errors && (Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length)) {
          const errText = Array.isArray(body.errors) ? body.errors.join('; ') : JSON.stringify(body.errors);
          const quotaError = Object.prototype.hasOwnProperty.call(body.errors, 'requests') || /requests? limits?|quota|limit for the day|reached the limit/i.test(errText);
          const rateError = Object.prototype.hasOwnProperty.call(body.errors, 'rateLimit') || /rate limit|too many requests|per minute/i.test(errText);
          if (quotaError) {
            const state = this._markQuotaExhausted(`the provider answered: ${errText}`);
            this._recordFailure(errText);
            this._notifyRequest({ ok: false, endpoint, httpStatus: res.status, errorCode: UNAVAILABLE_REASONS.QUOTA_EXCEEDED });
            throw new ApiFootballUnavailable('API-Football daily quota reached', {
              reason: UNAVAILABLE_REASONS.QUOTA_EXCEEDED,
              endpoint,
              errors: body.errors,
              resetAt: state.resetsAt,
              quota: state,
            });
          }
          if (rateError) {
            this._recordFailure(errText);
            this._notifyRequest({ ok: false, endpoint, httpStatus: res.status, errorCode: UNAVAILABLE_REASONS.RATE_LIMITED });
            throw new ApiFootballUnavailable('API-Football rate limit reached', {
              reason: UNAVAILABLE_REASONS.RATE_LIMITED,
              endpoint,
              errors: body.errors,
              quota: this.quotaState(),
            });
          }
          log.warn('API-Football soft error', { endpoint, errText });
          body.softErrors = body.errors;
          this._notifyRequest({ ok: false, endpoint, httpStatus: res.status, errorCode: 'SOFT_ERROR' });
        } else {
          this._notifyRequest({ ok: true, endpoint, httpStatus: res.status });
        }

        this._recordSuccess();
        if (body.response && body.response[0] && body.response[0].requests) {
          this._learnQuotaFromStatus(body.response[0]);
        }
        const normalised = {
          get: body.get || endpoint,
          parameters: body.parameters || params,
          errors: body.errors || null,
          results: typeof body.results === 'number' ? body.results : (body.response || []).length,
          paging: body.paging || { current: 1, total: 1 },
          response: Array.isArray(body.response) ? body.response : [],
        };
        this._cacheSet(key, normalised, ttl);
        return normalised;
      } catch (err) {
        if (err instanceof ApiFootballUnavailable) throw err;
        const timedOut = err && (err.name === 'AbortError' || /aborted|timeout/i.test(err.message || ''));
        lastError = new ApiFootballUnavailable('API-Football network error', {
          endpoint,
          message: err && err.message ? err.message : String(err),
          reason: timedOut ? UNAVAILABLE_REASONS.TIMEOUT : UNAVAILABLE_REASONS.NETWORK_ERROR,
        });
        this._recordFailure(lastError.details?.message || 'network error');
        this._notifyRequest({
          ok: false,
          endpoint,
          httpStatus: null,
          errorCode: timedOut ? UNAVAILABLE_REASONS.TIMEOUT : UNAVAILABLE_REASONS.NETWORK_ERROR,
        });
        if (attempt > retries) throw lastError;
        await this._backoff(attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new ApiFootballUnavailable('API-Football request failed');
  }

  /** How long the provider asked us to wait (Retry-After), bounded. */
  _retryAfterMs(res) {
    const headers = res && res.headers;
    if (!headers || typeof headers.get !== 'function') return null;
    const raw = headers.get('retry-after');
    if (raw === null || raw === undefined || raw === '') return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15000);
    const at = new Date(raw);
    if (!Number.isNaN(at.getTime())) return Math.min(Math.max(0, at.getTime() - Date.now()), 15000);
    return null;
  }

  /**
   * Notify the optional request listener (the credential service uses it to
   * persist "last API request time"). Listener failures never break a request.
   */
  _notifyRequest(info) {
    if (typeof this.onRequest !== 'function') return;
    try {
      const result = this.onRequest(info);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_err) {
      /* never break a request because diagnostics could not be recorded */
    }
  }

  /**
   * REAL credential probe used by the admin "Test Connection" action.
   *
   * It performs one genuine server-side GET of the provider's `/status`
   * endpoint (the official plan/quota endpoint) and reports exactly what came
   * back. It never fabricates a quota, never retries a rejected credential and
   * never touches fixtures, odds, tickets or the prediction engine.
   *
   * @returns {Promise<{ok: boolean, state: string, label: string, endpoint: string,
   *   httpStatus: number|null, latencyMs: number, message: string,
   *   quota: {current: number, limitDay: number}|null, plan: object|null,
   *   errors: string|null}>}
   */
  async probeCredentials({ endpoint = '/status' } = {}) {
    const startedAt = Date.now();
    const base = {
      ok: false,
      state: CONNECTION_STATES.NOT_TESTED,
      label: CONNECTION_LABELS.NOT_TESTED,
      reason: null,
      hint: null,
      endpoint,
      httpStatus: null,
      latencyMs: 0,
      message: '',
      quota: null,
      plan: null,
      errors: null,
    };

    if (!this.configured) {
      return {
        ...base,
        state: CONNECTION_STATES.CONFIG_INCOMPLETE,
        label: CONNECTION_LABELS.CONFIG_INCOMPLETE,
        message: 'No API key is available for this test.',
      };
    }

    try {
      // No cache, no retries: a credential test must be a real, single request.
      const data = await this.request(endpoint, {}, { ttl: 0, retries: 0 });
      const latencyMs = Date.now() - startedAt;
      const info = (data.response && data.response[0]) || null;

      if (data.errors && (Array.isArray(data.errors) ? data.errors.length : Object.keys(data.errors).length)) {
        const state = classifyProviderError({ httpStatus: null, errors: data.errors });
        return {
          ...base,
          state,
          label: CONNECTION_LABELS[state] || state,
          latencyMs,
          message: `The provider rejected this request: ${summarizeProviderError(data.errors) || state}`,
          errors: summarizeProviderError(data.errors),
        };
      }

      if (!info) {
        return {
          ...base,
          state: CONNECTION_STATES.PROVIDER_UNAVAILABLE,
          label: CONNECTION_LABELS.PROVIDER_UNAVAILABLE,
          latencyMs,
          message: 'The provider answered without any status payload.',
        };
      }

      const quota =
        info.requests && Number.isFinite(Number(info.requests.current))
          ? { current: Number(info.requests.current), limitDay: Number(info.requests.limit_day) || null }
          : null;

      return {
        ...base,
        ok: true,
        state: CONNECTION_STATES.CONNECTED,
        label: CONNECTION_LABELS.CONNECTED,
        latencyMs,
        message: `The provider accepted the credential${
          quota ? ` (${quota.current}${quota.limitDay ? `/${quota.limitDay}` : ''} requests used today)` : ''
        }.`,
        quota,
        plan: info.subscription
          ? {
              name: info.subscription.plan || info.subscription.name || null,
              active: info.subscription.active ?? null,
              end: info.subscription.end || null,
            }
          : null,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const details = (err && err.details) || {};
      const httpStatus = details.status || null;

      let state;
      const reason = details.reason || null;
      if (reason === UNAVAILABLE_REASONS.TIMEOUT || (err && err.name === 'AbortError')) state = CONNECTION_STATES.TIMEOUT;
      else if (reason === UNAVAILABLE_REASONS.QUOTA_EXCEEDED) state = CONNECTION_STATES.QUOTA_EXCEEDED;
      else if (reason === UNAVAILABLE_REASONS.RATE_LIMITED) state = CONNECTION_STATES.RATE_LIMITED;
      else if (reason === UNAVAILABLE_REASONS.AUTH_REJECTED) state = CONNECTION_STATES.INVALID_KEY;
      else if (reason === UNAVAILABLE_REASONS.PROVIDER_UNAVAILABLE) state = CONNECTION_STATES.PROVIDER_UNAVAILABLE;
      else if (reason === UNAVAILABLE_REASONS.NETWORK_ERROR || reason === UNAVAILABLE_REASONS.EMPTY_RESPONSE) state = CONNECTION_STATES.NETWORK_ERROR;
      else if (reason === UNAVAILABLE_REASONS.CIRCUIT_OPEN) state = CONNECTION_STATES.PROVIDER_UNAVAILABLE;
      else if (reason === UNAVAILABLE_REASONS.NO_API_KEY) state = CONNECTION_STATES.CONFIG_INCOMPLETE;
      else if (details.errors || details.status) {
        state = classifyProviderError({ httpStatus, errors: details.errors || null, message: err.message });
      } else state = CONNECTION_STATES.NETWORK_ERROR;

      const described = describeUnavailable(err);
      return {
        ...base,
        state,
        label: CONNECTION_LABELS[state] || state,
        reason: described.reason,
        hint: described.hint,
        httpStatus,
        latencyMs,
        message: err.message || 'The credential test failed',
        errors: summarizeProviderError(details.errors),
      };
    }
  }

  async _backoff(attempt, waitMs = null) {
    const ms = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : Math.min(15000, 500 * 2 ** Math.max(0, attempt - 1));
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ------------------------------------------------------------------ */
  /* endpoints                                                           */
  /* ------------------------------------------------------------------ */

  /** GET /status — plan, subscription and daily request usage (never billed). */
  async getStatus() {
    const data = await this.request('/status', {}, { ttl: this._cacheTtl.status });
    const info = (data.response && data.response[0]) || null;
    if (info && info.requests) this._learnQuotaFromStatus(info);
    return info;
  }

  /** GET /fixtures?date=YYYY-MM-DD */
  async getFixturesByDate(date, extra = {}) {
    return this.request('/fixtures', { date, timezone: 'UTC', ...extra }, { ttl: this._cacheTtl.fixtures });
  }

  /** GET /fixtures?id=1-2-3 (batched) */
  async getFixturesByIds(ids) {
    if (!ids || !ids.length) return { response: [], results: 0 };
    return this.request('/fixtures', { id: ids.join('-'), timezone: 'UTC' }, { ttl: this._cacheTtl.fixtures });
  }

  /** GET /fixtures?team=X&last=N&status=FT — used for form samples. */
  async getTeamLastFixtures(teamId, last = 10) {
    return this.request('/fixtures', { team: teamId, last, status: 'FT', timezone: 'UTC' }, { ttl: this._cacheTtl.fixtures });
  }

  /** GET /fixtures/headtohead?h2h=A-B&last=N */
  async getHeadToHead(teamA, teamB, last = 10) {
    return this.request('/fixtures/headtohead', { h2h: `${teamA}-${teamB}`, last, timezone: 'UTC' }, {
      ttl: this._cacheTtl.h2h,
    });
  }

  /** GET /odds?date=YYYY-MM-DD&page=N — bulk pre-match odds. */
  async getOddsByDate(date, page = 1) {
    return this.request('/odds', { date, page }, { ttl: 0 }); // odds are never served from cache when refreshing
  }

  /** GET /odds?fixture=ID — exact price for one fixture (used at generation time). */
  async getOddsByFixture(fixtureId) {
    return this.request('/odds', { fixture: fixtureId }, { ttl: 0 });
  }

  /** GET /odds?fixture=1-2-3 — batched variant where the plan supports it. */
  async getOddsByFixtures(fixtureIds) {
    if (!fixtureIds || !fixtureIds.length) return { response: [], results: 0 };
    return this.request('/odds', { fixture: fixtureIds.join('-') }, { ttl: 0 });
  }

  /** GET /injuries?fixture=ID — only when the plan provides it. */
  async getInjuriesByFixture(fixtureId) {
    return this.request('/injuries', { fixture: fixtureId }, { ttl: this._cacheTtl.injuries });
  }

  /** GET /standings?league=X&season=Y */
  async getStandings(leagueId, season) {
    return this.request('/standings', { league: leagueId, season }, { ttl: 6 * 60 * 60 * 1000 });
  }
}

/** Shared singleton used by the running server. */
const apiFootball = new ApiFootballClient();

/**
 * Every cron/CLI entry point goes through the same client, so the
 * database-managed credential (when one is active) is picked up automatically
 * — including by `scripts/cron-sync-*.js`, which never had a database
 * credential before this feature existed.
 *
 * `_refreshCredential()` lazily requires services/apiCredentialService.js
 * (deferred on purpose: that module imports this one). Registering an explicit
 * handler with `setCredentialRefresh()` is optional and only used by tests.
 */

module.exports = {
  ApiFootballClient,
  ApiFootballUnavailable,
  apiFootball,
  DEFAULT_TTL,
  CONNECTION_STATES,
  CONNECTION_LABELS,
  UNAVAILABLE_REASONS,
  REASON_INFO,
  reasonInfo,
  describeUnavailable,
  unavailableMessage,
  nextDailyReset,
  classifyProviderError,
  summarizeProviderError,
  CREDENTIAL_REFRESH_MS,
};
