// Simple service worker for offline caching of static assets
// Bump the cache version to ensure clients fetch the latest assets when the
// service worker is updated. Changing this name will cause the install
// event to run again and replace any previously cached resources.
// Bump the cache version again because we updated main.js with a
// global error handler. Incrementing this value ensures clients
// download the latest script instead of using a cached one. Each
// release should increment this value to invalidate old assets.
// Bump the cache again because we updated main.js to center the map on
// the user's location. Changing the cache name forces the service worker
// to reinstall and fetch the latest assets.
const CACHE_NAME = 'location-chat-cache-v4';
// List of resources to pre‑cache for offline use
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/main.js',
  '/manifest.json',
  '/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only handle GET requests; let other requests pass through
  if (request.method !== 'GET') {
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(request).then((response) => {
        // Optionally put fetched files in cache
        return response;
      });
    })
  );
});