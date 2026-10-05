'use strict';

/** /api/health + /api/meta */

const express = require('express');
const controller = require('../controllers/healthController');

const router = express.Router();

router.get('/health', controller.health);
router.get('/meta', controller.meta);

module.exports = router;
