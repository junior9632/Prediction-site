'use strict';

/**
 * /api/odds — verified Over 1.5 prices only.
 *
 * MEMBERS ONLY. The verified bookmaker prices are an input to (and part of)
 * every published prediction, so they are served to signed-in accounts only.
 * A guest receives 401 with no payload — no prices, no bookmaker list, no
 * fixture detail.
 */

const express = require('express');
const controller = require('../controllers/oddsController');
const { memberApiGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberApiGuard);

router.get('/', controller.listByDate);
router.get('/bookmakers', controller.bookmakers);
router.get('/fixture/:id', controller.byFixture);

module.exports = router;
