/* GoalPredict — service worker */
'use strict';

/**
 * Caching policy mirrors the product's honesty rules:
 *
 *  - /api/* is NEVER cached or intercepted. Tickets, odds and results always
 *    come from the server; offline means offline, never a stale ticket
 *    presented as today's.
 *  - Static assets (css/js/img/manifest) are cached with a versioned cache,
 *    refreshed in the background (stale-while-revalidate).
 *  - Page navigations are network-first with a branded offline fallback.
 */

const VERSION = 'v2';
const STATIC_CACHE = `goalpredict-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';

const PRECACHE = [
  OFFLINE_URL,
  '/css/style.css',
  '/js/api.js',
  '/img/logo.svg',
  '/img/favicon.svg',
  '/img/icon-maskable.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/img/') ||
    url.pathname === '/manifest.webmanifest'
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // HARD RULE: never intercept or cache API traffic — live data only.
  if (url.pathname.startsWith('/api/')) return;

  // HARD RULE: the admin console script is access controlled on the server;
  // it must never be cached or replayed from the service worker cache.
  if (url.pathname === '/js/admin.js') return;

  // Page navigations: network first, offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((hit) => hit || new Response('Offline', { status: 503 }))
      )
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const refresh = fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => null);
        return cached || refresh.then((r) => r || new Response('Offline', { status: 503 }));
      })
    );
  }
});
