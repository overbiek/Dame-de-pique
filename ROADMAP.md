# Dame de Pique — Launch Roadmap

Strict, cost-minimal sequence for taking Dame de Pique from a
feature-complete solo build to a real Android audience. Order matters more
than speed here — each phase exists because skipping it costs more later
than doing it now. Read `CLAUDE.md` for the technical architecture; this
file is the business/launch plan layered on top of it.

Also published as a formatted page: https://claude.ai/code/artifact/24d5d36c-5ffc-4dd1-8fa8-d2fb49d9df72
(private to Robin's claude.ai account — this file is the canonical, repo-tracked copy).

Last updated 2026-08-24.

## The verdict

The game itself is not the risk. Casual play against AI and friends, a full
MMR ranked ladder, daily challenges, a 20-ladder achievement system, an
entire earn-only cosmetics economy across crests/scenes/card
fronts/titles, eight table themes, friends, and stats are all built and
deployed — more depth than almost any solo card-game project reaches.

Two things are true right now that change the order of everything below:

1. Real accounts can be **permanently locked out today** — there is no
   password reset live yet. The backend for it is built and verified to
   load cleanly; the client-side UI is spec'd and ready for
   implementation (see `EMAIL_RECOVERY_SPEC.md`), but not wired up or
   tested end-to-end.
2. Ranked multiplayer is **unplayable with zero concurrent strangers** in
   it.

Casual + Ranked multiplayer, Daily Challenge, Blitz, the first-run
Tutorial overlay, and the achievement-ladder unlock path have now been
played by hand on a real device against the live Railway deploy and
confirmed working (2026-08-24) — that risk is closed. What's left in
Phase 0 is account recovery and basic error visibility.

None of that gets fixed by an app store listing or a marketing post — so
those wait until it's fixed.

## Where things actually stand

| Area | Status | Note |
|---|---|---|
| Core gameplay loop | **Live, verified** | Casual (AI + friends) and ranked MMR played by hand on a real device against the live Railway deploy |
| Tutorial, Blitz, Daily, achievement ladders | **Verified** | Played to completion on a real device (2026-08-24); the broader shop/purchase SQL surface behind achievements is unlock-path only, not fully re-verified |
| Account recovery | **Spec ready, not implemented** | `db.js`/`server.js` backend built and load-tested; client UI has an implementation-ready spec (`EMAIL_RECOVERY_SPEC.md`) but no code yet, so real users can still be locked out today |
| Cosmetics economy | **Done, and free** | Credits are earned by playing only — no real money touches the game anywhere right now. Keep it that way (see Phase 4) |
| Android packaging | **Not started** | PWA fundamentals (manifest, service worker, icons) already in place; the wrapping work is small once Phase 0–1 are done |
| Marketing / audience | **Zero** | No community seeding, no store presence, no content — a genuine zero starting point, which is fine this early |

## Phase 0 — Make it safe to hand to a stranger
**Cost:** $0–5/mo · **Time:** 3–7 days · **Blocks:** everything after it

Status: 1 of 3 done.

Nothing below is worth doing while these are open — a marketing push or a
store listing just points more people at the same broken paths, faster.

- [ ] **Close the account-recovery gap.** Backend is done (`db.js`,
  `server.js` — password-reset table, rate-limited reset-request/email
  flow via Resend's free tier, session invalidation on password change).
  Client UI is fully spec'd in `EMAIL_RECOVERY_SPEC.md` — forgot-password
  link, request-reset view, set-new-password view, the profile recovery
  email field, and the error-routing fix the spec calls out as easy to
  miss. What's left: implement the client UI from that spec, create the
  free Resend account and set the Railway env vars, then run the spec's
  manual test checklist end-to-end before this checks off.
- [x] **Actually run what's only been read.** Casual, Ranked, Daily
  Challenge, Blitz, Tutorial, and the achievement-ladder unlock path have
  all been played by hand on a real device against the live Railway
  deploy (2026-08-24) and confirmed working.
- [ ] **Know when it breaks.** Minimal error visibility — a free Sentry tier
  or a daily habit of checking Railway logs — so a launch-week traffic
  spike fails loudly to you instead of silently to your first users.

## Phase 1 — Seed real players before Ranked meets a stranger
**Cost:** $0 · **Time:** 1–3 weeks · **Blocks:** Phase 2

An empty ranked queue is the fastest way to lose a first-time player
permanently. Casual already solves this with AI — Ranked doesn't have
that safety net, and it's the mode you most want newcomers to trust.

- **Recruit 10–30 founding players by hand.** Not a broadcast — direct
  asks. Friends first, then a small number of general trick-taking /
  card-game communities (Reddit — r/cardgames and similar, Discord
  servers built around Hearts-style or trick-taking games, BoardGameGeek
  forums). English/international is the decided primary audience (see
  Phase 3), so seed in English-speaking spaces first rather than
  French-language ones specifically.
- **Fix before you scale.** Whatever this group finds gets fixed before
  Phase 2, not queued alongside it. A Play Store listing is a one-shot
  first impression — don't spend it on bugs this phase would have caught
  for free.

## Phase 2 — Package for Android
**Cost:** $25 one-time · **Time:** 2–5 days · **Blocks:** Phase 3

Deliberately third, not first. Everything here is mechanical once Phase
0–1 are actually done — shipping to a store before then just moves the
same unresolved risk in front of a colder, less forgiving audience.

- Wrap the existing PWA as a **Trusted Web Activity** with PWABuilder
  against the current manifest (no rewrite — it loads the live site).
- Add the Digital Asset Links file (`/.well-known/assetlinks.json`) so
  Chrome trusts it enough to hide the URL bar.
- Register a Google Play developer account ($25, one-time).
- Write the mandatory privacy policy (required — the app collects
  accounts and stats).
- Upload first to **Internal Testing**, not Production, for a final
  real-device pass.

## Phase 3 — Visibility, on close to no budget
**Cost:** $0, mostly time · **Time:** ongoing

A card game with real depth and no audience yet has one genuine
advantage: an actual, findable niche already exists for it. The job is
reaching that niche, not shouting into a general one.

- **Language is decided: English, for an international audience.** The
  app's name stays "Dame de Pique" — that's branding and flavor, not a
  language commitment — but the interface, store listing, and every
  marketing channel are English-first. Don't let the French name pull
  marketing effort toward francophone-only channels; it's a distinctive
  name for a game built for a general international audience, not a
  signal to niche down to French speakers.
- **Channels that match a real-time trick-taking game:**
  - Community seeding — the English-language trick-taking / card-game
    communities from Phase 1 (Reddit, Discord, BoardGameGeek), now with
    a store link.
  - itch.io listing — free HTML5/PWA distribution with its own discovery
    surface, low effort for a game already running in a browser.
  - A single Product Hunt launch — free, one good day of visibility if
    timed after Phase 2 is stable.
  - Short gameplay clips — trick-taking with real card art and a scoring
    swing is inherently watchable in 20–30 seconds; native to
    TikTok/Shorts, costs nothing but editing time.
  - ASO once listed — store listing keywords and screenshots in English.

## Phase 4 — Monetize, once there's real traffic to monetize
**Cost:** $0 to start · **Time:** gated on Phase 3

Ads or a support link in front of five daily players earns nothing and
just adds friction to the thing you're still trying to prove works. This
phase starts when Phase 3 shows real recurring usage, not on a calendar
date.

| Option | Verdict | Cost | Why |
|---|---|---|---|
| Unobtrusive web ads (AdSense-style) | **Start here** | $0 | Same page renders inside the Android wrapper — no separate SDK integration needed. Only worth turning on once there's traffic. |
| External "support the dev" link (Ko-fi / Buy Me a Coffee) | **Start here** | $0 | Voluntary, outside the app's purchase flow — no store billing integration required. |
| Real-money cosmetics | **Reject** | — | Contradicts what's already built — credits are earn-only by design. Keep it that way; it's a real differentiator, not a gap. |
| Paid supporter tier (extra stats, perks) | **Later, if ever** | real | Sold inside the Android app, this legally requires Google Play Billing integration — real engineering cost. Not before organic demand justifies it. |
| Real-money stakes / wagering on outcomes | **Do not build** | — | Severe Play Store policy risk, up to and including a full app ban. Already correctly cut from scope per `CLAUDE.md` — leave it cut. |

## Four ways to waste the work already done

- Don't list on the Play Store before password reset is actually
  implemented and tested, not just spec'd. A locked-out reviewer during
  Internal Testing is an easy 1-star before anyone's even played a hand.
- Don't spend money on promotion before Phase 1 proves the core loop
  holds up under real concurrent play. Paid reach just finds bugs faster
  and in public.
- Don't build any real-money purchase flow before organic traction
  justifies the Play Billing integration cost — it's real engineering
  time spent on a maybe.
- Don't let the French name pull Phase 3 effort toward francophone-only
  channels — the decided audience is English/international; treat French
  as a possible later translation, not the default lane.
