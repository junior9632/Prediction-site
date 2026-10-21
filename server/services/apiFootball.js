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
const { createHash } = require('node:crypto');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { normalizeHost, baseUrlForHost, normalizeApiKey, redactSecret, unquote } = require('../utils/providerConfig');
const { createProviderDispatcher, networkFailure } = require('../utils/providerTransport');
const { discoverServerAddresses, formatAddresses } = require('../utils/egressIp');
const providerDispatcher = createProviderDispatcher(config.apiFootball.ipFamily);

/**
 * How long the client stops calling after the provider has refused this
 * server's IP address. An allowlist rejection is neither an outage nor a
 * transient error, so retrying cannot help — but the operator may add the
 * address at any second, and every rejected call still reaches the provider.
 * "Test connection" (`bypassCircuit`) is never held back by this.
 */
const IP_BLOCK_COOLDOWN_MS = 5 * 60 * 1000;

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
  REQUEST_REJECTED: 'REQUEST_REJECTED',
  IP_NOT_ALLOWED: 'IP_NOT_ALLOWED',
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
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
  REQUEST_REJECTED: 'Provider rejected the request',
  IP_NOT_ALLOWED: 'This server’s IP is not on the provider allowlist',
  SUBSCRIPTION_INACTIVE: 'API subscription required or inactive',
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
  CONFIG_INVALID: 'CONFIG_INVALID',
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
  CREDENTIAL_UNREADABLE: 'CREDENTIAL_UNREADABLE',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  QUOTA_RESERVED: 'QUOTA_RESERVED',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH_REJECTED: 'AUTH_REJECTED',
  REQUEST_REJECTED: 'REQUEST_REJECTED',
  IP_NOT_ALLOWED: 'IP_NOT_ALLOWED',
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
  CONFIG_INVALID: {
    label: 'the API configuration is invalid',
    hint: 'Use an approved API-Football host and the key issued for that host. Check API Management or API_FOOTBALL_HOST / API_FOOTBALL_KEY, then run npm run api:check.',
  },
  SUBSCRIPTION_INACTIVE: {
    label: 'the provider subscription is missing or inactive',
    hint: 'For RapidAPI, subscribe to API-Football with the same account/app that issued this key, then retry Test connection. If your key came from the API-Sports dashboard, select v3.football.api-sports.io instead; the keys and subscriptions are separate. Renew an expired plan in the issuing provider dashboard.',
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
  /**
   * API-Football answers HTTP 200 with `errors.Ip` when the account's IP/domain
   * allowlist does not contain the caller. Nothing about the key, the plan or
   * the season is wrong, and no retry can fix it: only adding the address (or
   * emptying the list) can. That is why this is its own reason with the exact
   * dashboard screen — the generic "parameters outside the plan's range" hint
   * sent operators looking in the wrong place.
   */
  IP_NOT_ALLOWED: {
    label: 'this server’s IP address is not allowed by the provider',
    hint:
      'The API key is valid, but the account has an IP/domain allowlist and this server is not on it. Open https://dashboard.api-football.com/profile?access, ' +
      'add the address this server calls from and click ADD — changes apply immediately; an empty list means no restriction at all. ' +
      'Add the IPv6 address as well when the host uses both families, then run Test connection in Admin → API Management (or `npm run api:check`).',
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
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
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
 * The fix for an allowlist rejection, naming the address this server uses when
 * it could be discovered. Without an address the operator still gets the exact
 * dashboard screen, so the message is never a dead end.
 *
 * @param {{ips: string[], source: string}|null} addresses
 */
function ipNotAllowedHint(addresses) {
  const base = reasonInfo(UNAVAILABLE_REASONS.IP_NOT_ALLOWED).hint;
  const list = formatAddresses(addresses);
  if (!list) return base;
  const how = addresses && addresses.source ? ` (${addresses.source})` : '';
  return `${base} This server reports ${list}${how} — add ${addresses.ips.length > 1 ? 'those addresses' : 'that address'} to the list.`;
}

/**
 * Turn any `ApiFootballUnavailable` into the structured report the dashboard,
 * the sync log and the CLI diagnostics all render. Pure — no side effects.
 *
 * @returns {{reason: string|null, label: string, hint: string|null, detail: string|null,
 *   httpStatus: number|null, resetAt: string|null, quota: object|null,
 *   egressIp: {ips: string[], source: string}|null}}
 */
function describeUnavailable(err) {
  const details = (err && err.details) || {};
  const reason = details.reason || null;
  const info = reasonInfo(reason);
  return {
    reason,
    label: details.networkCode ? `${info.label} (${details.networkCode})` : info.label,
    hint: details.hint || info.hint || null,
    networkCode: details.networkCode || null,
    detail: err && err.message ? String(err.message) : null,
    httpStatus: details.status != null && Number.isFinite(Number(details.status)) ? Number(details.status) : null,
    resetAt: details.resetAt || null,
    quota: details.quota || null,
    // Only present for an allowlist rejection: the address(es) the operator
    // must add. Null when nothing could be learned — never a guess.
    egressIp: details.egressIp || null,
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

  // Per-minute wording must win over generic "request limit" wording.
  if (/per minute|rate.?limit|too many requests/.test(text) || (errors && errors.rateLimit)) return CONNECTION_STATES.RATE_LIMITED;
  if ((errors && errors.requests) || /daily|quota|limit for the day|requests? limit|reached the limit/.test(text)) return CONNECTION_STATES.QUOTA_EXCEEDED;
  if (httpStatus && (httpStatus >= 500 || httpStatus === 499 || httpStatus === 408 || httpStatus === 425)) return CONNECTION_STATES.PROVIDER_UNAVAILABLE;
  // The account's IP/domain allowlist refused the CALLER (HTTP 200 + errors.Ip).
  // Decided BEFORE the generic auth/rejection fallbacks: the key was accepted,
  // and "not allowed" must not be read as "not authorized". The refusal word is
  // required, so an unrelated "IP address could not be resolved" message is not
  // mistaken for an allowlist decision.
  if (/\bip\b[^.]{0,80}\b(?:not allowed|blocked|denied|not permitted|not authorised|not authorized)\b|\bnot allowed to call\b|\ballowed ips?\b/.test(text)) return CONNECTION_STATES.IP_NOT_ALLOWED;
  // RapidAPI also uses HTTP 403 for a missing API subscription.
  // Its explicit message must win over the generic 401/403 auth fallback.
  if (/\bnot subscribed\b|\bunsubscribed\b|\bno active subscription\b|\bsubscription\b[^.{}]*\b(expired|inactive|not active|required)\b|\b(expired|inactive) subscription\b/.test(text)) return CONNECTION_STATES.SUBSCRIPTION_INACTIVE;
  if (httpStatus === 401 || httpStatus === 403 || /missing application key|no api key|invalid api key|invalid token|token.*invalid|not authorized|unauthorized|account suspended|invalid.*key/.test(text)) return CONNECTION_STATES.INVALID_KEY;
  if (httpStatus === 429) return CONNECTION_STATES.RATE_LIMITED;
  return CONNECTION_STATES.REQUEST_REJECTED;
}

/** JSON-safe summary of a provider error — never a credential or a header. */
function summarizeProviderError(errors, secret = null) {
  if (!errors) return null;
  if (Array.isArray(errors)) return redactSecret(errors.join('; '), secret).slice(0, 300) || null;
  if (typeof errors === 'object') {
    try {
      return redactSecret(JSON.stringify(errors), secret).slice(0, 300);
    } catch (_) {
      return null;
    }
  }
  return redactSecret(String(errors), secret).slice(0, 300) || null;
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
    this.host = normalizeHost(options.host || config.apiFootball.host);
    this.baseUrl = options.baseUrl || baseUrlForHost(this.host);
    this.key = unquote(options.key ?? config.apiFootball.key);
    this.isRapidApi = /rapidapi\.com/i.test(this.host);
    const timeout = Number(options.timeoutMs ?? config.apiFootball.timeoutMs);
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 15000;
    this.maxRetries = options.maxRetries ?? config.apiFootball.maxRetries;
    const rate = Number(options.ratePerMinute ?? config.apiFootball.ratePerMinute);
    this.ratePerMinute = Number.isFinite(rate) && rate > 0 ? Math.min(600, Math.floor(rate) || 1) : 60;
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.dispatcher = options.dispatcher || providerDispatcher;
    this._rateLimitedUntil = 0;

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

    // Used ONLY to name this server's address in an IP-allowlist rejection
    // (see utils/egressIp.js). `false` disables even that diagnostic request.
    this.serverAddressLookup =
      options.serverAddressLookup === false ? null : options.serverAddressLookup || discoverServerAddresses;
    this._ipBlockedUntil = 0;
    this._ipBlock = null;

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
    this.stats = { calls: 0, failures: 0, cacheHits: 0, lastCallAt: null, lastError: null, lastOutcome: null, lastSuccessAt: null, quota: null };
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
    const nextHost = normalizeHost(credential.host || config.apiFootball.host);
    const nextBaseUrl = credential.baseUrl || baseUrlForHost(nextHost);
    const loginChanged =
      nextKey !== this.key || nextHost !== this.host || nextBaseUrl !== this.baseUrl;

    this.key = nextKey;
    this.host = nextHost;
    this.baseUrl = nextBaseUrl;
    this.isRapidApi = /rapidapi\.com/i.test(this.host);
    this.credentialSource = credential.source || (nextKey ? 'environment' : 'none');
    this.providerId = credential.providerId || this.providerId;
    this.credentialError = credential.error || null;
    const configuredRate = Number(credential.ratePerMinute);
    if (Number.isFinite(configuredRate) && configuredRate > 0) {
      this.ratePerMinute = Math.max(1, Math.min(600, Math.floor(configuredRate), loginChanged ? Infinity : this._quota.perMinuteLimit || Infinity));
    }

    if (loginChanged) {
      // a different key/host must never be served a cached payload, and the
      // daily budget we learned belongs to the previous credential/plan
      this._cache.clear();
      this._breaker = { ...this._breaker, failures: 0, openedAt: 0 };
      this._quota = { ...this._quota, current: null, remaining: null, limitDay: null, source: null, checkedAt: null, exhaustedUntil: 0, exhaustedReason: null, perMinuteLimit: null };
      this.stats.quota = null;
      this.stats.lastOutcome = null;
      this.stats.lastError = null;
      this.stats.lastSuccessAt = null;
      this.stats.lastCallAt = null;
      this._rateLimitedUntil = 0;
      // a different credential may have a different allowlist
      this._ipBlockedUntil = 0;
      this._ipBlock = null;
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
    // A long-lived Passenger worker must not retain yesterday's zero forever.
    const now = Date.now();
    const checked = this._quota.checkedAt && new Date(this._quota.checkedAt);
    if ((checked && Number.isFinite(checked.getTime()) && nextDailyReset(checked).getTime() <= now) ||
        (this._quota.exhaustedUntil && this._quota.exhaustedUntil <= now)) {
      Object.assign(this._quota, { current: null, remaining: null, checkedAt: null, source: null, exhaustedUntil: 0, exhaustedReason: null });
      this.stats.quota = null;
    }
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
      perMinuteLimit: this._quota.perMinuteLimit,
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
    if (remaining !== null) {
      this._quota.remaining = remaining;
      if (remaining > 0) { this._quota.exhaustedUntil = 0; this._quota.exhaustedReason = null; }
    }
    if (this._quota.limitDay !== null && remaining !== null) this._quota.current = Math.max(0, this._quota.limitDay - remaining);
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
    if (limitDay !== null && current !== null) {
      this._quota.remaining = Math.max(0, limitDay - current);
      if (this._quota.remaining > 0) { this._quota.exhaustedUntil = 0; this._quota.exhaustedReason = null; }
    }
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

  /* ------------------------------------------------------------------ */
  /* IP allowlist rejections                                             */
  /* ------------------------------------------------------------------ */

  /**
   * This server's address, for the operator who has to add it to the
   * provider's allowlist. Never throws; `null` when it cannot be learned.
   * The lookup is cached by utils/egressIp.js, so repeated sync jobs in the
   * same process cost nothing.
   */
  async _serverAddresses() {
    if (!this.serverAddressLookup) return null;
    try {
      return await this.serverAddressLookup({ dispatcher: this.dispatcher });
    } catch (err) {
      log.warn('unable to determine this server’s public address', { message: err && err.message });
      return null;
    }
  }

  /**
   * Stop calling the provider for a few minutes after it refused this
   * server's address. The reason is RETAINED (unlike the circuit breaker,
   * which reports its own generic state): every surface keeps saying
   * IP_NOT_ALLOWED with the address and the fix, and "Test connection" can
   * verify the repair immediately.
   */
  _blockIp(addresses) {
    this._ipBlockedUntil = Date.now() + IP_BLOCK_COOLDOWN_MS;
    this._ipBlock = addresses || null;
    log.warn('the provider refuses this server’s IP address — calls paused', {
      addresses: addresses ? addresses.ips.join(', ') : null,
      retryAt: new Date(this._ipBlockedUntil).toISOString(),
    });
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
    const observation = { configured: this.configured, verified: Boolean(this.stats.lastOutcome && this.stats.lastOutcome.ok), lastCheckedAt: this.stats.lastOutcome ? this.stats.lastOutcome.at : null };
    if (!this.configured || this.credentialError) {
      // Not having a key is a REASON, not just a state: the operator asked
      // "why is the data source unavailable", and the answer (plus the fix)
      // must travel with every surface that renders the state.
      return {
        ...observation,
        state: 'UNCONFIGURED',
        available: false,
        callable: false,
        reason: this.credentialError ? (this.credentialError.code || 'CONFIG_INVALID') : UNAVAILABLE_REASONS.NO_API_KEY,
        label: this.credentialError ? this.credentialError.message : reasonInfo(UNAVAILABLE_REASONS.NO_API_KEY).label,
        hint: this.credentialError ? reasonInfo(this.credentialError.code).hint : reasonInfo(UNAVAILABLE_REASONS.NO_API_KEY).hint,
        resetsAt: null,
        retryInMs: 0,
        quota: this.stats.quota,
        quotaState: quota,
      };
    }
    if (quota.exhausted) {
      return {
        ...observation,
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
    // The provider refused this server's address. The key, the plan and the
    // network are fine, so the circuit breaker is untouched — but no call can
    // succeed until the address is allowlisted, which `available:false` says.
    if (Date.now() < this._ipBlockedUntil) {
      return {
        ...observation,
        state: 'IP_BLOCKED',
        available: false,
        callable: false,
        reason: UNAVAILABLE_REASONS.IP_NOT_ALLOWED,
        label: reasonInfo(UNAVAILABLE_REASONS.IP_NOT_ALLOWED).label,
        hint: ipNotAllowedHint(this._ipBlock),
        egressIp: this._ipBlock,
        resetsAt: new Date(this._ipBlockedUntil).toISOString(),
        retryInMs: Math.max(0, this._ipBlockedUntil - Date.now()),
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
      ...observation,
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
    this.stats.lastSuccessAt = new Date().toISOString();
    this.stats.lastOutcome = { ok: true, at: this.stats.lastSuccessAt };
  }

  _recordFailure(message, { tripBreaker = true, ...details } = {}) {
    if (tripBreaker) this._breaker.failures += 1;
    this.stats.failures += 1;
    this.stats.lastError = { message, ...details, at: new Date().toISOString() };
    this.stats.lastOutcome = { ...this.stats.lastError, ok: false };
    if (tripBreaker && this._breaker.failures >= this._maxFailures) {
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

  _headers(credential = this) {
    if (credential.isRapidApi) {
      return {
        'x-rapidapi-key': credential.key,
        // the header carries the bare host, never the /v3 path
        'x-rapidapi-host': String(credential.host).replace(/\/.*$/, ''),
        accept: 'application/json',
      };
    }
    return { 'x-apisports-key': credential.key, accept: 'application/json' };
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
  async request(endpoint, params = {}, { ttl = 0, retries = this.maxRetries, bypassCircuit = false } = {}) {
    await this._refreshCredential();
    if (this.credentialError) {
      throw new ApiFootballUnavailable(this.credentialError.message, { reason: this.credentialError.code || 'CREDENTIAL_UNREADABLE' });
    }
    if (!this.configured) throw new ApiFootballUnavailable('API-Football key is not configured', { reason: 'NO_API_KEY' });
    let apiKey;
    let url;
    try {
      apiKey = normalizeApiKey(this.key);
      if (!this.baseUrl || !/^\/[a-z0-9/-]+$/i.test(endpoint)) throw new Error('Invalid API URL');
      url = new URL(`${this.baseUrl}${endpoint}`);
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    } catch (_err) {
      throw new ApiFootballUnavailable('API-Football host or key is invalid. Check API Management.', { reason: 'CONFIG_INVALID' });
    }
    if (!bypassCircuit && !this.isAvailable()) {
      throw new ApiFootballUnavailable('DATA SOURCE TEMPORARILY UNAVAILABLE', { ...this.breakerState(), reason: 'CIRCUIT_OPEN' });
    }
    if (Date.now() < this._rateLimitedUntil) {
      throw new ApiFootballUnavailable('API-Football rate limit cooldown is active', { reason: 'RATE_LIMITED', resetAt: new Date(this._rateLimitedUntil).toISOString() });
    }
    // The provider told us this address is not allowed. Keep saying exactly
    // that (and how to fix it) instead of spending another request on a call
    // that cannot succeed yet. A real credential test always gets through.
    if (!bypassCircuit && Date.now() < this._ipBlockedUntil) {
      const retryAt = new Date(this._ipBlockedUntil).toISOString();
      throw new ApiFootballUnavailable(
        `API-Football still refuses this server’s IP address (next attempt after ${retryAt}; add the address in the provider dashboard)`,
        { reason: 'IP_NOT_ALLOWED', endpoint, hint: ipNotAllowedHint(this._ipBlock), egressIp: this._ipBlock, retryAt }
      );
    }
    const cacheKey = this._cacheKey(endpoint, params);
    const cached = ttl > 0 ? this._cacheGet(cacheKey) : null;
    if (cached) { this.stats.cacheHits += 1; return cached; }
    // Do not send a newly activated key to the old host while a request waits.
    const credential = { key: apiKey, host: this.host, isRapidApi: this.isRapidApi };
    const isCurrent = () => this.key === apiKey && this.host === credential.host;
    const recordFailure = (err, tripBreaker = true) => {
      if (!isCurrent()) return;
      const info = describeUnavailable(err);
      this._recordFailure(err.message, { ...info, tripBreaker });
      this._notifyRequest({ ok: false, endpoint, httpStatus: info.httpStatus, errorCode: info.reason, message: info.detail });
    };
    const maxRetries = Math.max(0, Math.min(5, Number(retries) || 0));
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const quota = this.quotaState();
      if (isCurrent() && quota.exhausted && endpoint !== '/status') {
        throw new ApiFootballUnavailable('API-Football daily request quota exhausted', { reason: 'QUOTA_EXCEEDED', endpoint, resetAt: quota.resetsAt, quota });
      }
      await this._acquireRateSlot();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      this.stats.calls += 1;
      this.stats.lastCallAt = new Date().toISOString();
      let retryWait = null;
      try {
        const res = await this.fetchImpl(url.toString(), {
          method: 'GET', headers: this._headers(credential), signal: controller.signal,
          dispatcher: this.dispatcher,
          // Never forward a secret-bearing header to an unapproved redirect.
          redirect: 'manual',
        });
        if (isCurrent()) this._learnQuotaFromHeaders(res);
        const text = await res.text();
        let body;
        try { body = text ? JSON.parse(redactSecret(text, apiKey)) : null; } catch (_err) { body = null; }
        if (res.status === 204 && endpoint !== '/status') body = { errors: [], response: [], results: 0 };
        // API-Sports documents soft errors inside `errors`, but its IP-allowlist
        // refusal has also been seen at the top level as `{"Ip": "..."}` with
        // HTTP 200. Both shapes are a provider rejection — never zero data.
        const errors =
          body && body.errors
            ? body.errors
            : body && typeof body.Ip === 'string'
              ? { Ip: body.Ip }
              : body && typeof body.ip === 'string'
                ? { Ip: body.ip }
                : null;
        const hasErrors = errors && (typeof errors !== 'object' || Object.keys(errors).length > 0);
        if (!res.ok || hasErrors) {
          const state = classifyProviderError({ httpStatus: res.status, errors, message: body && body.message || '' });
          const reason = state === 'INVALID_KEY' ? 'AUTH_REJECTED' : state;
          const summary = summarizeProviderError(errors || (body && body.message), apiKey);
          let q = this.quotaState();
          // An explicit zero daily budget is stronger evidence than a generic 429.
          const actualReason = res.status === 429 && q.exhausted ? 'QUOTA_EXCEEDED' : reason;
          if (actualReason === 'QUOTA_EXCEEDED' && isCurrent()) q = this._markQuotaExhausted(summary || 'daily request quota exhausted');
          const transient = actualReason === 'PROVIDER_UNAVAILABLE';
          const rate = actualReason === 'RATE_LIMITED';
          // HTTP 200 + `errors.Ip` is not an outage, a bad key, a plan problem
          // or a bad parameter: the account's allowlist refused this server.
          // Report the address to allowlist and stop repeating the call.
          let addresses = null;
          let hint = reasonInfo(actualReason).hint;
          let ipMessage = '';
          if (actualReason === 'IP_NOT_ALLOWED') {
            addresses = await this._serverAddresses();
            hint = ipNotAllowedHint(addresses);
            const list = formatAddresses(addresses);
            ipMessage = `API-Football refuses this server’s IP address (HTTP ${res.status} on ${endpoint}${summary ? `: ${summary}` : ''})${list ? ` — this server is ${list}` : ''}`;
            if (isCurrent()) this._blockIp(addresses);
          }
          lastError = new ApiFootballUnavailable(
            transient ? 'API-Football is temporarily unavailable' : actualReason === 'QUOTA_EXCEEDED' ? 'API-Football daily request quota exhausted' : actualReason === 'IP_NOT_ALLOWED' ? ipMessage : `API-Football request rejected (HTTP ${res.status} on ${endpoint}${summary ? `: ${summary}` : ''})`,
            { reason: actualReason, status: res.status, endpoint, errors: errors || null,
              hint, quota: q, egressIp: addresses,
              resetAt: actualReason === 'QUOTA_EXCEEDED' ? q.resetsAt : null }
          );
          recordFailure(lastError, transient);
          retryWait = rate ? this._retryAfterMs(res) ?? 1000 : null;
          if (rate && isCurrent()) this._rateLimitedUntil = Date.now() + retryWait;
          if ((!transient && !rate) || attempt >= maxRetries || (rate && (attempt >= 1 || retryWait > 60000))) throw lastError;
        } else if (!body || typeof body !== 'object' || (!Array.isArray(body.response) && !(endpoint === '/status' && body.response && typeof body.response === 'object'))) {
          lastError = new ApiFootballUnavailable('API-Football returned an empty or malformed response', { reason: 'EMPTY_RESPONSE', status: res.status, endpoint });
          recordFailure(lastError);
          if (attempt >= maxRetries) throw lastError;
        } else {
          const info = endpoint === '/status' ? (Array.isArray(body.response) ? body.response[0] : body.response) : null;
          if (isCurrent()) {
            if (info && info.requests) this._learnQuotaFromStatus(info);
            this._recordSuccess();
            this._notifyRequest({ ok: true, endpoint, httpStatus: res.status });
          }
          const normalised = {
            get: body.get || endpoint, parameters: body.parameters || params,
            errors: errors || null, httpStatus: res.status,
            results: typeof body.results === 'number' ? body.results : Array.isArray(body.response) ? body.response.length : 1,
            paging: body.paging || { current: 1, total: 1 }, response: body.response,
          };
          if (isCurrent()) this._cacheSet(cacheKey, normalised, ttl);
          return normalised;
        }
      } catch (err) {
        if (err instanceof ApiFootballUnavailable) throw err;
        const failure = networkFailure(err, { timedOut: controller.signal.aborted });
        lastError = new ApiFootballUnavailable(`${failure.message}${failure.networkCode ? ` (${failure.networkCode})` : ''}`, { endpoint, ...failure });
        recordFailure(lastError);
        if (attempt >= maxRetries || (failure.networkCode && /CERT|ISSUER|SIGNATURE/.test(failure.networkCode))) throw lastError;
      } finally { clearTimeout(timer); }
      // Never sleep after the final attempt; a test is exactly one bounded call.
      await this._backoff(attempt + 1, retryWait);
    }
    throw lastError;
  }

  /** How long the provider asked us to wait (Retry-After), bounded. */
  _retryAfterMs(res) {
    const headers = res && res.headers;
    if (!headers || typeof headers.get !== 'function') return null;
    const raw = headers.get('retry-after');
    if (raw === null || raw === undefined || raw === '') return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 86400000);
    const at = new Date(raw);
    if (!Number.isNaN(at.getTime())) return Math.min(Math.max(0, at.getTime() - Date.now()), 86400000);
    return null;
  }

  /**
   * Notify the optional request listener (the credential service uses it to
   * persist "last API request time"). Listener failures never break a request.
   */
  _notifyRequest(info) {
    if (typeof this.onRequest !== 'function') return;
    try {
      const result = this.onRequest({ ...info, identity: { host: this.host, fingerprint: createHash('sha256').update(String(this.key)).digest('hex') } });
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
    await this._refreshCredential();
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
      egressIp: null,
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
      const data = await this.request(endpoint, {}, { ttl: 0, retries: 0, bypassCircuit: true });
      const latencyMs = Date.now() - startedAt;
      const info = (Array.isArray(data.response) ? data.response[0] : data.response) || null;

      if (data.errors && (Array.isArray(data.errors) ? data.errors.length : Object.keys(data.errors).length)) {
        const state = classifyProviderError({ httpStatus: null, errors: data.errors });
        const addresses = state === CONNECTION_STATES.IP_NOT_ALLOWED ? await this._serverAddresses() : null;
        return {
          ...base,
          state,
          label: CONNECTION_LABELS[state] || state,
          // The reason and its fix must travel with the verdict, exactly as
          // they do for the thrown errors — a bare state is not a diagnosis.
          reason: state === CONNECTION_STATES.INVALID_KEY ? UNAVAILABLE_REASONS.AUTH_REJECTED : state,
          hint: addresses ? ipNotAllowedHint(addresses) : reasonInfo(state).hint,
          egressIp: addresses,
          latencyMs,
          message: `The provider rejected this request: ${summarizeProviderError(data.errors) || state}`,
          errors: summarizeProviderError(data.errors),
        };
      }

      if (!info || !(info.requests && toNumberOrNull(info.requests.current) !== null) && !(info.subscription && typeof info.subscription.active === 'boolean')) {
        return {
          ...base,
          state: CONNECTION_STATES.PROVIDER_UNAVAILABLE,
          label: CONNECTION_LABELS.PROVIDER_UNAVAILABLE,
          latencyMs,
          httpStatus: data.httpStatus || 200,
          reason: 'EMPTY_RESPONSE', hint: reasonInfo('EMPTY_RESPONSE').hint,
          message: 'The provider answered without a valid status payload.',
        };
      }

      const quota =
        info.requests && toNumberOrNull(info.requests.current) !== null
          ? { current: Number(info.requests.current), limitDay: toNumberOrNull(info.requests.limit_day) }
          : null;

      const inactive = info.subscription && info.subscription.active === false;
      const exhausted = quota && quota.limitDay !== null && quota.current >= quota.limitDay;
      const state = inactive ? 'SUBSCRIPTION_INACTIVE' : exhausted ? 'QUOTA_EXCEEDED' : 'CONNECTED';
      return {
        ...base,
        httpStatus: data.httpStatus || 200,
        rateLimitPerMinute: this._quota.perMinuteLimit,
        reason: state === 'CONNECTED' ? null : state,
        hint: state === 'CONNECTED' ? null : reasonInfo(state).hint,
        resetAt: exhausted ? this.quotaState().resetsAt : null,
        ok: state === 'CONNECTED',
        state,
        label: CONNECTION_LABELS[state],
        latencyMs,
        message: `${inactive ? 'The provider reports an inactive subscription' : exhausted ? 'The credential was accepted, but today’s daily quota is exhausted' : 'The provider accepted the credential'}${
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
      else if (reason === UNAVAILABLE_REASONS.IP_NOT_ALLOWED) state = CONNECTION_STATES.IP_NOT_ALLOWED;
      else if (reason === UNAVAILABLE_REASONS.PROVIDER_UNAVAILABLE) state = CONNECTION_STATES.PROVIDER_UNAVAILABLE;
      else if (reason === UNAVAILABLE_REASONS.NETWORK_ERROR) state = CONNECTION_STATES.NETWORK_ERROR;
      else if (reason === UNAVAILABLE_REASONS.EMPTY_RESPONSE) state = CONNECTION_STATES.PROVIDER_UNAVAILABLE;
      else if (reason === UNAVAILABLE_REASONS.CIRCUIT_OPEN) state = CONNECTION_STATES.PROVIDER_UNAVAILABLE;
      else if (reason === UNAVAILABLE_REASONS.NO_API_KEY || reason === UNAVAILABLE_REASONS.CONFIG_INVALID) state = CONNECTION_STATES.CONFIG_INCOMPLETE;
      else if (reason === 'REQUEST_REJECTED' || reason === 'SUBSCRIPTION_INACTIVE') state = reason;
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
        networkCode: described.networkCode,
        egressIp: described.egressIp,
        resetAt: described.resetAt,
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
    const info = (Array.isArray(data.response) ? data.response[0] : data.response) || null;
    if (info && info.requests) this._learnQuotaFromStatus(info);
    return info;
  }

  /** GET /fixtures?date=YYYY-MM-DD */
  async getFixturesByDate(date, extra = {}) {
    return this.request('/fixtures', { date, timezone: 'UTC', ...extra }, { ttl: this._cacheTtl.fixtures });
  }

  /** GET /fixtures?ids=1-2-3 — documented maximum: 20 IDs. */
  async getFixturesByIds(ids) {
    if (!ids || !ids.length) return { response: [], results: 0 };
    const values = fixtureIds(ids);
    return this.request('/fixtures', { ids: values.join('-'), timezone: 'UTC' }, { ttl: this._cacheTtl.fixtures });
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
    return this.request('/odds', { date, page, bet: 5 }, { ttl: 0 }); // odds are never served from cache when refreshing
  }

  /** GET /odds?fixture=ID — exact price for one fixture (used at generation time). */
  async getOddsByFixture(fixtureId) {
    return this.request('/odds', { fixture: fixtureIds([fixtureId])[0], bet: 5 }, { ttl: 0 });
  }

  /** /odds accepts ONE fixture integer; combine individual real responses. */
  async getOddsByFixtures(ids) {
    if (!ids || !ids.length) return { response: [], results: 0 };
    const values = fixtureIds(ids);
    const response = [];
    for (const id of values) {
      const data = await this.getOddsByFixture(id);
      response.push(...data.response);
    }
    return { response, results: response.length, paging: { current: 1, total: 1 }, endpointCalls: values.length };
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

function fixtureIds(ids) {
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => !['string', 'number'].includes(typeof id) || !/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw AppError.badRequest('Supply up to 20 positive fixture IDs.', 'INVALID_FIXTURE_IDS');
  }
  return [...new Set(ids.map(Number))];
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
  ipNotAllowedHint,
  CREDENTIAL_REFRESH_MS,
};
