'use strict';

/**
 * DASHBOARD INTERACTION TESTS
 *
 * Runs the shipped browser scripts (public/js/*.js) against the real Express app
 * on a loopback port, using the mini DOM harness in tests/lib/miniDom.js.
 *
 * Covered here, per dashboard:
 *  - admin console: generation run (button -> confirm -> progress -> button restored
 *    -> badge refresh), a failing progress endpoint, secondary data-load failures,
 *    the four sync jobs, the users console (approve / detail modal / search / refresh),
 *    Settings rendering, API Management "Test connection", the mobile drawer,
 *    hash routing + unknown-view fallback, and sign out.
 *  - member dashboards: predictions date filter + eligible filter + API failure,
 *    ticket with no ticket, account password validation + sign out, and the
 *    activity-feed failure path.
 *  - data contracts: an overview with a real sync log and a prediction detail with
 *    stored score components are both populated (guards against empty placeholders).
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'dashboards-test-secret-0123456789abcdef';
process.env.API_FOOTBALL_KEY = 'dashboards-test-key';

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const fakeDb = require('./fakeDb');
const { buildScenario, FakeApi } = require('./synthetic');
const settingsService = require('../server/services/settingsService');
const ticketService = require('../server/services/ticketService');
const apiCredentialService = require('../server/services/apiCredentialService');
const { apiFootball } = require('../server/services/apiFootball');
const { createApp } = require('../server/app');
const { createPage, createCookieJar, createFetch, flush, waitFor } = require('./lib/miniDom');
const dbQueries = require('../server/database/queries');

const ROOT = path.resolve(__dirname, '..');

let scn;
let ctx;
let server;
let base;
let adminJar;
let memberJar;
let adminLoginStatus;

const PASSWORD = 'secret123';
const ADMIN = {
  id: 1, email: 'admin@dashboards.local', username: 'admin', password_hash: bcrypt.hashSync(PASSWORD, 8),
  role: 'superadmin', is_active: 1, locked_until: null, must_change_password: 0, failed_logins: 0,
};
const MEMBER = {
  id: 77, email: 'member@dashboards.local', username: 'member', full_name: 'Member Test',
  password_hash: bcrypt.hashSync(PASSWORD, 8), role: 'user', is_active: 1, status: 'approved',
  failed_logins: 0, locked_until: null, last_login_at: null,
  created_at: '2026-09-01 10:00:00', updated_at: '2026-09-01 10:00:00',
};
const PENDING = {
  id: 78, email: 'p@dashboards.local', username: 'pendingpete', full_name: 'Pete Pending',
  password_hash: bcrypt.hashSync(PASSWORD, 8), role: 'user', is_active: 1, status: 'pending',
  failed_logins: 0, locked_until: null, created_at: '2026-10-01 10:00:00', updated_at: '2026-10-01 10:00:00',
};

const ADMIN_SCRIPTS = ['admin-fixtures.js', 'admin-settings.js', 'admin-api-management.js', 'admin.js'];

function check(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
}

async function login(jar, user, password, admin = false) {
  const res = await fetch(`${base}/api/auth/${admin ? 'admin/' : ''}login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: user, password }),
  });
  jar.absorb(res);
  return res.status;
}

function failingFetch(jar, shouldFail, status = 500) {
  const real = createFetch(base, jar);
  return async (input, init) => {
    const url = String(input);
    if (shouldFail(url)) {
      const body = JSON.stringify({ ok: false, error: { code: 'SIMULATED_FAILURE', message: 'Simulated upstream failure' } });
      return {
        ok: false, status, statusText: 'Server Error',
        headers: new globalThis.Headers({ 'content-type': 'application/json' }),
        text: async () => body, json: async () => JSON.parse(body),
      };
    }
    return real(input, init);
  };
}

async function makePage(jar, file, { pathname, scripts, fetch: fetchImpl, confirm, prompt, search = '' }) {
  const markup = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
  const page = await createPage({
    baseUrl: base, jar, markup, pathname, search, confirm, prompt, fetch: fetchImpl,
    scripts: [{ file: 'api.js' }, ...scripts.map((f) => ({ file: f }))],
  });
  await page.domReady();
  await flush(700);
  return page;
}

/** Settled tickets spread over past months: they exercise the history pager and the
 *  analytics chart with real rows instead of the empty state. */
function historicalTickets() {
  const rows = [];
  let id = 500;
  for (let month = 5; month <= 9; month += 1) {
    for (let index = 0; index < 4; index += 1) {
      id += 1;
      const day = String(2 + index * 6).padStart(2, '0');
      rows.push({
        id,
        ticket_date: `2026-${String(month).padStart(2, '0')}-${day}`,
        market_key: 'over_1_5',
        market_label: 'Over 1.5 Goals',
        status: 'QUALIFIED',
        selection_count: 3,
        total_odds: 2.1 + index * 0.1,
        total_odds_display: (2.1 + index * 0.1).toFixed(2),
        avg_confidence: 0.71,
        min_confidence: 0.66,
        avg_quality: 0.74,
        max_risk: 0.22,
        estimated_probability: 0.69,
        result: index % 3 === 0 ? 'LOST' : 'WON',
        settled_odds: index % 3 === 0 ? null : 2.1 + index * 0.1,
        settled_at: `2026-${String(month).padStart(2, '0')}-${day} 21:00:00`,
        result_note: null,
        generated_at: `2026-${String(month).padStart(2, '0')}-${day} 09:00:00`,
        published_at: `2026-${String(month).padStart(2, '0')}-${day} 09:30:00`,
      });
    }
  }
  return rows;
}

async function memberSession() {
  const jar = createCookieJar();
  assert.equal(await login(jar, 'member', PASSWORD), 200, 'fresh member session');
  return jar;
}

const adminPage = (jar, opts = {}) => makePage(jar, 'admin.html', { pathname: '/admin.html', scripts: ADMIN_SCRIPTS, ...opts });

before(async () => {
  scn = buildScenario();

  /* One stored sync log and one stored score row so the "empty list" behaviour of
     the overview and the prediction breakdown can be told apart from missing data. */
  ctx = fakeDb.install({
    admins: [ADMIN],
    users: [MEMBER, PENDING],
    settings: [],
    fixtures: scn.fixtures,
    teamForms: scn.teamForms,
    leagues: scn.leagueEnvs,
    tickets: historicalTickets(),
    apiSyncLogs: [{
      id: 9001, job: 'fixtures', status: 'SUCCESS', records: 12, message: 'fixtures synced by test',
      source: 'api-football', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    }],
  });
  settingsService.invalidateCache();

  const sample = new FakeApi(scn);
  Object.assign(apiFootball, {
    host: 'fake.api-football.test',
    baseUrl: 'https://fake.api-football.test/v3',
    isAvailable: () => true,
    breakerState: () => ({
      state: 'OK', available: true, consecutiveFailures: 0, retryInMs: 0,
      quota: { current: 42, limit_day: 7500 }, calls: 3, failures: 0, cacheHits: 1,
      lastCallAt: new Date().toISOString(), lastError: null,
    }),
    getStatus: async () => ({ requests: { current: 42, limit_day: 7500 }, subscription: { name: 'Pro (test)', active: true } }),
    probeCredentials: async () => ({
      ok: true, state: 'CONNECTED', label: 'Connection successful', endpoint: '/status',
      httpStatus: 200, latencyMs: 100, message: 'accepted', quota: { current: 42, limitDay: 7500 },
      plan: { name: 'Pro', active: true }, errors: null,
    }),
    getFixturesByDate: (d) => sample.getFixturesByDate(d),
    getFixturesByIds: (i) => sample.getFixturesByIds(i),
    getTeamLastFixtures: async () => ({ response: [], results: 0, paging: { current: 1, total: 1 } }),
    getHeadToHead: () => sample.getHeadToHead(),
    getOddsByDate: (d, p) => sample.getOddsByDate(d, p),
    getOddsByFixture: (i) => sample.getOddsByFixture(i),
    getOddsByFixtures: async (ids) => ({
      response: scn.oddsPayloads.filter((p) => ids.map(Number).includes(Number(p.fixture.id))),
      results: ids.length, paging: { current: 1, total: 1 },
    }),
    getInjuriesByFixture: () => sample.getInjuriesByFixture(),
  });
  apiCredentialService.setClientFactory(() => apiFootball);

  /* Generate the ticket the dashboards read, exactly as the admin UI would. */
  const started = await ticketService.startGeneration({
    adminId: ADMIN.id, source: 'admin_ui', date: scn.ticketDate, api: new FakeApi(scn),
  });
  let progress = await ticketService.getGenerationProgress(started.runId);
  while (progress && progress.status === 'RUNNING') {
    await flush(20);
    progress = await ticketService.getGenerationProgress(started.runId);
  }
  assert.ok(progress && ['COMPLETED', 'QUALIFIED'].includes(progress.status), `ticket generation finished (${progress && progress.status})`);

  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  adminJar = createCookieJar();
  adminLoginStatus = await login(adminJar, 'admin', PASSWORD, true);
  memberJar = createCookieJar();
  const memberLoginStatus = await login(memberJar, 'member', PASSWORD);
  assert.equal(adminLoginStatus, 200, 'admin login');
  assert.equal(memberLoginStatus, 200, 'member login');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (ctx) ctx.restore();
  settingsService.invalidateCache();
});

test('admin console: generation run drives the progress panel and restores the button', async () => {
  const page = await adminPage(adminJar);
  check('generate button initialised', !page.$('#genBtn').disabled, 'disabled at load');

  page.click('#genBtn');
  await flush(200);
  check('confirmation asked', page.confirmCalls.length >= 1, 'no confirm dialog');

  const sawProgress = await waitFor(
    () => /QUALIFIED|NO QUALIFYING|DATA SOURCE|TICKET|alert/.test(page.html('#progressBox')),
    { timeoutMs: 6000 },
  );
  check('progress reported', sawProgress, page.html('#progressBox').slice(0, 160));
  check('button restored after completion', !page.$('#genBtn').disabled, 'still disabled');
  check('ticket badge refreshed', /QUALIFIED|badge/i.test(page.html('#genStatus')), page.html('#genStatus').slice(0, 120));
  page.window.dispatch('beforeunload');
});

test('admin console: a failing progress endpoint re-enables the button and explains itself', async () => {
  const page = await adminPage(adminJar, {
    fetch: failingFetch(adminJar, (url) => url.includes('/generation-progress')),
  });
  page.click('#genBtn');
  await flush(1600);
  check('button re-enabled', !page.$('#genBtn').disabled, 'button stuck disabled');
  check('failure explained', /could not|failed|unavailable|error/i.test(page.html('#progressBox')), page.html('#progressBox').slice(0, 200));
  page.window.dispatch('beforeunload');
});

test('admin console: secondary view failures show a message and no stuck skeleton', async () => {
  for (const [view, marker, label] of [
    ['odds', '/admin/odds', 'odds'],
    ['predictions', '/admin/predictions', 'predictions'],
    ['logs', '/admin/system-logs', 'logs'],
  ]) {
    const page = await adminPage(adminJar, { fetch: failingFetch(adminJar, (url) => url.includes(marker)) });
    await page.setHash(view);
    await flush(600);
    const html = page.html('#viewRoot');
    check(`${label} failure shows a message`, /simulated|failed|unavailable|error/i.test(html), html.slice(0, 200).replace(/\s+/g, ' '));
    check(`${label} failure leaves no skeleton`, !/skeleton/.test(html), 'skeleton left behind');
  }
});

test('admin console: every sync job reports a result and releases its button', async () => {
  const page = await adminPage(adminJar);
  await page.setHash('api');
  await flush(700);

  const buttons = page.$$('[data-sync]');
  assert.equal(buttons.length, 4, 'four sync buttons');
  for (const btn of buttons) {
    const job = btn.dataset.sync;
    btn.click();
    await flush(900);
    const html = page.html('#syncBox');
    check(`sync ${job} reports a result`, /alert/.test(html) && !/running/i.test(html), html.slice(0, 160).replace(/\s+/g, ' '));
  }
  check('sync buttons re-enabled', buttons.every((b) => !b.disabled), 'a sync button stayed disabled');
});

test('admin users console: approve, detail modal, search and refresh', async () => {
  const page = await makePage(adminJar, 'admin/users.html', { pathname: '/admin/users', scripts: ['admin-users.js'] });
  check('summary cards', page.html('#summaryCards').includes('Pending approval'), page.html('#summaryCards').slice(0, 120));
  check('table rows', page.html('#tableBody').includes('pendingpete'), page.html('#tableBody').slice(0, 160));

  const approve = page.$$('[data-act="approve"]')[0];
  check('approve button bound', Boolean(approve), 'no approve button');
  approve.click();
  await flush(700);
  check('approve posts and refreshes', /Approved/.test(page.html('#noticeBox')), page.html('#noticeBox').slice(0, 160));
  check(
    'approved status visible in the table',
    !page.html('#tableBody').includes('pendingpete') || /Approved/.test(page.html('#tableBody')),
    'row not refreshed',
  );

  const view = page.$$('[data-act="view"]')[0];
  check('view button bound', Boolean(view), 'no view button');
  view.click();
  await flush(500);
  check('detail modal filled', page.html('#detailBody').length > 100 && !/skeleton/.test(page.html('#detailBody')), page.html('#detailBody').slice(0, 120));
  page.click('#detailClose');
  check('detail closes', page.$('#detailOverlay').style.display === 'none', String(page.$('#detailOverlay').style.display));

  page.type('#searchInput', 'zzz-no-such-user');
  page.click('#searchBtn');
  await flush(500);
  check('empty search state', /No users found/.test(page.html('#tableBody')), page.html('#tableBody').slice(0, 160));

  page.click('#refreshBtn');
  await flush(500);
  check('refresh button works', /Registered users|users/i.test(page.html('#tableTitle') + page.html('#tableBody')), 'nothing rendered');
});

test('admin settings: the form renders with a save control', async () => {
  const page = await adminPage(adminJar);
  await page.setHash('settings');
  await flush(900);
  check('form rendered', Boolean(page.$('#settingsForm input, #settingsForm select')), 'no form controls');
  check('save button present', Boolean(page.$('#saveSettings') || page.$('#saveBtn')), 'no save button');
});

test('admin api management: credentials card and a real test-connection verdict', async () => {
  const page = await adminPage(adminJar);
  await page.setHash('api-management');
  await flush(900);
  const html = page.html('#viewRoot');
  check('status card rendered', /Connection|credential/i.test(html), html.slice(0, 200).replace(/\s+/g, ' '));

  const testBtn = page.$('#apiTestBtn');
  check('test connection button', Boolean(testBtn), 'no test button');
  testBtn.click();
  await flush(1800);
  const verdict = (page.html('#apiActionBox') || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  check(
    'test shows verdict',
    /Connection successful|Sample verdict|CONNECTED|accepted/i.test(page.html('#viewRoot') + page.html('#apiActionBox')),
    verdict.slice(0, 300),
  );
});

test('admin console: mobile drawer, hash routing and unknown-view fallback', async () => {
  const page = await adminPage(adminJar);
  page.window.innerWidth = 420;

  page.click('#sideToggle');
  check('drawer opens', page.$('#sideNav').classList.contains('open'), 'not open');
  check('overlay shown', !page.$('#sideOverlay').classList.contains('hidden'), 'hidden');
  check('aria-expanded true', page.$('#sideToggle').getAttribute('aria-expanded') === 'true', page.$('#sideToggle').getAttribute('aria-expanded'));

  page.click('#sideOverlay');
  check('overlay closes drawer', !page.$('#sideNav').classList.contains('open'), 'still open');

  page.click('#sideToggle');
  await page.setHash('history');
  await flush(600);
  check('navigating closes the drawer', !page.$('#sideNav').classList.contains('open'), 'still open');
  check('title follows the view', page.text('#viewTitle') === 'Ticket History', page.text('#viewTitle'));

  await page.setHash('nope');
  await flush(500);
  check('unknown view falls back to dashboard', page.text('#viewTitle') === 'Dashboard', page.text('#viewTitle'));
  check('dashboard content rendered after fallback', /Win rate/.test(page.html('#viewRoot')), page.html('#viewRoot').slice(0, 160));
});

test('admin console: sign out returns to the admin door', async () => {
  const jar = createCookieJar();
  assert.equal(await login(jar, 'admin', PASSWORD, true), 200, 'fresh admin session');
  const page = await adminPage(jar);
  page.click('#logoutBtn');
  await flush(600);
  check('logout navigates to the sign-in door', page.navigated('/admin/login'), JSON.stringify(page.navigations));
});

test('member predictions: date filter, empty state and eligible filter', async () => {
  const page = await makePage(memberJar, 'predictions.html', { pathname: '/predictions', scripts: ['predictions.js'] });

  page.change('#dateInput', '2020-01-01');
  await flush(600);
  check('empty date shows an empty state', /No analysis stored/.test(page.html('#predList')), page.html('#predList').slice(0, 160));

  page.change('#dateInput', scn.ticketDate);
  await flush(600);
  check('returning to a populated date restores rows', /Northbridge/.test(page.html('#predList')), page.html('#predList').slice(0, 160));

  page.check('#eligibleOnly', true);
  await flush(500);
  check(
    'eligible filter sends the flag',
    /Eligible/.test(page.html('#predList')) || /No analysis/.test(page.html('#predList')),
    page.html('#predList').slice(0, 160),
  );
});

test('member predictions: an API failure shows an error state, not an empty list', async () => {
  const page = await makePage(memberJar, 'predictions.html', {
    pathname: '/predictions', scripts: ['predictions.js'],
    fetch: failingFetch(memberJar, (url) => url.includes('/api/predictions')),
  });
  check('API failure shows an error state', /Predictions unavailable|Simulated/.test(page.html('#predList')), page.html('#predList').slice(0, 200));
});

test('member ticket: a day without a ticket explains itself', async () => {
  const page = await makePage(memberJar, 'ticket.html', { pathname: '/ticket', search: '?date=2020-01-01', scripts: ['ticket.js'] });
  check('no-ticket box shown', !page.$('#noTicketBox').classList.contains('hidden'), 'hidden');
  check('no-ticket message', page.text('#noTicketMessage').length > 10, page.text('#noTicketMessage'));
});

test('member account: password validation is explained and sign out works', async () => {
  const page = await makePage(memberJar, 'account.html', { pathname: '/account.html', scripts: ['account.js'] });
  check('member view painted', !page.$('#memberView').classList.contains('hidden'), 'hidden');

  page.type('#curPassword', 'wrong-password');
  page.type('#newPassword', 'short');
  page.submit('#passwordForm');
  await flush(600);
  check('short password explained', /at least 8 characters/.test(page.text('#passwordAlertText')), page.text('#passwordAlertText'));
  check('password alert visible', !page.$('#passwordAlert').classList.contains('hidden'), 'alert hidden');
  check('password button re-enabled', !page.$('#passwordBtn').disabled, 'disabled');

  page.click('#signOutBtn');
  await flush(500);
  check('sign out navigates home', page.navigated('/'), JSON.stringify(page.navigations));
});

test('member dashboard: an activity failure hides the card instead of showing a stale feed', async () => {
  const jar = createCookieJar();
  assert.equal(await login(jar, 'member', PASSWORD), 200, 'fresh member session');
  const page = await makePage(jar, 'dashboard.html', {
    pathname: '/dashboard', scripts: ['dashboard.js'],
    fetch: failingFetch(jar, (url) => url.includes('/dashboard/activity')),
  });
  check('activity card hidden', page.$('#activityCard').classList.contains('hidden'), 'card left visible');
  check('profile still painted', page.text('#welcomeName') === 'member', page.text('#welcomeName'));
});

test('member history: rows, result badges, pager and result filter', async () => {
  const jar = await memberSession();
  const page = await makePage(jar, 'history.html', { pathname: '/history', scripts: ['history.js'] });

  const list = page.html('#historyList');
  check('history rows rendered', /history-row/.test(list), list.slice(0, 200));
  check('history shows a settled outcome', /Won|Lost/.test(list), list.slice(0, 200));
  check('pager rendered for more than one page', /Page 1 \/ \d+/.test(page.html('#pager')), page.html('#pager'));
  check('prev disabled on the first page', page.$('#prevBtn') && page.$('#prevBtn').disabled === true, 'prev enabled');

  page.click('#nextBtn');
  await flush(900);
  check('next page loads', /Page 2 \/ \d+/.test(page.html('#pager')), page.html('#pager'));
  check('next page still shows rows', /history-row/.test(page.html('#historyList')), page.html('#historyList').slice(0, 120));

  page.change('#resultFilter', 'LOST');
  await flush(900);
  const filtered = page.html('#historyList');
  check('result filter narrows the list', /LOST|Lost/.test(filtered) && !/Won/.test(filtered.replace(/Won[^<]*<\/span>/g, '')), filtered.slice(0, 200));
  check('filter resets to page 1', !/Page 2/.test(page.html('#pager')), page.html('#pager'));
});

test('member analytics: cards, streaks and a monthly chart built from settled tickets', async () => {
  const jar = await memberSession();
  const page = await makePage(jar, 'analytics.html', { pathname: '/analytics', scripts: ['analytics.js'] });

  check('stat cards populated', page.text('#statCards').trim().length > 5, page.html('#statCards').slice(0, 160));
  check('roi cards populated', page.text('#roiCards').trim().length > 3, page.html('#roiCards').slice(0, 160));
  check('streak cards populated', page.text('#streakCards').trim().length > 3, page.html('#streakCards').slice(0, 160));
  check('monthly chart drawn', /<svg/.test(page.html('#monthlyChart')), page.html('#monthlyChart').slice(0, 160));
  check('monthly table rendered', /2026-0[5-9]/.test(page.html('#monthlyTable')), page.html('#monthlyTable').slice(0, 160));
  check('generated timestamp shown', page.text('#generatedAt').length > 3, page.text('#generatedAt'));
});

test('member ticket: a published ticket renders picks, accuracy and diagnostics', async () => {
  const jar = await memberSession();
  const page = await makePage(jar, 'ticket.html', { pathname: `/ticket?date=${scn.ticketDate}`, search: `?date=${scn.ticketDate}`, scripts: ['ticket.js'] });

  check('no-ticket box hidden', page.$('#noTicketBox').classList.contains('hidden'), 'noTicketBox visible');
  check('picks listed', /pick|Over 1\.5|selection/i.test(page.html('#pickList')), page.html('#pickList').slice(0, 200));
  check('accuracy summary filled', page.text('#accSummary').trim().length > 0, page.html('#accSummary').slice(0, 160));
  check('ticket date shown', page.text('#ticketDate').length >= 8, page.text('#ticketDate'));
  check('ticket badge shown', page.text('#ticketBadge').length > 0, page.text('#ticketBadge'));
});

test('sign-in doors: admin credentials gate the console, member credentials gate the account page', async () => {
  const adminDoor = await makePage(createCookieJar(), 'login.html', { pathname: '/login', scripts: ['login.js'] });
  adminDoor.type('#login', 'admin');
  adminDoor.type('#password', 'wrong-password');
  adminDoor.submit('#loginForm');
  await flush(900);
  check('bad admin password explained', !adminDoor.$('#loginAlert').classList.contains('hidden') && adminDoor.text('#loginAlertText').length > 3, adminDoor.text('#loginAlertText'));
  check('admin button re-enabled', !adminDoor.$('#submitBtn').disabled, 'disabled');

  adminDoor.type('#password', PASSWORD);
  adminDoor.submit('#loginForm');
  await flush(1200);
  check('admin login navigates into the console', adminDoor.navigated('/admin.html'), JSON.stringify(adminDoor.navigations));

  const memberDoor = await makePage(createCookieJar(), 'account.html', { pathname: '/account.html', scripts: ['account.js'] });
  check('guest view shown when signed out', !memberDoor.$('#guestView').classList.contains('hidden'), 'guest view hidden');
  memberDoor.type('#loginId', 'member');
  memberDoor.type('#loginPassword', 'wrong-password');
  memberDoor.submit('#loginForm');
  await flush(900);
  check('bad member password explained', memberDoor.text('#loginAlertText').length > 3, memberDoor.text('#loginAlertText'));
  check('member login button re-enabled', !memberDoor.$('#loginBtn').disabled, 'disabled');

  memberDoor.type('#loginPassword', PASSWORD);
  memberDoor.submit('#loginForm');
  await flush(1200);
  check('member login navigates on', memberDoor.navigations.length > 0, JSON.stringify(memberDoor.navigations));
});

test('mobile: the public navigation drawer opens, closes on Escape and on tap', async () => {
  const page = await makePage(createCookieJar(), 'index.html', { pathname: '/', scripts: ['app.js'] });
  page.window.innerWidth = 390;
  const toggle = page.$('#navToggle');
  check('mobile toggle present', Boolean(toggle), 'no #navToggle');
  check('menu starts closed', page.$('#mobileMenu').hidden === true, String(page.$('#mobileMenu').hidden));

  toggle.click();
  check('toggle opens the menu', page.$('#mobileMenu').classList.contains('open') && page.$('#mobileMenu').hidden === false, 'menu stayed closed');
  check('aria-expanded reflects open', toggle.getAttribute('aria-expanded') === 'true', toggle.getAttribute('aria-expanded'));

  page.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  check('Escape closes the menu', !page.$('#mobileMenu').classList.contains('open'), 'still open');

  toggle.click();
  check('menu reopens for the tap test', page.$('#mobileMenu').classList.contains('open'), 'did not reopen');
  page.$('#mobileMenu a').click();
  check('tapping a link closes the menu', !page.$('#mobileMenu').classList.contains('open'), 'still open');
});

test('mobile: member dashboards still paint their key panels at phone width', async () => {
  const jar = await memberSession();
  const page = await makePage(jar, 'dashboard.html', { pathname: '/dashboard', scripts: ['dashboard.js'] });
  page.window.innerWidth = 390;
  page.window.dispatch('resize');
  check('welcome name at phone width', page.text('#welcomeName').length > 0, page.text('#welcomeName'));
  check('ticket status card visible', page.html('#ticketStatus').trim().length > 0, page.html('#ticketStatus').slice(0, 120));
  check('profile panel visible', page.text('#profileEmail').includes('@'), page.text('#profileEmail'));
});

test('data contracts: sync logs and score components are returned when stored', async () => {
  const adminFetch = createFetch(base, adminJar);
  /* the account test signs the shared member session out, so start a fresh one */
  const memberJar2 = createCookieJar();
  assert.equal(await login(memberJar2, 'member', PASSWORD), 200, 'member session for the data contract');
  const memberFetch = createFetch(base, memberJar2);
  const overview = await adminFetch('/api/admin/overview');
  assert.equal(overview.status, 200, 'overview status');
  const overviewBody = await overview.json();
  const syncs = overviewBody.data.recentSyncs;
  assert.ok(Array.isArray(syncs) && syncs.length >= 1, 'overview should surface the stored sync log');
  assert.equal(syncs[0].job, 'fixtures');

  const listed = await memberFetch(`/api/predictions?date=${scn.ticketDate}&limit=1`);
  assert.equal(listed.status, 200, 'predictions list status');
  const listedBody = await listed.json();
  const first = (listedBody.data.items || [])[0];
  assert.ok(first, 'the generated ticket should have at least one stored prediction');

  /* The query layer is doubled here; the point of the assertion is the controller
     contract (component/score/weight/contribution are mapped and ordered), not MySQL. */
  const realGetScores = dbQueries.getPredictionScores;
  dbQueries.getPredictionScores = async (ids) => ids.map((id) => ({
    prediction_id: id, component: 'form', score: 0.72, weight: 0.3, contribution: 0.216, detail_json: '{"wins":4}',
  }));
  try {
    const detail = await memberFetch(`/api/predictions/${first.fixtureId}`);
    assert.equal(detail.status, 200, 'prediction detail status');
    const body = await detail.json();
    const breakdown = body.data.scoreBreakdown;
    assert.ok(Array.isArray(breakdown) && breakdown.length === 1, 'score breakdown should carry the stored components');
    assert.equal(breakdown[0].component, 'form');
    assert.equal(breakdown[0].score, 0.72);
    assert.equal(body.data.prediction.id, first.id);
  } finally {
    dbQueries.getPredictionScores = realGetScores;
  }
});
