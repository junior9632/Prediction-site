'use strict';

/** /api/odds — verified Over 1.5 prices only. */

const express = require('express');
const controller = require('../controllers/oddsController');

const router = express.Router();

router.get('/', controller.listByDate);
router.get('/bookmakers', controller.bookmakers);
router.get('/fixture/:id', controller.byFixture);

module.exports = router;
