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
// v11: the eight table backgrounds were replaced wholesale. Seven landed
// on NEW filenames (moulin_rouge/holiday/victorian_room/noir_casino/
// moon_balcony/conservatory/theater .webp), which need no bump — a new
// URL was never cached. But `observatory.webp` KEPT its filename with new
// bytes, which is exactly the v8 trap again: cache-first with no
// revalidation means a returning player who ever loaded the old
// Observatory would keep serving it forever and never even request the
// new one. One in-place overwrite is enough to require the bump.
// v12: same trap again — all 52 public/cardfronts/noir/*.webp files were
// re-cropped in place, same filenames. The original crop measured the
// card art's own true silhouette accurately (~0.46 aspect), but that's
// narrower than the app's 5:7 card box, so object-fit:cover scaled it up
// to fill the box's width and cropped the excess off the top and bottom
// — reported as "too zoomed in". Fixed at the source instead of in CSS:
// each card is now padded to the box's own 5:7 ratio (matching Bold's
// 500x700) before final resize, so cover no longer needs to crop
// anything. Any returning player who'd already loaded a Noir card face
// needs this bump or keeps seeing the old cropped bytes forever.
// v13: the v12 padding fix traded the top/bottom crop for visible white
// bars down both sides instead — correct proportions, but not what was
// wanted. Re-exported once more: same tight per-card crop, but stretched
// (non-uniform scale) directly to 500x700 instead of padded, on request
// — full-bleed like Bold Deck, at the cost of a slight, barely-visible
// horizontal stretch to the art. Same in-place-overwrite trap, same bump.
const CACHE = 'ddp-v13';
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
