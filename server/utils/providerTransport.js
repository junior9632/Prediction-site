'use strict';

const { Agent } = require('undici');

/**
 * A provider-only dispatcher, not a global DNS or TLS override. Node 18's
 * default fetch can select an unreachable IPv6 address on shared hosting.
 * Happy Eyeballs tries the other family without disabling certificate checks.
 * A host operator can explicitly select IPv4/IPv6 if their routing needs it.
 */
function createProviderDispatcher(family = 'auto', lookup = undefined) {
  const selected = String(family).toLowerCase();
  return new Agent({
    connect: selected === '4' || selected === '6'
      ? { family: Number(selected), autoSelectFamily: false, lookup }
      : { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250, lookup },
    connections: 4,
    keepAliveTimeout: 10000,
  });
}

/** Only stable OS/transport codes are exposed, never sockets, headers or keys. */
function networkFailure(error, { timedOut = false } = {}) {
  const codes = [];
  const seen = new Set();
  function visit(err, depth = 0) {
    if (!err || typeof err !== 'object' || seen.has(err) || depth > 5) return;
    seen.add(err);
    if (typeof err.code === 'string') codes.push(err.code);
    visit(err.cause, depth + 1);
    if (Array.isArray(err.errors)) err.errors.slice(0, 8).forEach((child) => visit(child, depth + 1));
  }
  visit(error);
  const messages = {
    ENOTFOUND: ['DNS lookup failed', 'Check the approved provider host and your hosting DNS resolver. Run npm run api:check on the hosting server.'],
    EAI_AGAIN: ['DNS lookup temporarily failed', 'Retry after the DNS resolver recovers; ask the host to check outbound DNS if this repeats. Run npm run api:check.'],
    ENETUNREACH: ['No network route to the provider', 'Ask the host to allow outbound HTTPS (port 443). On IPv4-only hosting, set API_FOOTBALL_IP_FAMILY=4 and restart, then run npm run api:check.'],
    EHOSTUNREACH: ['The provider network is unreachable', 'Check hosting outbound HTTPS and IP routing. Run npm run api:check on the hosting server.'],
    ECONNREFUSED: ['The HTTPS connection was refused', 'Ask the host/provider to check firewall rules and outbound TCP port 443. Run npm run api:check.'],
    ECONNRESET: ['The HTTPS connection was reset', 'Retry once; if repeated, ask the host/provider to check shared-IP firewall restrictions. Run npm run api:check.'],
    CERT_HAS_EXPIRED: ['The TLS certificate has expired', 'Check the server clock and ask the host/provider to repair its certificate chain. Never disable TLS verification.'],
    SELF_SIGNED_CERT_IN_CHAIN: ['TLS certificate verification failed', 'Check the hosting CA trust store and any HTTPS interception. Never disable TLS verification.'],
    EACCES: ['Outbound network access was denied', 'Ask the host to allow outbound HTTPS on port 443, then run npm run api:check.'],
    UND_ERR_SOCKET: ['The provider connection closed unexpectedly', 'Check hosting/provider firewall and shared-IP restrictions, then run npm run api:check.'],
    DEPTH_ZERO_SELF_SIGNED_CERT: ['TLS certificate verification failed', 'Check the hosting CA trust store or HTTPS interception. Never disable TLS verification.'],
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: ['TLS certificate verification failed', 'Ask the host to repair its CA trust store or the provider certificate chain. Never disable TLS verification.'],
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: ['The TLS issuer is not trusted', 'Update the hosting CA certificates. Never disable TLS verification.'],
    ERR_TLS_CERT_ALTNAME_INVALID: ['The TLS certificate does not match the host', 'Check the provider hostname, DNS and any HTTPS proxy. Never disable TLS verification.'],
    UND_ERR_CONNECT_TIMEOUT: ['The HTTPS connection timed out', 'Check outbound HTTPS and IPv4/IPv6 routing, then run npm run api:check.'],
    UND_ERR_HEADERS_TIMEOUT: ['The provider response timed out', 'Check the provider status and API_FOOTBALL_TIMEOUT_MS on the server.'],
    UND_ERR_BODY_TIMEOUT: ['The provider response timed out', 'Check the provider status and API_FOOTBALL_TIMEOUT_MS on the server.'],
    ETIMEDOUT: ['The connection timed out', 'Check outbound HTTPS and API_FOOTBALL_TIMEOUT_MS, then run npm run api:check.'],
  };
  const code = codes.find((c) => Object.prototype.hasOwnProperty.call(messages, c)) || null;
  const timeout = timedOut || error?.name === 'AbortError' || Boolean(code && /TIMEOUT|TIMEDOUT/.test(code));
  const [message, hint] = messages[code] || (timeout
    ? ['The provider did not answer before the request timeout', 'Check outbound HTTPS or increase API_FOOTBALL_TIMEOUT_MS, then run npm run api:check.']
    : ['The HTTPS request to the provider failed', 'Check hosting outbound HTTPS/DNS and the provider firewall, then run npm run api:check.']);
  return { reason: timeout ? 'TIMEOUT' : 'NETWORK_ERROR', networkCode: code, message, hint };
}

module.exports = { createProviderDispatcher, networkFailure };
