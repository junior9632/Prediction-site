/* Homepage contract.
 *
 * The public homepage is MARKETING. It must read as a product landing page for
 * an anonymous visitor and must never become a dashboard: no ticket, no odds,
 * no accumulator, no statistics, no account-scoped data and no privileged
 * surface. The signed-in experience lives at /dashboard, the operator console
 * at /admin — this suite pins the separation.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUBLIC_DIR, p), 'utf8');

const JS_CALLS = /\/api\//;
const html = read('index.html');
const css = read('css/style.css');
const js = read('js/app.js');
const aboutHtml = read('about.html');

/* The one phrase from the product rules that legitimately contains the word
   "accumulator": the homepage explains the rule, it never renders one. */
const RULE_STATEMENT = 'No forced accumulator.';

/* The daily-target pledges are the product's own rules; two of them name the
   thing the homepage must not render. They are stripped before the forbidden
   vocabulary check so the rule can still be stated in full. */
const RULE_SENTENCES = [
  RULE_STATEMENT,
  'No fabricated selections.',
  'Only qualifying selections are published.',
  'If no qualifying combination exists, we show no qualifying ticket.',
  'Our daily accumulator target is between 2.00 and 4.00 total decimal odds.',
];

test('homepage: the marketing structure from the brief is complete and in order', () => {
  const order = [
    'class="site-header lp-header"',
    'class="lp-hero"',
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

  // hero copy, badge, buttons
  assert.match(html, /Daily Over 1\.5 Goals/, 'the hero badge names the market');
  assert.match(html, /AI-Powered/, 'the hero headline is the AI pitch');
  assert.match(html, /Football Predictions/, 'the hero headline names the product');
  assert.ok(
    html.includes('Smarter football insights built from real fixtures, verified bookmaker odds and'),
    'the hero supporting text ships verbatim'
  );
  assert.match(html, /href="\/predictions\.html"[^>]*>\s*View Today's Predictions/s, 'primary hero CTA leads to the predictions page');
  assert.match(html, /href="#how-it-works"[^>]*>How It Works/, 'secondary hero CTA scrolls to the process');

  // trust strip: four cards, exact copy
  for (const [title, body] of [
    ['Real Football Data', 'Fixtures and football statistics from reliable data sources.'],
    ['Verified Bookmaker Odds', 'Use verified bookmaker prices instead of invented odds.'],
    ['One Clear Market', 'We focus exclusively on Over 1.5 Goals.'],
    ['No Forced Picks', 'If no qualifying combination exists, we show no qualifying ticket.'],
  ]) {
    assert.ok(html.includes(title), `trust card "${title}" is present`);
    assert.ok(html.includes(body), `trust card "${title}" keeps its copy`);
  }

  // what is goalpredict
  assert.match(html, /Football predictions built around data/i, 'the "what is GoalPredict" heading exists');
  assert.ok(
    html.includes('real match information, historical\n            performance, goal trends and verified bookmaker prices'),
    'the "what is GoalPredict" paragraph ships verbatim'
  );

  // our only market
  assert.match(html, /One market\. One focus\./, 'the market label exists');
  assert.match(html, /Over <span class="accent">1\.5<\/span> Goals/, 'the market headline is Over 1.5 Goals');
  for (const [title, body] of [
    ['Goal Trends', 'Historical goal-scoring patterns.'],
    ['Match Data', 'Recent and relevant football statistics.'],
    ['Verified Odds', 'Real bookmaker prices only.'],
  ]) {
    assert.ok(html.includes(title), `market card "${title}" is present`);
    assert.ok(html.includes(body), `market card "${title}" keeps its copy`);
  }

  // daily target
  assert.match(html, /Daily target/, 'the daily-target label exists');
  assert.match(html, /2\.00\s*<span class="lp-target-dash">—<\/span>\s*4\.00/, 'the 2.00 - 4.00 target is stated');
  assert.ok(html.includes('Our daily accumulator target is between 2.00 and 4.00 total decimal odds.'));
  for (const pledge of ['No artificial odds.', 'No fabricated selections.', RULE_STATEMENT]) {
    assert.ok(html.includes(pledge), `the rule "${pledge}" is stated`);
  }

  // how it works: numbered process
  for (const [num, title, body] of [
    ['01', 'Collect', 'Football fixtures and match data are collected.'],
    ['02', 'Analyse', 'The system evaluates relevant football statistics and goal trends.'],
    ['03', 'Verify', 'Available Over 1.5 bookmaker odds are checked and validated.'],
    ['04', 'Publish', 'Only qualifying selections are published.'],
  ]) {
    assert.ok(html.includes(num), `step ${num} is numbered`);
    assert.ok(html.includes(title), `step ${num} is titled ${title}`);
    assert.ok(html.includes(body), `step ${num} keeps its copy`);
  }

  // why goalpredict: six features
  for (const [title, body] of [
    ['Real Data', 'Built around real football information.'],
    ['Verified Odds', 'No invented bookmaker prices.'],
    ['Over 1.5 Only', 'One focused prediction market.'],
    ['2.00&ndash;4.00 Target', 'A clear daily odds range.'],
    ['No Forced Picks', 'No qualifying combination means no ticket.'],
    ['Transparent Results', 'Published tickets can be tracked through results and history.'],
  ]) {
    assert.ok(html.includes(title), `feature "${title}" is present`);
    assert.ok(html.includes(body), `feature "${title}" keeps its copy`);
  }

  // final CTA
  assert.match(html, /Ready to see the predictions\?/, 'the final CTA heading exists');
  assert.ok(html.includes("Explore today's football predictions and follow GoalPredict's latest results."));
  assert.match(html, /href="\/predictions\.html"[^>]*>View Predictions/, 'the final CTA links the predictions page');
  assert.match(html, /href="\/account\.html#register"[^>]*>Create Account/, 'the final CTA links registration');
});

test('homepage: ACCEPTANCE — an anonymous visitor sees no dashboard, no data widgets', () => {
  // 1. the user's own forbidden list, checked against the rendered markup.
  //    The single product rule that names the accumulator is excluded because
  //    it states the rule; every other mention is forbidden.
  const withoutRule = RULE_SENTENCES.reduce((text, sentence) => text.split(sentence).join(''), html);
  const forbidden = [
    "Today's Ticket",
    "Today's Accumulator",
    'Number of Selections',
    'Total Odds',
    'Ticket Status',
    'Pending Status',
    'No Qualifying Ticket',
    'Latest Settled Tickets',
    'Generate Ticket',
    'Accumulator',
    'Dashboard statistics',
    'Activity Feed',
  ];
  for (const phrase of forbidden) {
    assert.ok(
      !new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(withoutRule),
      `the homepage must not contain "${phrase}"`
    );
  }
  const ruleText = RULE_SENTENCES.join(' ');
  assert.equal(
    (html.match(/accumulator/gi) || []).length,
    (ruleText.match(/accumulator/gi) || []).length,
    'every mention of "accumulator" belongs to a stated product rule'
  );
  // dashboard vocabulary that only the product rules may name: once the rule
  // sentences are removed, none of it may remain anywhere on the page
  for (const word of ['accumulator', 'selection', 'confidence', 'status', 'odds target']) {
    assert.ok(
      !withoutRule.toLowerCase().includes(word),
      `"${word}" may only appear inside a stated product rule`
    );
  }

  // 2. no widget could even be painted: the markup carries no data hooks
  for (const id of [
    'accSummary', 'accPicks', 'accOdds', 'accConfidence', 'accStatusWrap', 'accGenerated',
    'pickList', 'noTicketBox', 'diagGrid', 'recentResults',
    'liveOdds', 'livePicks', 'liveConfidence', 'livePill', 'liveMessage',
    'statOdds', 'statPicks', 'statConfidence', 'statStatus', 'statMarket',
  ]) {
    assert.ok(!html.includes(`id="${id}"`), `the homepage must not render #${id}`);
  }

  // 3. and no data request could be made: the homepage script touches no API
  assert.ok(!/API\.(get|post|put|del)\(/.test(js), 'js/app.js must not call the API');
  assert.ok(!/\bfetch\(/.test(js), 'js/app.js must not fetch anything');
  assert.ok(!/XMLHttpRequest/.test(js), 'js/app.js must not open a request of any kind');

  // 4. no privileged or account-scoped surface is referenced anywhere
  for (const needle of [
    '/api/ticket', '/api/tickets', '/api/dashboard', '/api/predictions',
    '/api/fixtures', '/api/analytics', '/api/admin', 'js/dashboard.js', 'js/admin.js',
    'data-auth-admin',
  ]) {
    assert.ok(!html.includes(needle), `index.html must not reference ${needle}`);
    assert.ok(!js.includes(needle), `js/app.js must not reference ${needle}`);
    assert.ok(!aboutHtml.includes(needle), `about.html must not reference ${needle}`);
  }
  assert.ok(!/\/admin\b/.test(html), 'the public homepage must not link the admin surface');
  assert.ok(!/admin/i.test(html), 'the word "admin" must not appear on the homepage at all');
  // the signed-in chips are the only place the member area may be named, so
  // the header can point an authenticated visitor at their own workspace
  const accountChips = [
    ...(html.match(/data-auth-signed[\s\S]*?<\/span>/g) || []),
    ...(html.match(/<a[^>]*data-auth-name-mobile[\s\S]*?<\/a>/g) || []),
  ];
  assert.equal(accountChips.length, 2, 'the header carries exactly two signed-in chips (desktop + mobile)');
  const withoutChips = accountChips.reduce((text, chip) => text.split(chip).join(''), html);
  assert.ok(!/dashboard/i.test(withoutChips), 'the member area is only named by the signed-in chips');
});

test('homepage: header is premium, public and session aware', () => {
  // the five public nav entries, in order, with no privileged entry
  const nav = html.match(/<nav class="main-nav lp-nav"[\s\S]*?<\/nav>/)[0];
  for (const label of ['Home', 'Predictions', 'Results', 'Analytics', 'About']) {
    assert.ok(nav.includes(`>${label}<`), `the desktop nav keeps ${label}`);
  }
  assert.ok(!/admin/i.test(nav), 'no admin entry in the primary navigation');
  assert.ok(!/dashboard/i.test(nav), 'no dashboard entry in the primary navigation');

  // right-hand actions: Login + Get Started
  assert.match(html, /data-auth-login>Login</, 'the header offers Login');
  assert.match(html, /data-auth-register>Get Started</, 'the header offers Get Started');
  assert.match(html, /\[data-auth-register\]|data-auth-register/, 'Get Started is session aware');

  // mobile: hamburger + drawer carrying the same public links
  assert.ok(html.includes('id="navToggle"'), 'the header renders a hamburger toggle');
  assert.match(html, /aria-controls="mobileMenu"/, 'the toggle controls the drawer');
  const drawer = html.match(/<div class="lp-mobile-menu"[\s\S]*?<\/div>\s*<\/header>/)[0];
  for (const label of ['Home', 'Predictions', 'Results', 'Analytics', 'About']) {
    assert.ok(drawer.includes(`>${label}<`), `the mobile drawer keeps ${label}`);
  }
  assert.ok(drawer.includes('data-auth-login'), 'the mobile drawer offers Login');
  assert.ok(drawer.includes('data-auth-register'), 'the mobile drawer offers Get Started');
  assert.match(css, /\.lp-nav-toggle\s*\{[^}]*display: none/, 'the hamburger is hidden by default');
  assert.match(css, /@media \(max-width: 899\.98px\)[\s\S]*?\.lp-nav-toggle \{ display: inline-flex/, 'the hamburger appears on small screens');
  assert.match(css, /@media \(max-width: 599\.98px\)[\s\S]*?\.lp-header-cta \{ display: none/, 'Get Started moves into the drawer on the smallest screens');
  assert.match(css, /@media \(max-width: 899\.98px\)[\s\S]*?\.lp-nav \{ display: none/, 'the desktop nav collapses on small screens');

  // session awareness is allowed to read /auth/me only (through the shared
  // helper), so the header can show the account chip for a signed-in visitor
  const apiJs = read('js/api.js');
  assert.ok(js.includes('App.session.bindHeader()'), 'the homepage binds the shared session helper');
  assert.match(apiJs, /API\.get\('\/auth\/me'\)/, 'the shared helper reads /auth/me');
  assert.ok(!/\/auth\/me/.test(js), 'the homepage script itself never touches the session endpoint');
});

test('homepage: footer keeps the public links — and no admin door', () => {
  assert.ok(html.includes('class="site-footer lp-footer"'), 'the page ends with the site footer');
  assert.ok(html.includes('Data-driven football predictions focused on Over 1.5 Goals.'), 'the footer tagline ships verbatim');
  const footer = html.match(/<footer[\s\S]*?<\/footer>/)[0];
  for (const [label, href] of [
    ['Home', '/'],
    ['Predictions', '/predictions.html'],
    ['Results', '/history.html'],
    ['Analytics', '/analytics.html'],
    ['About', '/about.html'],
    ['Login', '/login'],
    ['Terms', '/legal.html#terms'],
    ['Privacy', '/legal.html#privacy'],
  ]) {
    assert.ok(footer.includes(`href="${href}"`), `the footer links ${label}`);
  }
  assert.ok(!/admin/i.test(footer), 'no admin link in the footer');
  assert.match(footer, /18\+/, 'the footer carries the 18+ notice');
  assert.match(footer, /begambleaware\.org/i, 'the footer points problem gamblers to help');
});

test('homepage: no fabricated data anywhere in the markup', () => {
  // The landing page states rules, not results: no odds values, no team names,
  // no scores, no dates dressed up as live information.
  assert.ok(!/1\.\d\d\b/.test(html), 'no fabricated decimal odds');
  assert.ok(!/\b(\d+)\s*(picks?|selections?|wins?|losses?)\b/i.test(html), 'no fabricated pick counts');
  assert.ok(!/\b\d{1,2}\s+(?:vs|v)\s+\d{1,2}\b/i.test(html), 'no fabricated scores');
  assert.ok(!/\bWON\b|\bLOST\b/.test(html), 'no fabricated results');
  assert.match(html, /id="year">\d{4}</, 'the copyright year ships as a no-JS fallback');
  assert.ok(js.includes('#year'), 'and is refreshed from the clock');
  // the only numbers on the page are the product's own published rules
  for (const number of ['1.5', '2.00', '4.00', '01', '02', '03', '04', '18+']) {
    assert.ok(html.includes(number), `the published rule "${number}" is present`);
  }
});

test('landing styles: designed layout, timeline, reveals, mobile-first rules', () => {
  for (const cls of ['lp-header', 'lp-hero', 'lp-hero-inner', 'lp-badge', 'lp-trust', 'lp-split',
    'lp-market', 'lp-target', 'lp-steps', 'lp-features', 'lp-cta', 'lp-footer', 'lp-chip']) {
    assert.ok(css.includes(`.${cls}`), `css/style.css must style .${cls}`);
  }
  // horizontal process on desktop, vertical rail on mobile
  assert.match(css, /\.lp-steps\s*\{[^}]*grid-template-columns: repeat\(4/, 'the process is a four-column timeline');
  assert.match(css, /@media \(max-width: 899\.98px\)[\s\S]*?\.lp-steps \{ grid-template-columns: 1fr/, 'the process stacks on phones');
  // scroll reveal, with a reduced-motion escape hatch
  assert.match(css, /\.reveal-ready \.reveal\.in/, 'reveal transitions exist');
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.reveal-ready \.reveal \{ opacity: 1/, 'reduced motion disables the reveal');
  assert.ok(js.includes('IntersectionObserver'), 'the reveal is driven by IntersectionObserver');
  // responsive breakpoints
  for (const bp of ['(max-width: 1099.98px)', '(max-width: 899.98px)', '(max-width: 599.98px)']) {
    assert.ok(css.includes(`@media ${bp}`), `the landing layer has a ${bp} breakpoint`);
  }
  // strict CSP holds: every script tag is external, and the page ships its own
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), 'no inline <script> tags on the homepage');
  assert.ok(html.includes('/js/app.js'), 'the homepage loads its own script');
  assert.ok(html.includes('/css/style.css'), 'the homepage loads the shared stylesheet');
  assert.ok(html.includes('manifest.webmanifest'), 'the homepage links the manifest');
});

test('about page: the product story is public, static and admin-free', () => {
  assert.ok(aboutHtml.includes('lp-header'), 'the about page shares the public header');
  assert.match(aboutHtml, /football analysis service, not a betting shop/i, 'about explains what GoalPredict is');
  assert.match(aboutHtml, /One market/i, 'about restates the single market');
  assert.match(aboutHtml, /No fabricated fixtures, teams or markets\./, 'about states the fabrication rule');
  assert.match(aboutHtml, /No guarantee of profit, ever\./, 'about states the no-guarantee rule');
  assert.ok(aboutHtml.includes('href="/predictions.html"'), 'about links the predictions page');
  assert.ok(!JS_CALLS.test(aboutHtml), 'about makes no API call of its own');
  for (const nav of ['Home', 'Predictions', 'Results', 'Analytics', 'About']) {
    assert.ok(aboutHtml.includes(`>${nav}<`), `about keeps the ${nav} nav entry`);
  }
  assert.ok(!/admin/i.test(aboutHtml), 'the about page never mentions the console');
});

