'use strict';

/** Public performance statistics. */

const analyticsService = require('../services/analyticsService');
const { asyncHandler } = require('../utils/asyncHandler');

/** GET /api/analytics */
const overview = asyncHandler(async (_req, res) => {
  const data = await analyticsService.getPublicStats();
  res.json({ ok: true, data });
});

module.exports = { overview };
