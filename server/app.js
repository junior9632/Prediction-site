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
const { optionalAuth } = require('./middleware/auth');
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
  const pages = ['ticket', 'history', 'analytics', 'predictions', 'legal', 'account', 'login', 'admin'];
  for (const page of pages) {
    app.get(`/${page}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, `${page}.html`)));
  }

  app.get('/robots.txt', (_req, res) => {
    res
      .type('text/plain')
      .send(
        `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /login\nDisallow: /account\nDisallow: /api/\n\nSitemap: ${config.appUrl}/sitemap.xml\n`
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
