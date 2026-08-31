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

**Update 2026-08-24 — real-device verification pass.** Casual, Ranked,
Daily Challenge, Blitz, the Tutorial, and achievement ladder unlocks have
all now been played to completion by the developer against the live
Railway deploy, on a real device, and confirmed working. That supersedes
the "implemented, never executed" caveats below for those specific
items — the static-verification notes are kept as-is because they still
document how each was checked *before* that pass, which remains useful
if something regresses. **Still genuinely open, not yet touched by this
pass:** password reset (not built — no email service configured) and
error/crash monitoring under real traffic. Both are tracked in
`ROADMAP.md`, which also has the launch sequencing this status feeds
into.

The tutorial (see its own section below) was implemented without any way
to execute JS in the environment that built it, so it was verified by
exhaustive static tracing instead: every function reference
cross-checked against a definition, every `tutAwaiting` contract checked
against `tutorialCommitPlay`'s handling of it, every `$('tutorial-*')`
id checked against the markup, brace/paren balance checked on the whole
file. The 2026-08-24 pass above is the first real on-device run.

**Achievements & cosmetics (own section below) is the newest addition
and is in a BETTER position than the rest: its client half has actually
been run.** No Node was available there either, so `server.js`/`db.js`
remain statically-verified only — but `public/index.html` was served by
a `python -m http.server` against a copy with the one `socket.io`
`<script src>` swapped for a stub, and driven with a payload shaped like
`loadPlayerCosmetics`'s. That exercised, on real rendered geometry: all
five customization sub-tabs at 375px and in landscape, equipping and the
locked-item no-op, the guest gates, logout reset, the 12 achievement
rows, the scene layer's z-order and hit-testing behind a real hand of
cards, the Royal Court card skin, titles on the lobby rows, and
contrast across all four themes. **The achievement-ladder unlock path
itself — a rung actually clearing and the unlock landing in the
client — is now confirmed on live Railway as of the 2026-08-24 pass
above**, which means that flow's socket handler and SQL write are no
longer purely statically-verified. The rest of the SQL surface (the
shop/purchase path — `buyCosmetic`, credit spending — and any socket
handler outside the achievement-unlock flow) is still unexercised; the
same "first real run is the actual first test" caveat applies to those.
Two traps worth knowing if you repeat that setup, both of which read as
product bugs and are not:
1. The Browser pane doesn't composite when it isn't displayed, so **CSS
   transitions never advance and `getComputedStyle` returns each
   transition's frozen START value** (an element stuck at `opacity:0`, a
   colour that ignores the current theme). Inject
   `*,*::before,*::after{transition:none!important;animation:none!important}`
   before measuring anything.
2. For the same reason **`loading="lazy"` images never load** — nothing
   is ever "in viewport" for the intersection observer, so they sit at
   `naturalWidth 0` forever and look broken. Set `loading='eager'` on
   them before asserting anything about image loading.
Layout measurement (`getBoundingClientRect`, `scrollWidth`) is unaffected
by either and is trustworthy as-is.

**Blitz and Daily Challenge (their own sections below) were built the
same way — implemented, statically verified, never executed** — until
the 2026-08-24 pass above, which played both to completion against live
Railway and confirmed them working end-to-end, SQL included. No Node
runtime was available in the environment that originally built them, so
what got checked *before* that pass was static only: bracket/string/
template balance across `server.js`, `db.js` and both inline `<script>`
blocks; every `db.*` call cross-checked against `db.js`'s exports and
every export against a definition; every `$('id')` in the client
cross-checked against the markup; every `onclick=` handler against a
definition. **That static pass is no longer the only evidence for these
two** — treat them as verified, and `server.js` is no longer
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
  see the Blitz section. **Ranked is now a fixed 8 rounds**
  (`RANKED_ROUNDS`, passed by `formRankedMatch`); it no longer inherits
  `DEFAULT_ROUNDS` like every other call site. Casual keeps the full
  4/8/12/16 picker.
  Consequence, accepted deliberately rather than migrated:
  `ranked_stats`' best/worst-**game** and average columns now mix
  pre-change 16-round totals with 8-round ones, the same incomparability
  that gave Blitz its own columns. Per-round and per-trick records are
  unaffected — a round is 13 tricks in every mode. `DEFAULT_ROUNDS` is 16 and every call site that
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
  provably can't contain her — exempted only when *this AI* is the
  moon-pace owner (`moonPaceOwner(G) !== pi`), since capturing her for
  an opponent's benefit is never the point; never voluntarily win a
  hearts trick with a heart that beats the board if a losing heart is
  also legal (Monte Carlo's sampling can occasionally get noisy enough
  late in a round to make a needless capture look survivable — this
  removes it as an option entirely) — exempted more broadly, whenever
  *anyone* is on moon pace (`moonPaceOwner(G) === -1` is the only
  active case), because deliberately taking a dirty trick can be the
  one move that breaks an opponent's run, mirroring `heuristicChoose`'s
  own `oppMoonPace` handling for hearts specifically; never *lead* the
  queen herself unless we're the sole moon-pace owner AND hold both
  A♠/K♠ (so nothing beats her — she comes straight back to us, which is
  the point when chasing +60); on a genuinely free void discard (we
  hold none of the led suit, so whatever we play can never win this
  trick), always play the queen or a heart over a safe card — permanent,
  zero-risk downside removal, skipped only if it would hand the trick's
  win to an uncontested moon-pace opponent, same `feedsPace` idea
  `heuristicChoose` already used; always lead a held A♦/A♣ on trick 1.
  `heuristicChoose`'s leading branch mirrors the same "don't lead
  A♠/K♠, don't lead the queen" restrictions independently, since it's
  also used as the Monte Carlo rollout policy and as the
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
- **The game is landscape-first**, but NOT hard-enforced — a forced
  `#rotate-gate` overlay was tried and then deliberately reverted: it
  blocked a real player whose phone couldn't rotate into landscape at
  all, locking them out of the app entirely. `manifest.json` is
  `"orientation":"landscape"` and `applyOrientationLock()` requests a
  landscape lock on every screen, both best-effort (the lock only works
  reliably in an installed standalone Android Chrome PWA), and portrait
  remains reachable as the fallback everywhere the lock doesn't take.
- **The portrait CSS is NOT dead code — it's a real, live fallback**,
  not just the base layer under `html.landscape-mode`. Any device that
  can't or won't rotate lands here, so it has to stay genuinely usable,
  not merely present in the cascade. `isLandscapeModeActive()` gates on
  `matchMedia` rather than being forced to `true` for exactly this
  reason: painting a wide, short layout into a tall, narrow viewport
  would clip it into uselessness. A verbatim copy of the last
  portrait-usable build is kept at `backup/index-portrait-reference.html`
  (see that folder's README) as a reference point if the live portrait
  CSS ever drifts; it's outside `public/` so it is neither served nor
  cached.
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
  2. **Rail screens** (casual, ranked, rank, statistics) — narrow left
     rail of header chrome, body in column 2. Two screens take these
     rules and then override the column split: Daily Challenge to 50/50,
     and My Account to a single full-width column with **no rail at
     all** — see each one's own section.
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
  own landscape block then adds what's specific to it: the hero/panel
  split below, and the theme cards' shorter swatch on a short viewport.
- **In landscape My Account has NO rail — it's the one rail screen that
  opts out of the rail itself**, and that's a deliberate correction, not
  an oversight. Its content is *already* a two-column split (hero card |
  tabs + panel), so nesting that inside the shared rail spent a 238px
  column on nothing but the ‹ Menu button and squeezed both real columns
  into what was left. Measured at 915×412: hero 220px, panel 352px, and a
  238×370 hole beside them. Worse, at a larger Android font scale the
  hero's own content (the account chip's username, the 1.4rem name)
  exceeded its 220px, and `.acct-layout` — `overflow-y:auto`, which
  **computes `overflow-x` to `auto` too** — grew a horizontal scrollbar
  and clipped the theme cards and the Friends tab off the right edge.
  That's the reported "doesn't fit in one screen" bug and its actual
  cause.
  So the outer grid collapses to a single column: `.screen-header` keeps
  row 1, `.acct-layout` takes the full width of row 2. The hero lands hard
  against the left edge under Menu and the panel gets the reclaimed 258px
  (352 → 687px at 915×412), which is what puts the four theme cards in one
  row (150px of height → 70px) and the five-tab customization strip
  comfortably inside its column. Verified at 915×412 and 667×375, at
  16/18/20px root font, on every tab: zero horizontal overflow anywhere.
- Three consequences of that, all load-bearing:
  - The **divider moves onto `.acct-main`**. The generic rail rule put the
    indent, the border and the scroll on `.acct-layout`; with no rail
    there, all three belong to the columns inside it.
  - **The two halves scroll independently**, which is what retired the
    hero's `position:sticky` — it was sticky against `.acct-layout`'s
    scroll, and with each column owning its own overflow there is nothing
    left for it to stick to. The hero is `overflow-y:auto` and
    deliberately **not** `justify-content:center`: a scrollable box that
    centres its content makes the top unreachable once it overflows, the
    same trap the shared body-panel rule documents.
  - `.profile-hero .acct-chip` needs `max-width:100%`. It's
    `flex:0 0 auto;width:auto`, so its intrinsic width (a full username)
    won over the column and was what actually overflowed — the ellipsis
    on `.acct-chip-text` can only work once the pill is allowed to be
    narrower than its content.
- **The hero's name and title now live INSIDE the rank nameplate**
  (`#pv-plate`, which is also `.rank-plate.lg`) rather than beside it —
  the plaque is a decorative layer behind dynamic player text, per the
  rank-cosmetics sheet. It is therefore always in the DOM; with no rank
  set equipped it carries no `data-material` and renders as exactly the
  bare name + title it was before. See the Rank cosmetics section.
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
  - **Row 5 is the `1fr` one, not the tagline's row 3.** That's what
    keeps the credits box tucked directly under the tagline while still
    pushing the utility group to the foot of the rail — the same swap
    `#casual-chip` needed on Casual Play. An `auto` margin can't do
    either job, because on a grid item auto margins only absorb space
    inside that item's own area and don't move siblings. Every rail
    child now has an **explicit** `grid-row`, because the `1fr` spacer
    sits mid-rail and auto-placement would drop whichever element came
    next straight into it.
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

## The roster rail (`.roster`, play screen, landscape)
- **All four players' identity and score down the right column** — a
  rank-framed avatar, the rank nameplate carrying name + title, the
  round total and tricks won. It is the "show off your cosmetics during
  play" surface, and it exists **without costing the cards a single
  pixel**.
- **That's possible because the right column was already reserved and
  mostly empty.** `.table` pads `min(42vw,250px)` on the right so the
  trick cross never slides under `.rt-stack`, and only ~107px of that
  column's height was in use (`.corner-rt` + `.tbl-note`). The rail
  fills the rest. **Verified, not assumed**: card width/height, hand
  top, hand height and the leftmost/rightmost card edges are all
  byte-identical to the pre-change build (61.16 × 85.63, hand top
  314.4, leftmost 166.4, rightmost 748.8 at 915×412). Nothing in the
  `.roster` block may ever be allowed to grow `.mid` or `.hand`.
- **The plaque IS the row.** The avatar straddles the plate's left edge
  (`margin-right:-14px`, `padding-left:20px` on the plate) rather than
  sitting beside it, which is the rank sheet's own "decorative layer
  behind dynamic player text" contract — the same thing `.rank-plate.lg`
  does on the account hero. One object per player, not three.
- **Rows are ordered by POSITION, not seat index** (`ROSTER_ORDER =
  [2,1,3,0]` → top, left, right, you, via `seatOf()`), so the rail
  mirrors the table's geometry and the row-to-seat mapping needs no
  colour coding or legend.
- **`.rank-plate.xs` is a fourth size** beside `.sm`/`.lg` — four
  `--rp-*` numbers and no restated rules. `.sm` occupies ~36px once the
  emblem overhang and foot lozenge are counted, and four of those missed
  the available height by a hair. Like the other two it sits **before**
  `.rank-plate:not([data-material])` in source order, which is what lets
  an undressed plate still collapse its padding (they tie at 0,2,0).
- **The score is `G.roundBefore[i]`, frozen** — it moves between rounds,
  never after a trick, exactly like the seat blocks and the caption it
  replaces. The small figure beside it is tricks-won, the one number
  here that does move mid-round.
- **The tricks figure needs a hard separator, and this was a real
  rendered bug.** At a 3px gap in the same ink, a score of 42 beside 3
  tricks reads as **"423"**, and −13 beside 0 as "−130". It carries a
  `border-left` hairline plus padding for that reason. Static tracing
  would never have caught it.
- **AI seats wear `paper` + the title "I am a bot"**, set client-side in
  `rosterRowHTML`. paper is the tier a human holds at the *bottom* of the
  ladder, so every dressed human plaque reads as earned by contrast — and
  in solo-vs-AI, where three seats are computers, four bare wrappers
  looked broken rather than aspirational. **`server.js` and `db.js` are
  untouched by this whole feature**; everything it renders was already in
  `publicState` (`name`, `avatar`, `title`, `rankMaterial`, `roundBefore`,
  `tricksWon`, `dealer`, `connected`).
- **An undressed plate needs `border:2px solid transparent` AND matching
  2px padding.** A dressed plate carries a 2px metal border a side; without
  both, an undressed row measured 26px against its neighbours' 28 and the
  rail went visibly ragged. `.ros-txt`'s `min-height:1.3rem` does the same
  job for a player with no title. Both are the "reserve constant space"
  rule this file already applies to `.mystrip`'s turn badge — and both
  were caught by rendering, not by reading.
- **`.tcap` reduces to name-only, but ONLY when the rail is up.** The
  badge, score and dealer `D` move to the rail; the caption keeps the one
  job the rail can't do — telling you whose card is in that slot. The
  pass screen has no rail, so it keeps the full caption; dropping the
  score there would simply lose it.
- **Play screen only, and that's a design decision before it's a fit
  one.** The pass screen's stack also carries `#p-go`/`#p-auto`
  (`relocatePassChrome`), leaving ~118px against the rail's ~136 — but
  the better argument is that during passing no trick has been played and
  no score has moved since the round summary the player just confirmed
  through. `tableHTML` emits it only when `opts.roster` is set, which only
  `renderPlay` does.
- **Suppressed during the tutorial**, and not for tidiness: a
  `side:'right'` callout positions itself at the **live** `.rt-stack`
  bottom edge, which the rail pushes from ~102px to ~236px — straight
  onto the hand at 667×375. Verified both ways: `tutorialActive` true
  restores the stack to 101.8 and the full 4-child captions.
- **Contrast on the plate ink is measured, not picked.** `--rm-ink` is
  already solved against both ends of its gradient, and knocking it back
  with `opacity` spends that headroom: at `.72` paper lands **3.68:1** —
  under AA, on the smallest type in the app, on the plate every AI seat
  wears. `.85` is where the worst material still clears (paper 4.92/5.94,
  every other material 5.5+). Both `.ros-ti` and `.ros-sc small` use it.
- **Measured budget** at 915×412 and 667×375, at 16/18/20px root font, on
  all four themes, with bare/dressed/disconnected/all-AI/absurd-name
  fixtures: rows uniform at 28px (33.2px at 20px root), roster 136px,
  **26px of clearance above the hand in the worst case** (667x375 at 20px root), zero
  horizontal or vertical overflow, zero plate overflow past the stack,
  ellipsis engaging on a long name. Re-measure if `.corner-rt`,
  `.tbl-note` or the hand's height ever change.
- `.ros.turn` rings the plate with an **`outline`, not a border**, so it
  can't disturb the plaque's six layers or its measured height. The
  companion `.ros-av` border-colour only bites on an unframed avatar —
  `.rank-framed` sets border-colour with `!important` so the rank metal
  always wins, which is correct.
- **`.rt-stack.has-roster` unboxes `.tbl-note`** (background and border
  off). Two stacked bordered cards read as clutter, and the chrome is
  height the rail wants. Scoped to that class so the pass screen, where
  the note is the only thing under the panel, is left exactly as it was.
- **THE NOTE ABOVE IT MUST BE EXACTLY TWO LINES, ALWAYS.** It is the
  rail's only movable neighbour, so anything changing its height moves
  the whole rail — and it changed constantly in both directions:
  `.nt-sub` is empty most of the time (the server clears `lastTrickMsg`
  in three places, so the banner appears when a trick resolves and
  vanishes when the next starts — the rail jumped up a line *every
  trick*), and `.nt-main` **wraps on a long name** ("Waiting for
  Bartholomew Winterbottom III" is 2 lines, taking the note to 49.8px),
  which shoved it down instead.
  Fixed by making each line reserve **itself** — `min-height:1.2em`
  (exactly its own line-height) plus `nowrap`+ellipsis so wrapping is
  impossible — rather than by computing a min-height for the parent. A
  parent min-height was tried first and left 1.6px of drift, because the
  rendered line boxes don't match `font-size × line-height` arithmetic.
  **Don't reintroduce a computed constant here**; the per-line reserve is
  deterministic and needs nothing kept in sync with the font sizes.
  `syncLandscapeNote` also stops collapsing the empty sub (and the whole
  box) when `pinned` — i.e. when it sits in a `.has-roster` stack — since
  an inline `display:none` would defeat the reserve. Verified across nine
  note states × 2 viewports × 3 root font sizes: roster top varies by
  0.02px, which is sub-pixel rounding.
  Clamping the prompt costs nothing: a truncated "Waiting for
  Bartholom…" is fully legible in the rail directly beneath, which now
  lists every player by name.

## Round summary - the transposed scoresheet (`#s-summary`)
- **Each player's ROW is their whole scoresheet**: identity on the left,
  one narrow column per round running across, total on the right. This
  replaced a standings panel stacked ON TOP of a separate rounds-as-rows
  table - the two listed the same numbers twice, the table's column
  headers were truncated names (`COMPUTE...`), and together they were
  what stopped the screen fitting one view.
- **`sheetHTML` still exists and `#s-final` uses it.** Only
  `renderSummary` stopped calling it. Don't delete it.
- **ONE grid, not four rows.** That's what keeps every player's round 7
  in the same column, and it makes the horizontal scroll a single element
  instead of four that would have to be kept in sync.
  `grid-template-columns:210px repeat(var(--rn),minmax(34px,1fr)) 72px`.
- **Identity and total columns are `position:sticky`** (left / right,
  `z-index:3`) so the name and total never leave the screen when the
  strip scrolls. **`.sumwrap` must therefore be opaque** (`--felt-2`) -
  a translucent wash lets the scrolling cells show through them.
- **Measured fit at 915x412 (~716px of `.center-wrap`).** 210 identity +
  72 total leaves ~434 for the strip: 4 rounds -> 108px a column,
  8 -> 54px, 12 -> 36px, all without scrolling; 16 hits the 34px floor
  and scrolls by 112px. At 667x375 it is 86/43/34/34. **Every length now
  fits one screen vertically at every root font size** - that was the
  whole point of the change.
  One exception: a round somebody **shot the moon** adds
  `renderSummary`'s gold explainer, and at 18-20px root font that
  overflows by 4-29px. The note is already trimmed in landscape
  (`html.landscape-mode #s-summary .note.gold`) to reclaim the 28px it
  cost at default size. Accepted rather than chased further - the screen
  scrolls, and it is the rare intersection of biggest font, shortest
  viewport and a moon.
- **Fixed seat order (`ROSTER_ORDER`), never sorted by standing.** The
  rail already trained that order, and rows that reorder every round are
  the same "don't let it move" problem the note's reserved lines prevent.
  Placement is a `1st/2nd/3rd/4th` marker instead - standard competition
  ranking, so a tie shares a placement, matching `computeGameCredits`.
- The identity cell carries the rail's own classes (`.ros`, `.ros-av`,
  `.ros-plate` at **`.xs`**) so the plaque is byte-identical to the play
  screen's. An earlier version used `.sm` in a 320px column; in a 210px
  column `.xs` is both the right proportion and the consistent one.
- **`history[].totals` was always broadcast and never read.** Each cell is
  the round's swing over the running total after it - the delta alone said
  what a round cost but never where it left you. Zero server change.
  Guarded (`typeof === 'number'`) so an older server's state degrades to
  the delta. `history[].dir` is still unused; the letter comes from
  `G.passLetters`.
- **`.sg-c small` inherits the cell's colour at `opacity:.72`** rather
  than taking `--faint`, whose `.42` alpha measured 3.42:1 on Bordeaux and
  2.31:1 on Clair - under AA for real information. Inheriting also keeps a
  moon cell's running total gold for free. Verified 7.35 / 6.88 / 5.81 /
  7.77 (bordeaux/emeraude/clair/marquee).
- **THE SCORE SITS OUTSIDE THE PLAQUE, AND THIS IS LOAD-BEARING.**
  `--ddp-pos`/`--ddp-neg` are **themed**; the plate materials are
  deliberately **un-themed** (a rank is the same rank at every table). Two
  independently-varying systems, so an accent can never be safe on a plate
  interior - measured, `#7FE0B4` on paper is **1.02:1** (paper being the
  plate every AI seat wears), and Clair's dark accents fail on **seven of
  the eight** materials, worst 1.47:1. In the total column they sit on the
  panel, where `.seat-score.up/.down` already proves them: 8.79 / 8.34 /
  4.75 / 9.16.
- **"In the +" is not an arbitrary threshold.** Every round is exactly
  zero-sum - 13 tricks x +10 = 130, all hearts -104, the queen -26 - and
  the moon replaces it with +60/-20/-20/-20, also zero. So the four totals
  always sum to zero and positive means precisely "beating the table
  average". Confirmed in rendered output, not just on paper.
- **A shot moon marks the whole COLUMN** (`.moonc`), not just the
  shooter's gold cell, which is invisible unless you already know where to
  look. `.now` deliberately wins where both apply.
- **Clair needed a correction for the moon cell, and its selector is the
  interesting part.** Both golds fail on Clair's panel (rgb 241,234,219):
  `--gold-hi` 1.98:1, `--gold` 2.86:1. `#7A5A18` measures 5.33. It is
  written `html[data-theme="clair"].landscape-mode .sg-c.moon b` - the
  base rule is `html.landscape-mode .sg-c.moon b` at (0,3,2), so a plain
  `[data-theme="clair"] .sg-c.moon b` would be (0,2,2) and **lose wherever
  it sat**. Qualifying `html` with both attribute and class makes it
  (0,4,2) and wins outright, unlike its source-order-dependent neighbours
  in that block.
- **`scrollSummaryToNow()` scrolls only `.sumwrap`, horizontally**, using
  `getBoundingClientRect`. Its predecessor `scrollSheet` used
  `scrollIntoView`, which walks **every** scrollable ancestor - with a
  panel above the sheet that scrolled `.center-wrap` and hid the panel
  entirely. `scrollSheet` is kept for `#s-final`.
- **A `.mine` row is marked by the rail's underline, not a gold
  placement**: `--gold-hi` there measured 2.12:1 on Clair.
- Verified at 915x412 and 667x375, 16/18/20px root font, all four themes,
  4/8/12/16 rounds, first/mid/last round, moon-this-round, all-AI, bare
  human and long names: rows uniform at 28.8px, sticky columns hold at 0px
  drift, current round scrolled into view, zero overflow on either axis.

## Seat draw & dealer cut (`#s-draw`)
- The last two screens still drawing their own ad-hoc card (a rounded box
  with a `🂠` glyph and the rank stacked over the suit). They now render
  as **real cards**: the same face gradient, edge and ink as the table,
  and the *same blue back* opponents' cards use — so a draw card reads as
  a card from this deck rather than a placeholder.
- **The name is a caption UNDERNEATH (`.dcw`), not printed on the card
  face.** That's what a real cut looks like, and it stops a long name
  fighting the rank for the same space — the old `.dcn` was capped at
  66px and ellipsised inside the card.
- **One number drives the whole thing: `--dc`**, so every part (radius,
  corner index, centre pip, inset hairline, caption width) scales
  together. Sized `clamp(56px, min(16vw,11vh), 86px)` in portrait and
  `clamp(48px,15vh,82px)` in landscape — **clamped against BOTH axes on
  purpose**: landscape here is *short* rather than narrow (~375px tall on
  the tightest phone), so a width-only clamp overflowed vertically.
- The face-down card the player can still turn gets a pulsing brass ring
  (`prefers-reduced-motion` off-switch); the winning cut gets a brass
  ring plus a lift, so which card took it reads at a glance without the
  note underneath.
- **The dealer's card carries the physical `D` button** — reusing
  `.dealer-badge` rather than inventing a second marker — and only once
  the cut is settled (`drawRound === 2 && phase === 'drawDone'`). During
  round 1 there is no dealer yet, and mid-cut it isn't known.
- Verified at 915×412 and 667×375 at 16/18/20px root font, in all three
  states (unrevealed / seats settled / dealer settled): no overflow on
  any axis, and the Begin button and exit row stay on screen.

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
- **The SAME trap applies to any runtime-cached (non-`ASSETS`) file
  overwritten in place under its existing filename** — avatars, scenes,
  card fronts, rank art. This bit us for real a second time: re-cropping
  `charmer.webp` etc. in place (same filenames, new bytes) shipped fine
  on the server, but every browser that had already fetched the old
  avatar under that exact URL kept serving it from cache forever — the
  fetch handler is unconditionally cache-first with no revalidation, so
  the new file was never even requested. A player reported the change
  "not applying" when it had; **bump `CACHE` (v8)** whenever an
  in-place asset overwrite needs to actually reach returning players —
  it deletes the whole old cache namespace in `activate`, which is what
  forces the re-fetch. Editing the image bytes alone changes nothing
  this service worker will notice, exactly like the manifest case above.

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
- Hidden `mmr` (starts at `RANKED_STARTING_MMR` = **250**, `db.js`) +
  `placement_games_played` (first 5 ranked games) live in `ranked_stats`,
  not `stats` — `stats.mmr`/`stats.placement_games_played` are legacy
  columns from before ranked had its own table, left in place unused
  rather than dropped, and one-time-backfilled into `ranked_stats` on
  schema init (`ensureSchema`) so any MMR already earned under the old
  combined scheme isn't lost. The backfill's own `WHERE mmr <> 1000`
  check is intentionally untouched — that `1000` is the OLD system's
  default, testing "did this account ever earn a non-default MMR under
  the legacy scheme", and has nothing to do with where a NEW account
  starts today.
  Visible rank is always derived from `mmr` via `rankForMmr`/`RANK_TABLE`
  in `server.js` — never stored separately, never computed client-side
  (the client only renders whatever `tier`/`division`/`label` the server
  sends, e.g. in `rankedProfileOk`/`rankedResult`/`leaderboardOk`)
- **250 is the middle of Novice, chosen deliberately over the old 1000
  (Player/Gold).** `RANK_TABLE` has Novice spanning 0-499 across its
  three divisions (0 / 167 / 334) with Apprentice starting at 500, so
  250 is both the tier's own midpoint and lands inside Novice II —
  correct under either reading of "the middle of Novice". A brand-new
  account is meant to visibly start at the bottom of the ladder now,
  not already in the middle tier.
- **Placement games (the first 5) apply DOUBLE the MMR delta** —
  `applyRankedMmr` (`db.js`) multiplies `computeMmrChanges`' output by 2
  before applying it, for exactly as long as `placement_games_played < 5`
  when the game started. This is what gets a genuinely skilled new
  player up near their real rank quickly from the 250 starting point,
  instead of crawling there one normal-rate game at a time. Whether a
  given result counts as a placement game is read from the row's
  placement count from BEFORE that game (`SELECT ... FOR UPDATE` inside
  a transaction, so two results finishing for the same account back to
  back can't both read the pre-increment count and both double). An
  account with no `ranked_stats` row at all is treated as mid-placement
  by definition, so its very first ranked result is doubled too.
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

## Achievements & cosmetics (crests, titles, scenes, card fronts)
- **One registry, in `server.js`, and it is the only authority.**
  `ACHIEVEMENTS` (12 rows) and `COSMETICS` (scenes / cardFronts / crests
  / titles) define everything; `evaluateAchievements` is the single
  evaluation point, and `saveCosmetics` re-validates every incoming ID
  against a freshly evaluated unlock set. The client carries a parallel
  table of **presentation only** (crest SVG art, scene CSS, display
  strings) keyed by the same IDs — it never decides what's unlocked, so
  a crafted socket message can't equip something unearned.
- **Unlock state is NEVER stored.** It's always re-derived from
  `achievement_stats` against the thresholds in the registry. So
  retuning a threshold takes effect immediately for everyone, and the
  two can't drift apart — the deliberate cost is that lowering a
  threshold retroactively grants, and raising one retroactively revokes.
  Only what's *equipped* is persisted (`player_cosmetics`), and an ID
  that's no longer unlocked is filtered out on read (`filterEquipped`)
  rather than migrated, so removing a cosmetic is safe.
- **`achievement_stats` is a THIRD, mode-agnostic counter table** — not
  new columns on `stats`/`ranked_stats`. Those two are strictly
  separated pipelines (see Accounts & stats); "win 25 games" is meant to
  count every mode, so folding it into either would break that
  separation or need the counter kept twice and summed at read time.
  Nothing in it is displayed as a statistic.
  Peak MMR is the exception and is deliberately NOT mirrored here:
  `ranked_stats.mmr_highest` already has it and `getAchievementStats`
  LEFT JOINs it, because rank must never be computed a second time.
- Write points, all through `trackStat` like every other stat write:
  `resolveTrick` (queen taken — outside the casual/ranked branch AND
  outside its `!G.daily` guard, since taking the queen in the Daily
  Challenge is still taking the queen), `dealRound` (dealer rounds, once
  per hand actually dealt, so a 16-round game counts 16 and a Blitz 4),
  and `recordGameFinishedForAll` (one `recordAchievementGame` call
  carrying every per-game flag at once rather than six round trips).
- `recordGameFinishedForAll(G, natural)` gained a second argument.
  `finishEarly` passes `false`, the natural round-exhaustion path passes
  `true` — the only difference that matters, and only to The Silent
  Dealer. A win is the highest final score, and a **tie counts as a win
  for everyone tied**: the game has no tiebreak rule, so inventing one
  just to deny an achievement would be worse than being generous.
- `p.suitsWon` is a GAME-scoped accumulator on the player object (Four-
  Suit Master). `p.tricks` can't serve — `dealRound` clears it every
  hand, so by the final round it only describes that hand. Reset in
  `startDraw` when `round === 1`.
- **Scenes and Royal Court are one attribute on `<html>` and everything
  else is CSS.** No render function is aware either exists, which is
  what keeps the hand-tuned `--cw`/`--overlap`, hit-testing and drag
  code untouched. Royal Court's skin keys entirely off the `data-r`/
  `data-s` attributes `cardHTML()` already emits. **Real-art card fronts
  (Noir Casino, Bold Deck — see that section below) are the one
  exception** — real per-card art can't be conjured from attributes
  alone, so `cardHTML()` gained one additive line for it. Geometry is
  still untouched either way; see that section for how it stays that
  way. This mechanism was originally built for Nocturne Deck, which has
  since been deleted from the game entirely (id, art, everything) — Noir
  and Bold are what it actually serves now.
- **The Royal Court frame lives on `.card::before`, not in
  `box-shadow`** — `.card.tap:active`, `.card.sel`, `.card.dragging` and
  `.card.received` all replace `box-shadow` outright, so a frame drawn
  there would vanish exactly when a card is picked up. `::after` is left
  alone; `.card.received` owns it.

## Nocturne Deck card front — DELETED
- **Removed from the game entirely, not deprecated gradually**: the
  `cardfront_nocturne` catalog entry, `public/cardfronts/nocturne/` (52
  files), and every client-side reference (`CARDFRONT_IDS`,
  `CARDFRONT_ATTR`, `CARDFRONT_ART_SETS`, the `data-cardfront="nocturne"`
  CSS rule) are all gone. Same "art AND ids, not just unlisted" call as
  the original 20-avatar set and the first scene batch.
- **The real-art architecture it introduced did NOT go with it.** Royal
  Court is a pure CSS re-skin of the glyph markup; a 52-portrait
  illustrated deck can't be approximated in gradients, so Nocturne was
  the first card front where `cardHTML()` needed to emit something extra
  (`.card-art`, `cardFrontArtImg()`, the `.has-art`/`.ix,.big` hide rule).
  That mechanism now belongs to Noir Casino and Bold Deck (see below) —
  the section documenting it lives with Royal Court's own architecture
  note earlier in this file, retitled from "Nocturne Deck" to "real-art
  card fronts" rather than deleted, since Noir and Bold both still run on
  it verbatim.
- **`cardfront_royal_court` is untouched** — still achievement-only
  (`unlock:'ach_queen_hunter'`, no price), exactly as it's been since
  Nocturne took over its shop slot and then itself went away. Nobody who
  owns or would earn Royal Court loses anything.
- If real-art crops are ever redone for Noir/Bold, the cropping notes
  that were here (contact-sheet measurement, per-row height variance,
  2× Lanczos upscale) are preserved in git history on this file, not
  copied forward — they described a source sheet that no longer ships.

## Noir Casino card front (shop-exclusive, no free route)
- **The first cosmetic with NO earn-it-for-free path at all.**
  `COSMETICS.cardFronts`: `{ id:'cardfront_noir', unlock:null,
  price:CREDIT_PRICES.epic }` — `unlock:null` with no `price` has always
  meant "always free" (Classic, the default scene); this is `unlock:null`
  **with** a price, which is a genuinely new combination every earlier
  item avoided by always pairing a price with an achievement.
  `cosmeticsFor`'s `unlocked` formula needed one word for this: was
  `!c.unlock || done.has(c.unlock) || bought.has(c.id)`, now
  `(!c.unlock && !c.price) || done.has(c.unlock) || bought.has(c.id)`.
  Verified against all four existing shapes before shipping it (free/
  no-price, gated/no-price, gated/priced, and the new priced/ungated) —
  only the new shape's result actually changes.
- **Client shows "Shop exclusive" instead of the generic "Locked"** when
  an item has a price but no `unlockName` at all — the fallback text a
  purely-achievement-gated locked item still uses. Saying "Locked" on a
  shop-exclusive item would wrongly imply some non-purchase path exists.
  The picker's price hint (`"600 in the Shop"`, next to Nocturne's
  requirement line) is suppressed for this item specifically — it already
  says "Shop exclusive", so repeating the price there is noise; the real
  price and Buy button live on the Shop screen itself, unaffected by any
  of this (`shopItemHTML` was already generic enough to need zero
  changes for a no-unlock item — `earned = item.unlocked && !item.owned`
  is false until purchase makes both true together).
- **Same crop methodology as Nocturne, adapted for a near-white sheet.**
  `Cardfront Noir 20s.png` (1536×1024, cards edge-to-edge with thin
  drop-shadowed borders on a white page) couldn't use Nocturne's
  dark-background threshold — card and gutter are both near-white, only
  ~10 luminance units apart. Column-**minimum** (not average) luminance
  over the full row height is what separated them cleanly: a gutter
  column never has anything drawn on it so its minimum stays ~250+ the
  whole way down, while every card column dips low somewhere (ink, the
  border line, a corner curve) even where a naive single-slice scan
  would have caught a blank patch and misread it as a gutter. A ≥5px
  run-length filter rejects small blank interior patches from being
  misread as gutters. Confirmed clean: 12 gutter bands for 13 columns,
  5 row-bands for 4 rows, both matching exactly.
  This sheet's card order is **A first**, not last (`A,2,3,...,10,J,Q,K`)
  — do not assume Nocturne's column order carries over to a new sheet;
  re-measure per sheet.
  `public/cardfronts/noir/`, 52 files, ~6KB each (smaller than Nocturne's
  ~10KB — this source has less fine detail to encode). Same 2× Lanczos
  upscale, same WebP settings, same "not in `sw.js` ASSETS, runtime-
  cached" treatment.
- **Named after the existing "Noir Casino" avatar collection**
  (`AVATAR_COLLECTIONS` in `server.js`: The Gambler, The Dealer, Femme
  Fatale, The Detective...), not the source filename's "Noir 20s" — the
  collection identity already exists in this codebase, so the card front
  reuses it rather than inventing a second name for the same aesthetic.
  It does NOT touch that avatar collection or its own unlock rules in
  any way; the two are unrelated systems that happen to share a name.
- **Same card-back omission as Nocturne, for the same reason.** The
  source sheet doesn't include a back at all in this case, so there was
  nothing to decide either way.
- **Verified end-to-end** against the exact same harness as Nocturne:
  a real 13-card hand renders with `has-art` on all 13 and the fallback
  glyphs hidden; switching away stops `cardHTML()` emitting any art at
  all; the My Account picker shows "Shop exclusive" with no
  achievement-style requirement; the Shop screen shows 5,000 credits and
  a working Buy button that emits only an id and token; the
  under-5,000-balance state correctly disables to "Not enough"; and both
  `server.js` and the inline client script still parse clean.
- **Two things this "verified end-to-end" pass above actually got wrong,
  both found later by the player on a real device, not by any harness:**
  1. **The crop was geometrically correct but the wrong shape.** The
     column-minimum/row-gutter method measured the card art's own true
     silhouette accurately — but that silhouette is ~0.46 wide:tall
     (roughly 110×230px per card in the source sheet), narrower than the
     app's 5:7 card box. `.card-art{object-fit:cover}` scales *up* to
     fill the box's width, which pushed the excess height off both the
     top and bottom — reported as "too zoomed in, top and bottom not
     visible". Nothing was actually lost from the crop; the box just
     didn't match what was cropped. First fix (v12): padded each of the
     52 cards (symmetric, near-white `(254,254,254)` sampled from the
     sheet's own page background) to the box's own 5:7 ratio before the
     final resize to 500×700, matching Bold Deck's resolution. That
     traded the top/bottom crop for visible white bars down both sides —
     correct proportions, but reported as "not fitting" the other way.
     **v13, current**: same tight per-card crop, but stretched
     (non-uniform scale) directly to 500×700 instead of padded — full-
     bleed like Bold Deck, at the cost of a slight, barely-visible
     horizontal stretch to the art, on request. Files grew from ~6KB
     (original) to ~18KB (v12/v13, roughly the same either way).
  2. **"the fallback glyphs hidden" above was never actually true for
     Noir.** The CSS rule that hides `.ix`/`.big` once real art loads
     (`html[data-cardfront="X"] .card.has-art .ix,.big{display:none}`)
     shipped with only an `X="nocturne"` selector — there was no `X=
     "noir"` version at all, so Noir's plain corner glyphs were painted
     on top of its real art the entire time this card front existed.
     Extended to list `nocturne`/`noir`/`bold` explicitly (see that rule's
     own comment for why it can't be derived from `CARDFRONT_ART_SETS` in
     JS — it's pure CSS). Bold Deck was added in the same session and
     correctly included from the start; Noir was the one that had shipped
     broken.
  Both required an `sw.js` `CACHE` bump (v12, then v13 for the stretch
  re-export) — see that file's own note: overwriting a runtime-cached
  asset in place under its existing filename is invisible to a returning
  player without one, same trap as the v8/v11 entries above it.

- **Scenes are pure CSS gradient compositions, no image assets**, and
  that's a decision rather than a stopgap: eight full-bleed backgrounds
  would dwarf everything else this PWA pre-caches, and gradients need no
  art direction per viewport. **One definition serves both the
  full-screen `#scene-layer` and the 52px picker thumbnail** because
  every stop is a percentage — both carry `.scene-art` + `data-scene`,
  nothing is duplicated per size. A shared `.scene-art::after` central
  scrim guarantees the "keep the middle quiet" rule so an individual
  scene can't break card readability however busy its own layers are.
- `#scene-layer` is outside `#app` and BEHIND it (z-index 0 vs 1), plus
  `pointer-events:none` — structurally incapable of covering a card or
  a control. Verified by hit-testing the table centre and a card centre
  with a scene equipped. It's revealed only on the pass/play screens
  (`html.scene-on`, set by `show()` via `updateSceneLayer`): every other
  screen's text was contrast-tuned against the plain felt.
- `ddp.scene`/`ddp.cardFront` in localStorage are a **cache of what the
  server last said is equipped**, not a source of truth — purely so the
  right scene and card face are painted on the first frame (same
  anti-flash reasoning as the theme's inline `<head>` script). Every
  server response overwrites it; `doLogout` clears it.
- **Crests are inline SVG**, built from `var(--gold*)` so they follow the
  active theme — a raster crest would be stuck on whichever palette it
  was drawn in. Suit glyphs inside them are `<text>`, not emoji, for the
  reason the menu tiles document: emoji ignore `fill`.
- **`.cos-tab` is a THIRD tab family on `#s-personal` and none of the
  three may be merged**: `.acct-toptab` (Profile/Achievements/Friends),
  `.acct-tab` (login/signup), `.cos-tab` (Theme/Scenes/Cards/Crests/
  Titles, nested inside the Profile panel).
- **The `.cos-tabs` strip is five equal columns (`flex:1 1 0`), not
  content-sized.** Content-sized measured 405px against the 328px
  available in the account panel at 375px and pushed the last two tabs
  off a strip with no scroll affordance. Equal columns make the fit
  independent of label length and of whether a locked-count badge is
  showing. Labels are one word each and the full section name lives in
  each panel's own `.sec-label`; the locked *count* lives there too,
  because a padlock-plus-number badge measured wider than the space left
  beside the label and forced an ellipsis. The tab keeps only a 4px dot.
- **Clair needed a correction, measured not guessed** — and the active
  tab was the worst offender, i.e. selecting a tab made its label
  *harder* to read than its neighbours:
  `.cos-tab.active` 10.90/12.13/**2.12**/13.63 →  5.28;
  `.cos-req` 3.38/3.42/**2.33**/3.38 → 4.95;
  `.sec-count` and idle `.cos-tab` 3.40/3.43/**2.54**/3.39 → 6.17
  (Bordeaux/Émeraude/**Clair**/Marquee). Same failure and same fix as
  the existing `.acct-tab.active` correction — brass on a pale ground.
  Lives at the END of the stylesheet with the other Clair blocks:
  `.cos-tab.active` is a genuine 0,2,0-vs-0,2,0 tie only source order
  settles.
- **Titles are sent through `publicState`** (`p.title`), resolved ONCE at
  join time via `lookupTitle` — re-reading per broadcast would put a DB
  round trip in the hot path of every card played. In `joinRoom` the
  lookup happens **before** the seat-taken re-check, not after: every
  await is a window another socket can claim the slot in, and that check
  is what closes it.
- Shown in the My Account hero (under the name) and on the lobby seat
  rows. Deliberately **not** on the pass/play table: that vertical
  budget is spent, and a title line under `.tcap` would break it.
- Guests: everything is gated. No unlocks, no equipping, defaults only —
  "played today" style reasoning, an unlock is a fact about an *account*.
  The Table theme tab still works for them, unchanged.
- Adding an achievement = a counter in `db.getAchievementStats` + a row
  in `ACHIEVEMENTS` + crest art in `CREST_ART`. The crest, the title it
  grants, the Achievements tab entry and any cosmetic it gates all fall
  out of that. `scratchpad/check2.py`-style cross-file checking is worth
  redoing if you touch the registries — a mismatch between the server
  registry and the client art tables fails **silently** (blank
  thumbnail, dead scene, unequippable item).

## Rank tiers were RENAMED — `slug` is the key, `tier` is the label
- The eight tiers now display as **Novice / Apprentice / Player /
  Gambler / Ace / Master / Grand Master / Legend** (was Bronze / Silver /
  Gold / Platinum / Diamond / Master / Grandmaster / Legend).
- **The MMR thresholds are untouched.** This is a rename, not a
  re-tuning — nobody's rank moved, only what it's called.
- `RANK_TABLE` rows gained a **`slug`**, and the slug is the ORIGINAL
  bronze..legend key. That split is the whole trick: `rankForMmr` returns
  both, and everything mechanical keys off the slug —
  - `public/badges/*.svg`: all 22 filenames unchanged
  - `.tag.bronze` … `.tag.legend`: all eight CSS rules unchanged
  - `tierReached`, `RANK_COSMETICS`, and every `rankTier:` field
  — while only display strings use `tier`. **"Grand Master" contains a
  space**, so it could never have been a filename or a class name; if you
  ever key anything off the display name it will silently break at the
  top of the ladder.
- Client-side, `rankSlug(rank)` is the single accessor, with a fallback
  to the old lowercased-tier derivation so a stale cached client that
  predates the server sending `slug` still renders instead of showing
  broken badge images.
- The trap this actually sprang during implementation: `COSMETICS.titles`
  still carried capitalised `rankTier:'Silver'` values after
  `tierReached` moved to slugs, which would have locked **every rank
  title forever** — silently, since a locked cosmetic looks identical to
  one you haven't earned. Cross-file registry checking caught it; keep
  doing that when touching either side.

## Rank cosmetics (8 sets) and portrait avatars (20)
- **Eight rank sets, one per TIER, not per rank state.** The reference
  sheet defines eight; divisions within a tier share a look. Each set is
  avatar frame + nameplate + table badge, in a fixed *material* (paper,
  ink, velvet, brass, gold, royal, obsidian, diamond).
- Unlocked purely by reaching the tier, and **never revoked** — the check
  reads PEAK mmr (`ranked_stats.mmr_highest`), so a losing streak can't
  take a set away. Not purchasable.
- **The equipped rank set defaults to the HIGHEST unlocked**, not to a
  fixed entry: it's the one automatic cosmetic, so someone who never
  opens the picker still wears what they earned, and is re-dressed the
  moment they rank up. An explicit lower choice still wins
  (`filterEquipped` checks the stored value first).
- **Materials are deliberately NOT themed** per felt palette, unlike
  everything else. A rank is the same rank whatever table you're at, and
  the sheet specifies them as fixed materials — same reasoning that
  leaves card backs and `--ok`/`--warn` alone.
- **SIX tokens per material, not four, and the split is the whole design.**
  The plate's INTERIOR (`--rm-hi`→`--rm-lo`) and the frame METAL
  (`--rm-edge`/`--rm-metal-hi`) are independent, because in the sheet six
  of the eight tiers are a dark interior inside a bright metal frame — one
  "material colour" can't drive both. `--rm-ink` is text on the interior;
  `--rm-orn` is the ornament ink (emblem, corner pieces, inner hairline),
  which follows the metal except where the sheet names a different stone
  (obsidian's violet crystal, Legend's ice blue).
  **The table badge and the avatar ring read the METAL, not the
  interior** — deliberately. Keying them off the interior turned six of
  the eight badges into a near-black dot on the felt, and 9px on a
  `.tcap` is the one place a rank marker has to stay legible.
- Nameplate ink is measured against BOTH ends of its gradient, not the
  midpoint, and after the palettes were retuned to the sheet's own colours
  every one clears with room to spare rather than being nudged over the
  line: paper 8.88/6.93, ink 8.30/12.12, velvet 7.75/13.48, brass
  6.97/13.28, gold 11.86/14.43, royal 9.89/15.82, obsidian 10.50/14.11,
  diamond 8.40/13.90.
- **The nameplate is a Deco plaque in SIX layers, and one definition
  serves all three sizes.** Metallic border (the element), textured
  interior (`.rp-grain`), inner hairline + chamfered corners
  (`.rp-frame`), mirrored side corner pieces (`.rp-side` ×2 — the same
  SVG both sides, the right one flipped in CSS, which is what makes them
  a mirrored pair rather than two pieces of art to keep in sync), a
  top-centre emblem straddling the top edge (`.rp-em`) and a lower-centre
  lozenge (`.rp-foot`). Sizes are four `--rp-*` numbers, so `.sm` / base
  / `.lg` re-declare those and restate no rule.
  **Deliberately NOT `clip-path`'d into chamfered corners**, tempting as
  that is: the emblem and the foot both straddle the plate's edge on
  purpose and a clip-path on the host cuts both off flush. The chamfer is
  drawn by `.rp-frame`'s corner cuts instead.
  Progression is material / palette / ornament / emblem only — the
  silhouette is identical across all eight, which is the sheet's rule and
  what makes them read as one set.
- **`[data-material]` on the plate is the whole gate.** Without the
  attribute every decorative layer stays `display:none` and the padding
  drops to 0, so the same element is either a plaque or a bare wrapper.
  That's what lets the account hero keep it in the DOM permanently.
- **`rankPlateDressHTML` (decoration) is separate from
  `rankNameplateHTML` (decoration + tier text) because the hero needs
  the dressing only** — its content is a live `<input>` plus the title
  line, per the sheet's "decorative layer behind dynamic player text".
  `renderHeroCosmetics` rewrites `#pv-plate-art`, never `#pv-plate`, so
  re-dressing the plaque can't clear the name field or drop focus out of
  it mid-edit (verified: typed value and focus both survive an equip).
- The picker thumbnail plates are a **fixed 100×34 with the tier text
  hidden**. Sized to content the eight came out 68px ("Ace") to 111px
  ("Grand Master") wide and looked like eight different objects; the tier
  name is already the card's own `.cos-name` directly beneath. The thumb's
  own backing is a wash of `--rm-edge` (the metal), not the interior
  gradient — six near-black interiors gave six identical dark cells with
  the plaque invisible against its own backing.
- **Legend alone gets a shimmer, and only a restrained slow one** — the
  sheet grants it to that tier and pointedly to no other. It lives on
  `.rp-grain::after`, so it needs no seventh layer, and it has a
  `prefers-reduced-motion` off-switch.
- **Clair needed a correction and it's on the RING, not the plate.** The
  materials are un-themed, so the only adaptable part is the outer ring
  (built from `--ddp-scrim-rgb` for exactly this reason). Frame metal vs
  the hero card it sits on measures bordeaux 5.1–11.8, émeraude 5.1–10.8,
  marquee 5.9–12.4 — and Clair 1.2–2.6, with Novice the worst case of all
  at 1.01 for its parchment interior, i.e. the whole plaque very nearly
  disappears. The ring's alpha was walked up until it cleared 4.5 on BOTH
  sides of the join: `.62` gives 4.32 vs the card and 4.36 vs the
  parchment (from 1.95/1.97 at the shared `.32`). Warm ink at 62%, not
  black, so it reads as an engraved edge.
- **`input.hero-name-input`, not the bare class — this rule was inert for
  its whole life.** The generic form rule is `input[type=text]` (0,1,1)
  and sets the `font` SHORTHAND plus padding/border/background; a bare
  `.hero-name-input` (0,1,0) lost that tie outright, so the hero name
  rendered as an ordinary boxed 1rem DM Sans field instead of the 1.4rem
  Playfair display name it was written to be. Qualifying with the element
  type ties at (0,1,1) and this block is ~700 lines later, so source order
  settles it. `:focus` and `::placeholder` need the same treatment (their
  generic counterparts carry the extra pseudo too). Same family as
  `.theme-swatch-btn`/`.theme-card` and the tabular-figures block.
- **The brief's own asset IDs and paths were NOT adopted**
  (`rank_nameplate_novice`, `public/assets/cosmetics/rank/nameplates/`).
  The registry already ships `rank_<slug>` with art at
  `public/ranks/<slug>/plate.webp`, that ID is what's persisted in
  `player_cosmetics.rank_set`, and its own "extend the existing
  persistence mechanism" instruction is the one that governs. `rankSet`
  IS the brief's `rankNameplate`. **`server.js` and `db.js` are untouched
  by this** — the whole feature was already wired server-side.
- **The plate art landed — one exported plaque per tier, `public/ranks/
  <slug>/plate.webp`, all 8.** Each piece still renders its CSS
  treatment first and layers the file on top *if it exists* —
  `rankArtMissing` records a 404 per (slug, piece) for the session, so a
  missing asset costs exactly one failed request rather than one per
  render, and the badge piece (not supplied) still degrades to the CSS
  fallback exactly as designed.
  **Source and pipeline**: 8 reference PNGs (2172×724, one per tier,
  named by the DISPLAY tier — Novice/Apprentice/Player/Gambler/Ace/
  Master/Grandmaster/Legend, mapped to the slug order above), each a
  complete plaque on a near-black page with the tier name already baked
  into its own bottom lozenge — not a bare frame meant to be filled by
  `.rp-text`. Background removal couldn't use a global luminance
  threshold the way the white-page card fronts do: several materials
  (ink, obsidian) have a genuinely DARK textured interior by design, and
  a flat threshold would have punched transparent holes straight through
  it. Used a **flood fill from the image border** instead
  (`scipy.ndimage.label` on a near-black mask, keeping only the
  components that touch an edge) — background gets removed regardless of
  how dark it is, while any interior dark texture that isn't CONNECTED to
  the border survives untouched. Confirmed on Grandmaster (obsidian, the
  worst case): the black cracked-stone interior stayed fully opaque while
  the surrounding page and the light/lightning bleeding past the frame
  edges both went cleanly transparent. Trimmed to content and downscaled
  to 1100px wide (`object-fit:contain` means the exact resolution isn't
  load-bearing; this comfortably covers the `.lg` hero at real device
  pixel ratios without the ~2MB-per-file source weight) — final files
  56–92KB each, WebP quality 90.
  **`.rp-text` had to be added to the `has-art` hide rule** — it wasn't
  in scope for the six-layer CSS-fallback hide (`.rp-grain`/`.rp-frame`/
  `.rp-side`/`.rp-em`/`.rp-foot`) because it didn't exist when that rule
  was written for the *unartworked* plate, and the exported art's own
  baked-in tier lozenge makes it fully redundant now: without the fix,
  loading real art would show the tier name TWICE (once baked bottom-
  centre, once again from `.rp-text` dead-centre). Doesn't touch the
  account hero's separate `.nameplate-content` (the player's live name/
  title) — that was never `.rp-text` and was always meant to sit on top
  of the art, not be hidden by this rule.
- The table badge's fallback is the EXISTING `public/badges/*.svg`
  medallion — same rank, same moment, already on disk.
- **`rankBadgeHTML`'s `size` argument is optional and normally omitted.**
  It writes an inline `--rb`, and an inline custom property beats any
  stylesheet rule — passing a size made the `.tcap`/`.seat-name`
  overrides silently inert. Same inline-style trap as `.exit-row`'s
  margin and the `max-width:440px` wraps.
- **The table badge must cost ZERO vertical budget.** At 11px it grew
  each `.tcap` line box 12px→14px — three captions, 6px off a budget the
  `--ch` formula treats as spent. It still fitted (measured at 915×412
  and at the tightest documented 667×375, nothing clipped), but
  `.tcap .rank-tbadge` now sizes it to 9px with `vertical-align:middle`
  so it rides inside the existing 11.52px line box. Captions measure 12px
  again. **`scrollHeight === clientHeight` is NOT proof of fit on the
  table screens** — they're `overflow:hidden`, so overflow clips
  silently; compare `.mid`'s rect against `.table`'s instead.
- **The original 5-collection, 20-avatar set (Royal Court, Noir Casino,
  Emerald Society, Moonlit Occult, Grand Hotel) is GONE — replaced
  wholesale, not deprecated gradually**, on the requester's own call
  ("not happy with them in the end"). Their `public/avatars/` folders are
  deleted, not just unlisted, and their ids are out of `AVATAR_IDS`
  entirely. In their place: **one collection, "House Regulars", 7
  avatars** (`public/avatars/house-regulars/`) — real photo-illustration
  portraits rather than the original fantasy-roleplay art style. Stored
  in the SAME `accounts.avatar` column the emoji avatars use, not in
  `player_cosmetics`, for the same reason as before: an avatar is
  identity, already travels through `publicState` and every leaderboard
  query, and a second home would mean two sources of truth for what a
  player looks like.
- **Only 7, not 8.** An 8th source file ("the host", a wide open smile)
  existed when this was scoped but was gone from disk by the time of
  actual cropping — most likely evicted by OneDrive's on-demand sync in
  the gap between being shown and being processed. Nothing references
  it; it slots in as an 8th `AVATAR_COLLECTIONS` entry whenever the file
  resurfaces.
- **The source art is a 1254×1254 circular medallion with a BAKED-IN
  gold ring and house crest, not a bare portrait** — unlike the original
  20, which were plain face crops with no framing at all. That first
  created a real conflict: every avatar host in this app already draws
  its OWN state-reactive ring (`.avatar`, `.avatar-opt` — gold border on
  your turn, gold border when selected in the picker), so a second,
  PERMANENT gold ring baked into the source would compete with that.
  **The first 7 were initially cropped to remove the baked-in ring for
  exactly that reason** (13.5% inset, clearing it on every image), but
  this was later reverted — see the "all 12 now keep the ring" note
  below for why, and for what replaced it. Same 160×160, same
  supersampled circular alpha mask, same `public/avatars/<dir>/` layout
  as the set it replaced throughout — only the crop geometry changed.
- **`sanitizeAvatar` doesn't just allow-list the current ids before its
  8-char slice — it now also CLEARS a recognizable stale one instead of
  mangling it.** Previously any string failing the allow-list fell
  straight into `.slice(0,8)`, which existed to bound arbitrary emoji
  input. That's fine for real emoji, but a stale portrait id like
  `royal_king` (from a since-removed collection, no longer in
  `AVATAR_IDS`) would silently mangle into `royal_ki` and get stored as
  if that garbled text were a deliberate emoji-avatar choice. A
  plain-ASCII-letters-and-underscores value is never real emoji, so that
  shape is caught first and cleared to `null` instead — the SAME rule
  now applied client-side in `avatarHTML`, which used to just print
  raw text (`v ? esc(v) : ...`) whenever a value fell outside
  `AVATAR_ART`, and would have literally displayed the string
  `"royal_king"` in the UI for anyone whose account still had it stored.
  Both fixes are independent of which specific ids get removed — they'll
  hold the next time a collection is replaced too.
- Portrait avatars carry **no unlock condition**, deliberately: the sheet
  states one for the rank cosmetics and pointedly not for these, and the
  emoji avatars beside them have always been free. They need an account
  only because editing your identity already did.
- `avatarHTML(v, name, lazy)` is the single place an avatar value becomes
  markup. **`lazy` is opt-in and only the picker uses it** — the table
  rebuilds its seats' innerHTML on every `gameState` (every card played),
  so deferring those images re-runs the intersection check each rebuild
  and risks the avatar popping mid-trick, to save nothing.
- Not in `sw.js`'s `ASSETS` — the fetch handler runtime-caches them, so
  no `CACHE` bump is needed and installs don't pull the set up front.
- **A second batch of 5 (belle, countess, envoy, baron, castaway) joined
  the same `house_regulars` collection later, and — on the requester's
  own follow-up complaint that the first 7 were "zoomed in a bit too
  much" — they DELIBERATELY KEEP the source's baked-in gold ring/crest,
  the exact thing the first 7 were originally cropped specifically to
  remove.** That was the explicit resolution to a real crop-geometry
  conflict discovered while trying to fit these 5 the same way as the
  first 7: a crop tight enough to clear the ring left a cut-off sliver
  of the bottom crest ornament on at least one source image (measured —
  the crest's top edge sits only ~177px above the bottom edge on the
  worst case, more clearance than the ring itself needs), so there was
  no inset that satisfied both "no ring" and "no clipped ornament" at
  once. Shown side by side (ring-kept vs. ring-removed) before deciding;
  keeping the ring was the explicit choice, not a fallback.
  Crop is `inset=14` (not a ratio, unlike the first 7's original 13.5%)
  — measured directly against the source's luminance profile: pure
  black square-corner margin holds through x≈14, then jumps sharply as
  the ring becomes visible, so 14px trims exactly the transparent
  corners PNG export leaves outside the circular medallion and nothing
  else.
- **The original 7 were re-cropped to match, on the requester's own
  follow-up ask, retiring the ring/no-ring split above the same day it
  shipped.** Kept the ring on all 12 rather than the reverse (stripping
  it from the new 5 to match the old 7) — going back to a tighter,
  ring-free crop would have reintroduced the exact "too zoomed in"
  complaint that started this whole thread, where keeping the ring on
  everything has no equivalent downside beyond the app's own
  turn/selection ring reading as a double ring, which is a much smaller
  cost.
  **This source set (WhatsApp-exported JPEGs, not the second batch's
  clean PNGs) turned out to have wildly inconsistent margins between the
  ring and the frame edge — nothing like the second batch's uniform
  ~14px** — so the same "trim only the black corners" luminance-scan
  method that worked for the second batch was unusable here: measured
  per image, the ring-to-edge gap ranged from ~0px (touching the frame
  almost exactly) to ~60px, and varied by side within a single image
  too (one had a 58px gap on the left/right but only 14-17px on
  top/bottom). A single fixed inset would have clipped the ring on the
  tighter images and left visible slack on the looser ones.
  **Resolved by visually bisecting each image individually** — rendering
  actual candidate crops (not just reading raw luminance numbers, which
  were noisy enough on these JPEGs to give false margins from ring
  reflections and background candlelight) at a sweep of insets and
  picking, per image, the largest inset that still shows a clean, full,
  unclipped ring: `charmer`=10, `sharp`=15, `optimist`=15, `jester`=15,
  `scholar`=10 (bald head sits close to the ring's inner top edge, so
  kept conservative), `wildcard`=10, `closer`=15. Not a single shared
  constant — this source set doesn't have one usable value, unlike the
  second batch's clean 14px.
  Same supersampled circular mask / 160×160 / WebP pipeline as every
  other avatar batch, output files simply overwritten in place (same
  ids, same filenames — no `AVATAR_COLLECTIONS` change needed for this
  part).
- **The re-crop above still looked visibly tighter than the second
  batch, and it wasn't a crop choice — the WhatsApp-exported source
  files were themselves already framed tight**, confirmed by cropping
  at `inset=0` (the loosest possible, i.e. the raw file) and finding it
  nearly identical to the shipped `inset=10-15` versions. WhatsApp
  recompresses (and can crop) images on send, and the working theory is
  that this trimmed away headroom the original renders had before
  these 7 were ever exported through it. No amount of inset tuning can
  recover pixels that were never in the file.
  **Fixed by asking for, and receiving, the true originals** (not
  WhatsApp exports) for all 7 — same 1254×1254 template, but with the
  same generous headroom/background margin the second batch has. Once
  re-measured against these, the per-image "trim only the black
  corners" luminance-scan method worked cleanly again (unlike on the
  WhatsApp files, where it was unreliable): `charmer`=7, `sharp`=10,
  `optimist`=5, `jester`=8, `scholar`=2, `wildcard`=36, `closer`=36.
  `wildcard`/`closer` sitting far higher than the other five isn't
  noise — their sources simply carry a much wider black margin (visual
  sweep confirmed a clean ring at every tested value from 20 to 52), so
  a small inset would have left a visible black ring around the medal
  on just those two.
  All 12 avatars now read as one consistent set — verified via a full
  side-by-side contact sheet, not just per-image checks. Output files
  again overwritten in place under the same ids; no `AVATAR_COLLECTIONS`
  change needed.

## Credits — the second progression track
- **Parallel to MMR and never touching it.** Credits measure engagement,
  rank measures skill. Nothing in the credit system is read by
  matchmaking or by rank derivation, and nothing purchasable confers a
  gameplay advantage — those are the spec's first two non-goals and they
  are what the "crests and rank sets are not for sale" rule below
  protects.
- `computeGameCredits(placeIndex, totalScore, roundsPlayed, moons)` in
  `server.js` is the whole formula:
  `round(placementBase × clamp(1 + 0.02 × totalScore/roundsPlayed, 0.75, 1.25))
  + 10 × moons`, placement base 50/40/32/24.
  **Dividing by `roundsPlayed` is what makes it length-agnostic** — the
  same average pays 55 at 4, 8, 12 and 16 rounds, so Blitz needed no
  separate calibration. Verified against all six of the spec's worked
  examples (63/53/44/31/20/18), exact matches.
- `placementIndexes` is **standard competition ranking** — equal scores
  share a placement, so a tie for first pays both players the 1st-place
  base. Same generosity rule the win achievement already uses: the game
  has no tiebreak, so inventing one purely to pay someone less would be
  worse.
- **Ranked is uncapped; casual pays at most one game a day**, whoever the
  opponents are (not AI-only, as an earlier draft had it). That asymmetry
  is the entire point — ranked volume is the only route to credits at
  speed, which is the lever meant to pull players there.
- **Only a naturally finished game pays.** `recordGameFinishedForAll`'s
  `natural` argument is already false for the early-end vote, and that is
  exactly the case that must not pay — otherwise four players could vote
  out of a game one round in and farm it.
- **Every grant is idempotent, because `trackStat` retries.**
  `credit_transactions` carries `UNIQUE (account_id, type, reference_id)`
  and every grant is `ON CONFLICT DO NOTHING`, only moving the balance
  when a row was actually inserted. The reference is `code-startedAt` for
  a game (room codes alone get reused, so the code can't identify a game)
  and the date for a daily.
  **The casual day-claim had to become idempotent too, and this is subtle:**
  `claimCasualCreditDay` stores WHICH game claimed the day
  (`last_casual_credit_ref`). Without that the claim is atomic but not
  retry-safe — a grant that failed *after* the claim succeeded would, on
  the retry, find the day already taken and silently pay nothing.
- Daily: `5 + round(max(0, score) × 0.2)`, flat floor for showing up plus
  a multiplier on a positive finish only. Deliberately simpler than the
  multiplayer formula — one attempt a day, no placement, nothing to clamp
  against. **Calibration confirmed from the ruleset**, not guessed: a
  daily is one round, so a typical positive finish is +20..+30 → +4..+6
  bonus, exactly the spec's intended band; a moon (+60) tops out near +12.
- **Guests earn nothing anywhere**, and the daily payload zeroes `credits`
  for them rather than showing a figure that was never banked.

## The Shop and the ownership model
- **Purchasing is the ONE piece of cosmetic availability that is stored.**
  Everything else is still re-derived from `achievement_stats` on every
  call, so retuning a threshold still takes effect immediately for
  everyone. An item is available if it is achievement-unlocked **OR**
  purchased — `cosmeticsFor` ORs the two — which means a bought item can
  never be revoked by a retune, and the derived half keeps the property
  the achievements section documents.
- `player_purchases` is keyed `(account_id, item_id)`. `purchaseItem`
  inserts the row first and takes payment second, both inside one
  transaction: the balance guard lives in the `WHERE` (`credit_balance >=
  price`), so an over-spend updates no row instead of writing a negative
  balance.
- **Only scenes and card fronts are purchasable, and that's a rule, not a
  scoping accident.** Crests are 1:1 with achievements — a crest IS the
  visible proof of one, so a bought crest would be a lie. Rank sets are
  earned by reaching a tier and are documented as never purchasable;
  selling them would also make credits look like they touch rank.
  Neither carries a `price`, `buyCosmetic` only searches the two
  purchasable arrays, and `renderShop` renders only priced items — so the
  exclusion holds in three independent places.
- **The client never sends a price.** `buyCosmetic` emits an item id; the
  server re-derives the price and the funds check from its own registry,
  exactly like the unlock re-validation `saveCosmetics` already does.
- **The scenes' real achievement gates are back.** They were temporarily
  `unlock: null` so the photos were previewable before the shop existed
  (see `dedf411`'s own note). They now have both a gate and a price, so
  every one is reachable two ways. **Consequence to expect on deploy:** a
  scene someone equipped while it was temporarily free, but hasn't
  earned or bought, is dropped back to the default by `filterEquipped` —
  which is that function working as designed, not a bug.
- Prices are `CREDIT_PRICES` (common 600 / rare 2000 / epic 5000 /
  legendary 12000). Only common and rare are used so far; epic and
  legendary exist for the avatar frames and VFX that phase P1/P2.

## The credit chip (`creditChipSVG`)
- **Inline SVG built from `var(--gold*)` and `var(--felt-0)`**, for the
  reason the crests already document: a raster chip would be stuck on
  whichever palette it was drawn in, and the reference art is the Marquee
  palette specifically. From tokens it stays gold-on-emerald there and
  re-tints on Bordeaux, Émeraude and Clair.
- **ONE definition serves every size** — the 38px menu box, the 15px
  balance line, the 13px price tag — because the only input is `--cc`.
  The reference's crowned-queen profile is far too fine to survive 13px,
  so the centre resolves to a crowned spade: the same mark at any size.
- **Each instance gets a unique gradient id (`cc-metal-N`).** A gradient
  is referenced by fragment id, so emitting the same id from every chip
  meant duplicate DOM ids with every `url(#…)` on the page resolving to
  whichever chip was first. It renders correctly right up until that chip
  is re-rendered away — and the shop rebuilds its cards on every payload —
  at which point every other chip silently loses its metal.
- **The menu credits box lives in the identity RAIL, not the tile grid.**
  That's what keeps it clear of the landscape 2×3 tile budget this file
  warns is fully spent: the tiles are column 2, the box is column 1 under
  the tagline. Verified at 667×375 and 915×412 at 16/18/20px root font —
  zero overflow, last tile bottom unchanged at 361 of 375. It does eat
  some of the tagline row's `1fr` slack, so re-measure if anything else
  is ever added to that rail.
- Hidden entirely for guests, toggled from `updateMenuProfileUI` — the
  one function every login and logout path already calls, so visibility
  never has to be maintained from three places.

## Achievement ladders (4 tiers) - NEVER EXECUTED, see the warning below
- **20 achievements, each a LADDER of up to four rungs** rather than a
  single threshold. `achievementLevel(a, value)` counts rungs cleared;
  `evaluateAchievements` returns `{level, maxLevel, tiers, threshold,
  progress}` and still sets `unlocked = level >= 1`, which is what lets
  `cosmeticsFor`'s existing `a.unlocked` gating work completely unchanged.
- **One crest per achievement, gaining a LEVEL 1-4.** The client writes
  `data-level` on `.ach-crest`; art is keyed `(crest, level)` and rendered
  only if present, the same "drop the files in later, no code change"
  contract the rank plates (`public/ranks/<slug>/`) and scene art already
  use. **Most of the art still doesn't exist** - the CSS/inline-SVG crest
  shows through until it does. `crest_raven` (`ach_silent_dealer` /
  "Stayed the Course") and `crest_dealer_button` (`ach_the_dealer` /
  "Cut the Deck") now have real 4-tier art, at `public/crests/raven/1-4.webp`
  and `public/crests/dealer_button/1-4.webp` respectively - same
  1254×1254-medallion-cropped-to-512 pipeline as the other populated
  crests. The title is granted at **level 1**.
- **Every pre-existing achievement id is still here, on its original
  stat.** `COSMETICS` gates the scenes, the Royal Court card front and all
  twelve titles on those ids, and unlocks are re-derived on every read -
  so dropping one would silently un-equip whatever a player was wearing.
  Each old single threshold is now one rung of its ladder.
- **Thresholds are calibrated, not picked.** Queens 1/10/100/1000 is about
  250 games. Moons stop at **500** and ranked firsts at **750**: a moon
  lands in roughly 2% of hands and the AI actively defends against one
  (`oppMoonPace` / `moonPaceOwner`), so a 1000 rung would be ~3,000 games
  - not extreme, unreachable. Don't "tidy" these to a uniform 1000.
- **THREE REQUESTED ACHIEVEMENTS WERE IMPOSSIBLE AND ARE NOW HAND-LEVEL.**
  Worth keeping written down, because they will be proposed again:
  - **"+61 in one trick" cannot happen.** A trick scores +10 minus its own
    penalties, so +10 is the ceiling - the ruleset section above already
    warns about exactly this. It is now +61 in a **hand**, which means
    out-scoring a moon (+60) by ordinary play. A hand's ceiling is about
    +95 (take ten tricks while dodging the queen and the eleven highest
    hearts), so it is hard but reachable.
  - **"-60 in one trick" cannot happen.** The floor is -55: the queen
    (-26) plus the three highest hearts (-39), plus the +10 for winning
    it. As a hand it is fine - the floor there is about -88 (the queen
    plus twelve hearts over the minimum four tricks; you cannot take
    EVERY penalty card, because that is a moon).
  - **"win all 13 tricks" is unobservable as stated.** `resolveTrick`
    ends the hand the instant `checkMoon` succeeds, so the tricks after
    that are never dealt - lock the moon at trick 11 and you finish with
    11. It is measured as **every trick PLAYED**.
    **This is NOT the same event as shooting the moon**, which is the
    obvious wrong conclusion: you can take every heart and the queen while
    opponents win the penalty-free tricks, so winning every trick is a
    strict *subset* of a moon and much rarer.
- **NO ACHIEVEMENT COUNTS UNLESS THE GAME FINISHED NATURALLY.** The whole
  `recordAchievementGame` call is gated on `recordGameFinishedForAll`'s
  `natural` argument, which is false only for the end-early vote - so four
  players can't vote out one round in and farm the lot. It gates ONLY that
  call, deliberately not a `continue`: credits are gated separately just
  below, and the casual/ranked/blitz stat writes are **not** gated at all,
  because a statistic about an abandoned game is still true while an
  achievement for it is not.
  That would have made `gamesCompleted` identical to `gamesCompletedFull`,
  leaving The Silent Dealer measuring exactly what Card Master does - so
  `completedFull` now means **you were still in your own seat at the end**
  (`!G.players[i].isAI`). A player who leaves or is taken over keeps their
  `accountId` on the seat, so they still bank everything they personally
  did; they just don't get credit for seeing it through.
- **NOTHING BANKS UNTIL THE GAME FINISHES.** Queens taken and hands dealt
  used to write straight to the DB from `resolveTrick` and `dealRound`, so
  they could be farmed by abandoning game after game. They now accumulate
  on the room (`achBuf(G)`, lazily created - rooms are in-memory, so there
  is no migration) alongside slams, clean hands and best/worst hand, and
  flush **once** from `recordGameFinishedForAll`.
  **The queen has TWO write sites and they are easy to confuse** - this
  bit during implementation: `db.recordQueenTaken` inside the
  casual/ranked branch is a *casual statistic* and must keep writing
  immediately; the achievement one is the separate call below that branch.
  Buffering the wrong one silently breaks casual stats.
- Counters are indexed by **seat**; the account is resolved once, at the
  flush, so a seat that changes hands mid-game can't misattribute what its
  previous occupant did.
- `db.js` gained seven `achievement_stats` columns via
  `ADD COLUMN IF NOT EXISTS`. Counters add; `best_*`/`worst_*` take
  `GREATEST`/`LEAST`, which makes them records rather than totals **and**
  idempotent under `trackStat`'s three retries.
- **Secrets leak nothing.** `evaluateAchievements` blanks `name`, `desc`,
  `tiers` and `threshold` server-side for an unearned secret rather than
  trusting the client to hide them - the whole cosmetics payload goes over
  the wire, so a crafted client would otherwise just read them out.
  `cmp:'lte'` inverts the comparison for the two stats that move downward.
- **THE WARNING.** No Node runtime was available in the environment that
  built this, so **no SQL and no socket handler in this change has ever
  been executed**. What *was* verified: a cross-file checker confirming
  every achievement resolves a stat `getAchievementStats` actually
  returns, tiers monotonic in the direction their `cmp` implies, `names[]`
  matching `tiers[]`, every granted title declared, every `COSMETICS`
  unlock pointing at a real id, every field passed to
  `recordAchievementGame` accepted by it, and every `db.*` call exported;
  plus the client rendered against a payload shaped like the new response
  across tiered / locked / maxed / single-tier / both secret states.
  **Run it against a throwaway Postgres before trusting the schema
  migration or the flush path.**

## Campaign prologue cinematic
- **Gated purely on "has this account seen these cues before", the same
  mechanism every other story cue already uses** — deliberately NOT also
  tied to campaign progress (no `highestUnlockedLevel`/level-1-result
  check). This was tried and reverted: it correctly stopped an
  already-progressed account from getting the cinematic sprung on it,
  but it also meant testing the prologue required resetting an account's
  entire campaign progress (`campaign_level_results` +
  `highest_unlocked_level`), not just its seen-cues. Kept simple instead
  — clearing `story_cues_seen` alone is enough to make an account see it
  again. **Real consequence to expect on deploy**: since these seven cue
  ids are brand new, every EXISTING account — at any chapter, any
  level — has none of them in `storyCuesSeen` yet, so the cinematic will
  play for them too on their very next campaign visit, not just for
  brand-new players. Accepted deliberately rather than guarded against.
- **Plays once ever per account**, before the campaign map's existing
  Level 1 `chapterEnter` dialogue ("First time here?"). Covers the
  screenplay's opening EXT. CITY STREET beat that nothing had rendered
  before now — the motorcar, the envelope, the invitation, the walk to
  the facade — ending exactly where `chapterEnter` already begins
  ("The doors open. The CONCIERGE waits inside." → "First time here?"),
  so the two hand off without overlap or a gap.
- **Stored as ordinary story cues, not a parallel system** — seven
  `ccue(1, 'prologue', null, ...)` entries at the very end of
  `CAMPAIGN_STORY_CUES` in `server.js`, reusing the exact same
  `storyCuesSeen`/`markCampaignCuesSeen` persistence every other cue
  already has, so "seen" is server-authoritative and synced across
  devices rather than a `localStorage` flag. **They're appended at the
  END of the array specifically** — `ccue()`'s id embeds
  `_campaignCueSeq`, a running counter over file order, so inserting
  them earlier would have shifted every subsequent cue's id and
  silently replayed already-seen dialogue for real accounts. Any future
  edit to these seven lines is safe (their own ids are unaffected by
  edits to their own `text`); adding an eighth must still go after them,
  not before.
- **Narrator-only, `speakerId: null`, and that's what forks the
  rendering path.** Every other trigger goes through
  `campaignDialogueStep`/`#camp-dialogue` (the small speech-bubble card
  with a character portrait). The prologue's lines have no character to
  anchor a portrait to, so they're rendered by a dedicated client-side
  path, `campaignMaybeShowPrologue`/`#camp-prologue`, instead — a
  full-bleed cinematic, not a speech bubble.
- **Three photographed stills**, `public/campaign/prologue/1.webp` /
  `2.webp` / `3.webp` (downscaled to 1600px wide, ~135–195KB each, same
  WebP-from-source-PNG convention as every other art asset in this
  file). Not in `sw.js`'s `ASSETS` — runtime-cached on first use, same
  as scenes/avatars/rank plates. `CAMPAIGN_PROLOGUE_BG` (client) maps
  each cue's `bg` (1/2/3) to its file; `campaignPrologueSetBg` no-ops if
  the requested still is already showing (two consecutive cues share
  still 1), and otherwise fades out, swaps `src`, fades in.
- **The letter-reveal beat (still 2) carries no text of its own** — the
  invitation's copy ("ONE HUNDRED TABLES... COME ALONE. — DAME DE
  PIQUE") is baked into the still itself, not overlaid. Its cue has
  `hold: 2000` instead: the text box stays hidden, tap-to-advance is
  suspended (`campProlHolding`), and a Continue button fades in after
  2s — the one beat in this sequence that isn't tap-through, because the
  brief asked for a timed reveal there specifically.
  **`campProlHolding` is what stops a stray tap during those 2s from
  skipping the button entirely** — without it, the scrim's click
  listener would advance straight past the letter on the first tap.
- **Tapping anywhere on the scrim advances**, not just a button —
  `#camp-prologue`'s click listener fires on any tap except one that
  lands inside `#camp-prol-continue` (`closest()` check, since that
  button's own `onclick` already handles itself and the click still
  bubbles up). This works only because the background stills fill the
  whole scrim via `object-fit:cover` with no dead space — unlike
  `#camp-dialogue`'s scrim, which relies on empty padding around a
  smaller centered card and can't use a plain `e.target.id===scrim`
  check here.
- A permanent bottom-weighted `linear-gradient` (`.camp-prol-vignette`)
  sits over the stills independent of the text card's own panel
  background — both stills have bright highlights low in frame (the
  car's light, the wet pavement reflections), so the card alone
  wouldn't guarantee the text stays readable against every still.
- Own typewriter reveal (`campaignPrologueTypeText`, same per-character
  timing as `campaignTypeText`'s `CAMP_TYPE_MS`) rather than reusing
  that function directly — it's hard-wired to `#camp-dlg-text`, and this
  overlay needs its own typing/timer/full-text state for its own
  tap-to-complete-early behavior anyway, so sharing would only mean
  threading an element parameter through both call sites.

## Campaign dialogue portraits are `loading="eager"`, not lazy
- **Was `loading="lazy"` and that was a real, intermittent bug** —
  reported as "his images are not all fully inserted in all the
  conversations he had" about The Scholar specifically, though the
  mechanism isn't scholar-specific. `campaignDialogueStep()` replaces
  `#camp-dlg-portrait`'s innerHTML on EVERY line, even consecutive ones
  from the same speaker, so `campaignPortraitImg` builds a brand-new
  `<img>` per line and its lazy-load timer restarts from zero every
  time. A quick tap could dismiss a line before that line's fresh image
  had even started loading, leaving the SVG monogram showing instead of
  the real portrait for that one line, while a slower/longer line
  elsewhere in the same conversation loaded fine — "not every line",
  not "never". **The Scholar surfaced it because he has the most
  consecutive same-speaker runs of any character** — four "Woof."-style
  short lines in a row in both his `bossIntro` and `chapterExit` — so
  he's the character most likely to have a line dismissed before its
  image starts loading, not the only one capable of hitting this.
  Fixed by making `campaignPortraitImg` eager, same call already made
  for `campaignGoldImg` (gold medallions) for an unrelated reason —
  neither image is ever off-screen/deferred in a way lazy-loading could
  actually help with, so there was never a benefit to weigh against this
  cost. Portraits are small (a handful of KB) and already
  `campaignArtMissing`-gated against repeat 404s, so loading them eagerly
  costs nothing extra.

## Campaign AI seats show their character's real portrait at the table
- **Every campaign character already has real portrait art** at
  `public/campaign/characters/<id>.webp` — all 17 of them, including the
  "unnamed" regulars (`reg1..3`, `lounge1..3`, `lib1..3`, `cons1..3`,
  `rooftop1..2`, `glass_baron`, `concierge`). This was already true
  before this change and easy to miss: only the 5 characters who are
  ALSO an existing House Regular avatar (`the_sharp`/`the_scholar`/
  `the_wildcard`/`the_optimist`/`cons_guest`) are listed in
  `CAMPAIGN_PORTRAIT_SRC`; everyone else was always falling through to
  `campaignPortraitImg`'s own `/campaign/characters/${id}.webp` fallback,
  which was never a hypothetical placeholder path — the files were
  already sitting there. The only thing standing between that art and
  the actual table was the bug below.
- **The actual bug: every AI seat's avatar at the table, roster rail,
  round-summary sheet and final-standings row was hardcoded to the
  generic 🤖 glyph, unconditionally on `p.isAI`** — `seatHTML`,
  `rosterRowHTML`, the summary sheet's identity cell, and `finalRowHTML`
  all did `p.isAI ? '🤖' : avatarHTML(p.avatar,p.name)`, which never even
  looked at `p.avatar`. This bug predates the campaign feature entirely
  (it's the same expression used for a plain solo-vs-AI casual bot,
  where showing 🤖 is correct) — campaign just inherited it, so even the
  5 seatAvatar-dressed bosses were showing the robot glyph instead of
  their real photo the whole time campaign existed.
- **Fixed with a new field, `campaignCharId`, sent per-seat in
  `publicState`** — set in `createCampaignRoom` alongside `avatar`
  (`seatIds[i-1]`, the same id `campaignSeatCharacters` already resolves
  boss-substitution through), always `null` outside campaign rooms. All
  four render sites now check it FIRST: `p.campaignCharId ?
  campaignPortraitHTML(p.campaignCharId) : p.isAI ? '🤖' :
  avatarHTML(p.avatar,p.name)` — so a real campaign seat always renders
  through the same portrait pipeline the dialogue cards already use
  (real photo if `CAMPAIGN_PORTRAIT_SRC`/the characters/ fallback has
  one, the gold monogram badge otherwise — never actually the monogram
  in practice, per the note above), while a genuine generic bot (casual/
  ranked/daily solo-vs-AI) is completely unaffected, since
  `campaignCharId` is simply absent there.
  **`p.avatar` itself is untouched** — still set from `seatAvatar` for
  the 5 reused characters, just no longer the thing being read for
  rendering; kept in case anything else ever needs the underlying
  in-game avatar id rather than the campaign identity.
- `.avatar .camp-portrait{width:100%;height:100%}` is the one CSS
  addition this needed — `campaignPortraitHTML`'s existing per-context
  size rules (`.camp-corner-tr`/`.camp-boss-teaser`/`.camp-modal-opp`)
  only cover spots with no `.avatar` ancestor to size against; this one
  rule is what lets it drop into the bare `.avatar`, `.avatar.md` and
  `.ros-av.avatar` wrappers all four render sites already use, at
  whatever size each already resolves to, with zero new per-context
  rules. Relies on the same "explicit size beats `place-items:center`'s
  shrink-to-fit" mechanism `.av-img` already uses for the same reason.

## Level-detail popup — two columns, not one long stack
- **The level's main goal now sits right next to the level name**
  (`.camp-modal-headline`, baseline-aligned flex row, wraps to two lines
  for a long objective) instead of in its own boxed panel underneath —
  `campaignObjectiveParts(level)` replaced `campaignObjectiveHTML`,
  returning `{main, gold, dir}` separately instead of one combined HTML
  blob, since the caller now places `main` next to the title and only
  `gold`/`dir` in the small block beneath it. `dir` is deliberately
  returned as plain text (not pre-escaped) since the caller sets it via
  `.textContent`, unlike `main`/`gold` which carry `<b>`/`<i>` tags and
  go through `.innerHTML`.
- **"Best scores" moved from below to a second column on the right**
  (`.camp-modal-columns`, a two-column flex row), specifically so it
  stops being what forces the whole card to scroll. `.camp-modal-friends`
  already had `overflow-y:auto`, but every friend row still pushed the
  card taller first — the WHOLE card scrolled, not just the list.
- **`align-items:stretch` was tried first on `.camp-modal-columns` and
  reverted — it doesn't actually solve the scrolling problem, it just
  relocates it.** With stretch, the row's height is the taller of the
  two columns' own natural content heights, and the right column's own
  content (label + your row + every friend) has nothing bounding IT
  either — so a handful of friends still grows the right column past the
  left column's height, which stretch then applies back to the LEFT
  column too, and the row (and the card) is exactly as tall as before,
  just for a different reason. Confirmed empirically: at 6 friends the
  card measured `scrollHeight 415` against `clientHeight 361` — still
  scrolling.
- **The actual fix is `align-items:flex-start` plus a fixed
  `min-height:150px;max-height:200px` on `.camp-modal-side-col`** —
  concrete numbers, measured against the left column's own real content
  height (≈165px for a plain level, ≈195px for a boss level's extra sub
  line), not an attempt to dynamically match it. This decouples the two
  columns entirely: the left column is always exactly as tall as its own
  content regardless of friend count; the right column ranges between
  150–200px regardless of friend count (a short list doesn't look like
  an empty stub, a long one scrolls via `.camp-modal-friends{flex:1;
  min-height:0;overflow-y:auto}` inside that fixed ceiling instead of
  ever pushing the row taller). Verified with 0, 6 and 20 fake friend
  rows at both 915×412 and 667×375 (the smallest realistic landscape
  phone): `card.scrollHeight === card.clientHeight` in every case — the
  outer card never needs to scroll — while the friends list's own
  `scrollHeight` correctly exceeds its `clientHeight` (774 vs 117 at 20
  friends) and scrolls internally.
- `.camp-modal-card`'s `max-width` grew from 440px to 560px to give the
  two columns room — this modal only ever opens over the campaign
  screen, which is landscape-only, so the extra width is never fighting
  a narrow portrait viewport.

## STORY BOX narration cues (inline, not the prologue's cinematic)
- **A second, much smaller kind of narration than the prologue
  cinematic** — sourced from a separate reference doc
  (`Dame_de_Pique_Story_Boxes_..._Insert_Guide.md`, not checked into the
  repo) that maps narration lines the original screenplay pass missed,
  each anchored to an exact `INSERT AFTER` / `INSERT BEFORE` position
  relative to the existing spoken lines. Unlike the prologue, these
  don't get their own background stills or full-bleed overlay — they're
  narration inserted INLINE into the ordinary per-level cue sequence
  (`preLevel`/`postClear`/`chapterEnter`/etc.), shown in the same
  `#camp-dialogue` card the spoken lines already use.
- **Still just `ccue(levelId, trigger, null, text)`** — the exact same
  `speakerId: null` convention the prologue cues already established,
  now reused for something structurally different. What's new is
  `campaignDialogueStep` itself: it computes `isNarration = !cue.
  speakerId` and, when true, empties `#camp-dlg-portrait`, skips the
  name, and toggles `.camp-dlg-narration` on `#camp-dlg-wrap` — CSS then
  hides the (now-empty) portrait slot and the name line, and italicizes
  the text, all within the SAME card markup a spoken line uses. No new
  DOM, no new overlay.
- **All of Chapters 1-5 (Prologue + Levels 1-50, every level this game
  actually has) are done.** The reference doc covers all 100 levels;
  Levels 51-100 (Cabaret of Oddities/The Jester and the Grand Ballroom/
  The Charmer onward) aren't in scope because those chapters don't exist
  in `CAMPAIGN_LEVELS`/`CAMPAIGN_CHAPTERS` yet — there is nothing to
  insert story boxes INTO until those levels are built, so that's
  follow-up work for whenever they are, not a gap in this pass.
- **Every insertion follows one rule for resolving a mismatch between
  the guide's anchors and this implementation's actual cue list**: this
  codebase already deviates from the master screenplay in real ways —
  Chapter 2 collapsed three rooftop players into two (their #3 lines
  reattributed, see `CAMPAIGN_CHAPTER_ROSTER`'s own note), several
  levels have extra "Added buildup" lines the screenplay never had (Level
  5/6's glass-swirl foreshadowing, Level 10's drink-banter cold open),
  and Level 50 restructured two of The Optimist's alternate midpoint
  stingers into one `pick:'random'` postFail line. Where a guide anchor
  and the literal current text disagree because of one of these, the
  fix follows the STATED anchor text, inserted immediately adjacent to
  it, rather than guessing at "the start" or "the end" of a bucket —
  except when the anchor is a scene/level heading (`INT./EXT. ... NIGHT`
  or `LEVEL N`), which always means "the very first thing in that
  level's sequence," ahead of any added banter too, since an
  establishing shot has to come before dialogue that assumes the scene
  has already started. **One box was skipped rather than forced in**:
  Level 50's "He lets the sentence sit for exactly one beat," anchored
  to a two-line exchange the postFail restructuring above collapsed
  into a single random-pick string — splitting a `pick:'random'` cue to
  fit a narration box in the middle would change what "one of these
  four lines chosen at random" means, so it's left out; see the comment
  at that level's `bossMidpoint`/`postFail` block.
- **Verified structurally, not level-by-level by hand**: a Python pass
  parsed every `ccue()` call out of the live file, grouped them into
  their `(levelId, trigger)` buckets, and confirmed the narration/speech
  interleaving matches what was intended for every one of the 49 levels
  touched. Two representative sequences (Level 10's `bossIntro`, mixing
  narration with the added drink-banter cold open; Level 26's `postClear`,
  where a narration "A beat." sits between "Correct." and "Woof.") were
  also driven live through `campaignMaybeShow`/`campaignDialogueStep` in
  a browser and the exact narrator/speaker order at each step confirmed
  against the plan.
- **`ccue()`'s id/order scheme had to change FIRST, before any of this
  could be inserted safely.** It used to embed a single counter running
  over the ENTIRE file (`_campaignCueSeq`), so a cue's id depended on
  every `ccue()` call before it in source order — inserting a STORY BOX
  anywhere but the literal end of the array (which is exactly why the
  prologue cues were appended there rather than woven into Chapter 1's
  early cues) would shift every later cue's id and silently replay
  already-seen dialogue for real accounts. Both Level 1 insertions
  needed to land in the middle of the file, at the very TOP of the cue
  list, which would have renumbered essentially every cue in the game.
  Fixed by keying the counter (and therefore `order`) per `(levelId,
  trigger)` bucket instead of globally (`_campaignCueSeqByBucket`) —
  `order` was already only ever compared within one filtered bucket
  (`campaignCuesFor`), so this changes nothing functionally. **This was
  a one-time mass id change** (every existing cue's id shifted once,
  since the scheme itself changed) but makes every FUTURE insertion,
  in any level, safe — it can now only ever renumber cues in that one
  level+trigger bucket, never anything outside it.

## Returning to the map re-centers on the level you just played
- **Was always re-centering on the account's frontier
  (`highestUnlockedLevel`)** regardless of which level the player
  actually just left — replaying an already-cleared Level 10 while your
  real progress sat at Level 34 would drop you back on Chapter 4 (34's
  chapter) instead of back where you were looking, Chapter 1 around
  Level 10. Reported as wanting to land back "on the level I played."
- **Fixed with one extra piece of state, `campaignReturnLevelId`**, read
  once by `renderCampaignMap`/`campaignRenderChapterView` in place of
  `highestUnlockedLevel` — for BOTH which chapter to show and which node
  to scroll to — then cleared immediately after. Deliberately NOT
  persisted or left set: a later plain `goCampaign()` (the menu tile, or
  the chapter nav arrows) must go back to showing frontier progress, not
  get stuck re-centering on a replayed level forever.
- **Only set by `goCampaignFromTable()`, a new wrapper used at every
  "back to the map FROM A TABLE" site** — leaving/forfeiting mid-game
  (`leftRoom`/`roomClosed`, when `d.campaign` is true) and the final
  screen's "Back to the Map" button. The menu tile keeps calling the
  plain `goCampaign()` directly, on purpose — opening Campaign fresh
  from the menu has always meant "show me where I am," and should keep
  meaning that.
- **Reads `S.campaignLevel`** (already sent in every `publicState` while
  `S.campaign` is true) rather than anything tracked separately, so it
  reflects whichever level was ACTUALLY just played — including a replay
  of an old one — with no new server-side field needed.
- **Deliberately does not touch `campaignNodeHTML`'s own `.current`
  pulse**, which still keys off `highestUnlockedLevel` alone. The glow
  marking "the real next level to play" must keep pointing at the actual
  frontier regardless of where the player scrolled off to replay an
  earlier table — only the chapter shown and the scroll position change.
- Verified by driving `goCampaignFromTable`/`renderCampaignMap` directly
  against a fake account sitting at Level 34 with Level 10 as the
  just-played level: first render lands on Chapter 1 ("Velvet
  Entrance") scrolled to Table 10, `campaignReturnLevelId` reads back
  `null` immediately after (confirming it was consumed), and a second,
  plain `renderCampaignMap` call on the same data correctly falls back
  to Chapter 4 ("The Carnival Lounge"), matching the frontier again.

## Boss teaser (top-right map corner) is 3x bigger, name below not beside
- `.camp-corner-tr` went from a horizontal row (30px portrait + name
  beside it) to a column (90px portrait, name centered underneath) —
  `flex-direction:column`, portrait sizing bumped 30px→90px on both of
  the (redundant, same-value) selectors that set it
  (`.camp-corner-tr .camp-portrait` and `.camp-boss-teaser>.camp-portrait`).
  Verified at both 915×412 and 667×375 across all 5 real chapters (Glass
  Baron/Sharp/Scholar/Wildcard/Optimist all render their real photo, not
  the monogram fallback) — the box tops out around 135px tall, well
  clear of the route below even on the shortest phone.
- **The "Carnival Lounge boss not there" report was the existing
  progressive-reveal gate working as designed, not a bug** —
  `campaignRenderChapterView`'s `bossGlimpsed = highestUnlockedLevel >=
  ch.levelStart+3` deliberately keeps the teaser empty until the player
  is a few levels into a chapter (Chapter 4 = Level 34+), matching the
  brief's "early levels: distant glimpse" pacing. Confirmed by forcing
  `highestUnlockedLevel` past that threshold in a fake payload and
  re-rendering Chapter 4 specifically — The Wildcard's real photo comes
  up correctly, so the asset/data pipeline for that chapter was never
  broken; the account that reported it likely just hadn't reached Level
  34 in-game yet (or was peeking at the chapter early via the nav
  arrows). Left as-is rather than "fixed", since removing the gate would
  be a real pacing/design change beyond what was asked.

## Campaign's home button opens a menu mid-hand, not a bare two-tap confirm
- **Campaign is the one mode where leaving is destructive** (it forfeits
  the attempt outright — see the ranked-vs-campaign distinction
  documented elsewhere), so the plain "tap the home icon twice" pattern
  every other mode uses is a real risk: one careless double-tap and an
  attempt is gone with no reminder of what was even at stake. `askLeave`
  now branches on `S.campaign` — campaign opens `#camp-leave-modal`
  instead of arming the button's own two-tap confirm; every other mode
  (casual/ranked/daily) is untouched.
- **The modal shows the same objective headline the level-detail popup
  shows before a hand starts** ("Table 34 — Win at least 6 tricks." /
  "Gold: win 9 or more." underneath), built via the same
  `campaignObjectiveParts()` the pre-game popup uses, plus a red
  "Tap to Forfeit" button. Deliberately no "At this table"/"Best
  scores" sections — this is a quick mid-hand reminder of the goal, not
  the pre-game popup, and campaign's tight vertical budget doesn't need
  a second copy of content the player already saw.
- **Built entirely from the live game state `S`** —
  `S.campaignLevel`/`S.campaignBoss`/`S.campaignObjective` (all already
  sent in every `publicState` while `S.campaign` is true) — never from
  `campaignData`/the map's own level list, so it works on a cold
  reconnect straight into a hand, before the map was ever fetched this
  session, the same reasoning `campaignChapterSlug` already documents
  for the table background.
- **One tap inside the modal is enough** — no second arm-and-confirm on
  the "Tap to Forfeit" button itself. Opening the modal (tapping the
  home icon once) is already the deliberate extra step that replaces
  the old double-tap; stacking another confirm on top of that would be
  redundant friction. Tapping the scrim background or the × still
  dismisses without forfeiting.
- Verified live: a normal level shows "Table 34" + the score objective,
  a boss level shows "Boss Table" + the boss's name as a subtitle, the
  Forfeit button emits `leaveRoom` with the room code and closes the
  modal, and a non-campaign game (`S.campaign` false) still gets the
  original "Tap again to leave" two-tap button behavior unchanged.

## Gold medallion art now covers all 50 built levels, not just 1-10
- `public/campaign/gold/<levelId>.webp` — Levels 11-50 added alongside
  the existing 1-10, all 40 processed from the same 1254×1254
  black-page medallion source art via the identical pipeline the rank
  plates and Noir card front already use: flood-fill background removal
  from the border (`scipy.ndimage.label` on a near-black mask, keeping
  only components that touch an edge — so a genuinely dark interior,
  like several of these medallions' deep red backgrounds, survives
  untouched while only the true black margin goes transparent), trimmed
  to content, resized to 160×160 (matching the existing 1-10 exactly).
  ~14-16KB each, three outliers (32/40/49, whose medallions use a
  lighter interior pattern with more color variation to encode) at
  ~26-27KB — still trivial for a runtime-cached asset.
- **`campaignGoldImg(levelId)` needed zero code changes** — it already
  builds `/campaign/gold/${levelId}.webp` generically for any level id
  (see its own `onerror` fallback-to-star contract); this was purely an
  asset drop-in;
  Levels 51-100 have no medallion source art yet since those chapters
  don't exist in `CAMPAIGN_LEVELS` at all — same "nothing to add it to
  yet" reasoning as the story-box narration pass above.
- Not added to `sw.js`'s `ASSETS` — runtime-cached on first use, same
  as every other campaign art (chapter backgrounds, character
  portraits). No `CACHE` bump needed either: these are brand-new
  filenames (`11.webp`…`50.webp`), not an in-place overwrite of
  already-cached ones, so the cache-first fetch handler just fetches
  them fresh the first time any of Levels 11-50 is cleared at Gold.

## Not implemented
- Password reset (no email service configured)
- Ranked Blitz (Blitz is casual-only on purpose — splitting MMR across
  two match lengths would fragment a ranked population that isn't large
  enough yet)
- **The rank plate artwork is done** — see the Rank cosmetics section for
  the full pipeline. **The table badge piece is still not supplied**
  (only `plate.webp` exists per tier); `rankBadgeHTML` keeps falling back
  to the existing `public/badges/*.svg` medallions, which is a perfectly
  finished look on its own, not a gap waiting on art.
  **Correction to the Rank cosmetics section's own file-path note:** it
  names a third piece, `frame.webp`, but no `rankArtImg(slug,'frame',…)`
  call exists anywhere — `.rank-framed` is CSS-only (a border/glow ring
  on the existing avatar well), so dropping a frame image in would
  currently do nothing. Wire a fourth `rankArtImg` call before shipping
  frame art.
- **Scene backgrounds — now wired, same contract as the rank art
  above.** Drop `public/scenes/<slug>.webp` (slug = the scene id with
  its `scene_` prefix stripped, e.g. `velvet_room`) and it layers over
  that scene's CSS gradient with no code change — `sceneArtImg`/
  `sceneArtMissing` near `SCENE_IDS`, `.scene-art-img` in `<style>`.
  Serves both the full-screen `#scene-layer` and the 52px picker
  thumbnail from the same file via `object-fit:cover`, so source art
  should be composed to survive both a tall-portrait/wide-landscape
  full-bleed crop AND a short wide strip — a roughly square source
  (~1200-1400px) with the important detail concentrated in the center
  ~60-70% is the safest bet against all three crops. Keep the true
  center calm regardless (cards render on top; the shared `::after`
  scrim darkens it but doesn't replace good composition). Not added to
  `sw.js`'s `ASSETS` — runtime-cached on first use, same as the 20
  portrait avatars.
- **Noir card front is done** (see its own section above) — it's out of
  this list now. The remaining three unimplemented card-front collections
  (Emerald, Occult, Grand Hotel) — the brief explicitly scoped the
  original build to Royal Court only, and Noir/Nocturne both arrived
  later as separate, standalone asks rather than through that brief.
- **Credit economy, deferred pieces.** Achievement credits (P1), Quick
  Match / Custom Game split (P1), avatar frames and the epic/legendary
  price tiers they'd fill (P1/P2), campaign unlocks (P2). Cut entirely
  from this phase per the spec: gifting, Weekly Tournament, and Cash
  Stakes (whose full design is preserved in the spec's appendix —
  `accounts.lifetime_credits_earned` is already recorded and ready to
  resume its mode-unlock role if it returns).

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
