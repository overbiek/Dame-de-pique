// Bumped for the manifest going orientation:landscape (and its colours
// moving to the Bordeaux theme). manifest.json is cached cache-first and
// editing it does NOT change this file's own bytes, so without a bump
// here the browser never sees the service worker as updated and keeps
// serving the OLD manifest forever. This has bitten us before.
// v6: added the Marquee brand splash art to ASSETS. Any ASSETS change
// needs this string bumped or the browser never re-runs install() and
// keeps serving the old cache — same trap as the manifest note above.
const CACHE = 'ddp-v6';
const ASSETS = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
                '/brand/marquee-logo.webp', '/brand/marquee-splash-portrait.webp'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never touch the realtime connection
  if (url.pathname.startsWith('/socket.io')) return;
  if (e.request.method !== 'GET') return;

  // Page loads: always try the network so updates land immediately
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }

  // Everything else: cache first, fall back to network
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(res => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
    )
  );
});
