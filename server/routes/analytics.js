'use strict';

/**
 * /api/analytics — performance statistics.
 *
 * MEMBERS ONLY. The published record (win rates, flat-stake ROI, streaks,
 * monthly breakdowns) is prediction performance data and is part of the
 * member area: a guest is answered 401 with no payload.
 */

const express = require('express');
const controller = require('../controllers/analyticsController');
const { memberApiGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberApiGuard);

router.get('/', controller.overview);

module.exports = router;
