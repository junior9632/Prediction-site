'use strict';

/**
 * API PROVIDER REGISTRY — the allowlist that makes "API Management" safe.
 *
 * WHY A REGISTRY
 *   An admin screen that accepts an API key AND an API host is a textbook
 *   server-side request forgery (SSRF) gadget: whatever host is typed there is
 *   fetched by the server, with the server's own network position. So the
 *   browser never gets to name a host directly — it may only pick one of the
 *   hosts declared here, and every request is built from this table.
 *
 * ADDING A PROVIDER
 *   Add one entry with `implemented: true`, its official hosts and its auth
 *   header style. Providers declared with `implemented: false` are visible in
 *   the dashboard as "not available in this build" and are REFUSED by every
 *   endpoint: this project never pretends an unverified integration is live.
 */

const { AppError } = require('../utils/errors');
const { normalizeHost } = require('../utils/providerConfig');

/** How the credential is presented to the provider. */
const AUTH_STYLES = Object.freeze({
  /** Direct API-Sports host: `x-apisports-key: <key>` */
  API_SPORTS: 'api_sports',
  /** RapidAPI marketplace host: `x-rapidapi-key` + `x-rapidapi-host` */
  RAPIDAPI: 'rapidapi',
});

const PROVIDERS = Object.freeze({
  api_football: Object.freeze({
    id: 'api_football',
    label: 'API-Football (Pro)',
    description: 'Fixtures, verified Over 1.5 bookmaker prices, form, injuries and results.',
    implemented: true,
    defaultHostId: 'v3.football.api-sports.io',
    testEndpoint: '/status',
    /** Requests per minute budget used when the provider does not report one. */
    defaultRatePerMinute: 60,
    docsUrl: 'https://www.api-football.com/documentation-v3',
    hosts: Object.freeze([
      Object.freeze({
        id: 'v3.football.api-sports.io',
        label: 'v3.football.api-sports.io (official API-Sports host)',
        authStyle: AUTH_STYLES.API_SPORTS,
        baseUrl: 'https://v3.football.api-sports.io',
        recommended: true,
      }),
      Object.freeze({
        id: 'api-football-v1.p.rapidapi.com/v3',
        label: 'api-football-v1.p.rapidapi.com/v3 (RapidAPI marketplace host)',
        authStyle: AUTH_STYLES.RAPIDAPI,
        baseUrl: 'https://api-football-v1.p.rapidapi.com/v3',
        recommended: false,
      }),
    ]),
  }),

  /**
   * Declared so the feature is extensible, deliberately NOT implemented:
   * no client, no host, no test. Selecting one is refused with
   * PROVIDER_NOT_IMPLEMENTED instead of showing a fake "connected" state.
   */
  sportmonks: Object.freeze({
    id: 'sportmonks',
    label: 'SportMonks (not implemented in this build)',
    description: 'Declared for future extension. This build ships no client for it, so it cannot be configured or activated.',
    implemented: false,
    hosts: Object.freeze([]),
    defaultHostId: null,
    testEndpoint: null,
    docsUrl: null,
  }),
  football_data_org: Object.freeze({
    id: 'football_data_org',
    label: 'football-data.org (not implemented in this build)',
    description: 'Declared for future extension. This build ships no client for it, so it cannot be configured or activated.',
    implemented: false,
    hosts: Object.freeze([]),
    defaultHostId: null,
    testEndpoint: null,
    docsUrl: null,
  }),
});

const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

/** The provider this build actually integrates with. */
const DEFAULT_PROVIDER_ID = 'api_football';

/** Safe, browser-facing view: no secrets, no internal URLs. */
function describe(provider) {
  return {
    id: provider.id,
    label: provider.label,
    description: provider.description || null,
    implemented: Boolean(provider.implemented),
    defaultHostId: provider.defaultHostId || null,
    hosts: (provider.hosts || []).map((host) => ({
      id: host.id,
      label: host.label,
      recommended: Boolean(host.recommended),
    })),
    ratePerMinuteDefault: provider.defaultRatePerMinute || null,
    docsUrl: provider.docsUrl || null,
  };
}

/** Every provider, for the selection control. */
function list() {
  return PROVIDER_IDS.map((id) => describe(PROVIDERS[id]));
}

function get(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

/** Resolve a provider id or throw a 400 explaining the accepted values. */
function requireProvider(providerId) {
  const provider = get(providerId);
  if (!provider) {
    throw AppError.badRequest(`Unknown API provider "${providerId}"`, 'UNKNOWN_PROVIDER', {
      accepted: PROVIDER_IDS,
    });
  }
  if (!provider.implemented) {
    throw AppError.badRequest(
      `No verified ${provider.label} integration ships in this build — it cannot be configured or activated.`,
      'PROVIDER_NOT_IMPLEMENTED',
      { provider: provider.id, implemented: false }
    );
  }
  return provider;
}

/**
 * Resolve a host against the provider allowlist.
 * Anything not on the list is refused — the server never fetches an
 * administrator-supplied host.
 */
function requireHost(provider, hostValue) {
  const wanted = normalizeHost(hostValue) || normalizeHost(provider.defaultHostId);
  if (!wanted) {
    throw AppError.badRequest('No API host was supplied and the provider has no default host', 'HOST_REQUIRED');
  }
  const match = (provider.hosts || []).find((host) => host.id === wanted);
  if (!match) {
    throw AppError.badRequest(
      `Host "${wanted}" is not an approved ${provider.label} API host.`,
      'HOST_NOT_ALLOWED',
      { allowedHosts: (provider.hosts || []).map((h) => h.id) }
    );
  }
  return match;
}

/** Effective request budget: the stored value wins, else the provider default. */
function ratePerMinute(provider, stored) {
  const n = Number(stored);
  if (Number.isFinite(n) && n > 0) return Math.min(n, 600);
  return provider.defaultRatePerMinute || 60;
}

module.exports = {
  AUTH_STYLES,
  PROVIDERS,
  PROVIDER_IDS,
  DEFAULT_PROVIDER_ID,
  list,
  get,
  requireProvider,
  normalizeHost,
  requireHost,
  ratePerMinute,
};
