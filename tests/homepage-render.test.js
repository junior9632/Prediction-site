/* ==========================================================================
   The redesigned public homepage must actually RENDER.

   tests/http.test.js proves the markup and the contracts; this file executes
   the real browser scripts (public/js/api.js + public/js/app.js) against the
   real element ids of public/index.html with a minimal DOM stand-in, and
   checks that the landing page fills in from PUBLIC endpoints only. It is the
   guard against a "looks right in the diff, throws in the browser" regression:
   every helper name, id and payload key the page depends on is exercised.
   ========================================================================== */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ------------------------------- DOM stub ------------------------------- */

function classSet(initial) {
  return new Set(String(initial || '').split(/\s+/).filter(Boolean));
}

function makeElement(id, options = {}) {
  const classes = classSet(options.class);
  const attrs = Object.assign({}, options.attrs);
  let text = '';
  let html = '';
  const notes = new Map();
  const node = {
    id,
    tagName: options.tag || 'DIV',
    attrs,
    listeners: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
    },
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(value) {
      classes.clear();
      classSet(value).forEach((c) => classes.add(c));
    },
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = value === null || value === undefined ? '' : String(value);
      // a real DOM keeps the markup in sync; the assertions read either one
      html = text;
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value === null || value === undefined ? '' : String(value);
      text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    },
    parentElement: null,
    setAttribute: (k, v) => {
      attrs[k] = String(v);
    },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener: (type, fn) => {
      node.listeners[type] = fn;
    },
    removeEventListener: () => {},
    scrollIntoView: () => {},
    focus: () => {},
    querySelector: (sel) => {
      if (sel === '.d') {
        if (!notes.has('.d')) notes.set('.d', makeElement('note'));
        return notes.get('.d');
      }
      return null;
    },
    querySelectorAll: () => [],
    /** text of a child the page created by selector (the ROI sub-note) */
    child: (sel) => node.querySelector(sel),
  };
  return node;
}

/**
 * A DOM built from the REAL index.html: every id= in the file becomes a stub
 * element, and the data-auth-* hooks are counted so bindHeader() has something
 * to toggle. Anything the page asks for that the file does not contain stays
 * null, exactly like a browser.
 */
function buildDom() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const byId = new Map();
  for (const match of html.matchAll(/<[^>]*\bid="([\w-]+)"/g)) {
    if (!byId.has(match[1])) byId.set(match[1], makeElement(match[1]));
  }
  const attrCounts = new Map();
  const attrNodes = new Map();
  for (const match of html.matchAll(/data-auth-[a-z-]+/g)) {
    attrCounts.set(match[0], (attrCounts.get(match[0]) || 0) + 1);
    if (!attrNodes.has(match[0])) attrNodes.set(match[0], makeElement(`[${match[0]}]`));
  }
  // parents: the ROI cell reads its own sub-note through parentElement
  for (const node of byId.values()) {
    node.parentElement = { querySelector: (sel) => node.querySelector(sel) };
  }

  const listeners = {};
  const document = {
    cookie: '',
    documentElement: makeElement('html'),
    querySelector: (sel) => {
      if (sel.startsWith('#')) return byId.get(sel.slice(1)) || null;
      return attrNodes.get(sel) || null;
    },
    querySelectorAll: (sel) => {
      const node = attrNodes.get(sel);
      return node ? [node] : [];
    },
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => makeElement('created', { tag }),
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    body: makeElement('body'),
  };

  return { html, byId, attrCounts, document, listeners };
}

/* ----------------------------- API fixtures ----------------------------- */

const TICKET = {
  id: 1176,
  date: '2026-10-07',
  market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
  status: 'QUALIFIED',
  result: 'PENDING',
  selectionCount: 2,
  totalOdds: '2.20',
  avgConfidence: 83.8,
  generatedAt: '2026-10-07T00:34:00.000Z',
  selections: [
    {
      position: 1,
      fixtureId: 1001,
      league: { name: 'Test Premier League', logo: null },
      homeTeam: { name: 'Northbridge FC', logo: null },
      awayTeam: { name: 'Harbour United', logo: null },
      kickoffAt: '2026-10-07T02:00:00.000Z',
      odds: { value: '1.28', bookmaker: 'Bet365', verifiedAt: '2026-10-07T00:34:00.000Z', verifiedAgo: '5 minutes ago' },
      confidence: 84.4,
      result: 'PENDING',
      score: null,
    },
    {
      position: 2,
      fixtureId: 1002,
      league: { name: 'Test Championship', logo: null },
      homeTeam: { name: 'Riverside Rovers', logo: null },
      awayTeam: { name: 'Kingsway Athletic', logo: null },
      kickoffAt: '2026-10-07T04:00:00.000Z',
      odds: { value: '1.72', bookmaker: 'Bet365', verifiedAt: '2026-10-07T00:34:00.000Z', verifiedAgo: '5 minutes ago' },
      confidence: 83.2,
      result: 'PENDING',
      score: null,
    },
  ],
};

const NO_TICKET = {
  date: '2026-10-08',
  market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
  status: 'NO_QUALIFYING_TICKET',
  result: 'N/A',
  selectionCount: 0,
  totalOdds: null,
  avgConfidence: null,
  generatedAt: '2026-10-08T00:34:00.000Z',
  selections: [],
  noTicket: {
    message: 'No valid Over 1.5 combination was found within the 2.00-4.00 target range.',
    diagnostics: {
      fixturesAnalyzed: 30,
      over15Candidates: 11,
      verifiedOdds: 9,
      rejectedMatches: 19,
      lowConfidence: 6,
      highRisk: 4,
      insufficientData: 5,
      correlationRejected: 2,
      combinationsTested: 84,
      qualifiedCombinations: 0,
    },
  },
};

const HISTORY = {
  page: 1,
  limit: 5,
  total: 2,
  items: [
    { id: 9001, date: '2026-10-06', status: 'QUALIFIED', result: 'WON', selectionCount: 3, totalOdds: '2.20' },
    { id: 9002, date: '2026-10-05', status: 'QUALIFIED', result: 'LOST', selectionCount: 2, totalOdds: '2.40' },
  ],
};

const STATS = {
  tickets: { total: 15, qualified: 11, noTicketDays: 3, won: 6, lost: 3, void: 1, pending: 1, settled: 9, winRate: 66.67, avgOdds: 2.2 },
  selections: { total: 33, settled: 28, winRate: 85.71 },
  over15: { settled: 28, won: 24, winRate: 85.71 },
  streaks: { currentWinningStreak: 1, longestWinningStreak: 2, longestLosingStreak: 1 },
  flatStake: { staked: 10, returned: 14.18, profit: 4.18, roi: 41.79 },
  market: { key: 'over_1_5', label: 'Over 1.5 Goals' },
  generatedAt: '2026-10-07T00:40:00.000Z',
};

const PREDICTIONS = {
  date: '2026-10-07',
  page: 1,
  limit: 2,
  total: 2,
  items: [
    {
      fixtureId: 1001,
      kickoffAt: '2026-10-07T02:00:00.000Z',
      league: { name: 'Test Premier League', logo: null },
      homeTeam: { name: 'Northbridge FC', logo: null },
      awayTeam: { name: 'Harbour United', logo: null },
      eligible: true,
      rejectReason: null,
      confidence: 84.4,
      quality: 89.65,
      risk: 13.31,
      expectedGoals: { home: 2.26, away: 1.68, total: 3.94 },
      over15Rates: { home: 85, away: 85, h2h: null, league: 86 },
      odds: { available: true, value: '1.28', bookmaker: 'Bet365' },
    },
    {
      fixtureId: 1003,
      kickoffAt: '2026-10-07T06:00:00.000Z',
      league: { name: 'Test Serie', logo: null },
      homeTeam: { name: 'Old Town FC', logo: null },
      awayTeam: { name: 'West Park', logo: null },
      eligible: false,
      rejectReason: 'LOW_CONFIDENCE',
      confidence: 61.2,
      quality: 70,
      risk: 28,
      expectedGoals: { home: 1.1, away: 1.0, total: 2.1 },
      over15Rates: { home: 60, away: 55, h2h: null, league: 58 },
      odds: { available: false, value: null, bookmaker: null },
    },
  ],
};

/**
 * Boot public/js/api.js and public/js/app.js in a sandbox wired to `dom`,
 * with `fetch` answering the given payloads. Returns the fetch log so the test
 * can prove which endpoints the page touched.
 */
async function render(dom, fixtures) {
  const calls = [];
  const fetchStub = async (url) => {
    const target = String(url);
    calls.push(target);
    const match = Object.keys(fixtures).find((key) => target.includes(key));
    const body = match ? fixtures[match] : { ok: false, error: { code: 'NOT_FOUND', message: `no fixture for ${target}` } };
    const ok = Boolean(match);
    return {
      ok,
      status: ok ? 200 : 404,
      headers: { get: () => null },
      async json() {
        return ok ? { ok: true, data: body } : body;
      },
    };
  };

  const window = {
    location: { href: '/', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
  const sandbox = {
    window,
    document: dom.document,
    navigator: { userAgent: 'node' },
    location: window.location,
    localStorage: window.localStorage,
    fetch: fetchStub,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    Date,
    Math,
    JSON,
    Intl,
    Promise,
    RegExp,
    Error,
    Number,
    String,
    Object,
    Array,
    Boolean,
    Map,
    Set,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const file of ['js/api.js', 'js/app.js']) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    vm.runInContext(source, sandbox, { filename: `public/${file}` });
  }

  // fire DOMContentLoaded like the browser does, then let every awaited
  // fetch/format promise settle
  for (const fn of dom.listeners.DOMContentLoaded || []) await fn();
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));

  return { calls, sandbox };
}

function text(dom, id) {
  const node = dom.byId.get(id);
  return node ? node.innerHTML : null;
}

/* --------------------------------- tests -------------------------------- */

test('homepage rendering: the landing page fills in from public endpoints only', async () => {
  const dom = buildDom();
  const { calls } = await render(dom, {
    '/auth/me': null,
    '/health': { status: 'ok', database: 'ok', dataSource: { configured: true, available: true, state: 'OK' } },
    '/ticket/today': TICKET,
    '/tickets/history': HISTORY,
    '/analytics': STATS,
    '/predictions': PREDICTIONS,
  });

  // hero live panel + accumulator summary
  assert.equal(text(dom, 'statPicks'), '2');
  assert.equal(text(dom, 'statOdds'), '2.20');
  assert.equal(text(dom, 'statConfidence'), '84%');
  assert.match(text(dom, 'accStatusWrap'), /Qualified/);
  assert.match(text(dom, 'accGenerated'), /Generated/);

  // today's ticket: real selection rows, no empty state
  assert.match(text(dom, 'pickList'), /Northbridge FC/);
  assert.match(text(dom, 'pickList'), /Riverside Rovers/);
  assert.ok(dom.byId.get('noTicketBox').classList.contains('hidden'), 'the empty state is hidden when a ticket exists');

  // public statistics strip
  assert.equal(text(dom, 'hpStatSettled'), '9');
  assert.equal(text(dom, 'hpStatWinRate'), '66.67%');
  assert.equal(text(dom, 'hpStatAvgOdds'), '2.20');
  assert.equal(text(dom, 'hpStatStreak'), '2');
  assert.equal(text(dom, 'hpStatRoi'), '+41.8%', 'flat-stake ROI is signed');
  assert.match(dom.byId.get('hpStatRoi').child('.d').textContent, /4\.18 units profit/);

  // model output cards, including the not-yet-eligible one
  const matches = text(dom, 'hpMatches');
  assert.match(matches, /hp-match/);
  assert.match(matches, /Northbridge FC/);
  assert.match(matches, /Old Town FC/);
  assert.match(matches, /Model pick/);
  assert.match(matches, /LOW_CONFIDENCE|Watching/);
  assert.match(text(dom, 'hpMatchesNote'), /2 fixture/);

  // settled history
  assert.match(text(dom, 'recentResults'), /Won/);
  assert.match(text(dom, 'recentResults'), /Lost/);

  // data-source pill
  assert.match(dom.byId.get('dataSourcePill').className, /\bok\b/);

  // and the hard boundary: no account-scoped call was ever made
  for (const call of calls) {
    assert.ok(!call.includes('/api/dashboard'), `the homepage must never call ${call}`);
    assert.ok(!call.includes('/api/admin'), `the homepage must never call ${call}`);
  }
  assert.ok(calls.some((c) => c.includes('/api/ticket/today')), 'the ticket feed is read');
  assert.ok(calls.some((c) => c.includes('/api/predictions?')), 'the model feed is read');
});

test('homepage rendering: a no-ticket day degrades to an honest diagnostic panel', async () => {
  const dom = buildDom();
  await render(dom, {
    '/auth/me': null,
    '/health': { status: 'ok', database: 'ok', dataSource: { configured: true, available: false, state: 'DOWN' } },
    '/ticket/today': NO_TICKET,
    '/tickets/history': { items: [] },
    '/analytics': STATS,
    '/predictions': { date: '2026-10-08', total: 0, items: [] },
  });

  assert.equal(text(dom, 'statPicks'), '0');
  assert.equal(text(dom, 'statOdds'), '—');
  assert.equal(text(dom, 'pickList'), '');
  assert.ok(!dom.byId.get('noTicketBox').classList.contains('hidden'), 'the empty state is shown');
  assert.match(text(dom, 'noTicketMessage'), /within the 2\.00-4\.00 target range/);
  assert.match(text(dom, 'diagGrid'), /Fixtures analyzed/);
  assert.match(text(dom, 'diagGrid'), /84/);
  assert.match(text(dom, 'recentResults'), /No settled tickets yet/);
  assert.match(text(dom, 'hpMatches'), /No match analysis published yet/);
  assert.match(text(dom, 'recentResults'), /No settled tickets yet/);
  assert.match(dom.byId.get('dataSourcePill').className, /\bwarn\b/);
});

test('homepage rendering: a failing API leaves the page up instead of throwing', async () => {
  const dom = buildDom();
  // no fixtures at all: every endpoint 404s
  await render(dom, {});

  assert.match(text(dom, 'pickList'), /Could not load today/);
  assert.match(dom.byId.get('dataSourcePill').className, /warn/);
  assert.match(text(dom, 'dataSourcePill'), /temporarily unavailable|not configured/);
  // an unknown URL is still an honest page: sections render their empty state
  assert.match(text(dom, 'recentResults'), /No settled tickets yet/);
  assert.match(text(dom, 'hpMatches'), /No match analysis published yet/);
  assert.match(text(dom, 'hpStatWinRate'), /—/);
});
