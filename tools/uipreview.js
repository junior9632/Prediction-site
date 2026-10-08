'use strict';

/**
 * UI PREVIEW HARNESS — development tool, NOT part of the deployed application.
 *
 * It boots the REAL Express app (server/app.js), the REAL prediction pipeline
 * and the REAL controllers, but replaces the two things a sandbox or a laptop
 * does not have:
 *
 *   1. MySQL/MariaDB  -> tests/fakeDb.js (in-memory, same SQL from queries.js)
 *   2. API-Football   -> tests/synthetic.js FakeApi (fictional sample payloads)
 *
 * Every number you see in the preview is clearly fictional sample data
 * ("Northbridge FC", "Test Premier League", ...). Nothing is scraped, cached or
 * inferred from real football data, and no API key is involved.
 *
 * Production deployment uses `node server.js` with a real database and a real
 * API-Football key — see README.md and docs/DEPLOYMENT-CPANEL.md.
 *
 * Usage:  node tools/uipreview.js            (http://localhost:3000)
 *         PORT=8080 node tools/uipreview.js
 * Admin:  username `admin`   password `preview123`
 * Member: username `member`  password `preview123`  (open /dashboard)
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.PORT = process.env.PORT || '3000';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'preview-only-secret-not-used-in-production';
process.env.DB_HOST = process.env.DB_HOST || 'preview.invalid';
process.env.DB_NAME = process.env.DB_NAME || 'preview';
process.env.DB_USER = process.env.DB_USER || 'preview';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'preview';
process.env.API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || 'preview-sample-key';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

const fakeDb = require('../tests/fakeDb');
const { buildScenario, FakeApi } = require('../tests/synthetic');

const decimal = require('../server/utils/decimal');
const settingsService = require('../server/services/settingsService');
const ticketService = require('../server/services/ticketService');
const { apiFootball } = require('../server/services/apiFootball');
const { createApp, PUBLIC_DIR } = require('../server/app');

const PREVIEW_PASSWORD = 'preview123';
const ADMIN = {
  id: 1,
  email: 'admin@preview.local',
  username: 'admin',
  password_hash: bcrypt.hashSync(PREVIEW_PASSWORD, 8),
  role: 'superadmin',
  is_active: 1,
  locked_until: null,
  must_change_password: 0,
  failed_logins: 0,
};

/** A demo member, so /dashboard and its private activity feed can be reviewed. */
const MEMBER = {
  id: 2,
  email: 'member@preview.local',
  username: 'member',
  password_hash: bcrypt.hashSync(PREVIEW_PASSWORD, 8),
  role: 'user',
  is_active: 1,
  failed_logins: 0,
  locked_until: null,
  last_login_at: null,
  last_login_ip: null,
  created_at: '2026-09-01 09:00:00',
  updated_at: '2026-09-01 09:00:00',
};

/** Fictional audit rows for the member's own Dashboard Activity feed. */
function previewActivityLogs() {
  const rows = [
    { event: 'USER_REGISTERED', channel: 'auth', level: 'info', daysAgo: 37, message: 'Member member registered' },
    { event: 'USER_LOGIN', channel: 'auth', level: 'info', daysAgo: 12, message: 'Member member signed in' },
    { event: 'LOGIN_FAILED', channel: 'auth', level: 'warn', daysAgo: 9, message: 'Failed user login for member' },
    { event: 'USER_PASSWORD_CHANGED', channel: 'auth', level: 'info', daysAgo: 4, message: 'Member member changed the password' },
    { event: 'USER_LOGIN', channel: 'auth', level: 'info', daysAgo: 1, message: 'Member member signed in' },
  ];
  return rows.map((row, index) => ({
    id: index + 1,
    level: row.level,
    channel: row.channel,
    event: row.event,
    message: row.message,
    actor_type: 'user',
    actor_id: MEMBER.id,
    ip_address: '203.0.113.7',
    user_agent: 'preview',
    context_json: null,
    created_at: mysqlDateTime(new Date(Date.now() - row.daysAgo * 86400000)),
  }));
}

const mysqlDateTime = (date) => date.toISOString().replace('T', ' ').slice(0, 19);
const utcDay = (date) => date.toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* 1. sample data                                                      */
/* ------------------------------------------------------------------ */

/**
 * Anchor the three sample kickoffs so they are always in the future and always
 * inside the same UTC day (the generation window is one UTC day).
 */
function anchorKickoffs(scn) {
  const now = new Date();
  const buildSlots = (start) => [0, 1, 2].map((i) => new Date(start.getTime() + i * 2 * 3600000));

  const cursor = new Date(now.getTime() + 100 * 60000);
  cursor.setUTCMinutes(0, 0, 0);
  let slots = buildSlots(cursor);

  if (utcDay(slots[2]) !== utcDay(slots[0])) {
    // too close to midnight UTC: use the next day instead
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9, 0, 0));
    slots = buildSlots(next);
  }

  const date = utcDay(slots[0]);
  scn.fixtures.forEach((row, i) => {
    row.kickoff_at = mysqlDateTime(slots[i]);
    row.api_timestamp = mysqlDateTime(slots[i]);
    row.kickoffDate = slots[i];
  });
  scn.oddsPayloads.forEach((payload, i) => {
    payload.fixture.timestamp = slots[i].toISOString();
  });
  scn.ticketDate = date;
  return date;
}

/** API-Football shaped `/fixtures` payloads so the sync buttons also work. */
function apiFixtureItems(scn) {
  return scn.fixtures.map((row) => ({
    fixture: {
      id: row.id,
      date: row.kickoffDate.toISOString(),
      timestamp: row.kickoffDate.toISOString(),
      timezone: 'UTC',
      status: { long: row.status_long, short: row.status_short, elapsed: row.status_elapsed },
      venue: { name: row.venue_name, city: row.venue_city },
      referee: row.referee,
    },
    league: {
      id: row.league_id,
      name: row.league_name,
      country: row.league_country,
      logo: row.league_logo,
      season: row.league_season,
      round: row.league_round,
    },
    teams: {
      home: { id: row.home_team_id, name: row.home_team_name, logo: row.home_logo },
      away: { id: row.away_team_id, name: row.away_team_name, logo: row.away_logo },
    },
    goals: { home: row.goals_home, away: row.goals_away },
    score: { fulltime: { home: row.goals_home, away: row.goals_away } },
  }));
}

/** Fourteen days of clearly fictional history so every page has content. */
function seedHistory(store, scn) {
  const pattern = [
    { status: 'QUALIFIED', result: 'WON', goals: [[2, 1], [1, 1], [3, 0]] },
    { status: 'QUALIFIED', result: 'LOST', goals: [[2, 0], [0, 0], [2, 2]] },
    { status: 'NO_QUALIFYING_TICKET', result: 'N/A', goals: null },
    { status: 'QUALIFIED', result: 'WON', goals: [[1, 2], [2, 2], [4, 1]] },
    { status: 'QUALIFIED', result: 'VOID', goals: [[2, 1], [null, null], [null, null]], voidNote: 'every leg was void or postponed' },
    { status: 'QUALIFIED', result: 'LOST', goals: [[3, 1], [1, 0], [0, 1]] },
    { status: 'NO_QUALIFYING_TICKET', result: 'N/A', goals: null },
    { status: 'QUALIFIED', result: 'WON', goals: [[2, 0], [1, 3], [2, 2]] },
    { status: 'DATA_SOURCE_UNAVAILABLE', result: 'N/A', goals: null },
    { status: 'QUALIFIED', result: 'WON', goals: [[5, 0], [1, 1], [2, 1]] },
    { status: 'QUALIFIED', result: 'LOST', goals: [[1, 1], [2, 0], [1, 0]] },
    { status: 'QUALIFIED', result: 'WON', goals: [[2, 3], [3, 1], [1, 1]] },
    { status: 'NO_QUALIFYING_TICKET', result: 'N/A', goals: null },
    { status: 'QUALIFIED', result: 'WON', goals: [[2, 1], [4, 0], [1, 2]] },
  ];

  const oddsValues = ['1.28', '1.30', '1.32'];
  let ticketId = 9000;
  let selectionId = 9000;

  pattern.forEach((day, index) => {
    const date = new Date(Date.now() - (index + 1) * 86400000);
    const dateStr = utcDay(date);
    ticketId += 1;

    if (day.status !== 'QUALIFIED') {
      store.tickets.push({
        id: ticketId,
        ticket_date: dateStr,
        market_key: 'over_1_5',
        market_label: 'Over 1.5 Goals',
        status: day.status,
        selection_count: 0,
        total_odds: '0.000000',
        total_odds_display: '0.00',
        avg_confidence: null,
        min_confidence: null,
        avg_quality: null,
        max_risk: null,
        estimated_probability: null,
        result: 'N/A',
        settled_odds: null,
        settled_at: null,
        result_note:
          day.status === 'DATA_SOURCE_UNAVAILABLE'
            ? 'DATA SOURCE TEMPORARILY UNAVAILABLE'
            : 'NO QUALIFYING TICKET — no combination reached the 2.00 minimum with verified Over 1.5 prices',
        min_total_odds: '2.00',
        max_total_odds: '4.00',
        generation_id: null,
        generated_by_admin_id: ADMIN.id,
        generated_at: mysqlDateTime(date),
        published: 1,
      });
      return;
    }

    const total = decimal.product(oddsValues);
    const selections = scn.fixtures.map((row, i) => {
      selectionId += 1;
      const goals = day.goals[i];
      const totalGoals = goals[0] === null ? null : goals[0] + goals[1];
      let legResult = 'PENDING';
      if (goals[0] === null) legResult = i === 1 ? 'POSTPONED' : 'VOID';
      else if (totalGoals >= 2) legResult = 'WON';
      else legResult = 'LOST';

      const kickoff = new Date(date.getTime() + (12 + i * 3) * 3600000);
      return {
        id: selectionId,
        ticket_id: ticketId,
        fixture_id: row.id,
        prediction_id: null,
        position: i + 1,
        league_id: row.league_id,
        league_name: row.league_name,
        league_country: row.league_country,
        league_logo_url: row.league_logo,
        home_team_id: row.home_team_id,
        away_team_id: row.away_team_id,
        home_team_name: row.home_team_name,
        away_team_name: row.away_team_name,
        home_team_logo: row.home_logo,
        away_team_logo: row.away_logo,
        kickoff_at: mysqlDateTime(kickoff),
        market_key: 'over_1_5',
        market_label: 'Over 1.5 Goals',
        bookmaker_id: 8,
        bookmaker_name: 'Bet365',
        odd_decimal: oddsValues[i],
        odd_raw: oddsValues[i],
        odds_updated_at: mysqlDateTime(new Date(kickoff.getTime() - 3600000)),
        odds_verified_at: mysqlDateTime(new Date(kickoff.getTime() - 3000000)),
        confidence: 84 - i * 0.6,
        quality_score: 89.6,
        risk_score: 12.3 + i,
        model_probability: 0.88,
        result: legResult,
        final_home_goals: goals[0],
        final_away_goals: goals[1],
        final_total_goals: totalGoals,
        settled_at: legResult === 'PENDING' ? null : mysqlDateTime(new Date(kickoff.getTime() + 7200000)),
        snapshot_json: JSON.stringify({
          market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
          odds: { raw: oddsValues[i], decimal: Number(oddsValues[i]), bookmakerName: 'Bet365', bookmakersOffering: 3 },
          scoring: { confidence: 84 - i * 0.6, quality: 89.6, risk: 12.3 + i, expectedTotalGoals: 3.9 - i * 0.2 },
          previewSample: true,
        }),
      };
    });
    store.selections.push(...selections);

    const activeOdds = selections.filter((s) => s.result !== 'VOID' && s.result !== 'POSTPONED').map((s) => s.odd_raw);
    store.tickets.push({
      id: ticketId,
      ticket_date: dateStr,
      market_key: 'over_1_5',
      market_label: 'Over 1.5 Goals',
      status: 'QUALIFIED',
      selection_count: selections.length,
      total_odds: decimal.format(total, 6),
      total_odds_display: decimal.format(total, 2),
      avg_confidence: 83.1,
      min_confidence: 82.5,
      avg_quality: 89.6,
      max_risk: 14.3,
      estimated_probability: 0.68,
      result: day.result,
      settled_odds: day.result === 'PENDING' ? null : decimal.format(decimal.product(activeOdds.length ? activeOdds : ['1.00']), 6),
      settled_at: mysqlDateTime(new Date(date.getTime() + 10 * 3600000)),
      result_note: day.voidNote || null,
      min_total_odds: '2.00',
      max_total_odds: '4.00',
      generation_id: null,
      generated_by_admin_id: ADMIN.id,
      generated_at: mysqlDateTime(date),
      published: 1,
    });

    // results rows so the settlement/analytics views agree with the legs
    selections.forEach((sel, i) => {
      const goals = day.goals[i];
      store.results.push({
        id: 7000 + index * 10 + i,
        fixture_id: sel.fixture_id,
        status_short: goals[0] === null ? (i === 1 ? 'PST' : 'CANC') : 'FT',
        status_long: goals[0] === null ? 'Postponed' : 'Match Finished',
        goals_home: goals[0],
        goals_away: goals[1],
        total_goals: goals[0] === null ? null : goals[0] + goals[1],
        over15_result: sel.result,
        settled: 1,
        settled_at: sel.settled_at,
        source: 'api-football',
        raw_json: null,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 2. preview banner (injected into the HTML by this harness only)      */
/* ------------------------------------------------------------------ */

const BANNER_JS = `
(function () {
  var bar = document.createElement('div');
  bar.setAttribute('role', 'note');
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#7c2d12;color:#ffedd5;' +
    'font:600 12px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:8px 12px;text-align:center;' +
    'border-top:1px solid #f97316;letter-spacing:.02em;';
  bar.textContent = 'PREVIEW MODE \\u2014 sample data only. Fictional teams, leagues, odds and results. ' +
    'No API-Football key, no database. Production runs on server.js + MySQL. Admin: admin / preview123 · Member: member / preview123 (/dashboard)';
  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(bar);
    document.body.style.paddingBottom = '52px';
  });
})();
`;

const BANNER_TAG = '<script src="/preview-banner.js" defer></script>';

/**
 * The HTML routes are served by this harness (so the preview banner can be
 * injected), which means they bypass the app's helmet middleware. The same
 * security headers are set here to keep the preview faithful to production.
 */
const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://media.api-sports.io https:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function sendHtml(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!fs.existsSync(full)) {
    res.status(404).type('text/plain').send('Not found');
    return;
  }
  res.set({
    'Content-Security-Policy': PREVIEW_CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  let html = fs.readFileSync(full, 'utf8');
  if (html.includes('</body>')) html = html.replace('</body>', `${BANNER_TAG}</body>`);
  else html += BANNER_TAG;
  res.type('text/html').send(html);
}

/* ------------------------------------------------------------------ */
/* 3. boot                                                             */
/* ------------------------------------------------------------------ */

async function waitForRun(runId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let progress = await ticketService.getGenerationProgress(runId);
  while (progress && progress.status === 'RUNNING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    progress = await ticketService.getGenerationProgress(runId);
  }
  return progress;
}

async function main() {
  const scn = buildScenario({ oddsValues: ['1.28', '1.30', '1.32'] });
  const ticketDate = anchorKickoffs(scn);

  const ctx = fakeDb.install({
    admins: [ADMIN],
    users: [MEMBER],
    systemLogs: previewActivityLogs(),
    settings: [],
    fixtures: scn.fixtures,
    teamForms: scn.teamForms,
    leagues: scn.leagueEnvs,
  });
  settingsService.invalidateCache();
  seedHistory(ctx.store, scn);

  // the app's API client becomes the sample client (no network is ever used)
  const sampleApi = new FakeApi(scn);
  sampleApi.getFixturesByDate = async () => ({ response: apiFixtureItems(scn), results: scn.fixtures.length, paging: { current: 1, total: 1 } });
  sampleApi.getFixturesByIds = async (ids) => ({
    response: apiFixtureItems(scn).filter((item) => String(ids).includes(String(item.fixture.id))),
    results: scn.fixtures.length,
    paging: { current: 1, total: 1 },
  });
  // `configured` is a getter derived from the (dummy) preview key, so only the
  // transport methods and metadata are replaced — no request ever leaves here.
  Object.assign(apiFootball, {
    host: 'preview.sample.local',
    baseUrl: 'https://preview.sample.local/v3',
    isAvailable: () => true,
    // mirror the real breakerState()/status shapes the dashboard renders
    breakerState: () => ({
      state: 'OK',
      available: true,
      consecutiveFailures: 0,
      retryInMs: 0,
      quota: { current: 42, limit_day: 7500 },
      calls: 28,
      failures: 0,
      cacheHits: 6,
      lastCallAt: new Date().toISOString(),
      lastError: null,
      preview: true,
    }),
    getStatus: async () => ({
      account: { firstname: 'Preview', lastname: 'Sample' },
      requests: { current: 42, limit_day: 7500 },
      subscription: { name: 'Pro (preview sample)', active: true, ended: '2099-01-01' },
      preview: true,
    }),
    getFixturesByDate: (date) => sampleApi.getFixturesByDate(date),
    getFixturesByIds: (ids) => sampleApi.getFixturesByIds(ids),
    getTeamLastFixtures: async () => ({ response: [], results: 0, paging: { current: 1, total: 1 } }),
    getHeadToHead: () => sampleApi.getHeadToHead(),
    getOddsByDate: (date, page) => sampleApi.getOddsByDate(date, page),
    getOddsByFixture: (id) => sampleApi.getOddsByFixture(id),
    getOddsByFixtures: async (ids) => ({
      response: scn.oddsPayloads.filter((p) => ids.map(Number).includes(Number(p.fixture.id))),
      results: ids.length,
      paging: { current: 1, total: 1 },
    }),
    getInjuriesByFixture: () => sampleApi.getInjuriesByFixture(),
  });

  // generate the sample day through the real pipeline
  const started = await ticketService.startGeneration({ adminId: ADMIN.id, source: 'admin_ui', date: ticketDate, api: apiFootball });
  const progress = await waitForRun(started.runId);
  if (progress.status !== 'QUALIFIED') {
    console.warn(`[preview] sample generation ended as ${progress.status}: ${progress.error || ''}`);
  }

  // if the sample day is not "today" (late UTC evening), copy it onto today so
  // the homepage and the admin "Today's Ticket" view are populated
  const today = utcDay(new Date());
  if (ticketDate !== today && ctx.store.tickets.length) {
    const source = ctx.store.tickets.find((t) => String(t.ticket_date).slice(0, 10) === ticketDate);
    if (source) {
      const clone = { ...source, id: ctx.store.ids + 5000, ticket_date: today, generated_at: mysqlDateTime(new Date()) };
      const legs = ctx.store.selections.filter((s) => Number(s.ticket_id) === Number(source.id));
      ctx.store.tickets.push(clone);
      legs.forEach((leg, i) => {
        ctx.store.selections.push({
          ...leg,
          id: ctx.store.ids + 6000 + i,
          ticket_id: clone.id,
          kickoff_at: mysqlDateTime(new Date(Date.now() - (3 - i) * 3600000)),
        });
      });
    }
  }

  const app = createApp();
  const wrapper = express();
  wrapper.disable('x-powered-by');
  wrapper.get('/preview-banner.js', (_req, res) => res.type('application/javascript').send(BANNER_JS));
  wrapper.get('/', (_req, res) => sendHtml(res, 'index.html'));
  // The protected pages must never bypass the app's guards, so they are NOT
  // served by the banner injector — they fall through to the real app, which
  // enforces the same hidden-admin rules as production.
  wrapper.get(/^\/[A-Za-z0-9_-]+\.html$/, (req, res, next) => {
    if (req.path === '/admin.html' || req.path === '/dashboard.html') return next();
    return sendHtml(res, req.path.slice(1));
  });
  wrapper.use(app);

  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer(wrapper);
  server.listen(port, '0.0.0.0', () => {
    const lines = [
      '',
      '  GoalPredict — UI preview harness (sample data only)',
      `  Local:   http://localhost:${port}`,
      `  Admin:   http://localhost:${port}/admin.html  (admin / ${PREVIEW_PASSWORD})`,
      `  Sample ticket date: ${ticketDate}${ticketDate === today ? ' (today)' : ` (today shows a copy)`}`,
      `  Sample generation:  ${progress.status}`,
      '  Database: in-memory double (tests/fakeDb.js) — no MySQL required',
      '  Upstream: fictional API-Football double — no network, no API key',
      '',
    ];
    console.log(lines.join('\n'));
  });

  const shutdown = () => {
    server.close(() => {
      ctx.restore();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[preview] failed to start:', err);
  process.exit(1);
});
