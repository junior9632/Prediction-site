'use strict';

/**
 * /api/ticket + /api/tickets — today's ticket, a specific date and history.
 * Mounted twice (singular + plural) so both documented URLs work.
 */

const express = require('express');
const controller = require('../controllers/ticketController');

const router = express.Router();

router.get('/today', controller.today);
router.get('/history', controller.history);
router.get('/:date', controller.byDate);

module.exports = router;
