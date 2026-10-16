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
      // a different key/host must never be served a cached payload
      this._cache.clear();
      this._breaker = { ...this._breaker, failures: 0, openedAt: 0 };
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
    if (!this.configured) return { state: 'UNCONFIGURED', available: false };
    return {
      state: this.isAvailable() ? (this._breaker.failures ? 'DEGRADED' : 'OK') : 'OPEN',
      available: this.isAvailable(),
      consecutiveFailures: this._breaker.failures,
      retryInMs: this.isAvailable()
        ? 0
        : Math.max(0, this._breaker.cooldownMs - (Date.now() - this._breaker.openedAt)),
      quota: this.stats.quota,
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
        'x-rapidapi-host': this.host,
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
        reason: this.credentialError.code || 'CREDENTIAL_UNREADABLE',
        host: this.host,
      });
    }
    if (!this.configured) {
      throw new ApiFootballUnavailable('API-Football key is not configured', { reason: 'NO_API_KEY' });
    }
    if (!this.isAvailable()) {
      throw new ApiFootballUnavailable('DATA SOURCE TEMPORARILY UNAVAILABLE', {
        reason: 'CIRCUIT_OPEN',
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

        // 499/408/425 are transient timeouts on the provider side, not a rejected request
        if (res.status === 429 || res.status >= 500 || res.status === 499 || res.status === 408 || res.status === 425) {
          lastError = new ApiFootballUnavailable(
            res.status === 429
              ? 'API-Football rejected the request: rate limit reached'
              : 'API-Football is temporarily unavailable',
            { status: res.status, endpoint }
          );
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
            ? 'check API_FOOTBALL_KEY / API_FOOTBALL_HOST (an api-sports.io key needs host v3.football.api-sports.io; a RapidAPI key needs the rapidapi.com host) and that the plan includes this endpoint'
            : null;
          throw new ApiFootballUnavailable(
            `API-Football request rejected (HTTP ${res.status} on ${endpoint}${providerMessage ? `: ${providerMessage}` : ''})`,
            {
              status: res.status,
              endpoint,
              params,
              errors: apiErrors,
              reason: authRejected ? 'AUTH_REJECTED' : 'REQUEST_REJECTED',
              hint,
            }
          );
        }

        if (!body) {
          this._recordFailure('empty body');
          lastError = new ApiFootballUnavailable('API-Football returned an empty response');
          this._notifyRequest({ ok: false, endpoint, httpStatus: res.status, errorCode: 'EMPTY_BODY' });
          await this._backoff(attempt);
          continue;
        }

        // API-Football reports soft errors with HTTP 200 + `errors`
        if (body.errors && (Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length)) {
          const errText = Array.isArray(body.errors) ? body.errors.join('; ') : JSON.stringify(body.errors);
          if (/requests? limit|quota|exceeded/i.test(errText)) {
            this._recordFailure(errText);
            this._notifyRequest({ ok: false, endpoint, httpStatus: res.status, errorCode: 'QUOTA_EXCEEDED' });
            throw new ApiFootballUnavailable('API-Football daily quota reached', { errors: body.errors });
          }
          log.warn('API-Football soft error', { endpoint, errText });
          body.softErrors = body.errors;
          this._notifyRequest({ ok: false, endpoint, httpStatus: res.status, errorCode: 'SOFT_ERROR' });
        } else {
          this._notifyRequest({ ok: true, endpoint, httpStatus: res.status });
        }

        this._recordSuccess();
        if (body.response && body.response[0] && body.response[0].requests) {
          this.stats.quota = {
            current: body.response[0].requests.current,
            limit_day: body.response[0].requests.limit_day,
          };
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
          reason: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        });
        this._recordFailure(lastError.details?.message || 'network error');
        this._notifyRequest({
          ok: false,
          endpoint,
          httpStatus: null,
          errorCode: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        });
        if (attempt > retries) throw lastError;
        await this._backoff(attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new ApiFootballUnavailable('API-Football request failed');
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
      if (details.reason === 'TIMEOUT' || (err && err.name === 'AbortError')) state = CONNECTION_STATES.TIMEOUT;
      else if (details.errors || details.status) {
        state = classifyProviderError({ httpStatus, errors: details.errors || null, message: err.message });
      } else if (details.reason === 'CIRCUIT_OPEN') state = CONNECTION_STATES.PROVIDER_UNAVAILABLE;
      else if (details.reason === 'NO_API_KEY') state = CONNECTION_STATES.CONFIG_INCOMPLETE;
      else state = CONNECTION_STATES.NETWORK_ERROR;

      return {
        ...base,
        state,
        label: CONNECTION_LABELS[state] || state,
        httpStatus,
        latencyMs,
        message: err.message || 'The credential test failed',
        errors: summarizeProviderError(details.errors),
      };
    }
  }

  async _backoff(attempt) {
    const ms = Math.min(15000, 500 * 2 ** Math.max(0, attempt - 1));
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ------------------------------------------------------------------ */
  /* endpoints                                                           */
  /* ------------------------------------------------------------------ */

  /** GET /status — plan, subscription and daily request usage. */
  async getStatus() {
    const data = await this.request('/status', {}, { ttl: this._cacheTtl.status });
    const info = (data.response && data.response[0]) || null;
    if (info && info.requests) {
      this.stats.quota = { current: info.requests.current, limit_day: info.requests.limit_day };
    }
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
  classifyProviderError,
  summarizeProviderError,
  CREDENTIAL_REFRESH_MS,
};
