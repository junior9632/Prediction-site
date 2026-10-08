/* Homepage contract — the public landing page.
 *
 * Two jobs, checked from both ends:
 *
 *   1. It is a MARKETING / SPORTS-INTELLIGENCE page. It may show the public
 *      preview (today's published ticket, the published record, today's
 *      analysed fixtures) because every one of those is already served to an
 *      anonymous visitor on /ticket, /analytics and /predictions.
 *
 *   2. It must never show or fetch anything ACCOUNT-SCOPED. Dashboard
 *      activity, account statistics, personal ticket history and notifications
 *      belong to /dashboard, and the server refuses them without a verified,
 *      active session (`tests/dashboard-activity.test.js` proves that side).
 *      Here we prove the public side: the page it serves, the endpoints its
 *      script is allowed to touch, and what it actually requests at runtime.
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
const { createApp, PUBLIC_DIR } = require('../server/app');

const read = (p) => fs.readFileSync(path.join(PUBLIC_DIR, p), 'utf8');
const html = read('index.html');
const css = read('css/style.css');
const js = read('js/app.js');
const aboutHtml = read('about.html');

/* The public endpoints the landing page is allowed to read. Each one is
   asserted below to answer 200 for a guest. */
const PUBLIC_ENDPOINTS = ['/api/ticket/today', '/api/analytics', '/api/predictions?limit=6'];
const PRIVATE_MARKERS = ['dashboard', 'admin', 'activity', 'auth/me', 'auth/login', 'auth/register'];

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

/* ------------------------------------------------------------------ */
/* structure & copy                                                    */
/* ------------------------------------------------------------------ */

test('homepage: the sports-intelligence structure from the brief is complete and in order', () => {
  const order = [
    'class="site-header lp-header"',
    'class="lp-hero"',
    'id="public-record"',
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
  assert.match(html, /href="\/ticket\.html"[^>]*>\s*View Today's Predictions/s, "the hero CTA opens today's predictions");
  assert.match(html, /href="\/account\.html#register"[^>]*data-auth-register>Create Free Account/, 'the hero offers account creation');

  // what is GoalPredict — the AI explanation
  assert.match(html, /Football predictions built around data/i, 'the "what is GoalPredict" heading exists');
  assert.ok(html.includes('GoalPredict analyses football fixtures using real match information'), 'the explanation paragraph ships');

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

  // final CTA
  assert.match(html, /Ready to see the predictions\?/, 'the final CTA heading exists');
  assert.match(html, /href="\/predictions\.html"[^>]*>View Predictions/, 'the final CTA links the predictions page');
  assert.match(html, /href="\/account\.html#register"[^>]*>Create Account/, 'the final CTA links registration');
});

test('homepage: ACCEPTANCE — a visitor sees the PUBLIC preview and no dashboard activity', () => {
  // 1. the public preview surfaces exist and are wired to the public endpoints
  for (const id of ['pvPill', 'pvPillText', 'pvPicks', 'pvOdds', 'pvProbability', 'pvNote', 'pvGenerated']) {
    assert.ok(html.includes(`id="${id}"`), `the hero preview renders #${id}`);
  }
  for (const id of ['statSettled', 'statTicketWinRate', 'statLegWinRate', 'statRoi']) {
    assert.ok(html.includes(`id="${id}"`), `the public record renders #${id}`);
  }
  assert.ok(html.includes('id="matchCards"'), 'the match/prediction card grid exists');
  assert.match(html, /Today's matches/, 'the match section is titled');
  assert.match(js, /API\.get\(PUBLIC\.ticket\)/, "js/app.js reads today's published ticket");
  assert.match(js, /API\.get\(PUBLIC\.analytics\)/, 'js/app.js reads the published record');
  assert.match(js, /API\.get\(PUBLIC\.predictions\)/, 'js/app.js reads the analysed fixtures');

  // 2. dashboard / account-scoped vocabulary and surfaces are absent
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
  for (const needle of [
    '/api/dashboard', '/api/admin', 'activityFeed', 'js/dashboard.js', 'js/admin.js',
    'data-auth-admin', 'dashboardActivity',
  ]) {
    assert.ok(!html.includes(needle), `index.html must not reference ${needle}`);
    assert.ok(!js.includes(needle), `js/app.js must not reference ${needle}`);
    assert.ok(!aboutHtml.includes(needle), `about.html must not reference ${needle}`);
  }
  assert.ok(!/\/admin\b/.test(html), 'the homepage must not link the admin surface');
  assert.ok(!/admin/i.test(html), 'the word "admin" must not appear on the homepage at all');

  // the member area is named only by the session-aware chips
  const accountChips = [
    ...(html.match(/data-auth-signed[\s\S]*?<\/span>/g) || []),
    ...(html.match(/<a[^>]*data-auth-name-mobile[\s\S]*?<\/a>/g) || []),
  ];
  assert.equal(accountChips.length, 2, 'the header carries two signed-in chips (desktop + mobile)');
  // one marketing sentence is allowed to explain that an account adds a
  // personal area; it is not a link and it names no data
  const EXPLAINER = 'Everything public stays free — an account adds your own dashboard.';
  assert.ok(html.includes(EXPLAINER), 'the CTA explains what an account adds');
  const withoutChips = accountChips
    .reduce((text, chip) => text.split(chip).join(''), html)
    .split(EXPLAINER)
    .join('');
  assert.ok(!/dashboard/i.test(withoutChips), 'the member area is only named by the signed-in chips');
  assert.ok(!/href="\/dashboard"/.test(withoutChips), 'no dashboard link exists for a visitor');
});

test('homepage: the script can only reach public endpoints (static allowlist)', () => {
  const calls = [...js.matchAll(/API\.get\(\s*(?:'([^']+)'|PUBLIC\.(\w+))/g)].map((m) => m[1] || `PUBLIC.${m[2]}`);
  assert.ok(calls.length >= 3, 'the homepage reads the public preview endpoints');

  // every literal path must be a documented public endpoint
  const literal = calls.filter((c) => c.startsWith('/'));
  for (const call of literal) {
    assert.ok(PUBLIC_ENDPOINTS.includes(`/api${call}`), `${call} must be one of the public endpoints`);
  }
  // ... and resolving the PUBLIC map (used for the rest) must stay public too
  const mapBlock = js.match(/const PUBLIC = \{[\s\S]*?\};/);
  assert.ok(mapBlock, 'js/app.js declares its public endpoint map');
  const map = [...mapBlock[0].matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => `/api${m[2]}`);
  assert.deepEqual([...map].sort(), [...PUBLIC_ENDPOINTS].sort(), 'the PUBLIC map is exactly the public preview set');

  // no call may name a private surface at all
  for (const call of [...calls, ...map]) {
    for (const marker of PRIVATE_MARKERS) {
      assert.ok(!call.toLowerCase().includes(marker), `${call} must not touch ${marker}`);
    }
  }
  assert.ok(!/\bfetch\(/.test(js), 'js/app.js opens no raw fetch of its own');
  assert.ok(!/XMLHttpRequest/.test(js), 'js/app.js opens no XHR of its own');
});

test('homepage: at runtime it requests nothing private (executed script trace)', async () => {
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

  const replies = {
    '/api/ticket/today': { status: 'QUALIFIED', selectionCount: 3, totalOdds: '2.20', estimatedProbability: 0.5916, generatedAt: '2026-10-08T13:51:46.000Z', oddsWindow: { min: 2, max: 4 }, selections: [] },
    '/api/analytics': { tickets: { total: 15, settled: 9, winRate: 66.67, pending: 1 }, over15: { winRate: 85.71 }, flatStake: { staked: 10, profit: 4.18, roi: 41.79 } },
    '/api/predictions?limit=6': { items: [{ fixtureId: 1, kickoffAt: '2026-10-08T15:00:00.000Z', league: { name: 'Test League' }, homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, eligible: true, modelProbability: 0.88, expectedGoals: { total: 3.9 }, over15Rates: { home: 85 }, odds: { available: true, value: '1.28', bookmaker: 'Bet365', verifiedAt: '2026-10-08T13:00:00.000Z' } }] },
  };

  const fetchStub = async (url) => {
    asked.push(url);
    if (url.endsWith('/api/auth/me')) return { ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'UNAUTHORIZED' } }) };
    if (Object.prototype.hasOwnProperty.call(replies, url)) return { ok: true, status: 200, json: async () => ({ ok: true, data: replies[url] }) };
    throw new Error(`the homepage tried to load ${url}`);
  };

  const window = { document, addEventListener() {}, innerWidth: 1440, location: { href: '/' }, matchMedia: () => ({ matches: false }) };
  const ctx = {
    window, document, fetch: fetchStub, navigator: {}, console,
    setTimeout, Promise, Object, Array, String, Number, Boolean, RegExp, Math, Date, JSON, Error,
    encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/api.js'), ctx, { filename: 'api.js' });
  vm.runInContext(js, ctx, { filename: 'app.js' });

  await document._h.DOMContentLoaded();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const paths = asked.map((u) => u.replace(/^\/api/, '/api'));
  // exactly the public preview set, plus the shared session check
  const expected = new Set(['/api/auth/me', ...PUBLIC_ENDPOINTS]);
  for (const p of paths) assert.ok(expected.has(p), `the homepage requested ${p}, which is not a public endpoint`);
  for (const p of PUBLIC_ENDPOINTS) assert.ok(paths.includes(p), `the homepage requested ${p}`);
  for (const p of paths) {
    for (const marker of PRIVATE_MARKERS.filter((m) => m !== 'auth/me')) {
      assert.ok(!p.toLowerCase().includes(marker), `no dashboard/admin request may be made (saw ${p})`);
    }
  }

  // and the public data actually painted the preview
  assert.equal(nodes.get('pvPillText').textContent, 'Published');
  assert.equal(nodes.get('pvPicks').textContent, '3');
  assert.equal(nodes.get('pvOdds').textContent, '2.20');
  assert.equal(nodes.get('pvProbability').textContent, '59%');
  assert.equal(nodes.get('statSettled').textContent, '9');
  assert.equal(nodes.get('statTicketWinRate').textContent, '67%');
  assert.match(nodes.get('matchCards').innerHTML, /pv-match/, 'the match cards render');
});

/* ------------------------------------------------------------------ */
/* server side: public is public, private is private                    */
/* ------------------------------------------------------------------ */

test('homepage: every endpoint it reads is public, and the private ones are refused', async () => {
  const ctx = fakeDb.install({ admins: [], settings: [], fixtures: [], teamForms: [], leagues: [] });
  settingsService.invalidateCache();
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 1. what the homepage shows is readable by a guest — no session, no cookie
    for (const endpoint of PUBLIC_ENDPOINTS) {
      const res = await fetch(`${base}${endpoint}`, { headers: { Accept: 'application/json' } });
      assert.equal(res.status, 200, `${endpoint} must answer a guest with 200`);
      const body = await res.json();
      assert.equal(body.ok, true, `${endpoint} returns the public envelope`);
      assert.ok(!/dashboard|activity/i.test(JSON.stringify(body)), `${endpoint} carries no activity data`);
    }

    // 2. the account-scoped side is refused for a guest: 401, no payload
    const activity = await fetch(`${base}/api/dashboard/activity`, { headers: { Accept: 'application/json' } });
    assert.equal(activity.status, 401, 'a guest gets 401 from the activity API');
    const payload = await activity.json();
    assert.equal(payload.data, undefined, 'the refusal carries no data');
    assert.equal(activity.headers.get('cache-control'), 'no-store');

    // 3. and the page that renders it is not even served to a guest
    const dashboard = await fetch(`${base}/dashboard`, { redirect: 'manual' });
    assert.equal(dashboard.status, 302);
    assert.equal(dashboard.headers.get('location'), '/account.html');

    // 4. the homepage HTML a guest receives contains no activity payload
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const servedHtml = await home.text();
    assert.ok(!/dashboard activity/i.test(servedHtml), 'the served homepage has no dashboard activity block');
    assert.ok(!servedHtml.includes('/api/dashboard'), 'the served homepage names no dashboard endpoint');
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
  for (const label of ['Home', "Today's Predictions", 'Matches', 'Analytics']) {
    assert.ok(nav.includes(`>${label}<`), `the desktop nav keeps ${label}`);
  }
  assert.ok(!/admin/i.test(nav), 'no admin entry in the primary navigation');
  assert.ok(!/dashboard/i.test(nav), 'no dashboard entry in the primary navigation');

  assert.match(html, /data-auth-login>Login</, 'the header offers Login');
  assert.match(html, /data-auth-register>Create Account</, 'the header offers Create Account');
  assert.match(read('js/api.js'), /\[data-auth-register\]/, 'the Create Account button is session aware');

  assert.ok(html.includes('id="navToggle"'), 'the header renders a hamburger toggle');
  assert.match(html, /aria-controls="mobileMenu"/, 'the toggle controls the drawer');
  const drawer = html.match(/<div class="lp-mobile-menu"[\s\S]*?<\/div>\s*<\/header>/)[0];
  for (const label of ['Home', "Today's Predictions", 'Matches', 'Analytics']) {
    assert.ok(drawer.includes(`>${label}<`), `the mobile drawer keeps ${label}`);
  }
  assert.ok(drawer.includes('data-auth-login') && drawer.includes('data-auth-register'), 'the drawer offers both account actions');
  assert.match(css, /@media \(max-width: 899\.98px\)[\s\S]*?\.lp-nav-toggle \{ display: inline-flex/, 'the hamburger shows on small screens');
  assert.match(css, /@media \(max-width: 599\.98px\)[\s\S]*?\.lp-header-cta \{ display: none/, 'Create Account moves into the drawer on the smallest screens');

  const footer = html.match(/<footer[\s\S]*?<\/footer>/)[0];
  for (const [label, href] of [
    ['Home', '/'], ["Today's Predictions", '/ticket.html'], ['Matches', '/predictions.html'],
    ['Analytics', '/analytics.html'], ['Results', '/history.html'], ['About', '/about.html'],
    ['Login', '/login'], ['Register', '/account.html#register'],
    ['Terms', '/legal.html#terms'], ['Privacy', '/legal.html#privacy'],
  ]) {
    assert.ok(footer.includes(`href="${href}"`), `the footer links ${label}`);
  }
  assert.ok(!/admin/i.test(footer), 'no admin link in the footer');
  assert.match(footer, /18\+/, 'the footer carries the 18+ notice');
  assert.match(footer, /begambleaware\.org/i, 'the footer points problem gamblers to help');
  assert.ok(html.includes('Data-driven football predictions focused on Over 1.5 Goals.'), 'the footer tagline ships');
});

test('landing styles: preview surfaces, timeline, reveals and mobile layouts', () => {
  for (const cls of ['lp-header', 'lp-hero', 'lp-badge', 'pv-panel', 'pv-figures', 'pv-tile',
    'pv-match', 'pv-metric', 'lp-trust', 'lp-split', 'lp-market', 'lp-target', 'lp-steps',
    'lp-features', 'lp-cta', 'lp-footer']) {
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

test('homepage: no fabricated data — every figure is painted from a public endpoint', () => {
  // static copy may state the product's rules, never invented results
  assert.ok(!/1\.\d\d\b/.test(html.replace(/2\.00|4\.00|1\.5/g, '')), 'no fabricated decimal odds');
  assert.ok(!/\b\d{1,2}\s+(?:vs|v)\s+\d{1,2}\b/i.test(html), 'no fabricated scores');
  assert.ok(!/\bWON\b|\bLOST\b/.test(html), 'no fabricated results');
  assert.ok(!/\b(\d+)\s*(picks?|selections?|wins?|losses?)\b/i.test(html), 'no fabricated pick counts');
  assert.match(html, /id="year">\d{4}</, 'the copyright year ships as a no-JS fallback');
  assert.ok(js.includes('#year'), 'and is refreshed from the clock');
  // the figure placeholders render as em-dashes until real data arrives
  for (const id of ['pvPicks', 'pvOdds', 'pvProbability', 'statSettled', 'statTicketWinRate', 'statLegWinRate', 'statRoi']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*>—<`), `#${id} starts as an empty placeholder`);
  }
});

test('about page: public, static and admin-free', () => {
  assert.ok(aboutHtml.includes('lp-header'), 'the about page shares the public header');
  assert.match(aboutHtml, /football analysis service, not a betting shop/i, 'about explains what GoalPredict is');
  assert.match(aboutHtml, /No fabricated fixtures, teams or markets\./, 'about states the fabrication rule');
  assert.match(aboutHtml, /No guarantee of profit, ever\./, 'about states the no-guarantee rule');
  assert.ok(aboutHtml.includes('href="/predictions.html"'), 'about links the predictions page');
  assert.ok(!/\/api\//.test(aboutHtml), 'about makes no API call of its own');
  assert.ok(!/admin/i.test(aboutHtml), 'the about page never mentions the console');
});
