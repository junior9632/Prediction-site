'use strict';

/**
 * /api/admin — protected dashboard API.
 * Every route requires an active administrator + CSRF token for mutations.
 */

const express = require('express');
const controller = require('../controllers/adminController');
const userManagement = require('../controllers/userManagementController');
const { adminGuard, superAdminGuard } = require('../middleware/adminAuth');
const { adminLimiter, generateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.use(adminLimiter);
router.use(adminGuard);

/* user management — registration approval workflow (admin only) */
router.get('/users/summary', userManagement.summary);
router.get('/users', userManagement.list);
router.get('/users/:id', userManagement.detail);
router.post('/users/:id/approve', userManagement.approve);
router.post('/users/:id/reject', userManagement.reject);
router.post('/users/:id/suspend', userManagement.suspend);
router.post('/users/:id/reactivate', userManagement.reactivate);

router.get('/overview', controller.overview);

/* manual ticket generation */
router.post('/generate-ticket', generateLimiter, controller.generateTicket);
router.get('/generation-progress', controller.generationProgress);
router.get('/generation-report', controller.generationReport);
router.get('/generations', controller.generations);

/* configuration */
router.get('/settings', controller.getSettings);
router.put('/settings', controller.updateSettings);

/* data screens */
router.get('/fixtures', controller.fixtures);
router.get('/odds', controller.odds);
router.get('/predictions', controller.predictions);
router.get('/tickets/history', controller.ticketsHistory);
router.get('/analytics', controller.analytics);

/* operations */
router.post('/sync', controller.sync);
router.get('/api-status', controller.apiStatus);
router.get('/system-logs', controller.systemLogs);
router.get('/sync-logs', controller.syncLogs);
router.get('/admins', superAdminGuard, controller.admins);

module.exports = router;
