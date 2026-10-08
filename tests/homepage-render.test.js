/* Homepage render contract: the public landing page is a sports-intelligence
   page built from public data only. These assertions pin the pieces the
   marketing layout must keep — and, just as importantly, the things it must
   never leak to an anonymous visitor. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'app.js'), 'utf8');

test('homepage: the hero sells one market and one honest promise', () => {
  assert.ok(html.includes('class="hp-hero"'), 'the hero uses the landing-page block');
  assert.match(html, /AI Sports Intelligence/, 'the hero headline is the intelligence pitch');
  assert.match(html, /Over 1\.5 Goals/, 'the single market is named');
  assert.match(html, /2\.00\s*(?:&nbsp;)?\s*[–-]\s*(?:&nbsp;)?\s*4\.00/, 'the odds window is stated');
  assert.ok(html.includes('class="hp-cta"'), 'the hero carries primary calls to action');
  assert.match(html, /href="\/ticket\.html"[^>]*>See today's ticket/, "the main CTA leads to today's ticket");
  assert.match(html, /href="\/account\.html#register"[^>]*data-auth-login/, 'the register CTA targets the guest form');

  // honesty: nothing on the page promises winnings or implies a bookmaker
  assert.ok(!/\bguaranteed\b/i.test(html), 'no guarantee language on the homepage');
  assert.ok(!/\brisk[- ]free\b/i.test(html), 'no risk-free language on the homepage');
});

test('homepage: the trust strip and the 18+ footer ship together', () => {
  assert.ok(html.includes('class="hp-trust"'), 'the hero carries a trust strip');
  for (const claim of ['Verified bookmaker odds', 'Combined odds 2.00', 'never on a timer', 'Play responsibly']) {
    assert.ok(html.includes(claim), `the trust strip keeps "${claim}"`);
  }
  assert.ok(html.includes('class="site-footer"'), 'the page ends with a footer');
  assert.match(html, /18\+/, 'the footer is 18+');
  assert.match(html, /begambleaware\.org/i, 'the footer points problem gamblers to help');
  assert.match(html, /not a bookmaker|nothing is invented/i, 'the footer repeats the honest positioning');
});

test('homepage: a live, server-sourced preview of today\'s ticket sits in the hero', () => {
  assert.ok(html.includes('class="hp-live"'), 'the preview panel exists');
  for (const id of ['livePill', 'livePillText', 'liveMarket', 'liveOdds', 'livePicks', 'liveConfidence', 'liveMessage']) {
    assert.ok(html.includes(`id="${id}"`), `the preview panel renders #${id}`);
  }
  // the panel is painted from the same public endpoints every visitor reads
  assert.match(js, /API\.get\('\/ticket\/today'\)/, "js/app.js reads today's public ticket");
  assert.match(js, /API\.get\('\/tickets\/history\?limit=5'\)/, 'js/app.js reads the public history');
  assert.match(js, /#livePill/, 'js/app.js paints the status pill');
  assert.match(js, /DATA_SOURCE_UNAVAILABLE/, 'a dead data source is surfaced, not hidden');
  assert.match(js, /NO_QUALIFYING_TICKET/, 'a no-ticket day is surfaced, not hidden');
});

test("homepage: today's accumulator renders from real data with the empty state wired", () => {
  for (const id of ['accSummary', 'accPicks', 'accOdds', 'accConfidence', 'accStatusWrap', 'accGenerated', 'pickList', 'noTicketBox', 'diagGrid']) {
    assert.ok(html.includes(`id="${id}"`), `the accumulator renders #${id}`);
  }
  assert.ok(html.includes('id="recentResults"'), 'the settled-ticket strip exists');
  assert.match(js, /paintDiagnostics/, 'the no-ticket day explains itself with diagnostics');
  assert.match(js, /skeletonRows\(3\)/, 'the pick list shows a skeleton while loading');
  assert.match(js, /emptyState\('alert', 'Could not load the ticket'/, 'a failed fetch degrades to a readable empty state');
});

test('homepage: the landing page never touches account-scoped or privileged surfaces', () => {
  for (const forbidden of ['/api/dashboard', 'activityFeed', '/js/dashboard.js', '/api/admin', 'data-auth-admin']) {
    assert.ok(!html.includes(forbidden), `index.html must not reference ${forbidden}`);
    assert.ok(!js.includes(forbidden), `js/app.js must not reference ${forbidden}`);
  }
  assert.ok(!/\/admin\b/.test(html), 'the public homepage must not link the admin surface');
  assert.ok(js.includes('App.session.bindHeader()'), 'the header still binds the public session state');
  // the login slot is bound by the shared session helper, which hides it
  // for signed-in members instead of duplicating session logic per page
  const apiJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'api.js'), 'utf8');
  assert.match(apiJs, /\[data-auth-login\]/, 'api.js binds the [data-auth-login] slot');
  assert.match(apiJs, /\[data-auth-signed\]/, 'api.js reveals the signed-in slot');
});

test('homepage: markup, stylesheet and script are wired for the new sections', () => {
  for (const cls of ['hp-hero', 'hp-eyebrow', 'hp-h1', 'hp-sub', 'hp-cta', 'hp-trust', 'hp-live', 'hp-pill']) {
    assert.ok(css.includes(`.${cls}`), `css/style.css must style .${cls}`);
  }
  assert.match(css, /\.hp-live-grid[^{]*\{[^}]*grid-template-columns/, 'the preview grid is a real grid');
  assert.match(css, /@media \(max-width: 899\.98px\)[\s\S]*?\.hp-live-grid/, 'the preview grid collapses on phones');
  // the strict CSP holds: every script tag is external
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), 'no inline <script> tags on the homepage');
  assert.ok(html.includes('/js/app.js'), 'the homepage loads its own script');
  assert.ok(html.includes('/css/style.css'), 'the homepage loads the shared stylesheet');
});
