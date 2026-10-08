'use strict';

/**
 * Express application factory.
 *
 * Browser -> Express -> API-Football. The API key never leaves this process.
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
const { requireActiveAccount } = require('./middleware/account');
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

/* ------------------------------------------------------------------ *
 * MEMBER-ONLY PAGES
 *
 * Football predictions and everything built on them are the product, so they
 * are members only: the page, the data behind it and the navigation entry.
 * Each entry maps the public URL to the file it serves and to the copy shown
 * on the sign-in door when a visitor is bounced there.
 * ------------------------------------------------------------------ */
const MEMBER_PAGES = [
  {
    path: '/predictions',
    file: 'predictions.html',
    title: 'Football Predictions',
    message: 'Login or create an account to access GoalPredict AI football predictions.',
  },
  {
    path: '/ticket',
    file: 'ticket.html',
    title: "Today's AI Ticket",
    message: 'Login to access today’s verified football selections.',
  },
  {
    path: '/history',
    file: 'history.html',
    title: 'Ticket History',
    message: 'Login to access the published ticket history and settled results.',
  },
  {
    path: '/analytics',
    file: 'analytics.html',
    title: 'Prediction Analytics',
    message: 'Login to access GoalPredict prediction analytics and the performance record.',
  },
];

/** The page entry a `?next=` target refers to — never anything off-site. */
function protectedTarget(next) {
  const raw = typeof next === 'string' ? next.trim() : '';
  // a relative same-site path only: "//evil.example" is a protocol-relative URL
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  const pathname = raw.split('?')[0].split('#')[0].replace(/\.html$/, '').replace(/\/+$/, '') || '/';
  return MEMBER_PAGES.find((page) => page.path === pathname) || null;
}

/** Where a visitor is sent instead of the member area they asked for. */
function signInRedirect(target) {
  const clean = String(target || '/').split('?')[0];
  return `/login?next=${encodeURIComponent(clean)}`;
}

const LOCK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';

/**
 * The login-required panel shown on the sign-in door.
 *
 * It is rendered on the SERVER from the fixed page table above — the `next`
 * value only selects an entry, it is never interpolated — so a visitor with
 * JavaScript disabled still sees why they were redirected, and no attacker
 * supplied string can ever reach the markup.
 */
function loginRequiredBanner(page) {
  return [
    '<section class="auth-required" id="loginRequired">',
    `<span class="auth-required-icon" aria-hidden="true">${LOCK_ICON}</span>`,
    '<div>',
    '<p class="auth-required-eyebrow">Members only</p>',
    `<h2 class="auth-required-title">${page.title}</h2>`,
    `<p class="auth-required-body">${page.message}</p>`,
    '<div class="auth-required-actions">',
    '<a class="btn btn-primary" href="#signin">Login</a>',
    '<a class="btn btn-ghost" href="#register">Create Account</a>',
    '</div>',
    '<p class="auth-required-note">Predictions, odds, confidence scores and the ticket history are never shown to signed-out visitors.</p>',
    '</div>',
    '</section>',
  ].join('\n    ');
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
  // The member pages are protected at the server boundary as well as in the
  // browser. An unauthenticated visitor opening /predictions, /ticket,
  // /history, /analytics or /dashboard directly — typed in the address bar,
  // followed from an old bookmark or from a search result — is bounced to the
  // member sign-in door instead of receiving the page. The HTML itself is
  // therefore never handed to a guest, and it is never cached or indexed.
  //
  // These routes are registered BEFORE the static file handler below, so the
  // static middleware can never serve the underlying .html file to a visitor.
  const sendToSignIn = (req, res) => res.redirect(302, signInRedirect(req.path));

  const memberPageGuard = (req, res, next) =>
    requireAuth(req, res, (err) => {
      if (err) {
        // missing, forged or expired session: the door, never the page
        if (err.status === 401) return sendToSignIn(req, res);
        return next(err);
      }
      // A genuine token is still not enough: the account is re-read from the
      // database, exactly like the API guard does, so a disabled, locked or
      // deleted account is turned away from the page as well.
      return requireActiveAccount(req, res, (accountErr) => {
        if (!accountErr) return next();
        if (accountErr.status === 401 || accountErr.status === 403) return sendToSignIn(req, res);
        return next(accountErr);
      });
    });

  // /dashboard keeps one extra rule from the existing system: an
  // administrator belongs in the console, not the member workspace.
  const dashboardPageGuard = (req, res, next) =>
    memberPageGuard(req, res, (err) => {
      if (err) return next(err);
      if (req.auth && req.auth.type === 'admin') return res.redirect(302, '/admin.html');
      return next();
    });

  const noStoreHeaders = {
    'Cache-Control': 'no-store, no-cache',
    Pragma: 'no-cache',
    'X-Robots-Tag': 'noindex, nofollow',
  };

  const sendMemberPage = (file) => (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, file), { headers: noStoreHeaders });

  for (const page of MEMBER_PAGES) {
    app.get(page.path, memberPageGuard, sendMemberPage(page.file));
    app.get(`${page.path}.html`, memberPageGuard, sendMemberPage(page.file));
  }

  app.get('/dashboard', dashboardPageGuard, sendMemberPage('dashboard.html'));
  app.get('/dashboard.html', dashboardPageGuard, sendMemberPage('dashboard.html'));

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

  // Friendly URLs (no .html needed). Only PUBLIC pages are listed here: the
  // member pages (predictions, ticket, history, analytics, dashboard) are
  // registered above behind the session guard, so this list must never grow
  // one of them back. /login is the MEMBER sign-in — the same page as
  // /account, register form included — so a visitor who types it lands on
  // something useful. The console's own unlisted door is /admin/login (and
  // the legacy /login.html that the deployment guide still prints).
  const pages = ['legal', 'about', 'account'];
  for (const page of pages) {
    app.get(`/${page}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, `${page}.html`)));
  }

  /* ------------------------- member sign-in door --------------------- */
  // /login is where every guarded page sends a signed-out visitor, carrying
  // the page they asked for in `?next=`. The page answers with the shared
  // account page plus a server-rendered "login required" panel naming that
  // page, so the visitor is told what is behind the door (and the message
  // survives JavaScript being switched off). A visitor who is already signed
  // in is sent straight back to the page they wanted.
  const accountPageHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'account.html'), 'utf8');
  const LOGIN_REQUIRED_SLOT = '<!--login-required-banner-->';

  app.get('/login', (req, res) => {
    const target = protectedTarget(req.query.next);
    if (target && req.auth) return res.redirect(302, target.path);

    const body = target ? accountPageHtml.replace(LOGIN_REQUIRED_SLOT, loginRequiredBanner(target)) : accountPageHtml;
    res
      .set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' })
      .type('html')
      .send(body);
    return undefined;
  });

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

  // Public, indexable pages only — the sign-in pages are deliberately
  // excluded, and so is every member page: a crawler reaching /predictions,
  // /ticket, /history or /analytics is answered with a redirect to the
  // sign-in door and a noindex header, so advertising them here would only
  // fill a search index with login redirects.
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
