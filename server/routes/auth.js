'use strict';

/** /api/auth — admin + user authentication. */

const express = require('express');
const controller = require('../controllers/authController');
const { requireAdmin, requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/adminAuth');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Session endpoints answer with per-account data (or set cookies): nothing here
// may ever be stored by a browser cache, a shared proxy or a CDN.
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.post('/admin/login', authLimiter, controller.adminLogin);
router.post('/admin/logout', controller.adminLogout);
router.post('/admin/change-password', requireAdmin, controller.changePassword);
router.get('/me', controller.me);
router.post('/register', authLimiter, controller.register);
router.post('/login', authLimiter, controller.userLogin);
router.post('/logout', controller.logout);
router.post('/change-password', requireAuth, requireCsrf, controller.userChangePassword);

module.exports = router;
