'use strict';

/**
 * /api/fixtures — fixture data plus the Over 1.5 market attached to it.
 *
 * MEMBER ONLY from this release on: every row carries the verified Over 1.5
 * price, and the detail route additionally returns the fixture's prediction
 * (confidence, quality, risk, expected goals) and its settled result. Those
 * are prediction data, so an anonymous caller is refused with 401 instead of
 * receiving the list.
 */

const express = require('express');
const controller = require('../controllers/fixtureController');
const { memberGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberGuard);

router.get('/', controller.list);
router.get('/:id', controller.detail);

module.exports = router;
