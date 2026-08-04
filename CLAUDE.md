# Dame de Pique

Custom online multiplayer Hearts variant. Node.js/Express/Socket.io backend
+ single-file HTML/CSS/JS frontend. Deployed on Railway, auto-deploys on
push to the connected branch.

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
  `SWIPE_SWITCH_GAP` (px) gates how far the pointer must travel before
  switching to a neighboring card — tune this, not the fan overlap, if
  swipe-selection ever feels twitchy or unresponsive again.
- Any layout depending on `.mystrip`/badge/button text length changing
  (e.g. "your turn") must reserve constant space (`visibility` toggle,
  not `display`/conditional markup) — a past bug had the strip resize
  and jump the whole screen on turn changes.
- Moon-shot celebration (`maybeShowMoonFx`, round-summary screen only):
  one-shot per round via `moonFxShownForRound`, same pattern as the
  existing pass-transition fx (`passFxShownForRound`) — guards against
  re-firing on every `gameState` broadcast while sitting on that screen
  (e.g. when other players' round-confirmations come in). Purely
  decorative/emoji-based (🌕/🚀), no new image assets.

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
