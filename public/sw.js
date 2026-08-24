// Bumped for the manifest going orientation:landscape (and its colours
// moving to the Bordeaux theme). manifest.json is cached cache-first and
// editing it does NOT change this file's own bytes, so without a bump
// here the browser never sees the service worker as updated and keeps
// serving the OLD manifest forever. This has bitten us before.
// v6: added the Marquee brand splash art to ASSETS. Any ASSETS change
// needs this string bumped or the browser never re-runs install() and
// keeps serving the old cache — same trap as the manifest note above.
// v7: manifest display standalone -> fullscreen (and background_color to
// the Marquee splash edge). Bumping is what makes the new manifest reach
// an already-installed copy at all — see the note above.
// v8: the SAME trap, but for a runtime-cached (not ASSETS-listed) file —
// the "keep the ring" avatar re-crops overwrote charmer.webp etc. in
// place under their EXISTING filenames. The fetch handler below is
// cache-first with no revalidation, so any browser that had already
// loaded the old bytes under that exact URL just kept serving them
// forever; the new file on the server was never even requested. Bumping
// CACHE deletes the whole old cache namespace (activate handler, below),
// which is what actually forces a re-fetch — editing the image files
// alone changes nothing this service worker will notice. Any future
// in-place overwrite of a runtime-cached asset (avatars, scenes, card
// fronts, rank art) needs the same bump, not just an ASSETS change.
// v9: recropped the four Clean Sheet crest tiers in place.
// v10: replaced the app icons (icon-192/512, icon-maskable-512,
// apple-touch-icon) in place — the OLD two-card artwork was still what
// Android's native launch splash and the installed icon showed, flashing
// briefly before the JS-driven #splash overlay (the NEW Marquee card
// mark) took over, i.e. two different pictures back to back on startup.
// Same in-place-overwrite trap as v8: bumping is what actually forces a
// re-fetch of the new bytes under those existing filenames.
const CACHE = 'ddp-v10';
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
