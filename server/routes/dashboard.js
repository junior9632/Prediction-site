'use strict';

/**
 * /api/dashboard — the signed-in account's OWN dashboard data.
 *
 * Server side protection, not CSS:
 *   * `requireAuth` rejects every request without a verified session with
 *     401 Unauthorized (no data, no partial payload);
 *   * `requireActiveAccount` re-reads the account from the database, so a
 *     deleted / disabled / locked account is refused too;
 *   * every handler scopes its query to that account, so opening the URL
 *     directly as a visitor (or as a different member) can never return
 *     dashboard activity.
 *
 * The composition is the shared `memberApiGuard` — the exact same one the
 * prediction, ticket, odds, fixture and analytics routers mount, plus the
 * no-store header that stops a shared cache replaying account data (or a
 * 401/403 for a route whose answer depends on the session).
 *
 * The admin console keeps using /api/admin/* — nothing here loosens it.
 */

const express = require('express');
const controller = require('../controllers/dashboardController');
const { memberApiGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberApiGuard);

router.get('/activity', controller.activity);

module.exports = router;
