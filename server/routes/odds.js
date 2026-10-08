'use strict';

/**
 * /api/odds — verified Over 1.5 prices only.
 *
 * MEMBER ONLY. The prices themselves are the prediction input, so the whole
 * router sits behind `memberGuard`: a guest is answered with 401 rather than
 * with the bookmaker prices a ticket is built from.
 */

const express = require('express');
const controller = require('../controllers/oddsController');
const { memberGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberGuard);

router.get('/', controller.listByDate);
router.get('/bookmakers', controller.bookmakers);
router.get('/fixture/:id', controller.byFixture);

module.exports = router;
