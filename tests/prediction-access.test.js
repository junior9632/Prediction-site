'use strict';

/**
 * PREDICTION ACCESS BOUNDARY — football predictions are LOGIN-ONLY.
 *
 * The rule under test, in one sentence: an anonymous visitor cannot obtain a
 * single prediction, selection, odds value, confidence figure, ticket or
 * history row — not through a page, not through an API, not with DevTools,
 * not with a hand-written URL, and not by supplying an identifier of their
 * own. A signed-in, active account can, and only for data the server decided
 * it may see.
 *
 * Both halves are proven here against a running Express app backed by the
 * in-memory database double, seeded with a REAL qualified ticket so there is
 * genuine data that could leak:
 *
 *   1. GUEST       -> 401 + no payload from every prediction endpoint,
 *                     302 -> /login?next=... from every member page, and a
 *                     homepage that publishes no prediction data
 *   2. MEMBER      -> 200 with data from the same endpoints, the same pages
 *                     served no-store / noindex
 *   3. ADMINISTRATOR -> the console keeps working, member endpoints included
 *   4. DISABLED / LOCKED / GHOST accounts are refused even with a valid token
 *
 * The enforcement lives in server/middleware/account.js (`memberApiGuard`)
 * mounted by the routers, and in the page guards in server/app.js — never in
 * CSS, never in JavaScript. The frontend assertions below only check that the
 * UI agrees with the server; removing all of them would not open a single
 * endpoint.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'prediction-access-secret-please-change';
delete process.env.API_FOOTBALL_KEY;
delete process.env.API_FOOTBALL_HOST;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fakeDb = require('./fakeDb');
const { buildScenario, FakeApi } = require('./synthetic');

const auth = require('../server/middleware/auth');
const settingsService = require('../server/services/settingsService');
const ticketService = require('../server/services/ticketService');
const { createApp, PUBLIC_DIR } = require('../server/app');

const ADMIN = {
  id: 1,
  email: 'admin@test.local',
  username: 'admin',
  password_hash: 'x',
  role: 'superadmin',
  is_active: 1,
  locked_until: null,
  must_change_password: 0,
};

const MEMBER = {
  id: 11,
  email: 'member@test.local',
  username: 'goalhound',
  password_hash: 'x',
  role: 'user',
  is_active: 1,
  locked_until: null,
  created_at: new Date().toISOString(),
  last_login_at: null,
};

const OTHER_MEMBER = { ...MEMBER, id: 12, email: 'other@test.local', username: 'otherfan' };
const DISABLED = { ...MEMBER, id: 13, username: 'banned', is_active: 0 };
const LOCKED = { ...MEMBER, id: 14, username: 'locked', locked_until: new Date(Date.now() + 3600e3).toISOString() };

/* Every URL that carries prediction data. Nothing here may answer a guest. */
const PREDICTION_APIS = [
  '/api/predictions',
  '/api/predictions?date=2026-01-01',
  '/api/predictions?eligible=1&limit=100',
  '/api/predictions/1',
  '/api/ticket/today',
  '/api/tickets/today',
  '/api/tickets/history',
  '/api/ticket/history',
  '/api/analytics',
  '/api/fixtures',
  '/api/fixtures?playable=1',
  '/api/fixtures/1',
  '/api/odds',
  '/api/odds/bookmakers',
  '/api/odds/fixture/1',
  '/api/dashboard/activity',
];

/* Every page that renders prediction data, in both URL shapes. */
const MEMBER_PAGES = [
  '/predictions',
  '/predictions.html',
  '/ticket',
  '/ticket.html',
  '/history',
  '/history.html',
  '/analytics',
  '/analytics.html',
  '/dashboard',
  '/dashboard.html',
];

/* Markup that can only exist on a page which is really rendering data. */
const DATA_MARKERS = ['id="predList"', 'id="pickList"', 'id="historyList"', 'id="statCards"', 'id="activityFeed"'];

/* Words that would betray a prediction in served HTML. */
const DATA_WORDS = ['pv-match-teams', 'pick-teams', 'odds-badge', 'conf-pill', 'Verified odds', 'Total odds'];

let server;
let base;
let ctx;
let scn;
let ticketDate;
let memberToken;
let otherToken;
let adminToken;
let disabledToken;
let lockedToken;

async function waitForRun(runId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let progress = await ticketService.getGenerationProgress(runId);
  while (progress && progress.status === 'RUNNING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    progress = await ticketService.getGenerationProgress(runId);
  }
  return progress;
}

async function req(method, urlPath, { token = null, cookie = null, redirect = 'manual' } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers.Cookie = `${require('../server/config').auth.cookieName}=${token}`;
  }
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${urlPath}`, { method, headers, redirect });
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

before(async () => {
  scn = buildScenario({ oddsValues: ['1.28', '1.30', '1.32'] });
  ticketDate = scn.ticketDate;

  ctx = fakeDb.install({
    admins: [ADMIN],
    settings: [],
    fixtures: scn.fixtures,
    teamForms: scn.teamForms,
    leagues: scn.leagueEnvs,
    users: [MEMBER, OTHER_MEMBER, DISABLED, LOCKED],
  });
  settingsService.invalidateCache();

  // A real qualified ticket: there IS prediction data in the database, so a
  // leak in any of the assertions below would be a real leak.
  const started = await ticketService.startGeneration({
    adminId: ADMIN.id,
    source: 'admin_ui',
    date: ticketDate,
    api: new FakeApi(scn),
  });
  const progress = await waitForRun(started.runId);
  assert.equal(progress.status, 'QUALIFIED', String(progress.error || ''));
  assert.ok(ctx.store.selections.length >= 3, 'the scenario stored real selections');

  memberToken = auth.signToken({ sub: MEMBER.id, type: 'user', role: MEMBER.role, username: MEMBER.username });
  otherToken = auth.signToken({ sub: OTHER_MEMBER.id, type: 'user', role: 'user', username: OTHER_MEMBER.username });
  adminToken = auth.signToken({ sub: ADMIN.id, type: 'admin', role: ADMIN.role, username: ADMIN.username });
  disabledToken = auth.signToken({ sub: DISABLED.id, type: 'user', role: 'user', username: DISABLED.username });
  lockedToken = auth.signToken({ sub: LOCKED.id, type: 'user', role: 'user', username: LOCKED.username });

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
/* 1. GUEST — the API refuses everything                               */
/* ------------------------------------------------------------------ */

test('guest: every prediction endpoint answers 401 with no payload', async () => {
  for (const url of PREDICTION_APIS) {
    const res = await get(url);
    assert.equal(res.status, 401, `${url} must refuse a guest`);
    assert.equal(res.json.ok, false, `${url} reports the refusal in the envelope`);
    assert.equal(res.json.data, undefined, `${url} carries no data`);
    assert.match(res.headers.get('cache-control') || '', /no-store/, `${url} is never cacheable`);

    // nothing prediction-shaped appears anywhere in the body
    for (const word of ['homeTeam', 'awayTeam', 'selections', 'confidence', 'bookmaker', 'totalOdds', 'expectedGoals']) {
      assert.ok(!res.text.includes(word), `${url} leaks nothing (${word})`);
    }
  }
});

test('guest: HEAD, cookies and both mount prefixes are refused the same way', async () => {
  // HEAD is served by the same handler as GET
  const head = await req('HEAD', '/api/predictions');
  assert.equal(head.status, 401);

  // the ticket router is mounted twice; guarding one prefix is not enough
  for (const url of ['/api/ticket/today', '/api/tickets/today', '/api/ticket/history', '/api/tickets/history']) {
    const res = await get(url);
    assert.equal(res.status, 401, `${url} is guarded too`);
  }

  // a garbage cookie is not a session
  const cookie = await get('/api/predictions', { cookie: `${require('../server/config').auth.cookieName}=not-a-jwt` });
  assert.equal(cookie.status, 401);

  // an expired session is a refusal, not a partial answer
  const jwt = require('jsonwebtoken');
  const expired = jwt.sign({ sub: MEMBER.id, type: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '-1h' });
  const stale = await get('/api/predictions', { token: expired });
  assert.equal(stale.status, 401);
  assert.equal(stale.json.error.code, 'TOKEN_EXPIRED');
});

test('guest: nothing a browser can send unlocks the data', async () => {
  // The server decides who is asking. No query parameter, header or body
  // field can supply an identity it will believe.
  const attempts = [
    '/api/predictions?userId=11&user_id=11&memberId=11&public=1&auth=1&guest=0',
    `/api/predictions?token=${encodeURIComponent(memberToken)}`,
    '/api/tickets/history?userId=11&scope=all',
    '/api/analytics?userId=11&admin=1',
    `/api/fixtures?apiKey=${encodeURIComponent(memberToken)}`,
  ];
  for (const url of attempts) {
    const res = await get(url);
    assert.equal(res.status, 401, `${url} stays closed`);
    assert.equal(res.json.data, undefined, `${url} returns nothing`);
  }

  // a token for one account cannot be presented as somebody else
  const spoofed = await get('/api/dashboard/activity?actorId=12&actor_id=12&userId=12&scope=all&type=admin', { token: memberToken });
  assert.equal(spoofed.status, 200);
  assert.equal(spoofed.json.data.scope, 'self');
  assert.equal(spoofed.json.data.account.id, MEMBER.id);
  assert.ok(!JSON.stringify(spoofed.json).includes('otherfan'), "another member's data never leaks");

  // ... and the other member's own session is scoped to them, not to us
  const otherFeed = await get('/api/dashboard/activity', { token: otherToken });
  assert.equal(otherFeed.status, 200);
  assert.equal(otherFeed.json.data.account.id, OTHER_MEMBER.id);
  assert.ok(!JSON.stringify(otherFeed.json).includes(MEMBER.username), "one member never reads another's activity");
});

/* ------------------------------------------------------------------ */
/* 2. GUEST — the pages redirect, the data is never served              */
/* ------------------------------------------------------------------ */

test('guest: every member page redirects to the sign-in door with no markup', async () => {
  for (const url of MEMBER_PAGES) {
    const res = await get(url);
    assert.equal(res.status, 302, `${url} redirects a guest`);
    assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(url)}`, `${url} names the refused page`);
    for (const marker of DATA_MARKERS) {
      assert.ok(!res.text.includes(marker), `${url} ships no ${marker}`);
    }
    assert.ok(!/Over 1\.5 analysis|Candidates/.test(res.text), `${url} ships no prediction copy`);
  }
});

test('guest: the sign-in door is professional, names the page and offers both actions', async () => {
  const cases = [
    ['%2Fpredictions', 'Football Predictions', 'Login or create an account to access GoalPredict AI football predictions.'],
    ['%2Fticket', "Today's AI Ticket", 'Login to access today’s verified football selections.'],
    ['%2Fhistory', 'Ticket History', 'Login to access the published ticket history and settled results.'],
    ['%2Fanalytics', 'Prediction Analytics', 'Login to access GoalPredict prediction analytics and the performance record.'],
  ];
  for (const [next, title, message] of cases) {
    const res = await get(`/login?next=${next}`);
    assert.equal(res.status, 200, `/login?next=${next} is served`);
    assert.ok(res.text.includes('id="loginRequired"'), 'the login-required panel is rendered by the server');
    assert.ok(res.text.includes(title), `the panel names ${title}`);
    assert.ok(res.text.includes(message), 'the panel explains what is required');
    assert.match(res.text, />Login</, 'the panel offers Login');
    assert.match(res.text, />Create Account</, 'the panel offers Create Account');
    assert.match(res.headers.get('cache-control') || '', /no-store/, 'the door is never cached');
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/, 'the door is never indexed');
  }

  // without ?next the plain account page is served (no injected panel)
  const plain = await get('/login');
  assert.equal(plain.status, 200);
  assert.match(plain.text, /Create a free account/);
  assert.ok(!plain.text.includes('id="loginRequired"'));

  // an unknown or off-site target is ignored — no injection, no open redirect
  for (const bad of ['%2F%2Fevil.example%2Fsteal', 'https%3A%2F%2Fevil.example', '%2Fadmin', 'javascript%3Aalert(1)', '%2F']) {
    const res = await get(`/login?next=${bad}`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('id="loginRequired"'), `${bad} renders no panel`);
    assert.ok(!res.text.includes('evil.example'), `${bad} is not echoed`);
  }
});

test('guest: the homepage is marketing only — no prediction data at all', async () => {
  const home = await get('/');
  assert.equal(home.status, 200, 'the homepage stays public');

  for (const marker of [...DATA_MARKERS, ...DATA_WORDS, 'pv-match-teams', 'pv-match-meta', 'matchCards']) {
    assert.ok(!home.text.includes(marker), `the homepage renders no ${marker}`);
  }
  // no team name, league or price from the seeded ticket may appear
  const seededTeams = new Set();
  for (const selection of ctx.store.selections) {
    if (selection.home_team_name) seededTeams.add(selection.home_team_name);
    if (selection.away_team_name) seededTeams.add(selection.away_team_name);
  }
  assert.ok(seededTeams.size > 0, 'the scenario has team names that could leak');
  for (const team of seededTeams) {
    assert.ok(!home.text.includes(team), `the homepage never prints ${team}`);
  }
  for (const price of ['1.28', '1.30', '1.32', '2.20']) {
    assert.ok(!home.text.includes(price), `the homepage never prints the odds ${price}`);
  }
  assert.ok(!/\/api\/(predictions|ticket|tickets|analytics|fixtures|odds)/.test(home.text), 'the homepage names no prediction endpoint');
  assert.match(home.text, /Unlock AI Football Predictions/, 'the homepage carries the unlock CTA');
  assert.match(home.text, /Login to view today's predictions/, 'the homepage carries the login CTA');
});

test('guest: the navigation hides the member area and the scripts never call it', () => {
  const publicPages = ['index.html', 'about.html', 'legal.html', 'account.html', 'login.html'];
  for (const page of publicPages) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
    const memberLinks = html.match(/<a[^>]*data-auth-only[^>]*>[^<]*<\/a>/g) || [];
    for (const link of memberLinks) {
      assert.match(link, /class="[^"]*\bhidden\b/, `${page}: a member link ships hidden — ${link}`);
    }
    assert.ok(!html.includes('js/predictions.js') || page === 'predictions.html', `${page} loads no prediction script`);
  }

  // the landing script makes no data request at all
  const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'app.js'), 'utf8');
  assert.ok(!/API\.get\(/.test(appJs), 'js/app.js reads no endpoint');
  assert.ok(!/\/api\/(predictions|ticket|tickets|analytics|fixtures|odds|dashboard|admin)/.test(appJs), 'js/app.js names no protected endpoint');

  // the shared helper reveals the member navigation only for a real session
  const apiJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'api.js'), 'utf8');
  assert.match(apiJs, /\[data-auth-only\]/, 'api.js toggles the member-only links');
  assert.match(apiJs, /memberOnly\.forEach\(\(node\) => node\.classList\.toggle\('hidden', !isAuthed\)\)/, 'the toggle depends on the session');
  assert.match(apiJs, /lockedState/, 'api.js offers the 401 state member pages render');
});

test('guest: the service worker and the crawlers never expose a member page', async () => {
  const worker = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  assert.match(worker, /isMemberPage/, 'the worker knows the member pages');
  assert.match(worker, /if \(isMemberPage\(url\.pathname\)\) return;/, 'and never caches them');
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/, 'API traffic is still never touched');

  const robots = await get('/robots.txt');
  assert.equal(robots.status, 200);
  assert.doesNotMatch(robots.text, /predictions|ticket|history|analytics|admin|login/i, 'robots.txt advertises nothing private');

  const sitemap = await get('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  for (const page of ['/predictions<', '/ticket<', '/history<', '/analytics<', '/dashboard<']) {
    assert.ok(!sitemap.text.includes(page), `the sitemap omits ${page}`);
  }
  assert.match(sitemap.text, /\/legal<\/loc>/, 'the public pages are still listed');
});

/* ------------------------------------------------------------------ */
/* 3. MEMBER — the same doors open                                     */
/* ------------------------------------------------------------------ */

test('member: the prediction endpoints answer 200 with real data', async () => {
  // queried for the scenario's ticket date: the synthetic fixtures are
  // anchored to it, which is not necessarily "today" in UTC
  const predictions = await get(`/api/predictions?date=${ticketDate}`, { token: memberToken });
  assert.equal(predictions.status, 200);
  assert.equal(predictions.json.ok, true);
  assert.ok(predictions.json.data.items.length > 0, 'the member sees the analysed fixtures');
  assert.match(predictions.headers.get('cache-control') || '', /no-store/, 'member data is never cached');

  const ticket = await get('/api/ticket/today', { token: memberToken });
  assert.equal(ticket.status, 200);
  assert.ok(ticket.json.data, 'the ticket is served');

  const history = await get('/api/tickets/history', { token: memberToken });
  assert.equal(history.status, 200);
  assert.ok(Array.isArray(history.json.data.items));

  for (const url of ['/api/analytics', '/api/fixtures', '/api/odds']) {
    const res = await get(url, { token: memberToken });
    assert.equal(res.status, 200, `${url} serves the member`);
    assert.equal(res.json.ok, true);
    assert.match(res.headers.get('cache-control') || '', /no-store/, `${url} is never cached`);
  }
});

test('member: the member pages are served, uncached and unindexed', async () => {
  for (const [url, marker] of [
    ['/predictions', 'id="predList"'],
    ['/predictions.html', 'id="predList"'],
    ['/ticket', 'id="pickList"'],
    ['/history', 'id="historyList"'],
    ['/analytics', 'id="statCards"'],
    ['/dashboard', 'id="activityCard"'],
  ]) {
    const res = await get(url, { token: memberToken });
    assert.equal(res.status, 200, `${url} is served to the member`);
    assert.ok(res.text.includes(marker), `${url} carries its own markup`);
    assert.match(res.headers.get('cache-control') || '', /no-store/, `${url} is never cached`);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/, `${url} is never indexed`);
  }

  // the sign-in door sends a live session straight back to the page
  const bounced = await get('/login?next=%2Fpredictions', { token: memberToken });
  assert.equal(bounced.status, 302);
  assert.equal(bounced.headers.get('location'), '/predictions');
});

test('member: the navigation the brief asks for is present for a signed-in account', () => {
  for (const page of ['index.html', 'predictions.html', 'ticket.html', 'history.html', 'analytics.html', 'dashboard.html']) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
    const nav = html.match(/<nav class="main-nav[^"]*"[\s\S]*?<\/nav>/);
    assert.ok(nav, `${page} renders a primary navigation`);
    for (const label of ['Dashboard', 'Predictions', "Today's Ticket", 'Ticket History', 'Analytics']) {
      assert.ok(nav[0].includes(`>${label}<`), `${page}: the member navigation keeps ${label}`);
    }
    // Logout is rendered by the shared session controls on every page
    assert.ok(/data-auth-logout|id="logoutBtn"/.test(html), `${page} offers Logout to a member`);
  }
});

test('member: an ended session falls back to the sign-in door, not to an error', () => {
  // The pages are guarded server side; this only keeps the UI honest when a
  // session ends while a member page is open.
  for (const name of ['predictions.js', 'ticket.js', 'history.js', 'analytics.js']) {
    const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js', name), 'utf8');
    assert.match(js, /isUnauthorized\(err\)/, `${name} recognises a 401`);
    assert.match(js, /lockedState\(/, `${name} renders the sign-in prompt`);
  }
});

/* ------------------------------------------------------------------ */
/* 4. ADMINISTRATOR — nothing is loosened or broken                    */
/* ------------------------------------------------------------------ */

test('admin: the console keeps working and the member surface stays open', async () => {
  const overview = await get('/api/admin/overview', { token: adminToken });
  assert.equal(overview.status, 200, 'the console API is untouched');
  assert.equal(overview.json.ok, true);

  const predictions = await get('/api/predictions', { token: adminToken });
  assert.equal(predictions.status, 200, 'an administrator is an authenticated principal');

  // the member workspace still sends an administrator to the console
  const dashboard = await get('/dashboard', { token: adminToken });
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.get('location'), '/admin.html');

  // a member still cannot touch the console
  const forbidden = await get('/api/admin/overview', { token: memberToken });
  assert.ok([401, 403].includes(forbidden.status));
});

/* ------------------------------------------------------------------ */
/* 5. ACCOUNT STATE — a valid token is not enough                      */
/* ------------------------------------------------------------------ */

test('account state: disabled, locked and deleted accounts lose access immediately', async () => {
  const disabled = await get('/api/predictions', { token: disabledToken });
  assert.equal(disabled.status, 403);
  assert.equal(disabled.json.error.code, 'ACCOUNT_DISABLED');
  assert.equal(disabled.json.data, undefined);

  const locked = await get('/api/predictions', { token: lockedToken });
  assert.equal(locked.status, 403);
  assert.equal(locked.json.error.code, 'ACCOUNT_LOCKED');

  const ghost = auth.signToken({ sub: 9999, type: 'user', role: 'user', username: 'ghost' });
  const gone = await get('/api/predictions', { token: ghost });
  assert.equal(gone.status, 401);
  assert.equal(gone.json.error.code, 'ACCOUNT_MISSING');

  // the same accounts are refused by the pages, not only by the APIs
  for (const token of [disabledToken, lockedToken, ghost]) {
    const page = await get('/ticket', { token });
    assert.ok([302, 401, 403].includes(page.status), 'a refused account never receives the page');
    assert.ok(!page.text.includes('id="pickList"'));
  }
});

/* ------------------------------------------------------------------ */
/* 6. the enforcement is server side, not decoration                   */
/* ------------------------------------------------------------------ */

test('enforcement: the UI preview harness cannot bypass the guards either', () => {
  // tools/uipreview.js wraps the real app to inject a "sample data" banner. A
  // wrapper that serves .html files itself would hand a signed-out reviewer
  // the member pages, so it is restricted to an ALLOWLIST of public pages and
  // everything else falls through to the guarded app.
  const harness = fs.readFileSync(path.join(__dirname, '..', 'tools', 'uipreview.js'), 'utf8');
  const allow = harness.match(/PUBLIC_PREVIEW_PAGES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(allow, 'the harness allowlists the pages it may serve');
  const allowed = (allow[1].match(/'[^']+'/g) || []).map((entry) => entry.slice(1, -1));
  assert.ok(allowed.length >= 3, 'the public pages are still previewable');
  for (const page of ['/predictions.html', '/ticket.html', '/history.html', '/analytics.html', '/dashboard.html', '/admin.html']) {
    assert.ok(!allowed.includes(page), `the harness must never serve ${page} itself`);
  }
  assert.match(harness, /if \(!PUBLIC_PREVIEW_PAGES\.has\(req\.path\)\) return next\(\);/, 'anything unlisted falls through to the app');
});

test('enforcement: the guard is mounted in the routers, not in the frontend', () => {
  const guard = fs.readFileSync(path.join(__dirname, '..', 'server', 'middleware', 'account.js'), 'utf8');
  assert.match(guard, /const memberApiGuard = \[neverCache, auth\.requireAuth, requireActiveAccount\];/, 'the composed guard exists');

  for (const router of ['predictions.js', 'tickets.js', 'odds.js', 'fixtures.js', 'analytics.js', 'dashboard.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', router), 'utf8');
    assert.match(source, /router\.use\(memberApiGuard\);/, `routes/${router} mounts the member guard`);
    // the guard must run before any handler is registered
    assert.ok(
      source.indexOf('router.use(memberApiGuard);') < source.indexOf('router.get('),
      `routes/${router} guards before it serves`
    );
  }

  // ... and the pages are guarded before express.static can serve the file
  const app = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
  assert.ok(
    app.indexOf('app.get(page.path, memberPageGuard, sendMemberPage(page.file));') < app.indexOf('express.static(PUBLIC_DIR'),
    'the page guards are registered before the static handler'
  );
  assert.match(app, /signInRedirect\(req\.path\)/, 'a refused visitor is sent to /login with the page they asked for');
  assert.match(app, /const pages = \['legal', 'about', 'account'\];/, 'no member page is served as a plain friendly URL');
});
