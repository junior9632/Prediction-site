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

    this._callTimestamps = [];
    this._cache = new Map();
    this._cacheTtl = options.cacheTtl || DEFAULT_TTL;
    this._breaker = { failures: 0, openedAt: 0, cooldownMs: options.cooldownMs || 60 * 1000 };
    this._maxFailures = options.maxFailures || 4;

    // counters surfaced in the admin "API Status" panel
    this.stats = { calls: 0, failures: 0, cacheHits: 0, lastCallAt: null, lastError: null, quota: null };
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

        if (res.status === 429 || res.status >= 500) {
          lastError = new ApiFootballUnavailable('API-Football rate limited or unavailable', {
            status: res.status,
            endpoint,
          });
          this._recordFailure(lastError.message);
          await this._backoff(attempt);
          continue;
        }

        if (!res.ok) {
          const apiErrors = (body && body.errors) || null;
          this._recordFailure(`HTTP ${res.status} on ${endpoint}`);
          throw new ApiFootballUnavailable('API-Football request rejected', {
            status: res.status,
            endpoint,
            errors: apiErrors,
          });
        }

        if (!body) {
          this._recordFailure('empty body');
          lastError = new ApiFootballUnavailable('API-Football returned an empty response');
          await this._backoff(attempt);
          continue;
        }

        // API-Football reports soft errors with HTTP 200 + `errors`
        if (body.errors && (Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length)) {
          const errText = Array.isArray(body.errors) ? body.errors.join('; ') : JSON.stringify(body.errors);
          if (/requests? limit|quota|exceeded/i.test(errText)) {
            this._recordFailure(errText);
            throw new ApiFootballUnavailable('API-Football daily quota reached', { errors: body.errors });
          }
          log.warn('API-Football soft error', { endpoint, errText });
          body.softErrors = body.errors;
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
        lastError = new ApiFootballUnavailable('API-Football network error', {
          endpoint,
          message: err && err.message ? err.message : String(err),
        });
        this._recordFailure(lastError.details?.message || 'network error');
        if (attempt > retries) throw lastError;
        await this._backoff(attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new ApiFootballUnavailable('API-Football request failed');
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

module.exports = { ApiFootballClient, ApiFootballUnavailable, apiFootball, DEFAULT_TTL };
