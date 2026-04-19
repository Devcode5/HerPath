// sw.js — HerPath Service Worker
// Strategy: Cache-first for static assets, network-first for navigation
// Bump CACHE_VERSION whenever you deploy a new build

const CACHE_VERSION = 'herpath-v1';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  // Add any external fonts/scripts you rely on:
  'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=Nunito:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  'https://cdn.tailwindcss.com',
];

// ─── Install: pre-cache everything we listed above ───────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => {
        // Use { cache: 'reload' } so we always get a fresh copy on install,
        // not a stale HTTP-cached version.
        return Promise.allSettled(
          PRECACHE_URLS.map((url) =>
            cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
              // Non-fatal: if a CDN resource fails (e.g. offline during install)
              // we just log it and move on — the runtime handler will retry.
              console.warn('[SW] Precache failed for:', url, err);
            })
          )
        );
      })
      .then(() => self.skipWaiting())  // activate immediately, don't wait for old SW to die
  );
});

// ─── Activate: delete every cache that isn't CACHE_VERSION ───────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => self.clients.claim())  // take control of all open tabs immediately
  );
});

// ─── Fetch: the main strategy logic ──────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests — let POST/PUT/DELETE go straight to network
  if (request.method !== 'GET') return;

  // Skip non-http(s) requests (e.g. chrome-extension://)
  if (!request.url.startsWith('http')) return;

  const url = new URL(request.url);

  // ── Strategy A: Network-first for HTML navigation requests ──────────────
  // If the user navigates to any page in the app, try the network first.
  // If the network fails (offline), fall back to the cached index.html.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Network succeeded — clone and store the fresh copy in cache
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => {
          // Network failed — serve from cache
          return caches.match(request).then(
            (cached) => cached || caches.match('/index.html')
          );
        })
    );
    return;
  }

  // ── Strategy B: Cache-first (falling back to network) for everything else ─
  // Static assets (fonts, scripts, CSS) are expensive to re-download.
  // Serve from cache instantly if available; otherwise hit the network
  // and cache the result for next time.
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Cache hit — return immediately, but also revalidate in the background
        // (stale-while-revalidate pattern for long-lived assets)
        const revalidate = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches
                .open(CACHE_VERSION)
                .then((cache) => cache.put(request, networkResponse.clone()));
            }
            return networkResponse;
          })
          .catch(() => { /* offline — background revalidation silently fails */ });

        // We don't await the revalidation — just return the cached copy now
        void revalidate;
        return cachedResponse;
      }

      // Cache miss — fetch from network and cache it
      return fetch(request)
        .then((networkResponse) => {
          // Only cache valid, same-origin-or-CORS responses
          if (
            !networkResponse ||
            networkResponse.status !== 200 ||
            (networkResponse.type !== 'basic' && networkResponse.type !== 'cors')
          ) {
            return networkResponse;
          }

          const clone = networkResponse.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          return networkResponse;
        })
        .catch(() => {
          // Total offline + cache miss: nothing we can do for non-HTML assets
          console.warn('[SW] Offline and no cache for:', request.url);
        });
    })
  );
});

// ─── Message handler: force update from the app ──────────────────────────────
// Call this from your app: navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' })
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
