/* Homepage contract — the public landing page.
 *
 * FOOTBALL DATA IS MEMBER ONLY. The homepage is therefore a pure MARKETING /
 * SPORTS-INTELLIGENCE page: it may explain the product, show the shape of the
 * member surfaces behind a lock, and offer the sign-in door — but it must
 * never fetch or render a team, a price, a confidence figure, a selection or
 * a statistic.
 *
 * What this file proves:
 *
 *   1. The page it serves: marketing copy, the locked preview, the sign-in
 *      CTAs, and the absence of any prediction payload.
 *   2. The script it ships requests NOTHING but the shared session check
 *      (`/api/auth/me`) — statically and at runtime, in an executed trace.
 *   3. Server side: every prediction/ticket/analytics endpoint answers a guest
 *      with 401 and an empty body, and every prediction PAGE answers 401 with
 *      the "login required" page instead of the member surface.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'homepage-render-secret-please-change';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fakeDb = require('./fakeDb');
const settingsService = require('../server/services/settingsService');
const auth = require('../server/middleware/auth');
const { createApp, PUBLIC_DIR } = require('../server/app');

const read = (p) => fs.readFileSync(path.join(PUBLIC_DIR, p), 'utf8');
const html = read('index.html');
const css = read('css/style.css');
const js = read('js/app.js');
const apiJs = read('js/api.js');
const aboutHtml = read('about.html');

/* Endpoints that are member only: a guest must never receive data from them,
   and the homepage must never ask for them. */
const MEMBER_ENDPOINTS = [
  '/api/predictions?limit=6',
  '/api/predictions',
  '/api/ticket/today',
  '/api/tickets/history',
  '/api/analytics',
  '/api/fixtures',
  '/api/odds',
];
/* Endpoints that stay public. */
const PUBLIC_ENDPOINTS = ['/api/health', '/api/meta'];

const PRIVATE_MARKERS = ['dashboard', 'admin', 'activity', 'auth/login', 'auth/register'];

/* The product's own rule statements are the only place dashboard vocabulary
   may appear; they explain the rules, they do not render a dashboard. */
const RULE_SENTENCES = [
  'No forced accumulator.',
  'No fabricated selections.',
  'Only qualifying selections are published.',
  'If no qualifying combination exists, we show no qualifying ticket.',
  'Our daily accumulator target is between 2.00 and 4.00 total decimal odds.',
];
const withoutRules = RULE_SENTENCES.reduce((text, sentence) => text.split(sentence).join(''), html);

const MEMBER = {
  id: 7,
  email: 'fan@test.local',
  username: 'ticketfan',
  password_hash: 'x',
  role: 'user',
  is_active: 1,
  failed_logins: 0,
  locked_until: null,
  last_login_at: null,
  created_at: '2026-09-01 10:00:00',
  updated_at: '2026-09-01 10:00:00',
};

/* ------------------------------------------------------------------ */
/* structure & copy                                                    */
/* ------------------------------------------------------------------ */

test('homepage: the sports-intelligence structure from the brief is complete and in order', () => {
  const order = [
    'class="site-header lp-header"',
    'class="lp-hero"',
    'id="member-record"',
    'id="todays-matches"',
    'class="lp-trust"',
    'id="what-is-goalpredict"',
    'id="our-market"',
    'id="daily-target"',
    'id="how-it-works"',
    'id="why-goalpredict"',
    'class="lp-cta reveal"',
    'class="site-footer lp-footer"',
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = html.indexOf(marker);
    assert.ok(at > -1, `the homepage renders ${marker}`);
    assert.ok(at > cursor, `${marker} appears in the documented order`);
    cursor = at;
  }

  // hero
  assert.match(html, /AI Sports Intelligence/, 'the hero carries the AI/intelligence badge');
  assert.match(html, /AI-Powered/, 'the hero headline is the AI pitch');
  assert.match(html, /Football Predictions/, 'the hero headline names the product');
  assert.match(
    html,
    /href="\/login\?next=\/predictions"[^>]*>\s*Login to view today's predictions/s,
    "the hero CTA opens the sign-in door and comes back to predictions"
  );
  assert.match(html, /href="\/account\.html#register"[^>]*data-auth-register>Create Free Account/, 'the hero offers account creation');

  // trust strip, exact copy
  for (const [title, body] of [
    ['Real Football Data', 'Fixtures and football statistics from reliable data sources.'],
    ['Verified Bookmaker Odds', 'Use verified bookmaker prices instead of invented odds.'],
    ['One Clear Market', 'We focus exclusively on Over 1.5 Goals.'],
    ['No Forced Picks', 'If no qualifying combination exists, we show no qualifying ticket.'],
  ]) {
    assert.ok(html.includes(title), `trust card "${title}" is present`);
    assert.ok(html.includes(body), `trust card "${title}" keeps its copy`);
  }

  // what is GoalPredict — the AI explanation (public and encouraged)
  assert.match(html, /Football predictions built around data/i, 'the "what is GoalPredict" heading exists');
  assert.ok(html.includes('GoalPredict analyses football fixtures using real match information'), 'the explanation paragraph ships');
  assert.ok(html.includes('A goal model scores every fixture from expected goals'), 'how the AI works is explained');

  // one market + daily target + process + features
  assert.match(html, /One market\. One focus\./, 'the market label exists');
  assert.match(html, /Over <span class="accent">1\.5<\/span> Goals/, 'the market headline is Over 1.5 Goals');
  assert.match(html, /2\.00\s*<span class="lp-target-dash">—<\/span>\s*4\.00/, 'the 2.00 - 4.00 target is stated');
  for (const [num, title, body] of [
    ['01', 'Collect', 'Football fixtures and match data are collected.'],
    ['02', 'Analyse', 'The system evaluates relevant football statistics and goal trends.'],
    ['03', 'Verify', 'Available Over 1.5 bookmaker odds are checked and validated.'],
    ['04', 'Publish', 'Only qualifying selections are published.'],
  ]) {
    assert.ok(html.includes(`>${num}<`), `step ${num} is numbered`);
    assert.ok(html.includes(`>${title}<`), `step ${num} is titled ${title}`);
    assert.ok(html.includes(body), `step ${num} keeps its copy`);
  }
  for (const [title, body] of [
    ['Real Data', 'Built around real football information.'],
    ['Verified Odds', 'No invented bookmaker prices.'],
    ['Over 1.5 Only', 'One focused prediction market.'],
    ['2.00&ndash;4.00 Target', 'A clear daily odds range.'],
    ['No Forced Picks', 'No qualifying combination means no ticket.'],
    ['Transparent Results', 'Published tickets can be tracked through results and history.'],
  ]) {
    assert.ok(html.includes(`>${title}<`), `feature "${title}" is present`);
    assert.ok(html.includes(body), `feature "${title}" keeps its copy`);
  }

  // final CTA — the unlock pitch
  assert.match(html, /Unlock AI Football Predictions/, 'the final CTA carries the unlock heading');
  assert.match(
    html,
    /href="\/login\?next=\/predictions">Login to view today's predictions →/,
    'the final CTA links the sign-in door'
  );
  assert.match(html, /href="\/account\.html#register"[^>]*>Create Account/, 'the final CTA links registration');
});

test('homepage: ACCEPTANCE — a visitor sees a LOCKED marketing preview and no prediction data', () => {
  // 1. the preview is a lock, not a payload
  assert.match(html, /id="pvTitle">Unlock AI Football Predictions</, 'the preview is the unlock pitch');
  assert.match(html, /class="pv-pill lock"[\s\S]{0,120}Members only/, 'the preview is badged members only');
  assert.ok(html.includes('lock-mask'), 'the figures are masked placeholders');

  // no live figure node survives: the old data targets are gone for good
  for (const id of ['pvPicks', 'pvOdds', 'pvProbability', 'pvNote', 'pvGenerated', 'statSettled',
    'statTicketWinRate', 'statLegWinRate', 'statRoi', 'matchCards', 'matchEmpty']) {
    assert.ok(!html.includes(`id="${id}"`), `the homepage no longer paints #${id}`);
  }

  // 2. the script asks for no prediction surface at all
  for (const needle of ['/predictions', '/ticket', '/analytics', '/fixtures', '/odds', 'API.get(']) {
    assert.ok(!js.includes(needle), `js/app.js must not touch ${needle}`);
  }

  // 3. dashboard / account-scoped vocabulary and surfaces are absent
  const forbidden = [
    'Dashboard Activity',
    'Activity Feed',
    'Your activity',
    'My activity',
    'account activity',
    'username',
    'member since',
    'Your tickets',
    'Your predictions',
    'notifications',
    'Generate Ticket',
  ];
  for (const phrase of forbidden) {
    assert.ok(
      !new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(withoutRules),
      `the homepage must not contain "${phrase}"`
    );
  }
  for (const needle of ['/api/dashboard', '/api/admin', 'activityFeed', 'js/dashboard.js', 'js/admin.js',
    'data-auth-admin', 'dashboardActivity']) {
    assert.ok(!html.includes(needle), `index.html must not reference ${needle}`);
    assert.ok(!js.includes(needle), `js/app.js must not reference ${needle}`);
    assert.ok(!aboutHtml.includes(needle), `about.html must not reference ${needle}`);
  }
  assert.ok(!/\/admin\b/.test(html), 'the homepage must not link the admin surface');
  assert.ok(!/admin/i.test(html), 'the word "admin" must not appear on the homepage at all');

  // 4. member-only navigation exists but ships hidden for a guest
  const memberLinks = [...html.matchAll(/<a\s([^>]*data-member-only[^>]*)>/g)].map((m) => m[1]);
  assert.ok(memberLinks.length >= 5, 'the homepage declares the member-only nav entries');
  for (const attrs of memberLinks) {
    assert.match(attrs, /class="[^"]*\bhidden\b/, 'a member-only link is hidden until a session exists');
  }
});

test('homepage: the script can reach no prediction endpoint (static allowlist)', () => {
  assert.ok(!/API\.get\(/.test(js), 'js/app.js issues no data read of its own');
  assert.ok(!/API\.post\(/.test(js), 'js/app.js issues no write of its own');
  assert.ok(!/\bfetch\(/.test(js), 'js/app.js opens no raw fetch of its own');
  assert.ok(!/XMLHttpRequest/.test(js), 'js/app.js opens no XHR of its own');
  for (const endpoint of MEMBER_ENDPOINTS) {
    const path = endpoint.replace('/api', '');
    assert.ok(!js.includes(path), `js/app.js must not name ${path}`);
    assert.ok(!html.includes(`/api${path}`), `index.html must not name /api${path}`);
  }
  // the only endpoint the landing page may reach is the session check, and it
  // lives in the shared helper (api.js) that every page already needs
  assert.match(apiJs, /\/auth\/me/, 'the shared session check is the only call the header makes');
});

test('homepage: at runtime it requests nothing but the session check (executed script trace)', async () => {
  // A minimal DOM so the real public/js/app.js runs, with a recording fetch.
  const asked = [];
  const makeEl = (id) => ({
    id, textContent: '', innerHTML: '', className: '', hidden: false, attrs: {}, dataset: {},
    style: { setProperty() {} },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    addEventListener() {}, firstChild: null, removeChild() {},
  });
  const nodes = new Map();
  const document = {
    cookie: '',
    documentElement: { classList: { add() {}, remove() {} } },
    body: makeEl('body'),
    querySelector(sel) {
      const id = sel.startsWith('#') ? sel.slice(1) : sel.replace(/^\[([^\]]+)\]$/, '$1');
      if (!nodes.has(id)) nodes.set(id, makeEl(id));
      return nodes.get(id);
    },
    querySelectorAll: () => [],
    addEventListener(type, fn) { (document._h = document._h || {})[type] = fn; },
    createElement: () => makeEl('created'),
  };

  const fetchStub = async (url) => {
    asked.push(url);
    if (url.endsWith('/api/auth/me')) return { ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'UNAUTHORIZED' } }) };
    throw new Error(`the homepage tried to load ${url}`);
  };

  const window = { document, addEventListener() {}, innerWidth: 1440, location: { href: '/', pathname: '/', search: '', replace() {} }, matchMedia: () => ({ matches: false }) };
  const ctx = {
    window, document, fetch: fetchStub, navigator: {}, console,
    setTimeout, Promise, Object, Array, String, Number, Boolean, RegExp, Math, Date, JSON, Error,
    encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(apiJs, ctx, { filename: 'api.js' });
  vm.runInContext(js, ctx, { filename: 'app.js' });

  await document._h.DOMContentLoaded();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // exactly the shared session check — nothing else
  assert.deepEqual(asked, ['/api/auth/me'], `the homepage requested ${JSON.stringify(asked)}`);
  for (const url of asked) {
    for (const marker of PRIVATE_MARKERS.filter((m) => m !== 'auth/me')) {
      assert.ok(!url.toLowerCase().includes(marker), `no dashboard/admin request may be made (saw ${url})`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* server side: public is public, predictions are member only           */
/* ------------------------------------------------------------------ */

test('homepage: every prediction endpoint is refused for a guest, and so is every page', async () => {
  const ctx = fakeDb.install({ admins: [], users: [MEMBER], settings: [], fixtures: [], teamForms: [], leagues: [] });
  settingsService.invalidateCache();
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 1. what the homepage shows stays public
    for (const endpoint of PUBLIC_ENDPOINTS) {
      const res = await fetch(`${base}${endpoint}`, { headers: { Accept: 'application/json' } });
      assert.equal(res.status, 200, `${endpoint} must answer a guest with 200`);
    }
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200, 'the homepage is public');

    // 2. every football API is 401 for a guest, with no data in the body
    for (const endpoint of MEMBER_ENDPOINTS) {
      const res = await fetch(`${base}${endpoint}`, { headers: { Accept: 'application/json' }, redirect: 'manual' });
      assert.equal(res.status, 401, `${endpoint} must refuse a guest with 401`);
      const body = await res.json();
      assert.equal(body.ok, false, `${endpoint} returns the error envelope`);
      assert.equal(body.data, undefined, `${endpoint} carries no data for a guest`);
      assert.equal(res.headers.get('cache-control'), 'no-store', `${endpoint} is never cached`);
      const text = JSON.stringify(body);
      for (const leak of ['confidence', 'homeTeam', 'selections', 'totalOdds', 'winRate']) {
        assert.ok(!text.includes(leak), `${endpoint} must not leak "${leak}"`);
      }
    }

    // 3. every football PAGE answers 401 with the login-required door
    const pages = ['/predictions', '/predictions.html', '/ticket', '/ticket.html', '/today-ticket', '/history', '/history.html', '/analytics', '/analytics.html'];
    for (const page of pages) {
      const res = await fetch(`${base}${page}`, { redirect: 'manual' });
      assert.equal(res.status, 401, `${page} must refuse a guest with 401`);
      assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate', `${page} is never cached`);
      assert.match(res.headers.get('x-robots-tag') || '', /noindex/, `${page} is never indexed`);
      const body = await res.text();
      assert.match(body, /Login or create an account|Login to access/, `${page} shows the login-required page`);
      assert.ok(body.includes('href="/login?next='), `${page} offers the sign-in door`);
      assert.ok(body.includes('/account.html#register'), `${page} offers account creation`);
      // the page may describe the member area; it must never carry its data
      for (const leak of ['homeTeam', 'awayTeam', 'expectedGoals', 'totalOdds', 'pick-row',
        'history-row', 'pv-match', 'acc-summary', 'predList', 'scoreBreakdown', 'Eligible']) {
        assert.ok(!body.includes(leak), `${page} must not leak "${leak}"`);
      }
    }

    // 4. and the member only surfaces open for a verified session
    const token = auth.signToken({ sub: MEMBER.id, type: 'user', role: 'user', username: MEMBER.username });
    for (const endpoint of MEMBER_ENDPOINTS) {
      const res = await fetch(`${base}${endpoint}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200, `${endpoint} opens for a member`);
    }
    const predictions = await fetch(`${base}/predictions`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
    assert.equal(predictions.status, 200, '/predictions serves the member page to a member');
    assert.match(await predictions.text(), /id="predList"/, 'and it is the real predictions page');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    ctx.restore();
    settingsService.invalidateCache();
  }
});

test('homepage: a forged user id in the request never widens the payload', async () => {
  const ctx = fakeDb.install({ admins: [], users: [MEMBER], settings: [], fixtures: [], teamForms: [], leagues: [] });
  settingsService.invalidateCache();
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // a guest smuggling an identity into the query string is still a guest
    for (const suffix of ['?userId=1', '?user_id=1&role=admin', '?account=1']) {
      const res = await fetch(`${base}/api/predictions${suffix}`, { headers: { Accept: 'application/json' } });
      assert.equal(res.status, 401, `/api/predictions${suffix} must still refuse a guest`);
    }
    // and a header cannot impersonate either
    const res = await fetch(`${base}/api/predictions`, { headers: { Accept: 'application/json', 'X-User-Id': '1' } });
    assert.equal(res.status, 401, 'a spoofed X-User-Id header changes nothing');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    ctx.restore();
    settingsService.invalidateCache();
  }
});

/* ------------------------------------------------------------------ */
/* presentation                                                         */
/* ------------------------------------------------------------------ */

test('homepage: navigation, footer and session-aware header', () => {
  const nav = html.match(/<nav class="main-nav lp-nav"[\s\S]*?<\/nav>/)[0];
  for (const label of ['Home', 'About']) {
    assert.ok(nav.includes(`>${label}<`), `the desktop nav keeps ${label}`);
  }
  // the member entries ship hidden and are revealed only by a verified session
  for (const label of ['Dashboard', 'Predictions', "Today's Ticket", 'Ticket History', 'Analytics']) {
    assert.ok(nav.includes(`>${label}<`), `the desktop nav declares the member entry ${label}`);
    const entry = nav.match(new RegExp(`<a[^>]*>${label.replace(/'/g, '&#39;')}<`)) || nav.match(new RegExp(`<a[^>]*>${label}<`));
    assert.ok(entry && /data-member-only/.test(entry[0]), `${label} is member only`);
    assert.ok(entry && /hidden/.test(entry[0]), `${label} starts hidden for a guest`);
  }
  assert.ok(!/admin/i.test(nav), 'no admin entry in the primary navigation');

  assert.match(html, /data-auth-login>Login</, 'the header offers Login');
  assert.match(html, /data-auth-register>Create Account</, 'the header offers Create Account');
  assert.match(apiJs, /\[data-auth-register\]/, 'the Create Account button is session aware');
  assert.match(apiJs, /\[data-member-only\]/, 'the member-only navigation is session aware');

  assert.ok(html.includes('id="navToggle"'), 'the header renders a hamburger toggle');
  assert.match(html, /aria-controls="mobileMenu"/, 'the toggle controls the drawer');
  const drawer = html.match(/<div class="lp-mobile-menu"[\s\S]*?<\/div>\s*<\/header>/)[0];
  for (const label of ['Home', 'About', 'Dashboard', 'Predictions', 'Analytics']) {
    assert.ok(drawer.includes(`>${label}<`), `the mobile drawer keeps ${label}`);
  }
  assert.ok(drawer.includes('data-member-only'), 'the drawer hides the member entries for a guest');
  assert.ok(drawer.includes('data-auth-login') && drawer.includes('data-auth-register'), 'the drawer offers both account actions');
  assert.match(css, /@media \(max-width: 899\.98px\)[\s\S]*?\.lp-nav-toggle \{ display: inline-flex/, 'the hamburger shows on small screens');
  assert.match(css, /@media \(max-width: 599\.98px\)[\s\S]*?\.lp-header-cta \{ display: none/, 'Create Account moves into the drawer on the smallest screens');

  const footer = html.match(/<footer[\s\S]*?<\/footer>/)[0];
  for (const [label, href] of [
    ['Home', '/'], ['About', '/about.html'],
    ['Login', '/login'], ['Register', '/account.html#register'],
    ['Terms', '/legal.html#terms'], ['Privacy', '/legal.html#privacy'],
  ]) {
    assert.ok(footer.includes(`href="${href}"`), `the footer links ${label}`);
  }
  assert.ok(!footer.includes('href="/history.html"') || /data-member-only[^>]*>\s*Ticket History/.test(footer), 'the record link is member only');
  assert.ok(!/admin/i.test(footer), 'no admin link in the footer');
  assert.match(footer, /18\+/, 'the footer carries the 18+ notice');
  assert.match(footer, /begambleaware\.org/i, 'the footer points problem gamblers to help');
  assert.ok(html.includes('Data-driven football predictions focused on Over 1.5 Goals.'), 'the footer tagline ships');
});

test('landing styles: locked preview, timeline, reveals and mobile layouts', () => {
  for (const cls of ['lp-header', 'lp-hero', 'lp-badge', 'pv-panel', 'pv-figures', 'pv-tile',
    'pv-match', 'pv-metric', 'lp-trust', 'lp-split', 'lp-market', 'lp-target', 'lp-steps',
    'lp-features', 'lp-cta', 'lp-footer', 'lock-wrap', 'lock-panel', 'lock-mask']) {
    assert.ok(css.includes(`.${cls}`), `css/style.css must style .${cls}`);
  }
  assert.match(css, /\.pv-match-grid[^{]*\{[^}]*grid-template-columns: repeat\(3/, 'the match cards form a grid');
  assert.match(css, /@media \(max-width: 1099\.98px\)[\s\S]*?\.pv-match-grid \{ grid-template-columns: repeat\(2/, 'the match grid steps down on tablets');
  assert.match(css, /@media \(max-width: 599\.98px\)[\s\S]*?\.pv-tiles \{ grid-template-columns: 1fr/, 'the record tiles stack on phones');
  assert.match(css, /\.lp-steps\s*\{[^}]*grid-template-columns: repeat\(4/, 'the process is a four-column timeline');
  assert.match(css, /@media \(max-width: 899\.98px\)[\s\S]*?\.lp-steps \{ grid-template-columns: 1fr/, 'the process stacks on phones');
  assert.match(css, /\.reveal-ready \.reveal\.in/, 'reveal transitions exist');
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.reveal-ready \.reveal \{ opacity: 1/, 'reduced motion disables the reveal');
  assert.ok(js.includes('IntersectionObserver'), 'the reveal is driven by IntersectionObserver');
  for (const bp of ['(max-width: 1099.98px)', '(max-width: 899.98px)', '(max-width: 599.98px)']) {
    assert.ok(css.includes(`@media ${bp}`), `the landing layer has a ${bp} breakpoint`);
  }
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), 'no inline <script> tags (strict CSP)');
  assert.ok(html.includes('/js/app.js') && html.includes('/css/style.css'), 'assets are linked');
  assert.ok(html.includes('manifest.webmanifest'), 'the manifest is linked');
});

test('homepage: no fabricated data — not one figure, team, price or result', () => {
  assert.ok(!/1\.\d\d\b/.test(html.replace(/2\.00|4\.00|1\.5/g, '')), 'no fabricated decimal odds');
  assert.ok(!/\b\d{1,2}\s+(?:vs|v)\s+\d{1,2}\b/i.test(html), 'no fabricated scores');
  assert.ok(!/\bWON\b|\bLOST\b/.test(html), 'no fabricated results');
  // "Over 1.5" is the market name, not a count — strip it before checking
  const noMarket = html.replace(/Over\s*1\.5/gi, 'MARKET').replace(/1\.5/g, 'MARKET');
  assert.ok(!/\b(\d+)\s*(picks?|selections?|wins?|losses?)\b/i.test(noMarket), 'no fabricated pick counts');
  assert.ok(!/\b\d{1,3}%\b/.test(html), 'no fabricated percentages');
  assert.match(html, /id="year">\d{4}</, 'the copyright year ships as a no-JS fallback');
  assert.ok(js.includes('#year'), 'and is refreshed from the clock');
});

test('about page: public, static and admin-free', () => {
  assert.ok(aboutHtml.includes('lp-header'), 'the about page shares the public header');
  assert.match(aboutHtml, /football analysis service, not a betting shop/i, 'about explains what GoalPredict is');
  assert.match(aboutHtml, /No fabricated fixtures, teams or markets\./, 'about states the fabrication rule');
  assert.match(aboutHtml, /No guarantee of profit, ever\./, 'about states the no-guarantee rule');
  assert.ok(!/\/api\//.test(aboutHtml), 'about makes no API call of its own');
  assert.ok(!/admin/i.test(aboutHtml), 'the about page never mentions the console');
});
