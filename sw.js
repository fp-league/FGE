const CACHE = 'fge-v6';
const STATIC = [
  './styles.css', './app.js', './manifest.json', './porsche.png',
  './911porschav3.ttf', './911porschav3bold.ttf', './911porschav3cond.ttf', './911porschav3title.ttf'
];

// Pre-cache static assets on install (fonts, CSS, JS)
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).catch(() => {})
  );
  self.skipWaiting();
});

// Clean up old caches on activate
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

  const url = new URL(e.request.url);
  const isHTML = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/FGE') || url.pathname.endsWith('/FGE/');

  if (isHTML) {
    // Network-first for HTML — always get the latest page, fall back to cache
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const c = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, c)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
  } else {
    // Cache-first for assets (CSS, JS, fonts, images)
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) {
          const c = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, c)).catch(() => {});
        }
        return res;
      }).catch(() => {}))
    );
  }
});
