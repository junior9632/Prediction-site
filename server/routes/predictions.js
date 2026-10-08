'use strict';

/**
 * /api/predictions — server computed Over 1.5 analysis.
 *
 * MEMBERS ONLY. Football predictions — the analysis list, the confidence /
 * quality / risk scores, the model probability and the transparent per-match
 * breakdown — are the product. They are never served to an anonymous visitor.
 *
 * The protection is server side, in this router, so it holds for every caller:
 * the member page, an AJAX request from DevTools, curl or a scraped URL all
 * pass through `memberApiGuard` first and receive 401 Unauthorized with no
 * payload when the session is missing, invalid, expired, disabled or locked.
 * Responses are never cacheable, so a proxy cannot replay them either.
 */

const express = require('express');
const controller = require('../controllers/predictionController');
const { memberApiGuard } = require('../middleware/account');

const router = express.Router();

router.use(memberApiGuard);

router.get('/', controller.list);
router.get('/:fixtureId', controller.detail);

module.exports = router;
