# Dame de Pique

Custom online multiplayer Hearts variant. Node.js/Express/Socket.io backend
+ single-file HTML/CSS/JS frontend. Deployed on Railway, auto-deploys on
push to the connected branch.

## Current status / pick up here
Everything below is shipped and deployed (pushed to `main`, which
auto-deploys to Railway). Landscape table mode has been through several
rounds of on-device iteration on a OnePlus 13R and is being tuned
against real screenshots — the vertical budget is the fragile part, so
re-check that the whole pass/play screen still fits one viewport without
scrolling after touching any landscape sizing.

## Files
- `server.js` — game engine, socket handlers, AI, auth endpoints
- `db.js` — Postgres layer (accounts, sessions, stats). Only active if
  `DATABASE_URL` is set; the app degrades gracefully to guest-only play
  without it — never assume a DB is present without checking.
- `public/index.html` — entire frontend in one file (inline `<style>` +
  `<script>`, no build step)
- `package.json` — express, socket.io, pg, bcryptjs

## Custom ruleset
- +10 per trick won; hearts subtract face value (2♥=-2 .. A♥=-14); Q♠=-26
- A single trick can therefore never score above +10 — that's correct,
  not a bug, if it comes up again
- Shooting the moon (all hearts + Q♠ in one round) replaces that round's
  score entirely: shooter +60, everyone else -20
- 16 rounds; pass cycle Left→Right→Across→Keep (rounds 4/8/12/16 = Keep,
  no passing)
- The opening card of trick 1 each round can't be a heart or Q♠
- Pass selection has a 1-minute timer (`PASS_SELECT_MS`) — any player who
  hasn't chosen by then gets 2 random cards auto-picked (`autoPassRemaining`
  in `server.js`), so the round can't be held hostage by someone AFK
- Advancing past round summary needs every real seat to confirm
  (`G.roundReady`, `confirmRound` socket event) — not just the host — with
  a 20s auto-advance (`ROUND_CONFIRM_MS`) if not everyone confirms.
  AI/empty seats are pre-confirmed. `checkRoundReady` is also invoked from
  `resumeAfterSeatChange` so a seat converting to AI (leave / ranked
  takeover) can't leave the room stuck waiting on a confirmation that will
  never come

## AI (in server.js)
- `heuristicChoose` — fast rule-based policy; also used as the rollout
  policy inside Monte Carlo simulations
- `aiChoose` — the actual live decision. Samples plausible opponent hands
  via `sampleWorld` (respecting proven voids + passing certainty),
  simulates each candidate card to the end of the round, plays whichever
  averages best
- `applyHardRules` — a hard pre-filter run before Monte Carlo (play-time
  only), so these are guaranteed, not just statistically favored: never
  lead hearts>5 unless every lower heart is already played; never lead
  or overtake spades with A/K while Q♠ is still unaccounted for (not
  held, not captured) unless it's the closing card of a trick that
  provably can't contain her; always lead a held A♦/A♣ on trick 1.
  `heuristicChoose`'s leading branch mirrors the same "don't lead
  A♠/K♠ while she's still out there" restriction independently, since
  it's also used as the Monte Carlo rollout policy and as the
  exception-fallback for the live decision — both bypass
  `applyHardRules` entirely
- `aiSelectPass` — its own hard filter, `neverPass`: never pass
  clubs≤J, hearts≤5, or spades≤J (the low/mid spades are the guards
  that let a spade lead be ducked instead of scooping the queen).
  Overridden by `mustPass`: a club or diamond down to a single card is
  forced into the outgoing pass even though it's otherwise protected —
  going fully void in that suit outweighs keeping the one card, since
  every future lead in it becomes a free dump for a heart or Q♠
- Order matters in `heuristicChoose`'s leading branch — the trick-1 ace
  check must come before the spade-hunting ("chase mode") check, or
  chase mode fires first and the ace rule never triggers

## Frontend UI during play/pass (public/index.html)
- No top header bar on the play/pass screens — `tableHTML()` renders two
  round icon buttons stacked in the table's otherwise-empty top-left/
  top-right grid corners (`.corner-lt`/`.corner-rt`, `grid-area: lt`/`rt`
  in `.table`'s `grid-template-areas`), positioned beside the top
  opponent. Left corner: round-count badge (`roundBadgeHTML`) + on the
  pass screen only, a pass-direction letter badge (L/R/O/K via
  `passBadgeHTML`/`PASS_LETTER`); play screen shows a "Trick x/13" line
  instead. Right corner: Rules + Leave, plus (play screen only) the
  last-trick peek button. Built via `cornerActions(leftHTML, rtExtraHTML)`.
- Last-trick peek: server tracks `G.lastTrick = {round, trickNum, winner,
  cards}` set in `resolveTrick`, sent in `publicState`. Client button
  (`#g-lt-btn`) is disabled unless `G.lastTrick.round === G.round`;
  press-and-hold shows `#g-lasttrick` overlay (`lastTrickHTML`), release
  hides it — no toggle, must stay held.
- Dealer indicator: not text, a physical poker-style "D" button
  (`.dealer-badge`, white bg/black ring) absolutely positioned on the
  bottom-right of whichever seat's avatar is currently dealing (incl. own
  `mystrip` avatar). Every avatar always renders one; only the current
  dealer's gets the `.on` class, so switching dealers is a cross-fade,
  not text changing.
- Opponent seat score shows tricks won this round (`p.tricksWon`, sent
  live) plus total score frozen at `G.roundBefore[i]` — deliberately NOT
  live `p.score`, so it only changes between hands, not after every
  trick.
- Card selection (pass screen, 2-card picker) and card play (play
  screen) both support hold-and-slide: press a card, drag across the fan
  without lifting, each card crossed gets toggled/becomes the live pick;
  release plays it (play screen) or leaves it selected (pass screen).
  Hit-testing is by nearest-card-CENTER (`nearestTapCard`), not
  `elementFromPoint` — cards overlap 55-65%, and whichever card is
  stacked on top (highest z-index, rightmost) claims almost its entire
  covered neighbor's hit area under point-based testing, which made
  swipes skip cards outright (confirmed empirically: 4 of 13 cards were
  completely unreachable near the top of the fan). Nearest-center gives
  every card an equal-width slot regardless of stacking. Don't revert to
  `elementFromPoint` here even for "simpler code" — it reintroduces the
  skip bug.
  `nearestTapCard` is used on the **initial press as well as** the
  swipe, on both orientations. It used to be swipe-only, with
  `pointerdown` demanding a direct hit via `event.target.closest`, which
  left dead zones everywhere: the gaps between landscape cards, the
  hand's own padding, the strip either side of the outermost cards, and
  — worst — any *illegal* card, which swallowed the press entirely even
  with a legal card right beside it. Because only `.card.tap` is
  considered, illegal cards are now transparently skipped instead.
  A useful side effect: nearest-centre stays usable even if the row
  overflows its container, since a card is reachable as long as any part
  of its centre-slot is on screen. That's a safety net for the `38px`
  floor in `--cw`, which is the one case the width formula can't
  guarantee.
- The landscape drag-to-play `pointermove` is bound to **`window`**, not
  `#g-hand`. The gesture's whole purpose is to pull a card up to the
  table centre, which leaves the hand's box almost immediately — bound
  to `#g-hand` the card froze the moment the finger crossed the row's
  edge. It presented as a rendering glitch rather than a broken drag,
  because the drop test reads `pointerup`, which was already on
  `window`.
- Fan card size/overlap (`--cw`/`--overlap`) is tuned per breakpoint
  against real measured available width, not guessed — see the width
  media queries near the top of `<style>`. 400-580px-wide phones are the
  tightest horizontal fit of all (single-digit px slack), which is why
  `--cw` itself drops slightly there instead of just relaxing overlap
  like the narrower tiers do. A separate `@media (max-height:760px)`
  tier (plus a combined narrow+short tier for very old/small phones)
  shrinks `--cw` and tightens section gaps further so the whole
  play/pass screen fits one viewport without scrolling on short phones
  — verified against real rendered heights at 320/340/360/375/390/
  414/428px width × 568/667/736/740/844/926px height combos. Don't tweak
  any of this without re-measuring — margins are single-digit px in
  several places and it's easy to silently reintroduce overflow.
- Any layout depending on `.mystrip`/badge/button text length changing
  (e.g. "your turn") must reserve constant space (`visibility` toggle,
  not `display`/conditional markup) — a past bug had the strip resize
  and jump the whole screen on turn changes.
- `show(id)` adds the new screen's `.active` class before removing the
  previous screen's, specifically so there's never a synchronous window
  where every `.screen` is `display:none` at once (which would flash the
  near-black felt background underneath) — keep that order if this
  function is ever touched.
- Moon-shot celebration (`showMoonFx`, fires on the **play** screen, not
  round-summary): triggered by a dedicated one-shot `moonShot` socket
  event emitted the instant `checkMoon` succeeds in `resolveTrick`
  (server-side — moon is locked in as soon as one player holds all 13
  hearts + Q♠, which can happen before trick 13, so remaining tricks are
  skipped entirely once detected). Since the event itself is genuinely
  one-shot, the client needs no round/phase guard, unlike the
  pass-transition fx pattern it otherwise resembles. Rocket launches
  from the shooting player's actual seat position via `seatOf()`.
  Purely decorative/emoji-based (🌕/🚀), no new image assets.
- Landscape mode exists on the main menu and the pass/play ("table")
  screens — lobby, draw, round-summary and final are portrait-only by
  design, not yet-todo. `LANDSCAPE_SCREENS` is the whole gate.
- **Landscape main menu** is a pure CSS reflow of the portrait markup —
  no DOM change. `.menu-wrap` becomes a two-column grid: an identity
  rail (crest / title / tagline, with the How-to-play, Sound and Install
  utilities at its foot) and the five tiles in column 2, Casual Play
  spanning as a hero above a 2×2. Three things there are load-bearing:
  - The tagline's grid row is the `1fr` one. That's what pushes the
    utility group to the bottom of the rail — an `auto` margin can't,
    because on a grid item auto margins only absorb space inside that
    item's own area and don't move siblings.
  - `.exit-row`'s `margin-top` needs `!important`: the menu markup
    carries an inline `style="margin-top:22px"`, which no normal
    stylesheet rule can beat, and this layout is deliberately CSS-only.
  - `.menu-wrap` uses `height:100%` and plain padding, **not** `100dvh`
    plus `env(safe-area-inset-*)`. `html.landscape-mode #app` already
    applies both; re-adding them double-counts the notch and overflows
    by exactly that amount.
  `#install` gets a margin override but deliberately **not** `display` —
  it's `display:none` by default and revealed by `showInstall()` only
  when the app isn't already installed, so forcing it visible would
  advertise "Install as an app" inside the installed PWA.
- `#s-menu` starts with `class="active"` and `currentScreenId` already
  defaults to `'menu'`, so `show()` never runs for the first screen —
  hence the one-time `updateLandscapeMode()` call right after that
  function is defined. Without it, a phone already held in landscape at
  first paint gets the portrait menu until it's rotated away and back.
- `rerenderTableScreen()` guards on `currentScreenId` being `pass`/`play`,
  not just on `S` existing. Every `render*` it calls invokes `show()`, so
  without that guard a rotation while a game exists but the player is
  sitting on the (now landscape-capable) menu would navigate them into
  the game unasked.
- Landscape is driven purely by **real physical rotation** —
  `isLandscapeModeActive()` is just
  `matchMedia('(orientation:landscape)').matches`, and
  `updateLandscapeMode()` puts `html.landscape-mode` on only when that's
  true *and* the current screen is pass/play. It's a class rather than a
  plain `@media` query solely because of that per-screen gating.
  `manifest.json`'s `orientation` is `"any"` (was hard-locked
  `"portrait"`) and `applyOrientationLock()` in `show()` does a
  best-effort `screen.orientation.lock('portrait')`/`.unlock()` per
  screen, so non-table screens stay portrait.
- An earlier version added a manual `⟳` toggle (`toggleManualLandscape`,
  `localStorage` key `ddp.forceLandscape`) plus an `html.force-rotate`
  CSS trick that rotated `<body>` itself 90°, because rotation was
  believed unreliable on installed PWAs. **Both are deleted** — rotation
  works on the target device. `screenDeltaToLocal()` went with them,
  since it existed only to invert that CSS rotation for drag math. Don't
  reintroduce the `<body>` rotation without also restoring that pointer
  conversion: a `translate()` on a descendant of a rotated ancestor
  moves along the rotated local axes while pointer events report true
  screen coordinates, so drags track sideways without it.
- **Landscape card size is solved, not guessed.** Width is the binding
  constraint and drives everything:
  - `--cw` = `(100vw − safe-area-inset-left − safe-area-inset-right −
    60px − 15·--gap)/13` — thirteen cards plus 15 gaps (12 between
    cards, 3 extra between the four suit groups) must fit one row; the
    60 is `#app` + `.hand` padding plus a 24px breathing margin so the
    row isn't edge-to-edge. **13 cards across ~900px is a hard wall** —
    each card can be ~60px wide and no more. That's the answer if bigger
    cards get asked for again; the only way past it is letting hand
    cards overlap, which was deliberately removed.
    **The `env(safe-area-inset-*)` terms are load-bearing, not
    decoration.** `#app`'s landscape padding is `env(...) + 8px`, and in
    landscape the camera cutout moves to a *side* (~45px on a OnePlus
    13R). Omitting them sized the row against ~45px of room that doesn't
    exist; `.hand` is `justify-content:center` with `overflow:visible`,
    so half the excess spilled off the left edge under the cutout,
    untappable. That was a real reported bug ("can't select the leftmost
    cards, worst with 13 in hand"). The vertical formula has the same
    terms for the same reason (bottom gesture bar).
    The arithmetic now closes exactly: row width works out to
    `100vw − insets − 60` against an available `100vw − insets − 36`,
    i.e. 24px of slack, 12px per side. If you change `#app` or `.hand`
    padding, that identity is what you're keeping true.
  - `--ch` = `min(1.4·--cw, (100vh - 76px - --cw)/3)` — 1.4 is the real
    proportion of a physical playing card and is what normally applies;
    the second term is a safety valve for short viewports. The column
    stacks three card-*heights* and one card-*width* (trick cross top
    and bottom rows, your hand, and the middle row — only a card-width
    tall thanks to the rotated side cards, below). The 76 is the fixed
    furniture between them (`#app` padding 8, `.hand` padding 8, table
    padding 12, three name-caption rows ~45; the mid's row gap is 0 by
    design). Both table screens use the same figure — the pass screen's
    confirm button and countdown are in the right-hand stack, not below
    the hand.
  **If you change any of that furniture, change the constant.** The
  screens are `overflow:hidden`, so getting it wrong doesn't scroll —
  the trick cross silently overflows the table and is clipped.
  Both custom properties must be declared explicitly, because a custom
  property's `var()` references resolve where the property is *declared*
  — overriding only `--cw` would silently leave `--ch` at its portrait
  value. This bit us once already.
- **The left and right players' played cards are rotated 90° to face
  them** (`.card-turn`, `ccw`/`cw`). This isn't only decorative: it
  makes the trick cross's middle row a card-*width* tall instead of a
  card-height, and that saving is exactly what buys the cards their
  realistic 1.4 proportion. A rotated element still occupies its
  *unrotated* box, so `.card-turn` is a wrapper carrying the swapped
  `width:var(--ch);height:var(--cw)` with the card absolutely centred
  and turned inside it — rotating the card in place would not reclaim
  any height. All four slots caption underneath their card, and the
  mid's row-gap is `0` so the top and bottom cards close right up to the
  side players' row without crossing into it.
- **The pass screen's confirm button and auto-pass countdown
  (`#p-go`/`#p-auto`) are physically MOVED into `.rt-stack` in
  landscape**, under the status note, by `relocatePassChrome()`. Moving
  the nodes rather than duplicating them keeps `updatePassButton()` and
  the countdown timer working untouched. The catch: their landscape home
  is inside `#p-table`, whose `innerHTML` is rebuilt every render — so
  `parkPassChrome()` **must** run *before* that rebuild (it does, at the
  top of both `renderPass` and `renderPassReveal`) or the two elements
  are destroyed with it and never return. Parking is also what restores
  the portrait layout, since they're the last two children of `#s-pass`
  in that order. Portrait's `visibility:hidden` on `#p-go` reserves
  space to stop layout jump; in the stack that just leaves a gap, so
  `relocatePassChrome` collapses it with `display:none` there.
- The landscape table is a different structure, not just restyled:
  `tableHTML()` branches on `isLandscapeModeActive()` and drops the seat
  blocks ringing the table entirely, rendering each player's name/score
  as a `.tcap` caption directly under the trick slot they play into —
  including your own, which is why `.mystrip` is hidden in landscape.
  Opponents' face-down fans are dropped too. Everything else in the
  landscape table is absolutely positioned against `.table`, which
  stretches to fill the screen: home button top-left, and `.rt-stack`
  top-right holding the round/trick + rules + last-trick panel with the
  status-text block directly beneath it.
- **Both the `.banner` and `.prompt` lines below the table are
  `display:none` in landscape** — two rows of height the cards now use
  instead. All of that text (whose turn, what to pass, what you
  received, who won the trick) collects in one `.tbl-note` block inside
  `.rt-stack`; sharing that wrapper with the info panel is what lets it
  sit under the panel without hard-coding the panel's height.
  `tableHTML()` renders it empty and
  `syncLandscapeNote(tableId, promptId, bannerId)` copies the (still
  written, just hidden) elements into it at the END of each render.
  That direction matters: every render branch sets its prompt *after*
  building the table, so threading the text through `tableHTML` would
  mean restructuring all of them. It no-ops in portrait, where
  `.tbl-note` isn't rendered, and hides itself when there's no text at
  all rather than leaving an empty bordered box.
- The landscape hand is a flat row, not a fan: `.card-slot`'s inline
  rotation/lift transform is overridden to `none` and `--overlap` flips
  from a large negative value to a small positive `--gap`, so cards sit
  side by side and don't overlap at all. `--gap` is deliberately tiny —
  it's width the cards themselves could use, and the `--cw` formula
  subtracts exactly these gaps.
- Because rotating the phone doesn't itself produce a new `gameState`
  broadcast, both the `matchMedia` change listener and a debounced
  `resize` listener call `rerenderTableScreen()`. The matchMedia one
  re-renders *immediately* rather than waiting for the debounce, since
  the markup (not just the styling) differs per orientation and the gap
  would briefly show portrait markup under landscape CSS.
- Landscape play uses a different card-play gesture entirely: drag the
  card to the table center (`isLandscapePlay()`/`startCardDrag()` etc.)
  instead of portrait's hold-and-slide-then-release
  (`playPicking`/`setPlayPick`). Drop within `.mid`'s bounding box (+30px
  padding) plays the card; anywhere else snaps it back via a CSS
  transition and cancels. These share the same `pointerup`/
  `pointercancel` window listeners (`releasePlayPick`/`cancelPlayPick`),
  which branch on whether `dragEl` is set — keep that branch first if
  either function is touched, or drags will fall through into the
  portrait release logic. The dragged card's z-index boost has to be
  applied to its **parent** `.card-slot` (`.card-slot:has(.card.dragging)`),
  not just the card itself — every `.card-slot` gets its own inline
  `transform` from `handHTML()` for the fan rotation, and `transform`
  on an element creates a new stacking context, so a z-index set only on
  the inner `.card` is invisible to sibling slots outside that
  context — same reason the pre-existing `.tap:active`/`.sel` z-index
  boosts already use the same `:has()` pattern on the parent slot.

## Table themes (Bordeaux / Émeraude / Clair)
- Three swappable palettes, picked in **My Account** (`#s-personal`),
  persisted to `localStorage` as `ddp.tableTheme` (same convention as
  `ddp.sfxMuted`). Bordeaux is the default and lives on `:root` directly
  — there is deliberately no `[data-theme="bordeaux"]` selector, so
  "attribute absent" and "bordeaux" are the same state, not two.
- **Two-layer token system, and this is the important part.** The
  `--ddp-*` block at the top of `<style>` is the *only* place a felt /
  card / ink / suit colour is written literally. Immediately below it a
  second `:root` block re-defines the pre-existing names the rest of the
  stylesheet already used (`--felt-0/1/2`, `--gold*`, `--cream`,
  `--muted`, `--faint`, `--line`, `--card-face`, `--card-edge`, `--red`,
  `--ink`) as `var(--ddp-…)`. That derived layer is what made the whole
  UI theme-aware without touching hundreds of rules. **Add new colours
  as `--ddp-*` tokens; don't hardcode hex in rules.**
- That second `:root` block must stay *after* the `[data-theme]` blocks
  in source order, and must not itself declare any `--ddp-*` — both
  selectors match `<html>` at equal specificity, so source order decides.
- `--ddp-*-rgb` companions exist because much of the UI is translucent
  washes (`rgba(...,.32)` borders, glows, scrims) and those can't take a
  hex token — they take `rgba(var(--ddp-x-rgb),alpha)`.
  `--ddp-scrim-rgb`/`--ddp-gloss-rgb` are the "push back"/"lift forward"
  colours; Clair flips the scrim to its warm ink so shading on a light
  felt reads as a soft shadow instead of grey sludge.
- **Clair is the theme that breaks things.** Anything picked as pale
  text on a dark wash becomes pale-on-pale there. The status accents
  (`--ddp-pos/neg/ai/mine`) are themed for exactly this reason, and a
  `[data-theme="clair"]` correction block at the very END of the
  stylesheet re-grounds the rank tags, `.note.bad` and `.btn.danger` on
  the ink. That block is last **on purpose** — it ties on specificity
  with what it overrides (`[data-theme="clair"] .tag` vs `.tag.you` are
  both 0,2,0), so moving it up with the other theme definitions would
  silently stop it working. Test any new pale-on-dark accent against
  Clair.
- An inline `<script>` in `<head>` sets `data-theme` before first paint;
  without it, anyone on Émeraude or Clair sees a flash of Bordeaux felt
  because the main script is at the end of `<body>` (same reasoning as
  the `show()` anti-flash ordering). `initTableTheme()` still runs later
  in the boot IIFE to mark the active swatch and sync the `theme-color`
  meta, which needs the menu markup to exist.
- Card backs (blue) and `--ok`/`--warn` are intentionally left
  un-themed: they're identity/semantic colours, not felt or card-face.
- `--ddp-heart` is **identical in all three themes** and that's correct,
  not an oversight. It only ever renders on a card face (suit glyphs,
  the penalty-card tint), and the card faces are near-identical across
  themes, so there's nothing for it to adapt to. It's deliberately
  desaturated (`#8C2233`) so it doesn't compete with the brass.

## Numeric readouts use tabular figures — this is functional
- Scores, MMR, timers, trick counters and the round badge render in
  `--font-num` (IBM Plex Mono) with `font-variant-numeric:tabular-nums`.
  The point isn't the look: tabular figures force every digit to the
  same advance width, so a score ticking `9`→`10` or a countdown
  `10`→`9` can't change an element's width and shove the layout
  sideways. It's the type-level counterpart to the existing "reserve
  constant space" rule under Frontend UI — that one stops text *length*
  moving things, this stops digit *shape* doing it. Don't drop it back
  to a proportional face.
- The rule block sits late in the stylesheet **on purpose**: most of
  those elements already declare `'Playfair Display'` at equal
  specificity, so source order is what decides. Moving it up silently
  reverts the whole thing.
- Suit glyphs, card ranks, the dealer `D` and the pass-direction letter
  badge stay on Playfair — they're card artwork and letters, not
  readouts. `.tb-badge.pass` keeps its own font/size at higher
  specificity for exactly this reason.
- `.tb-badge`'s font-size drops to `.5rem` because Plex Mono is wider
  than DM Sans and the badge has to fit `16/16` inside a 32px token.

## `public/sw.js` caches `manifest.json` cache-first — bump `CACHE` on ANY manifest change
- `ASSETS` includes `/manifest.json`, and the fetch handler is cache-first
  for everything except page navigations (`e.request.mode==='navigate'`,
  which is always network-first so `index.html` itself updates
  immediately). A `manifest.json`-only edit does **not** change `sw.js`'s
  own bytes, so the browser never detects the service worker as updated,
  never re-runs `install`, and keeps serving the **old** cached manifest
  indefinitely — this bit us for real: the `orientation` unlock
  (`portrait`→`any`) silently didn't reach an already-installed PWA
  because of exactly this. Bump the `CACHE` version string in `sw.js`
  itself whenever `manifest.json` (or any other `ASSETS` entry) changes,
  or the update never propagates
- Even with the cache fixed, Android bakes the manifest's `orientation`
  into the installed app's WebAPK wrapper at **install time**. Chrome
  does check for manifest updates periodically in the background, but
  it's not immediate/forceable — a user who already has the app
  installed will very likely need to uninstall and reinstall
  (Add to Home Screen again) to actually pick up an orientation change,
  not just reload/relaunch it

## Accounts & stats (needs DATABASE_URL — Railway Postgres plugin)
- Username/password, bcrypt-hashed, session tokens
- Casual and ranked stats are two entirely separate tables/pipelines —
  `stats` (casual only) vs `ranked_stats` (ranked only). Every stat write
  site in `server.js` (`resolveTrick`, `endRound`, `recordGameFinishedForAll`,
  `formRankedMatch`) branches on `G.ranked` to call the casual or ranked
  `db.js` function, never both. Casual: games played/finished, best/worst
  single trick, best/worst round, best/worst game, total moons shot, most
  moons in one game, win streak. Ranked: games played, average score,
  worst single trick only (no "best trick" tracked for ranked), best/worst
  round, best/worst game, moons, Q♠ takes, ended positive/negative, plus
  `mmr_highest`/`mmr_lowest` (peak/trough MMR ever reached, updated
  alongside `mmr` itself in `applyRankedMmr`) — no win streak, deliberately
  narrower than casual, matches what was actually asked for
- `trackStat()` retries 3x with backoff on failure — this fixed a real
  production data-loss bug (silent dropped writes to Railway's DB), keep
  it

## Ranked Multiplayer (needs DATABASE_URL, same as accounts/stats)
- Hidden `mmr` (starts 1000) + `placement_games_played` (first 5 ranked
  games) live in `ranked_stats`, not `stats` — `stats.mmr`/
  `stats.placement_games_played` are legacy columns from before ranked had
  its own table, left in place unused rather than dropped, and
  one-time-backfilled into `ranked_stats` on schema init (`ensureSchema`)
  so any MMR already earned under the old combined scheme isn't lost.
  Visible rank is always derived from `mmr` via `rankForMmr`/`RANK_TABLE`
  in `server.js` — never stored separately, never computed client-side
  (the client only renders whatever `tier`/`division`/`label` the server
  sends, e.g. in `rankedProfileOk`/`rankedResult`/`leaderboardOk`)
- `computeMmrChanges` is intentionally isolated (pure, single function) so
  the formula can later become Elo-style
  (`K × (normalizedScore - expectedPerformance)`) without touching
  matchmaking, storage, or the client
- Matchmaking is an in-memory `rankedQueue` array + a 2s `setInterval`
  tick (`server.js`) — expanding-radius, sorted-by-mmr sliding window.
  Lost on server restart/redeploy, same as in-progress casual rooms
  already are; no persistence attempted
- Ranked rooms reuse the normal `rooms`/`G` object with `G.ranked = true`
  rather than a separate game-state system — this is why `setAI` and
  code-based `joinRoom` are hard-rejected when `G.ranked`, and why
  `leaveRoom` has a ranked-specific branch
- Ranked never uses AI seats, but a disconnected (or explicitly left)
  ranked player gets a 15s grace period (`RANKED_RECONNECT_MS`,
  `scheduleRankedTakeover`/`clearRankedTakeover`) before their seat is
  handed to the computer so the other three aren't stuck — `rejoin` flips
  `isAI` back to `false` and cancels the timer if they come back. This is
  different from casual play, where an explicit "leave" mid-game converts
  the seat to AI immediately, permanently
- Rank badge art lives in `public/badges/*.svg` (22 files: `bronze-1`
  through `grandmaster-3`, plus `legend`), sourced from a Rocket-League-
  style badge pack whose file names (`champion_*`, `grand_champion_*`,
  `supersonic_legend`) don't match this game's tier names (`master`,
  `grandmaster`, `legend`) — already renamed on disk, but keep that
  mapping in mind if new badge assets are ever dropped in

## Not implemented
- Password reset (no email service configured)

## Sound effects (public/sfx.js + public/sounds/*.ogg)
- Self-contained module, own global `SFX` object (`SFX.play(name)`,
  `.setMuted()`, `.unlock()`, `.loadCardSounds()`) — loaded via its own
  `<script src="/sfx.js">` tag before the main inline script in
  `index.html`. Card-handling sounds (deal/place/pass/fan/shuffle) are real
  samples (Kenney Casino Audio, CC0); everything else (trick win/lose,
  penalty, confirm, your-turn, seating draw, game win/lose, moon fanfare)
  is synthesized live via Web Audio, no extra files needed
- Web Audio requires a user gesture before it'll actually play — `SFX.play`
  calls before the first tap are silently no-ops if the context is still
  suspended; unlocked via a one-time `pointerdown` listener in `index.html`
- All state-driven cues (fresh deal, trick outcome, your-turn) are wired
  through `handleSfxForState(G)` in the `gameState` router — every tracker
  in there uses a `null` sentinel meaning "not yet observed this session,"
  seeded silently on the first `gameState` after a page load/reconnect so
  rejoining mid-game doesn't replay a deal/trick sound for something that
  already happened before this tab connected. Follow that same pattern for
  any new state-diffed cue rather than assuming round/trick 1
- Mute toggle (`#sfx-toggle` in the main menu) persists to `localStorage`
  (`ddp.sfxMuted`) — `SFX.setMuted()` short-circuits `play()` entirely, so
  muted-then-unmuted still works without reloading anything

## Solo-vs-AI casual rooms never expire on a timer
- A casual room where exactly one seat isn't AI (`server.js`'s room-cleanup
  `setInterval`, near the bottom) is exempt from both `EMPTY_CLOSE_MS` and
  `IDLE_CLOSE_MS` — that player can be disconnected/logged off for any
  length of time and `rejoin` (localStorage session token, no expiry) will
  always work. The only way that room closes is the explicit "Leave"
  button, which already closes it via the existing
  `!G.players.some(p => p.token && !p.isAI)` check in `leaveRoom`. Ranked
  is excluded from this (`!G.ranked` guard) since it never has AI seats to
  begin with, and a stalled ranked game already has its own 15s
  disconnect→AI-takeover mechanism instead
- Caveat that doesn't have a fix without persisting `rooms` to the DB (out
  of scope so far): all room state is in-memory only, so a server
  restart/redeploy — which happens on every push to `main`, since this
  auto-deploys — wipes even a solo-vs-AI game in progress. "Never expires"
  only holds within one server process's uptime, not across deploys

## Testing convention
- Copy `server.js` → `server.test.js`, sed the AI/round `setTimeout`
  delays down to ~5ms for fast local iteration; delete before shipping
- Test `db.js` against a real local Postgres instance, not a mock
  (`apt-get install postgresql` works fine in a sandboxed environment)
- Frontend logic: load `index.html` in jsdom, extract the inline
  `<script>`, and `eval` it — but it starts with `"use strict"`, which
  gives `eval` its own scope, so nothing attaches to `window` by
  default. Append an explicit `window.__t = { ... }` export block to the
  same eval'd string to expose what needs testing
- Delete all test files and `node_modules` before considering a change
  finished
