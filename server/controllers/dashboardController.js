'use strict';

/**
 * MEMBER DASHBOARD controller — data that only belongs to a signed-in
 * account. Every handler runs behind `requireAuth` + `requireActiveAccount`;
 * an anonymous caller is answered with 401 Unauthorized and receives no
 * dashboard data at all.
 */

const activityService = require('../services/activityService');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/errors');

/**
 * GET /api/dashboard/activity
 *
 * The caller's own activity feed (sign-ins, password changes, lockouts and the
 * account summary). Scoped to `req.member`, which the account guard read from
 * the database — query parameters can never widen the scope.
 */
const activity = asyncHandler(async (req, res) => {
  if (!req.member) throw AppError.unauthorized();
  const data = await activityService.getDashboardActivity(req.member);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, data });
});

module.exports = { activity };
