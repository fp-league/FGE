const CACHE = 'fge-v11';

// Pre-cache only what every visit uses at every screen size.
//
// This used to list the full-size car and logos. Now that those are served
// through srcset, a phone never loads them — so pre-caching the originals
// downloaded about 94 KB on first visit that the page then ignored, which
// is the exact opposite of the point. The fetch handler below is already
// cache-first for images, so whichever variant a device actually picks is
// cached the first time it is used. Only the nav logo, which is the same
// 2 KB file on every device, is worth fetching up front.
const IMMUTABLE = ['./fge-logo-sm.webp'];

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
