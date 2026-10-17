'use strict';

/**
 * /api/ticket + /api/tickets — today's ticket, a specific date and history.
 * Mounted twice (singular + plural) so both documented URLs work.
 *
 * MEMBER ONLY. A ticket is the published AI selection: its legs, prices,
 * combined odds and settlement are never served to an anonymous caller. The
 * guard runs before the router's own handlers, so every route below — and
 * every alias prefix — is covered.
 */

const express = require('express');
const controller = require('../controllers/ticketController');
const { memberGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberGuard);

router.get('/today', controller.today);
router.get('/history', controller.history);
router.get('/:date', controller.byDate);

module.exports = router;
