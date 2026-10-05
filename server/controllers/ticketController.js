'use strict';

/** Public ticket endpoints: today's ticket, a specific date, and history. */

const ticketService = require('../services/ticketService');
const time = require('../utils/time');
const { assertValid } = require('../utils/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const settingsService = require('../services/settingsService');

/** GET /api/ticket/today */
const today = asyncHandler(async (_req, res) => {
  const settings = await settingsService.getEngineSettings();
  const ticket = await ticketService.getTicketForDate(new Date());
  res.json({
    ok: true,
    data: {
      ...ticket,
      oddsWindow: ticket.oddsWindow || { min: Number(settings.minTotalOdds), max: Number(settings.maxTotalOdds) },
      autoTicketGeneration: false,
      market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
      serverTime: new Date().toISOString(),
    },
  });
});

/** GET /api/ticket/:date */
const byDate = asyncHandler(async (req, res) => {
  const { date } = assertValid({ date: { type: 'date', required: true } }, req.params);
  const ticket = await ticketService.getTicketForDate(date);
  res.json({ ok: true, data: ticket });
});

/** GET /api/tickets/history?page=&limit=&from=&to=&status=&result= */
const history = asyncHandler(async (req, res) => {
  const params = assertValid(
    {
      page: { type: 'int', default: 1, min: 1, max: 500 },
      limit: { type: 'int', default: 20, min: 1, max: 100 },
      from: { type: 'date' },
      to: { type: 'date' },
      status: { type: 'enum', values: ['QUALIFIED', 'NO_QUALIFYING_TICKET', 'DATA_SOURCE_UNAVAILABLE', 'PENDING', 'ERROR'] },
      result: { type: 'enum', values: ['PENDING', 'WON', 'LOST', 'VOID', 'PARTIAL_VOID', 'POSTPONED', 'N/A'] },
    },
    req.query
  );
  const data = await ticketService.getHistory(params);
  res.json({ ok: true, data });
});

module.exports = { today, byDate, history };
