/* Homepage contract — the public landing page.
 *
 * Two jobs, checked from both ends:
 *
 *   1. It is a MARKETING page. It explains the product, how the AI works and
 *      what a membership unlocks. It renders NO prediction data: no fixture,
 *      no team, no league, no odds, no pick, no confidence figure, no ticket
 *      total, no win rate, no ROI. The figures that used to sit in the hero,
 *      in the record tiles and in the match grid are prediction data, so they
 *      moved behind the login with the pages they belong to.
 *
 *   2. It must never show, fetch or link anything ACCOUNT-SCOPED either.
 *      Dashboard activity, account statistics and personal ticket history
 *      belong to /dashboard, and the server refuses them without a verified,
 *      active session (`tests/dashboard-activity.test.js` proves that side).
 *      Here we prove the public side: the page it serves, the endpoints its
 *      script is allowed to touch (only the session check), what it actually
 *      requests at runtime, and that the prediction APIs it no longer calls
 *      would answer a visitor with 401 anyway.
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

/* The only request the landing page may make: the shared session check that
   tells the header WHO is signed in. It answers with the account name and
   nothing else — no prediction, no ticket, no activity feed. */
const SESSION_ENDPOINT = '/api/auth/me';

/* The prediction surface. Every one of these is members only, so the landing
   page must not call them and a visitor must not be able to read them. */
const MEMBER_ENDPOINTS = [
  '/api/predictions',
  '/api/predictions/1',
  '/api/ticket/today',
  '/api/tickets/today',
  '/api/tickets/history',
  '/api/analytics',
  '/api/fixtures',
  '/api/odds',
];

const PRIVATE_MARKERS = ['dashboard', 'admin', 'activity', 'predictions', 'ticket', 'analytics', 'fixtures', 'odds'];

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
    'id="member-access"',
    'id="inside-the-product"',
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
  assert.match(html, /Unlock AI Football Predictions/, 'the hero CTA is the unlock pitch');
  assert.match(html, /Login to view today's predictions →/, "the hero offers the login CTA");
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
  assert.match(html, /Unlock AI Football Predictions/, 'the final CTA heading is the unlock pitch');
  assert.match(html, /href="\/login\?next=%2Fticket"[^>]*data-auth-guest-only>Login to view today's predictions →/, 'the final CTA sends a visitor to the sign-in door');
  assert.match(html, /href="\/account\.html#register"[^>]*data-auth-register>Create Account/, 'the final CTA links registration');
});

test('homepage: ACCEPTANCE — a visitor sees marketing only, never prediction data', () => {
  // 1. the preview surfaces are LOCKED placeholders, not data containers
  assert.ok(html.includes('class="pv-panel pv-locked'), 'the hero panel is the locked preview');
  assert.ok(html.includes('id="pvTitle"'), 'the locked panel is labelled');
  assert.match(html, /Members only/, 'the panel says the data is members only');
  for (const phrase of [
    "Today's verified Over 1.5 selections",
    'Bookmaker odds, frozen at generation time',
    'Confidence, data-quality and risk scores',
    'The transparent breakdown behind every pick',
  ]) {
    assert.ok(html.includes(phrase), `the locked panel names ${phrase}`);
  }

  // none of the old live-data hooks survive: they could only ever be filled
  // by calling a prediction endpoint
  for (const id of ['pvPicks', 'pvOdds', 'pvProbability', 'pvNote', 'pvGenerated', 'pvPillText', 'matchCards', 'statSettled', 'statTicketWinRate', 'statLegWinRate', 'statRoi']) {
    assert.ok(!new RegExp(`id="${id}"`).test(html), `the homepage no longer renders #${id}`);
  }

  // 2. no prediction vocabulary that would indicate live data
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
    '/api/dashboard', '/api/admin', '/api/predictions', '/api/ticket', '/api/analytics', '/api/fixtures', '/api/odds',
    'activityFeed', 'js/dashboard.js', 'js/admin.js', 'js/predictions.js', 'js/ticket.js', 'js/analytics.js',
    'data-auth-admin', 'dashboardActivity',
  ]) {
    assert.ok(!html.includes(needle), `index.html must not reference ${needle}`);
    assert.ok(!js.includes(needle), `js/app.js must not reference ${needle}`);
    assert.ok(!aboutHtml.includes(needle), `about.html must not reference ${needle}`);
  }
  assert.ok(!/\/admin\b/.test(html), 'the homepage must not link the admin surface');
  assert.ok(!/admin/i.test(html), 'the word "admin" must not appear on the homepage at all');

  // the member area is named only by the session-aware controls
  const memberControls = html.match(/data-auth-only/g) || [];
  assert.ok(memberControls.length >= 10, 'the header, drawer, sections and footer all carry session-aware member links');
  for (const entry of html.match(/<a[^>]*data-auth-only[^>]*>[^<]*<\/a>/g) || []) {
    assert.match(entry, /class="[^"]*\bhidden\b/, `a member-only link ships hidden: ${entry}`);
  }

  const EXPLAINER = 'Login or create a free account to open them.';
  assert.ok(html.includes(EXPLAINER), 'the CTA explains what an account adds');
  const sessionChips = [
    ...(html.match(/<a[^>]*data-auth-only[^>]*>[^<]*<\/a>/g) || []),
    ...(html.match(/data-auth-signed[\s\S]*?<\/span>/g) || []),
    ...(html.match(/<a[^>]*data-auth-name-mobile[^>]*>[^<]*<\/a>/g) || []),
  ];
  assert.ok(sessionChips.length >= 12, 'the member surfaces are all session aware');
  const withoutMemberLinks = sessionChips
    .reduce((text, chip) => text.split(chip).join(''), html)
    .split(EXPLAINER)
    .join('');
  assert.ok(!/href="\/dashboard"/.test(withoutMemberLinks), 'no dashboard link exists for a visitor');
});

test('homepage: the script can only reach the session endpoint (static allowlist)', () => {
  // js/app.js makes no API.get / fetch of its own any more
  assert.ok(!/API\.get\(/.test(js), 'js/app.js reads no endpoint directly');
  assert.ok(!/\bfetch\(/.test(js), 'js/app.js opens no raw fetch of its own');
  assert.ok(!/XMLHttpRequest/.test(js), 'js/app.js opens no XHR of its own');
  assert.match(js, /App\.session\.bindHeader\(\)/, 'the header session check is the one request it makes');

  // the shared session helper is the only thing that may name an endpoint
  const apiJs = read('js/api.js');
  const sessionCalls = [...apiJs.matchAll(/API\.get\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(sessionCalls.includes('/auth/me'), 'the session helper calls /auth/me');
  for (const call of sessionCalls) {
    assert.ok(!PRIVATE_MARKERS.some((marker) => call.toLowerCase().includes(marker)), `the session helper must not call ${call}`);
  }
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
    // the session check answers "nobody is signed in"; anything else is a leak
    if (url.endsWith(SESSION_ENDPOINT)) return { ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'UNAUTHORIZED' } }) };
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

  assert.deepEqual(asked, [SESSION_ENDPOINT], 'exactly one request: the shared session check');
  for (const url of asked) {
    for (const marker of PRIVATE_MARKERS.filter((m) => m !== 'auth/me')) {
      assert.ok(!url.toLowerCase().includes(marker), `no prediction or dashboard request may be made (saw ${url})`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* server side: the landing page is public, the data behind it is not    */
/* ------------------------------------------------------------------ */

test('homepage: it is public, and every prediction endpoint it does not call is refused anyway', async () => {
  const ctx = fakeDb.install({ admins: [], settings: [], fixtures: [], teamForms: [], leagues: [] });
  settingsService.invalidateCache();
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 1. the marketing page itself is public
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200, 'the homepage answers a visitor');
    const servedHtml = await home.text();
    assert.ok(!/dashboard activity/i.test(servedHtml), 'the served homepage has no dashboard activity block');
    assert.ok(!servedHtml.includes('/api/dashboard'), 'the served homepage names no dashboard endpoint');
    assert.ok(!/\/api\/(predictions|ticket|tickets|analytics|fixtures|odds)/.test(servedHtml), 'the served homepage names no prediction endpoint');

    // 2. every prediction endpoint a visitor might try from DevTools is 401
    for (const endpoint of MEMBER_ENDPOINTS) {
      const res = await fetch(`${base}${endpoint}`, { headers: { Accept: 'application/json' } });
      assert.equal(res.status, 401, `${endpoint} refuses a visitor`);
      const body = await res.json();
      assert.equal(body.ok, false, `${endpoint} reports the refusal`);
      assert.equal(body.data, undefined, `${endpoint} carries no prediction data`);
      assert.match(res.headers.get('cache-control') || '', /no-store/, `${endpoint} is never cached`);
    }

    // 3. and the pages that render them redirect to the sign-in door
    for (const page of ['/predictions', '/ticket', '/history', '/analytics', '/dashboard']) {
      const res = await fetch(`${base}${page}`, { redirect: 'manual' });
      assert.equal(res.status, 302, `${page} redirects a visitor`);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(page)}`);
    }

    // 4. the sign-in door names what was refused and offers both actions
    const door = await fetch(`${base}/login?next=%2Fpredictions`);
    assert.equal(door.status, 200);
    const doorHtml = await door.text();
    assert.match(doorHtml, /Football Predictions/);
    assert.match(doorHtml, /Login or create an account to access GoalPredict AI football predictions\./);
    assert.match(doorHtml, />Login</);
    assert.match(doorHtml, />Create Account</);

    // 5. the still-public endpoints carry branding and rules only — no fixture,
    //    team, odds, pick, confidence value or history row
    for (const endpoint of ['/api/health', '/api/meta']) {
      const res = await fetch(`${base}${endpoint}`, { headers: { Accept: 'application/json' } });
      assert.equal(res.status, 200, `${endpoint} stays public`);
      const body = await res.json();
      const text = JSON.stringify(body);
      assert.equal(body.ok, true);
      for (const leak of ['"homeTeam"', '"awayTeam"', '"selections"', '"confidence"', '"fixtureId"', '"bookmaker"', '"odds"', '"items"', '"prediction"']) {
        assert.ok(!text.includes(leak), `${endpoint} carries no ${leak}`);
      }
    }
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
  // the member navigation the brief asks for after login
  for (const label of ['Dashboard', 'Predictions', "Today's Ticket", 'Ticket History', 'Analytics']) {
    assert.ok(nav.includes(`>${label}<`), `the desktop nav carries ${label} for a member`);
  }
  assert.ok(!/admin/i.test(nav), 'no admin entry in the primary navigation');
  for (const entry of nav.match(/<a[^>]*data-auth-only[^>]*>[^<]*<\/a>/g) || []) {
    assert.match(entry, /class="[^"]*\bhidden\b/, `${entry} is hidden until the session is verified`);
  }

  assert.match(html, /data-auth-login>Login</, 'the header offers Login');
  assert.match(html, /data-auth-register>Create Account</, 'the header offers Create Account');
  const apiJs = read('js/api.js');
  assert.match(apiJs, /\[data-auth-register\]/, 'the Create Account button is session aware');
  assert.match(apiJs, /\[data-auth-only\]/, 'the member navigation is revealed by the session check');
  assert.match(apiJs, /\[data-auth-guest-only\]/, 'the guest CTAs are hidden once somebody is signed in');

  assert.ok(html.includes('id="navToggle"'), 'the header renders a hamburger toggle');
  assert.match(html, /aria-controls="mobileMenu"/, 'the toggle controls the drawer');
  const drawer = html.match(/<div class="lp-mobile-menu"[\s\S]*?<\/div>\s*<\/header>/)[0];
  for (const label of ['Home', 'About', 'Dashboard', 'Predictions', "Today's Ticket", 'Ticket History', 'Analytics']) {
    assert.ok(drawer.includes(`>${label}<`), `the mobile drawer keeps ${label}`);
  }
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
  // member destinations stay in the footer, hidden for a visitor
  for (const href of ['/predictions.html', '/ticket.html', '/history.html', '/analytics.html']) {
    const link = (footer.match(new RegExp(`<a[^>]*href="${href.replace(/\./g, '\\.')}"[^>]*>[^<]*<\\/a>`)) || [])[0];
    assert.ok(link, `the footer keeps a ${href} link for members`);
    assert.match(link, /data-auth-only/, `the ${href} footer link is session aware`);
    assert.match(link, /class="[^"]*\bhidden\b/, `the ${href} footer link ships hidden`);
  }
  assert.ok(!/admin/i.test(footer), 'no admin link in the footer');
  assert.match(footer, /18\+/, 'the footer carries the 18+ notice');
  assert.match(footer, /begambleaware\.org/i, 'the footer points problem gamblers to help');
  assert.ok(html.includes('Data-driven football predictions focused on Over 1.5 Goals.'), 'the footer tagline ships');
});

test('landing styles: locked surfaces, timeline, reveals and mobile layouts', () => {
  for (const cls of ['lp-header', 'lp-hero', 'lp-badge', 'pv-panel', 'pv-locked', 'pv-locked-list',
    'pv-tile', 'pv-match', 'pv-match-locked', 'lp-trust', 'lp-split', 'lp-market', 'lp-target',
    'lp-steps', 'lp-features', 'lp-cta', 'lp-footer', 'auth-required', 'empty-state.locked']) {
    assert.ok(css.includes(`.${cls.split('.')[0]}`), `css/style.css must style .${cls}`);
  }
  assert.ok(css.includes('.pv-panel.pv-locked'), 'the locked hero panel is styled');
  assert.ok(css.includes('.pv-match-locked'), 'the locked fixture cards are styled');
  assert.ok(css.includes('.auth-required'), 'the login-required panel is styled');
  assert.match(css, /\.pv-match-grid[^{]*\{[^}]*grid-template-columns: repeat\(3/, 'the fixture cards form a grid');
  assert.match(css, /@media \(max-width: 1099\.98px\)[\s\S]*?\.pv-match-grid \{ grid-template-columns: repeat\(2/, 'the card grid steps down on tablets');
  assert.match(css, /@media \(max-width: 599\.98px\)[\s\S]*?\.pv-tiles \{ grid-template-columns: 1fr/, 'the tiles stack on phones');
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

test('homepage: no fabricated data — the page publishes no figure at all', () => {
  // static copy may state the product's rules, never invented results.
  // Stripped first: the market name (Over 1.5), the published 2.00-4.00 odds
  // window, and the decorative aria-hidden pipeline bars (style="--h: 42%"),
  // which are a graphic, not a figure.
  const prose = html
    .replace(/style="--h:\s*\d+%"/g, '')
    .replace(/2\.00|4\.00|1\.5/g, '');
  assert.ok(!/1\.\d\d\b/.test(prose), 'no fabricated decimal odds');
  assert.ok(!/\b\d{1,2}\s+(?:vs|v)\s+\d{1,2}\b/i.test(html), 'no fabricated scores');
  assert.ok(!/\bWON\b|\bLOST\b/.test(html), 'no fabricated results');
  assert.ok(!/\b(\d+)\s*(picks?|selections?|wins?|losses?)\b/i.test(prose), 'no fabricated pick counts');
  assert.ok(!/\b\d{1,3}%/.test(prose), 'no fabricated percentage (win rate, confidence, probability)');
  assert.match(html, /id="year">\d{4}</, 'the copyright year ships as a no-JS fallback');
  assert.ok(js.includes('#year'), 'and is refreshed from the clock');
});

test('about page: public, static and admin-free', () => {
  assert.ok(aboutHtml.includes('lp-header'), 'the about page shares the public header');
  assert.match(aboutHtml, /football analysis service, not a betting shop/i, 'about explains what GoalPredict is');
  assert.match(aboutHtml, /No fabricated fixtures, teams or markets\./, 'about states the fabrication rule');
  assert.match(aboutHtml, /No guarantee of profit, ever\./, 'about states the no-guarantee rule');
  assert.ok(aboutHtml.includes('href="/predictions.html"'), 'about keeps a predictions link for members');
  assert.ok(aboutHtml.includes('/login?next=%2Fpredictions'), 'about sends a visitor to the sign-in door instead');
  assert.ok(!/\/api\//.test(aboutHtml), 'about makes no API call of its own');
  assert.ok(!/admin/i.test(aboutHtml), 'the about page never mentions the console');
});
