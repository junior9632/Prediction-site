'use strict';

/**
 * Outbound notifications — Telegram bot + generic JSON webhook.
 *
 * Zero dependencies: both transports use Node's built-in fetch. The module
 * is strictly fire-and-forget:
 *  - when nothing is configured every call is a silent no-op;
 *  - a transport failure is logged but NEVER thrown — a dead Telegram API
 *    must never break ticket generation, settlement or a cron run.
 *
 * Honesty rules apply here too: messages only describe tickets and runs
 * that actually happened. There is no "retry until it looks good", no
 * synthetic content, and NO QUALIFYING TICKET days are announced exactly
 * as such.
 */

const config = require('../config');
const log = require('../utils/logger').child('notify');

/** Injectable for tests; defaults to the global fetch (Node >= 18). */
let fetchImpl = typeof fetch === 'function' ? fetch : null;

function _setFetch(fn) {
  fetchImpl = fn;
}

function telegramConfigured() {
  return Boolean(config.notifications.telegramBotToken && config.notifications.telegramChatId);
}

function webhookConfigured() {
  return Boolean(config.notifications.webhookUrl);
}

function isConfigured() {
  return telegramConfigured() || webhookConfigured();
}

/* ------------------------------------------------------------------ */
/* Formatting (pure, unit tested)                                      */
/* ------------------------------------------------------------------ */

function kickoffHHMM(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

/**
 * Plain-text announcement for a QUALIFIED public ticket
 * (shape of ticketService.formatTicketForPublic).
 */
function formatTicketPublished(ticket) {
  const lines = [];
  lines.push(`\u{1F3AF} GoalPredict \u2014 Today's Ticket (${ticket.date})`);
  lines.push(`Market: ${ticket.market && ticket.market.label ? ticket.market.label : 'Over 1.5 Goals'}`);
  lines.push('');
  (ticket.selections || []).forEach((s, i) => {
    const kick = kickoffHHMM(s.kickoffAt);
    const bookmaker = s.odds && s.odds.bookmaker ? ` (${s.odds.bookmaker})` : '';
    const oddsText = s.odds && s.odds.display ? ` @ ${s.odds.display}${bookmaker}` : '';
    lines.push(
      `${i + 1}. ${s.homeTeam.name} vs ${s.awayTeam.name}${oddsText}${kick ? ` \u2014 ${kick}` : ''}`,
    );
  });
  lines.push('');
  if (ticket.totalOdds) {
    lines.push(
      `Combined odds: ${ticket.totalOdds} (target ${ticket.oddsWindow.min.toFixed(2)}\u2013${ticket.oddsWindow.max.toFixed(2)})`,
    );
  }
  if (ticket.avgConfidence !== null && ticket.avgConfidence !== undefined) {
    lines.push(`Average confidence: ${ticket.avgConfidence}`);
  }
  lines.push('');
  lines.push('Verified bookmaker odds only. 18+, bet responsibly \u2014 never more than you can afford to lose.');
  return lines.join('\n');
}

/** Plain-text announcement for a NO QUALIFYING TICKET day. */
function formatNoTicket(ticket) {
  const lines = [];
  lines.push(`\u26AA GoalPredict \u2014 ${ticket.date}: NO QUALIFYING TICKET`);
  const message = ticket.noTicket && ticket.noTicket.message ? ticket.noTicket.message : null;
  if (message) lines.push(message);
  lines.push('No pick was forced to pad the odds. We publish nothing rather than something weak.');
  return lines.join('\n');
}

/** Plain-text operational alert (health check, data source down, run error). */
function formatAlert(event, details = {}) {
  const lines = [`\u{1F6A8} GoalPredict ALERT \u2014 ${event}`];
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Transports                                                          */
/* ------------------------------------------------------------------ */

async function postJson(url, body, timeoutMs) {
  if (!fetchImpl) throw new Error('fetch is not available in this runtime');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function sendTelegram(text, timeoutMs) {
  const { telegramBotToken, telegramChatId } = config.notifications;
  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  return postJson(url, { chat_id: telegramChatId, text, disable_web_page_preview: true }, timeoutMs);
}

async function sendWebhook(event, text, data, timeoutMs) {
  return postJson(
    config.notifications.webhookUrl,
    { source: 'goalpredict', event, message: text, data: data || null, sentAt: new Date().toISOString() },
    timeoutMs,
  );
}

/**
 * Dispatch `text` to every configured transport.
 * Resolves with { telegram, webhook } booleans. Never rejects.
 */
async function dispatch(event, text, data = null) {
  const outcome = { telegram: false, webhook: false };
  if (!isConfigured()) return outcome;
  const timeoutMs = config.notifications.timeoutMs;

  if (telegramConfigured()) {
    try {
      await sendTelegram(text, timeoutMs);
      outcome.telegram = true;
    } catch (err) {
      log.warn('telegram notification failed', { event, message: err.message });
    }
  }
  if (webhookConfigured()) {
    try {
      await sendWebhook(event, text, data, timeoutMs);
      outcome.webhook = true;
    } catch (err) {
      log.warn('webhook notification failed', { event, message: err.message });
    }
  }
  return outcome;
}

/* ------------------------------------------------------------------ */
/* Public API (fire-and-forget)                                        */
/* ------------------------------------------------------------------ */

/** Announce a freshly published QUALIFIED ticket. */
async function ticketPublished(publicTicket) {
  if (!publicTicket || !isConfigured()) return { telegram: false, webhook: false };
  try {
    return await dispatch('TICKET_PUBLISHED', formatTicketPublished(publicTicket), {
      date: publicTicket.date,
      totalOdds: publicTicket.totalOdds,
      selectionCount: publicTicket.selectionCount,
    });
  } catch (err) {
    log.warn('ticketPublished notification failed', { message: err.message });
    return { telegram: false, webhook: false };
  }
}

/** Announce a NO QUALIFYING TICKET day — honesty is part of the product. */
async function noQualifyingTicket(publicTicket) {
  if (!publicTicket || !isConfigured()) return { telegram: false, webhook: false };
  try {
    return await dispatch('NO_QUALIFYING_TICKET', formatNoTicket(publicTicket), {
      date: publicTicket.date,
      reason: publicTicket.noTicket ? publicTicket.noTicket.reason : null,
    });
  } catch (err) {
    log.warn('noQualifyingTicket notification failed', { message: err.message });
    return { telegram: false, webhook: false };
  }
}

/** Operational alert: health check failed, data source down, run crashed. */
async function alert(event, details = {}) {
  if (!isConfigured()) return { telegram: false, webhook: false };
  try {
    return await dispatch(event, formatAlert(event, details), details);
  } catch (err) {
    log.warn('alert notification failed', { event, message: err.message });
    return { telegram: false, webhook: false };
  }
}

module.exports = {
  isConfigured,
  ticketPublished,
  noQualifyingTicket,
  alert,
  // exported for unit tests
  formatTicketPublished,
  formatNoTicket,
  formatAlert,
  _setFetch,
};
