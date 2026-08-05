# Portrait reference

`index-portrait-reference.html` is a verbatim copy of `public/index.html`
as it stood at commit `0f0c5da` — the last state in which the app was
usable **in portrait**, before it was locked to landscape.

Kept because the portrait design is real work that shouldn't have to be
reconstructed from memory: the per-breakpoint `--cw`/`--overlap` tuning,
the short-phone `@media (max-height:760px)` tier, the fanned hand with
its negative overlap, and the seat blocks ringing the table are all
portrait-specific and were measured against real devices rather than
guessed.

## What "landscape only" actually changed

The portrait CSS was **not deleted** — it is still the base layer that
the `html.landscape-mode` rules override, and it still renders if an
orientation lock silently fails (a plain browser tab, iOS, or an OS-level
rotation lock). What changed is that the app now *asks* to be landscape
everywhere:

- `manifest.json` → `"orientation": "landscape"`
- `applyOrientationLock()` locks landscape on every screen instead of
  unlocking for table screens and locking portrait elsewhere

So this file is a reference for the portrait *experience* and its
tuning, not a store of CSS that has otherwise been lost.

## Note

This is belt-and-braces. Git already holds the full history, so the same
content is available with:

```bash
git show 0f0c5da:public/index.html
```

Nothing serves this directory — it is deliberately outside `public/`, so
Express won't expose it and the service worker won't cache it.
