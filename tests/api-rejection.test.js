'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiFootballClient, ApiFootballUnavailable } = require('../server/services/apiFootball');

function client(status, body) {
  const calls = { n: 0 };
  const c = new ApiFootballClient({
    key: 'test-key',
    maxRetries: 1,
    fetch: async () => {
      calls.n += 1;
      return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
    },
  });
  c.manageCredential = false;
  c._backoff = async () => {};
  return { c, calls };
}

test('a rejected request reports HTTP status, provider message and a credential hint', async () => {
  const { c } = client(403, { errors: { token: 'Error/Missing application key' } });
  await assert.rejects(c.request('/odds', { date: '2026-10-16', page: 1 }), (err) => {
    assert.ok(err instanceof ApiFootballUnavailable);
    assert.match(err.message, /rejected \(HTTP 403 on \/odds: .*Missing application key/);
    assert.equal(err.details.reason, 'AUTH_REJECTED');
    assert.ok(err.details.hint);
    return true;
  });
});

test('HTTP 499 (provider timeout) is retried instead of treated as a rejection', async () => {
  const { c, calls } = client(499, {});
  await assert.rejects(c.request('/odds', { date: '2026-10-16' }), /temporarily unavailable/);
  assert.equal(calls.n, 2);
});
