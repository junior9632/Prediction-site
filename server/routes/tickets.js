'use strict';

/**
 * /api/ticket + /api/tickets — today's ticket, a specific date and history.
 * Mounted twice (singular + plural) so both documented URLs work.
 *
 * MEMBERS ONLY. Today's ticket, its selections, the frozen odds snapshots and
 * the published history are prediction data: an anonymous visitor gets 401
 * with no payload on every one of these URLs, including both mount prefixes.
 * The guard lives in the router so it cannot be bypassed by asking for the
 * other prefix or for the data directly instead of through the page.
 */

const express = require('express');
const controller = require('../controllers/ticketController');
const { memberApiGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberApiGuard);

router.get('/today', controller.today);
router.get('/history', controller.history);
router.get('/:date', controller.byDate);

module.exports = router;
