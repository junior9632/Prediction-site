'use strict';

/**
 * /api/analytics — performance statistics.
 *
 * MEMBER ONLY. Win rates, streaks, the flat-stake record and the monthly
 * breakdown are prediction analytics: `memberGuard` answers a guest with 401
 * and no payload instead of the numbers.
 */

const express = require('express');
const controller = require('../controllers/analyticsController');
const { memberGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberGuard);

router.get('/', controller.overview);

module.exports = router;
