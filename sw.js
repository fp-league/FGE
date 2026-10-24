const CACHE = 'fge-v10';

// Only pre-cache fonts and images — they never change between deploys
const IMMUTABLE = [
  './porsche.webp', './gt3-logo.webp', './gt4-logo.webp',
  './fge-logo.webp', './fge-logo-sm.webp'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(IMMUTABLE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('jsonbin.io')) return;
  // Live timing polls every 3s. Caching those would bloat the cache and risk
  // serving a stale race state, so the API is left to the network entirely.
  if (e.request.url.includes('workers.dev') || e.request.url.includes('/api/')) return;

  const url = new URL(e.request.url);
  const ext = url.pathname.split('.').pop().toLowerCase();

  // Fonts & images — cache-first (immutable between deploys)
  const isCacheFirst = ['ttf','woff','woff2','otf','png','jpg','jpeg','webp','svg','ico'].includes(ext);

  if (isCacheFirst) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) {
          const c = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, c)).catch(() => {});
        }
        return res;
      }).catch(() => {}))
    );
  } else {
    // HTML, CSS, JS, manifest — network-first so hard refresh always gets fresh code
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const c = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, c)).catch(() => {});
        }
        return res;
      }).catch(() =>
        caches.match(e.request).then(hit => hit || caches.match('./index.html'))
      )
    );
  }
});
