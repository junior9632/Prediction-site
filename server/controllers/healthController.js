'use strict';

/**
 * Health + public metadata.
 * The API key is never part of any response — only whether a key is configured.
 */

const db = require('../database/queries');
const connection = require('../database/connection');
const config = require('../config');
const settingsService = require('../services/settingsService');
const { apiFootball } = require('../services/apiFootball');
const ticketService = require('../services/ticketService');
const { asyncHandler } = require('../utils/asyncHandler');

/** GET /api/health */
const health = asyncHandler(async (_req, res) => {
  let database = 'ok';
  try {
    // the pool lives in the connection layer, not in the repository layer
    await connection.ping();
    await db.countTickets({});
  } catch (_) {
    database = 'unavailable';
  }
  const breaker = apiFootball.breakerState();
  res.status(database === 'ok' ? 200 : 503).json({
    ok: database === 'ok',
    data: {
      status: database === 'ok' && breaker.available ? 'ok' : 'degraded',
      database,
      dataSource: {
        configured: apiFootball.configured,
        available: breaker.available,
        state: breaker.state,
      },
      market: { key: config.market.key, label: config.market.label, goalLine: config.market.goalLine },
      autoTicketGeneration: false,
      generationRunning: ticketService.isRunning(),
      serverTime: new Date().toISOString(),
      version: require('../../package.json').version,
    },
  });
});

/** GET /api/meta — branding + public rules, nothing sensitive */
const meta = asyncHandler(async (_req, res) => {
  const settings = await settingsService.getEngineSettings();
  res.json({
    ok: true,
    data: {
      siteName: settings.siteName,
      tagline: settings.siteTagline,
      displayTimezone: settings.displayTimezone,
      market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
      oddsWindow: { min: Number(settings.minTotalOdds), max: Number(settings.maxTotalOdds) },
      thresholds: {
        minConfidence: Number(settings.minConfidence),
        maxRisk: Number(settings.maxRisk),
        minDataQuality: Number(settings.minDataQuality),
        minSelections: Number(settings.minSelections),
        maxSelections: Number(settings.maxSelections),
      },
      autoTicketGeneration: false,
      correlationProtection: Boolean(settings.correlationProtection),
      oddsFreshnessMinutes: Number(settings.oddsFreshnessMinutes),
      serverTime: new Date().toISOString(),
    },
  });
});

module.exports = { health, meta };
