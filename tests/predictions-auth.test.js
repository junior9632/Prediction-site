'use strict';

/**
 * FOOTBALL PREDICTIONS ARE LOGIN ONLY — the acceptance matrix.
 *
 *   guest   -> every prediction surface is refused: 401 Unauthorized from the
 *              API with an empty body, 401 + the "login required" page from
 *              every page route. No match, price, confidence, selection,
 *              ticket, history row or statistic ever reaches the browser.
 *   member  -> every surface opens, scoped to the session the SERVER resolved
 *              (a userId in the query string or a header changes nothing)
 *   admin   -> keeps its existing permissions and can read the surfaces too
 *   closed  -> a deactivated or deleted account is refused even with a token
 *              that is still cryptographically valid
 *
 * The suite boots the real Express app against the in-memory database double,
 * so it exercises the same middleware, routes and controllers as production.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'predictions-auth-test-secret';
delete process.env.API_FOOTBALL_KEY;
delete process.env.API_FOOTBALL_HOST;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const fakeDb = require('./fakeDb');
const auth = require('../server/middleware/auth');
const settingsService = require('../server/services/settingsService');
const { createApp, PUBLIC_DIR } = require('../server/app');

const ADMIN = {
  id: 1, email: 'admin@test.local', username: 'admin',
  password_hash: bcrypt.hashSync('admin-test-pass-1', 4),
  role: 'superadmin', is_active: 1, locked_until: null, must_change_password: 0,
  created_at: '2026-08-01 09:00:00',
};
const MEMBER = {
  id: 41, email: 'fan@test.local', username: 'ticketfan',
  password_hash: bcrypt.hashSync('member-secret-99', 4),
  role: 'user', is_active: 1, failed_logins: 0, locked_until: null,
  last_login_at: null, created_at: '2026-09-01 10:00:00', updated_at: '2026-09-01 10:00:00',
};
const DISABLED = {
  id: 43, email: 'closed@test.local', username: 'closedfan', password_hash: 'x',
  role: 'user', is_active: 0, failed_logins: 0, locked_until: null,
  last_login_at: null, created_at: '2026-09-03 10:00:00', updated_at: '2026-09-03 10:00:00',
};
const LOCKED = {
  id: 44, email: 'locked@test.local', username: 'lockedfan', password_hash: 'x',
  role: 'user', is_active: 1, failed_logins: 5, locked_until: '2099-01-01 00:00:00',
  last_login_at: null, created_at: '2026-09-04 10:00:00', updated_at: '2026-09-04 10:00:00',
};

/** Every prediction surface, by name. */
const PREDICTION_APIS = [
  '/api/predictions',
  '/api/predictions?date=2026-10-08&limit=10',
  '/api/predictions/12345',
  '/api/ticket/today',
  '/api/ticket/2026-10-08',
  '/api/tickets/today',
  '/api/tickets/history',
  '/api/tickets/history?limit=5',
  '/api/analytics',
  '/api/fixtures',
  '/api/fixtures?date=2026-10-08',
  '/api/odds',
  '/api/odds/bookmakers',
  '/api/odds/fixture/12345',
];

const PREDICTION_PAGES = [
  '/predictions',
  '/predictions.html',
  '/ticket',
  '/ticket.html',
  '/today-ticket',
  '/history',
  '/history.html',
  '/analytics',
  '/analytics.html',
];

/** Words that must never appear in a refusal or in a public page. */
const DATA_MARKERS = [
  'homeTeam', 'awayTeam', 'expectedGoals', 'totalOdds', 'selectionCount',
  'modelProbability', 'confidence"', 'rejectReason', 'scoreBreakdown',
  'pick-row', 'history-row', 'predList', 'acc-summary', 'monthlyChart',
];

let server;
let base;
let ctx;

async function req(urlPath, { token = null, cookie = null, headers = {} } = {}) {
  const h = Object.assign({ Accept: 'application/json' }, headers);
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  const res = await fetch(`${base}${urlPath}`, { method: 'GET', headers: h, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

before(async () => {
  ctx = fakeDb.install({ admins: [ADMIN], users: [MEMBER, DISABLED, LOCKED], settings: [], fixtures: [], teamForms: [], leagues: [] });
  settingsService.invalidateCache();
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

const memberToken = () => auth.signToken({ sub: MEMBER.id, type: 'user', role: 'user', username: MEMBER.username });
const adminToken = () => auth.signToken({ sub: ADMIN.id, type: 'admin', role: ADMIN.role, username: ADMIN.username });

/* ------------------------------------------------------------------ */
/* 1. GUEST — the API                                                  */
/* ------------------------------------------------------------------ */

test('guest: every prediction API answers 401 Unauthorized with no data', async () => {
  for (const endpoint of PREDICTION_APIS) {
    const res = await req(endpoint);
    assert.equal(res.status, 401, `${endpoint} must refuse a guest with 401 (got ${res.status})`);
    assert.equal(res.json.ok, false, `${endpoint} returns the error envelope`);
    assert.equal(res.json.data, undefined, `${endpoint} must carry no data at all`);
    assert.match(res.json.error.code, /UNAUTHORIZED|TOKEN_INVALID|TOKEN_EXPIRED|AUTH_NOT_CONFIGURED/, `${endpoint} codes the refusal`);
    assert.equal(res.headers.get('cache-control'), 'no-store', `${endpoint} is never cached`);
    for (const marker of DATA_MARKERS) {
      assert.ok(!res.text.includes(marker), `${endpoint} must not leak "${marker}"`);
    }
  }
});

test('guest: a garbage, expired or forged token is refused exactly like no token', async () => {
  const expired = jwt.sign({ sub: MEMBER.id, type: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '-10s' });
  const wrongSecret = jwt.sign({ sub: MEMBER.id, type: 'user' }, 'not-the-real-secret', { algorithm: 'HS256' });
  const alg = Buffer.from(
    `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({ sub: MEMBER.id, type: 'user' })
    ).toString('base64url')}.`
  ).toString();

  for (const [name, token] of [
    ['garbage', 'not-a-jwt'],
    ['expired', expired],
    ['wrong secret', wrongSecret],
    ['alg=none', alg],
  ]) {
    const api = await req('/api/predictions', { token });
    assert.equal(api.status, 401, `a ${name} token must not open the API (got ${api.status})`);
    assert.equal(api.json.data, undefined, `a ${name} token must not receive data`);
    const page = await req('/predictions', { token });
    assert.equal(page.status, 401, `a ${name} token must not open the page (got ${page.status})`);
    assert.match(page.text, /Login or create an account/, `a ${name} token still gets the login door`);
  }
});

test('guest: a forged session cookie is refused, and no cookie is issued on refusal', async () => {
  const cookieName = require('../server/config').auth.cookieName;
  const api = await req('/api/predictions', { cookie: `${cookieName}=forged.jwt.value` });
  assert.equal(api.status, 401, 'a forged cookie opens nothing');
  assert.equal(api.json.data, undefined);
  const setCookie = api.headers.get('set-cookie');
  assert.ok(!setCookie, 'a refusal never plants a session cookie');
});

/* ------------------------------------------------------------------ */
/* 2. GUEST — the pages                                                */
/* ------------------------------------------------------------------ */

test('guest: every prediction page answers 401 with the login-required door', async () => {
  for (const page of PREDICTION_PAGES) {
    const res = await req(page);
    assert.equal(res.status, 401, `${page} must refuse a guest with 401 (got ${res.status})`);
    assert.match(res.headers.get('content-type') || '', /html/, `${page} answers with a page, not data`);
    assert.match(res.headers.get('cache-control') || '', /no-store/, `${page} is never cached`);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/, `${page} is never indexed`);

    const body = res.text;
    assert.match(body, /Members only/, `${page} states that the surface is member only`);
    assert.ok(body.includes('href="/login?next='), `${page} offers Login`);
    assert.ok(body.includes('href="/account.html#register"'), `${page} offers Create Account`);
    for (const marker of DATA_MARKERS) {
      assert.ok(!body.includes(marker), `${page} must not leak "${marker}"`);
    }
  }
});

test('guest: each protected page carries its own professional copy', async () => {
  const expectations = [
    ['/predictions', 'Football Predictions', 'Login or create an account to access GoalPredict AI football predictions.'],
    ['/ticket', "Today's AI Ticket", "Login to access today's verified football selections."],
    ['/today-ticket', "Today's AI Ticket", "Login to access today's verified football selections."],
    ['/history', 'Ticket History', 'Login to access the complete, settled GoalPredict ticket record.'],
    ['/analytics', 'Prediction Analytics', 'Login to access GoalPredict performance analytics and AI model statistics.'],
  ];
  // the view is HTML escaped on the way out, so compare against escaped copy
  const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  for (const [page, title, message] of expectations) {
    const res = await req(page);
    assert.equal(res.status, 401, `${page} is refused`);
    assert.ok(res.text.includes(`<title>${esc(title)} — Login required — GoalPredict</title>`), `${page} titles the door "${title}"`);
    assert.ok(res.text.includes(`<h1 class="lock-title">${esc(title)}</h1>`), `${page} heads the door with "${title}"`);
    assert.ok(res.text.includes(esc(message)), `${page} explains what is behind the door`);
  }
});

test('guest: the login-required page remembers where the visitor came from', async () => {
  const res = await req('/predictions');
  assert.ok(res.text.includes('href="/login?next=%2Fpredictions"'), 'the door carries a same-site next parameter');
  assert.ok(!/next=(https?:)?\/\//.test(res.text), 'next can never point off-site');
});

test('guest: the member page scripts are never a data source', () => {
  for (const name of ['predictions.js', 'ticket.js', 'history.js', 'analytics.js']) {
    const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js', name), 'utf8');
    assert.ok(!/api\.key|API_FOOTBALL|secret/i.test(js), `js/${name} carries no secret`);
    assert.match(js, /API\.get\(/, `js/${name} reads from our own API`);
  }
  // every one of them binds the shared session header, which is what hides the
  // member navigation and walks an expired session to the sign-in door
  for (const name of ['predictions.js', 'ticket.js', 'history.js', 'analytics.js']) {
    const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js', name), 'utf8');
    assert.match(js, /App\.session\.bindHeader\(\)/, `js/${name} wires the session-aware header`);
  }
});

test('guest: the shared client refuses to sit on a 401 — it walks to the sign-in door', () => {
  const apiJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'api.js'), 'utf8');
  assert.match(apiJs, /res\.status === 401/, 'a 401 is recognised');
  assert.match(apiJs, /session\.onUnauthorized\(\)/, 'and handed to the session helper');
  assert.match(apiJs, /window\.location\.replace\(`\/login\?next=/, 'which walks the browser to /login');
  assert.match(apiJs, /!path\.startsWith\('\/auth\/'\)/, 'the session check itself never triggers the walk');
});

test('guest: the member-only navigation ships hidden on every public page', () => {
  for (const page of ['index.html', 'about.html', 'legal.html', 'account.html']) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
    const entries = [...html.matchAll(/<a\s([^>]*data-member-only[^>]*)>/g)].map((m) => m[1]);
    assert.ok(entries.length >= 5, `${page} declares the member-only entries`);
    for (const attrs of entries) {
      assert.match(attrs, /class="[^"]*\bhidden\b/, `${page}: a member entry starts hidden`);
    }
    assert.ok(!/<a href="\/predictions\.html">/.test(html), `${page} has no plain predictions link`);
  }
  const apiJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'api.js'), 'utf8');
  assert.match(apiJs, /querySelectorAll\('\[data-member-only\]'\)/, 'the shared helper reveals them for a session');
});

/* ------------------------------------------------------------------ */
/* 3. MEMBER — the surfaces open                                       */
/* ------------------------------------------------------------------ */

test('member: every prediction API opens for a verified session', async () => {
  const token = memberToken();
  for (const endpoint of PREDICTION_APIS) {
    const res = await req(endpoint, { token });
    assert.notEqual(res.status, 401, `${endpoint} must not refuse a member`);
    assert.notEqual(res.status, 403, `${endpoint} must not forbid a member`);
    assert.ok([200, 404].includes(res.status), `${endpoint} answers a member (got ${res.status})`);
    if (res.status === 200) assert.equal(res.json.ok, true, `${endpoint} returns the success envelope`);
  }
});

test('member: every prediction page is served for a verified session', async () => {
  const token = memberToken();
  for (const page of ['/predictions', '/ticket', '/history', '/analytics']) {
    const res = await req(page, { token });
    assert.equal(res.status, 200, `${page} opens for a member (got ${res.status})`);
    assert.match(res.headers.get('cache-control') || '', /no-store/, `${page} is never cached`);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/, `${page} is never indexed`);
  }
});

test('member: the session cookie from the browser opens the same surfaces', async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: MEMBER.username, password: 'member-secret-99' }),
  });
  assert.equal(login.status, 200, 'the member signs in');
  const setCookie = typeof login.headers.getSetCookie === 'function'
    ? login.headers.getSetCookie()
    : [login.headers.get('set-cookie') || ''];
  const cookieName = require('../server/config').auth.cookieName;
  const session = setCookie.find((c) => c.trim().startsWith(`${cookieName}=`));
  assert.ok(session, 'a session cookie is issued');
  assert.match(session, /HttpOnly/i, 'the session cookie is httpOnly');

  const jar = session.split(';')[0];
  const api = await req('/api/predictions', { cookie: jar });
  assert.equal(api.status, 200, 'the cookie session opens the API like a browser would');
  const page = await req('/predictions', { cookie: jar });
  assert.equal(page.status, 200, 'the cookie session opens the page like a browser would');
});

/* ------------------------------------------------------------------ */
/* 4. USER SPECIFIC SECURITY — identity comes from the session          */
/* ------------------------------------------------------------------ */

test('security: a user id supplied by the browser never widens the payload', async () => {
  const attempts = [
    ['query string', '/api/predictions?userId=1'],
    ['query string (snake)', '/api/predictions?user_id=1&role=admin'],
    ['query string (admin flag)', '/api/analytics?admin=1&isAdmin=true'],
    ['ticket by id', '/api/ticket/today?userId=1'],
    ['history scope', '/api/tickets/history?userId=1'],
  ];
  for (const [label, url] of attempts) {
    const guest = await req(url);
    assert.equal(guest.status, 401, `${label} cannot turn a guest into a member (${url})`);
    assert.equal(guest.json.data, undefined);
  }

  // and a member cannot ask for somebody else's data either: the handler has
  // no parameter to widen the scope with, so the answer is the caller's own
  const token = memberToken();
  const res = await req('/api/tickets/history?userId=999', { token });
  assert.equal(res.status, 200, 'a member still receives their own history');
  assert.doesNotMatch(res.text, /999/, 'the payload carries no trace of the requested id');
});

test('security: a spoofed identity header is ignored', async () => {
  for (const header of [{ 'X-User-Id': '1' }, { 'X-Admin': 'true' }, { 'X-Role': 'admin' }]) {
    const guest = await req('/api/predictions', { headers: header });
    assert.equal(guest.status, 401, `a ${Object.keys(header)[0]} header cannot authenticate a guest`);
  }
  const res = await req('/api/predictions', { headers: { 'X-User-Id': '1', 'X-Role': 'admin' } });
  assert.equal(res.status, 401, 'headers alone never authenticate');
});

/* ------------------------------------------------------------------ */
/* 5. CLOSED ACCOUNTS                                                  */
/* ------------------------------------------------------------------ */

test('security: a deactivated or locked member is refused even with a valid token', async () => {
  for (const [label, row] of [['deactivated', DISABLED], ['locked', LOCKED]]) {
    const token = auth.signToken({ sub: row.id, type: 'user', role: 'user', username: row.username });
    const api = await req('/api/predictions', { token });
    assert.equal(api.status, 403, `a ${label} account is refused by the API (got ${api.status})`);
    assert.equal(api.json.data, undefined, `a ${label} account receives no data`);
    const page = await req('/predictions', { token });
    assert.equal(page.status, 403, `a ${label} account is refused by the page (got ${page.status})`);
    assert.match(page.text, /Login or create an account/, `a ${label} account gets the door`);
    assert.match(page.text, /disabled or temporarily locked/, `a ${label} account is told why`);
  }
});

test('security: a deleted member (no database row) is refused', async () => {
  const token = auth.signToken({ sub: 987654, type: 'user', role: 'user', username: 'ghost' });
  const api = await req('/api/predictions', { token });
  assert.equal(api.status, 401, 'a token for a deleted account is refused');
  assert.equal(api.json.data, undefined);
  const page = await req('/predictions', { token });
  assert.equal(page.status, 401, 'and the page is refused too');
});

/* ------------------------------------------------------------------ */
/* 6. ADMIN + public surfaces are untouched                            */
/* ------------------------------------------------------------------ */

test('admin: keeps every existing permission and can still read the surfaces', async () => {
  const token = adminToken();
  const overview = await req('/api/admin/overview', { token });
  assert.equal(overview.status, 200, 'the console API still answers');
  const predictions = await req('/api/predictions', { token });
  assert.equal(predictions.status, 200, 'an administrator is an authenticated principal');
  const page = await req('/predictions', { token });
  assert.equal(page.status, 200, 'and can open the member pages');
});

test('public: health, meta, the landing page and the legal pages stay open to everyone', async () => {
  for (const url of ['/api/health', '/api/meta', '/', '/about', '/legal', '/about.html', '/legal.html', '/login', '/account']) {
    const res = await req(url);
    assert.equal(res.status, 200, `${url} stays public (got ${res.status})`);
  }
  // the landing page never names a prediction endpoint
  const home = await req('/');
  for (const needle of ['/api/predictions', '/api/ticket', '/api/analytics', '/api/fixtures', '/api/odds']) {
    assert.ok(!home.text.includes(needle), `the homepage must not reference ${needle}`);
  }
  assert.match(home.text, /Unlock AI Football Predictions/, 'and it carries the unlock CTA');
  assert.match(home.text, /Login to view today's predictions/, 'plus the sign-in CTA');
});

test('public: the login-required view is not a static asset anyone can fetch', async () => {
  for (const url of ['/login-required.html', '/views/login-required.html', '/server/views/login-required.html']) {
    const res = await req(url);
    assert.equal(res.status, 404, `${url} is not served as a file`);
  }
});
