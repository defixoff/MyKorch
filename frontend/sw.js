const CACHE_NAME = 'moy-korch-v7';
// Query-versioning forces a new worker to fetch current assets instead of
// inheriting a same-name response from the previous worker's cache.
const STATIC_FILES = ['/index.html?v=7', '/app.js?v=7', '/styles.css?v=7', '/manifest.json?v=7', '/icon.svg?v=7'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Данные пользователя всегда должны идти в сеть: иначе после POST интерфейс
  // видел бы устаревший ответ /api/rigs или /api/.../cards из Cache Storage.
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (url.origin === self.location.origin) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match('/index.html'))));
});
