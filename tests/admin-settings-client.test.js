'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settingsService = require('../server/services/settingsService');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../public/js/admin-settings.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
const escapeHtml = (value) => String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (value) => JSON.parse(JSON.stringify(value));
const definitions = Object.entries(settingsService.DEFINITIONS).map(([key, definition]) => ({ key, ...definition, min: definition.min === undefined ? null : definition.min, max: definition.max === undefined ? null : definition.max }));

function makePage({ put, items = definitions, get } = {}) {
  const nodes = new Map();
  const calls = [];
  const handlers = {};
  let current = true;
  let html = '';
  const makeNode = (id) => ({
    id, value: '', checked: false, disabled: false, innerHTML: '', textContent: '', className: '', attrs: {}, listeners: {}, customError: '',
    setCustomValidity(text) { this.customError = text; },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
  });
  const fields = items.map((item) => {
    const node = makeNode(`set_${item.key}`);
    node.dataset = { setting: item.key };
    node.type = item.type === 'boolean' ? 'checkbox' : item.type === 'number' ? 'number' : 'text';
    node.value = item.type === 'json' ? JSON.stringify(JSON.parse(item.value), null, 2) : String(item.value);
    node.checked = item.value === '1';
    node.disabled = Boolean(item.locked);
    node.item = item;
    nodes.set(`#set_${item.key}`, node);
    nodes.set(`#set_${item.key}_hint`, makeNode(`set_${item.key}_hint`));
    nodes.set(`#set_${item.key}_error`, makeNode(`set_${item.key}_error`));
    return node;
  });
  for (const id of ['settingsForm', 'settingsFields', 'saveSettings', 'discardSettings', 'settingsMsg']) nodes.set(`#${id}`, makeNode(id));
  const form = nodes.get('#settingsForm');
  form.querySelectorAll = () => fields;
  form.reportValidity = () => fields.every((node) => {
    if (node.disabled) return true;
    if (node.customError) return false;
    if (node.type === 'number') return node.value.trim() !== '' && Number.isFinite(Number(node.value)) && Number(node.value) >= node.item.min && Number(node.value) <= node.item.max && (!node.item.integer || Number.isInteger(Number(node.value)));
    return true;
  });
  const API = {
    get: get || (async () => ({ items })),
    async put(url, body) {
      calls.push({ url, body: json(body) });
      return put ? put(url, body) : { applied: Object.entries(body).map(([key, value]) => ({ key, value })), rejected: [] };
    },
  };
  const sandbox = {
    document: { querySelector: (selector) => nodes.get(selector) || null },
    window: { confirm: () => true, addEventListener: (type, handler) => { handlers[type] = handler; } },
    App: {}, console,
  };
  vm.runInNewContext(SCRIPT, sandbox, { filename: 'admin-settings.js' });
  return {
    nodes, fields, calls, handlers,
    page: sandbox.window.AdminSettings,
    get html() { return html; },
    leave() { current = false; },
    node(key) { return nodes.get(`#set_${key}`); },
    change(key, value) {
      const node = this.node(key);
      if (node.type === 'checkbox') node.checked = Boolean(value);
      else node.value = value;
      node.listeners.input();
    },
    submit: () => form.onsubmit({ preventDefault() {} }),
    load: () => sandbox.window.AdminSettings.load({ API, icons: {}, escapeHtml, card: (title, body) => `<h2>${title}</h2>${body}`, render: (value) => { html = value; }, isCurrent: () => current }),
  };
}

test('settings editor renders every group, typed controls and accessible locked/toggle labels', async () => {
  const page = makePage();
  await page.load();
  for (const item of definitions) assert.ok(page.html.includes(`data-setting="${item.key}"`), item.key);
  assert.match(page.html, /for="set_enable_h2h_api"/);
  assert.match(page.html, /id="set_sync_days_ahead"[^>]*step="1"/);
  assert.match(page.html, /id="set_injury_impact_per_player"[^>]*step="any"/);
  assert.match(page.html, /id="set_market_key"[^>]*disabled/);
  assert.match(page.html, /aria-live="polite"/);
  assert.equal(page.nodes.get('#saveSettings').disabled, true);
  assert.equal(page.page.hasUnsavedChanges(), false);
  assert.match(CSS, /\.switch \.track\s*\{[^}]*pointer-events:\s*none/s, 'the decorative track cannot swallow taps');
  assert.match(CSS, /input:focus-visible \+ \.track/);
  assert.match(HTML, /admin-settings\.js\?v=20261016/);
});

test('an unchanged form sends nothing; changing one field sends no locked or unrelated settings', async () => {
  const page = makePage();
  await page.load();
  await page.submit();
  assert.equal(page.calls.length, 0);
  page.change('min_confidence', '80');
  assert.equal(page.page.hasUnsavedChanges(), true);
  await page.submit();
  assert.deepEqual(page.calls, [{ url: '/admin/settings', body: { min_confidence: '80' } }]);
  assert.equal(page.page.hasUnsavedChanges(), false);
  assert.equal(page.nodes.get('#saveSettings').disabled, true);
  assert.equal(page.node('market_key').disabled, true);
  assert.match(page.nodes.get('#settingsMsg').textContent, /1 setting\(s\) saved/);
});

test('toggle changes and exact JSON values are saved without altering numeric precision', async () => {
  const page = makePage();
  await page.load();
  page.change('enable_h2h_api', false);
  page.change('risk_weights', '{"injuries": 0.025}');
  await page.submit();
  assert.deepEqual(page.calls[0].body, { enable_h2h_api: '0', risk_weights: '{"injuries": 0.025}' });
  assert.equal(JSON.parse(page.node('risk_weights').value).injuries, 0.025);
});

test('native numeric constraints and invalid JSON block submission instead of false success', async () => {
  const page = makePage();
  await page.load();
  page.change('sync_days_ahead', '1.5');
  await page.submit();
  assert.equal(page.calls.length, 0);
  page.change('sync_days_ahead', '0');
  for (const value of ['{', '[]', 'null']) {
    page.change('confidence_weights', value);
    await page.submit();
    assert.equal(page.calls.length, 0);
    assert.equal(page.node('confidence_weights').attrs['aria-invalid'], 'true');
  }
  assert.match(page.nodes.get('#settingsMsg').textContent, /Nothing has been saved/);
});

test('a failed save keeps the draft and permits retry without claiming success', async () => {
  let fail = true;
  const page = makePage({ put: async (_url, body) => {
    if (fail) throw new Error('Database is unavailable');
    return { applied: Object.entries(body).map(([key, value]) => ({ key, value })), rejected: [] };
  } });
  await page.load();
  page.change('min_confidence', '81');
  await page.submit();
  assert.match(page.nodes.get('#settingsMsg').textContent, /Save failed: Database is unavailable/);
  assert.equal(page.node('min_confidence').value, '81');
  assert.equal(page.page.hasUnsavedChanges(), true);
  assert.equal(page.nodes.get('#settingsFields').disabled, false);
  fail = false;
  await page.submit();
  assert.equal(page.page.hasUnsavedChanges(), false);
});

test('double submit cannot send a second request while a save is in flight', async () => {
  let resolve;
  const page = makePage({ put: () => new Promise((done) => { resolve = done; }) });
  await page.load();
  page.change('site_name', 'Test branding');
  const first = page.submit();
  await page.submit();
  assert.equal(page.calls.length, 1);
  assert.equal(page.nodes.get('#settingsFields').disabled, true);
  assert.equal(page.nodes.get('#saveSettings').disabled, true);
  resolve({ applied: [{ key: 'site_name', value: 'Test branding' }], rejected: [] });
  await first;
  assert.equal(page.nodes.get('#settingsFields').disabled, false);
});

test('partial saves reconcile only applied fields; rejected drafts remain editable and are retried alone', async () => {
  let first = true;
  const page = makePage({ put: async (_url, body) => {
    if (first) {
      first = false;
      return { applied: [{ key: 'min_confidence', value: '80' }], rejected: [{ key: 'sync_timezone', reason: 'INVALID_TIMEZONE', message: 'Use a valid timezone.' }] };
    }
    return { applied: Object.entries(body).map(([key, value]) => ({ key, value })), rejected: [] };
  } });
  await page.load();
  page.change('min_confidence', '80');
  page.change('sync_timezone', 'Wrong/Zone');
  await page.submit();
  assert.equal(page.node('sync_timezone').value, 'Wrong/Zone');
  assert.match(page.nodes.get('#settingsMsg').textContent, /1 saved; 1 need attention/);
  assert.equal(page.node('sync_timezone').attrs['aria-invalid'], 'true');
  page.change('sync_timezone', 'Africa/Lagos');
  await page.submit();
  assert.deepEqual(page.calls[1].body, { sync_timezone: 'Africa/Lagos' });
  assert.equal(page.page.hasUnsavedChanges(), false);
});

test('server cross-field feedback clears when another dependent field is changed', async () => {
  const page = makePage({ put: async () => ({ applied: [], rejected: [{ key: 'min_selections', message: 'Invalid range' }, { key: 'max_selections', message: 'Invalid range' }] }) });
  await page.load();
  page.change('min_selections', '7');
  await page.submit();
  assert.equal(page.node('min_selections').customError, 'Invalid range');
  page.change('max_selections', '8');
  assert.equal(page.node('min_selections').customError, '', 'fixing the related field allows the next submit');
});

test('discard restores saved values and beforeunload protects unsaved drafts', async () => {
  const page = makePage();
  await page.load();
  page.change('max_risk', '33');
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  page.handlers.beforeunload(event);
  assert.equal(event.prevented, true);
  assert.equal(event.returnValue, '');
  page.nodes.get('#discardSettings').onclick();
  assert.equal(page.node('max_risk').value, '35');
  assert.equal(page.page.hasUnsavedChanges(), false);
});

test('legacy invalid settings can be repaired by saving the displayed safe defaults', async () => {
  const items = definitions.map((item) => item.key === 'sync_timezone' ? { ...item, needsRepair: true, warning: 'The stored timezone is invalid.' } : item);
  const page = makePage({ items });
  await page.load();
  assert.equal(page.page.hasUnsavedChanges(), true);
  await page.submit();
  assert.deepEqual(page.calls[0].body, { sync_timezone: 'UTC' });
  assert.equal(page.page.hasUnsavedChanges(), false);
});

test('a late settings response cannot replace the view after navigation', async () => {
  let resolve;
  const page = makePage({ get: () => new Promise((done) => { resolve = done; }) });
  const pending = page.load();
  page.leave();
  resolve({ items: definitions });
  await pending;
  assert.ok(!page.html.includes('settingsForm'));
});
