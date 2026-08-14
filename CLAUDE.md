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
The tutorial (see its own section below) is implemented but has **never
been run** — it was built without any way to execute JS in this
environment, verified by exhaustive static tracing (every function
reference cross-checked against a definition, every `tutAwaiting`
contract checked against `tutorialCommitPlay`'s handling of it, every
`$('tutorial-*')` id checked against the markup, brace/paren balance
checked on the whole file) rather than by running it. Treat the first
real on-device run as the actual first test, not a formality.

**Blitz and Daily Challenge (their own sections below) are in the same
position — implemented, never executed.** No Node runtime was available
in the environment that built them either. What *was* verified
statically: bracket/string/template balance across `server.js`, `db.js`
and both inline `<script>` blocks; every `db.*` call cross-checked
against `db.js`'s exports and every export against a definition; every
`$('id')` in the client cross-checked against the markup; every
`onclick=` handler against a definition. Not verified: any SQL actually
running, and the Daily Challenge's end-to-end flow. **These are the
first things to exercise on device**, and `server.js` is no longer
untouched-by-new-features, so a bad deploy now affects live casual and
ranked games too — worth a local run against a throwaway Postgres
before pushing.

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
- Round count is **per room** (`G.roundsTotal`), not a global constant —
  see the Blitz section. `DEFAULT_ROUNDS` is 16 and every call site that
  doesn't ask for a length gets it. Pass cycle Left→Right→Across→Keep
  (rounds 4/8/12/16 = Keep, no passing, in a 16-round game)
- The opening card of trick 1 each round can't be a heart or Q♠
- `passDir(round)` maps the round number onto that cycle, but the
  direction actually in force is `roundPassDir(G)` — a room can pin one
  (see Daily Challenge). `passTarget`/`passSource` take that direction
  as their second argument, not a round number
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
- **The game is landscape-only.** `manifest.json` is
  `"orientation":"landscape"` and `applyOrientationLock()` requests a
  landscape lock on every screen. Both are best-effort — the lock works
  reliably only in an installed standalone Android Chrome PWA, and
  Android bakes the manifest orientation into the WebAPK at *install*
  time, so an already-installed copy must be reinstalled before it takes
  effect.
- **The portrait CSS is deliberately still there** and is not dead code.
  It's the base layer the `html.landscape-mode` rules override, and it's
  the fallback that renders when the orientation lock silently fails (a
  plain browser tab, iOS, an OS-level rotation lock). That's also why
  `isLandscapeModeActive()` still gates on `matchMedia` rather than
  being forced to `true`: painting a wide, short layout into a tall,
  narrow viewport would clip it into uselessness. A verbatim copy of the
  last portrait-usable build is kept at
  `backup/index-portrait-reference.html` (see that folder's README);
  it's outside `public/` so it is neither served nor cached.
- `applyOrientationLock()` and `updateLandscapeMode()` are both called
  once at startup as well as from `show()` — `show()` never runs for the
  first screen, since `#s-menu` ships `active` and `currentScreenId`
  already defaults to `'menu'`.
- **Every screen has a landscape layout** — `LANDSCAPE_SCREENS` holds
  all of them and is the whole gate. There are three distinct layout
  families, and picking the wrong one for a new screen is the easy
  mistake:
  1. **Table screens** (pass/play) — bespoke, see the `--cw`/`--ch`
     furniture above.
  2. **Rail screens** (casual, ranked, rank, statistics, My Account,
     Daily Challenge) — narrow left rail of header chrome, body in
     column 2. Daily Challenge takes these rules and then overrides the
     column split to 50/50; see its own section.
  3. **Game-flow screens** (lobby, seat draw / dealer cut, round
     summary, final) — a single wide centred column, *opted out* of the
     rail layout. Their content is wide and sequential (a row of drawn
     cards, a per-round score table, four lobby seats, a podium), so a
     narrow rail fights it. Because the shared rail rule has already
     pushed their children into column 2 with an indent and a divider,
     that block has to **reset `padding-left` and `border-left`** — the
     grid properties go inert under `display:block` but those two would
     survive and show up as a stray rule down the middle.
- **The four content screens share ONE landscape layout**, and the rules
  are scoped to `html.landscape-mode .screen.active > .center-wrap`
  rather than an id list. That works because `landscape-mode` is only
  ever on when the *active* screen is in `LANDSCAPE_SCREENS`, so the
  selector can only match those screens — and anything added to the set
  later inherits the layout for free (My Account does exactly this, see
  below, though it also layers its own nested split on top). The menu
  uses `.menu-wrap` and the table screens have no `.center-wrap`, so
  neither is caught.
  The shape: everything defaults into column 2 as a single scrollable
  body panel (`grid-row:1/-1`), and the chrome — `.backlink`,
  `.screen-header`, `h2`, `.tagline`, `.exit-row`, `.note` — is pulled
  back into a narrow left rail. All the body panels can share one grid
  area because they're mutually exclusive: exactly one is ever not
  `display:none`, and a `display:none` element isn't a grid item at all.
  If you ever make two visible at once they'll stack on top of each
  other.
- **My Account (`#s-personal`) is a hero + tabbed hub, not a flat form**
  — a player card (avatar, editable name, login pill, rank medallion)
  beside a Profile/Achievements/Friends tab bar. Its portrait markup
  wraps everything except `.backlink` in one `.acct-layout` div, and
  that single wrapper is the whole reason the shared landscape rule
  above needs no exception for it any more (an earlier version, with a
  flatter portrait markup, did): `.backlink` still lands in the rail via
  the generic chrome selector, and `.acct-layout` — the only *other*
  direct child of `.center-wrap` — already gets column 2, full height,
  scrollable, from the generic "everything else" rule. `#s-personal`'s
  own landscape block only adds what's specific to it: making
  `.acct-layout` itself a nested grid (hero rail | tab bar + panel), and
  `position:sticky` on `.profile-hero` so it stays put while the panel
  scrolls under it. The sticky works because it resolves against
  `.acct-layout`'s own scroll (set by the generic rule), not the page's.
- **The Profile/Achievements/Friends tabs are `.acct-toptab`/
  `.acct-panel`, deliberately distinct from `.acct-tabs`/`.acct-tab`**,
  which is the *login/signup* pair inside the Profile panel's
  `#acct-form`. Same naming pattern, different job, both live on
  `#s-personal` at once — don't merge them. `switchAccountTab()` toggles
  both class sets in lockstep; `goPersonal()` calls it to reset to
  Profile every time the screen opens, so a stale Achievements/Friends
  tab never lingers behind a return visit.
- **The rank medallion is populated by `renderAccountRank()` off the
  same `rankedProfileOk`/`rankedProfileError` events the Ranked screen
  already listens for** — socket.io supports multiple listeners per
  event, so this doesn't disturb that handler. `goPersonal()` requests
  it (`getRankedProfile`) only when logged in, and drives the medallion
  through three states even before the server answers: guest → "Not
  ranked", logged-in-pending → "Loading…" (the `renderAccountRank(null)`
  call), then the real rank or "Placement n/5" once the response lands.
  The `$('s-personal').classList.contains('active')` guard in the
  listener matters: without it, a response arriving after the player has
  already navigated away would still overwrite the medallion, which
  would then show stale data the next time they open the screen — same
  screen-liveness pattern the Ranked screen's own listener already uses.
- **`.theme-swatch-btn` has two lives, and the card one very nearly
  didn't work.** The bare circular-dot styling (28px circle) is the base
  rule; `.theme-swatch-btn.theme-card` restyles it into a labelled
  preview card for the account hub, without touching the JS or the
  id/data-attribute contract (`applyTableTheme()` toggles `.active` on
  whichever element carries `.theme-swatch-btn`, whatever else it wears).
  It is written with **two classes on purpose**. As originally shipped it
  was a bare `.theme-card`, and there was a second
  `.theme-swatch-row{display:flex;gap:8px}` in the swatch block ~800
  lines further down. Both tied on specificity with the card rules and
  both won on source order, so the entire card redesign was inert — the
  picker rendered as flex-packed 28px circles with the labels clipped off
  by its own `overflow:hidden`. Nobody noticed because it still looked
  like a deliberate row of dots. Fixed by deleting the stale row rule and
  giving the card rules two classes, so neither depends on ordering.
  Same family of trap as the Clair correction block and the
  tabular-figures block — but those two *rely* on source order winning,
  which is exactly why this one lost.
- `.theme-swatch-row` is `repeat(auto-fit,minmax(82px,1fr))`, not a fixed
  column count: four cards sit in one row where there's room and fall to
  3+1 / 2×2 in the narrower landscape account panel. A fifth theme needs
  no layout change.
- `max-width:none` on those wraps needs `!important` — `s-ranked`,
  `s-rank` and `s-stats` each carry an inline `style="max-width:440px"`.
  Same class of trap as the menu's `.exit-row` inline `margin-top`;
  check for inline styles before assuming a landscape override will win.
- `#rank-you-bar` is `position:fixed` to the viewport bottom, so
  `#rank-content` reserves `padding-bottom` for it — otherwise the last
  leaderboard rows sit underneath it.
- `.rt-stack` has a **fixed** `width:min(42vw,240px)`, not min/max. The
  pass and play panels hold different content (a pass-direction letter
  vs a "Trick n/13" line), so sized to content the box visibly changed
  shape between the two screens. `align-items:stretch` then makes
  `.corner-rt`, the status note and the pass button all match it.
- `lastTrickBtnHTML(G, id)` is shared by both table screens so the panel
  holds the same controls on each. On the **pass** screen it always
  renders disabled, and that's correct rather than a bug: a round's
  passing happens before any trick has been played in it, so the stored
  `G.lastTrick` belongs to the *previous* round and fails the
  `lastTrick.round === G.round` guard. That's also what keeps it safe —
  `bindLastTrickButton()` no-ops on a disabled button, and the pass
  screen has no `.lasttrick-ov` overlay to display anything in. If it
  ever needs to actually work there, both of those have to change.
- Body panels are top-aligned in their column, deliberately **not**
  vertically centred. `justify-content:center` / `margin:auto` inside a
  scrollable container makes overflowing content unreachable at the
  start — the same class of bug as the clipped install instructions and
  the off-screen leftmost cards. Don't "improve" the centring.
- **Landscape main menu** is a pure CSS reflow of the portrait markup —
  no DOM change. `.menu-wrap` becomes a two-column grid: an identity
  rail (crest / title / tagline, with the How-to-play, Sound and
  Tutorial utilities at its foot) and the six tiles in column 2 as an
  even **2×3**. There is deliberately no hero span any more: markup
  order (Casual, Daily, Ranked, Rank, Statistics, My Account) is exactly
  the reading order a plain 2-column grid produces, so **auto-placement
  alone** pairs Casual above Ranked and Daily above Rank — no explicit
  `grid-column`/`grid-row` on any tile. Reordering the markup reorders
  the grid; that's the only control.
  Six tiles in the height three used to occupy is tight, which is what
  the landscape tile/icon/type shrink and `display:none` on
  `.tile-arrow` are paying for. Verified non-scrolling down to
  667×375 (the smallest realistic landscape phone). If a seventh tile is
  ever added, re-measure — the budget is genuinely spent.
  Three things there are load-bearing:
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
- **Double-tap a card to play it** — the second way to play, alongside
  the landscape drag below. It only exists in landscape, and that's not
  an oversight: in portrait a single press-and-release already plays the
  card via `releasePlayPick`, so a tap is spoken for. In landscape a tap
  in place previously did nothing at all (the drag just snapped back),
  which is what left the gesture free to mean something.
  Lives inside `endCardDrag`, in the not-dropped branch: a press that
  moved ≤`TAP_SLOP_PX` and lasted ≤`TAP_MAX_MS` counts as a tap, and two
  taps on the **same** card within `DOUBLE_TAP_MS` (320) commit it. Both
  taps having to be the same card is what stops "tap A, tap B" playing B
  while someone is just looking around.
  The first tap rings the card with `.card.tap-armed` — deliberately
  *not* `.sel`, which lifts a card by 1.12 card-heights for the portrait
  picker's preview and reads as a bug when all you did was tap once. The
  arm self-expires on the timer, is cleared by `cancelCardDrag`, and is
  cleared at the top of `renderPlay` so it can't survive the hand's
  innerHTML being rebuilt with a key pointing at a detached element.
  Because `nearestTapCard` only ever returns `.card.tap`, an illegal card
  can't be armed — a tap near one arms the nearest *legal* card instead,
  and the ring is what shows you which. That's the same
  transparently-skip behaviour the press logic already had.
- **Fixed alongside it:** a tap-without-movement in landscape used to
  leave `.dragging` stuck on the card. `endCardDrag`'s snap-back set
  `el.style.transform=''` and waited for `transitionend` to call
  `resetDragStyles` — but a tap never set a transform, so no transition
  ever ran and the event never fired. The card stayed lifted until the
  next `gameState` rebuilt the hand. It now resets directly when there's
  no transform to animate.
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

## Table themes (Bordeaux / Émeraude / Clair / Marquee)
- Four swappable palettes, picked in **My Account** (`#s-personal`),
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
- **Adding a theme means FOUR enumeration points, not one.** `DDP_THEMES`
  (validation in `applyTableTheme`), `DDP_THEME_BG` (the `theme-color`
  meta / Android status-bar tint), the inline anti-flash `<script>` in
  `<head>` (which string-matches theme names — miss it and a first-load
  user on that theme flashes Bordeaux), and a `.theme-swatch-btn
  .theme-card` button in the picker. Missing any one fails quietly.
- **Marquee** is the brand palette from the logo art (deep emerald
  `#020605`/`#071A15`/`#0D2E25` + brass `#C49E58`/`#EED08E`/`#806436`,
  mint `#B0CABE` as `--ddp-muted`). Two deliberate departures from the
  design handoff it came from, both because that brief was written
  against `CLAUDE.md` alone and never saw the stylesheet:
  its `palette.css` used `--ddp-felt-0/1/2`, `--ddp-gold*`, `--ddp-cream`,
  `--ddp-faint`, `--ddp-line` — those are the DERIVED layer's names with
  a `--ddp-` prefix added, and **none of them exist**; only 3 of its 15
  declarations would have done anything. And it proposed
  `--ddp-cream:#EED08E`, i.e. gold; in this codebase that token is
  `--cream`, every line of body copy in the app. Marquee uses a warm
  off-white `#EDE4D2` and puts the emerald character in `--ddp-muted`.
  Needs no Clair-style correction block — it's a dark theme, so the
  status accents carry over from Bordeaux/Émeraude unchanged.
- `--ddp-heart` is **identical in all four themes** and that's correct,
  not an oversight. It only ever renders on a card face (suit glyphs,
  the penalty-card tint), and the card faces are near-identical across
  themes, so there's nothing for it to adapt to. It's deliberately
  desaturated (`#8C2233`) so it doesn't compete with the brass.

## The app runs FULLSCREEN, not standalone
- `manifest.json` is `"display":"fullscreen"` with a
  `"display_override":["fullscreen","standalone","minimal-ui"]` chain.
  Standalone still paints the Android status bar strip along the top edge
  — that strip was real reclaimed screen space, which matters on a
  landscape-only game whose vertical budget is already spent.
- **Android bakes the display mode into the WebAPK at install time**,
  exactly like `orientation`, so an already-installed copy keeps its old
  chrome until it's uninstalled and re-added. That's why there's also a
  runtime fallback: `requestTrueFullscreen()` rides the same one-shot
  `pointerdown` listener the Web Audio unlock uses (the Fullscreen API
  needs user activation) and asks for fullscreen directly. Entirely
  best-effort — a no-op when already fullscreen, silently rejected in a
  browser tab that won't allow it — but it reclaims the strip immediately
  without anyone reinstalling.
- `viewport-fit=cover` was already set and is what lets the layout paint
  into the cutout area; the `env(safe-area-inset-*)` terms in `#app` and
  in the `--cw`/`--ch` formulas are what keep content out of it. Those
  insets shrink in fullscreen, so the card sizing gains the space
  automatically — no formula change was needed.
- `manifest.json` changed, so `sw.js`'s `CACHE` is bumped (`ddp-v7`).

## `.deco-box` — the Marquee Deco box treatment
- One edge-vignette + brass-inset-frame treatment shared by **every**
  card, panel and selection control in the app: `.tile`, `.stat-card`,
  `.slot`, `.codebox`, `.pod`, `.daily-hero`, `.profile-hero`,
  `#daily-board-wrap`, `.profile-chip`, `.acct-chip`, `.seg-btn`,
  `.avatar-opt`, plus `.deco-box` as the opt-in hook (used by
  `.theme-swatch-btn.theme-card` and `.acct-toptab`).
- **Applied by SELECTOR, not by adding a class to every element.**
  Several of these are built in JS render functions — `.slot` in
  `renderLobby`, `.pod` in `renderFinal`, `.avatar-opt` in
  `renderAvatarGrid` — so a class-based rollout would have meant editing
  render code. This stays CSS-only. Adding a new box to the treatment
  means adding it to three selector lists (base, `::before`, `::after`).
- **Three tokens drive it**: `--deco-edge`, `--deco-frame`,
  `--deco-frame-strong`, declared in the **first** `:root` (with the
  `--ddp-*` block), *not* the derived one. That placement is
  load-bearing: `[data-theme="clair"]` ties with `:root` at 0,1,0, so it
  can only override by coming later in source order — and the derived
  `:root` sits *after* the theme blocks. Clair's whole correction is now
  three token overrides instead of two duplicated selector lists.
- `--deco-inset` (default `6px`, `3px` on compact controls) is a
  per-element custom property, so sizing the frame to a 40px pill vs a
  20px hero needs no new rule.
- **`::before` carries `border-radius:inherit`** rather than relying on
  the host's `overflow:hidden` to clip it. The game-flow screens'
  landscape block (`#s-lobby/#s-draw/#s-summary/#s-final > .center-wrap
  > *`) forces `overflow:visible` at a specificity the shared rule can't
  beat, so `.codebox` would otherwise show square vignette corners
  poking past its 18px radius.
- **Not treated, deliberately**: `.sheet-wrap` (its `overflow:auto` is
  what scrolls the scoresheet — `overflow:hidden` would kill it),
  `.note` (background and border carry semantic good/bad/gold state; a
  brass frame fights a red error), `.empty-state` (a text block with no
  box of its own), `.acct-tabbar`/`.acct-tabs` (containers whose
  children already carry it — framing both nests two frames), `.btn`
  (44 of them, and a dark vignette over the gold primary reads as a
  rendering fault), table rows (a `tr`/`td` can't host absolute
  pseudo-elements reliably), and everything on the pass/play screens
  (vertical budget).
- **The menu tile icons are typographic glyphs, not emoji** (♠ ☀ ♛ ◆ ▤ ☺,
  from the Deco mockup), and that's what makes the treatment work on
  them: emoji ignore `color` and largely ignore `text-shadow`, so they
  could never take the brass tint or the `.deco-box` icon glow. The three
  with colour-emoji presentation variants (♠ ☀ ☺) carry **U+FE0E** in the
  markup — without it Android renders them in colour and both the tint
  and the glow are silently lost. `.tile-icon` also carries an explicit
  symbol font fallback, since DM Sans has no ♛ or ▤.
  My Account's icon is the exception: `updateMenuProfileUI()` replaces it
  with the player's own avatar emoji when they've set one, so ☺ is only
  the fallback (in both the markup and that function — change both).
- **Built from `--ddp-brass-rgb` / `--ddp-scrim-rgb`, never Marquee's
  hex**, so it flips with the theme like everything else. (The spec it
  came from called the brass companion `--ddp-gold-rgb` and hung the icon
  glow off `.ic`; neither exists here — it's `--ddp-brass-rgb` and
  `.tile-icon`, so that glow rule would have matched nothing.)
- **The `z-index:-1` + `isolation:isolate` pairing is load-bearing, not
  tidiness.** An absolutely-positioned pseudo-element paints ABOVE its
  host's in-flow content, so the vignette would otherwise wash over the
  tile's own icon and label — and the icon sits exactly in the left-edge
  band where the vignette is darkest. `isolation:isolate` makes the host
  a stacking context so `z-index:-1` lands the decoration above the
  host's background but below its content. Without the isolation the
  negative index would drop it behind the host's background instead and
  it would vanish. Don't remove either half.
- **Zero box-model impact by design** — both pseudo-elements are
  absolutely positioned and `pointer-events:none`, and the inset frame is
  a pseudo rather than a border/padding on the real element. Verified by
  measuring every tile with and without the class: identical rects, and
  the landscape 2×3 menu still fits 667×375 with no scroll (last tile
  bottom 313 of 375).
- `border-radius:inherit` on `::after` is what lets one rule serve 18px
  tiles, 14px theme cards and 9px tab pills. The tab pills get
  `inset:3px` instead of `6px` — a 6px inset inside a ~34px pill reads
  as a cramped double-border.
- **Clair needs a correction and the other three don't, because it breaks
  in BOTH directions at once.** Measured contrast of the treatment
  against the box's own background:
  vignette — Bordeaux 1.06, Émeraude 1.42, Marquee 1.25, **Clair
  lightened instead of darkening** (its `--ddp-bg` is the near-white page
  colour, so the "fade to the edges" read as a bloom);
  frame — Bordeaux 1.43, Émeraude 1.35, Marquee 1.43, **Clair 1.20**
  (brass at .22 all but vanishes on a pale felt).
  So Clair fades toward its warm ink at .13 (1.28 edge contrast) and
  lifts the frame to .40/.72 (1.40/2.05). Both alphas were solved for,
  not guessed. It lives at the **end** of the stylesheet with the other
  Clair corrections — see the token-placement note above for why source
  order is what decides it.

## Menu tiles — the Marquee Deco layout
- Each tile is a **centred vertical stack**: glyph → NAME (uppercase
  display face, 14px) → tagline (uppercase, 9px, `--muted`). Not the
  old icon-beside-text row. `.tile-arrow` is `display:none` everywhere —
  a centred three-line stack has nowhere to put a chevron — and
  `.tile-icon` is a bare glyph, not a 44px chip, which is where the
  height for the stack came from.
- **`align-self:stretch` + `grid-template-rows:repeat(3,1fr)`** on
  `.menu-tiles` is what makes the six tiles divide the full column height
  instead of clustering in the middle. The per-orientation type/size
  overrides that used to live in the landscape block are gone: shrinking
  the type again in landscape is exactly what made it stop matching the
  reference. Only vertical padding is trimmed there (10px, not 12px) —
  at 667×375 "Ranked Multiplayer" wraps to two lines and `.tile` is
  `overflow:hidden`, so the tagline was being clipped by ~2px.
- **Two mappings differ from the spec this was built from**, both because
  its token names assume a different system:
  - `--ddp-gold-rgb` is `--ddp-brass-rgb`, and `--ddp-felt-0-rgb` had no
    equivalent at all — **`--ddp-bg-rgb` was added to all four theme
    blocks** for the vignette, following the existing companion pattern
    rather than hardcoding felt hex into the rule.
  - **The felt ramp is inverted relative to the mockup.** There
    `--felt-0` is the DARKEST stop; here `--felt-0` is `--ddp-felt`, the
    LIGHTEST, and `--felt-2` is `--ddp-bg`, the darkest. Copying the
    spec's `felt-2 → felt-1 → felt-0` literally runs the gradient
    bright-side-down. The rule orders them by meaning instead.
- `.tile.primary` uses `color-mix()` against `--ddp-brass` rather than
  the mockup's hardcoded `#16382c`/`#0a2019`/`#050f0c`, which are
  Marquee's emerald and would leak into the other three themes.
- **Clair needed two corrections, for the usual reason plus a new one.**
  The vignette fades toward `--ddp-bg`, the darkest felt — but on Clair
  `--ddp-bg` IS the near-white page colour, so the edge fade *lightened*
  (#e4d9c5 → #eee7d8) and read as a bloom rather than a vignette. Clair
  fades toward its warm ink instead, at .13 for a 1.28 edge contrast, in
  the same band as the other three (1.06/1.42/1.25). Separately, the
  mockup's `opacity:.7` tagline measures 2.63:1 on Clair — under AA, on
  the smallest type in the app — so Clair takes it back to full opacity
  (4.44:1). Both live in the end-of-stylesheet Clair block.

## Brand splash (`#splash`, `public/brand/*.webp`)
- **This is the app's only boot state and it didn't exist before.**
  `#s-menu` ships `class="active"` and the app paints straight to the
  menu, so the splash is a new UI state layered on top, not a screen in
  the `show()` rotation. It lives outside `#app`, `position:fixed`,
  `z-index:9000`.
- **Non-blocking by construction.** `hideSplash()` fires on socket
  `connect` *or* a hard `SPLASH_MAX_MS` (2.2s) timeout, whichever lands
  first, and guards on an already-done flag — so an offline start or a
  dead server can never trap anyone behind it. `SPLASH_MIN_MS` (650ms)
  stops it flashing past on a fast local connect. It removes itself from
  the DOM after fading.
- `pointer-events:none` throughout, deliberately: the first `pointerdown`
  anywhere is what unlocks Web Audio (see the Sound section), and a
  full-screen overlay that ate it would silently mute the first game.
- **Not themed, on purpose** — a brand mark is the brand's colours, not
  the player's chosen felt, the same as an OS splash screen. It doesn't
  read `data-theme` at all.
- **The landscape image is the SQUARE logo, not the portrait loading
  screen**, and that's the whole reason two assets exist. The handoff's
  loading screen is 1080×1920; `cover` on a ~900×412 landscape viewport
  crops it to a thin horizontal band through the middle, losing both the
  emblem and the wordmark. So landscape gets `marquee-logo.webp`
  `contain`-fitted and letterboxed on `#020605` (the art's own edge
  colour, so the join is invisible), and the portrait art is used only
  under `@media (orientation:portrait)`, where it fits as designed.
- Assets are **WebP, downscaled from the source PNGs** — 18KB and 40KB
  against 3.1MB and 2.8MB. Don't commit the originals; this is a phone
  PWA and they're in `sw.js`'s `ASSETS` (hence the `ddp-v6` bump).
- `manifest.json`'s icons are deliberately **left alone**. The handoff
  offers the seal as an icon source but warns its fine ring/tick detail
  won't survive 48px, and it's full-bleed square art with no transparent
  padded crop — changing icons also means regenerating the maskable set
  and re-triggering the WebAPK install caveat documented above.

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

## Tutorial (`public/index.html`, first-run overlay + "?" replay button on the menu)
- **Architecture: Part A is entirely client-side, not a server-backed
  room.** The design this was implemented from originally called for a
  real "tutorial room" in `server.js` with scripted AI overrides and a
  `tutorialHint` socket event. That was deliberately not built —
  server.js changes couldn't be run or tested at all in the environment
  that built this, and shipping an untested change to the shared game
  engine every real game also runs through, on production, was judged
  too risky. **`server.js` is completely untouched by the tutorial.**
- Instead, Part A drives a fake, fully scripted game-state object
  (`tutG`, built by `tutBuildG()`) through the exact same render
  functions real play uses — `renderPass`/`renderPassReveal`/
  `renderPlay`/`renderSummary`, and everything they call (`tableHTML`,
  `handHTML`, `myStrip`, `cornerActions`, `sheetHTML`, the legal/dim card
  mechanism, the hold-and-slide and landscape drag gestures, `nearestTapCard`).
  This is what gives Part A full landscape support for free, without a
  single landscape-specific line written for the tutorial itself.
- **Pass-mode selection can now be forced to a specific pair, not just
  "any 2."** `handHTML`'s `mode==='pass'` branch reuses the SAME `legal`
  parameter play-mode already had (previously always `null`/unused in
  pass mode): a card outside the legal set is `.dim` instead of `.tap`,
  exactly like an illegal play. `renderPass`/`handHTML` thread an
  optional `G.passLegal` array through for this — unset (`undefined`/
  `null`) on every real call site, so real play's "pick any 2" is
  unchanged; the tutorial is the only caller that ever sets it
  (`tutA_handPass`, forcing exactly the two passed-away hearts). Small,
  backward-compatible, real-code-touching extensions like this are
  preferred over duplicating `handHTML` for the tutorial's own use.
- `updatePassButton()` gets one tutorial-only cosmetic line: `.tut-glow`
  toggles onto `#p-go` the instant `picked.length===2`, since it's
  called after every `togglePassCard()` regardless of whether a
  tutorial is running. No-op (the class never gets added) outside one.
- **The specific forced cards get their own highlight**,
  `tutorialHighlightCards()` → `.tut-forced`, distinct from
  `tutorialSpotlight()`'s ring (which points at one whole element — a
  badge, a hand, the table — not specific cards inside one). Applied
  once, right after the render that creates the card elements:
  `togglePassCard()` mutates the existing DOM nodes' `.sel` class
  in place rather than re-rendering the hand on every tap, so the
  highlight survives clicks without needing re-application.
- **`isOverDropZone()` takes an optional `pad`** (defaults to the
  original `30`, unchanged for real play); `endCardDrag()` passes `400`
  when `tutorialActive`. A missed landscape drag-drop is silent — the
  card just snaps back with no error — which looks exactly like the
  tutorial being stuck. A forced single-card lead should never be
  droppable-but-missed, so the tutorial's drop tolerance is generous on
  purpose; real gameplay's precision is untouched.
- **`tutorialCommitPlay()` fades the callout out (`tutorialFadeCallout()`)
  the instant a forced card is committed**, before the ~2s of scripted
  AI responses play out — leaving stale instructions ("play your A♣")
  visible while cards were visibly landing on the table read as another
  plausible cause of "stuck," on top of the drop-zone one.
  `tutorialFadeCallout()` only removes the callout's `.show` class; it
  deliberately does NOT also clear the spotlight ring the way
  `tutorialHideCallout()` does, since the ring should stay on `.mid`
  while the trick plays out.
- **The pass→trick-1 transition was two stops, now it's one.** What
  were three separate steps (hand intro → pass-direction explainer →
  a "cards received" reveal screen with its own Next tap before trick 1
  even starts) are now two: one merged hand+pass step
  (`tutA_handPass`), and one merged reveal+lead step (`tutA_trick1`,
  which skips rendering `renderPassReveal` entirely and goes straight to
  the play screen with the Ace already forced, mentioning what was
  received in the same callout that ends on the actual drag
  instruction). Fewer stops, and it's what lets a callout's text end on
  a literal action instruction instead of a "Next" button that doesn't
  lead anywhere actionable yet.
- **The callout box is fixed top-left** (`#tutorial-callout`), not
  bottom-center — the table screens' one dead corner (hand at the
  bottom, trick cross and info stack on the right), so it never sits
  over the cards or buttons it's telling the player to use. In
  landscape it sits BELOW the home button rather than under it (`top:
  60px`, clearing the button's 44px + margins) rather than overlapping
  it — check that offset again if the home button's size/position ever
  changes.
- **The only touches to real interaction code are the guards above plus
  six `if(tutorialActive)` branches**, each added at the exact point a real
  action would hit the network, redirecting to a tutorial-local handler
  instead of `socket.emit(...)`: `confirmPass()`, `endCardDrag()`,
  `releasePlayPick()`, `askLeave()` (home button → `exitTutorial()`
  instead of trying to leave a room that doesn't exist), and
  `confirmRoundClick()`. Plus one more line, in the
  `matchMedia('(orientation:landscape)')` change listener, re-applying
  the tutorial's spotlight ring after an orientation-triggered
  re-render (which rebuilds the table's innerHTML and destroys whatever
  the ring was attached to). Every one of these is a no-op when
  `tutorialActive` is false, i.e. always, outside a tutorial run.
- **`me`, `room`, and `S` are all temporarily repointed** at tutorial
  start (`me=0`, `room=''`, `S=tutG`) and restored in `exitTutorial()`.
  This is what lets the unmodified render functions and interaction
  handlers work against fake state without knowing it's fake — they all
  already read `me`/`S` as ambient globals. In practice this only ever
  launches from an idle menu (first run, or the "?" button — both
  menu-only), so there's nothing real to preserve; the save/restore is a
  safety net, not a load-bearing path.
- **Two ordinary shared globals had to be reset in `exitTutorial()`**:
  `passFxShownForRound` and `lastCurrentTrickLen`. Both are "have I
  already observed this?" diff-trackers that `renderPassReveal`/
  `renderPlay` read to decide whether to play the pass-flying-cards
  animation / a `cardPlace` sound — real per-render diffing, not part of
  any per-game state object. Running a full scripted round through them
  left both at stale non-fresh values; without resetting them, the
  player's actual first real game would have silently skipped that
  animation on round 1 and the `cardPlace` sound on the first opponent
  card. Reset to the same sentinels (`-1`/`null`) a fresh page load
  starts with.
- **The spotlight ring is a box-shadow-cutout on the target itself**
  (`.tutorial-target`, `0 0 0 9999px` spread), not a separate scrim
  element with the target's z-index boosted above it — deliberately, so
  it needs no positioning math regardless of what's being pointed at.
  This only looks like a full-screen dim wash because every ancestor
  between a tutorial target and `<body>` (`#app`, `.screen.active`) is
  itself sized to fill the entire viewport in landscape — the box-shadow
  spread is actually clipped at the nearest `overflow:hidden` ancestor,
  which happens to coincide with the screen edge here. If any of those
  containers ever gets a smaller/padded/centred landscape treatment,
  this stops covering the edges and needs converting to a real
  `position:fixed` scrim (the welcome/Part-B overlays already use one —
  `.tutorial-scrim` — this could switch to the same pattern).
  **Corollary: the spotlight dims EVERYTHING except its one target.** Any
  other element that must stay bright at the same time needs
  `position` + a `z-index` above 501 or it just looks greyed out —
  `.tut-glow` on the pass button carries `z-index:502` for exactly this
  reason, and it works because both it and the spotlit `#p-hand` sit
  inside `#app`, which is `position:relative;z-index:1` and so is the
  shared stacking context those two values are compared in. It pulsed
  correctly but *underneath* the wash before that was added.
  For the general case `tutorialSpotlight(sel, liftSel)` takes an
  optional second selector: those elements get a brass ring **and**
  `z-index:502` via `.tutorial-lift`, but cast no scrim of their own.
  Only one element can sensibly carry the scrim — two overlapping
  9999px shadows compound into a much darker wash, and since they'd
  share a z-index each would dim the other. So "highlight the round
  badge *and* the eye" is one scrim on the panel plus two lifted rings,
  not two scrims.
- Callout placement is per-step: `tutorialCallout(html, {side:'right'})`
  moves it to the top *right*, with its `top` measured off the live
  `.rt-stack` rather than hard-coded, since that panel's height varies
  with how much status text is showing. Every step that asks the player
  to drag a card uses it — the default top-left corner sits over the
  `.mid` drop target — as do the trick-3 narration steps, so the table
  stays readable while the scripted cards land.
- **The fixed 4-trick script and why those specific tricks**: every card
  referenced anywhere in the script — the learner's 13 starting cards
  (`TUT_HAND`), the 2 passed away, the 2 received, and every scripted AI
  play across all four tricks — is a distinct (rank, suit) pair, verified
  by hand (not generated) since correctness here couldn't be checked by
  running anything. AI hands are never enumerated beyond the specific
  cards they're scripted to play — real play never shows an opponent's
  actual hand either (only `cardCount`), so nothing needed a full
  13-card hand behind it. The four tricks are chosen so each one lands a
  single teaching beat: trick 1 (learner leads, forced ace, wins clean —
  "opening restriction" + "+10 for winning" together, since the design
  brief's own step ordering put those two beats back to back); trick 2
  (an opponent leads, learner is offered every legal card of the led
  suit rather than one forced card, since the RULE — not a specific
  outcome — is what's being taught; scripted so the learner never wins
  it regardless of which legal card they pick, since West's ace exceeds
  every card the learner could legally hold); trick 3 (the Q♠ moment —
  the learner holds exactly one spade all game, guaranteeing it's their
  only legal card whenever spades are led, which is what makes the
  "ouch" moment inevitable rather than avoidable by a lucky/unlucky
  choice); trick 4 (mild heart penalty, contrasting +6 net against
  trick 3's −16, per the source design's own explicit request for that
  contrast).
- `tutAwaiting` is the hand-off contract between a step function and the
  guarded real handlers: `{type:'play',rank,suit,after}` demands the one
  exact forced card (tricks 1, 3, 4's openers); `{type:'playAny',suit,after}`
  accepts any card of that suit (trick 2's follow-suit step, where
  genuine choice among legal cards is the point). `tutorialCommitPlay()`
  is the single place both are resolved — if you add a new kind of
  forced action, it goes there, not into a new guard.
- **THE INVARIANT THAT BREAKS THE TUTORIAL SILENTLY.** Setting
  `tutG.legalCards` does NOT by itself make a card playable. `renderPlay`
  computes whose turn it is as
  `(trickLeader + currentTrick.length) % 4`, and only renders your hand
  in `'play'` mode — the mode that puts `.tap` on cards — when that
  equals your seat (0). `nearestTapCard` only ever finds `.tap` cards, so
  if the arithmetic doesn't land on 0, **nothing is tappable, no guard
  fires, and the tutorial dead-ends with no error**. So every step that
  sets `tutAwaiting` to a play must first have pushed a card for each
  seat between the leader and you. It is not enough for the callout text
  to *say* an opponent played — the card has to actually be in
  `currentTrick`. This shipped broken at trick 2 for exactly that reason
  (text claimed Computer 4 had followed; only Computer 3's card was ever
  pushed). Current leaders/positions: trick 1 leader 0 (you first),
  trick 2 leader 2 (seats 2,3 then you), trick 3 leader 1 (seats 1,2,3
  then you), trick 4 leader 0 (you first).
- `tutorialAutoPlay(plays, done)` takes an array of **`[seat, card]`
  pairs**, so its first element destructures as `const [[seat,card],...rest]`.
  Writing `const [seat,card,...rest]` instead made `seat` the whole pair
  array, so `tutG.players[seat]` was `undefined` and `.cardCount--` threw
  *inside the setTimeout* — which meant `renderPlay` never ran, the
  recursion never continued, `done()` never fired, and the tutorial froze
  the instant the first scripted opponent card was due, with a corrupt
  `{player:<array>}` entry left in `currentTrick`. This was the real
  cause of the reported "computer doesn't continue" stall; two earlier
  guesses at it (drop-zone tolerance, a stale callout) were wrong and
  fixed nothing. All three resolvers share this one helper, so all three
  tricks were broken by it.
- Debugging note for anything like this in future: because the scripted
  steps run inside `setTimeout` callbacks, **an exception in one is
  invisible in the UI** — no error surface, the tutorial simply stops
  mid-sequence and looks "stuck". Check the browser console first; a
  silent stall is much more likely to be a thrown error in the next
  scheduled step than a missed gesture. The home button (top-left) still
  exits via `askLeave` → `exitTutorial()` in that state, so the player is
  never actually trapped.
- **Part B (`startTutorialPartB`) is intentionally NOT built on `tutG`
  at all** — it's static reference content (scoring table, the moon,
  the pass cycle, casual vs. ranked), rendered as its own small
  card-deck overlay with no game state involved, matching the source
  design's own reasoning: scoring math can't be "discovered" through one
  scripted trick, so it's taught as short concrete facts instead,
  Balatro-style, not folded into Part A's forced-play mechanic.
  Reachable only by replaying the whole tutorial (the "?" button runs
  Part A → Part B in sequence, matching "replay jumps straight into Part
  A") — there's no standalone "skip to just the reference cards" entry
  point; the existing Rules modal (`openRules()`) already serves as the
  always-available full-reference fallback.
- **The step-9 round-summary screen does not run a live 20-second
  countdown.** `syncCountdown()`/`renderVote()`/`handleSfxForState()` are
  only ever called from the real `socket.on('gameState', ...)` handler,
  which the tutorial never goes through (it calls `renderSummary(tutG)`
  directly) — the auto-advance behaviour is explained in that step's
  callout text, not demonstrated live. Deliberate, not an oversight: a
  real countdown would need its own scripted resolution (what happens
  when it hits zero, in a round that was already truncated to 4 of 13
  tricks) for no real teaching benefit.
- **This never played out the remaining 9 of 13 tricks in the round**,
  and says so on screen ("We skipped ahead…") rather than pretending the
  round-summary numbers are what a real round produces. Every teaching
  beat the design called for is delivered in the 4 scripted tricks;
  playing out the rest would only add time.

## Blitz — per-room match length (4 / 8 / 12 / 16 rounds)
- **The pass cycle needed no generalization at all, and that's the
  important design note.** The spec this was built from proposed an
  `isKeepRound(round, roundsTotal)` helper with `cycle =
  floor(roundsTotal/4)`, which would have made a 4-round game
  every-round-Keep (no passing anywhere) and an 8-round game
  L/R/K/L/R/K (no "across" ever). That was **deliberately not built**:
  every offered length is a multiple of 4, and the existing
  `passDir(round) = ['left','right','across','keep'][(round-1)%4]`
  already lands Keep on the *final* round of a 4-, 8- or 16-round game.
  So a 4-round Blitz is exactly one of each direction. `passDir` is
  untouched. If a non-multiple-of-4 length is ever offered, THAT is when
  a helper becomes necessary — not before.
- `ROUND_OPTIONS = [4, 8, 12, 16]` and `sanitizeRoundsTotal()` in
  `server.js` are the whole validation; anything else coerces to 16, on
  the client (`ROUND_OPTIONS`/`loadRoundsTotal`) and the server
  independently.
- `createRoom(hostName, hostAvatar, hostAccountId, opts)` gained an
  optional 4th argument. Every pre-existing call site passes nothing and
  is unchanged. `TOTAL_ROUNDS` is gone — `publicState`, `advanceRound`
  and the `passLetters` array all read `G.roundsTotal` now.
- The client already read `G.totalRounds` everywhere (`roundBadgeHTML`,
  `sheetHTML`, `renderSummary`), so no client render code needed
  changing for the length itself — only the picker.
- Picker sits on the **Casual Play** screen directly above "Create a
  game", not a sixth menu tile: it only affects a game you *create*
  (joining by code inherits the host's length), and keeping it off the
  menu leaves the hand-tuned landscape `.menu-wrap` grid alone. Sticky
  via `ddp.lastRoundsTotal`.
- Picker is a 2x2 `.seg-grid` of `.seg-btn` cards (not a thin segmented
  row — four choices are the single most consequential decision on this
  screen, so they get real touch targets). Kept on `.seg-btn`
  specifically rather than a new class, since `.seg-btn` is one of the
  classes wired into the shared `.deco-box` vignette/brass-frame
  treatment (selector lists ~line 225-301) — renaming it would silently
  drop that treatment, same trap `.theme-swatch-btn` hit once already.
  Selection state is shown via both the `.active` background AND a
  `.seg-check` checkmark badge, since colour-only active state on a
  brass-tinted background is a real accessibility gap; `.seg-dots` (a 4-
  dot relative-length indicator) uses `<em>`, not `<i>`, to avoid
  colliding with the existing bare-`i` subtitle rule on `.seg-btn`.
- On Casual Play specifically (landscape only — portrait is unaffected),
  the profile chip is pulled out of the scrolling body panel and into
  the rail directly under the title (`html.landscape-mode #s-landing
  #casual-chip`), the one exception to the shared rail/body split every
  other screen uses. `#casual-chip` is a direct child of `.center-wrap`
  now (not nested in `#casual-ready`) so the landscape override can
  target it; `goCasual()` toggles its `display` directly instead of
  piggybacking on `#casual-ready`'s visibility.
- **Blitz gets its own GAME-level stat columns, not its own table.**
  `stats.blitz_games_played/_finished/_points_total/_best_game/
  _worst_game/_moons_total`, written by `recordBlitzGameStarted`/
  `recordBlitzGameFinished` and routed by `isBlitz(G)` at the two
  existing call sites. Per-**trick** and per-**round** records stay in
  the shared columns on purpose — a round is 13 tricks in every mode, so
  those are match-length-agnostic and blend correctly. Only a final
  *game* total is incomparable across lengths.

## Daily Challenge (one seeded hand per UTC day)
- **It's an ordinary room, not a new game system.** `createDailyRoom`
  builds a normal `G` via `createRoom` with `{daily, dailyDate,
  forcePassDir}`, sets `roundsTotal = 1` directly (1 isn't an offered
  `ROUND_OPTIONS` value so `sanitizeRoundsTotal` would reject it), seats
  the player at 0 with three AI, and calls `dealRound(G)` straight away
  — no seat draw, no dealer cut, no lobby. Everything after that is the
  normal play loop, the normal `gameState` broadcast, the normal table
  screens and the normal round-summary → final flow.
- **Three things are drawn from the date, not just the cards**: the deal
  (`seededShuffle`), the pass direction (`dailyPassDir`) and the dealer
  (`dailyDealer`). So one day is Keep with West dealing, the next is
  Across with you dealing — the hand genuinely differs day to day rather
  than only the cards. All three go through `dailyPick(prefix, date, n)`,
  and **each uses its own seed string** rather than successive draws off
  one stream, so they're independent (otherwise every "keep" day would
  share a family of deals). `dailyPick` discards two draws first:
  mulberry32's opening output is only weakly separated for nearby seeds,
  and these seed strings differ by a single date character. Verified over
  5000 simulated days — χ²=0.32 and 2.02 (3 df) for direction and dealer,
  joint 16.73 (15 df) — and 200/200 distinct opening hands.
- **The AI is deliberately NOT seeded and is byte-for-byte the casual
  AI.** `aiChoose`/`heuristicChoose`/`applyHardRules`/`aiSelectPass`
  never read `G.round`, `G.roundsTotal`, `G.daily` or `G.ranked`, so
  there is nothing mode-dependent to keep in sync — the only reason the
  computers ever played differently here was the original no-pass design
  skipping `aiSelectPass` entirely, which the seeded direction fixed.
  `sampleWorld`'s Monte Carlo sampling stays random: every player faces
  the same *deal*, which is what makes the comparison meaningful, and
  making it reproducible would mean touching the Monte Carlo core.
  Revisit only if leaderboard integrity actually becomes a complaint.
- `dailyDateKey()` is **UTC** (`toISOString().slice(0,10)`) and the
  client's `todayKey()` must stay identical — a local-date key would
  give Auckland and Lisbon different puzzles at the same instant.
- **`passTarget`/`passSource` take a DIRECTION, not a round number.**
  They used to derive the direction from the round themselves, which is
  silently wrong for any room that pins one. `roundPassDir(G)` /
  `roundPassLetter(G, round)` are the single points of truth
  (`G.forcePassDir || passDir(G.round)`), and every call site passes
  `roundPassDir(G)` through. A pinned `'keep'` still skips the pass
  phase in `dealRound`; the other three run a real one.
- **`publicState` sends `passDir`.** `renderPass`/`renderPassReveal`
  used to recompute it as `(G.round-1)%4` client-side, which showed the
  wrong letter badge and the wrong "pass across" prompt the moment a
  room's direction stopped being a function of its round number. They
  now read `G.passDir`; the old expression survives only as a fallback
  for the tutorial's fake state object, which has no such field.
- Today's direction is shown on `#s-daily` before you play
  (`DAILY_DIR_TEXT`). It gives nothing away — you'd see it on the pass
  screen regardless — and it's what makes "the whole hand changes daily"
  visible from the front door.
- **The score is never sent by the client.** `submitDailyResult(G)` is
  called from `recordGameFinishedForAll` (which early-returns for daily
  rooms, so casual/ranked stats are never touched) and reads
  `G.players[0].score` from the server's own state. Guarded by
  `G.dailySubmitted`.
- **The whole submit is safe to retry**, which is why it goes through
  `trackStat`: `recordDailyScore` is `ON CONFLICT DO NOTHING` (a second
  submission can never overwrite the first score) and `bumpDailyStreak`
  is a no-op when `last_played` is already today. A partial failure
  (score written, streak not) re-runs both correctly.
- Tables: `daily_challenge_scores` with `UNIQUE (account_id,
  challenge_date)` — that constraint is the real one-attempt-per-day
  enforcement; the server's pre-check in `startDailyChallenge` only
  exists to give a friendly refusal before dealing a hand. Streaks live
  in a companion `daily_stats` table rather than on `accounts`, which
  stays purely identity. Index is `(challenge_date, score DESC)`, which
  covers both the leaderboard slice and the `RANK()` standing query.
- `getDailyStreak` returns 0 when the last play was neither today nor
  yesterday: the stored `streak` value is stale until the next play
  rewrites it, so liveness is computed at read time.
- **Daily rooms are excluded from the "solo-vs-AI never expires"
  exemption** in the cleanup `setInterval`. The result is banked in
  Postgres the moment the hand ends and there's nothing to come back to,
  so it closes on the normal timers. `endGame` (the end-early vote) is
  also hard-rejected for daily rooms — otherwise a player could bank a
  partial score. Leaving mid-hand closes the room and records nothing,
  so the attempt is simply forfeited and can be retried.
- **Client: `#s-daily` is a front door and leaderboard, not a game
  screen.** The hand plays on the ordinary pass/play table screens and
  the result lands on the ordinary final screen in a `#f-daily` block,
  exactly mirroring how `#f-ranked` works. So Daily Challenge needed no
  table furniture — it's in `LANDSCAPE_SCREENS` and picks up the shared
  `.center-wrap` rail rules, then overrides the split (below).
  `renderFinal` clears `#f-daily` when `!G.daily`; it never populates
  it, since the `dailyResult` event can land either side of that render.
- **`#s-daily` is the one rail screen that splits 50/50 instead**, and
  it's the fourth landscape layout family in practice. Every other rail
  screen has a small header cluster plus ONE wide body panel, so a
  narrow column 1 is right. This screen has TWO real panels, so the
  divider moves to the middle: `grid-template-columns:1fr 1fr` with the
  leaderboard filling the space under the header cluster that would
  otherwise sit empty.
  **Placement there is explicit, per child, on purpose.** The shared
  rules have already assigned chrome to column 1 and *everything else*
  to `grid-column:2;grid-row:1/-1`, so mixing auto-placement back in for
  the board would be fragile — each child of `#s-daily>.center-wrap`
  gets a named cell instead. The ID in those selectors is also what wins
  the specificity tie against the shared class-only rules.
- **`#daily-board-wrap` is a direct child of `.center-wrap`, NOT of
  `#daily-content`** — it has to occupy the whole left half on its own,
  so it can't be nested inside the panel that occupies the right half.
  In portrait it simply falls below the hero, which is the right reading
  order there too.
  It scrolls *internally* (`.daily-board-scroll` is the `overflow-y`
  element, `flex:1`), and the grid item itself is `overflow:hidden` —
  that's what keeps `.daily-you` pinned to the bottom edge of the box
  while rows move under it. Deliberately **not** `position:fixed` like
  `#rank-you-bar`: that one spans the viewport because the ranked
  leaderboard *is* the whole screen, whereas this box shares the screen
  with the hero panel beside it. Portrait has no height to bound the box
  against, hence the `max-height:46vh` there, reset to `none` in
  landscape where the grid's `1fr` row is the bound.
- The daily leaderboard sends the **top 100**, and `you` is returned
  whenever the player has a score today — *including* when they're
  already visible in the list, unlike `getLeaderboard`'s
  outside-the-top-N fallback. The pinned row is a permanent "you are
  here", not a fallback. Row numbers are computed from the score
  (equal scores share a rank) rather than the array index, so the list
  agrees with the `RANK()` figure the pinned row shows.
- **Guests can play but nothing is banked.** No leaderboard row, no
  streak, and the menu tile's dot is never set for them — "played today"
  is a fact about an *account*. This also matters mechanically: a guest
  `dailyStatus` legitimately arrives on reconnect *before*
  `resumeSession` has attached the account, so treating it as
  authoritative would wipe a real player's dot. That response
  deliberately doesn't touch the `ddp.dailyLastCompleted` cache, and
  `authOk` re-requests the status once the account is live.

## Not implemented
- Password reset (no email service configured)
- Ranked Blitz (Blitz is casual-only on purpose — splitting MMR across
  two match lengths would fragment a ranked population that isn't large
  enough yet)

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
