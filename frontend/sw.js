const CACHE_NAME = 'moy-korch-v8';
// Список нужен только как оффлайн-фолбэк — актуальность контента больше
// не зависит от ручного бампа версии в этих строках (см. network-first ниже).
const STATIC_FILES = ['/index.html', '/app.js', '/styles.css', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Данные пользователя всегда должны идти в сеть: иначе после POST интерфейс
  // видел бы устаревший ответ /api/rigs или /api/.../cards из Cache Storage.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first: свежая версия — приоритет, кэш — только оффлайн-фолбэк.
  // Раньше было наоборот (cache-first), из-за чего пользователи видели
  // старый билд, пока в кэше вообще что-то лежало.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (url.origin === self.location.origin && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))
  );
});
