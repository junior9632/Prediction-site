#!/usr/bin/env node
'use strict';

/**
 * ACCESS VERIFIER — proves the member/guest boundary against a RUNNING server.
 *
 *   node scripts/verify-access.js https://yourdomain.com
 *   node scripts/verify-access.js --member=member:pw --admin=admin:pw
 *   node scripts/verify-access.js --json
 *
 * The automated suite (tests/dashboard-activity.test.js) proves the rules with
 * an in-memory database. This script proves the DEPLOYED site: it makes real
 * HTTP requests and checks that
 *
 *   guest         -> EVERY prediction endpoint (predictions, tickets, odds,
 *                    fixtures, analytics) and the member dashboard feed answer
 *                    401 with no payload; every member page (/predictions,
 *                    /ticket, /history, /analytics, /dashboard) redirects to
 *                    the sign-in door; the homepage publishes no prediction
 *                    data and names no prediction endpoint; the admin surface
 *                    is refused
 *   member        -> the same endpoints answer 200 with data, the member pages
 *                    are served no-store / noindex, and
 *                    /api/dashboard/activity is scoped to that account
 *                    (audience "authenticated", scope "self")
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

async function request(path, { method = 'GET', body = null, token = null, redirect = 'manual', timeoutMs = TIMEOUT_MS } = {}) {
  const headers = { Accept: 'application/json' };
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

/* Every URL that carries prediction data. A guest must be refused by all of
   them — page or API, friendly URL or .html, singular or plural prefix. */
const PREDICTION_APIS = [
  '/api/predictions',
  '/api/predictions/1',
  '/api/ticket/today',
  '/api/tickets/today',
  '/api/tickets/history',
  '/api/ticket/2026-01-01',
  '/api/analytics',
  '/api/fixtures',
  '/api/fixtures/1',
  '/api/odds',
  '/api/odds/bookmakers',
  '/api/odds/fixture/1',
  '/api/dashboard/activity',
];

const MEMBER_PAGES = ['/predictions', '/predictions.html', '/ticket', '/ticket.html', '/history', '/history.html', '/analytics', '/analytics.html', '/dashboard', '/dashboard.html'];

/* Words that can only appear on a page that is actually rendering prediction
   data. The homepage and the sign-in door must not contain any of them. */
const DATA_MARKERS = ['pv-match-teams', 'pick-teams', 'odds-badge', 'conf-pill', 'id="predList"', 'id="pickList"', 'id="historyList"'];

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
      page.status === 302 && location.startsWith('/login?next='),
      `got ${page.status} -> ${location || '(no location)'}`
    );
    check(`guest: ${url} ships no member feed`, !/Dashboard Activity/i.test(page.text));
  }

  /* ---- the prediction surface: no session, no data, on any URL ---- */
  for (const url of PREDICTION_APIS) {
    const res = await request(url);
    check(`guest: GET ${url} is 401`, res.status === 401, `got ${res.status}`);
    check(`guest: GET ${url} carries no data`, res.json && res.json.ok === false && !('data' in res.json), res.text.slice(0, 120));
    check(
      `guest: GET ${url} is never cached`,
      /no-store/i.test(res.headers.get('cache-control') || ''),
      res.headers.get('cache-control') || '(none)'
    );
  }

  // A forged token or a "public" flag changes nothing: the server decides.
  const spoof = await request('/api/predictions?userId=1&user_id=1&public=1&auth=1&token=x');
  check('guest: query parameters cannot unlock the prediction API', spoof.status === 401, `got ${spoof.status}`);
  const forged = await request('/api/ticket/today', { token: 'not-a-real-jwt' });
  check('guest: a forged token is refused', forged.status === 401, `got ${forged.status}`);

  for (const url of MEMBER_PAGES) {
    const page = await request(url);
    const location = page.headers.get('location') || '';
    check(
      `guest: ${url} redirects to the sign-in door`,
      page.status === 302 && location.startsWith('/login?next='),
      `got ${page.status} -> ${location || '(no location)'}`
    );
    check(`guest: ${url} ships no prediction markup`, !DATA_MARKERS.some((m) => page.text.includes(m)));
  }

  // The door itself explains what was refused, by name, with both actions.
  const door = await request('/login?next=%2Fpredictions');
  check('guest: the sign-in door names the refused page', door.status === 200 && /Football Predictions/.test(door.text), `got ${door.status}`);
  check(
    'guest: the sign-in door offers Login and Create Account',
    />Login</.test(door.text) && />Create Account</.test(door.text)
  );
  const evil = await request('/login?next=%2F%2Fevil.example%2Fsteal');
  check('guest: an off-site next is ignored (no open redirect)', evil.status === 200 && !evil.text.includes('evil.example'));

  const home = await request('/', { redirect: 'follow' });
  check('guest: the homepage is served', home.status === 200, `got ${home.status}`);
  check('guest: the homepage mentions no dashboard activity', !/dashboard activity/i.test(home.text));
  check('guest: the homepage references no dashboard endpoint', !home.text.includes('/api/dashboard'));
  check(
    'guest: the homepage references no prediction endpoint',
    !/\/api\/(predictions|ticket|tickets|analytics|fixtures|odds)/.test(home.text)
  );
  check('guest: the homepage renders no prediction markup', !DATA_MARKERS.some((m) => home.text.includes(m)));
  check('guest: the homepage offers the unlock CTA', /Unlock AI Football Predictions/.test(home.text));
  check('guest: the homepage offers the login CTA', /Login to view today's predictions/.test(home.text));
  check(
    'guest: the homepage hides the member navigation',
    (home.text.match(/<a[^>]*data-auth-only[^>]*>/g) || []).every((tag) => /class="[^"]*\bhidden\b/.test(tag))
  );

  // The public page scripts must read public feeds only.
  const homeJs = await request('/js/app.js');
  check('guest: the shared script calls no dashboard endpoint', homeJs.status === 200 && !homeJs.text.includes('/api/dashboard'), `got ${homeJs.status}`);
  check('guest: the shared script calls no admin endpoint', homeJs.status === 200 && !homeJs.text.includes('/api/admin'));
  check(
    'guest: the shared script calls no prediction endpoint',
    homeJs.status === 200 && !/\/api\/(predictions|ticket|tickets|analytics|fixtures|odds)/.test(homeJs.text)
  );

  // The worker must never replay a member page from its cache.
  const worker = await request('/sw.js');
  check('guest: the service worker never caches a member page', worker.status === 200 && worker.text.includes('isMemberPage'), `got ${worker.status}`);

  const adminApi = await request('/api/admin/overview');
  check('guest: the admin API is refused', adminApi.status === 401, `got ${adminApi.status}`);

  // Still public on purpose: uptime probes and the deployment checklist read
  // them. They carry branding and published rules, never a fixture, a price,
  // a pick, a confidence value or a history row.
  for (const url of ['/api/health', '/api/meta']) {
    const res = await request(url);
    const text = JSON.stringify((res.json && res.json.data) || {});
    check(`guest: ${url} stays public and carries no prediction data`, res.status === 200 && !/homeTeam|selections|fixtureId|bookmaker|confidence/.test(text), `got ${res.status}`);
  }

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
    return;
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

  /* ---- the prediction surface opens for the signed-in account ---- */
  for (const url of ['/api/predictions', '/api/ticket/today', '/api/tickets/history', '/api/analytics', '/api/fixtures', '/api/odds']) {
    const res = await request(url, { token: session.token });
    check(`member: GET ${url} is 200`, res.status === 200, `got ${res.status}`);
    check(`member: GET ${url} returns data`, Boolean(res.json && res.json.ok === true && res.json.data), res.text.slice(0, 120));
    check(
      `member: GET ${url} is never cached`,
      /no-store/i.test(res.headers.get('cache-control') || ''),
      res.headers.get('cache-control') || '(none)'
    );
  }

  for (const url of ['/predictions', '/ticket', '/history', '/analytics']) {
    const page = await request(url, { token: session.token });
    check(`member: ${url} is served`, page.status === 200, `got ${page.status}`);
    check(
      `member: ${url} is no-store and noindex`,
      /no-store/i.test(page.headers.get('cache-control') || '') && /noindex/i.test(page.headers.get('x-robots-tag') || ''),
      `${page.headers.get('cache-control')} / ${page.headers.get('x-robots-tag')}`
    );
  }

  // A member is sent back to the page they were refused instead of the door.
  const bounced = await request('/login?next=%2Fpredictions', { token: session.token });
  check(
    'member: the sign-in door sends a live session back to the page',
    bounced.status === 302 && (bounced.headers.get('location') || '').endsWith('/predictions'),
    `got ${bounced.status} -> ${bounced.headers.get('location') || '(no location)'}`
  );
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
  if (options.member) await verifyMember(options.member);
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
