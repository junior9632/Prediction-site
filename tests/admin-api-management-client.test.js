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
function harness(responses = {}, { fetchImpl = null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
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
    nodes.clear(); // innerHTML replaces the DOM; old controls/feedback do not survive.
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
      requests.push({ path: pathname, method: options.method || 'GET', body: options.body, timeoutMs: options.timeoutMs });
      const key = `${options.method || 'GET'} ${pathname.split('?')[0]}`;
      const responder = responses[key];
      if (!responder) throw new Error(`unexpected request: ${key}`);
      return responder(options.body, options);
    },
    get(pathname, options = {}) {
      return api.request(pathname, options);
    },
    post(pathname, body, options = {}) {
      return api.request(pathname, { ...options, method: 'POST', body });
    },
    put(pathname, body, options = {}) {
      return api.request(pathname, { ...options, method: 'PUT', body });
    },
  };

  const window = { confirm: () => true, location: { href: '/admin#api-management' } };
  const ctx = {
    window,
    document,
    fetch: fetchImpl || (async () => {
      throw new Error('the admin view must use the shared API helper, never fetch directly');
    }),
    navigator: {},
    console,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    AbortController,
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
  const sharedApi = ctx.window.App.API;
  if (!fetchImpl) ctx.window.App.API = api;

  // capture alerts by wrapping the element innerHTML setter used by actionBox
  const helpers = {
    API: ctx.window.App.API,
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

  return { ctx, nodes, requests, helpers, sharedApi, view: ctx.window.AdminApiManagement, html: () => lastHtml, alerts };
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

test('API Management repair: a real DOM replacement does not erase save/test feedback', async () => {
  const h = harness({
    'GET /admin/api-management': () => STATUS_PAYLOAD,
    'PUT /admin/api-management/credentials': () => ({ maskedKey: '********7890', status: STATUS_PAYLOAD }),
    'POST /admin/api-management/test': () => ({ ok: true, state: 'CONNECTED', label: 'Connection successful', message: 'The provider accepted the credential.', latencyMs: 12 }),
  });
  await h.view.load(h.helpers);
  const oldBox = h.nodes.get('apiActionBox');
  h.nodes.get('apiKey').value = 'test-only-key-1234567890';
  await h.nodes.get('apiSaveBtn').onclick();
  assert.notEqual(h.nodes.get('apiActionBox'), oldBox, 'render replaces the DOM, just as innerHTML does in a browser');
  assert.match(h.nodes.get('apiActionBox').innerHTML, /API key saved/);
  await h.nodes.get('apiTestBtn').onclick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Connection successful/);
});

test('API Management repair: Test before Save preserves the typed key and chosen host', async () => {
  const h = harness({
    'GET /admin/api-management': () => STATUS_PAYLOAD,
    'POST /admin/api-management/test': () => ({ ok: false, state: 'INVALID_KEY', message: 'Not accepted', latencyMs: 9 }),
  });
  await h.view.load(h.helpers);
  const key = h.nodes.get('apiKey'); key.value = 'candidate-not-yet-saved';
  h.nodes.get('apiHost').value = 'api-football-v1.p.rapidapi.com/v3';
  await h.nodes.get('apiTestBtn').onclick();
  assert.equal(h.nodes.get('apiKey'), key, 'test does not rebuild the credential form');
  assert.equal(key.value, 'candidate-not-yet-saved');
  assert.equal(h.nodes.get('apiHost').value, 'api-football-v1.p.rapidapi.com/v3');
  assert.ok(!h.html().includes(key.value), 'the secret is never interpolated into HTML');
  assert.equal(h.view.hasUnsavedChanges(), true);
  assert.match(h.nodes.get('apiActionBox').innerHTML, /not been saved/);
});

test('API Management repair: all actions and inputs are disabled while a request runs', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const h = harness({ 'GET /admin/api-management': () => STATUS_PAYLOAD, 'POST /admin/api-management/test': () => pending });
  await h.view.load(h.helpers);
  const running = h.nodes.get('apiTestBtn').onclick();
  for (const id of ['apiSaveBtn', 'apiTestBtn', 'apiActivateBtn', 'apiDisableBtn', 'apiRefreshBtn', 'apiKey', 'apiHost']) assert.equal(h.nodes.get(id).disabled, true, id);
  await h.nodes.get('apiSaveBtn').onclick();
  assert.equal(h.requests.filter((r) => r.method === 'PUT').length, 0, 'a competing save cannot run');
  release({ ok: true, state: 'CONNECTED', message: 'accepted', latencyMs: 1 });
  await running;
  assert.equal(h.view.isBusy(), false);
  assert.equal(h.nodes.get('apiKey').disabled, false);
});

test('API Management repair: environment marketplace hosts are selected instead of the recommendation', async () => {
  const payload = structuredClone(STATUS_PAYLOAD);
  payload.credential = null;
  payload.environment = { keyConfigured: true, host: 'api-football-v1.p.rapidapi.com/v3', maskedKey: '********1234' };
  payload.credentialSource = 'environment';
  const h = harness({ 'GET /admin/api-management': () => payload });
  await h.view.load(h.helpers);
  assert.equal(h.nodes.get('apiHost').value, payload.environment.host);
});

test('API Management repair: Activate refuses an unsaved key or host draft', async () => {
  const h = harness({ 'GET /admin/api-management': () => STATUS_PAYLOAD });
  await h.view.load(h.helpers);
  h.nodes.get('apiKey').value = 'unsaved-test-only-key';
  await h.nodes.get('apiActivateBtn').onclick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Save the configuration first/);
  assert.equal(h.requests.filter((r) => r.method === 'POST').length, 0);
});

test('API Management repair: a late response cannot replace another dashboard view', async () => {
  let finish;
  let visible = true;
  const pending = new Promise((resolve) => { finish = resolve; });
  const h = harness({ 'GET /admin/api-management': () => pending });
  const loading = h.view.load({ ...h.helpers, isCurrent: () => visible });
  visible = false;
  h.helpers.render('<div>Another dashboard view</div>');
  finish(STATUS_PAYLOAD);
  await loading;
  assert.equal(h.html(), '<div>Another dashboard view</div>');
});

test('API Management repair: refresh failures preserve the test verdict and the unsaved key', async () => {
  let reads = 0;
  const h = harness({
    'GET /admin/api-management': () => { if (++reads > 1) throw new Error('status temporarily unavailable'); return STATUS_PAYLOAD; },
    'POST /admin/api-management/test': () => ({ ok: true, label: 'Connection successful', message: 'accepted', latencyMs: 1 }),
  });
  await h.view.load(h.helpers);
  h.nodes.get('apiKey').value = 'unsaved-test-only-key';
  await h.nodes.get('apiTestBtn').onclick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Connection successful/);
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Status refresh failed/);
  assert.equal(h.nodes.get('apiKey').value, 'unsaved-test-only-key');
});

test('API Management repair: schema/encryption failures explain the blocked save on click', async () => {
  const payload = structuredClone(STATUS_PAYLOAD);
  payload.databaseManaged = false; payload.degradedReason = 'SCHEMA_OUT_OF_DATE';
  payload.encryption.configured = false;
  const h = harness({ 'GET /admin/api-management': () => payload });
  await h.view.load(h.helpers);
  assert.equal(h.nodes.get('apiSaveBtn').disabled, false, 'a prerequisite failure is not a dead button');
  assert.equal(h.nodes.get('apiTestBtn').disabled, false);
  await h.nodes.get('apiSaveBtn').onclick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Credential storage needs attention/);
  assert.match(h.nodes.get('apiActionBox').innerHTML, /npm run db:migrate/);
  assert.equal(h.requests.filter((r) => r.method !== 'GET').length, 0, 'no unsafe save is submitted');
  assert.match(h.html(), /npm run db:migrate/);
});

/** A complete, credential-free storage report for the view tests. */
function storageReport(overrides = {}) {
  return {
    readOnly: true,
    state: 'READY',
    ready: true,
    degraded: false,
    canRead: true,
    canSave: true,
    summary: 'Credential storage is ready: the database tables are present and the encryption key is usable.',
    checkedAt: '2026-10-16T09:20:00.000Z',
    database: { reachable: true, code: null, driverCode: null, message: 'Database connection is available.' },
    schema: { checked: true, ready: true, source: 'information_schema', missingTables: [], missingColumns: [], migration: { required: false, file: '003-api-credential-management.sql', applied: true } },
    permissions: { checked: true, select: true, insert: true, update: true, delete: true, all: false, message: null },
    credentials: { readable: true, count: 1, error: null },
    history: { ready: true, eventsReadable: true, syncsReadable: true, error: null },
    encryption: { state: 'ENV_READY', configured: true, pending: false, canEncrypt: true, canDecrypt: true, source: 'env', keyEnvVar: 'API_CREDENTIALS_ENCRYPTION_KEY', keyPath: null, message: 'set' },
    issues: [],
    ...overrides,
  };
}

test('API Management repair: credential storage is a separate, explicit readiness panel', async () => {
  const payload = structuredClone(STATUS_PAYLOAD);
  payload.storage = storageReport();
  const h = harness({ 'GET /admin/api-management': () => payload });
  await h.view.load(h.helpers);

  assert.match(h.html(), /Credential storage — admin-only read-only check/);
  assert.match(h.html(), /READY/);
  assert.match(h.html(), /a provider connection test does not change this/);
  assert.equal(h.nodes.get('apiSaveBtn').disabled, false, 'ready storage allows saving');
  assert.match(h.html(), /CONNECTED/, 'the provider connection remains visible on its own');
});

test('API Management repair: schema storage failure names the migration and blocks unsafe saving', async () => {
  const payload = structuredClone(STATUS_PAYLOAD);
  payload.databaseManaged = false;
  payload.degradedReason = 'SCHEMA_OUT_OF_DATE';
  payload.storage = storageReport({
    state: 'SCHEMA_OUT_OF_DATE',
    ready: false,
    degraded: true,
    canRead: false,
    canSave: false,
    summary: 'Credential storage is unavailable: the database is missing migration 003-api-credential-management.sql.',
    schema: {
      checked: true, ready: false, source: 'information_schema',
      missingTables: ['api_credentials', 'api_connection_events'], missingColumns: [],
      migration: { required: true, file: '003-api-credential-management.sql', applied: false },
    },
    issues: [{
      area: 'schema',
      code: 'SCHEMA_OUT_OF_DATE',
      message: 'Missing credential-storage objects: api_credentials, api_connection_events.',
      fix: 'Apply 003-api-credential-management.sql with npm run db:migrate, or paste it into phpMyAdmin.',
    }],
  });
  const h = harness({ 'GET /admin/api-management': () => payload });
  await h.view.load(h.helpers);

  assert.equal(h.nodes.get('apiSaveBtn').disabled, false, 'clicking explains the prerequisite');
  assert.equal(h.nodes.get('apiTestBtn').disabled, false, 'provider testing stays available');
  h.nodes.get('apiKey').value = 'unsaved-test-only-key';
  await h.nodes.get('apiSaveBtn').onclick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /003-api-credential-management\.sql/);
  assert.match(h.nodes.get('apiSaveBtn').title, /npm run db:migrate/);
  assert.match(h.nodes.get('apiControlHint').textContent, /Credential storage needs attention/);
  assert.equal(h.nodes.get('apiKey').value, 'unsaved-test-only-key');
  assert.equal(h.requests.filter((r) => r.method === 'PUT').length, 0, 'storage protection is not bypassed');
  assert.match(h.html(), /003-api-credential-management\.sql/);
  assert.match(h.html(), /npm run db:migrate/);
  assert.match(h.html(), /does not prove that a key can be stored/);
});

test('API Management repair: a history-only failure does not claim storage is unavailable', async () => {
  const payload = structuredClone(STATUS_PAYLOAD);
  payload.degradedReason = 'HISTORY_UNAVAILABLE';
  payload.storage = storageReport({
    state: 'HISTORY_DEGRADED',
    ready: false,
    degraded: true,
    summary: 'Credential storage is ready; only the diagnostics history is unavailable.',
    history: { ready: false, eventsReadable: false, syncsReadable: false, error: 'SCHEMA_OUT_OF_DATE' },
    issues: [{ area: 'history', code: 'SCHEMA_OUT_OF_DATE', message: 'History queries fail.', fix: 'Saving a credential is not blocked by this.' }],
  });
  const h = harness({ 'GET /admin/api-management': () => payload });
  await h.view.load(h.helpers);

  assert.equal(h.nodes.get('apiSaveBtn').disabled, false, 'history is not a save blocker');
  assert.match(h.html(), /only the diagnostics history is unavailable/);
  assert.doesNotMatch(h.html(), /Credential storage is unavailable\. Ask the host/);
});

test('API Management: unsaved Activate/Disable buttons explain the next step instead of being dead', async () => {
  const payload = structuredClone(STATUS_PAYLOAD);
  payload.credential = null;
  payload.credentialSource = 'none';
  const h = harness({ 'GET /admin/api-management': () => payload });
  await h.view.load(h.helpers);
  assert.equal(h.nodes.get('apiActivateBtn').disabled, false);
  assert.equal(h.nodes.get('apiDisableBtn').disabled, false);
  await h.nodes.get('apiActivateBtn').onclick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Save the configuration first/);
  await h.nodes.get('apiDisableBtn').onclick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /No saved credential to disable/);
  assert.equal(h.requests.filter((r) => r.method !== 'GET').length, 0, 'prerequisites remain enforced');
});

test('API Management: subscription failure leaves the form editable and Test clickable again', async () => {
  let attempts = 0;
  const h = harness({
    'GET /admin/api-management': () => STATUS_PAYLOAD,
    'POST /admin/api-management/test': () => {
      attempts += 1;
      return { ok: false, state: 'SUBSCRIPTION_INACTIVE', label: 'API subscription required or inactive',
        message: 'You are not subscribed to this API.', hint: 'Subscribe using the same account/app as the key.',
        httpStatus: 403, latencyMs: 390 };
    },
  });
  await h.view.load(h.helpers);
  h.nodes.get('apiKey').value = 'unsaved-test-only-key';
  await h.nodes.get('apiTestBtn').onclick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /You are not subscribed/);
  assert.match(h.nodes.get('apiActionBox').innerHTML, /HTTP 403/);
  assert.doesNotMatch(h.nodes.get('apiActionBox').innerHTML, /Invalid API key/);
  for (const id of ['apiTestBtn', 'apiRefreshBtn', 'apiHost', 'apiKey', 'apiSaveBtn']) assert.equal(h.nodes.get(id).disabled, false, id);
  await h.nodes.get('apiTestBtn').onclick();
  assert.equal(attempts, 2, 'a second click actually runs a test');
  assert.equal(h.nodes.get('apiKey').value, 'unsaved-test-only-key');
  assert.ok(h.requests.every((r) => r.timeoutMs === 45000), 'initial load, tests and status refreshes are all bounded');
});

test('API Management: account/subscription help follows the selected host without switching it automatically', async () => {
  const payload = structuredClone(STATUS_PAYLOAD);
  payload.providers = require('../server/services/apiProviders').list();
  const h = harness({ 'GET /admin/api-management': () => payload });
  await h.view.load(h.helpers);
  assert.match(h.html(), /Manage API account \/ subscription/);
  assert.match(h.html(), /https:\/\/dashboard\.api-football\.com\//);
  h.nodes.get('apiHost').value = 'api-football-v1.p.rapidapi.com/v3';
  h.nodes.get('apiHost').onchange();
  assert.match(h.nodes.get('apiHostHelp').innerHTML, /same account\/app/);
  assert.match(h.nodes.get('apiHostHelp').innerHTML, /https:\/\/rapidapi\.com\/api-sports\/api\/api-football\/pricing/);
  assert.match(h.nodes.get('apiHostHelp').innerHTML, /rel="noopener noreferrer"/);
  assert.equal(h.requests.length, 1, 'selecting a host never sends a secret or changes the saved credential');
});

/** Drive the real shared HTTP helper without waiting 45 wall-clock seconds. */
function manualTimers() {
  const timers = new Map();
  let nextId = 0;
  return {
    timers,
    setTimer(fn, ms) { const id = ++nextId; timers.set(id, { fn, ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    expire() {
      assert.equal(timers.size, 1, 'one request deadline is pending');
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.ms, 45000);
      timers.delete(id);
      timer.fn();
    },
  };
}

function waitForAbort(signal) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
const jsonReply = (data) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });

test('API Management: a stalled real HTTP request times out, unlocks the buttons, and can be retried', async () => {
  const clock = manualTimers();
  let attempts = 0;
  let testSignal;
  const h = harness({}, { ...clock, fetchImpl: async (url, options) => {
    if (url === '/api/admin/api-management') return jsonReply(STATUS_PAYLOAD);
    assert.equal(url, '/api/admin/api-management/test');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-CSRF-Token'], 'csrf-token-abc');
    assert.equal(options.credentials, 'same-origin');
    attempts += 1;
    testSignal = options.signal;
    if (attempts === 1) return waitForAbort(options.signal);
    return jsonReply({ ok: true, label: 'Connection successful', message: 'Accepted', latencyMs: 1 });
  } });
  await h.view.load(h.helpers);
  assert.equal(clock.timers.size, 0, 'a completed load clears its deadline');
  h.nodes.get('apiKey').value = 'unsaved-test-only-key';
  const running = h.nodes.get('apiTestBtn').onclick();
  assert.equal(h.nodes.get('apiTestBtn').disabled, true);
  clock.expire();
  await running;
  assert.equal(testSignal.aborted, true, 'the browser request is actually aborted');
  assert.equal(h.view.isBusy(), false);
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Request timed out/);
  for (const id of ['apiTestBtn', 'apiRefreshBtn', 'apiHost', 'apiKey', 'apiSaveBtn']) assert.equal(h.nodes.get(id).disabled, false, id);
  assert.equal(h.nodes.get('apiKey').value, 'unsaved-test-only-key', 'timeout does not erase the draft');
  await h.nodes.get('apiTestBtn').onclick();
  assert.equal(attempts, 2);
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Connection successful/);
  await tick();
  assert.equal(clock.timers.size, 0, 'successful retry and its refresh both clear their deadlines');
});

test('API Management: a stalled status refresh cannot lock the form after a provider 403', async () => {
  const clock = manualTimers();
  let reads = 0;
  const h = harness({}, { ...clock, fetchImpl: async (url, options) => {
    if (url === '/api/admin/api-management') return ++reads === 1 ? jsonReply(STATUS_PAYLOAD) : waitForAbort(options.signal);
    assert.equal(url, '/api/admin/api-management/test');
    return jsonReply({ ok: false, state: 'SUBSCRIPTION_INACTIVE', label: 'API subscription required or inactive',
      message: 'You are not subscribed to this API.', httpStatus: 403, latencyMs: 390 });
  } });
  await h.view.load(h.helpers);
  h.nodes.get('apiKey').value = 'unsaved-test-only-key';
  const running = h.nodes.get('apiTestBtn').onclick();
  await tick(); // the verdict is already displayed; the follow-up GET is pending
  assert.match(h.nodes.get('apiActionBox').innerHTML, /You are not subscribed/);
  assert.equal(h.nodes.get('apiTestBtn').disabled, false, 'a background diagnostics read does not lock the form');
  await running;
  clock.expire();
  await tick();
  assert.match(h.nodes.get('apiActionBox').innerHTML, /You are not subscribed/);
  assert.match(h.nodes.get('apiActionBox').innerHTML, /Status refresh failed: Request timed out/);
  assert.equal(h.nodes.get('apiKey').value, 'unsaved-test-only-key');
  assert.equal(h.nodes.get('apiTestBtn').disabled, false);
  assert.equal(h.view.isBusy(), false);
});

test('shared HTTP helper: PUT deadlines cover a stalled JSON body, not just response headers', async () => {
  const clock = manualTimers();
  let signal;
  const h = harness({}, { ...clock, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 200, json: () => waitForAbort(signal) };
  } });
  const pending = h.sharedApi.put('/admin/api-management/credentials', { key: 'test-only-key' }, { timeoutMs: 45000 });
  await tick();
  clock.expire();
  await assert.rejects(pending, (err) => err.code === 'REQUEST_TIMEOUT' && /server may still finish/.test(err.message));
  assert.equal(signal.aborted, true);
  assert.equal(clock.timers.size, 0);
});

test('shared HTTP helper: adding a deadline preserves caller cancellation and server errors', async () => {
  const clock = manualTimers();
  const h = harness({}, { ...clock, fetchImpl: async (_url, options) => waitForAbort(options.signal) });
  const controller = new AbortController();
  const pending = h.sharedApi.get('/admin/api-management', { timeoutMs: 45000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError' && err.code !== 'REQUEST_TIMEOUT');
  assert.equal(clock.timers.size, 0);

  h.ctx.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'CSRF_INVALID', message: 'Invalid CSRF token' } }) });
  await assert.rejects(h.sharedApi.post('/admin/api-management/test', {}, { timeoutMs: 45000 }),
    (err) => err.code === 'CSRF_INVALID' && err.status === 403);
  assert.equal(clock.timers.size, 0, 'server errors also release their timer');
});

test('API Management: a late background status read cannot overwrite a newer save', async () => {
  let finish;
  let reads = 0;
  const staleStatus = new Promise((resolve) => { finish = resolve; });
  const saved = structuredClone(STATUS_PAYLOAD);
  saved.credential.host = 'api-football-v1.p.rapidapi.com/v3';
  saved.connection.host = saved.credential.host;
  const h = harness({
    'GET /admin/api-management': () => ++reads === 1 ? STATUS_PAYLOAD : staleStatus,
    'POST /admin/api-management/test': () => ({ ok: false, state: 'SUBSCRIPTION_INACTIVE', message: 'Not subscribed', latencyMs: 1 }),
    'PUT /admin/api-management/credentials': () => ({ maskedKey: '********1234', status: saved }),
    'POST /admin/api-management/activate': () => ({ status: saved }),
  });
  await h.view.load(h.helpers);
  await h.nodes.get('apiTestBtn').onclick();
  assert.equal(h.view.isBusy(), false, 'the test is finished even though diagnostics are still pending');
  h.nodes.get('apiKey').value = 'replacement-test-only-key';
  h.nodes.get('apiHost').value = saved.credential.host;
  await h.nodes.get('apiSaveBtn').onclick();
  assert.equal(h.nodes.get('apiHost').value, saved.credential.host);
  finish(STATUS_PAYLOAD); // the old, direct-host diagnostics finally arrive
  await tick();
  await h.nodes.get('apiActivateBtn').onclick();
  assert.equal(h.requests.filter((r) => r.path === '/admin/api-management/activate').length, 1,
    'activation sees the new saved host, not the stale background response');
});
