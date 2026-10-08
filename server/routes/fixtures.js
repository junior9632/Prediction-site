'use strict';

/**
 * /api/fixtures — fixture data with the verified Over 1.5 price attached.
 *
 * MEMBERS ONLY. The list is the raw material of the prediction surface and
 * `/api/fixtures/:id` even carries the stored confidence, quality, risk and
 * expected-goals values, so neither route is served to an anonymous visitor:
 * a guest gets 401 with no payload.
 */

const express = require('express');
const controller = require('../controllers/fixtureController');
const { memberApiGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberApiGuard);

router.get('/', controller.list);
router.get('/:id', controller.detail);

module.exports = router;
