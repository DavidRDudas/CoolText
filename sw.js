/* CoolText service worker — cache-first so the app works offline.
   Bump the version when shipping changes to any cached asset. */

const CACHE = 'cooltext-v1';
const ASSETS = [
  '.',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  'vendor/mammoth.browser.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached ||
      fetch(e.request).then((res) => {
        // Runtime-cache successful same-origin responses (and font files).
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() =>
        e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()
      )
    )
  );
});
