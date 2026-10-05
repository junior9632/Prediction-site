'use strict';

/** /api/analytics — public performance statistics. */

const express = require('express');
const controller = require('../controllers/analyticsController');

const router = express.Router();

router.get('/', controller.overview);

module.exports = router;
