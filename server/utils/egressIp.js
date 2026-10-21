'use strict';

/**
 * WHICH ADDRESS DOES THE PROVIDER SEE?
 *
 * API-Football can restrict an API key to a list of IP addresses/domains
 * (`dashboard.api-football.com/profile?access`). When that list does not
 * contain the address this server calls from, EVERY endpoint answers HTTP 200
 * with a soft error in `errors.Ip`:
 *
 *   {"Ip": "This IP is not allowed to call the API, check the list of allowed
 *           IPs in the dashboard."}
 *
 * That is a configuration fact, not an outage, and the one thing the operator
 * needs in order to fix it is the address to add. Rather than asking them to
 * find it themselves, the server reports the address it believes it uses:
 *
 *   1. `SERVER_PUBLIC_IP` — an explicit value the operator sets (most reliable,
 *      and the only source that needs no outbound request at all);
 *   2. a short HTTPS lookup (`SERVER_IP_LOOKUP_URL`, default ipify) that shows
 *      the address the outside world really sees, i.e. the NAT/egress address;
 *   3. this machine's own public interface addresses, as a fallback when the
 *      lookup is blocked by the host's firewall.
 *
 * What this module does NOT do: change the network, discover private addresses
 * as if they were routable, or guess. If nothing can be learned the caller
 * simply reports the rejection without an address — the operator then reads it
 * from the provider's own error or asks the host.
 *
 * Privacy: the lookup is a single GET to a public "what is my IP" service. It
 * runs only when API-Football has already reported an IP block, it carries no
 * key, cookie or identifying header, and it can be switched off entirely with
 * `SERVER_IP_LOOKUP=0` (or by setting `SERVER_PUBLIC_IP`).
 */

const net = require('node:net');
const os = require('node:os');
const config = require('../config');
const logger = require('./logger');

const log = logger.child('server-address');

/** A learned answer stays valid this long; addresses rarely change. */
const CACHE_MS = 10 * 60 * 1000;
/** Never report a wall of addresses in a dashboard hint. */
const MAX_ADDRESSES = 4;

let cache = { value: null, at: 0 };

/**
 * Is this a globally routable address an operator could add to an allowlist?
 *
 * Private, loopback, link-local, CGNAT (100.64/10 — typical shared hosting
 * behind a carrier NAT) and unique-local IPv6 ranges are NOT, so they are never
 * presented as "add this to the provider allowlist".
 */
function isPublicAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (!address || !net.isIP(address)) return false;
  if (address.startsWith('::ffff:')) return isPublicAddress(address.slice(7));
  if (net.isIPv4(address)) {
    return !/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|255\.255\.255\.255$)/.test(address);
  }
  // IPv6: ::1 loopback, fe80::/10 link-local, fc00::/7 unique-local.
  if (address === '::1' || address === '::') return false;
  if (/^fe[89ab]/.test(address)) return false;
  if (/^f[cd]/.test(address)) return false;
  return true;
}

/** Public addresses configured on this machine (no network call). */
function localPublicAddresses() {
  const found = [];
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch (_err) {
    return found;
  }
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      const address = String(entry.address || '').split('%')[0];
      if (!isPublicAddress(address)) continue;
      found.push(address);
    }
  }
  return [...new Set(found)];
}

/** One bounded GET to a "what is my IP" service. Returns null for anything odd. */
async function lookupAddress({ fetchImpl, dispatcher, url, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await (fetchImpl || globalThis.fetch)(url, {
      method: 'GET',
      // No key, no cookie, no referrer: this request is not about the account.
      headers: { accept: 'application/json' },
      signal: controller.signal,
      dispatcher,
      redirect: 'manual',
    });
    if (!res || !res.ok) return null;
    const text = String(await res.text()).slice(0, 200).trim();
    let candidate = text;
    try {
      const parsed = JSON.parse(text);
      candidate = parsed && (parsed.ip || parsed.address || parsed.query);
    } catch (_err) {
      /* plain-text answers are the documented alternative */
    }
    const address = String(candidate || '').trim();
    return isPublicAddress(address) ? address : null;
  } catch (err) {
    log.warn('could not look up this server’s public address', { message: err && err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The addresses this server can be expected to call the provider from.
 *
 * @param {{fetchImpl?: Function, dispatcher?: object, declaredIp?: string|null,
 *          lookupEnabled?: boolean, lookupUrl?: string, timeoutMs?: number,
 *          skipLookup?: boolean, now?: number}} [options]
 * @returns {Promise<{ips: string[], source: string, checkedAt: string, detail: string}|null>}
 *   `null` when nothing could be learned — never a fabricated address.
 */
async function discoverServerAddresses(options = {}) {
  const settings = config.serverAddress || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  // 1. An address the operator declared. No lookup, no guess.
  const declared = String(options.declaredIp ?? settings.declaredIp ?? '')
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (declared.length) {
    const valid = [...new Set(declared.filter(isPublicAddress))].slice(0, MAX_ADDRESSES);
    if (valid.length) {
      return {
        ips: valid,
        source: 'SERVER_PUBLIC_IP',
        checkedAt: new Date(now).toISOString(),
        detail: 'configured on this server (environment)',
      };
    }
    log.warn('SERVER_PUBLIC_IP is not a public IP address and was ignored', { configured: declared.length });
  }

  if (!options.skipLookup && cache.value && now - cache.at < CACHE_MS) return cache.value;

  const local = localPublicAddresses();
  const lookupEnabled = options.lookupEnabled ?? settings.lookupEnabled ?? true;
  let looked = null;
  if (lookupEnabled) {
    looked = await lookupAddress({
      fetchImpl: options.fetchImpl,
      dispatcher: options.dispatcher,
      url: options.lookupUrl || settings.lookupUrl,
      timeoutMs: Number(options.timeoutMs || settings.timeoutMs) || 4000,
    });
  }

  const ips = [...new Set([...[looked], ...local].filter(isPublicAddress))].slice(0, MAX_ADDRESSES);
  if (!ips.length) return null;

  const value = {
    ips,
    source: looked ? 'public address lookup' : 'network interfaces',
    checkedAt: new Date(now).toISOString(),
    detail: looked
      ? 'the address the outside world sees'
      : 'this machine’s own public interface addresses (the lookup was unavailable)',
  };
  cache = { value, at: now };
  return value;
}

/** Human readable, e.g. "203.0.113.10 and 2001:db8::1". */
function formatAddresses(addresses) {
  const ips = (addresses && addresses.ips) || [];
  if (!ips.length) return '';
  if (ips.length === 1) return ips[0];
  return `${ips.slice(0, -1).join(', ')} and ${ips[ips.length - 1]}`;
}

/** Test seam: forget the cached answer. */
function resetAddressCache() {
  cache = { value: null, at: 0 };
}

module.exports = {
  isPublicAddress,
  localPublicAddresses,
  discoverServerAddresses,
  formatAddresses,
  resetAddressCache,
  CACHE_MS,
};
