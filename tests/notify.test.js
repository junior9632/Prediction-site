'use strict';

/**
 * NOTIFICATION SERVICE TESTS
 *  - no configuration  -> strict no-op, no network call ever
 *  - telegram + webhook -> correct endpoints and payloads
 *  - transport failures -> logged, never thrown (fire-and-forget guarantee)
 *  - message formatting -> honest wording for QUALIFIED and NO QUALIFYING TICKET
 */

process.env.NODE_ENV = 'test';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../server/config');
const notifyService = require('../server/services/notifyService');

const sampleTicket = {
  date: '2026-10-05',
  market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
  status: 'QUALIFIED',
  selectionCount: 2,
  totalOdds: '2.20',
  avgConfidence: 84,
  oddsWindow: { min: 2, max: 4 },
  selections: [
    {
      homeTeam: { name: 'Northbridge FC' },
      awayTeam: { name: 'Harbour United' },
      kickoffAt: '2026-10-05T12:00:00.000Z',
      odds: { display: '1.28', bookmaker: 'Test Bookmaker' },
    },
    {
      homeTeam: { name: 'Riverside Rovers' },
      awayTeam: { name: 'Kestrel Town' },
      kickoffAt: '2026-10-05T15:00:00.000Z',
      odds: { display: '1.72', bookmaker: 'Test Bookmaker' },
    },
  ],
};

const noTicketDay = {
  date: '2026-10-06',
  status: 'NO_QUALIFYING_TICKET',
  noTicket: {
    reason: 'BELOW_MIN_ODDS',
    message: 'No valid Over 1.5 combination was found within the 2.00-4.00 target range.',
  },
};

let calls;
let originalNotifications;

beforeEach(() => {
  calls = [];
  originalNotifications = { ...config.notifications };
  notifyService._setFetch(async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => '' };
  });
});

afterEach(() => {
  Object.assign(config.notifications, originalNotifications);
});

function configure({ telegram = false, webhook = false } = {}) {
  config.notifications.telegramBotToken = telegram ? '123:testtoken' : '';
  config.notifications.telegramChatId = telegram ? '-1000001' : '';
  config.notifications.webhookUrl = webhook ? 'https://hooks.test.local/goalpredict' : '';
}

test('notify: unconfigured service is a strict no-op', async () => {
  configure({});
  assert.equal(notifyService.isConfigured(), false);
  const a = await notifyService.ticketPublished(sampleTicket);
  const b = await notifyService.noQualifyingTicket(noTicketDay);
  const c = await notifyService.alert('HEALTH_CHECK_FAILED', { database: 'unavailable' });
  assert.deepEqual(a, { telegram: false, webhook: false });
  assert.deepEqual(b, { telegram: false, webhook: false });
  assert.deepEqual(c, { telegram: false, webhook: false });
  assert.equal(calls.length, 0, 'no network call is ever made without configuration');
});

test('notify: telegram receives the published ticket with real odds only', async () => {
  configure({ telegram: true });
  const outcome = await notifyService.ticketPublished(sampleTicket);
  assert.deepEqual(outcome, { telegram: true, webhook: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123:testtoken/sendMessage');
  assert.equal(calls[0].body.chat_id, '-1000001');
  const text = calls[0].body.text;
  assert.match(text, /Today's Ticket \(2026-10-05\)/);
  assert.match(text, /Northbridge FC vs Harbour United @ 1\.28 \(Test Bookmaker\)/);
  assert.match(text, /Combined odds: 2\.20 \(target 2\.00\u20134\.00\)/);
  assert.match(text, /bet responsibly/i);
});

test('notify: webhook receives a structured JSON event', async () => {
  configure({ webhook: true });
  const outcome = await notifyService.ticketPublished(sampleTicket);
  assert.deepEqual(outcome, { telegram: false, webhook: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hooks.test.local/goalpredict');
  assert.equal(calls[0].body.source, 'goalpredict');
  assert.equal(calls[0].body.event, 'TICKET_PUBLISHED');
  assert.deepEqual(calls[0].body.data, { date: '2026-10-05', totalOdds: '2.20', selectionCount: 2 });
  assert.ok(calls[0].body.sentAt);
});

test('notify: both transports fire for one event', async () => {
  configure({ telegram: true, webhook: true });
  const outcome = await notifyService.alert('HEALTH_CHECK_FAILED', { database: 'unavailable', dataSource: 'OPEN' });
  assert.deepEqual(outcome, { telegram: true, webhook: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].body.text, /GoalPredict ALERT \u2014 HEALTH_CHECK_FAILED/);
  assert.match(calls[0].body.text, /database: unavailable/);
  assert.equal(calls[1].body.event, 'HEALTH_CHECK_FAILED');
});

test('notify: a dead transport never throws (fire-and-forget guarantee)', async () => {
  configure({ telegram: true, webhook: true });
  notifyService._setFetch(async () => {
    throw new Error('ECONNREFUSED');
  });
  const outcome = await notifyService.ticketPublished(sampleTicket);
  assert.deepEqual(outcome, { telegram: false, webhook: false });
});

test('notify: non-2xx responses are treated as failures, not thrown', async () => {
  configure({ telegram: true });
  notifyService._setFetch(async () => ({ ok: false, status: 429, text: async () => 'Too Many Requests' }));
  const outcome = await notifyService.alert('GENERATION_ERROR', { error: 'boom' });
  assert.deepEqual(outcome, { telegram: false, webhook: false });
});

test('notify: NO QUALIFYING TICKET days are announced honestly', () => {
  const text = notifyService.formatNoTicket(noTicketDay);
  assert.match(text, /2026-10-06: NO QUALIFYING TICKET/);
  assert.match(text, /No valid Over 1\.5 combination/);
  assert.match(text, /No pick was forced/);
});

test('notify: ticket formatting tolerates missing optional fields', () => {
  const minimal = {
    date: '2026-10-05',
    market: null,
    totalOdds: null,
    avgConfidence: null,
    oddsWindow: { min: 2, max: 4 },
    selections: [{ homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, kickoffAt: null, odds: null }],
  };
  const text = notifyService.formatTicketPublished(minimal);
  assert.match(text, /1\. A vs B/);
  assert.doesNotMatch(text, /null|undefined/);
});
