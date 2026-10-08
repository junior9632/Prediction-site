'use strict';

/**
 * Express application factory.
 *
 * Browser -> Express -> API-Football. The API key never leaves this process.
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const config = require('./config');
const logger = require('./utils/logger');
const { AppError } = require('./utils/errors');
const { requestLogger } = require('./middleware/requestLogger');
const { optionalAuth, requireAuth, readToken, verifyToken } = require('./middleware/auth');
const { requireActiveAdmin } = require('./middleware/adminAuth');
const { apiLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const healthRoutes = require('./routes/health');
const fixturesRoutes = require('./routes/fixtures');
const oddsRoutes = require('./routes/odds');
const predictionsRoutes = require('./routes/predictions');
const ticketsRoutes = require('./routes/tickets');
const analyticsRoutes = require('./routes/analytics');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const dashboardRoutes = require('./routes/dashboard');

const log = logger.child('app');
const PUBLIC_DIR = path.join(config.rootDir, 'public');

function corsOptions() {
  const origins = config.security.corsOrigins;
  if (!origins.length) {
    // no explicit list => same origin only (the browser preview / same domain)
    return { origin: false, credentials: true };
  }
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true); // curl / server-to-server
      const allowed = origins.some((o) => o === '*' || o === origin);
      if (!allowed) return callback(AppError.forbidden('Origin not allowed by CORS policy', 'CORS_REJECTED'));
      return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    maxAge: 600,
  };
}

function createApp() {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Exact odds arithmetic uses BigInt scaled decimals. They must never reach a
  // JSON body (JSON.stringify throws on BigInt), so every response serialises
  // them as their exact string form instead of failing the request.
  app.set('json replacer', (key, value) => (typeof value === 'bigint' ? value.toString() : value));

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          // vanilla JS is always served from our own files — never inline
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'https://media.api-sports.io', 'https:'],
          'connect-src': ["'self'"],
          'font-src': ["'self'", 'data:'],
          'object-src': ["'none'"],
          'frame-ancestors': ["'self'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'upgrade-insecure-requests': config.isProduction ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
    })
  );

  app.use(compression());
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: config.security.maxBodySize }));
  app.use(express.urlencoded({ extended: false, limit: config.security.maxBodySize }));
  app.use(cookieParser());
  app.use(requestLogger);
  app.use(optionalAuth);

  /* ----------------------------- API ------------------------------- */
  app.use('/api', apiLimiter);
  app.use('/api', healthRoutes);
  app.use('/api/fixtures', fixturesRoutes);
  app.use('/api/odds', oddsRoutes);
  app.use('/api/predictions', predictionsRoutes);
  app.use('/api/ticket', ticketsRoutes);
  app.use('/api/tickets', ticketsRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  // Member dashboard data (activity feed, account summary). Guests get 401 —
  // never a partial payload, never a cached one.
  app.use('/api/dashboard', dashboardRoutes);

  /* ------------------------ protected frontend ---------------------- */
  // The private pages are protected at the server boundary as well as in the
  // browser. An unauthenticated visitor opening /dashboard or /dashboard.html
  // directly is bounced to the member sign-in page instead of receiving the
  // member area (and the page itself is never cached).
  const memberPageGuard = (req, res, next) =>
    requireAuth(req, res, (err) => {
      if (err && err.status === 401) return res.redirect(302, '/account.html');
      if (err) return next(err);
      if (req.auth && req.auth.type === 'admin') return res.redirect(302, '/admin.html');
      return next();
    });

  const memberDashboardPage = (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'), {
      headers: { 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' },
    });

  app.get('/dashboard', memberPageGuard, memberDashboardPage);
  app.get('/dashboard.html', memberPageGuard, memberDashboardPage);

  /* ------------------------- hidden admin area ---------------------- */
  // The admin console is deliberately undiscoverable: no public page, nav,
  // footer, sitemap or robots entry references it. Server side we never rely
  // on that secrecy alone —
  //   * guests (or expired/invalid sessions) are redirected to the public
  //     sign-in page, so the URL never answers with admin content
  //   * authenticated non-admins receive a bare 403 with no admin details
  //   * the admin account is re-read from the database, so a deactivated or
  //     locked administrator is refused even with a valid token
  //   * the console shell + its script are never cached or indexed
  const adminPageGuard = (req, res, next) => {
    const { token } = readToken(req);
    if (!token) return res.redirect(302, '/login.html');
    let claims;
    try {
      claims = verifyToken(token);
    } catch (_err) {
      return res.redirect(302, '/login.html');
    }
    if (claims.type !== 'admin') return next(AppError.forbidden());
    req.auth = {
      id: Number(claims.sub),
      type: 'admin',
      role: claims.role || 'admin',
      email: claims.email || null,
      username: claims.username || null,
    };
    return next();
  };

  const adminConsolePage = (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'), {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' },
    });

  app.get('/admin', adminPageGuard, requireActiveAdmin, adminConsolePage);
  app.get('/admin.html', adminPageGuard, requireActiveAdmin, adminConsolePage);

  // The console script lists the privileged API endpoints, so it is only
  // served to verified administrators; for everyone else it simply does not
  // exist (404), exactly like an unknown asset.
  app.get('/js/admin.js', (req, res, next) => {
    const { token } = readToken(req);
    if (token) {
      try {
        const claims = verifyToken(token);
        if (claims.type === 'admin') return res.sendFile(path.join(PUBLIC_DIR, 'js', 'admin.js'));
      } catch (_err) {
        /* fall through to the generic 404 below */
      }
    }
    return next(AppError.notFound());
  });

  /* --------------------------- frontend ---------------------------- */
  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      maxAge: config.isProduction ? '1h' : 0,
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  // friendly URLs (no .html needed)
  const pages = ['ticket', 'history', 'analytics', 'predictions', 'legal', 'account', 'login'];
  for (const page of pages) {
    app.get(`/${page}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, `${page}.html`)));
  }

  // The robots file must never advertise private areas (/admin, the sign-in
  // pages): a Disallow entry would point crawlers straight at them. The
  // private pages themselves answer with redirects/403s for anyone who is
  // not an administrator and carry noindex headers, so nothing leaks even if
  // a crawler does guess the URL.
  app.get('/robots.txt', (_req, res) => {
    res
      .type('text/plain')
      .send(
        `User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /api/\n\nSitemap: ${config.appUrl}/sitemap.xml\n`
      );
  });

  // Public, indexable pages only — admin/login are deliberately excluded.
  app.get('/sitemap.xml', (_req, res) => {
    const publicPages = ['', 'ticket', 'history', 'analytics', 'predictions', 'legal'];
    const today = new Date().toISOString().slice(0, 10);
    const urls = publicPages
      .map(
        (p) =>
          `  <url><loc>${config.appUrl}/${p}</loc><lastmod>${today}</lastmod><changefreq>${p === 'legal' ? 'monthly' : 'daily'}</changefreq></url>`
      )
      .join('\n');
    res
      .type('application/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  /* --------------------------- errors ------------------------------ */
  app.use(notFound);
  app.use(errorHandler);

  log.info('express app ready', { env: config.env, publicDir: PUBLIC_DIR });
  return app;
}

module.exports = { createApp, PUBLIC_DIR };
