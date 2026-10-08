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
 *   guest         -> /api/dashboard/activity is 401 with no payload, the member
 *                    page redirects to sign-in, no public page carries the feed,
 *                    and the admin surface is refused
 *   member        -> /api/dashboard/activity is 200, scoped to that account
 *                    (audience "authenticated", scope "self") and the member
 *                    page is served no-store / noindex
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
