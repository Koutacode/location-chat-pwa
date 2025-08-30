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
// Bump the cache again because we refined fetch handling. Changing the
// version triggers the service worker to reinstall and ensure clients
// receive the latest code.
// Bump the cache version again because we switched Leaflet to jsdelivr.
// Updating the cache name forces clients to fetch the latest assets,
// including the new CDN URLs.
// Bump cache again because we removed SRI attributes from Leaflet resources to
// prevent CDN integrity mismatches. Changing the cache name forces
// clients to download the updated index.html.
// Bump cache version because we've added room functionality, login overlay,
// and other features. Updating the cache name forces clients to fetch the
// latest assets, ensuring the new UI and logic are loaded.
// Bump cache version again because we added room persistence, room list
// display, and renamed the application to KOTACHAT. Incrementing
// the cache name forces clients to refresh cached assets and load the
// latest index.html, manifest.json and main.js files with the new
// features and app title.
// Bump cache version because we've added invite functionality, notification toggles,
// status bar, reconnection logic and login persistence. Incrementing the cache
// name forces clients to refresh cached assets and load the latest versions
// of index.html, style.css, main.js and service-worker.js with these new
// features.
// Bump the cache version because we've added file upload functionality and
// adjusted the UI layout (status bar positioning and additional buttons).
// Incrementing the cache name forces clients to refresh cached assets and
// load the latest versions of index.html, style.css, main.js and
// service-worker.js with these new features.
// Bump the cache version because we added file upload UI and adjusted overscroll
// behavior to prevent pull-to-refresh on mobile. Changing the cache name
// forces clients to fetch the latest assets (index.html, style.css, main.js).
// Bump the cache version again because we modified service worker registration
// logic in main.js to forcibly unregister old service workers. Changing the
// cache name ensures browsers fetch this updated service worker and cache.
// Bump cache version again because the file upload feature was removed.
// Updating the cache name forces clients to fetch assets without the
// upload UI and scripts.
const CACHE_NAME = 'location-chat-cache-v18';
// List of resources to pre‑cache for offline use
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/main.js',
  '/manifest.json',
  '/icon-512.png',
  // Use jsdelivr CDN for Leaflet assets instead of unpkg. The unpkg
  // domain is blocked in some deployment environments, preventing the
  // map from loading. jsdelivr is accessible and serves the same
  // files.
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
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
  const url = new URL(request.url);
  // Only intercept same‑origin requests. This prevents the service worker
  // from interfering with requests to other domains (e.g., unpkg.com or
  // openstreetmap.org). Without this check, the service worker can cause
  // unrelated pages to load our cached responses or appear blocked.
  if (url.origin !== self.location.origin) {
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