'use strict';

/**
 * HTTP ACCEPTANCE TESTS — criteria 6, 7, 9 plus the security rules:
 *  - the server boots and serves the vanilla frontend
 *  - a client can never post odds, picks, totals or results (they are ignored)
 *  - generation over HTTP without a data source produces no ticket
 *  - admin routes need a real administrator + CSRF for cookie sessions
 *  - no secret, key or upstream host ever appears in a public asset
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'http-test-secret-please-change-in-production';
delete process.env.API_FOOTBALL_KEY;
delete process.env.API_FOOTBALL_HOST;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fakeDb = require('./fakeDb');
const { buildScenario, FakeApi, todayUtc } = require('./synthetic');

const auth = require('../server/middleware/auth');
const settingsService = require('../server/services/settingsService');
const ticketService = require('../server/services/ticketService');
const { createApp, PUBLIC_DIR } = require('../server/app');

const ADMIN = { id: 1, email: 'admin@test.local', username: 'admin', password_hash: 'x', role: 'superadmin', is_active: 1, locked_until: null, must_change_password: 0 };

let server;
let base;
let ctx;
let scn;
let bearer;
let ticketDate;
let otherDate;

async function waitForRun(runId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let progress = await ticketService.getGenerationProgress(runId);
  while (progress && progress.status === 'RUNNING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    progress = await ticketService.getGenerationProgress(runId);
  }
  return progress;
}

async function req(method, urlPath, { token = null, cookie = null, csrf = null, body = null } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (body !== null) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const get = (urlPath, options) => req('GET', urlPath, options);
const post = (urlPath, body, options) => req('POST', urlPath, { ...options, body });
const put = (urlPath, body, options) => req('PUT', urlPath, { ...options, body });

before(async () => {
  scn = buildScenario({ oddsValues: ['1.28', '1.30', '1.32'] });
  ticketDate = scn.ticketDate;
  otherDate = new Date(new Date(`${ticketDate}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);

  ctx = fakeDb.install({
    admins: [ADMIN],
    settings: [],
    fixtures: scn.fixtures,
    teamForms: scn.teamForms,
    leagues: scn.leagueEnvs,
  });
  settingsService.invalidateCache();

  // seed one real qualified ticket through the service layer so the public
  // endpoints have honest data to serve
  const started = await ticketService.startGeneration({
    adminId: ADMIN.id,
    source: 'admin_ui',
    date: ticketDate,
    api: new FakeApi(scn),
  });
  const progress = await waitForRun(started.runId);
  assert.equal(progress.status, 'QUALIFIED', String(progress.error || ''));

  bearer = auth.signToken({ sub: ADMIN.id, type: 'admin', role: ADMIN.role, username: ADMIN.username });

  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (ctx) ctx.restore();
  settingsService.invalidateCache();
});

/* ------------------------------------------------------------------ */
/* Acceptance 6 — the client can never supply odds, picks or results    */
/* ------------------------------------------------------------------ */

test('acceptance 6: forged odds, picks and totals in the request body are ignored', async () => {
  const forged = {
    date: otherDate,
    odds: '9.99',
    totalOdds: '9.99',
    totalOddsDisplay: '9.99',
    selections: [
      { fixtureId: 4242, odds: '9.99', marketLabel: 'Over 2.5 Goals', confidence: 100, result: 'WON' },
      { fixtureId: 4243, odds: '8.50', marketLabel: 'Correct Score', confidence: 100 },
    ],
    selectionCount: 2,
    status: 'QUALIFIED',
    result: 'WON',
    settledOdds: '99.00',
    confidence: 100,
    marketKey: 'over_2_5',
    bookmakerName: 'Invented Bookmaker',
  };

  const res = await post('/api/admin/generate-ticket', forged, { token: bearer });
  assert.equal(res.status, 202);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.data.ticketDate, otherDate);
  assert.ok(res.json.data.runId);
  for (const field of ['odds', 'totalOdds', 'selections', 'status', 'result', 'confidence', 'marketKey', 'bookmakerName']) {
    assert.ok(res.json.data.ignoredClientFields.includes(field), `${field} must be reported as ignored`);
  }
  assert.match(res.json.data.note, /computed on the server/i);

  // no API key is configured in this environment -> no ticket may appear
  const progress = await waitForRun(res.json.data.runId);
  assert.equal(progress.status, 'DATA_SOURCE_UNAVAILABLE');
  assert.equal(ctx.store.tickets.filter((t) => String(t.ticket_date).slice(0, 10) === otherDate).length, 0);
  assert.equal(ctx.store.selections.filter((s) => Number(s.fixture_id) === 4242).length, 0);
  assert.ok(!ctx.store.selections.some((s) => String(s.bookmaker_name) === 'Invented Bookmaker'));
});

test('acceptance 7: the public page reports DATA SOURCE TEMPORARILY UNAVAILABLE', async () => {
  const res = await get(`/api/ticket/${otherDate}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.status, 'DATA_SOURCE_UNAVAILABLE');
  assert.equal(res.json.data.headline, 'DATA SOURCE TEMPORARILY UNAVAILABLE');
  assert.deepEqual(res.json.data.selections, []);
  assert.equal(res.json.data.totalOdds, null);
});

test('acceptance 6: query string odds filters cannot change what is published', async () => {
  const res = await get(`/api/ticket/${ticketDate}?odds=9.99&status=WON&result=WON&selections=99`);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.status, 'QUALIFIED');
  assert.equal(res.json.data.totalOdds, '2.20');
  assert.equal(res.json.data.selectionCount, 3);
});

/* ------------------------------------------------------------------ */
/* Acceptance 9 — the published ticket over HTTP                        */
/* ------------------------------------------------------------------ */

test('acceptance 9: the generated ticket is served with verified prices only', async () => {
  const res = await get(`/api/ticket/${ticketDate}`);
  assert.equal(res.status, 200);
  const data = res.json.data;
  assert.equal(data.status, 'QUALIFIED');
  assert.equal(data.market.key, 'over_1_5');
  assert.equal(data.market.label, 'Over 1.5 Goals');
  assert.equal(data.market.goalLine, 1.5);
  assert.equal(data.totalOdds, '2.20');
  assert.equal(data.selectionCount, 3);
  assert.equal(data.selections.length, 3);
  assert.equal(data.oddsWindow.min, 2);
  assert.equal(data.oddsWindow.max, 4);

  for (const pick of data.selections) {
    assert.equal(pick.market.key, 'over_1_5');
    assert.equal(pick.market.goalLine, 1.5);
    assert.ok(['1.28', '1.30', '1.32'].includes(pick.odds.display));
    assert.equal(pick.odds.display, Number(pick.odds.value).toFixed(2));
    assert.ok(pick.odds.bookmaker, 'the real bookmaker is published');
    assert.ok(pick.odds.verifiedAt, 'the verification time is published');
    assert.ok(pick.confidence >= 72 && pick.confidence <= 100);
    assert.ok(pick.homeTeam.name && pick.awayTeam.name);
    assert.ok(pick.league.name);
    assert.ok(pick.kickoffAt);
    assert.ok(pick.snapshot.expectedTotalGoals > 2);
    assert.equal(pick.result, 'PENDING');
  }
  assert.doesNotThrow(() => JSON.stringify(data));
});

test('acceptance 9: the admin dashboard endpoints describe the same run', async () => {
  const overview = await get('/api/admin/overview', { token: bearer });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.data.generationRunning, false);
  assert.ok(overview.json.data.analytics.tickets.total >= 1);
  assert.ok(overview.json.data.lastGeneration, 'the dashboard shows the most recent run');
  assert.ok(
    ['QUALIFIED', 'NO_QUALIFYING_TICKET', 'DATA_SOURCE_UNAVAILABLE'].includes(overview.json.data.lastGeneration.status),
  );
  assert.equal(overview.json.data.settings.autoTicketGeneration, false);
  assert.equal(overview.json.data.settings.market.key, 'over_1_5');
  assert.deepEqual(overview.json.data.settings.oddsWindow, { min: 2, max: 4 });
  // The synthetic scenario anchors kickoffs to 12:00 UTC "today", but after
  // ~11:00 UTC it rolls them to the next UTC day so they stay in the future.
  // dataToday counts the current UTC day only, so the expected count depends
  // on which day the scenario landed on.
  const expectedTodayCount = ticketDate === todayUtc() ? 3 : 0;
  assert.equal(overview.json.data.dataToday.fixtures, expectedTodayCount);
  assert.equal(overview.json.data.dataToday.fixturesWithVerifiedOdds, expectedTodayCount);
  assert.ok(overview.json.data.dataSource);

  const report = await get(`/api/admin/generation-report?date=${ticketDate}`, { token: bearer });
  assert.equal(report.status, 200);
  assert.equal(report.json.data.status, 'QUALIFIED');
  assert.equal(report.json.data.ticketDate, ticketDate);
  assert.equal(report.json.data.counters.selectedPicks, 3);
  assert.equal(report.json.data.counters.finalCandidates, 3);
  assert.equal(report.json.data.report.totalOdds, '2.20');
  assert.equal(report.json.data.triggerSource, 'admin_ui');
  assert.equal(report.json.data.adminId, ADMIN.id);

  const generations = await get('/api/admin/generations?limit=5', { token: bearer });
  assert.equal(generations.status, 200);
  assert.ok(generations.json.data.length >= 1);
  const qualifiedRun = generations.json.data.find((g) => g.status === 'QUALIFIED' && g.date === ticketDate);
  assert.ok(qualifiedRun, 'the manual run is listed with its trigger source');
  assert.equal(qualifiedRun.triggerSource, 'admin_ui');
  assert.equal(qualifiedRun.adminId, ADMIN.id);
  assert.equal(qualifiedRun.selectedPicks, 3);
  assert.equal(qualifiedRun.totalOdds, '2.20');

  const progress = await get(`/api/admin/generation-progress?run_id=${report.json.data.runId}`, { token: bearer });
  assert.equal(progress.status, 200);
  assert.equal(progress.json.data.status, 'QUALIFIED');
  assert.ok(progress.json.data.progress.length >= 5);
});

test('public reads: history, predictions, analytics and health', async () => {
  const history = await get('/api/tickets/history?limit=5');
  assert.equal(history.status, 200);
  assert.ok(history.json.data.items.length >= 1);
  assert.equal(history.json.data.items[0].status, 'QUALIFIED');
  assert.equal(history.json.data.items[0].selections.length, 3);

  const predictions = await get(`/api/predictions?date=${ticketDate}&eligible=1&limit=10`);
  assert.equal(predictions.status, 200);
  assert.equal(predictions.json.data.total, 3);
  assert.equal(predictions.json.data.items.length, 3);
  assert.equal(predictions.json.data.market.key, 'over_1_5');
  assert.deepEqual(predictions.json.data.rejectionBreakdown, { NONE: 3 });
  for (const p of predictions.json.data.items) {
    assert.equal(p.market.key, 'over_1_5');
    assert.equal(p.market.goalLine, 1.5);
    assert.equal(p.eligible, true);
    assert.ok(Number(p.confidence) >= 72 && Number(p.confidence) <= 100);
    assert.ok(Number(p.risk) <= 35);
    assert.ok(Number(p.quality) >= 60);
    assert.ok(p.homeTeam.name && p.awayTeam.name && p.kickoffAt);
    assert.ok(['1.28', '1.30', '1.32'].includes(String(p.odds && (p.odds.display || p.odds.value))));
  }

  const analytics = await get('/api/analytics');
  assert.equal(analytics.status, 200);
  assert.ok(analytics.json.data.tickets.total >= 1);
  assert.equal(analytics.json.data.market.key, 'over_1_5');
  assert.deepEqual(analytics.json.data.market.oddsWindow, { min: 2, max: 4 });
  assert.ok(Array.isArray(analytics.json.data.monthly));
  assert.doesNotThrow(() => JSON.stringify(analytics.json.data));

  const today = await get('/api/ticket/today');
  assert.equal(today.status, 200);
  assert.equal(today.json.data.autoTicketGeneration, false);
  assert.deepEqual(today.json.data.oddsWindow, { min: 2, max: 4 });
  assert.equal(today.json.data.market.label, 'Over 1.5 Goals');
  assert.ok(['PENDING', 'QUALIFIED', 'NO_QUALIFYING_TICKET'].includes(today.json.data.status));

  const health = await get('/api/health');
  assert.equal(health.status, 200, 'the site stays up even without a data source');
  assert.equal(health.json.data.database, 'ok');
  assert.equal(health.json.data.status, 'degraded');
  assert.equal(health.json.data.dataSource.configured, false);
  assert.equal(health.json.data.autoTicketGeneration, false);
  assert.equal(health.json.data.market.key, 'over_1_5');
  assert.ok(!JSON.stringify(health.json).includes('http-test-secret'));

  const meta = await get('/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.json.data.market.key, 'over_1_5');
  assert.equal(meta.json.data.oddsWindow.min, 2);
  assert.equal(meta.json.data.oddsWindow.max, 4);
  assert.equal(meta.json.data.autoTicketGeneration, false);
  assert.equal(meta.json.data.siteName, 'GoalPredict');

  const notFound = await get('/api/does-not-exist');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.ok, false);
});

/* ------------------------------------------------------------------ */
/* Security                                                             */
/* ------------------------------------------------------------------ */

test('operations: logs are readable and a sync cannot run without a data source', async () => {
  const logs = await get('/api/admin/system-logs?limit=20', { token: bearer });
  assert.equal(logs.status, 200);
  assert.ok(logs.json.data.total >= 1, 'the generation run is audited');
  assert.ok(logs.json.data.items.some((l) => l.event === 'TICKET_GENERATED'));
  assert.ok(!JSON.stringify(logs.json).includes('http-test-secret'));

  const filtered = await get('/api/admin/system-logs?limit=20&level=info&channel=tickets', { token: bearer });
  assert.equal(filtered.status, 200);
  assert.ok(filtered.json.data.items.every((l) => l.level === 'info'));

  const syncLogs = await get('/api/admin/sync-logs?limit=10', { token: bearer });
  assert.equal(syncLogs.status, 200);
  assert.ok(Array.isArray(syncLogs.json.data));

  const ticketsBefore = ctx.store.tickets.length;
  const sync = await post('/api/admin/sync', { job: 'fixtures' }, { token: bearer });
  assert.equal(sync.status, 503, 'an unconfigured data source is reported, never faked');
  assert.equal(sync.json.ok, false);
  assert.equal(sync.json.error.code, 'NO_API_KEY');
  assert.equal(ctx.store.tickets.length, ticketsBefore, 'a sync can never create a ticket');
});

test('contract: every field the frontend renders is present in the payload', async () => {
  // analytics.html reads all of these counters directly
  const analytics = await get('/api/analytics');
  assert.equal(analytics.status, 200);
  const a = analytics.json.data;
  for (const key of ['total', 'qualified', 'noTicketDays', 'won', 'lost', 'void', 'pending', 'settled', 'winRate', 'avgOdds', 'highestOdds', 'lowestOdds']) {
    assert.ok(key in a.tickets, `analytics.tickets.${key} is rendered by the page`);
  }
  for (const key of ['total', 'won', 'lost', 'voided', 'pending', 'settled', 'winRate']) {
    assert.ok(key in a.selections, `analytics.selections.${key} is rendered by the page`);
  }
  for (const key of ['settled', 'won', 'lost', 'voided', 'winRate']) assert.ok(key in a.over15, `over15.${key}`);
  for (const key of ['currentWinningStreak', 'currentLosingStreak', 'longestWinningStreak', 'longestLosingStreak']) {
    assert.ok(key in a.streaks, `streaks.${key}`);
  }
  assert.ok(a.monthly.length >= 1);
  for (const key of ['month', 'tickets', 'qualified', 'won', 'lost', 'voided', 'selections', 'avgOdds', 'winRate']) {
    assert.ok(key in a.monthly[0], `monthly.${key}`);
  }

  // predictions.html reads these from every item
  const predictions = await get(`/api/predictions?date=${ticketDate}&limit=5`);
  const item = predictions.json.data.items[0];
  for (const key of ['fixtureId', 'kickoffAt', 'league', 'homeTeam', 'awayTeam', 'eligible', 'rejectReason', 'confidence', 'quality', 'risk', 'expectedGoals', 'odds']) {
    assert.ok(key in item, `predictions item.${key}`);
  }
  for (const key of ['available', 'value', 'bookmaker']) assert.ok(key in item.odds, `predictions odds.${key}`);
  assert.ok('total' in item.expectedGoals);

  const detail = await get(`/api/predictions/${item.fixtureId}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.json.data.prediction);
  assert.ok(Array.isArray(detail.json.data.scoreBreakdown));

  // history.html reads these from every ticket
  const history = await get('/api/tickets/history?limit=5');
  const past = history.json.data.items.find((t) => t.status === 'QUALIFIED');
  for (const key of ['date', 'status', 'result', 'selectionCount', 'totalOdds', 'settledOdds', 'selections']) {
    assert.ok(key in past, `history item.${key}`);
  }
  for (const key of ['homeTeam', 'awayTeam', 'league', 'kickoffAt', 'odds', 'result', 'score']) {
    assert.ok(key in past.selections[0], `history selection.${key}`);
  }
});

test('security: admin routes reject anonymous and non admin callers', async () => {
  const anonymous = await get('/api/admin/overview');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.ok, false);

  const userToken = auth.signToken({ sub: 5, type: 'user', role: null });
  const asUser = await get('/api/admin/overview', { token: userToken });
  assert.equal(asUser.status, 403);

  const garbage = await get('/api/admin/overview', { token: 'not-a-jwt' });
  assert.equal(garbage.status, 401);

  const deactivated = await get('/api/admin/overview', {
    token: auth.signToken({ sub: 99, type: 'admin', role: 'superadmin' }),
  });
  assert.equal(deactivated.status, 401, 'an unknown administrator id is refused');
});

test('security: the admin area is hidden from the public UI', () => {
  // No public page may link to, mention or otherwise expose the admin URLs.
  // admin.html (the console itself) and login.html (the unlisted sign-in
  // door) are the only files allowed to know about the console.
  const exempt = new Set(['admin.html']);
  for (const entry of fs.readdirSync(PUBLIC_DIR)) {
    if (!entry.endsWith('.html') || exempt.has(entry)) continue;
    const html = fs.readFileSync(path.join(PUBLIC_DIR, entry), 'utf8');
    assert.ok(!html.includes('/admin'), `${entry} must not reference any admin URL`);
    assert.ok(!/data-auth-admin/i.test(html), `${entry} must not render admin controls`);
    assert.ok(!/admin login/i.test(html), `${entry} must not advertise an admin login`);
  }

  // The public navigation offers Home, Today's Ticket, Ticket History,
  // Analytics, Predictions and Login only.
  const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const nav = indexHtml.match(/<nav class="main-nav"[\s\S]*?<\/nav>/)[0];
  assert.ok(!/admin/i.test(nav), 'no admin entry in the primary navigation');
  for (const label of ['Home', "Today's Ticket", 'Ticket History', 'Analytics', 'Predictions']) {
    assert.ok(nav.includes(`>${label}<`), `the nav keeps ${label}`);
  }

  // The JavaScript loaded by public pages contains no privileged endpoints;
  // only the console itself (admin.js) and the unlisted sign-in door
  // (login.js) talk to the admin surface.
  const publicScripts = ['api.js', 'app.js', 'ticket.js', 'history.js', 'analytics.js', 'predictions.js', 'account.js', 'dashboard.js'];
  for (const name of publicScripts) {
    const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js', name), 'utf8');
    assert.ok(!js.includes('/admin'), `js/${name} must not reference admin endpoints`);
    assert.ok(!/data-auth-admin/i.test(js), `js/${name} must not wire admin controls`);
  }
});

test('security: typing the admin URL never grants a guest or member access', async () => {
  // guest: bounced to the public sign-in page, never shown admin content
  for (const url of ['/admin', '/admin.html']) {
    const res = await fetch(`${base}${url}`, { redirect: 'manual' });
    assert.equal(res.status, 302, `${url} redirects guests`);
    assert.equal(res.headers.get('location'), '/login.html');
  }

  // guest: unknown admin-looking URLs simply do not exist
  for (const url of ['/admin/login', '/admin/admin', '/admin/anything']) {
    const res = await get(url);
    assert.equal(res.status, 404, `${url} must not be revealed`);
  }

  // guest: the console script behaves like an unknown asset
  const script = await get('/js/admin.js');
  assert.equal(script.status, 404);

  // normal authenticated member: a proper 403, no admin details
  const userToken = auth.signToken({ sub: 5, type: 'user', role: null });
  for (const url of ['/admin', '/admin.html']) {
    const res = await get(url, { token: userToken });
    assert.equal(res.status, 403, `${url} must refuse members`);
    assert.ok(res.json && !/admin/i.test(res.json.error.message), 'the refusal must not mention admins');
  }
  assert.equal((await get('/js/admin.js', { token: userToken })).status, 404);
  const api = await get('/api/admin/overview', { token: userToken });
  assert.ok([401, 403].includes(api.status), 'members never reach the admin API');

  // administrator: full access, and the shell ships uncached + unindexable
  const shell = await get('/admin.html', { token: bearer });
  assert.equal(shell.status, 200);
  assert.match(shell.text, /Admin Console|admin-shell/);
  assert.match(shell.headers.get('cache-control') || '', /no-store/);
  assert.match(shell.headers.get('x-robots-tag') || '', /noindex/);
  const consoleScript = await get('/js/admin.js', { token: bearer });
  assert.equal(consoleScript.status, 200);
  const friendly = await get('/admin', { token: bearer });
  assert.equal(friendly.status, 200, 'the friendly URL keeps working for admins');
});

test('security: cookie sessions need the double submit CSRF token', async () => {
  const csrf = 'csrf-token-value-1234567890';
  const cookie = `fp_token=${bearer}; fp_csrf=${csrf}`;

  const withoutHeader = await post('/api/admin/generate-ticket', { date: otherDate }, { cookie });
  assert.equal(withoutHeader.status, 403);
  assert.equal(withoutHeader.json.error.code, 'CSRF_MISSING');

  const mismatched = await post('/api/admin/generate-ticket', { date: otherDate }, { cookie, csrf: 'wrong-token-value-0000000000' });
  assert.equal(mismatched.status, 403);
  assert.equal(mismatched.json.error.code, 'CSRF_INVALID');

  const settingsPut = await put('/api/admin/settings', { min_confidence: '70' }, { cookie });
  assert.equal(settingsPut.status, 403);

  // a bearer client (the CLI) is not cookie bound, so CSRF does not apply
  const bearerPut = await put('/api/admin/settings', { min_confidence: '70' }, { token: bearer });
  assert.equal(bearerPut.status, 200);
  assert.deepEqual(bearerPut.json.data.applied, [{ key: 'min_confidence', value: '70' }]);
});

test('security: locked settings cannot be changed through the API', async () => {
  const res = await put(
    '/api/admin/settings',
    { market_key: 'over_2_5', auto_ticket_generation: '1', min_total_odds: '1.20', max_total_odds: '9.00', max_risk: '90' },
    { token: bearer },
  );
  assert.equal(res.status, 200);
  const rejected = new Map(res.json.data.rejected.map((r) => [r.key, r.reason]));
  assert.equal(rejected.get('market_key'), 'LOCKED_SETTING');
  assert.equal(rejected.get('auto_ticket_generation'), 'LOCKED_SETTING');
  assert.equal(rejected.get('min_total_odds'), 'BELOW_MINIMUM_2');
  assert.equal(rejected.get('max_total_odds'), 'ABOVE_MAXIMUM_4');
  assert.equal(res.json.data.applied.some((a) => a.key === 'max_risk'), true);

  const listing = await get('/api/admin/settings', { token: bearer });
  assert.equal(listing.status, 200);
  const byKey = new Map(listing.json.data.items.map((s) => [s.key, s]));
  assert.equal(byKey.get('market_key').value, 'over_1_5');
  assert.equal(byKey.get('market_key').locked, true);
  assert.equal(byKey.get('auto_ticket_generation').value, '0');
  assert.equal(byKey.get('auto_ticket_generation').locked, true);
  assert.equal(byKey.get('min_total_odds').value, '2.00');
  assert.equal(byKey.get('max_total_odds').value, '4.00');
  for (const group of ['market', 'odds_window', 'filters', 'correlation', 'model', 'scoring', 'sync', 'site']) {
    assert.ok(
      listing.json.data.items.some((s) => s.group === group),
      `settings group ${group} must be exposed to the dashboard`,
    );
  }
});

test('security: the API status endpoint never reveals key material', async () => {
  const res = await get('/api/admin/api-status', { token: bearer });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.configured, false);
  assert.ok(!res.text.includes('http-test-secret'));
  assert.ok(!/key["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}/.test(res.text));
});

test('security: the frontend is served with a strict CSP and no inline scripts', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /GoalPredict/);
  const csp = home.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'inline scripts must stay blocked');
  assert.match(csp, /object-src 'none'/);
  assert.equal(home.headers.get('x-powered-by'), null);
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(home.text), 'no inline <script> tags');

  for (const asset of ['/js/api.js', '/js/app.js', '/css/style.css']) {
    const res = await get(asset);
    assert.equal(res.status, 200, `${asset} must be served`);
  }

  // the admin console shell and its script are NOT public assets: a guest is
  // bounced to the sign-in page, the script answers like an unknown file
  const adminShell = await fetch(`${base}/admin.html`, { redirect: 'manual' });
  assert.equal(adminShell.status, 302, 'the admin console redirects guests away');
  assert.equal(adminShell.headers.get('location'), '/login.html');
  const adminScript = await get('/js/admin.js');
  assert.equal(adminScript.status, 404, 'the admin script is invisible to guests');
});

test('security: no API key, secret or upstream host is shipped to the browser', () => {
  const forbidden = [/API_FOOTBALL_KEY/i, /api-sports\.io/i, /rapidapi/i, /X-RapidAPI/i, /JWT_SECRET/, /DB_PASSWORD/, /BEGIN [A-Z ]*PRIVATE KEY/];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|js|css|svg|json|webmanifest)$/i.test(entry.name)) files.push(full);
    }
  };
  walk(PUBLIC_DIR);
  assert.ok(files.length >= 10, 'the frontend assets must exist');

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(content), `${path.relative(PUBLIC_DIR, file)} must not contain ${pattern}`);
    }
  }
});

test('responsive: the admin console stays navigable on small screens', () => {
  // The sidebar is display:none below 900px. Without a drawer + toggle an
  // administrator on a phone could only ever reach the default view, so the
  // markup, the styles and the wiring must all exist together.
  const adminHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'admin.js'), 'utf8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', 'style.css'), 'utf8');

  for (const id of ['id="sideNav"', 'id="sideToggle"', 'id="sideOverlay"']) {
    assert.ok(adminHtml.includes(id), `admin.html must render ${id}`);
  }
  assert.match(css, /@media \(max-width: 899\.98px\)[\s\S]*?\.admin-side\.open/, 'the drawer needs a small-screen rule');
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*?\.side-toggle \{ display: none/, 'the hamburger must vanish on desktop');
  assert.ok(adminJs.includes('bindSideNav'), 'admin.js must wire the drawer');
  assert.ok(adminJs.includes('closeSideNav()'), 'switching view must close the drawer');

  // and the public pages keep their mobile bottom bar, hidden on desktop
  const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('class="bottom-nav"'), 'public pages need the mobile bottom nav');
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*?\.bottom-nav \{ display: none/, 'bottom nav is mobile only');
});

test('compliance & SEO: legal page, robots.txt and sitemap.xml are served', async () => {
  // friendly URL + static file
  const legal = await get('/legal');
  assert.equal(legal.status, 200);
  assert.match(legal.text, /Legal &amp; Responsible Play/);
  assert.match(legal.text, /18 or over/i);
  assert.match(legal.text, /not a bookmaker/i);
  assert.match(legal.text, /begambleaware\.org/i);

  const robots = await get('/robots.txt');
  assert.equal(robots.status, 200);
  assert.doesNotMatch(robots.text, /admin/i, 'robots.txt must never advertise the admin area');
  assert.doesNotMatch(robots.text, /Disallow: \/login/, 'the sign-in door is not advertised either');
  assert.match(robots.text, /Disallow: \/api\//);
  assert.match(robots.text, /Sitemap: .+\/sitemap\.xml/);

  const sitemap = await get('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type'), /xml/);
  assert.match(sitemap.text, /<urlset/);
  assert.match(sitemap.text, /\/ticket<\/loc>/);
  assert.match(sitemap.text, /\/legal<\/loc>/);
  assert.doesNotMatch(sitemap.text, /admin|login/, 'private pages are never in the sitemap');

  // every public page carries the responsible-gambling footer + legal link
  for (const page of ['ticket.html', 'history.html', 'analytics.html', 'predictions.html']) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
    assert.ok(html.includes('/legal.html'), `${page} must link to the legal page`);
    assert.match(html, /18\+/, `${page} must show the 18+ notice`);
    assert.match(html, /og:title/, `${page} must have Open Graph metadata`);
  }
});

test('member accounts: register -> login -> me -> change password -> logout', async () => {
  // register (public, rate limited route)
  const reg = await post('/api/auth/register', {
    email: 'fan@test.local',
    username: 'ticketfan',
    password: 'super-secret-99',
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.data.username, 'ticketfan');

  // duplicate registration is refused without user enumeration detail
  const dup = await post('/api/auth/register', {
    email: 'fan@test.local',
    username: 'ticketfan2',
    password: 'super-secret-99',
  });
  assert.equal(dup.status, 409);

  // login returns the account + a token and sets the auth cookies
  const login = await post('/api/auth/login', { login: 'ticketfan', password: 'super-secret-99' });
  assert.equal(login.status, 200);
  assert.equal(login.json.data.user.username, 'ticketfan');
  assert.ok(login.json.data.token, 'a bearer token is issued');
  assert.ok(login.json.data.csrfToken, 'a csrf token is issued for cookie sessions');
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /HttpOnly/i, 'the session cookie is httpOnly');
  const userToken = login.json.data.token;

  // wrong password is generic + counted
  const bad = await post('/api/auth/login', { login: 'ticketfan', password: 'wrong-password-1' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'INVALID_CREDENTIALS');

  // me reflects the user session incl. the membership date
  const me = await get('/api/auth/me', { token: userToken });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.type, 'user');
  assert.equal(me.json.data.account.username, 'ticketfan');
  assert.ok(me.json.data.account.memberSince, 'memberSince is published for the account page');

  // a user can change their own password (bearer session: no CSRF needed)
  const changed = await post(
    '/api/auth/change-password',
    { currentPassword: 'super-secret-99', newPassword: 'even-more-secret-11' },
    { token: userToken },
  );
  assert.equal(changed.status, 200);
  const relogin = await post('/api/auth/login', { login: 'ticketfan', password: 'even-more-secret-11' });
  assert.equal(relogin.status, 200);

  // ... but a user can NEVER touch admin endpoints
  const forbidden = await get('/api/admin/overview', { token: userToken });
  assert.ok([401, 403].includes(forbidden.status), 'user tokens are rejected by admin routes');
  const adminPw = await post(
    '/api/auth/admin/change-password',
    { currentPassword: 'x', newPassword: 'y'.repeat(12) },
    { token: userToken },
  );
  assert.ok([401, 403].includes(adminPw.status));

  // generic logout clears the cookie for any session type
  const out = await post('/api/auth/logout', {}, { token: userToken });
  assert.equal(out.status, 200);
  assert.equal(out.json.data.loggedOut, true);

  // the account page is served and carries the member UI + robots exclusion
  const page = await get('/account');
  assert.equal(page.status, 200);
  assert.match(page.text, /Create a free account/);
  assert.match(page.text, /noindex/);
  const robots = await get('/robots.txt');
  assert.match(robots.text, /Disallow: \/account/);
});

test('PWA: manifest, service worker and offline page — API traffic is never cached', async () => {
  const manifest = await get('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /manifest\+json/);
  const parsed = JSON.parse(manifest.text);
  assert.equal(parsed.short_name, 'GoalPredict');
  assert.equal(parsed.display, 'standalone');
  assert.ok(parsed.icons.length >= 2, 'any + maskable icons');

  const sw = await get('/sw.js');
  assert.equal(sw.status, 200);
  // The honesty rule, enforced in code: /api/ requests pass straight through.
  assert.match(sw.text, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw.text, /never intercept or cache API traffic/i);
  assert.ok(!/cache\.put\([^)]*api/i.test(sw.text), 'no code path caches an API response');

  const offline = await get('/offline.html');
  assert.equal(offline.status, 200);
  assert.match(offline.text, /never shows cached tickets/i);

  // registration ships in the shared api.js (CSP forbids inline scripts)
  const apiJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'api.js'), 'utf8');
  assert.match(apiJs, /serviceWorker.*register\('\/sw\.js'\)/s);

  // every page head links the manifest
  for (const page of ['index.html', 'ticket.html', 'history.html', 'analytics.html', 'predictions.html', 'legal.html', 'account.html']) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
    assert.ok(html.includes('manifest.webmanifest'), `${page} links the manifest`);
  }
});

test('analytics page: flat-stake ROI and monthly chart are rendered from real data only', async () => {
  // the public stats endpoint ships the flat-stake record the page renders
  const stats = await get('/api/analytics');
  assert.equal(stats.status, 200);
  assert.ok('flatStake' in stats.json.data, 'flat-stake record is part of the public payload');
  assert.ok(Array.isArray(stats.json.data.monthly));

  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'analytics.html'), 'utf8');
  assert.ok(html.includes('id="roiCards"'), 'ROI section exists');
  assert.ok(html.includes('id="monthlyChart"'), 'chart section exists');

  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'analytics.js'), 'utf8');
  assert.match(js, /renderRoi/);
  assert.match(js, /renderMonthlyChart/);
  assert.match(js, /losses included|negative ROI is shown/i, 'honesty note ships with the code');
});
