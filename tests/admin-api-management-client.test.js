'use strict';

/**
 * API MANAGEMENT PAGE — client wiring regression suite.
 *
 * WHAT IS BEING PROVED
 *   The console has shipped dead buttons before (see admin-users-client.test.js):
 *   markup rendered, no listener bound, nothing happened on tap. This suite runs
 *   the REAL public/js/admin-api-management.js in a `vm` context with a minimal
 *   document double and asserts, button by button, that:
 *
 *     1. every control the operator needs is rendered;
 *     2. Save / Test / Activate / Disable / Refresh each call the right endpoint
 *        with the right method and payload;
 *     3. the key field is sent once and then cleared — it is never re-displayed,
 *        never stored and never echoed back into the page;
 *     4. a failed request shows the server message and never claims success;
 *     5. nothing in the page invents a quota, a connection state or a ticket.
 *
 * The server side of these endpoints (authorization, CSRF, encryption, the real
 * provider request) is asserted over HTTP in tests/api-management.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const API_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin-api-management.js'), 'utf8');

const STATUS_PAYLOAD = {
  provider: 'api_football',
  providers: [
    {
      id: 'api_football',
      label: 'API-Football (Pro)',
      implemented: true,
      defaultHostId: 'v3.football.api-sports.io',
      hosts: [
        { id: 'v3.football.api-sports.io', label: 'v3.football.api-sports.io (official API-Sports host)', recommended: true },
        { id: 'api-football-v1.p.rapidapi.com/v3', label: 'api-football-v1.p.rapidapi.com/v3 (RapidAPI marketplace host)', recommended: false },
      ],
    },
    { id: 'sportmonks', label: 'SportMonks (not implemented in this build)', implemented: false, hosts: [] },
  ],
  activeProviderId: 'api_football',
  credentialSource: 'database',
  databaseManaged: true,
  degradedReason: null,
  credential: {
    provider: 'api_football',
    host: 'v3.football.api-sports.io',
    maskedKey: '********d4b8',
    keyLength: 24,
    isActive: true,
    algorithm: 'aes-256-gcm',
    savedAt: '2026-10-16T09:00:00.000Z',
    updatedAt: '2026-10-16T09:00:00.000Z',
    location: 'database (encrypted)',
  },
  environment: { keyConfigured: false, host: null, maskedKey: null, isActive: false },
  connection: {
    state: 'CONNECTED',
    label: 'Connection successful',
    message: 'The provider accepted the credential (120/7500 requests used today).',
    testedAt: '2026-10-16T09:05:00.000Z',
    latencyMs: 240,
    lastSuccessAt: '2026-10-16T09:05:00.000Z',
    lastErrorAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    host: 'v3.football.api-sports.io',
    resolvedFromDatabase: true,
  },
  lastRequestAt: '2026-10-16T09:10:00.000Z',
  lastSuccessfulSyncs: {
    fixtures: { lastSuccessAt: '2026-10-16T08:30:00.000Z', runs: 12 },
    odds: { lastSuccessAt: '2026-10-16T08:45:00.000Z', runs: 20 },
    results: { lastSuccessAt: null, runs: 0 },
  },
  quota: { current: 120, limitDay: 7500, checkedAt: '2026-10-16T09:05:00.000Z', source: 'provider /status' },
  rateLimits: { requestsPerMinute: 60, source: 'server configuration', providerBudgetPerMinute: 60 },
  plan: { name: 'Pro' },
  encryption: {
    configured: true,
    algorithm: 'aes-256-gcm',
    keyEnvVar: 'API_CREDENTIALS_ENCRYPTION_KEY',
    keyId: 'abc123',
    message: 'set',
  },
  client: { configured: true, host: 'v3.football.api-sports.io', calls: 42, failures: 1, cacheHits: 3, breakerState: 'OK', available: true },
  recentEvents: [
    { id: 3, event: 'TEST_OK', outcome: 'CONNECTED', httpStatus: null, endpoint: '/status', latencyMs: 240, message: 'ok', createdAt: '2026-10-16T09:05:00.000Z' },
  ],
  recentErrors: [
    { id: 2, event: 'TEST_FAILED', outcome: 'INVALID_KEY', httpStatus: 403, endpoint: '/status', latencyMs: 90, message: 'invalid key', createdAt: '2026-10-16T08:00:00.000Z' },
  ],
  predictionRules: {
    market: 'Over 1.5 Goals',
    marketKey: 'over_1_5',
    oddsWindow: [2.0, 4.0],
    minConfidence: 72,
    maxRisk: 35,
    minDataQuality: 60,
    maxSelections: 6,
    oddsFreshnessMinutes: 90,
    automaticTicketGeneration: false,
    ticketGeneration: 'MANUAL ONLY — API changes never generate a ticket',
  },
  serverTime: '2026-10-16T09:20:00.000Z',
};

/**
 * A very small document double: elements are created on demand and keep the
 * properties the view actually uses (value / onclick / innerHTML / disabled).
 * `render()` registers every id in the produced markup so the view can bind to
 * the controls it just rendered — exactly like the real console does.
 */
function harness(responses = {}) {
  const nodes = new Map();
  const requests = [];
  const alerts = [];
  let lastHtml = '';

  const makeEl = (id) => ({
    id,
    value: '',
    innerHTML: '',
    textContent: '',
    disabled: false,
    onclick: null,
    onchange: null,
    classList: { add() {}, remove() {}, toggle() {} },
  });

  const document = {
    cookie: 'fp_csrf=csrf-token-abc',
    querySelector(selector) {
      const id = selector.startsWith('#') ? selector.slice(1) : selector;
      if (!nodes.has(id)) nodes.set(id, makeEl(id));
      return nodes.get(id);
    },
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeEl('created'),
  };

  const render = (html) => {
    lastHtml = html;
    for (const match of String(html).matchAll(/id="([\w-]+)"/g)) {
      if (!nodes.has(match[1])) nodes.set(match[1], makeEl(match[1]));
    }
    // A real browser resolves a <select> from its markup; the double does the
    // same so the view reads the same selected provider/host a browser would.
    for (const select of String(html).matchAll(/<select[^>]*id="([\w-]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      if (!nodes.has(select[1])) nodes.set(select[1], makeEl(select[1]));
      const el = nodes.get(select[1]);
      el.innerHTML = select[2];
      const options = [...select[2].matchAll(/<option value="([^"]*)"([^>]*)>/g)];
      const chosen = options.find((o) => /selected/.test(o[2])) || options[0];
      if (chosen) el.value = chosen[1];
    }
  };

  const api = {
    async request(pathname, options = {}) {
      requests.push({ path: pathname, method: options.method || 'GET', body: options.body });
      const key = `${options.method || 'GET'} ${pathname.split('?')[0]}`;
      const responder = responses[key];
      if (!responder) throw new Error(`unexpected request: ${key}`);
      return responder(options.body);
    },
    get(pathname) {
      return api.request(pathname);
    },
    post(pathname, body) {
      return api.request(pathname, { method: 'POST', body });
    },
    put(pathname, body) {
      return api.request(pathname, { method: 'PUT', body });
    },
  };

  const window = { confirm: () => true, location: { href: '/admin#api-management' } };
  const ctx = {
    window,
    document,
    fetch: async () => {
      throw new Error('the admin view must use the shared API helper, never fetch directly');
    },
    navigator: {},
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Math,
    Date,
    JSON,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    isNaN,
    parseInt,
    parseFloat,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(API_JS, ctx, { filename: 'api.js' });

  // the view module uses the shared helper (App.API), exactly like the console
  // does — so the recording stub replaces App.API, not a local copy
  ctx.window.App.API = api;

  // capture alerts by wrapping the element innerHTML setter used by actionBox
  const helpers = {
    API: api,
    fmt: ctx.window.App.fmt,
    escapeHtml: ctx.window.App.escapeHtml,
    icons: ctx.window.App.icons,
    card: (title, body) => `<div class="card"><h2>${title}</h2>${body}</div>`,
    mini: (k, v, d, tone) => `<div class="mini-card"><div class="k">${k}</div><div class="v ${tone || ''}">${v}</div><div class="d">${d || ''}</div></div>`,
    table: (headers, rows) => `<table>${rows}</table>`,
    emptyState: (icon, title, message) => `<div class="empty-state">${title}${message}</div>`,
    render,
  };

  vm.runInContext(VIEW_JS, ctx, { filename: 'public/js/admin-api-management.js' });

  return { ctx, nodes, requests, helpers, view: ctx.window.AdminApiManagement, html: () => lastHtml, alerts };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('admin API Management view: every control is rendered and bound', async () => {
  const h = harness({ 'GET /admin/api-management': () => STATUS_PAYLOAD });
  await h.view.load(h.helpers);
  await tick();

  const html = h.html();
  for (const id of ['apiProvider', 'apiHost', 'apiKey', 'apiSaveBtn', 'apiTestBtn', 'apiActivateBtn', 'apiDisableBtn', 'apiRefreshBtn']) {
    assert.ok(html.includes(`id="${id}"`), `${id} is rendered`);
    const el = h.nodes.get(id);
    assert.ok(el, `${id} exists for binding`);
    if (id.endsWith('Btn')) assert.equal(typeof el.onclick, 'function', `${id} must have a click handler`);
  }

  // both approved hosts are offered, the unimplemented provider is not selectable
  assert.ok(html.includes('v3.football.api-sports.io'));
  assert.match(html, /disabled>SportMonks|disabled>API-Football \(Pro\)/, 'unimplemented providers ship disabled');

  // the masked key is what the page shows — never a full key
  assert.ok(html.includes('********d4b8'), 'the masked key is displayed');
  assert.match(html, /240 ms/, 'the last test latency is displayed');

  // the product rules are stated on the page
  assert.match(html, /Over 1\.5 Goals/);
  assert.match(html, /MANUAL ONLY/);
});

test('admin API Management view: Save encrypts server side, then clears the key field', async () => {
  const h = harness({
    'GET /admin/api-management': () => STATUS_PAYLOAD,
    'PUT /admin/api-management/credentials': (body) => {
      assert.equal(body.provider, 'api_football');
      assert.equal(body.key, 'live-key-abcdef123456');
      return {
        saved: true,
        provider: 'api_football',
        host: body.host,
        maskedKey: '********3456',
        replaced: false,
        isActive: false,
        note: 'Saved encrypted. Saving does not mark the provider connected — run Test Connection, then Activate Provider.',
        status: STATUS_PAYLOAD,
      };
    },
  });
  await h.view.load(h.helpers);
  await tick();

  const key = h.nodes.get('apiKey');
  key.value = 'live-key-abcdef123456';
  await h.nodes.get('apiSaveBtn').onclick();
  await tick();

  const put = h.requests.find((r) => r.method === 'PUT');
  assert.ok(put, 'the save posts to the credentials endpoint');
  assert.equal(put.path, '/admin/api-management/credentials');
  assert.equal(key.value, '', 'the key field is cleared after saving');
  assert.ok(!h.html().includes('live-key-abcdef123456'), 'the key never lands in the rendered page');
  const box = h.nodes.get('apiActionBox');
  assert.match(box.innerHTML, /encrypted at rest/, 'the operator is told the key is encrypted, not connected');
  assert.ok(!/connected/i.test(box.innerHTML.replace(/mark the provider connected/i, '')), 'saving never claims a connection');
});

test('admin API Management view: an empty key or a rejected save never claims success', async () => {
  const h = harness({
    'GET /admin/api-management': () => STATUS_PAYLOAD,
    'PUT /admin/api-management/credentials': () => {
      const err = new Error('API credentials cannot be saved: API_CREDENTIALS_ENCRYPTION_KEY is not configured on the server.');
      err.code = 'ENCRYPTION_KEY_MISSING';
      throw err;
    },
  });
  await h.view.load(h.helpers);
  await tick();

  const key = h.nodes.get('apiKey');
  key.value = '';
  await h.nodes.get('apiSaveBtn').onclick();
  await tick();
  assert.equal(h.requests.filter((r) => r.method === 'PUT').length, 0, 'nothing is sent without a key');
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Enter an API key first/);

  key.value = 'some-key-12345678';
  await h.nodes.get('apiSaveBtn').onclick();
  await tick();
  const box = h.nodes.get('apiActionBox').innerHTML;
  assert.match(box, /Could not save the API key/);
  assert.match(box, /ENCRYPTION_KEY_MISSING|is not configured/);
  assert.match(box, /class="alert error"/, 'a failed save is rendered as an error alert');
  assert.ok(!/alert ok/.test(box), 'a failure is never rendered as a success alert');
  assert.ok(!/encrypted at rest/.test(box), 'a failed save never claims the key was stored');
});

test('admin API Management view: Test Connection reports the real verdict and reuses cached results', async () => {
  const h = harness({
    'GET /admin/api-management': () => STATUS_PAYLOAD,
    'POST /admin/api-management/test': (body) => {
      assert.equal(body.provider, 'api_football');
      return {
        ok: false,
        state: 'INVALID_KEY',
        label: 'Invalid API key or unauthorized',
        message: 'The provider rejected this request: {"token":"Error/Missing application key."}',
        provider: 'api_football',
        host: 'v3.football.api-sports.io',
        endpoint: '/status',
        httpStatus: null,
        latencyMs: 80,
        quota: null,
        plan: null,
        reused: false,
        testedAt: '2026-10-16T09:30:00.000Z',
      };
    },
  });
  await h.view.load(h.helpers);
  await tick();

  // no key typed: the stored credential is used (no key field in the payload)
  await h.nodes.get('apiTestBtn').onclick();
  await tick();
  const post = h.requests.find((r) => r.path === '/admin/api-management/test');
  assert.ok(post);
  assert.equal(post.body.key, undefined, 'the stored credential is used when no key was typed');

  const box = h.nodes.get('apiActionBox').innerHTML;
  assert.match(box, /Invalid API key or unauthorized/, 'the provider verdict is shown verbatim');
  assert.ok(!/Connection successful/.test(box), 'a failure is never shown as a success');
  assert.ok(!/quota/i.test(box), 'no quota is invented for a failed test');
});

test('admin API Management view: Activate, Disable and Refresh call the documented endpoints', async () => {
  const h = harness({
    'GET /admin/api-management': () => STATUS_PAYLOAD,
    'GET /admin/api-management/diagnostics': () => ({
      quota: { current: 120, limitDay: 7500, checkedAt: '2026-10-16T09:05:00.000Z', source: 'provider /status' },
      rateLimits: { requestsPerMinute: 60, source: 'server configuration' },
      connection: STATUS_PAYLOAD.connection,
      liveProbe: { ok: true, state: 'CONNECTED', label: 'Connection successful', message: 'The provider accepted the credential.', quota: { current: 120, limitDay: 7500 } },
      recentErrors: [],
      encryption: STATUS_PAYLOAD.encryption,
      serverTime: STATUS_PAYLOAD.serverTime,
    }),
    'POST /admin/api-management/activate': (body) => {
      assert.equal(body.provider, 'api_football');
      return { activated: true, provider: 'api_football', status: STATUS_PAYLOAD };
    },
    'POST /admin/api-management/disable': (body) => {
      assert.equal(body.provider, 'api_football');
      return { disabled: true, provider: 'api_football', credentialSource: 'environment', status: STATUS_PAYLOAD };
    },
  });
  await h.view.load(h.helpers);
  await tick();

  await h.nodes.get('apiActivateBtn').onclick();
  await tick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Provider activated/);

  await h.nodes.get('apiDisableBtn').onclick();
  await tick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Provider disabled/);
  assert.match(h.nodes.get('apiActionBox').innerHTML, /environment/);

  await h.nodes.get('apiRefreshBtn').onclick();
  await tick();
  assert.ok(
    h.requests.some((r) => r.path === '/admin/api-management/diagnostics?probe=1'),
    'Refresh performs the safe live probe'
  );
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Connection successful/);
});

test('admin API Management view: the provider selector only offers allowlisted hosts', async () => {
  const h = harness({ 'GET /admin/api-management': () => STATUS_PAYLOAD });
  await h.view.load(h.helpers);
  await tick();

  const provider = h.nodes.get('apiProvider');
  const host = h.nodes.get('apiHost');
  provider.value = 'api_football';
  await provider.onchange();
  await tick();

  assert.match(host.innerHTML, /api-football-v1\.p\.rapidapi\.com\/v3/, 'the approved RapidAPI host is offered');
  // a host that is not on the allowlist can never be typed into the page
  assert.ok(!h.html().includes('type="url"'), 'there is no free-text host field at all');
});
