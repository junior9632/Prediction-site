'use strict';

/** /api/fixtures — public fixture data. */

const express = require('express');
const controller = require('../controllers/fixtureController');

const router = express.Router();

router.get('/', controller.list);
router.get('/:id', controller.detail);

module.exports = router;
