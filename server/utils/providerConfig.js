'use strict';

const { AppError } = require('./errors');

const DIRECT_HOST = 'v3.football.api-sports.io';
const RAPID_HOST = 'api-football-v1.p.rapidapi.com/v3';

/** cPanel values are sometimes pasted with a scheme, trailing slash or quotes. */
function unquote(value) {
  const text = String(value ?? '').trim();
  return /^(["']).*\1$/s.test(text) ? text.slice(1, -1).trim() : text;
}

function normalizeHost(value) {
  const host = unquote(value).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (host === `${DIRECT_HOST}/v3`) return DIRECT_HOST;
  if (host === RAPID_HOST.replace(/\/v3$/, '')) return RAPID_HOST;
  return host;
}

function baseUrlForHost(value) {
  const host = normalizeHost(value);
  return host === DIRECT_HOST || host === RAPID_HOST ? `https://${host}` : null;
}

function normalizeApiKey(value) {
  const key = unquote(value);
  if (!key) throw AppError.badRequest('An API key is required', 'API_KEY_REQUIRED');
  if (key.length < 8 || key.length > 256 || /^\*{4,}/.test(key) || /[^\x21-\x7e]|["'`]/.test(key)) {
    throw AppError.badRequest('Use the API key only (8–256 printable characters), without header names, spaces or line breaks.', 'API_KEY_MALFORMED');
  }
  return key;
}

/** Provider errors can echo credentials; redact before returning OR persisting. */
function redactSecret(value, secret) {
  let text = String(value ?? '');
  if (secret) {
    for (const variant of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) text = text.split(variant).join('[REDACTED]');
  }
  return text;
}

module.exports = { DIRECT_HOST, RAPID_HOST, unquote, normalizeHost, baseUrlForHost, normalizeApiKey, redactSecret };
