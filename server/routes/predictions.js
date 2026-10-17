'use strict';

/**
 * /api/predictions — server computed Over 1.5 analysis.
 *
 * MEMBER ONLY. Predictions, their confidence, the model probability and the
 * AI selections are a paid/registered surface: `memberGuard` refuses any
 * request without a verified, active session with 401 Unauthorized and an
 * empty body, so a guest opening the URL in the address bar — or from
 * DevTools — gets no prediction data back.
 */

const express = require('express');
const controller = require('../controllers/predictionController');
const { memberGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberGuard);

router.get('/', controller.list);
router.get('/:fixtureId', controller.detail);

module.exports = router;
