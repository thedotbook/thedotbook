// The Dollar Book — Service Worker
//
// Deliberately uses a NETWORK-FIRST strategy, not cache-first. The site is
// updated frequently (often multiple times a day), so the priority is
// always showing the freshest content when the user is online, with the
// cache only used as a fallback when genuinely offline. A cache-first
// strategy would risk showing stale content indefinitely after an update
// ships, which is a real problem this project hit before.

const CACHE_NAME = 'dollar-book-cache-v1';
const OFFLINE_FALLBACK_URL = 'index.html';

const PRECACHE_ASSETS = [
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

// Install: cache the core assets, then activate immediately rather than
// waiting for old tabs/instances to close.
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
});

// Activate: remove any old, differently-named caches from previous versions
// of this service worker, then take control of all open pages immediately.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first. Try the network; if it succeeds, use it AND update
// the cache for next time. If the network fails (offline), fall back to
// whatever's cached, and if that specific URL isn't cached either, fall
// back to the main page so the app still opens rather than showing a
// browser error.
self.addEventListener('fetch', (event) => {
  // Only handle GET requests - POST requests (like the AI chat / worker
  // calls) should always go straight to the network, never cached.
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        return networkResponse;
      })
      .catch(() =>
        caches.match(event.request).then((cachedResponse) => {
          return cachedResponse || caches.match(OFFLINE_FALLBACK_URL);
        })
      )
  );
});
