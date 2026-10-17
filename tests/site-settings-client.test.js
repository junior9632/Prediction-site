'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8');

function makeClient({ meta, fail = false } = {}) {
  const calls = [];
  const events = {};
  const name = { innerHTML: 'Goal<em>Predict</em>', textContent: 'GoalPredict' };
  const tagline = { innerHTML: '', textContent: 'Smarter Football Picks' };
  const document = {
    title: 'Fixtures — GoalPredict', cookie: '',
    querySelectorAll(selector) {
      if (selector === '.brand-name, [data-site-name]') return [name];
      if (selector.startsWith('.brand-tag')) return [tagline];
      return [];
    },
    addEventListener(type, handler) { (events[type] = events[type] || []).push(handler); },
  };
  const sandbox = {
    document, window: { document, location: { pathname: '/', search: '', hash: '', replace() {} }, addEventListener() {} },
    navigator: {}, console, setTimeout, clearTimeout, AbortController,
    fetch: async (url) => {
      calls.push(url);
      if (fail) throw new Error('offline');
      assert.equal(url, '/api/meta');
      return { ok: true, json: async () => ({ ok: true, data: meta || { siteName: 'Test Football', tagline: 'A test tagline', displayTimezone: 'Africa/Lagos' } }) };
    },
  };
  vm.runInNewContext(SCRIPT, sandbox, { filename: 'api.js' });
  return { client: sandbox.window.App, document, name, tagline, calls, events };
}

test('site name, tagline and display timezone are actually applied from public metadata', async () => {
  const page = makeClient();
  await Promise.all([page.client.site.load(), page.client.site.load()]);
  assert.deepEqual(page.calls, ['/api/meta'], 'all views share one metadata read');
  assert.equal(page.name.textContent, 'Test Football');
  assert.equal(page.tagline.textContent, 'A test tagline');
  assert.equal(page.document.title, 'Fixtures — Test Football');
  assert.equal(page.client.fmt.zoneLabel(), 'Africa/Lagos');
  assert.equal(page.client.fmt.dateTimeLabel('2026-10-16T23:30:00Z'), '17 Oct 2026 · 00:30');
});

test('changing the timezone affects kickoff instants, never shifts a ticket calendar date', () => {
  const { client } = makeClient();
  client.site.apply({ displayTimezone: 'America/New_York' });
  assert.equal(client.fmt.dateTimeLabel('2026-10-16T01:30:00Z'), '15 Oct 2026 · 21:30');
  assert.equal(client.fmt.dayLabel('2026-10-16'), '16 Oct 2026');
  client.site.apply({ displayTimezone: 'UTC' });
  assert.equal(client.fmt.dateTimeLabel('2026-10-16T01:30:00Z'), '16 Oct 2026 · 01:30');
  assert.equal(client.fmt.dayLabel('2026-10-16'), '16 Oct 2026');
});

test('display timezone handles daylight-saving offsets rather than adding a fixed offset', () => {
  const { client } = makeClient();
  client.site.apply({ displayTimezone: 'Europe/London' });
  assert.equal(client.fmt.timeLabel('2026-07-16T12:00:00Z'), '13:00');
  assert.equal(client.fmt.timeLabel('2026-12-16T12:00:00Z'), '12:00');
});

test('invalid timezone or offline metadata cannot break page formatting', async () => {
  const { client } = makeClient({ fail: true });
  await assert.doesNotReject(() => client.site.load());
  client.site.apply({ displayTimezone: 'Invalid/Zone' });
  assert.doesNotThrow(() => client.fmt.dateTimeLabel('2026-10-16T12:00:00Z'));
  assert.equal(client.fmt.dateTimeLabel(null), '—');
});

test('branding is inserted as text, and restoring defaults restores the original header markup', () => {
  const page = makeClient();
  page.client.site.apply({ siteName: '<img src=x onerror=alert(1)>', tagline: '<script>bad</script>' });
  assert.equal(page.name.textContent, '<img src=x onerror=alert(1)>');
  assert.ok(!page.name.innerHTML.includes('<img'));
  page.client.site.apply({ siteName: 'GoalPredict', tagline: 'Smarter Football Picks' });
  assert.equal(page.name.innerHTML, 'Goal<em>Predict</em>');
  assert.equal(page.tagline.textContent, 'Smarter Football Picks');
});
