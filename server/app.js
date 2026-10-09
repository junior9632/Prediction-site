'use strict';

/**
 * Express application factory.
 *
 * Browser -> Express -> API-Football. The API key never leaves this process.
 *
 * ACCESS MODEL (server enforced, never a CSS or JavaScript rule)
 *
 *   public  : / , /about , /legal , /login , /account , /api/health , /api/meta
 *   member  : /predictions , /ticket , /today-ticket , /history , /analytics ,
 *             /dashboard and every /api/{predictions,ticket,tickets,analytics,
 *             fixtures,odds} route
 *   admin   : /admin, /admin/users (+ /api/admin)
 *
 * A member route is refused before any controller, query or template runs:
 * an API path answers 401 Unauthorized with an empty body, a page path
 * answers 401 with the "login required" page. Football data — matches,
 * predictions, odds, confidence, AI selections, tickets, history and
 * analytics — therefore never leaves the server for an anonymous caller, and
 * the authenticated principal is always taken from the session token (never
 * from a request parameter).
 */

const fs = require('fs');
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
const { requireActiveAccount } = require('./middleware/account');
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
// Served from outside public/ on purpose: it is a server-rendered refusal, not
// a static asset anyone may fetch (and it must never be cached or indexed).
const LOGIN_REQUIRED_VIEW = path.join(config.rootDir, 'server', 'views', 'login-required.html');

/**
 * Copy for the "login required" page, one entry per protected surface. The
 * wording matches the product voice: it states what is behind the door
 * without revealing a single selection, price or percentage.
 */
const PREDICTIONS_SECTION = {
  eyebrow: 'Football Predictions · Members only',
  title: 'Football Predictions',
  message: 'Login or create an account to access GoalPredict AI football predictions.',
};
const TICKET_SECTION = {
  eyebrow: "Today's Ticket · Members only",
  title: "Today's AI Ticket",
  message: "Login to access today's verified football selections.",
};
const HISTORY_SECTION = {
  eyebrow: 'Ticket History · Members only',
  title: 'Ticket History',
  message: 'Login to access the complete, settled GoalPredict ticket record.',
};
const ANALYTICS_SECTION = {
  eyebrow: 'Analytics · Members only',
  title: 'Prediction Analytics',
  message: 'Login to access GoalPredict performance analytics and AI model statistics.',
};

/** Only same-site, absolute paths may be carried into a `?next=` parameter. */
function safeNextPath(value) {
  const raw = String(value || '');
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/predictions';
  return raw.slice(0, 200);
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let loginRequiredTemplate = null;
function loginRequiredTemplateHtml() {
  if (loginRequiredTemplate === null) loginRequiredTemplate = fs.readFileSync(LOGIN_REQUIRED_VIEW, 'utf8');
  return loginRequiredTemplate;
}

/**
 * Render the "login required" page.
 *
 * The protected URL itself answers with 401 Unauthorized (403 when the
 * session exists but the account is disabled or locked) and with this page as
 * the body — so a guest gets a professional, on-brand door rather than the
 * prediction data, and no cache is ever allowed to replay the answer.
 */
function sendLoginRequired(res, section, { status = 401, next = '/predictions', notice = '' } = {}) {
  const html = loginRequiredTemplateHtml()
    .replace(/\{\{EYEBROW\}\}/g, escapeHtml(section.eyebrow))
    .replace(/\{\{TITLE\}\}/g, escapeHtml(section.title))
    .replace(/\{\{MESSAGE\}\}/g, escapeHtml(section.message))
    .replace(/\{\{NEXT\}\}/g, encodeURIComponent(safeNextPath(next)))
    .replace(/\{\{YEAR\}\}/g, String(new Date().getFullYear()))
    .replace(
      '{{NOTICE}}',
      notice
        ? `<div class="alert warn" style="max-width:46ch;margin:20px auto 0;text-align:left;">${escapeHtml(notice)}</div>`
        : ''
    );

  res
    .status(status)
    .set({
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Robots-Tag': 'noindex, nofollow',
    })
    .type('html')
    .send(html);
}

/**
 * The notice shown on the login-required door when a signed-in account is
 * refused: pending applicants, rejected applications and suspended accounts
 * each get their own honest message (see middleware/account.js).
 */
function accountNotice(code) {
  if (code === 'ACCOUNT_PENDING') {
    return 'Your account has been submitted for approval. You will be able to access your dashboard once an administrator approves your account.';
  }
  if (code === 'ACCOUNT_REJECTED') {
    return 'This account application was not approved. Please contact support if you believe this is a mistake.';
  }
  if (code === 'ACCOUNT_SUSPENDED') {
    return 'This account has been suspended. Please contact support for more information.';
  }
  return 'This account is currently disabled or temporarily locked. Contact support or sign in with a different account.';
}

/**
 * Server side guard for a member-only page: a verified session AND an account
 * that still exists and is active. The account is re-read from the database by
 * `requireActiveAccount`, so a deleted, deactivated or locked member is
 * refused even while their token is still cryptographically valid.
 */
function memberAreaGuard(section) {
  return (req, res, next) =>
    requireAuth(req, res, (authErr) => {
      if (authErr) {
        return sendLoginRequired(res, section, {
          status: authErr.status === 401 ? 401 : authErr.status || 401,
          next: req.originalUrl,
        });
      }
      return requireActiveAccount(req, res, (accountErr) => {
        if (!accountErr) return next();
        const status = accountErr.status === 401 ? 401 : 403;
        return sendLoginRequired(res, section, {
          status,
          next: req.originalUrl,
          notice: status === 403 ? accountNotice(accountErr.code) : '',
        });
      });
    });
}

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
  // The member dashboard is refused for accounts that are not approved
  // (pending / rejected / suspended): the account is re-read from the
  // database, so an administrator's decision takes effect immediately, even
  // for a session token that is still cryptographically valid.
  const memberPageGuard = (req, res, next) =>
    requireAuth(req, res, (err) => {
      if (err && err.status === 401) return res.redirect(302, '/account.html');
      if (err) return next(err);
      if (req.auth && req.auth.type === 'admin') return res.redirect(302, '/admin.html');
      return requireActiveAccount(req, res, (accountErr) => {
        if (!accountErr) return next();
        // Not an approved member (pending / rejected / suspended / disabled):
        // back to the account door, which explains the status on sign-in.
        return res.redirect(302, '/account.html');
      });
    });

  const memberDashboardPage = (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'), {
      headers: { 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' },
    });

  app.get('/dashboard', memberPageGuard, memberDashboardPage);
  app.get('/dashboard.html', memberPageGuard, memberDashboardPage);

  /* --------------------- member-only football pages ------------------ */
  // Every football surface is login only. The guard below is the server side
  // half of that rule — the navigation link is hidden for guests, but the
  // page (and its .html alias) is refused here as well, so typing the URL
  // into a fresh incognito window answers with a 401 "login required" page
  // instead of predictions, odds, confidence or ticket selections.
  //
  // It runs BEFORE express.static, which is what makes the .html aliases
  // safe too: /predictions.html never reaches the static handler for a guest.
  const MEMBER_PAGES = [
    { routes: ['/predictions', '/predictions.html'], file: 'predictions.html', section: PREDICTIONS_SECTION },
    { routes: ['/ticket', '/ticket.html', '/today-ticket', '/today-ticket.html'], file: 'ticket.html', section: TICKET_SECTION },
    { routes: ['/history', '/history.html'], file: 'history.html', section: HISTORY_SECTION },
    { routes: ['/analytics', '/analytics.html'], file: 'analytics.html', section: ANALYTICS_SECTION },
  ];

  for (const page of MEMBER_PAGES) {
    const guard = memberAreaGuard(page.section);
    const serve = (_req, res) =>
      res.sendFile(path.join(PUBLIC_DIR, page.file), {
        headers: { 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' },
      });
    for (const route of page.routes) app.get(route, guard, serve);
  }

  /* ------------------------- hidden admin area ---------------------- */
  // The admin console is deliberately undiscoverable: no public page, nav,
  // footer, sitemap or robots entry references it. Server side we never rely
  // on that secrecy alone —
  //   * guests (or expired/invalid sessions) are redirected to the console's
  //     own sign-in door (/admin/login), so the URL never answers with admin
  //     content
  //   * authenticated non-admins receive a bare 403 with no admin details
  //   * the admin account is re-read from the database, so a deactivated or
  //     locked administrator is refused even with a valid token
  //   * the console shell + its script are never cached or indexed
  const adminPageGuard = (req, res, next) => {
    const { token } = readToken(req);
    if (!token) return res.redirect(302, '/admin/login');
    let claims;
    try {
      claims = verifyToken(token);
    } catch (_err) {
      return res.redirect(302, '/admin/login');
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

  // Canonical, unlisted sign-in door for the console: /admin/login.
  // It serves the shared sign-in page — no admin data, no console shell, no
  // endpoint list — so an operator who types the obvious admin address gets a
  // form instead of a 404. Every other /admin/<anything> still answers 404.
  const adminSignInPage = (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'), {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' },
    });

  const alreadySignedInAdmin = (req, res, next) => {
    const { token } = readToken(req);
    if (!token) return next();
    try {
      const claims = verifyToken(token);
      if (claims.type === 'admin') return res.redirect(302, '/admin.html');
    } catch (_err) {
      /* expired or invalid session: show the form again */
    }
    return next();
  };

  app.get('/admin/login', alreadySignedInAdmin, adminSignInPage);
  app.get('/admin/login.html', alreadySignedInAdmin, adminSignInPage);
  app.get('/admin', adminPageGuard, requireActiveAdmin, adminConsolePage);
  app.get('/admin.html', adminPageGuard, requireActiveAdmin, adminConsolePage);

  // The Users section of the console (registration approval + account
  // management) is a dedicated admin page behind the exact same guard chain:
  // guests are redirected to the console sign-in door, non-admins get a bare
  // 403, and the admin account is re-read from the database.
  const adminUsersPage = (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'admin', 'users.html'), {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' },
    });

  app.get('/admin/users', adminPageGuard, requireActiveAdmin, adminUsersPage);
  app.get('/admin/users.html', adminPageGuard, requireActiveAdmin, adminUsersPage);

  // The console scripts list the privileged API endpoints, so they are only
  // served to verified administrators; for everyone else they simply do not
  // exist (404), exactly like an unknown asset.
  const guardedAdminScript = (file) => (req, res, next) => {
    const { token } = readToken(req);
    if (token) {
      try {
        const claims = verifyToken(token);
        if (claims.type === 'admin') return res.sendFile(path.join(PUBLIC_DIR, 'js', file));
      } catch (_err) {
        /* fall through to the generic 404 below */
      }
    }
    return next(AppError.notFound());
  };

  app.get('/js/admin.js', guardedAdminScript('admin.js'));
  app.get('/js/admin-users.js', guardedAdminScript('admin-users.js'));

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

  // Friendly URLs (no .html needed). Only genuinely public pages live here —
  // /login is the MEMBER sign-in (the same page as /account, register form
  // included) so a visitor who types it lands on something useful. Every
  // football page (/predictions, /ticket, /today-ticket, /history,
  // /analytics) is registered above behind `memberAreaGuard` instead.
  const pages = ['legal', 'about', 'account'];
  for (const page of pages) {
    app.get(`/${page}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, `${page}.html`)));
  }

  app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'account.html')));

  // The robots file must never advertise private areas (/admin, the sign-in
  // pages, the member-only football pages): a Disallow entry would point
  // crawlers straight at them. Every protected page answers with a 401/403
  // login-required page and a noindex header, so nothing leaks even if a
  // crawler does guess the URL.
  app.get('/robots.txt', (_req, res) => {
    res
      .type('text/plain')
      .send(
        `User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /api/\n\nSitemap: ${config.appUrl}/sitemap.xml\n`
      );
  });

  // Public, indexable pages only — the sign-in pages and every member-only
  // football page are deliberately excluded.
  app.get('/sitemap.xml', (_req, res) => {
    const publicPages = ['', 'about', 'legal'];
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
