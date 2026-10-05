'use strict';

/** /api/predictions — server computed Over 1.5 analysis. */

const express = require('express');
const controller = require('../controllers/predictionController');

const router = express.Router();

router.get('/', controller.list);
router.get('/:fixtureId', controller.detail);

module.exports = router;
