'use strict';

/**
 * DASHBOARD ACTIVITY — the three states that matter:
 *
 *   guest         -> the section is hidden and unreachable: the page redirects
 *                    to the sign-in page and the API answers 401 Unauthorized
 *   member        -> visible and working, scoped to the caller's OWN account
 *                    (another member's events can never be requested)
 *   administrator -> keeps the existing admin permissions (console + own feed)
 *
 * The suite boots the real Express app with the in-memory database double, so
 * it exercises the same middleware, routes and SQL as production.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'dashboard-activity-test-secret';
delete process.env.API_FOOTBALL_KEY;
delete process.env.API_FOOTBALL_HOST;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const fakeDb = require('./fakeDb');
const auth = require('../server/middleware/auth');
const settingsService = require('../server/services/settingsService');
const { createApp, PUBLIC_DIR } = require('../server/app');

const MEMBER_PASSWORD = 'member-secret-99';
const ADMIN_PASSWORD = 'admin-test-pass-1';

const ADMIN = {
  id: 1,
  email: 'admin@test.local',
  username: 'admin',
  // a real hash so the operator verifier can exercise the admin sign-in too
  password_hash: bcrypt.hashSync(ADMIN_PASSWORD, 4),
  role: 'superadmin',
  is_active: 1,
  locked_until: null,
  must_change_password: 0,
  last_login_at: null,
  created_at: '2026-08-01 09:00:00',
};

const MEMBER = {
  id: 41,
  email: 'fan@test.local',
  username: 'ticketfan',
  password_hash: bcrypt.hashSync(MEMBER_PASSWORD, 4),
  role: 'user',
  is_active: 1,
  failed_logins: 0,
  locked_until: null,
  last_login_at: null,
  last_login_ip: null,
  created_at: '2026-09-01 10:00:00',
  updated_at: '2026-09-01 10:00:00',
};

const OTHER_MEMBER = {
  id: 42,
  email: 'other@test.local',
  username: 'otherfan',
  password_hash: 'x',
  role: 'user',
  is_active: 1,
  failed_logins: 0,
  locked_until: null,
  last_login_at: null,
  created_at: '2026-09-02 10:00:00',
  updated_at: '2026-09-02 10:00:00',
};

const DISABLED_MEMBER = {
  id: 43,
  email: 'closed@test.local',
  username: 'closedfan',
  password_hash: 'x',
  role: 'user',
  is_active: 0,
  failed_logins: 0,
  locked_until: null,
  last_login_at: null,
  created_at: '2026-09-03 10:00:00',
  updated_at: '2026-09-03 10:00:00',
};

// audit rows: two for the member, one for another member, one for the admin
const SYSTEM_LOGS = [
  {
    id: 1,
    level: 'info',
    channel: 'auth',
    event: 'USER_REGISTERED',
    message: 'Member ticketfan registered',
    actor_type: 'user',
    actor_id: 41,
    ip_address: '203.0.113.9',
    user_agent: null,
    context_json: null,
    created_at: '2026-09-01 10:00:00',
  },
  {
    id: 2,
    level: 'info',
    channel: 'auth',
    event: 'USER_PASSWORD_CHANGED',
    message: 'Member ticketfan changed the password',
    actor_type: 'user',
    actor_id: 41,
    ip_address: '203.0.113.9',
    user_agent: null,
    context_json: null,
    created_at: '2026-09-10 12:00:00',
  },
  {
    id: 3,
    level: 'info',
    channel: 'auth',
    event: 'USER_PASSWORD_CHANGED',
    message: 'Member otherfan changed the password',
    actor_type: 'user',
    actor_id: 42,
    ip_address: '198.51.100.4',
    user_agent: null,
    context_json: null,
    created_at: '2026-09-11 12:00:00',
  },
  {
    id: 4,
    level: 'info',
    channel: 'audit',
    event: 'ADMIN_LOGIN',
    message: 'Administrator admin signed in',
    actor_type: 'admin',
    actor_id: 1,
    ip_address: '198.51.100.10',
    user_agent: null,
    context_json: null,
    created_at: '2026-09-12 07:30:00',
  },
];

let server;
let base;
let ctx;
let adminBearer;
let memberBearer;
let disabledBearer;

async function req(method, urlPath, { token = null, body = null, redirect = 'follow' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    redirect,
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

before(async () => {
  ctx = fakeDb.install({
    admins: [ADMIN],
    settings: [],
    users: [MEMBER, OTHER_MEMBER, DISABLED_MEMBER],
    systemLogs: SYSTEM_LOGS,
  });
  settingsService.invalidateCache();

  adminBearer = auth.signToken({ sub: ADMIN.id, type: 'admin', role: ADMIN.role, username: ADMIN.username });
  memberBearer = auth.signToken({ sub: MEMBER.id, type: 'user', role: 'user', username: MEMBER.username });
  disabledBearer = auth.signToken({ sub: DISABLED_MEMBER.id, type: 'user', role: 'user', username: DISABLED_MEMBER.username });

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
/* 1. GUEST — hidden and inaccessible                                  */
/* ------------------------------------------------------------------ */

test('guest: dashboard activity is hidden on the public homepage', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.ok(!/dashboard activity/i.test(home.text), 'the visitor page never mentions dashboard activity');
  assert.ok(!home.text.includes('/api/dashboard'), 'the visitor page never references the protected endpoint');

  // the public page scripts carry no dashboard feed code either
  const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'app.js'), 'utf8');
  assert.ok(!appJs.includes('/api/dashboard'), 'js/app.js never calls the dashboard API');
  assert.ok(!appJs.includes('activityFeed'), 'js/app.js never renders the activity feed');

  // no public HTML file other than the member dashboard itself may contain it
  for (const entry of fs.readdirSync(PUBLIC_DIR)) {
    if (!entry.endsWith('.html') || entry === 'dashboard.html') continue;
    const html = fs.readFileSync(path.join(PUBLIC_DIR, entry), 'utf8');
    assert.ok(!/dashboard activity/i.test(html), `${entry} must not render dashboard activity`);
    assert.ok(!html.includes('/api/dashboard'), `${entry} must not reference the dashboard API`);
  }
});

test('guest: the activity API answers 401 and the member page redirects to sign-in', async () => {
  // opening the API URL directly returns 401 Unauthorized — and no data
  const api = await get('/api/dashboard/activity');
  assert.equal(api.status, 401);
  assert.equal(api.json.ok, false);
  assert.equal(api.json.error.code, 'UNAUTHORIZED');
  assert.ok(!('data' in api.json), 'no dashboard payload is returned to a visitor');
  assert.match(api.headers.get('cache-control') || '', /no-store/, 'even the refusal is never cached');

  // ... also with a forged / expired token
  const forged = await get('/api/dashboard/activity', { token: 'not-a-real-jwt' });
  assert.equal(forged.status, 401);

  // the member page is never served to a visitor: both URLs bounce to sign-in
  for (const url of ['/dashboard', '/dashboard.html']) {
    const res = await req('GET', url, { redirect: 'manual' });
    assert.equal(res.status, 302, `${url} redirects a guest`);
    assert.equal(res.headers.get('location'), '/account.html');
    assert.ok(!/dashboard activity/i.test(res.text), `${url} ships no member content`);
  }

  // the admin console data stays unreachable as well
  assert.equal((await get('/api/admin/overview')).status, 401);
});

/* ------------------------------------------------------------------ */
/* 2. LOGGED-IN MEMBER — visible and working                           */
/* ------------------------------------------------------------------ */

test('member: dashboard activity is served for the caller only', async () => {
  // the member signs in like a browser does (cookies are set as a side effect)
  const login = await post('/api/auth/login', { login: MEMBER.username, password: MEMBER_PASSWORD });
  assert.equal(login.status, 200);
  const token = login.json.data.token;
  assert.ok(login.headers.get('set-cookie'), 'the session cookie pair is issued');

  const res = await get('/api/dashboard/activity', { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.audience, 'authenticated');
  assert.equal(res.json.data.scope, 'self');
  assert.equal(res.json.data.account.username, MEMBER.username);
  assert.equal(res.json.data.account.type, 'user');

  // the feed contains the member's own events, including the fresh USER_LOGIN
  const events = res.json.data.items.map((item) => item.event);
  assert.ok(events.includes('USER_LOGIN'), 'the successful sign-in is recorded');
  assert.ok(events.includes('USER_REGISTERED'));
  assert.ok(res.json.data.summary.recordedEvents >= 3, 'the summary counts the account events');

  // and NOTHING from another account, even though the rows exist in the table
  assert.ok(!res.json.data.items.some((item) => item.id === 3), "another member's row never leaks");
  const text = JSON.stringify(res.json);
  assert.ok(!text.includes('otherfan'), "another member's username never leaks");
  assert.ok(!text.includes('198.51.100.4'), "another member's IP is never echoed");

  // a client cannot ask for somebody else's feed — the scope is the session
  const spoof = await get('/api/dashboard/activity?actorId=42&userId=42&scope=all', { token });
  assert.equal(spoof.status, 200);
  const spoofText = JSON.stringify(spoof.json);
  assert.ok(!spoofText.includes('otherfan'), 'query parameters can never widen the scope');
  assert.ok(!spoof.json.data.items.some((item) => item.id === 3));

  // the protected page is served to the signed-in member, uncached and unindexed
  const page = await get('/dashboard', { token });
  assert.equal(page.status, 200);
  assert.match(page.text, /Dashboard Activity/, 'the section exists for signed-in members');
  assert.match(page.headers.get('cache-control') || '', /no-store/);
  assert.match(page.headers.get('x-robots-tag') || '', /noindex/);

  // the API response is not cached either
  assert.match(res.headers.get('cache-control') || '', /no-store/);

  // the session endpoint itself is never cached and refuses a disabled account
  const meRes = await get('/api/auth/me', { token });
  assert.equal(meRes.status, 200);
  assert.match(meRes.headers.get('cache-control') || '', /no-store/);

  // a disabled account loses access immediately, even with a valid token
  const disabled = await get('/api/dashboard/activity', { token: disabledBearer });
  assert.equal(disabled.status, 403);
  assert.equal(disabled.json.error.code, 'ACCOUNT_DISABLED');
  const disabledMe = await get('/api/auth/me', { token: disabledBearer });
  assert.equal(disabledMe.status, 403, 'a disabled session cannot even paint the member header');
});

test('contract: a signed-in member can discover the dashboard from the account page', () => {
  const account = fs.readFileSync(path.join(PUBLIC_DIR, 'account.html'), 'utf8');
  assert.match(account, /href="\/dashboard"/, 'the member account page links to the dashboard');
  // the public sign-in page never advertises the feed itself
  assert.ok(!/dashboard activity/i.test(account), 'the guest-facing page does not render the feed');
  assert.ok(!account.includes('/api/dashboard'), 'and never references the protected endpoint');
});

test('contract: public/dashboard.html defines every element dashboard.js drives', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'dashboard.js'), 'utf8');

  const ids = new Set();
  for (const match of js.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'\s*\)/g)) ids.add(match[1]);
  for (const match of js.matchAll(/setText\(\s*'#([A-Za-z0-9_-]+)'/g)) ids.add(match[1]);
  assert.ok(ids.size >= 10, 'dashboard.js is expected to drive the member cards');
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `public/dashboard.html must define #${id}`);
  }

  // the activity card exists but starts hidden: only the authenticated payload reveals it
  const card = html.match(/<section[^>]*id="activityCard"[^>]*>/);
  assert.ok(card, 'the Dashboard Activity card exists');
  assert.match(card[0], /\bhidden\b/, 'the card is hidden until the server confirms the session');
  assert.ok(!/\son(click|load|error)=/i.test(html), 'no inline event handlers (CSP forbids them)');
  assert.ok(!html.includes('fetch('), 'the page uses the shared API helper, not ad-hoc requests');

  // a page restored from the back/forward cache must be wiped and re-checked,
  // and signing out must clear the feed before leaving the page
  assert.match(js, /addEventListener\('pageshow'/, 'bfcache restores are handled');
  assert.match(js, /event\.persisted/, 'and only acted on for real restores');
  assert.match(js, /clearActivity\(\);\s*\/\/ never leave the feed/);
  assert.match(js, /await API\.get\('\/auth\/me'\)/, 'the restore path re-validates the session server side');
});

/* ------------------------------------------------------------------ */
/* 3. ADMINISTRATOR — the existing admin permissions are preserved      */
/* ------------------------------------------------------------------ */

test('admin: the console keeps its permissions and the feed stays admin scoped', async () => {
  // the admin console API still works exactly as before
  const overview = await get('/api/admin/overview', { token: adminBearer });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.ok, true);
  assert.ok(overview.json.data.recentSyncs, 'the console activity panel keeps its data');

  // the admin has their own dashboard activity (admin scoped, not the member's)
  const res = await get('/api/dashboard/activity', { token: adminBearer });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.account.type, 'admin');
  assert.equal(res.json.data.account.username, ADMIN.username);
  const text = JSON.stringify(res.json);
  assert.ok(!text.includes('ticketfan'), "the admin's feed is not mixed with member rows");

  // an administrator opening the member dashboard is still sent to the console
  const page = await req('GET', '/dashboard', { token: adminBearer, redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/admin.html');

  // and members still cannot touch the admin surface
  const forbidden = await get('/api/admin/overview', { token: memberBearer });
  assert.ok([401, 403].includes(forbidden.status), 'member tokens are rejected by admin routes');
});

/* ------------------------------------------------------------------ */
/* 4. the operator-facing verifier works against this very server      */
/* ------------------------------------------------------------------ */

test('tooling: scripts/verify-access.js reports a clean pass against the running app', async () => {
  // Must be ASYNC: execFileSync would block this process's event loop, and the
  // app under test runs in it — the verifier's requests could never be served.
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const report = await promisify(execFile)(
    process.execPath,
    [
      path.join(__dirname, '..', 'scripts', 'verify-access.js'),
      `--base=${base}`,
      '--member=ticketfan:member-secret-99',
      `--admin=${ADMIN.username}:${ADMIN_PASSWORD}`,
      '--json',
    ],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, timeout: 60000 }
  ).then((r) => r.stdout);
  const parsed = JSON.parse(report);
  assert.equal(parsed.failed, 0, report);
  assert.ok(parsed.passed >= 20, 'the verifier checks the guest, member and admin states');
  assert.ok(parsed.results.some((r) => r.name.startsWith('guest:')));
  assert.ok(parsed.results.some((r) => r.name.startsWith('member:')));
  assert.ok(parsed.results.some((r) => r.name.startsWith('admin:')));
});
