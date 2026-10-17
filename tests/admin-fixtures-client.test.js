'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../public/js/admin-fixtures.js'), 'utf8');
const html = (value) => String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fixtures = Array.from({ length: 103 }, (_, index) => ({
  id: index + 1, home: `Home ${index + 1}`, away: 'Away Team', league: 'Test League', country: 'Testland',
  kickoffAt: '2026-10-16T18:00:00Z', status: index % 2 ? 'FT' : 'NS', statusLabel: index % 2 ? 'Match Finished' : 'Not Started',
  playable: index % 2 === 0, finished: index % 2 === 1, live: false, score: index % 2 ? '0-0' : null, fetchedAt: '2026-10-16T12:00:00Z',
}));

function makePage({ get, post, items = fixtures } = {}) {
  const nodes = new Map();
  const calls = { get: [], post: [] };
  let current = true;
  let rendered = '';
  const node = (id) => {
    if (nodes.has(id)) return nodes.get(id);
    const entry = { id, value: '', disabled: false, content: '', reportValidity() { return Boolean(this.value); } };
    Object.defineProperty(entry, 'innerHTML', {
      get: () => entry.content,
      set(value) {
        entry.content = value;
        if (id === '#fxPager') {
          nodes.delete('#fxPrev'); nodes.delete('#fxNext');
          for (const name of ['fxPrev', 'fxNext']) if (value.includes(`id="${name}"`)) node(`#${name}`).disabled = new RegExp(`id="${name}"[^>]*disabled`).test(value);
        }
      },
    });
    nodes.set(id, entry);
    return entry;
  };
  const sandbox = {
    document: { querySelector: (selector) => nodes.get(selector) || null },
    window: { confirm: () => true }, console,
  };
  vm.runInNewContext(SCRIPT, sandbox, { filename: 'admin-fixtures.js' });
  const page = sandbox.window.AdminFixtures;
  const API = {
    async get(url) { calls.get.push(url); return get ? get(url) : { items, total: items.length }; },
    async post(url, body) { calls.post.push({ url, body: JSON.parse(JSON.stringify(body)) }); return post ? post(url, body) : { result: { upcoming: items.length } }; },
  };
  return {
    page, nodes, calls,
    get rendered() { return rendered; },
    leave() { current = false; },
    load: () => page.load({
      API, fmt: { dateTimeLabel: (value) => value || '—', ago: (value) => value || '—', zoneLabel: () => 'Africa/Lagos' },
      icons: {}, escapeHtml: html, card: (title, body) => `${title}${body}`, table: (_headers, rows) => rows,
      emptyState: (_icon, title, description) => `${html(title)} ${html(description)}`, skeletonRows: () => 'Loading…',
      render: (value) => {
        rendered = value;
        for (const id of ['fixturesView', 'fixtureFilters', 'fxDate', 'fxGo', 'fxSync', 'fxMessage', 'fxSearch', 'fxStatus', 'fxBody', 'fxPager']) node(`#${id}`);
        node('#fxDate').value = value.match(/id="fxDate" value="([^"]+)"/)[1];
        node('#fxStatus').value = 'all';
      },
      isCurrent: () => current,
    }),
  };
}

test('fixtures view browses every stored fixture with pagination, search and status filters', async () => {
  const testPage = makePage();
  await testPage.load();
  const { nodes } = testPage;
  assert.match(testPage.calls.get[0], /^\/admin\/fixtures\?date=\d{4}-\d{2}-\d{2}$/);
  assert.match(nodes.get('#fxBody').innerHTML, /<b>Home 1<\/b>/);
  assert.ok(!nodes.get('#fxBody').innerHTML.includes('<b>Home 51</b>'));
  assert.equal(nodes.get('#fxPrev').disabled, true);
  nodes.get('#fxNext').onclick();
  assert.match(nodes.get('#fxBody').innerHTML, /<b>Home 51<\/b>/);
  nodes.get('#fxNext').onclick();
  assert.match(nodes.get('#fxBody').innerHTML, /<b>Home 103<\/b>/);
  assert.equal(nodes.get('#fxNext').disabled, true);
  nodes.get('#fxSearch').value = 'Home 103';
  nodes.get('#fxSearch').oninput();
  assert.match(nodes.get('#fxBody').innerHTML, /1 matching/);
  nodes.get('#fxStatus').value = 'finished';
  nodes.get('#fxStatus').onchange();
  assert.match(nodes.get('#fxBody').innerHTML, /No matching fixtures/);
  nodes.get('#fxSearch').value = '';
  nodes.get('#fxSearch').oninput();
  assert.match(nodes.get('#fxBody').innerHTML, /0-0/);
  assert.ok(!nodes.get('#fxBody').innerHTML.includes('<b>Home 1</b>'));
  assert.match(testPage.rendered, /Fixture date \(UTC\)/);
  assert.match(testPage.rendered, /Africa\/Lagos/);
});

test('selected-date sync sends exactly the selected date, disables repeat clicks and reloads real data', async () => {
  let resolve;
  const testPage = makePage({ post: () => new Promise((done) => { resolve = done; }) });
  await testPage.load();
  testPage.nodes.get('#fxDate').value = '2026-10-12';
  const first = testPage.nodes.get('#fxSync').onclick();
  await testPage.nodes.get('#fxSync').onclick();
  assert.equal(testPage.calls.post.length, 1);
  assert.deepEqual(testPage.calls.post[0], { url: '/admin/sync', body: { job: 'fixtures', date: '2026-10-12' } });
  assert.equal(testPage.nodes.get('#fxSync').disabled, true);
  resolve({ result: { upcoming: 7 } });
  await first;
  assert.equal(testPage.nodes.get('#fxSync').disabled, false);
  assert.equal(testPage.calls.get.at(-1), '/admin/fixtures?date=2026-10-12');
  assert.match(testPage.nodes.get('#fxMessage').innerHTML, /7 fixture\(s\) refreshed/);
  assert.match(testPage.nodes.get('#fxMessage').innerHTML, /No ticket was generated/);
});

test('quota pauses and upstream failures never render a green success message', async () => {
  for (const result of [
    { status: 'SKIPPED', reason: 'QUOTA_RESERVED', label: 'Requests reserved', hint: 'Try after midnight.' },
    { status: 'DATA_SOURCE_UNAVAILABLE', reason: 'NO_API_KEY', label: 'Missing API key', hint: 'Configure the provider.' },
  ]) {
    const testPage = makePage({ post: async () => ({ result }) });
    await testPage.load();
    await testPage.nodes.get('#fxSync').onclick();
    const message = testPage.nodes.get('#fxMessage').innerHTML;
    assert.ok(!message.includes('alert ok'));
    assert.ok(message.includes(result.label));
    assert.ok(message.includes(result.hint));
    assert.equal(testPage.nodes.get('#fxSync').disabled, false);
  }
  const { page } = makePage();
  assert.equal(page.syncState({ fixtures: {}, odds: { skippedDates: [{ date: '2026-10-16' }] }, results: {} }), 'warn');
  assert.equal(page.syncState({ dataSourceAvailable: false }), 'error');
});

test('network failures have actionable errors and re-enable load/sync controls', async () => {
  let fail = true;
  const testPage = makePage({ get: async () => { if (fail) throw new Error('Network unavailable'); return { items: [], total: 0 }; }, post: async () => { throw new Error('Sync timed out'); } });
  await testPage.load();
  assert.match(testPage.nodes.get('#fxBody').innerHTML, /Fixtures could not be loaded/);
  assert.equal(testPage.nodes.get('#fxGo').disabled, false);
  fail = false;
  await testPage.nodes.get('#fixtureFilters').onsubmit({ preventDefault() {} });
  assert.match(testPage.nodes.get('#fxBody').innerHTML, /No fixtures stored/);
  await testPage.nodes.get('#fxSync').onclick();
  assert.match(testPage.nodes.get('#fxMessage').innerHTML, /Sync failed: Sync timed out/);
  assert.equal(testPage.nodes.get('#fxSync').disabled, false);
});

test('a slow previous date cannot overwrite a newer date or a different view', async () => {
  const deferred = [];
  let initial = true;
  const testPage = makePage({ get: async () => {
    if (initial) { initial = false; return { items: [], total: 0 }; }
    return new Promise((resolve) => deferred.push(resolve));
  } });
  await testPage.load();
  testPage.nodes.get('#fxDate').value = '2026-10-10';
  const old = testPage.nodes.get('#fxDate').onchange();
  testPage.nodes.get('#fxDate').value = '2026-10-11';
  const recent = testPage.nodes.get('#fxDate').onchange();
  deferred[1]({ items: [{ ...fixtures[0], home: 'Newer date' }] });
  await recent;
  deferred[0]({ items: [{ ...fixtures[0], home: 'Older date' }] });
  await old;
  assert.ok(testPage.nodes.get('#fxBody').innerHTML.includes('Newer date'));
  assert.ok(!testPage.nodes.get('#fxBody').innerHTML.includes('Older date'));
  testPage.nodes.get('#fxDate').value = '2026-10-12';
  const last = testPage.nodes.get('#fxDate').onchange();
  testPage.leave();
  deferred[2]({ items: [{ ...fixtures[0], home: 'Stale navigation' }] });
  await last;
  assert.ok(!testPage.nodes.get('#fxBody').innerHTML.includes('Stale navigation'));
});

test('provider-originated team/status content is escaped, not executed', async () => {
  const testPage = makePage({ items: [{ ...fixtures[0], home: '<img src=x onerror=alert(1)>', statusLabel: '<script>bad</script>' }] });
  await testPage.load();
  const body = testPage.nodes.get('#fxBody').innerHTML;
  assert.ok(!body.includes('<img'));
  assert.ok(!body.includes('<script>'));
  assert.match(body, /&lt;img/);
});
