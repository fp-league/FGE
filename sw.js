const CACHE = 'fge-v1';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './logo.png',
  './911porschav3.ttf', './911porschav3bold.ttf', './911porschav3cond.ttf', './911porschav3title.ttf'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('jsonbin.io')) return;
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok) { const c = res.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)).catch(()=>{}); }
    return res;
  }).catch(() => caches.match('./index.html'))));
});
