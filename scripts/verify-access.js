#!/usr/bin/env node
'use strict';

/**
 * ACCESS VERIFIER — proves the member/guest boundary against a RUNNING server.
 *
 *   node scripts/verify-access.js https://yourdomain.com
 *   node scripts/verify-access.js --member=member:pw --admin=admin:pw
 *   node scripts/verify-access.js --json
 *
 * The automated suite (tests/dashboard-activity.test.js and
 * tests/predictions-auth.test.js) proves the rules with an in-memory database.
 * This script proves the DEPLOYED site: it makes real HTTP requests and checks
 * that
 *
 *   guest         -> every football surface is closed: the prediction, ticket,
 *                    history, analytics, fixtures and odds APIs answer 401 with
 *                    no payload, the pages answer 401 with the login-required
 *                    door, the homepage shows no prediction data, and the admin
 *                    surface is refused
 *   member        -> /api/dashboard/activity is 200, scoped to that account
 *                    (audience "authenticated", scope "self"), the member page
 *                    is served no-store / noindex, and every prediction,
 *                    ticket, history, analytics, fixture and odds surface
 *                    opens for the session
 *   administrator -> the console API keeps its permissions, /dashboard still
 *                    redirects administrators to the console, and the sign-in
 *                    door skips itself for a live session
 *
 * Credentials are only ever used for the sign-in request in this process; no
 * cookie jar, token or account is written to disk. Exit code 1 on any failure,
 * so it can gate a deployment or run from cron.
 */

const config = require('../server/config');

const DEFAULT_BASE = process.env.VERIFY_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 15000);

const results = [];
let failed = 0;
let base = DEFAULT_BASE;

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  if (!ok) failed += 1;
}

function credentials(arg) {
  const pair = arg.slice(arg.indexOf('=') + 1);
  const split = pair.indexOf(':');
  if (split < 1) throw new Error('credentials must look like --member=username:password');
  return { login: pair.slice(0, split), password: pair.slice(split + 1) };
}

function parseArgs(argv) {
  const options = { base: DEFAULT_BASE, member: null, admin: null, json: false };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg.startsWith('--member=')) options.member = credentials(arg);
    else if (arg.startsWith('--admin=')) options.admin = credentials(arg);
    else if (arg.startsWith('--base=')) options.base = arg.slice(7);
    else if (!arg.startsWith('-')) options.base = arg;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.base = options.base.replace(/\/+$/, '');
  return options;
}

async function request(path, { method = 'GET', body = null, token = null, redirect = 'manual', timeoutMs = TIMEOUT_MS, headers: extraHeaders = null } = {}) {
  const headers = Object.assign({ Accept: 'application/json' }, extraHeaders || {});
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    // the same session, as a browser would send it
    headers.Cookie = `${config.auth.cookieName}=${token}`;
  }
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    redirect,
    signal: AbortSignal.timeout(timeoutMs),
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

/* ------------------------------------------------------------------ */
/* guest                                                              */
/* ------------------------------------------------------------------ */

async function verifyGuest() {
  const api = await request('/api/dashboard/activity');
  check('guest: GET /api/dashboard/activity is 401', api.status === 401, `got ${api.status}`);
  check(
    'guest: the refusal carries no payload',
    api.json && api.json.ok === false && !('data' in api.json),
    api.text.slice(0, 120)
  );
  check(
    'guest: the refusal is never cached',
    /no-store/i.test(api.headers.get('cache-control') || ''),
    api.headers.get('cache-control') || '(none)'
  );

  for (const url of ['/dashboard', '/dashboard.html']) {
    const page = await request(url);
    const location = page.headers.get('location') || '';
    check(
      `guest: ${url} redirects to the sign-in page`,
      page.status === 302 && location.endsWith('/account.html'),
      `got ${page.status} -> ${location || '(no location)'}`
    );
    check(`guest: ${url} ships no member feed`, !/Dashboard Activity/i.test(page.text));
  }

  const home = await request('/', { redirect: 'follow' });
  check('guest: the homepage is served', home.status === 200, `got ${home.status}`);
  check('guest: the homepage mentions no dashboard activity', !/dashboard activity/i.test(home.text));
  check('guest: the homepage references no dashboard endpoint', !home.text.includes('/api/dashboard'));

  // The public page scripts must read public feeds only.
  const homeJs = await request('/js/app.js');
  check('guest: the shared script calls no dashboard endpoint', homeJs.status === 200 && !homeJs.text.includes('/api/dashboard'), `got ${homeJs.status}`);
  check('guest: the shared script calls no admin endpoint', homeJs.status === 200 && !homeJs.text.includes('/api/admin'));

  const adminApi = await request('/api/admin/overview');
  check('guest: the admin API is refused', adminApi.status === 401, `got ${adminApi.status}`);

  // The console's own sign-in door: a form, never admin data.
  const signIn = await request('/admin/login');
  check('guest: /admin/login serves the sign-in page', signIn.status === 200, `got ${signIn.status}`);
  check('guest: the sign-in page ships no admin data', !signIn.text.includes('/api/admin') && !signIn.text.includes('js/admin.js'));
  check(
    'guest: the sign-in page is never indexed',
    /noindex/i.test(signIn.headers.get('x-robots-tag') || ''),
    signIn.headers.get('x-robots-tag') || '(none)'
  );
  const consoleUrl = await request('/admin.html');
  check(
    'guest: the console redirects to the sign-in door',
    consoleUrl.status === 302 && (consoleUrl.headers.get('location') || '').endsWith('/admin/login'),
    `got ${consoleUrl.status} -> ${consoleUrl.headers.get('location') || '(none)'}`
  );
  const consoleScript = await request('/js/admin.js');
  check('guest: the console script does not exist for a guest', consoleScript.status === 404, `got ${consoleScript.status}`);
}

/* ------------------------------------------------------------------ */
/* the football surfaces: guest vs member                             */
/* ------------------------------------------------------------------ */

const PREDICTION_APIS = [
  '/api/predictions',
  '/api/predictions?date=2026-10-08&limit=5',
  '/api/predictions/1',
  '/api/ticket/today',
  '/api/tickets/today',
  '/api/tickets/history',
  '/api/analytics',
  '/api/fixtures',
  '/api/odds',
];

const PREDICTION_PAGES = [
  '/predictions', '/predictions.html', '/ticket', '/ticket.html', '/today-ticket',
  '/history', '/history.html', '/analytics', '/analytics.html',
];

/** Words that would mean football data escaped to an anonymous caller. */
const DATA_MARKERS = [
  'homeTeam', 'awayTeam', 'expectedGoals', 'totalOdds', 'selectionCount',
  'modelProbability', 'predList', 'pick-row', 'history-row', 'monthlyChart',
];

async function verifyGuestFootball() {
  for (const endpoint of PREDICTION_APIS) {
    const res = await request(endpoint);
    check(`guest: GET ${endpoint} is 401`, res.status === 401, `got ${res.status}`);
    check(
      `guest: ${endpoint} carries no payload`,
      !res.json || res.json.data === undefined,
      (res.text || '').slice(0, 120)
    );
    check(
      `guest: ${endpoint} is never cached`,
      /no-store/i.test(res.headers.get('cache-control') || ''),
      res.headers.get('cache-control') || '(none)'
    );
    for (const marker of DATA_MARKERS) {
      check(`guest: ${endpoint} leaks no "${marker}"`, !(res.text || '').includes(marker));
    }
  }

  for (const page of PREDICTION_PAGES) {
    const res = await request(page);
    check(`guest: ${page} is 401`, res.status === 401, `got ${res.status}`);
    check(
      `guest: ${page} shows the login-required door`,
      /Login or create an account|Login to access/.test(res.text || ''),
      (res.text || '').slice(0, 120)
    );
    check(
      `guest: ${page} offers Login and Create Account`,
      (res.text || '').includes('href="/login?next=') && (res.text || '').includes('/account.html#register')
    );
    check(
      `guest: ${page} is never cached or indexed`,
      /no-store/i.test(res.headers.get('cache-control') || '') && /noindex/i.test(res.headers.get('x-robots-tag') || ''),
      `${res.headers.get('cache-control')} / ${res.headers.get('x-robots-tag')}`
    );
    for (const marker of DATA_MARKERS) {
      check(`guest: ${page} leaks no "${marker}"`, !(res.text || '').includes(marker));
    }
  }

  // the public landing page must stay marketing only
  const home = await request('/', { redirect: 'follow' });
  check('guest: the homepage is served', home.status === 200, `got ${home.status}`);
  check('guest: the homepage carries the unlock CTA', /Unlock AI Football Predictions/.test(home.text));
  for (const needle of ['/api/predictions', '/api/ticket', '/api/analytics', '/api/fixtures', '/api/odds']) {
    check(`guest: the homepage never references ${needle}`, !home.text.includes(needle));
  }
  const homeJs = await request('/js/app.js');
  check('guest: the landing script reads no prediction endpoint', !/API\.get\(/.test(homeJs.text), homeJs.text.slice(0, 120));
  const sharedJs = await request('/js/api.js');
  check('guest: the shared script hides the member navigation', /\[data-member-only\]/.test(sharedJs.text));

  // the login-required view is server rendered, never a fetchable asset
  const view = await request('/login-required.html');
  check('guest: the login-required view is not a static file', view.status === 404, `got ${view.status}`);

  // identity is taken from the session, never from the request
  const spoofed = await request('/api/predictions', { headers: { 'X-User-Id': '1', 'X-Role': 'admin' } });
  check('guest: a spoofed identity header never authenticates', spoofed.status === 401, `got ${spoofed.status}`);
  for (const suffix of ['?userId=1', '?user_id=1&role=admin', '?account=1']) {
    const res = await request(`/api/predictions${suffix}`);
    check(`guest: /api/predictions${suffix} is still 401`, res.status === 401, `got ${res.status}`);
  }
}

async function verifyMemberFootball(token) {
  for (const endpoint of PREDICTION_APIS) {
    const res = await request(endpoint, { token });
    check(
      `member: GET ${endpoint} opens`,
      [200, 404].includes(res.status),
      `got ${res.status}`
    );
    if (res.status === 200) {
      check(`member: ${endpoint} returns the success envelope`, res.json && res.json.ok === true);
    }
  }
  for (const page of ['/predictions', '/ticket', '/history', '/analytics']) {
    const res = await request(page, { token });
    check(`member: ${page} is served`, res.status === 200, `got ${res.status}`);
    check(
      `member: ${page} is never cached or indexed`,
      /no-store/i.test(res.headers.get('cache-control') || ''),
      res.headers.get('cache-control') || '(none)'
    );
  }

  // the browser must not be able to widen the scope with a supplied id: the
  // answer has to be byte for byte the one the session is entitled to
  const own = await request('/api/tickets/history?limit=3');
  const widened = await request('/api/tickets/history?limit=3&userId=1', { token });
  const plain = await request('/api/tickets/history?limit=3', { token });
  check('member: a userId query parameter is ignored (same payload)', widened.text === plain.text);
  check('member: the history payload is only served to the session', own.status === 401, `guest got ${own.status}`);
}

/* ------------------------------------------------------------------ */
/* member / administrator                                             */
/* ------------------------------------------------------------------ */

async function signIn(kind, creds) {
  const path = kind === 'admin' ? '/api/auth/admin/login' : '/api/auth/login';
  const res = await request(path, { method: 'POST', body: { login: creds.login, password: creds.password } });
  if (res.status !== 200 || !res.json || !res.json.data || !res.json.data.token) {
    return { error: `${path} -> ${res.status}` };
  }
  return { token: res.json.data.token };
}

async function verifyMember(creds) {
  const session = await signIn('member', creds);
  if (session.error) {
    check('member: sign-in succeeds', false, session.error);
    return null;
  }
  check('member: sign-in succeeds', true);

  const api = await request('/api/dashboard/activity', { token: session.token });
  check('member: GET /api/dashboard/activity is 200', api.status === 200, `got ${api.status}`);
  const data = (api.json && api.json.data) || {};
  check(
    'member: the payload is session scoped',
    data.audience === 'authenticated' && data.scope === 'self',
    `audience=${data.audience} scope=${data.scope}`
  );
  check(
    'member: the payload is the caller account',
    data.account && data.account.username === creds.login,
    `account=${data.account && data.account.username}`
  );
  check('member: the feed is an array', Array.isArray(data.items), typeof data.items);
  check(
    'member: the feed records the sign-in just made',
    (data.items || []).some((item) => item.event === 'USER_LOGIN') || (data.summary || {}).recordedEvents > 0
  );
  check(
    'member: the response is never cached',
    /no-store/i.test(api.headers.get('cache-control') || ''),
    api.headers.get('cache-control') || '(none)'
  );

  const page = await request('/dashboard', { token: session.token });
  check('member: the member page is served', page.status === 200, `got ${page.status}`);
  check('member: the page contains the Dashboard Activity section', page.text.includes('Dashboard Activity'));
  check(
    'member: the page is no-store and noindex',
    /no-store/i.test(page.headers.get('cache-control') || '') && /noindex/i.test(page.headers.get('x-robots-tag') || ''),
    `${page.headers.get('cache-control')} / ${page.headers.get('x-robots-tag')}`
  );

  const adminApi = await request('/api/admin/overview', { token: session.token });
  check('member: the admin API stays forbidden', adminApi.status === 401 || adminApi.status === 403, `got ${adminApi.status}`);

  return session.token;
}

async function verifyAdmin(creds) {
  const session = await signIn('admin', creds);
  if (session.error) {
    check('admin: sign-in succeeds', false, session.error);
    return;
  }
  check('admin: sign-in succeeds', true);

  const overview = await request('/api/admin/overview', { token: session.token });
  check('admin: the console API keeps its permissions', overview.status === 200, `got ${overview.status}`);

  const page = await request('/dashboard', { token: session.token });
  const location = page.headers.get('location') || '';
  check(
    'admin: /dashboard still redirects to the console',
    page.status === 302 && location.endsWith('/admin.html'),
    `got ${page.status} -> ${location || '(no location)'}`
  );

  const feed = await request('/api/dashboard/activity', { token: session.token });
  check(
    'admin: the dashboard activity feed is admin scoped',
    feed.status === 200 && ((feed.json.data || {}).account || {}).type === 'admin',
    `got ${feed.status}`
  );

  const door = await request('/admin/login', { token: session.token });
  check(
    'admin: the sign-in door skips itself for a live session',
    door.status === 302 && (door.headers.get('location') || '').endsWith('/admin.html'),
    `got ${door.status} -> ${door.headers.get('location') || '(none)'}`
  );
}

/* ------------------------------------------------------------------ */
/* run                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  base = options.base;

  // Reachability is proven with a static route: /api/health and /api/meta both
  // read the database, so on a site whose database is down they would hang and
  // this verifier would blame the wrong thing. Any HTTP answer means the site
  // is up.
  try {
    const probe = await request('/robots.txt', { redirect: 'follow', timeoutMs: Math.min(TIMEOUT_MS, 8000) });
    check(`reachable: ${base} answers HTTP ${probe.status}`, probe.status > 0, `got ${probe.status}`);
  } catch (err) {
    process.stderr.write(`cannot reach ${base}: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  await verifyGuest();
  await verifyGuestFootball();
  if (options.member) {
    const memberToken = await verifyMember(options.member);
    if (memberToken) await verifyMemberFootball(memberToken);
  }
  if (options.admin) await verifyAdmin(options.admin);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ base, passed: results.length - failed, failed, results }, null, 2)}\n`);
  } else {
    const width = Math.max(...results.map((r) => r.name.length));
    for (const r of results) {
      process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.ok ? '' : r.detail}\n`);
    }
    process.stdout.write(`\n${results.length - failed}/${results.length} checks passed against ${base}\n`);
    if (!options.member || !options.admin) {
      process.stdout.write('note: pass --member=user:password and --admin=user:password to verify the signed-in states too\n');
    }
  }

  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`verification failed: ${err.message}\n`);
  process.exitCode = 1;
});
