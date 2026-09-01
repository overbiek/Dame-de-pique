const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Accounts (optional — only active if DATABASE_URL is set) ─────
const DB_ENABLED = !!process.env.DATABASE_URL;
const db = DB_ENABLED ? require('./db') : null;
const bcrypt = DB_ENABLED ? require('bcryptjs') : null;
if (DB_ENABLED) {
  db.ensureSchema()
    .then(() => console.log('Accounts: database schema ready'))
    .catch(err => console.error('Accounts: schema setup failed —', err.message));
} else {
  console.log('Accounts: DATABASE_URL not set, account system disabled (guest play still works)');
}
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const loginAttempts = new Map(); // username_lower -> { count, resetAt }
function loginRateLimited(usernameLower) {
  const now = Date.now();
  const rec = loginAttempts.get(usernameLower);
  if (!rec || now > rec.resetAt) return false;
  return rec.count >= 8;
}
function recordLoginAttempt(usernameLower, failed) {
  const now = Date.now();
  let rec = loginAttempts.get(usernameLower);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 10 * 60 * 1000 };
  if (failed) rec.count++; else rec.count = 0;
  loginAttempts.set(usernameLower, rec);
}

// ── Password reset email (optional — only active if RESEND_API_KEY is
// set, same DB_ENABLED-style gating as the account system itself) ──
// Uses Resend's plain HTTP API via Node's built-in fetch (Node >=18, see
// package.json's engines field) rather than an SDK dependency — one POST,
// no new package to install or keep updated. Swap the fetch call for
// another provider's REST API later without touching any caller; nothing
// outside this function knows which provider sends the email.
const EMAIL_ENABLED = !!process.env.RESEND_API_KEY;
// Set this in Railway's env vars to your deployed origin (e.g.
// https://dameDepique.up.railway.app or a custom domain) once you have
// one — it's what the reset link in the email points back at. Falls back
// to a relative-looking placeholder so a missing var fails loudly in the
// email itself instead of silently linking nowhere.
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3000';
// Resend requires the FROM address's domain to be verified in your Resend
// account before it will actually deliver — their free tier includes a
// shared onboarding@resend.dev sender that works with zero setup for low
// volume, which is what this defaults to. Override with RESEND_FROM once
// you've verified your own domain there.
const RESEND_FROM = process.env.RESEND_FROM || 'Dame de Pique <onboarding@resend.dev>';
async function sendPasswordResetEmail(to, resetUrl) {
  if (!EMAIL_ENABLED) {
    console.log(`[email disabled] password reset link for ${to}: ${resetUrl}`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject: 'Reset your Dame de Pique password',
        text: `Someone (hopefully you) asked to reset the password on your Dame de Pique account.\n\n`
          + `Reset it here — this link works once and expires in 1 hour:\n${resetUrl}\n\n`
          + `If you didn't request this, you can ignore this email — your password hasn't changed.`,
      }),
    });
    if (!res.ok) {
      console.error('sendPasswordResetEmail: Resend returned', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    console.error('sendPasswordResetEmail error:', e.message);
    return false;
  }
}
// Same shape as loginAttempts — keyed by email this time, since the
// attack this guards against is spamming reset emails at one address
// rather than password-guessing one username.
const resetRequestAttempts = new Map(); // email -> { count, resetAt }
function resetRequestRateLimited(email) {
  const now = Date.now();
  const rec = resetRequestAttempts.get(email);
  if (!rec || now > rec.resetAt) return false;
  return rec.count >= 3;
}
function recordResetRequestAttempt(email) {
  const now = Date.now();
  let rec = resetRequestAttempts.get(email);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 60 * 60 * 1000 };
  rec.count++;
  resetRequestAttempts.set(email, rec);
}
// Fire-and-forget stats writes — a DB hiccup here should never affect the
// game itself, just get logged and silently skipped.
function trackStat(fn) {
  if (!DB_ENABLED) return;
  const attempt = (triesLeft) => {
    Promise.resolve().then(fn).catch(err => {
      if (triesLeft > 0) {
        setTimeout(() => attempt(triesLeft - 1), 400);
      } else {
        console.error('Stats tracking error (gave up after retries):', err.message);
      }
    });
  };
  attempt(2); // up to 3 total attempts — a real trick/round/game result should never be silently lost to a one-off connection blip
}
async function lookupAccountByToken(accountToken) {
  if (!DB_ENABLED || !accountToken) return null;
  try { return await db.findAccountByToken(accountToken); } catch (e) { return null; }
}

// ── Constants ───────────────────────────────────────────────────
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RV = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const SO = {'♠':0,'♥':1,'♦':2,'♣':3};
// Rounds-per-game is a per-room parameter now (Blitz), not a global.
// DEFAULT_ROUNDS is what every existing call site gets when it doesn't ask
// for anything, so the classic game is untouched.
const DEFAULT_ROUNDS = 16;
// Every option is a multiple of 4, which is what keeps the existing
// Left→Right→Across→Keep cycle intact: (round-1)%4 already lands Keep on
// the final round of a 4-, 8- or 16-round game, so no pass-cycle rework
// is needed and a Blitz game still uses all four pass directions.
const ROUND_OPTIONS = [4, 8, 12, 16];
function sanitizeRoundsTotal(n) {
  const v = Number(n);
  return ROUND_OPTIONS.includes(v) ? v : DEFAULT_ROUNDS;
}
// "Blitz" is just a casual room that isn't the full 16 rounds.
function isBlitz(G) { return !G.ranked && !G.daily && G.roundsTotal !== DEFAULT_ROUNDS; }
const AUTO_ADVANCE_MS = 60 * 1000;      // host has a minute, then it moves on by itself
const IDLE_CLOSE_MS   = 10 * 60 * 1000; // nothing happening at all
const EMPTY_CLOSE_MS   = 2 * 60 * 1000; // nobody connected
const END_VOTE_MS      = 60 * 1000;     // how long an "end early" request stays open
const ROUND_CONFIRM_MS = 20 * 1000;     // everyone has 20s to confirm "next round" before it carries on
const PASS_SELECT_MS   = 60 * 1000;     // a minute to pick a pass, then 2 random cards go instead
const MOON_FX_MS       = 2900;          // keep the round on the play screen this long so the moon-shot fx can finish
const RANKED_MIN_RADIUS = 100;
const RANKED_RADIUS_STEP = 100;
const RANKED_RADIUS_GROW_MS = 8000; // how often a queued player's search radius widens
const RANKED_RECONNECT_MS = 15 * 1000; // grace period before a disconnected ranked seat is handed to AI

const rooms = {};
const rankedQueue = []; // { socketId, accountId, name, avatar, mmr, placementGamesPlayed, queuedAt }

// accountId -> Set<socket.id>, live for exactly as long as a socket with
// that account attached is connected (set alongside every authOk emit,
// cleared on disconnect below). A Set rather than a single socket id
// because the same account can have more than one tab/device open at
// once; "online" just means the set is non-empty. This is the only
// source of truth for friend presence/invites — nothing here touches
// Postgres, it's pure in-memory and resets on every server restart,
// which is fine since it's rebuilt the moment a client's session resumes.
const accountSockets = new Map();
function notifySocketsForAccount(accountId, event, payload) {
  const set = accountSockets.get(accountId);
  if (!set || !set.size) return false;
  for (const sid of set) io.to(sid).emit(event, payload);
  return true;
}

// ── Helpers ─────────────────────────────────────────────────────
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let out = '';
  for (let i = 0; i < 5; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return rooms[out] ? makeCode() : out;
}
function makeToken() { return crypto.randomBytes(16).toString('hex'); }

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
  return d;
}
function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
// ── Seeded shuffle (Daily Challenge only) ────────────────────────
// Everything else keeps using crypto.randomInt above — this exists purely
// so every player who opens the Daily Challenge on the same UTC calendar
// day is dealt an identical 52-card deal, which is what makes comparing
// scores on a leaderboard meaningful at all.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function seededShuffle(a, seedStr) {
  const rnd = mulberry32(seedFromString(seedStr));
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
// The challenge "day" is UTC so the same deal is live worldwide at the
// same instant — a local-date key would give someone in Auckland a
// different puzzle than someone in Lisbon at the same moment.
function dailyDateKey(d) {
  return (d || new Date()).toISOString().slice(0, 10);
}
// Every seeded choice for a day gets its OWN seed string rather than
// pulling successive values off one stream, so the deal, the pass
// direction and the dealer are independent of each other — otherwise
// e.g. every "keep" day would share a family of deals.
// The first two draws are discarded because mulberry32's opening output
// is only weakly separated for nearby seeds, and these seed strings
// differ by a single date character.
function dailyPick(prefix, date, n) {
  const rnd = mulberry32(seedFromString(prefix + date));
  rnd(); rnd();
  return Math.floor(rnd() * n);
}
// The whole hand varies by day, not just the cards: which way you pass
// (or that you keep) and who deals are both drawn from the date too.
function dailyPassDir(date) { return PASS_DIRS[dailyPick('ddp-daily-dir-', date, 4)]; }
function dailyDealer(date) { return dailyPick('ddp-daily-dealer-', date, 4); }

function cardVal(c) {
  if (c.suit === '♥') return -RV[c.rank];
  if (c.suit === '♠' && c.rank === 'Q') return -26;
  return 0;
}
function sortH(h) {
  return [...h].sort((a, b) => SO[a.suit] - SO[b.suit] || RV[a.rank] - RV[b.rank]);
}
function eqC(a, b) { return a.rank === b.rank && a.suit === b.suit; }

const PASS_DIRS = ['left', 'right', 'across', 'keep'];
const PASS_LETTER = { left: 'L', right: 'R', across: 'O', keep: 'K' };
function passDir(round) { return PASS_DIRS[(round - 1) % 4]; }
function passLetter(round) { return PASS_LETTER[passDir(round)]; }
// These take a DIRECTION, not a round number. They used to derive the
// direction from the round themselves, which silently broke any room
// whose direction isn't a function of its round number — i.e. the Daily
// Challenge, whose single round draws a direction from the date seed.
function passTarget(from, dir) {
  if (dir === 'left')   return (from + 1) % 4;
  if (dir === 'right')  return (from + 3) % 4;
  if (dir === 'across') return (from + 2) % 4;
  return from;
}

function passSource(to, dir) {
  if (dir === 'left')   return (to + 3) % 4;
  if (dir === 'right')  return (to + 1) % 4;
  if (dir === 'across') return (to + 2) % 4;
  return to;
}

// The pass direction actually in force for a room's current round. Every
// normal room just follows the round number; the Daily Challenge pins one
// direction for its single hand, drawn from that day's seed, so it can be
// Keep one day and Across the next. Everything that used to call
// passDir(G.round) goes through here instead.
function roundPassDir(G) { return G.forcePassDir || passDir(G.round); }
function roundPassLetter(G, round) {
  return G.forcePassDir ? PASS_LETTER[G.forcePassDir] : passLetter(round);
}

function canPlay(G, pi, card) {
  const trick = G.currentTrick;
  if (trick.length === 0) {
    // The single card that opens a round can't be a heart or the Q♠.
    // Applies in every round; from the second card onwards anything goes.
    if (G.trickNum === 1) {
      const penalty = c => c.suit === '♥' || (c.suit === '♠' && c.rank === 'Q');
      // Only binding while the opener still holds something safe.
      if (penalty(card) && G.players[pi].hand.some(c => !penalty(c))) return false;
    }
    return true;
  }
  const led = trick[0].card.suit;
  if (G.players[pi].hand.some(c => c.suit === led)) return card.suit === led;
  return true;
}
function legalCards(G, pi) { return G.players[pi].hand.filter(c => canPlay(G, pi, c)); }

function trickWinner(trick) {
  const led = trick[0].card.suit;
  let best = trick[0];
  for (const t of trick)
    if (t.card.suit === led && RV[t.card.rank] > RV[best.card.rank]) best = t;
  return best.player;
}

function checkMoon(G) {
  for (let i = 0; i < 4; i++) {
    const t = G.players[i].tricks;
    const allH = RANKS.every(r => t.some(c => c.suit === '♥' && c.rank === r));
    const qs = t.some(c => c.suit === '♠' && c.rank === 'Q');
    if (allH && qs) return i;
  }
  return -1;
}

// ── AI ──────────────────────────────────────────────────────────
// The computer seats play like a careful, counting-aware human: full
// rule knowledge, real card counting (everything played this round is
// tracked, so "is this the highest X left?" is a hard fact, not a
// guess), and awareness of the moon shot (both chasing one themselves
// and breaking someone else's). None of this peeks at other players'
// hands — it only ever reasons from its own hand plus what's publicly
// been played, the same information a sharp human opponent would have.

// Cards the AI should mostly hold onto rather than pass or discard away:
// aces/kings (trick-winning power) and 2s/3s (always-safe cards to have on
// hand) in the plain suits.
function isKeeper(c) {
  return (c.suit === '♦' || c.suit === '♣') &&
    (c.rank === 'A' || c.rank === 'K' || c.rank === '2' || c.rank === '3');
}

// Every card that's been played so far this round: already-resolved tricks
// (captured by whoever won them) plus whatever's sitting in the trick in progress.
function playedCardsThisRound(G) {
  const out = [];
  for (const p of G.players) out.push(...p.tricks);
  for (const t of G.currentTrick) out.push(t.card);
  return out;
}

// How many cards of a suit are still unaccounted for this round (not yet
// played by anyone) — the core "count the cards" primitive everything
// else below is built on.
function suitRemainingCount(G, suit) {
  return 13 - playedCardsThisRound(G).filter(c => c.suit === suit).length;
}

// Total negative points still loose in the round: every heart not yet
// played, plus the Q♠ if she hasn't fallen yet. Lets the AI gauge how
// much danger is still in play versus how "clean" the round has gotten.
function penaltyPointsRemaining(G) {
  const played = playedCardsThisRound(G);
  let pts = 0;
  for (const r of RANKS) {
    if (!played.some(c => c.suit === '♥' && c.rank === r)) pts += RV[r];
  }
  if (!played.some(c => c.suit === '♠' && c.rank === 'Q')) pts += 26;
  return pts;
}

// True if `card` is provably unbeatable in its suit right now — every
// higher rank of that suit is either already played this round or
// sitting safely in my own hand (so nobody can play it against me). This
// is what "knowing when to take with an Ace" really means: an Ace always
// qualifies trivially (nothing outranks it); a King qualifies once its
// Ace is gone; and so on down the suit.
function isGuaranteedWinner(G, card, myHand) {
  const played = playedCardsThisRound(G);
  return RANKS.filter(r => RV[r] > RV[card.rank]).every(r =>
    played.some(c => c.suit === card.suit && c.rank === r) ||
    myHand.some(c => c.suit === card.suit && c.rank === r)
  );
}

// A single penalty card is too weak a signal of an actual moon attempt —
// it's routinely just an unavoidable early trick, not the start of a run.
// Below this, moonPaceOwner reports "no one" so the hard-rule defenses in
// applyHardRules/heuristicChoose don't relax around a false alarm; two
// people can't yet have crossed it and be picked as owner in the same
// call, since the second one to appear kills the moon outright below.
const MOON_PACE_MIN_CARDS = 2;

// Which player currently owns every heart/Q♠ trick captured so far this
// round — i.e. who (if anyone) is on pace to shoot the moon. -1 once two
// different players have each banked at least one penalty card, since
// the moon is then mathematically dead for the round. Also -1 while the
// sole holder is still under MOON_PACE_MIN_CARDS (see its own note).
function moonPaceOwner(G) {
  let owner = -1;
  let ownerPenaltyCards = 0;
  for (let i = 0; i < 4; i++) {
    const penaltyCards = G.players[i].tricks.filter(c => c.suit === '♥' || (c.suit === '♠' && c.rank === 'Q'));
    if (penaltyCards.length) {
      if (owner !== -1 && owner !== i) return -1;
      owner = i;
      ownerPenaltyCards = penaltyCards.length;
    }
  }
  if (owner !== -1 && ownerPenaltyCards < MOON_PACE_MIN_CARDS) return -1;
  return owner;
}

// Once an Ace (♣/♦) has already fallen, its King becomes the new highest
// surviving card of that suit — effectively a guaranteed trick-winner if led
// later. This estimates the odds it's still worth holding onto rather than
// giving it up in a discard: more tricks left in the round means more
// chance to actually get to lead it and cash in the free win.
function promotedKingKeepChance(G, card) {
  if (card.rank !== 'K' || (card.suit !== '♣' && card.suit !== '♦')) return 0;
  const aceGone = playedCardsThisRound(G).some(c => c.suit === card.suit && c.rank === 'A');
  if (!aceGone) return 0;
  const tricksLeft = Math.max(1, 14 - G.trickNum);
  return Math.max(0.35, Math.min(0.95, tricksLeft / 13));
}

// Rolls the keep-chance for each candidate and filters out the ones that
// "win" the roll (i.e. probabilistically protects promoted Kings).
function withoutProbableKeepers(G, cards) {
  return cards.filter(c => Math.random() >= promotedKingKeepChance(G, c));
}

// Ducking under a trick I'm not trying to win: which specific card I play
// doesn't change this trick's outcome, only my hand's future safety. Lots
// of the suit (or of danger generally) still unaccounted for → spend a
// middling card now and keep the true low card in reserve for a tighter
// spot later. Suit's thinning out, or the round's mostly clean already →
// there may not be another safe chance, so cash the low card in now.
function duckCard(cards, remainingOfSuit, penaltyLeft) {
  const sorted = [...cards].sort((a, b) => RV[a.rank] - RV[b.rank]);
  if (sorted.length <= 1) return sorted[0];
  if (remainingOfSuit > 6 || penaltyLeft > 40) {
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }
  return sorted[0];
}

function handRisk(hand) {
  const bySuit = { '♠': [], '♥': [], '♦': [], '♣': [] };
  for (const c of hand) bySuit[c.suit].push(c);
  for (const s of SUITS) bySuit[s].sort((a, b) => RV[a.rank] - RV[b.rank]);

  let risk = 0;
  const spades = bySuit['♠'];
  const hasQS = spades.some(c => c.rank === 'Q');
  const lowSpades = spades.filter(c => RV[c.rank] < RV.Q).length;   // guards to duck with
  const highSpades = spades.filter(c => RV[c.rank] > RV.Q).length;  // A♠/K♠

  if (hasQS) {
    // Holding the queen herself: danger shrinks the more low spades you have
    // to duck under a spade lead with until she can be unloaded safely.
    const guardFactor = Math.max(0.12, 1 - lowSpades * 0.20);
    risk += 26 * guardFactor;
  } else if (highSpades > 0) {
    // Queen-bait: holding A♠/K♠ without the queen risks being forced to
    // overtake and scoop her if someone else leads spades. More low spades
    // to duck with first makes this much safer. They're also the main tool
    // for hunting her down later, so they're not pure liabilities — a
    // small offsetting discount reflects that hunting value.
    const guardFactor = Math.max(0.10, 1 - lowSpades * 0.22);
    risk += highSpades * 9 * guardFactor;
    if (spades.some(c => c.rank === 'A')) risk -= 2;
    if (spades.some(c => c.rank === 'K')) risk -= 1;
  }

  // Hearts cost scaled by rank; the very top hearts get an extra penalty
  // since they're the hardest to unload without winning a fat trick.
  for (const c of bySuit['♥']) {
    risk += RV[c.rank] * 0.9;
    if (RV[c.rank] >= RV.Q) risk += 4;
  }

  // Being void (or near-void) in a suit is good: it lets you dump danger
  // cards for free whenever that suit gets led later in the round. This
  // also drives pass selection to prefer freeing up any suit already down
  // to 2-or-fewer cards.
  for (const s of SUITS) {
    const n = bySuit[s].length;
    if (n === 0) risk -= (s === '♠' ? 10 : s === '♥' ? 6 : 5);
    else if (n === 1) risk -= (s === '♠' ? 4 : s === '♥' ? 2 : 2);
    else if (n === 2) risk -= (s === '♠' ? 2 : s === '♥' ? 1 : 1);
  }

  // Keeper cards (A/K/2/3 of ♦/♣): discourage passing these away.
  for (const c of hand) {
    if (isKeeper(c)) risk -= 3;
  }

  return risk;
}

function aiSelectPass(G, i) {
  const hand = G.players[i].hand;
  const isHighHeart = c => c.suit === '♥' && RV[c.rank] >= 8;
  const lowHeartsBeside = c => hand.filter(x => x.suit === '♥' && RV[x.rank] <= 7 && !eqC(x, c)).length;
  const suitCount = s => hand.filter(c => c.suit === s).length;

  // Hard protections: 2♣/3♣ are only ducking-safe cover when there's a
  // real club suit behind them (3+ clubs held) — with fewer, they're not
  // "cover", they're the whole safe part of the suit, no different from
  // holding a lone one (see the singleton exemption below); hearts this
  // low cost almost nothing to hold onto; low/mid spades (2 through J)
  // are the guards that let a spade lead be ducked safely instead of
  // forcing a scoop of the queen; and A♦/A♣ are the trick-1 opening
  // leads (see the `openingAce` rule in applyHardRules and
  // heuristicChoose's own mirror of it) — passing either away throws
  // away a guaranteed safe trick-1 lead for whichever opponent receives
  // it. Never pass any of these away.
  const neverPass = c =>
    (c.suit === '♣' && (c.rank === '2' || c.rank === '3') && suitCount('♣') >= 3) ||
    (c.suit === '♥' && RV[c.rank] <= 5) ||
    (c.suit === '♠' && RV[c.rank] <= 11) ||
    ((c.suit === '♦' || c.suit === '♣') && c.rank === 'A') ||
    ((c.suit === '♣' || c.suit === '♦') && c.rank === '2' && suitCount(c.suit) === 1);

  // A club or diamond down to a single card is worth passing on even
  // though it would otherwise be protected: going fully void in that
  // suit is worth far more than the one card, since every future lead
  // in it becomes a free dump for a heart or the queen of spades. The
  // 2 is the one exception — it's already a guaranteed-safe card to be
  // stuck following with whenever the suit does get led, so there's
  // nothing this particular card buys by going void that keeping it
  // doesn't already give for free; see `neverPass` above, which protects
  // it instead of this forcing it away.
  const mustPass = hand.filter(c => (c.suit === '♣' || c.suit === '♦') && suitCount(c.suit) === 1 && c.rank !== '2');
  if (mustPass.length >= 2) return mustPass.slice(0, 2).map(c => ({ rank: c.rank, suit: c.suit }));
  const forced = mustPass[0] || null;
  const exempt = c => forced && eqC(c, forced);

  // Every two-card pass that includes the forced card (if any),
  // otherwise all C(13,2) combos.
  const pairs = [];
  if (forced) {
    const fi = hand.findIndex(c => eqC(c, forced));
    for (let b = 0; b < hand.length; b++) if (b !== fi) pairs.push([fi, b]);
  } else {
    for (let a = 0; a < hand.length; a++)
      for (let b = a + 1; b < hand.length; b++) pairs.push([a, b]);
  }

  // Keep whichever pass leaves the safest 11-card hand behind. A high
  // heart is only allowed to leave in a candidate pass if the hand
  // doesn't already have at least 2 low hearts (7 or under) to fall
  // back on — otherwise it's safer buried behind that cover and dealt
  // with later than handed away now. `level` relaxes the guards one at
  // a time (least-important first) for the vanishingly unlikely case
  // every combo got filtered, e.g. a hand that's nearly all protected
  // clubs/hearts — rather than jumping straight to "anything goes".
  function bestAt(level) {
    let best = null, bestRisk = Infinity;
    for (const [a, b] of pairs) {
      const c1 = hand[a], c2 = hand[b];
      if (level === 0 && ((!exempt(c1) && neverPass(c1)) || (!exempt(c2) && neverPass(c2)))) continue;
      if (level <= 1) {
        if (isHighHeart(c1) && lowHeartsBeside(c1) >= 2) continue;
        if (isHighHeart(c2) && lowHeartsBeside(c2) >= 2) continue;
      }
      const remaining = hand.filter((_, idx) => idx !== a && idx !== b);
      const r = handRisk(remaining);
      if (r < bestRisk) { bestRisk = r; best = [c1, c2]; }
    }
    return best;
  }
  const best = bestAt(0) || bestAt(1) || bestAt(2);
  return best.map(c => ({ rank: c.rank, suit: c.suit }));
}

// The old rule-based decision-maker. Kept in full — it's no longer the
// live decision for the AI's own turn (that's now Monte Carlo, below),
// but it's exactly what powers every simulated player (opponents *and*
// the AI's own hypothetical future turns) inside each sampled world.
// It's a strong, fast policy, which is what makes the simulations below
// worth trusting.
function heuristicChoose(G, pi) {
  const legal = legalCards(G, pi);
  if (legal.length === 1) return legal[0];
  const trick = G.currentTrick;
  const hand = G.players[pi].hand;
  const moonOwner = moonPaceOwner(G);
  const amMoonPace = moonOwner === pi;
  const oppMoonPace = moonOwner !== -1 && moonOwner !== pi;

  // ══ LEADING ══════════════════════════════════════════════════
  if (trick.length === 0) {
    if (amMoonPace) {
      // Nobody else has a single heart or the queen yet this round — worth
      // pushing for the full +60 rather than playing it safe. Only lead
      // the queen myself if I also hold both A♠ and K♠ (then nothing can
      // beat her); a guaranteed-winner heart is fair game to lead too,
      // since nothing can outrank it and it comes straight back to me.
      const spadesHeld = hand.filter(c => c.suit === '♠');
      const haveTopTwo = spadesHeld.some(c => c.rank === 'A') && spadesHeld.some(c => c.rank === 'K');
      const qs = legal.find(c => c.suit === '♠' && c.rank === 'Q');
      if (qs && haveTopTwo) return qs;
      const heartWinners = legal.filter(c => c.suit === '♥' && isGuaranteedWinner(G, c, hand));
      if (heartWinners.length) return heartWinners.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
      const safe = legal.filter(c => cardVal(c) === 0);
      const pool = safe.length ? safe : legal;
      return pool.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
    }

    // Trick 1: an Ace of ♦/♣ is a completely safe, guaranteed win with
    // zero information cost — play it immediately rather than let any
    // other consideration (even queen-hunting) make this decision instead.
    if (G.trickNum === 1) {
      const openingAce = legal.find(c => (c.suit === '♦' || c.suit === '♣') && c.rank === 'A');
      if (openingAce) return openingAce;
    }

    // Hunt mode: holding none of Q♠/A♠/K♠ means leading spades carries no
    // risk of scooping the queen myself — flush her out of hiding.
    const spadesHeld = hand.filter(c => c.suit === '♠');
    const hasTopSpade = spadesHeld.some(c => c.rank === 'Q' || c.rank === 'A' || c.rank === 'K');
    const qsHeld = spadesHeld.some(c => c.rank === 'Q');
    const qsCaptured = G.players.some(p => p.tricks.some(c => c.suit === '♠' && c.rank === 'Q'));
    const legalSpades = legal.filter(c => c.suit === '♠');
    if (!hasTopSpade && legalSpades.length && !qsCaptured) {
      return legalSpades.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
    }

    // Leading A♠/K♠ while the queen is still unaccounted for risks the
    // same thing overtaking does — anyone void in spades can legally dump
    // her straight into a trick we're about to win outright. Only exempt
    // when we hold her ourselves, she's already gone, or we're on moon
    // pace (then capturing her is the point, not a risk).
    const spadeLeadUnsafe = !qsHeld && !qsCaptured && moonPaceOwner(G) !== pi;
    const noRiskyLead = c => !(spadeLeadUnsafe && c.suit === '♠' && (c.rank === 'A' || c.rank === 'K'));

    // Bank a free +10: lead a card that's provably unbeatable in its suit
    // right now (every higher card is already gone or safe in my own hand).
    const safe = legal.filter(c => cardVal(c) === 0);
    const guaranteed = safe.filter(c => isGuaranteedWinner(G, c, hand) && noRiskyLead(c));
    if (guaranteed.length) return guaranteed.sort((a, b) => RV[b.rank] - RV[a.rank])[0];

    // Hearts of 5 or under are cheap enough to shed proactively — as long
    // as at least two higher hearts are still unaccounted for, someone
    // else almost always has to cover it. A heart above 5 is only safe to
    // lead once every rank below it is already out of the game entirely:
    // at that point nobody can duck under it with a lower heart even if
    // they wanted to, so whoever follows with a heart is guaranteed to
    // beat me. Never chase with a heart above 5 outside that exact case.
    const played = playedCardsThisRound(G);
    const heartsInHand = legal.filter(c => c.suit === '♥').sort((a, b) => RV[a.rank] - RV[b.rank]);
    for (const c of heartsInHand) {
      if (RV[c.rank] <= 5) {
        const higherHeartsUnseen = RANKS.filter(r => RV[r] > RV[c.rank])
          .filter(r => !played.some(p => p.suit === '♥' && p.rank === r))
          .filter(r => !hand.some(p => p.suit === '♥' && p.rank === r)).length;
        if (higherHeartsUnseen >= 2) return c;
      } else {
        const allLowerGone = RANKS.filter(r => RV[r] < RV[c.rank])
          .every(r => played.some(p => p.suit === '♥' && p.rank === r));
        if (allLowerGone) return c;
      }
    }

    // Nothing clever on offer — lead the highest safe (non-penalty) card,
    // still avoiding an unnecessary A♠/K♠ risk if a safer option exists.
    const safeNoRisk = safe.filter(noRiskyLead);
    const safePool = safeNoRisk.length ? safeNoRisk : safe;
    if (safePool.length) return safePool.sort((a, b) => RV[b.rank] - RV[a.rank])[0];

    // Truly forced to lead a penalty card (hand is nothing but hearts and
    // maybe the queen): minimize the damage — lowest heart first, the
    // Q♠ only as the very last resort.
    const forcedHearts = legal.filter(c => c.suit === '♥').sort((a, b) => RV[a.rank] - RV[b.rank]);
    if (forcedHearts.length) return forcedHearts[0];
    return legal[0];
  }

  // ══ FOLLOWING ════════════════════════════════════════════════
  const led = trick[0].card.suit;
  const following = legal.filter(c => c.suit === led);

  if (following.length > 0) {
    const highInTrickEntry = [...trick].filter(t => t.card.suit === led)
      .sort((a, b) => RV[b.card.rank] - RV[a.card.rank])[0];
    const highInTrick = highInTrickEntry.card;
    const winners = following.filter(c => RV[c.rank] > RV[highInTrick.rank]);
    const losers  = following.filter(c => RV[c.rank] < RV[highInTrick.rank]);
    const penInTrick = trick.reduce((s, t) => s + Math.abs(cardVal(t.card)), 0);
    const remainingOfSuit = suitRemainingCount(G, led);
    const penaltyLeft = penaltyPointsRemaining(G);

    // Take it: either it's a clean trick worth the +10, I'm chasing the
    // moon myself and want every heart/queen I can get, or an opponent is
    // on pace for the moon and this dirty trick is my chance to break it —
    // almost any single trick's cost beats a guaranteed -20 later.
    let wantToWin = penInTrick === 0 || amMoonPace || (oppMoonPace && penInTrick > 0);

    // Spades: A♠/K♠ are too valuable (queen-hunting, safety later) to
    // spend just to win an ordinary clean spades trick. Only use them to
    // overtake when it's provably safe — I'm last to act (nothing left
    // to jump me) and the queen hasn't surfaced yet this round (so I'm
    // not risking scooping her). Otherwise hold them back and duck with
    // a lower spade instead, even though I technically could win.
    let restrictedWinners = winners;
    if (led === '♠' && wantToWin && !amMoonPace && penInTrick === 0) {
      // The queen herself is a separate, unconditional case: if she's one
      // of the winners it's because I'm already holding her, so "winning"
      // with her means personally taking the -26, not risking scooping her
      // from someone else the way leading/overtaking with A/K does. Strip
      // her out regardless of position or whether she's surfaced yet —
      // ducking under with any other loser is always better than a clean
      // trick's +10 minus her own -26.
      restrictedWinners = winners.filter(c => c.rank !== 'Q');

      const qsOut = G.players.some(p => p.tricks.some(c => c.suit === '♠' && c.rank === 'Q'))
        || trick.some(t => t.card.suit === '♠' && t.card.rank === 'Q');
      const safeToOvertake = trick.length === 3 && !qsOut;
      if (!safeToOvertake) {
        restrictedWinners = restrictedWinners.filter(c => c.rank !== 'A' && c.rank !== 'K');
      }
      if (!restrictedWinners.length) wantToWin = false; // nothing safe to win with — don't
    }

    if (wantToWin && restrictedWinners.length) {
      return restrictedWinners.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
    }

    if (losers.length) {
      // The queen, when she's one of the (provably losing, by definition
      // of `losers`) options, is never just "a loser" like any other card
      // — she's the single most dangerous card in the deck, and this
      // trick can never be safer for her than it is right now. Unload her
      // immediately rather than letting duckCard's low/mid-card logic
      // (built for ordinary cards worth holding onto) pass her over in
      // favor of something smaller, UNLESS we're chasing the moon
      // ourselves (then she's the whole point, not a liability) or doing
      // so would hand the trick's guaranteed winner a moon of their own —
      // same iAmLast approximation the void-discard rule below already
      // relies on to know that for certain.
      if (!amMoonPace) {
        const qsLoser = losers.find(c => c.suit === '♠' && c.rank === 'Q');
        if (qsLoser) {
          const iAmLast = trick.length === 3;
          const feedsPace = oppMoonPace && iAmLast && highInTrickEntry.player === moonOwner;
          if (!feedsPace) return qsLoser;
        }
      }
      // Ducking under — this trick's outcome doesn't depend on which loser
      // I play, so pick based on the count: preserve keepers/promoted
      // kings first, then go low or mid depending on how much danger and
      // how much of this suit is still loose in the round.
      const nonKeeper = losers.filter(c => !isKeeper(c));
      const base = nonKeeper.length ? nonKeeper : losers;
      const protectedPool = withoutProbableKeepers(G, base);
      const pool = protectedPool.length ? protectedPool : base;
      return duckCard(pool, remainingOfSuit, penaltyLeft);
    }

    // Forced to win regardless — every card I hold of this suit beats the
    // board. Minimize the damage: take it with the cheapest one.
    return winners.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
  }

  // Void in the led suit — a free discard.
  if (amMoonPace) {
    // Don't hand a heart or the queen to whoever wins this trick instead
    // of me — protect them, dump something harmless instead.
    const safe = legal.filter(c => cardVal(c) === 0);
    const pool = safe.length ? safe : legal;
    return pool.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
  }

  // If the pace-setter is already sitting on the winning card of this
  // trick and I'm last to act, don't feed them another heart/queen — dump
  // something harmless instead, same idea as the moon-pace case above.
  const iAmLast = trick.length === 3;
  const highSoFar = [...trick].filter(t => t.card.suit === led)
    .sort((a, b) => RV[b.card.rank] - RV[a.card.rank])[0];
  const feedsPace = oppMoonPace && iAmLast && highSoFar && highSoFar.player === moonOwner;

  if (!feedsPace) {
    const qs = legal.find(c => c.suit === '♠' && c.rank === 'Q');
    if (qs) return qs;
    const hearts = legal.filter(c => c.suit === '♥').sort((a, b) => RV[b.rank] - RV[a.rank]);
    if (hearts.length) return hearts[0];
  }

  // Nothing dangerous to dump (or dangerous-but-shouldn't-feed-the-pace):
  // protect keeper cards (and any King newly promoted to top-of-suit)
  // first, then let go of the lowest one to keep higher plain-suit assets
  // in hand (winning a trick is +10 here).
  const nonKeeper = legal.filter(c => !isKeeper(c));
  const pool0 = nonKeeper.length ? nonKeeper : legal;
  const protectedPool = withoutProbableKeepers(G, pool0);
  const pool = protectedPool.length ? protectedPool : pool0;
  return pool.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
}

// ── AI: probabilistic opponent-hand modeling (Monte Carlo) ───────
// This is the actual "true probability" layer. Nobody's hand is ever
// peeked at. Instead, every legal card is tested against many complete,
// *plausible* deals of the three opponents' hands — sampled so they're
// consistent with everything a sharp human could legitimately infer
// from the game so far — and the rest of the round is played out for
// each one using heuristicChoose. Whichever card comes out best on
// average, across all those simulated worlds, is the one actually
// played. It's the same idea real-world bridge/whist-class engines use
// (usually called Monte Carlo determinization): turn one hard problem
// with hidden information into many easy problems with perfect
// information, solve each cheaply, and average.

// A full, trick-by-trick log of what's been played this round — who
// played which card, in which trick — reset each round in dealRound and
// appended to in resolveTrick. This is what makes void inference
// possible: playedCardsThisRound only knows *which cards* have appeared,
// not *who played them off-suit*, and that second fact is the single
// most valuable piece of public information in the whole game.
function roundPlayLog(G) {
  const log = G.playLog ? [...G.playLog] : [];
  if (G.currentTrick && G.currentTrick.length) log.push(G.currentTrick);
  return log;
}

// Suits each player is *provably* void in: anyone who didn't follow the
// led suit despite the trick requiring it can only have done that
// because they hold none of it. Purely deductive — no guessing.
function inferVoidSuits(G) {
  const voids = { 0: new Set(), 1: new Set(), 2: new Set(), 3: new Set() };
  for (const trick of roundPlayLog(G)) {
    if (!trick.length) continue;
    const led = trick[0].card.suit;
    for (const play of trick) {
      if (play.card.suit !== led) voids[play.player].add(led);
    }
  }
  return voids;
}

// Cards a specific opponent is *provably* holding, beyond reasonable
// doubt: whatever I personally passed them this round, as long as they
// haven't played it yet. This is certain, not probabilistic — passing
// happens before any tricks, hands only ever shrink by playing.
function certainOpponentCards(G, pi) {
  const certain = { 0: [], 1: [], 2: [], 3: [] };
  if (G.passSelected && roundPassDir(G) !== 'keep' && G.passSelected[pi] && G.passSelected[pi].length === 2) {
    const tgt = passTarget(pi, roundPassDir(G));
    const played = playedCardsThisRound(G);
    const myHand = G.players[pi].hand;
    for (const c of G.passSelected[pi]) {
      const stillOut = !played.some(x => eqC(x, c)) && !myHand.some(x => eqC(x, c));
      if (stillOut) certain[tgt].push(c);
    }
  }
  return certain;
}

// Deals a single plausible, fully-specified world: concrete (hypothetical)
// hands for the three opponents, consistent with every hard constraint —
// exact remaining hand sizes (public), known voids (deduced above), and
// certain cards (also deduced above). Everything else genuinely unknown
// gets shuffled in at random. Retries a few times if an unlucky shuffle
// order makes a void temporarily impossible to satisfy; falls back to an
// unconstrained deal in the vanishingly rare case that still fails, so
// this can never throw or hang mid-game.
function sampleWorld(G, pi) {
  const myHand = G.players[pi].hand;
  const played = playedCardsThisRound(G);
  const voids = inferVoidSuits(G);
  const certain = certainOpponentCards(G, pi);

  const known = new Set();
  for (const c of myHand) known.add(c.suit + c.rank);
  for (const c of played) known.add(c.suit + c.rank);
  for (const i of [0, 1, 2, 3]) for (const c of certain[i]) known.add(c.suit + c.rank);

  const unknownPool = [];
  for (const s of SUITS) for (const r of RANKS) {
    if (!known.has(s + r)) unknownPool.push({ suit: s, rank: r });
  }

  const quota = {};
  for (const i of [0, 1, 2, 3]) {
    if (i === pi) continue;
    quota[i] = G.players[i].hand.length - certain[i].length;
  }

  const bySuit = { '♠': [], '♥': [], '♦': [], '♣': [] };
  for (const c of unknownPool) bySuit[c.suit].push(c);

  for (let attempt = 0; attempt < 8; attempt++) {
    const hands = { 0: [], 1: [], 2: [], 3: [] };
    for (const i of [0, 1, 2, 3]) if (i !== pi) hands[i] = [...certain[i]];
    const left = { ...quota };

    // Deal suit by suit, most-constrained suit first (fewest players still
    // eligible to hold it). This is the difference between "almost always
    // works" and "almost never works" once a couple of voids overlap —
    // dealing a widely-eligible suit (say ♦, which anyone can hold) before
    // a narrowly-eligible one (say ♥, with two players void in it) can
    // easily eat up the only quota left for the players who *can* still
    // take that ♥, leaving no legal home for it. Clearing the tightest
    // suits first, while the most quota is still open, avoids that trap.
    const suitOrder = [...SUITS].sort((a, b) => {
      const ea = [0, 1, 2, 3].filter(i => i !== pi && !voids[i].has(a)).length;
      const eb = [0, 1, 2, 3].filter(i => i !== pi && !voids[i].has(b)).length;
      return ea - eb;
    });

    let ok = true;
    for (const suit of suitOrder) {
      for (const c of shuffle(bySuit[suit])) {
        const eligible = [0, 1, 2, 3].filter(i => i !== pi && left[i] > 0 && !voids[i].has(c.suit));
        if (!eligible.length) { ok = false; break; }
        const pick = eligible[Math.floor(Math.random() * eligible.length)];
        hands[pick].push(c);
        left[pick]--;
      }
      if (!ok) break;
    }
    if (ok) return hands;
  }

  // Constraint set was still infeasible after 8 tries (would need very
  // unusual, tightly-overlapping voids) — relax them and just deal by
  // quota so there's always a usable world to simulate against.
  const pool = shuffle(unknownPool);
  const hands = { 0: [], 1: [], 2: [], 3: [] };
  for (const i of [0, 1, 2, 3]) if (i !== pi) hands[i] = [...certain[i]];
  let idx = 0;
  for (const i of [0, 1, 2, 3]) {
    if (i === pi) continue;
    while (hands[i].length < quota[i] + certain[i].length && idx < pool.length) hands[i].push(pool[idx++]);
  }
  return hands;
}

// Plays a sampled world out to the end of the round using heuristicChoose
// for every seat (this is the "perfect information" half of determinize-
// and-solve — once a world is concrete, there's nothing left to guess
// about, so the fast policy is exactly the right tool). Mutates simG in
// place and returns the raw +10/trick scoring accrued *from this point
// forward only* — the guard against a runaway loop is pure defensive
// programming; a real game can never hit it.
function simulateRoundFrom(simG) {
  const delta = [0, 0, 0, 0];
  let guard = 0;
  while (simG.trickNum <= 13) {
    while (simG.currentTrick.length < 4) {
      if (++guard > 3000) return delta; // should be structurally impossible
      const cp = (simG.trickLeader + simG.currentTrick.length) % 4;
      const card = heuristicChoose(simG, cp);
      const idx = simG.players[cp].hand.findIndex(c => eqC(c, card));
      if (idx === -1) return delta; // defensive: never actually happens
      simG.players[cp].hand.splice(idx, 1);
      simG.currentTrick.push({ player: cp, card });
    }
    const winner = trickWinner(simG.currentTrick);
    const penPts = simG.currentTrick.reduce((s, t) => s + cardVal(t.card), 0);
    delta[winner] += 10 + penPts;
    simG.players[winner].tricks.push(...simG.currentTrick.map(t => t.card));
    simG.currentTrick = [];
    simG.trickNum++;
    simG.trickLeader = winner;
  }
  return delta;
}

// Scores exactly one (candidate card × sampled world) pairing: build a
// disposable simulation from the real game's actual, already-resolved
// history plus this one hypothetical world, play it out, and return what
// it's worth to seat `pi`. Moon-shot scoring overrides everything else,
// exactly like the real endRound — a candidate that lets someone else's
// moon complete is worth a flat -20 (or +60 if *I'm* the one completing
// it), regardless of how the raw trick points landed.
function evaluateCandidate(G, pi, candidate, world) {
  const simG = {
    players: [0, 1, 2, 3].map(i => ({
      hand: i === pi
        ? G.players[pi].hand.filter(c => !eqC(c, candidate))
        : [...world[i]],
      tricks: [...G.players[i].tricks],
    })),
    currentTrick: G.currentTrick.map(t => ({ player: t.player, card: t.card })),
    trickNum: G.trickNum,
    trickLeader: G.trickLeader,
  };
  simG.currentTrick.push({ player: pi, card: candidate });

  const delta = simulateRoundFrom(simG);
  const moonShooter = checkMoon(simG);
  if (moonShooter >= 0) return moonShooter === pi ? 60 : -20;
  return delta[pi];
}

// How many sampled worlds to run per candidate card. Scaled down as the
// decision gets more expensive (more candidates to compare, more tricks
// left to simulate for each one) so worst case — the very first card of
// the round, with a full 13-card hand of options — still finishes in a
// reasonable fraction of a second, while cheap, late-round decisions get
// to run with much higher precision essentially for free.
function samplesFor(numCandidates, trickNum) {
  const tricksRemaining = Math.max(1, 14 - trickNum);
  const budget = Math.floor(1800 / (numCandidates * tricksRemaining));
  return Math.max(8, Math.min(120, budget));
}

// A thin hard-constraint layer applied only to the live decision (not the
// rollout policy) — the few rules that should never be left to
// probabilistic judgment: a free Ace on trick 1, never chasing with a
// heart that isn't safe yet, never leading or overtaking with A♠/K♠ or
// leading the queen herself while she's still unaccounted for unless
// it's provably safe, never voluntarily winning a hearts trick when a
// losing heart is available, and always dumping the queen/a heart
// instead of a safe card on a genuinely free void discard. Only ever
// narrows the candidate list, and only when a legal alternative
// actually remains — a genuinely forced move is always left untouched.
function applyHardRules(G, pi, legal) {
  const trick = G.currentTrick;

  if (trick.length === 0) {
    if (G.trickNum === 1) {
      const openingAce = legal.find(c => (c.suit === '♦' || c.suit === '♣') && c.rank === 'A');
      if (openingAce) return [openingAce];
    }
    let pool = legal;

    const played = playedCardsThisRound(G);
    const risky = pool.filter(c => c.suit === '♥' && RV[c.rank] > 5 &&
      !RANKS.filter(r => RV[r] < RV[c.rank]).every(r => played.some(p => p.suit === '♥' && p.rank === r)));
    if (risky.length && risky.length < pool.length) {
      pool = pool.filter(c => !risky.includes(c));
    }

    // Never lead A♠/K♠ while the queen is still unaccounted for — any
    // other player could easily be void in spades and dump her straight
    // into a trick we're guaranteed to win with the top card. Exempt: we
    // hold the queen ourselves (nothing at risk), she's already captured,
    // or we're on moon pace (then capturing her ourselves is the point).
    if (moonPaceOwner(G) !== pi) {
      const qsHeld = G.players[pi].hand.some(c => c.suit === '♠' && c.rank === 'Q');
      const qsCapturedEarlier = G.players.some(p => p.tricks.some(c => c.suit === '♠' && c.rank === 'Q'));
      if (!qsHeld && !qsCapturedEarlier) {
        const topSpadeLeads = pool.filter(c => c.suit === '♠' && (c.rank === 'A' || c.rank === 'K'));
        if (topSpadeLeads.length && topSpadeLeads.length < pool.length) {
          pool = pool.filter(c => !topSpadeLeads.includes(c));
        }
      }
    }

    // Never lead the queen herself unless it's provably safe: we're the
    // sole moon-pace owner AND also hold both A♠/K♠, so nothing in
    // anyone else's hand can beat her — she wins the trick and comes
    // straight back to us, which is the point when chasing +60.
    // Otherwise leading her is a coin flip on whoever else is still
    // holding spades; Monte Carlo can and does get this wrong on a thin
    // sample (this mirrors heuristicChoose's own amMoonPace+haveTopTwo
    // exception exactly, so both paths agree on when it's safe).
    const qsLead = pool.find(c => c.suit === '♠' && c.rank === 'Q');
    if (qsLead && pool.length > 1) {
      const spadesHeld = G.players[pi].hand.filter(c => c.suit === '♠');
      const haveTopTwo = spadesHeld.some(c => c.rank === 'A') && spadesHeld.some(c => c.rank === 'K');
      const safeToLeadQueen = moonPaceOwner(G) === pi && haveTopTwo;
      if (!safeToLeadQueen) pool = pool.filter(c => c !== qsLead);
    }

    return pool;
  }

  const led = trick[0].card.suit;
  if (led === '♠' && moonPaceOwner(G) !== pi) {
    // Both restrictions below narrow `pool` (never `legal` directly) and
    // compose, rather than the first one returning early — a hand holding
    // both an unsafe A/K *and* the queen needs both filters applied, not
    // just whichever is checked first.
    let pool = legal;

    const qsInTrick = trick.some(t => t.card.suit === '♠' && t.card.rank === 'Q');
    const qsCapturedEarlier = G.players.some(p => p.tricks.some(c => c.suit === '♠' && c.rank === 'Q'));
    // Safe to play A/K only once the queen can no longer land in this
    // trick: she's already gone from an earlier trick, or we're last to
    // act and she isn't one of the four cards on the table. If she's
    // sitting in the trick right now, playing top spades captures her
    // for certain — that used to slip through whenever *any* penalty
    // card (including her) was already in the trick, which was exactly
    // backwards, since that's the one case that's never safe.
    const safeToOvertake = !qsInTrick && (qsCapturedEarlier || trick.length === 3);
    if (!safeToOvertake) {
      const topSpades = pool.filter(c => c.suit === '♠' && (c.rank === 'A' || c.rank === 'K'));
      if (topSpades.length && topSpades.length < pool.length) {
        pool = pool.filter(c => !topSpades.includes(c));
      }
    }

    // Never voluntarily risk taking the queen herself when a spade that's
    // guaranteed to lose this trick is also legal. A card's rank is fixed
    // the instant it's played, so any spade already below the highest
    // spade on the table (the led card, or an overtake played ahead of
    // us) can never end up winning the trick no matter what's played
    // after us — ducking under with one of those is strictly safer than
    // risking the queen, which only avoids the -26 if someone else's
    // spade is already higher. Mirrors the hearts rule below exactly,
    // just against a single dangerous card instead of a whole suit.
    const qsFollow = pool.find(c => c.suit === '♠' && c.rank === 'Q');
    if (qsFollow) {
      const highSpadeSoFar = [...trick].filter(t => t.card.suit === '♠')
        .sort((a, b) => RV[b.card.rank] - RV[a.card.rank])[0];
      if (highSpadeSoFar) {
        // If a strictly higher spade is already down, the queen herself is
        // just as provably incapable of winning this trick as any other
        // card below it — the "risk" this whole rule exists to avoid
        // (scooping her for ourselves) is already zero. That's the exact
        // same guarantee the void-discard rule below unconditionally
        // dumps her on, so take it here too rather than saving her for a
        // less certain trick later — UNLESS whoever's about to win this
        // one is themselves chasing the moon, in which case handing her
        // over completes their run instead of ours; only checkable for
        // certain from the last position, same iAmLast approximation the
        // void-discard rule already uses for the identical reason.
        if (RV[highSpadeSoFar.card.rank] > RV.Q) {
          const moonOwner = moonPaceOwner(G);
          const iAmLast = trick.length === 3;
          const feedsPace = moonOwner !== -1 && iAmLast && highSpadeSoFar.player === moonOwner;
          if (!feedsPace) pool = [qsFollow];
        } else {
          const saferSpades = pool.filter(c => c.suit === '♠' && c.rank !== 'Q' &&
            RV[c.rank] < RV[highSpadeSoFar.card.rank]);
          if (saferSpades.length) pool = saferSpades;
        }
      }
    }

    if (pool.length !== legal.length) return pool;
  }

  // Never voluntarily win a hearts trick — every heart we capture is
  // points against us, so if we can follow with a heart that loses,
  // never spend one that wins instead, even when Monte Carlo's sampling
  // occasionally gets noisy enough to make the ace look survivable.
  // Exempt whenever anyone's on moon pace this round (ourselves, going
  // for +60 ourselves, or an opponent, where deliberately taking a dirty
  // trick can be the one move that breaks their run) — that judgment
  // call is left to Monte Carlo/heuristic on purpose. Deliberately
  // broader than the spade guard above, which only exempts *our own*
  // moon pace (`!== pi`, not `=== -1`): a queen capture only helps
  // whoever wins it, so it's never worth handing to an opponent, but a
  // hearts capture can be the correct defensive play against someone
  // else's run, matching heuristicChoose's own oppMoonPace handling.
  if (led === '♥' && moonPaceOwner(G) === -1) {
    const heartsHeld = legal.filter(c => c.suit === '♥');
    const highHeartInTrick = [...trick].filter(t => t.card.suit === '♥')
      .sort((a, b) => RV[b.card.rank] - RV[a.card.rank])[0];
    if (heartsHeld.length && highHeartInTrick) {
      const winners = heartsHeld.filter(c => RV[c.rank] > RV[highHeartInTrick.card.rank]);
      if (winners.length && winners.length < heartsHeld.length) {
        return legal.filter(c => !winners.includes(c));
      }
    }
  }

  // Void in the led suit: a genuinely free discard — whatever we play
  // here can never win this trick (only cards of the led suit can), so
  // dumping the queen or a heart we're holding costs nothing right now
  // and permanently removes the risk of being forced to give it up
  // later into a trick we DO win. Skip if we're on moon pace ourselves
  // (protect them instead — Monte Carlo already handles that correctly
  // given how large the EV swing is) or if dumping now would hand this
  // exact trick's win to whoever's already on an uncontested moon pace.
  const isVoidInLed = trick.length > 0 && !legal.some(c => c.suit === led);
  if (isVoidInLed && moonPaceOwner(G) !== pi) {
    const moonOwner = moonPaceOwner(G);
    const iAmLast = trick.length === 3;
    const highSoFar = [...trick].filter(t => t.card.suit === led)
      .sort((a, b) => RV[b.card.rank] - RV[a.card.rank])[0];
    const feedsPace = moonOwner !== -1 && iAmLast && highSoFar && highSoFar.player === moonOwner;
    if (!feedsPace) {
      const dangerous = legal.filter(c => (c.suit === '♠' && c.rank === 'Q') || c.suit === '♥');
      if (dangerous.length && dangerous.length < legal.length) {
        return dangerous;
      }
    }
  }

  return legal;
}

// The live decision. Every legal card gets tested against the same batch
// of sampled worlds (so the comparison between candidates is apples to
// apples within each sample), each one played out to the end of the
// round, and whichever card comes out with the best average result wins.
// Falls back to the plain heuristic if anything about the simulation
// goes wrong — this must never be the thing that crashes a live game.
function aiChoose(G, pi) {
  const legal = legalCards(G, pi);
  if (legal.length === 1) return legal[0];

  try {
    const filtered = applyHardRules(G, pi, legal);
    const pool = filtered.length ? filtered : legal;
    if (pool.length === 1) return pool[0];

    const samples = samplesFor(pool.length, G.trickNum);
    const totals = new Array(pool.length).fill(0);

    for (let s = 0; s < samples; s++) {
      const world = sampleWorld(G, pi);
      for (let ci = 0; ci < pool.length; ci++) {
        totals[ci] += evaluateCandidate(G, pi, pool[ci], world);
      }
    }

    let bestIdx = 0, bestAvg = -Infinity;
    for (let ci = 0; ci < pool.length; ci++) {
      const avg = totals[ci] / samples;
      if (avg > bestAvg) { bestAvg = avg; bestIdx = ci; }
    }
    return pool[bestIdx];
  } catch (e) {
    return heuristicChoose(G, pi);
  }
}

// ── Ranked: MMR & rank ladder (pure — isolated so the MMR formula can be
// swapped for an Elo-style K × (normalizedScore - expectedPerformance)
// later without touching matchmaking or any caller) ─────────────
function computeMmrChanges(scores) {
  const positives = scores.filter(s => s > 0);
  const avgPositive = positives.length
    ? positives.reduce((a, b) => a + b, 0) / positives.length
    : 1; // nobody scored positive — fall back so normalizedScore just equals the raw score
  return scores.map(score => {
    const normalized = score / avgPositive;
    const raw = 25 * normalized;
    return Math.round(Math.max(-40, Math.min(40, raw)));
  });
}

// `tier` is the DISPLAYED name; `slug` is the stable internal key and is
// deliberately unchanged from the original Bronze..Legend naming. That
// split is what let the tiers be renamed (to the cosmetic sheet's
// Novice..Legend) without touching a single one of the 22
// `public/badges/*.svg` filenames or the eight `.tag.<slug>` CSS rules —
// both are keyed off the slug, not the label. It also keeps
// "Grand Master" (which has a space, and so cannot be a class name or a
// filename) from ever reaching either.
// The MMR thresholds are untouched: this is a rename, not a re-tuning,
// so nobody's rank actually moved.
const RANK_TABLE = [
  { mmr: 0,    tier: 'Novice',       slug: 'bronze',      div: 1 },
  { mmr: 167,  tier: 'Novice',       slug: 'bronze',      div: 2 },
  { mmr: 334,  tier: 'Novice',       slug: 'bronze',      div: 3 },
  { mmr: 500,  tier: 'Apprentice',   slug: 'silver',      div: 1 },
  { mmr: 667,  tier: 'Apprentice',   slug: 'silver',      div: 2 },
  { mmr: 834,  tier: 'Apprentice',   slug: 'silver',      div: 3 },
  { mmr: 1000, tier: 'Player',       slug: 'gold',        div: 1 },
  { mmr: 1167, tier: 'Player',       slug: 'gold',        div: 2 },
  { mmr: 1334, tier: 'Player',       slug: 'gold',        div: 3 },
  { mmr: 1500, tier: 'Gambler',      slug: 'platinum',    div: 1 },
  { mmr: 1667, tier: 'Gambler',      slug: 'platinum',    div: 2 },
  { mmr: 1834, tier: 'Gambler',      slug: 'platinum',    div: 3 },
  { mmr: 2000, tier: 'Ace',          slug: 'diamond',     div: 1 },
  { mmr: 2167, tier: 'Ace',          slug: 'diamond',     div: 2 },
  { mmr: 2334, tier: 'Ace',          slug: 'diamond',     div: 3 },
  { mmr: 2500, tier: 'Master',       slug: 'master',      div: 1 },
  { mmr: 2667, tier: 'Master',       slug: 'master',      div: 2 },
  { mmr: 2834, tier: 'Master',       slug: 'master',      div: 3 },
  { mmr: 3000, tier: 'Grand Master', slug: 'grandmaster', div: 1 },
  { mmr: 3167, tier: 'Grand Master', slug: 'grandmaster', div: 2 },
  { mmr: 3334, tier: 'Grand Master', slug: 'grandmaster', div: 3 },
  { mmr: 3500, tier: 'Legend',       slug: 'legend',      div: null },
];
const DIV_ROMAN = { 1: 'I', 2: 'II', 3: 'III' };
function rankForMmr(mmr) {
  let best = RANK_TABLE[0];
  for (const row of RANK_TABLE) {
    if (mmr >= row.mmr) best = row; else break;
  }
  return {
    tier: best.tier,
    slug: best.slug,
    division: best.div,
    label: best.div ? `${best.tier} ${DIV_ROMAN[best.div]}` : best.tier,
    mmr,
  };
}

// ── Achievements & cosmetics ────────────────────────────────────
// ONE registry, server-side, and it is the only authority. The client
// carries a parallel table of *presentation* only (display names, the SVG
// crest art, scene CSS) keyed by these same IDs — it never decides what's
// unlocked, and `saveCosmetics` re-checks every incoming ID against a
// freshly evaluated unlock set, so a hand-crafted socket message can't
// equip something that wasn't earned.
//
// IDs are stable and must stay so: they're persisted in
// player_cosmetics. Thresholds are NOT — they're re-evaluated on every
// read, so retuning one takes effect immediately for everyone (upward
// too, which is the deliberate cost of never storing unlock rows; see
// db.js's player_cosmetics comment).
//
// `stat` names a key of db.getAchievementStats(). Adding an achievement
// means adding a counter there and a row here, nothing else — the crest,
// the title it grants, the Achievements tab entry and the cosmetics it
// gates all fall out of this table.
// Each achievement is a LADDER of up to four tiers rather than a single
// threshold. The crest is one art id that gains a LEVEL (1-4) as the
// ladder is climbed - art is keyed (crest, level) and rendered only if
// present, the same "drop the file in later, no code change" contract the
// rank plates and scene art already use. The title is granted at level 1,
// so early play already has something to wear and the top rung is the
// brag rather than the entry fee.
//
// `cmp:'lte'` inverts the comparison for the two secret achievements,
// whose stats move DOWNWARD (worst hand / worst game).
// `secret:true` hides the name and description client-side until earned.
//
// Every id that existed before this change is still here, on its original
// stat: COSMETICS gates the scenes, the Royal Court card front and all
// twelve titles on these ids, and unlocks are re-derived on every read -
// so dropping one would silently un-equip whatever a player was wearing.
// Each old single threshold now appears as one rung of its ladder.
const ACHIEVEMENTS = [
  { id: 'ach_queen_hunter',   stat: 'queensTaken',        tiers: [1, 10, 100, 1000],
    names: ["Hey, That's My Wife!", 'Queen Hunter', 'Queen Collector', 'Queen of Queens'],
    desc: 'Take the Queen of Spades.',
    crest: 'crest_queen_of_spades', title: 'title_queen_hunter' },

  // 500 rather than 1000: a moon lands in roughly 2% of hands and the AI
  // actively defends against one (see oppMoonPace / moonPaceOwner), so a
  // 1000 rung works out at ~3,000 games - not extreme, just unreachable.
  { id: 'ach_moon_chaser',    stat: 'moonsTotal',         tiers: [1, 10, 50, 500],
    names: ['Moonshooter', 'Moon Chaser', 'Moonstruck', 'Lord of the Moon'],
    desc: 'Shoot the moon.',
    crest: 'crest_crescent',        title: 'title_moon_chaser' },

  { id: 'ach_strategist',     stat: 'rankedGamesWon',     tiers: [1, 10, 100, 750],
    names: ['Contender', 'The Strategist', 'Ranked Veteran', 'Grand Tactician'],
    desc: 'Finish first in a ranked game.',
    crest: 'crest_snake',           title: 'title_strategist' },

  { id: 'ach_the_house',      stat: 'gamesWon',           tiers: [1, 10, 25, 100],
    names: ['First Win', 'The House', 'House Rules', 'The Whole Casino'],
    desc: 'Win a game.',
    crest: 'crest_crown',           title: 'title_the_house' },

  { id: 'ach_heartbreaker',   stat: 'gamesWonPositive',   tiers: [1, 10, 50, 200],
    names: ['Heartbreaker', 'Heartless', 'Heart of Stone', 'The Unmoved'],
    desc: 'Win a game finishing on a positive score.',
    crest: 'crest_rose',            title: 'title_heartbreaker' },

  { id: 'ach_four_suit',      stat: 'fourSuitGames',      tiers: [1, 10, 50, 200],
    names: ['All Four', 'Four-Suit Master', 'Suit Sovereign', 'Master of Suits'],
    desc: 'Win a game after taking tricks in all four suits.',
    crest: 'crest_four_suits',      title: 'title_four_suit_master' },

  { id: 'ach_silent_dealer',  stat: 'gamesCompletedFull', tiers: [1, 100, 500, 1000],
    names: ['Stayed the Course', 'The Silent Dealer', 'Iron Resolve', 'Never Folds'],
    desc: 'See a game through to the end in your own seat.',
    crest: 'crest_raven',           title: 'title_dealers_nemesis' },

  { id: 'ach_the_dealer',     stat: 'dealerRounds',       tiers: [1, 25, 100, 500],
    names: ['Cut the Deck', 'The Dealer', 'House Dealer', 'Dealer Eternal'],
    desc: 'Deal a hand.',
    crest: 'crest_dealer_button',   title: 'title_blame_the_dealer' },

  // -- rank ladder --
  // One ladder, one tier per reachable rank — 7, not the usual 4: a new
  // account starts mid-Novice, so Novice itself is never "reached" (there's
  // nothing to unlock by starting where you already are), leaving exactly
  // the 7 tiers above it. This used to be split across two 4-tier
  // achievements (ach_high_roller capped at Ace, ach_the_ascent picking up
  // from Ace to Legend) purely because every other achievement here caps at
  // 4 — merged into one now that "one tier per rank" is the actual point.
  // Thresholds are RANK_TABLE's own tier-entry MMRs and read mmrPeak, so a
  // losing streak can never revoke a rung already reached.
  { id: 'ach_high_roller',    stat: 'mmrPeak',            tiers: [500, 1000, 1500, 2000, 2500, 3000, 3500],
    names: ['Apprentice', 'Climbing the Ranks', 'Gambler', 'Ace', 'Master', 'Grand Master', 'Legend'],
    desc: 'Reach a new rank in ranked play.',
    crest: 'crest_diamond',         title: 'title_high_roller' },

  // -- skill, not time --
  // +61 in a single HAND, i.e. out-scoring a moon (+60) by ordinary play.
  // NOT per trick: a trick scores +10 minus its own penalties, so it can
  // never exceed +10 - see the ruleset note in CLAUDE.md. A hand's
  // ceiling is about +95 (take ten tricks while dodging the queen and the
  // eleven highest hearts), so this is hard but genuinely reachable.
  { id: 'ach_beyond_moon',    stat: 'bestRound',          tiers: [61],
    names: ['Beyond the Moon'],
    desc: 'Score more in a single hand than shooting the moon would pay.',
    crest: 'crest_sun',             title: 'title_beyond_moon' },

  // Winning every trick in a hand. Necessarily a moon (you hold every
  // penalty card), but a moon is NOT necessarily this - you can scoop
  // every heart and the queen while opponents take the penalty-free
  // tricks. So it is a strict subset and the rarest thing in the game.
  // Measured as "every trick PLAYED", because resolveTrick ends the hand
  // the moment the moon locks and the remaining tricks are never dealt.
  { id: 'ach_the_slam',       stat: 'slams',              tiers: [1, 10, 50, 100],
    names: ['The Trickster', 'Double Slam', 'Slam Artist', 'Untouchable'],
    desc: 'Win every trick in a hand.',
    crest: 'crest_slam',            title: 'title_the_slam' },

  { id: 'ach_ledger',         stat: 'bestGame',           tiers: [250],
    names: ['The Godfather'],
    desc: 'Finish a game on +250 or better.',
    crest: 'crest_ledger',          title: 'title_the_ledger' },

  { id: 'ach_clean_sheet',    stat: 'cleanRounds',        tiers: [1, 10, 100, 200],
    names: ['Clean Sheet', 'Spotless', 'Immaculate', 'Without a Mark'],
    desc: 'Finish a hand without taking a single penalty card.',
    crest: 'crest_clean',           title: 'title_clean_sheet' },

  { id: 'ach_queen_dodger',   stat: 'queenlessGames',     tiers: [1, 10, 50, 100],
    names: ['Not My Queen', 'Untouched', 'She Never Finds You', 'Ghost'],
    desc: 'Complete a whole game without ever taking the Queen of Spades.',
    crest: 'crest_veil',            title: 'title_queen_dodger' },

  // One step per casual match length (4/8/12/16 rounds), order-independent
  // — stat is a count of DISTINCT lengths ever finished naturally with
  // every hand's own delta >= 0, not a plain tally, so re-clearing an
  // already-cleared length can't push this past 4. See achBuf.noNegRound,
  // recordRoundAchievements and recordCleanLengthGame for how that count
  // is built up one length at a time.
  { id: 'ach_steady_hand',    stat: 'cleanLengthCount',   tiers: [1, 2, 3, 4],
    names: ['Steady Hand', 'Consistent Player', 'Ironclad', 'Flawless Record'],
    desc: 'Finish a game at each match length (4, 8, 12 and 16 rounds) without a single hand going negative.',
    crest: 'crest_quartet',         title: 'title_steady_hand' },

  // -- secret --
  // Hidden until earned, and both read a stat that moves DOWNWARD, hence
  // cmp:'lte'. A hand's floor is about -88 (the queen plus twelve hearts
  // across the minimum four tricks - you cannot take EVERY penalty card,
  // because that is a moon), so -60 is reachable.
  { id: 'ach_abyss',          stat: 'worstRound', cmp: 'lte', tiers: [-60], secret: true,
    names: ['The Abyss'],
    desc: 'Take -60 or worse in a single hand.',
    crest: 'crest_abyss',           title: 'title_abyss' },

  { id: 'ach_rock_bottom',    stat: 'worstGame',  cmp: 'lte', tiers: [-240], secret: true,
    names: ['Rock Bottom'],
    desc: 'Finish a game on -240 or worse.',
    crest: 'crest_rock_bottom',     title: 'title_rock_bottom' },
];

// How many rungs of `a` a value has cleared: 0 = locked, up to tiers.length.
function achievementLevel(a, value) {
  let lvl = 0;
  for (const t of a.tiers) {
    const hit = a.cmp === 'lte' ? value <= t : value >= t;
    if (hit) lvl++;
  }
  return lvl;
}

// Scenes and card fronts. `unlock: null` means always available — every
// category needs exactly one such entry so a brand-new account has
// something equipped rather than an empty picker. Crests and titles have
// no free entry on purpose: an unequipped crest/title is simply nothing
// shown, which is a valid state, whereas an unequipped scene would leave
// the table with no background at all.
// The real achievement gates are back (they were temporarily nulled so the
// scene photos were previewable before the shop existed), and each priced
// item now has a SECOND route: buy it. An item is available if it is
// achievement-unlocked OR purchased — see cosmeticsFor. That split is what
// keeps every threshold retunable, since only the purchase is stored.
//
// Scenes, card fronts and table themes are purchasable, deliberately.
// Crests are 1:1 with achievements — a crest IS the visible proof of one,
// so a bought crest would be a lie. Rank sets are earned by reaching a
// tier and are documented as never purchasable; selling them would also
// make credits look like they touch rank, which is this spec's own first
// non-goal. None of those three carry a price, and buyCosmetic only ever
// searches the three purchasable arrays.
const CREDIT_PRICES = { common: 600, rare: 2000, epic: 5000, legendary: 12000 };
// Table themes get their own flat 500 rather than reusing one of the tiers
// above — those tiers price cosmetics that vary a lot in rarity/effort
// (a background photo vs. a whole illustrated deck); every table theme is
// the same kind of thing (a felt palette), so one flat price fits all six
// locked ones evenly.
const THEME_PRICE = 500;
// Same reasoning as THEME_PRICE — two flat tiers for the fourteen
// non-default scenes, by which batch they arrived in rather than by
// per-item rarity: every scene is the same kind of cosmetic (a
// background photo), so batch order is the only thing distinguishing
// them. See the NAMING/pricing note on COSMETICS.scenes below.
const SCENE_PRICE_1 = 500;
const SCENE_PRICE_2 = 1000;
const COSMETICS = {
  // Obsidienne and Émeraude are the two free/default themes (see
  // filterEquipped's fallback and applyTableTheme's client-side default);
  // every other theme is shop-exclusive, same unlock:null+price shape
  // cardfront_noir established — no achievement route, purchase only.
  // Order here is display order everywhere this catalog is rendered (the
  // My Account picker, the Shop), which is why the two free ones lead.
  tableThemes: [
    { id: 'theme_obsidienne', name: 'Obsidienne',  unlock: null },
    { id: 'theme_emeraude',   name: 'Émeraude',     unlock: null },
    { id: 'theme_bordeaux',   name: 'Bordeaux',     unlock: null, price: THEME_PRICE },
    { id: 'theme_clair',      name: 'Clair',        unlock: null, price: THEME_PRICE },
    { id: 'theme_marquee',    name: 'Marquee',      unlock: null, price: THEME_PRICE },
    { id: 'theme_minuit',     name: 'Minuit',       unlock: null, price: THEME_PRICE },
    { id: 'theme_sable',      name: 'Sable Royale', unlock: null, price: THEME_PRICE },
    { id: 'theme_riviera',    name: 'Riviera',      unlock: null, price: THEME_PRICE },
  ],
  // REPLACED WHOLESALE — the eight original scenes (Velvet Room, Rooftop,
  // Grand Library, Winter Casino, Moon Room, Garden, Train, Observatory)
  // are gone, art AND ids, in favour of real photographic rooms, then
  // extended with a second batch of seven. Not deprecated gradually:
  // their .webp files are deleted from public/scenes/ too, same call as
  // the House Regulars avatar swap.
  //
  // `scene_observatory` is the ONE id carried over from the retired set,
  // deliberately: it is the same room re-arted rather than a different
  // place, so reusing the id preserves anyone who already bought it.
  // Every other original-batch id is genuinely a different room and takes
  // a new id — a player who owned one of those loses that specific
  // purchase, since player_purchases is keyed on item_id and the old id no
  // longer resolves. Accepted rather than migrated: retiring a cosmetic is
  // already documented as safe (filterEquipped drops an unknown id on
  // read, falling back to the default rather than rendering nothing), and
  // a purchase-id remap table would be permanent bookkeeping for a
  // one-off art swap.
  //
  // ALL FOURTEEN NON-DEFAULT SCENES ARE SHOP-EXCLUSIVE — no achievement
  // route at all, on request: `unlock:null` + a price is the shape
  // cardfront_noir already established for "purchase only". Priced in two
  // flat tiers by which batch they arrived in, not by rarity — every scene
  // is the same KIND of cosmetic (a background photo), so there's nothing
  // for a per-item rarity tier to actually track. The five achievement
  // gates the first batch briefly carried (ach_the_house, ach_moon_chaser,
  // ach_heartbreaker, ach_the_dealer, ach_high_roller) are gone; nothing
  // else in COSMETICS points at those ids, so no other cosmetic lost a
  // route by this.
  //
  // NAMING: `scene_ashen_gate` is the art supplied as "Mordor". The
  // picture itself is generic dark fantasy — a lava fortress gate, no
  // Tolkien landmark in it — but "Mordor" is a Middle-earth Enterprises
  // trademark, so the scene ships under a descriptive name instead. Only
  // the display string and the id differ; the artwork is untouched.
  scenes: [
    { id: 'scene_moulin_rouge',   name: 'The Moulin Rouge',   unlock: null },
    { id: 'scene_holiday',        name: 'Holiday',            unlock: null, price: SCENE_PRICE_1 },
    { id: 'scene_victorian_room', name: 'The Victorian Room', unlock: null, price: SCENE_PRICE_1 },
    { id: 'scene_noir_casino',    name: 'The Noir Casino',    unlock: null, price: SCENE_PRICE_1 },
    { id: 'scene_moon_balcony',   name: 'The Moon Balcony',   unlock: null, price: SCENE_PRICE_1 },
    { id: 'scene_conservatory',   name: 'The Conservatory',   unlock: null, price: SCENE_PRICE_1 },
    { id: 'scene_theater',        name: 'The Theater',        unlock: null, price: SCENE_PRICE_1 },
    { id: 'scene_observatory',    name: 'The Observatory',    unlock: null, price: SCENE_PRICE_1 },
    { id: 'scene_skyline',        name: 'The Skyline',        unlock: null, price: SCENE_PRICE_2 },
    { id: 'scene_waterfall',      name: 'The Waterfall',      unlock: null, price: SCENE_PRICE_2 },
    { id: 'scene_throne_room',    name: 'The Throne Room',    unlock: null, price: SCENE_PRICE_2 },
    { id: 'scene_docks',          name: 'The Docks',          unlock: null, price: SCENE_PRICE_2 },
    { id: 'scene_ashen_gate',     name: 'The Ashen Gate',     unlock: null, price: SCENE_PRICE_2 },
    { id: 'scene_arabian_nights', name: 'Arabian Nights',     unlock: null, price: SCENE_PRICE_2 },
    { id: 'scene_magic_forest',   name: 'The Magic Forest',   unlock: null, price: SCENE_PRICE_2 },
  ],
  cardFronts: [
    { id: 'cardfront_standard',    name: 'Classic',      unlock: null },
    // Royal Court is achievement-only, no price — Nocturne Deck, which
    // briefly shared this unlock string and took the shop slot, has been
    // deleted from the game entirely (id, art, everything). Nothing else
    // pointed at cardfront_nocturne, so removing it needed no further
    // cleanup here.
    { id: 'cardfront_royal_court', name: 'Royal Court',  unlock: 'ach_queen_hunter' },
    // TEMPORARY: both un-gated (no price) so the just-fixed Noir crop and
    // the new Bold Deck can be checked in-game directly, no credits
    // needed. Real gates, to restore before real players see this:
    //   { id: 'cardfront_noir', name: 'Noir Casino', unlock: null, price: CREDIT_PRICES.epic },
    //   { id: 'cardfront_bold', name: 'Bold Deck',   unlock: null, price: CREDIT_PRICES.rare },
    // While un-gated they also don't appear in the Shop at all, since
    // renderShop only lists priced items — equip both from My Account.
    { id: 'cardfront_noir',        name: 'Noir Casino',   unlock: null },
    { id: 'cardfront_bold',        name: 'Bold Deck',     unlock: null },
    // Shop-exclusive at a flat 1500, same unlock:null+price shape
    // cardfront_noir established — not one of the CREDIT_PRICES tiers,
    // a specifically requested price rather than a rarity-tier fit.
    { id: 'cardfront_stained_glass', name: 'Stained Glass Deck', unlock: null, price: 1500 },
    { id: 'cardfront_porcelain',     name: 'Porcelain Deck',     unlock: null, price: 2000 },
    { id: 'cardfront_verdant_nouveau', name: 'Verdant Nouveau Deck', unlock: null, price: 1500 },
  ],
  // Crests are 1:1 with achievements by design (the brief's whole point:
  // a crest IS the visible proof of an achievement), so they're derived
  // from ACHIEVEMENTS rather than listed twice and kept in sync by hand.
  get crests() {
    // Crests are 1:1 with achievements and always have been; the name now
    // comes from the ladder's FIRST rung, which is the one that grants it.
    return ACHIEVEMENTS.map(a => ({ id: a.crest, name: a.names[0], unlock: a.id }));
  },
  // Rank sets, derived from RANK_COSMETICS rather than listed twice.
  // `rankTier` is what marks them tier-unlocked in cosmeticsFor, the
  // same mechanism the rank titles already use.
  get rankSets() {
    return RANK_COSMETICS.map(r => ({
      id: 'rank_' + r.slug, name: r.tier, rankTier: r.slug,
      material: r.material, emblem: r.emblem,
    }));
  },
  // Titles: one per achievement (deduplicated — two achievements may
  // grant the same title), plus the rank titles, which unlock off the
  // ranked tier the server already derives rather than any new counter.
  titles: [
    { id: 'title_queen_hunter',      name: 'The Queen Hunter',    unlock: 'ach_queen_hunter' },
    { id: 'title_four_suit_master',  name: 'Four-Suit Master',    unlock: 'ach_four_suit' },
    { id: 'title_the_house',         name: 'The House',           unlock: 'ach_the_house' },
    { id: 'title_moon_chaser',       name: 'Moon Chaser',         unlock: 'ach_moon_chaser' },
    { id: 'title_heartbreaker',      name: 'Heartbreaker',        unlock: 'ach_heartbreaker' },
    { id: 'title_strategist',        name: 'The Strategist',      unlock: 'ach_strategist' },
    { id: 'title_dealers_nemesis',   name: "Dealer's Nemesis",    unlock: 'ach_silent_dealer' },
    { id: 'title_high_roller',       name: 'High Roller',         unlock: 'ach_high_roller' },
    { id: 'title_blame_the_dealer',  name: 'Blame the Dealer',    unlock: 'ach_the_dealer' },
    { id: 'title_beyond_moon',       name: 'Beyond the Moon',     unlock: 'ach_beyond_moon' },
    { id: 'title_the_slam',          name: 'The Trickster',       unlock: 'ach_the_slam' },
    { id: 'title_the_ledger',        name: 'The Godfather',       unlock: 'ach_ledger' },
    { id: 'title_clean_sheet',       name: 'Clean Sheet',         unlock: 'ach_clean_sheet' },
    { id: 'title_queen_dodger',      name: 'Not My Queen',        unlock: 'ach_queen_dodger' },
    { id: 'title_steady_hand',       name: 'Steady Hand',         unlock: 'ach_steady_hand' },
    { id: 'title_abyss',             name: 'Out of the Abyss',    unlock: 'ach_abyss' },
    { id: 'title_rock_bottom',       name: 'Rock Bottom',         unlock: 'ach_rock_bottom' },
    // rankTier is a SLUG, not a display name — tierReached compares
    // against RANK_TABLE's slug, so a capitalised tier name here would
    // silently never match and lock every rank title forever.
    { id: 'title_rising_star',       name: 'Rising Star',         rankTier: 'silver' },
    { id: 'title_one_more_game',     name: 'One More Game',       rankTier: 'gold' },
    { id: 'title_no_hearts_please',  name: 'No Hearts, Please',   rankTier: 'platinum' },
    { id: 'title_ace',               name: 'The Ace',             rankTier: 'diamond' },
    { id: 'title_definitely_not_counting_cards', name: 'Definitely Not Counting Cards', rankTier: 'master' },
    { id: 'title_grandmaster',       name: 'The Grandmaster',     rankTier: 'grandmaster' },
    { id: 'title_the_legend',        name: 'The Legend',          rankTier: 'legend' },
  ],
  // Portrait avatars, derived from AVATAR_COLLECTIONS rather than listed
  // twice — same reasoning as crests/rankSets above. A getter because
  // AVATAR_COLLECTIONS/PRICED_AVATAR_IDS are defined further down the
  // file; deferred until first read, same as those two.
  get avatars() {
    return AVATAR_COLLECTIONS.flatMap(c => c.avatars.map(([id, name]) => ({
      id, name, unlock: null,
      price: PRICED_AVATAR_IDS.has(id) ? AVATAR_PRICE : undefined,
    })));
  },
};

// Rank titles unlock at a tier and STAY unlocked — RANK_TABLE's order is
// the ladder, so "have I ever been at least this tier" is an index
// comparison against the peak MMR the ranked table already stores. Peak,
// not current, so a cosmetic is never silently revoked by a losing streak
// (the brief is explicit about that).
// Ordered by slug, not by display name — the slug is the stable key (see
// RANK_TABLE), so renaming a tier can never silently break this ladder
// comparison the way matching on a label would.
const TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster', 'legend'];
function tierReached(mmrPeak, slug) {
  const reached = rankForMmr(mmrPeak || 0).slug;
  return TIER_ORDER.indexOf(reached) >= TIER_ORDER.indexOf(slug);
}

// ── Rank cosmetics ──────────────────────────────────────────────
// One set per TIER (8), not per rank state (22): the reference sheet
// defines eight, and divisions within a tier share a look. Unlocked
// purely by reaching the tier — never purchasable, and never revoked if
// MMR later falls, which is why tierReached reads PEAK mmr.
// `material` is the sheet's own colour-theme name and is what the CSS
// fallback renders from until the exported emblem art lands; `emblem`
// names the artwork so a missing file is obvious in devtools.
const RANK_COSMETICS = [
  { slug: 'bronze',      tier: 'Novice',       material: 'paper',    emblem: 'shield' },
  { slug: 'silver',      tier: 'Apprentice',   material: 'ink',      emblem: 'pen' },
  { slug: 'gold',        tier: 'Player',       material: 'velvet',   emblem: 'fleur' },
  { slug: 'platinum',    tier: 'Gambler',      material: 'brass',    emblem: 'chip' },
  { slug: 'diamond',     tier: 'Ace',          material: 'gold',     emblem: 'spade' },
  { slug: 'master',      tier: 'Master',       material: 'royal',    emblem: 'crown' },
  { slug: 'grandmaster', tier: 'Grand Master', material: 'obsidian', emblem: 'shard' },
  { slug: 'legend',      tier: 'Legend',       material: 'diamond',  emblem: 'diamond' },
];

// ── Portrait avatars ────────────────────────────────────────────
// Replaced wholesale: the original 5 fantasy-roleplay collections (20
// avatars — Royal Court, Noir Casino, Emerald Society, Moonlit Occult,
// Grand Hotel) were pulled entirely at the requester's own call ("not
// happy with them in the end"), not deprecated gradually. Their art
// files are deleted from public/avatars/, not just unlisted, and their
// ids are gone from AVATAR_IDS — see sanitizeAvatar and the client's
// avatarHTML for how an account that still has one of the old ids
// stored degrades gracefully to initials instead of showing raw text.
//
// Like their predecessors, these carry NO unlock condition — the
// reference sheet's unlock only ever applied to rank cosmetics, and the
// emoji avatars beside them have always been free. Still require an
// account, but only because editing your identity already did (the
// guest gate on the account screen), not because of anything cosmetic.
//
// Stored in `accounts.avatar`, the SAME column the emoji avatars use,
// rather than in player_cosmetics — an avatar is identity, already
// carried through publicState and every leaderboard query, and a second
// home would mean two sources of truth for what a player looks like.
//
// Source art for this set is real photo-illustration portraits (not
// generated for this game specifically — see CLAUDE.md for the crop
// contract): each was supplied as a 1254x1254 circular medallion with a
// baked-in gold ring and house crest, and EVERY avatar in this
// collection now keeps that ring rather than cropping it away — see
// CLAUDE.md for why the first 7 originally didn't (a since-reverted
// attempt to avoid competing with the app's own state-reactive avatar
// border) and why that was abandoned in favour of consistency.
//
// Only 7 in the first sub-batch, not 8: an 8th source file ("the host",
// a big open smile) existed when this was scoped but was gone from disk
// by the time of actual cropping — most likely evicted by OneDrive's
// on-demand sync between being shown and being processed. Nothing
// references it; it can be added whenever the file resurfaces.
const AVATAR_COLLECTIONS = [
  { id: 'house_regulars', name: 'House Regulars', dir: 'house-regulars',
    avatars: [['regular_charmer', 'The Charmer', 'charmer'], ['regular_sharp', 'The Sharp', 'sharp'],
              ['regular_optimist', 'The Optimist', 'optimist'], ['regular_jester', 'The Jester', 'jester'],
              ['regular_scholar', 'The Scholar', 'scholar'], ['regular_wildcard', 'The Wildcard', 'wildcard'],
              ['regular_closer', 'The Closer', 'closer'],
              ['regular_belle', 'The Belle', 'belle'], ['regular_countess', 'The Countess', 'countess'],
              ['regular_envoy', 'The Envoy', 'envoy'], ['regular_baron', 'The Baron', 'baron'],
              ['regular_castaway', 'The Castaway', 'castaway'],
              ['regular_rookie', 'The Rookie', 'rookie'], ['regular_sheikh', 'The Sheikh', 'sheikh'],
              ['regular_duke', 'The Duke', 'duke'], ['regular_reveler', 'The Reveler', 'reveler']] },
];
const AVATAR_IDS = new Set(
  AVATAR_COLLECTIONS.flatMap(c => c.avatars.map(a => a[0]))
);
// The original 7 (charmer..closer) stay free, matching how they shipped.
// The 9 added later are shop-exclusive at a flat 500 credits — no
// achievement route, same unlock:null+price shape cardfront_noir
// established, just cheaper since there are nine of them rather than one.
const AVATAR_PRICE = 500;
const PRICED_AVATAR_IDS = new Set([
  'regular_belle', 'regular_countess', 'regular_envoy', 'regular_baron', 'regular_castaway',
  'regular_rookie', 'regular_sheikh', 'regular_duke', 'regular_reveler',
]);

// The single evaluation point. Everything downstream — the Achievements
// tab, every cosmetic picker, and save-time validation — reads this one
// result, so there is exactly one definition of "unlocked" in the app.
// ── achievement buffering ───────────────────────────────────────
// NOTHING banks until the game actually finishes. Queens taken and hands
// dealt used to write straight to the DB from resolveTrick and dealRound,
// which meant a player could farm them by abandoning game after game.
// They now accumulate on the room and are flushed once, from
// recordGameFinishedForAll - so an abandoned game contributes nothing at
// all, which is the rule the whole set is meant to obey.
//
// Lazily created rather than added to createRoom: rooms are in-memory
// only, so there is no migration to worry about, and this keeps the
// feature out of the room constructor entirely.
function achBuf(G) {
  if (!G.ach) {
    G.ach = {
      queens: [0, 0, 0, 0],
      dealt: [0, 0, 0, 0],
      slams: [0, 0, 0, 0],
      clean: [0, 0, 0, 0],
      best: [0, 0, 0, 0],
      worst: [0, 0, 0, 0],
      // Steady Hand (ach_steady_hand) — stays true unless some hand this
      // game nets that player a negative delta. Checked against at the
      // natural-finish flush; see recordGameFinishedForAll.
      noNegRound: [true, true, true, true],
    };
  }
  return G.ach;
}

// Called once per hand, from endRound, with that hand's swing per player.
function recordRoundAchievements(G, deltas) {
  const b = achBuf(G);
  // Tricks actually played this hand. Derived rather than read off
  // G.trickNum because a moon ends the hand early (resolveTrick bails as
  // soon as checkMoon succeeds), and "won every trick" has to mean every
  // trick that was really dealt out.
  const played = G.players.reduce((n, q) => n + q.tricks.length, 0) / 4;
  for (let i = 0; i < 4; i++) {
    const p = G.players[i];
    const d = deltas[i];
    if (d > b.best[i]) b.best[i] = d;
    if (d < b.worst[i]) b.worst[i] = d;
    if (d < 0) b.noNegRound[i] = false;
    const penalties = p.tricks.filter(
      c => c.suit === '♥' || (c.suit === '♠' && c.rank === 'Q')
    ).length;
    if (penalties === 0) b.clean[i]++;
    if (played > 0 && p.tricks.length / 4 === played) b.slams[i]++;
  }
}

function evaluateAchievements(stats) {
  return ACHIEVEMENTS.map(a => {
    const value = stats[a.stat] || 0;
    const level = achievementLevel(a, value);
    const maxLevel = a.tiers.length;
    // The rung still to climb; at full level it stays on the top rung so
    // the client can render "1000 / 1000" rather than a blank.
    const next = a.tiers[Math.min(level, maxLevel - 1)];
    const unlocked = level >= 1;
    // A secret that has not been earned yet leaks NOTHING - not its name,
    // not its description, not the number to aim for. Blanking it here
    // rather than in the client is what actually makes it secret: the
    // whole cosmetics payload goes over the wire, so a crafted client
    // would otherwise just read it out of the response.
    const hide = a.secret && !unlocked;
    return {
      id: a.id,
      name: hide ? null : (a.names[Math.max(0, level - 1)] || a.names[0]),
      desc: hide ? null : a.desc,
      crest: a.crest, title: a.title,
      secret: !!a.secret,
      hidden: hide,
      level, maxLevel,
      tiers: hide ? null : a.tiers,
      threshold: hide ? null : next,
      progress: hide ? 0 : (a.cmp === 'lte' ? value : Math.min(value, next)),
      value: hide ? 0 : value,
      unlocked,
    };
  });
}

function cosmeticsFor(achievements, stats, purchases) {
  const done = new Set(achievements.filter(a => a.unlocked).map(a => a.id));
  const bought = new Set(purchases || []);
  // rankTierName is sent alongside the slug so the client can say
  // "Reach Gambler" without carrying its own copy of RANK_TABLE — the
  // rule that visible rank is server-derived applies here too.
  const tierName = slug => (RANK_COSMETICS.find(r => r.slug === slug) || {}).tier || slug;
  const mark = list => list.map(c => ({
    id: c.id, name: c.name, unlock: c.unlock || null,
    unlockName: c.unlock ? ((ACHIEVEMENTS.find(a => a.id === c.unlock) || {}).names || [])[0] || null : null,
    rankTier: c.rankTier || null,
    rankTierName: c.rankTier ? tierName(c.rankTier) : null,
    material: c.material || null,
    emblem: c.emblem || null,
    price: c.price || null,
    // Only meaningful for an achievement-ladder item (a crest, so far) —
    // the rung reached on c.unlock's own achievement, so the client can
    // pick the matching tier of raster art instead of always showing the
    // first rung's. null for anything not gated on an achievement at all.
    level: c.unlock ? ((achievements.find(a => a.id === c.unlock) || {}).level || 0) : null,
    owned: bought.has(c.id),
    // Earned OR bought. The earned half is still re-derived from
    // achievement_stats on every call, so retuning a threshold takes effect
    // immediately for everyone; the bought half is the only stored piece,
    // and it can never be revoked by a retune.
    //
    // `!c.unlock` alone used to mean "always free" (Classic, the default
    // scene) — every priced item until now ALSO carried an achievement
    // unlock, so that was never ambiguous. A shop-EXCLUSIVE item (priced,
    // no unlock string at all) needs `!c.unlock` to stop meaning "free":
    // gating it on `!c.price` too is what keeps Classic/Velvet Room
    // (no unlock, no price) free while a no-unlock-but-priced item like
    // Noir Casino falls through to `bought.has(c.id)` only, same as
    // everything else purchasable.
    unlocked: c.rankTier ? tierReached(stats.mmrPeak, c.rankTier)
            : ((!c.unlock && !c.price) || done.has(c.unlock) || bought.has(c.id)),
  }));
  return {
    scenes: mark(COSMETICS.scenes),
    cardFronts: mark(COSMETICS.cardFronts),
    crests: mark(COSMETICS.crests),
    titles: mark(COSMETICS.titles),
    rankSets: mark(COSMETICS.rankSets),
    tableThemes: mark(COSMETICS.tableThemes),
    avatars: mark(COSMETICS.avatars),
  };
}

// Drops anything the account hasn't (or no longer has) unlocked, so a
// stale equip can never render. Returns the same shape getCosmetics does.
function filterEquipped(equipped, catalog) {
  const ok = (list, id) => {
    if (!id) return null;
    const found = list.find(c => c.id === id);
    return found && found.unlocked ? id : null;
  };
  // Rank set falls back to the HIGHEST one unlocked rather than to a
  // fixed default: it's the one cosmetic that's automatic, so a player
  // who never opens the picker should still be wearing the set they
  // earned, and should be re-dressed the moment they rank up. Picking a
  // lower set explicitly is still honoured, since ok() runs first.
  const highestRank = [...catalog.rankSets].reverse().find(r => r.unlocked);
  return {
    scene: ok(catalog.scenes, equipped.scene) || 'scene_moulin_rouge',
    cardFront: ok(catalog.cardFronts, equipped.cardFront) || 'cardfront_standard',
    crest: ok(catalog.crests, equipped.crest),
    // Second, independent crest slot — same validation as the first, and
    // deliberately allowed to hold the SAME id as `crest` (no dedupe):
    // nothing about wearing one achievement's crest twice is invalid.
    crest2: ok(catalog.crests, equipped.crest2),
    title: ok(catalog.titles, equipped.title),
    rankSet: ok(catalog.rankSets, equipped.rankSet) || (highestRank ? highestRank.id : null),
    // Obsidienne is the app's default felt (see applyTableTheme client-
    // side) — same "always resolve to something equipped" reasoning as
    // scene/cardFront above, not a fixed fallback picked at random.
    tableTheme: ok(catalog.tableThemes, equipped.tableTheme) || 'theme_obsidienne',
  };
}

// Everything the account screen needs in one round trip: what's unlocked,
// what's equipped (already filtered), and which unlocks haven't been
// celebrated yet. Also used at room-join time to look up a display title.
async function loadPlayerCosmetics(accountId) {
  const stats = await db.getAchievementStats(accountId);
  const achievements = evaluateAchievements(stats);
  const purchases = await db.getPurchases(accountId);
  const catalog = cosmeticsFor(achievements, stats, purchases);
  const stored = await db.getCosmetics(accountId);
  const equipped = filterEquipped(stored, catalog);
  const seen = new Set(stored.seen);
  const fresh = achievements.filter(a => a.unlocked && !seen.has(a.id)).map(a => a.id);
  const credits = await db.getCredits(accountId);
  return { stats, achievements, catalog, equipped, fresh, credits };
}

// The display string for a seat, or null. Guests and accounts with no
// title equipped both come back null, which every render path already
// treats as "just show the name".
function titleNameFor(id) {
  const t = COSMETICS.titles.find(x => x.id === id);
  return t ? t.name : null;
}

// What another player sees on your seat: your title and your rank set's
// material. Resolved ONCE per join — see the note on the player object's
// `title` field for why this must not move into publicState.
// Returns the empty shape rather than throwing: these are decorations,
// and a DB blip must never stop someone sitting down.
const NO_SEAT_COSMETICS = {
  title: null, rankMaterial: null,
  crest: null, crestLevel: 1, crest2: null, crest2Level: 1,
};
async function lookupSeatCosmetics(accountId) {
  if (!DB_ENABLED || !accountId) return NO_SEAT_COSMETICS;
  try {
    const { equipped, catalog } = await loadPlayerCosmetics(accountId);
    const set = catalog.rankSets.find(r => r.id === equipped.rankSet);
    // Same "resolve once at join, not per broadcast" contract as title/
    // rankMaterial above — crest level is looked up here rather than
    // re-read from the catalog on every gameState.
    const crestLevel = equipped.crest
      ? ((catalog.crests.find(c => c.id === equipped.crest) || {}).level || 1) : 1;
    const crest2Level = equipped.crest2
      ? ((catalog.crests.find(c => c.id === equipped.crest2) || {}).level || 1) : 1;
    return {
      title: titleNameFor(equipped.title),
      rankMaterial: set ? set.material : null,
      crest: equipped.crest || null,
      crestLevel,
      crest2: equipped.crest2 || null,
      crest2Level,
    };
  } catch (e) {
    return NO_SEAT_COSMETICS;
  }
}

// ── Room lifecycle ──────────────────────────────────────────────
function sanitizeAvatar(a) {
  const s = String(a || '').trim();
  // A portrait-avatar ID is a known constant, so it's passed through
  // whole. The 8-char slice below exists to bound arbitrary emoji input
  // and would mangle these ("regular_charmer" -> "regular_"), which is
  // why the allow-list check has to come first.
  if (AVATAR_IDS.has(s)) return s;
  // A snake_case value that ISN'T a currently-known id is a STALE
  // portrait id (from a since-removed collection — see AVATAR_COLLECTIONS'
  // own note above), not emoji/text input: real emoji are never plain
  // ASCII letters and underscores. Clearing it outright is what lets the
  // client's initials fallback take over cleanly next render, rather
  // than leaving a mangled 8-char remnant ("royal_king" -> "royal_ki")
  // sitting in the account forever.
  if (/^[a-z_]+$/.test(s)) return null;
  return s.slice(0, 8) || null;
}

// `opts` is optional and every field defaults to the classic game, so
// existing call sites (createRoom socket handler, formRankedMatch) keep
// behaving exactly as before without passing anything.
function createRoom(hostName, hostAvatar, hostAccountId, opts) {
  const o = opts || {};
  const code = makeCode();
  rooms[code] = {
    code,
    // Room codes are short and get reused after a room closes, so the code
    // ALONE can't identify a payable game. code+startedAt can, and that is
    // what credit_transactions' UNIQUE (account_id,type,reference_id) keys
    // off to make a retried grant a no-op instead of a double payment.
    startedAt: Date.now(),
    phase: 'lobby',
    ranked: false,
    roundsTotal: sanitizeRoundsTotal(o.roundsTotal),
    daily: !!o.daily,            // Daily Challenge room — one seeded hand, own leaderboard
    dailyDate: o.dailyDate || null,
    // Pins one pass direction for every round, overriding the normal
    // round-number cycle. null = ordinary cycle. 'keep' means no pass
    // phase at all; the other three run a real one.
    forcePassDir: PASS_DIRS.includes(o.forcePassDir) ? o.forcePassDir : null,
    dailySubmitted: false,
    rankedTimers: [null, null, null, null], // per-seat disconnect→AI-takeover timeout handles (ranked only)
    players: Array.from({ length: 4 }, (_, i) => ({
      name: i === 0 ? hostName : 'Empty seat',
      avatar: i === 0 ? sanitizeAvatar(hostAvatar) : null,
      accountId: i === 0 ? (hostAccountId || null) : null,
      // Equipped player title and rank-set material, resolved once at
      // join time (see lookupSeatCosmetics) rather than per broadcast —
      // they're cosmetic strings, and re-reading them on every gameState
      // would put a DB round trip in the hot path of every card played.
      title: null,
      rankMaterial: null,
      crest: null, crestLevel: 1, crest2: null, crest2Level: 1,
      isAI: false, socketId: null, token: null,
      score: 0, hand: [], tricks: [], connected: false, hasPassed: false,
      // Suits this player has won a trick in, for the whole GAME — the
      // Four-Suit Master achievement. `tricks` can't serve: dealRound
      // clears it every hand, so by the final round it only describes
      // that hand. Reset in startDraw/startGame, read once at game end.
      suitsWon: [],
    })),
    hostSocket: null,
    hostToken: null,
    round: 1,
    dealer: -1,
    drawRound: 0,
    drawCards: [],
    drawRevealed: [false, false, false, false],
    heartsbroken: false,
    currentTrick: [],
    trickLeader: 0,
    trickNum: 1,
    passSelected: [null, null, null, null],
    receivedThisRound: [[], [], [], []],
    roundBefore: [0, 0, 0, 0],
    history: [],
    autoAt: 0,
    autoTimer: null,
    endVote: null,
    voteAt: 0,
    voteTimer: null,
    voteMsg: '',
    emptySince: null,
    lastTrickMsg: '',
    moonShooter: -1,
    moonCounts: [0, 0, 0, 0], // per-seat moon shots this game, for the "most in one game" stat
    lastActivity: Date.now(),
  };
  return rooms[code];
}

// ── Daily Challenge ───────────────────────────────────────────────
// One seeded hand per UTC day, solo against three computers, no pass
// phase, scored on the normal rules and compared on a per-day
// leaderboard. It reuses the ordinary room/G object and the ordinary
// play loop wholesale — the only differences are the seeded deck (see
// dealRound), roundsTotal = 1, a pinned pass direction, and its own
// result pipeline. The AI seats are plain AI seats — same aiChoose, same
// aiSelectPass, same everything a casual game runs.
function createDailyRoom(name, avatar, accountId, socketId) {
  const date = dailyDateKey();
  const G = createRoom(name, avatar, accountId, {
    daily: true, dailyDate: date, forcePassDir: dailyPassDir(date),
  });
  G.roundsTotal = 1;            // set directly: 1 isn't one of the offered ROUND_OPTIONS
  const token = makeToken();
  Object.assign(G.players[0], { socketId, connected: true, token });
  G.hostSocket = socketId;
  G.hostToken = token;
  for (let i = 1; i < 4; i++) {
    Object.assign(G.players[i], {
      name: `Computer ${i + 1}`, avatar: null, accountId: null,
      isAI: true, connected: true, socketId: null, token: null,
    });
  }
  // No seat draw and no dealer cut — but the dealer still varies by day,
  // drawn from the date like everything else, so who leads trick 1 isn't
  // always the same seat. Deterministic, hence no cut needed to settle it.
  G.dealer = dailyDealer(date);
  return { G, token };
}

// Called once, from recordGameFinishedForAll, when the single daily round
// has been played out. The score is taken from the server's own game
// state — the client never sends one.
function submitDailyResult(G) {
  if (G.dailySubmitted) return;
  G.dailySubmitted = true;
  const p = G.players[0];
  const score = p.score;
  const tricksWon = p.tricks.length / 4;
  const shotMoon = G.moonShooter === 0;
  const socketId = p.socketId;
  const payload = { date: G.dailyDate, score, tricksWon, shotMoon, streak: null, position: null, entries: null,
                    credits: DAILY_CREDIT_FLOOR + Math.round(Math.max(0, score) * DAILY_CREDIT_PER_POINT) };

  if (!DB_ENABLED || !p.accountId) {
    // Guests still get their score and the day's deal; they just don't
    // appear on the leaderboard and don't carry a streak.
    // Guests earn nothing anywhere in this system, so the credit figure is
    // zeroed rather than shown-but-not-banked.
    if (socketId) io.to(socketId).emit('dailyResult', { ...payload, credits: 0, guest: true });
    return;
  }

  // Same retry policy as every other stat write — a Railway blip must not
  // silently cost someone their streak.
  trackStat(async () => {
    await db.recordDailyScore(p.accountId, G.dailyDate, score, tricksWon, shotMoon);
    const streak = await db.bumpDailyStreak(p.accountId, G.dailyDate);
    // Flat floor for showing up, plus a straight multiplier on a positive
    // finish only. Deliberately simpler than the multiplayer formula: this
    // is one attempt a day, not a placement, so there is nothing to clamp
    // against. Keyed on the date, so the whole block stays safe to retry.
    const dailyCredits = DAILY_CREDIT_FLOOR
      + Math.round(Math.max(0, score) * DAILY_CREDIT_PER_POINT);
    await db.grantCredits(p.accountId, dailyCredits, 'daily_reward', G.dailyDate);
    const standing = await db.getDailyStanding(p.accountId, G.dailyDate);
    if (socketId) {
      io.to(socketId).emit('dailyResult', {
        ...payload,
        streak: streak.streak, bestStreak: streak.bestStreak,
        position: standing ? standing.position : null,
        entries: standing ? standing.entries : null,
      });
    }
  });
}

// ── Campaign Mode ("The Hundred Tables") ────────────────────────────
// A single-player story mode: the human plays the SAME card engine every
// other mode runs, against 3 AI seats, through a fixed sequence of
// pre-authored hands — same "reuse createRoom/dealRound wholesale"
// approach Daily Challenge already established. Chapter 1 only in this
// build (Levels 1-10, boss The Glass Baron); every shape below is
// written generically so Chapters 2-10 can be dropped in later without
// touching engine code, the same "drop the data in, no code change"
// contract this codebase already uses for achievements/cosmetics.
// Keep in step with campaign_progress.attempts_current's DEFAULT in
// db.js (that default only seeds a brand-new row; this constant is the
// real cap, passed into every getCampaignState/consumeCampaignAttempt
// call). Lowering this is safe for existing accounts — getCampaignState
// clamps whatever is stored down to the new max on read.
// ── TEMPORARY: unlimited campaign attempts, for playtesting ──
// Flip this ONE constant back to false to restore the normal
// CAMPAIGN_MAX_ATTEMPTS cap. Nothing else needs changing: while it's
// true, startCampaignLevel skips spending an attempt and the map
// reports the pool as unlimited (the client renders ∞ instead of
// "n/15"). The stored attempts_current is left completely untouched,
// so whatever players had before this is exactly what they get back.
const CAMPAIGN_UNLIMITED_ATTEMPTS = true;
const CAMPAIGN_MAX_ATTEMPTS = 15;
const CAMPAIGN_ATTEMPT_REFILL_MS = 20 * 60 * 1000; // placeholder — no economy spec existed, tune freely
const CAMPAIGN_CREDITS_BY_TYPE = { Normal: 15, Harder: 22, BOSS: 60 }; // placeholder, same reason

function parseCardStr(s) { return { rank: s.slice(0, -1), suit: s.slice(-1) }; }
function parseHand(str) { return str.trim().split(/\s+/).map(parseCardStr); }

// Presentation data (name only) lives here; real portrait art is a
// drop-in-later asset on the client (campaignPortraitImg), same contract
// as scene/rank art. 'player' is a placeholder — the client always
// renders the PLAYER'S OWN live name/avatar for that speaker, never this
// entry, since campaign is account-gated and the identity is already known.
const CAMPAIGN_CHARACTERS = {
  concierge:   { id: 'concierge',   name: 'The Concierge' },
  reg1:        { id: 'reg1',        name: 'Regular #1' },
  reg2:        { id: 'reg2',        name: 'Regular #2' },
  reg3:        { id: 'reg3',        name: 'Regular #3' },
  glass_baron: { id: 'glass_baron', name: 'The Glass Baron' },
  // TWO rooftop players, not the screenplay's three. Once the Glass
  // Baron holds a chair (he stays on after escorting the PLAYER up),
  // the table has exactly two rooftop seats left — three distinct
  // rooftop players were never stageable. The screenplay's #3 lines are
  // folded into these two; no line was cut, only reattributed.
  rooftop1:    { id: 'rooftop1',    name: 'Rooftop Player #1' },
  rooftop2:    { id: 'rooftop2',    name: 'Rooftop Player #2' },
  // seatAvatar: an existing in-game avatar id (AVATAR_IDS) to dress this
  // character's SEAT with during the hand itself, so the table shows a
  // real face instead of initials. Only set where the character already
  // has avatar art in the game — The Sharp is literally one of the House
  // Regulars, so his campaign appearance and his avatar are the same
  // person and should look it.
  the_sharp:   { id: 'the_sharp',   name: 'The Sharp', seatAvatar: 'regular_sharp' },
  lib1:        { id: 'lib1',        name: 'Library Player #1' },
  lib2:        { id: 'lib2',        name: 'Library Player #2' },
  lib3:        { id: 'lib3',        name: 'Library Player #3' },
  // Same deal as The Sharp — already a House Regular, so campaign and
  // avatar are the same person and share the one piece of art.
  the_scholar: { id: 'the_scholar', name: 'The Scholar', seatAvatar: 'regular_scholar' },
  lounge1:     { id: 'lounge1',     name: 'Lounge Player #1' },
  lounge2:     { id: 'lounge2',     name: 'Lounge Player #2' },
  lounge3:     { id: 'lounge3',     name: 'Lounge Player #3' },
  the_wildcard:{ id: 'the_wildcard',name: 'The Wildcard', seatAvatar: 'regular_wildcard' },
  cons1:       { id: 'cons1',       name: 'Conservatory Player #1' },
  cons2:       { id: 'cons2',       name: 'Conservatory Player #2' },
  cons3:       { id: 'cons3',       name: 'Conservatory Player #3' },
  the_optimist:{ id: 'the_optimist',name: 'The Optimist', seatAvatar: 'regular_optimist' },
  // The Optimist's running gag needs someone to turn him down. The
  // screenplay writes four separate walk-ons (at the fountain, passing,
  // at the next table, by the fountain); they're collapsed into one
  // recurring guest so she can carry real art rather than four
  // monogrammed strangers with one line each — and "Still no." lands
  // better from someone he has already asked.
  cons_guest:  { id: 'cons_guest',  name: 'A Guest' },
  cabaret1:    { id: 'cabaret1',    name: 'Cabaret Player #1' },
  cabaret2:    { id: 'cabaret2',    name: 'Cabaret Player #2' },
  cabaret3:    { id: 'cabaret3',    name: 'Cabaret Player #3' },
  // Same deal as The Sharp/Scholar/Wildcard/Optimist — already a House
  // Regular, so campaign and avatar are the same person.
  the_jester:  { id: 'the_jester',  name: 'The Jester', seatAvatar: 'regular_jester' },
  ballroom1:   { id: 'ballroom1',   name: 'Ballroom Player #1' },
  ballroom2:   { id: 'ballroom2',   name: 'Ballroom Player #2' },
  ballroom3:   { id: 'ballroom3',   name: 'Ballroom Player #3' },
  // Same deal again — already a House Regular.
  the_charmer: { id: 'the_charmer', name: 'The Charmer', seatAvatar: 'regular_charmer' },
  vault1:      { id: 'vault1',      name: 'Vault Player #1' },
  vault2:      { id: 'vault2',      name: 'Vault Player #2' },
  vault3:      { id: 'vault3',      name: 'Vault Player #3' },
  // A true one-off — appears in his own aside at a neighboring table for
  // exactly one level (74) and never again, unlike every other named
  // walk-on so far (cons_guest recurs). No seatAvatar: he never sits at
  // the PLAYER's own table, so there's no seat to dress.
  nervous_player: { id: 'nervous_player', name: 'Nervous Player' },
  // Same deal as every other boss who's already a House Regular.
  the_closer:  { id: 'the_closer',  name: 'The Closer', seatAvatar: 'regular_closer' },
  private1:    { id: 'private1',    name: 'Private Player #1' },
  private2:    { id: 'private2',    name: 'Private Player #2' },
  private3:    { id: 'private3',    name: 'Private Player #3' },
  // Unlike every boss since The Sharp, NOT given a seatAvatar — fresh
  // dedicated portrait art was supplied for her specifically rather
  // than reusing the existing regular_countess House Regular (a
  // different pose/setting entirely), a deliberate art choice rather
  // than an oversight. She renders through the same generic
  // /campaign/characters/the_countess.webp path every non-reused
  // character already uses, both at the table and in dialogue.
  the_countess:{ id: 'the_countess',name: 'The Countess' },
  // The three "identical" women who hold all three opponent seats for
  // the whole of Chapter 10 — not just at the x0 level, unlike every
  // earlier chapter. All share the exact same portrait file (see
  // CAMPAIGN_PORTRAIT_SRC on the client) since the screenplay's whole
  // point is that they cannot be told apart.
  dame1:       { id: 'dame1',       name: 'Woman One' },
  dame2:       { id: 'dame2',       name: 'Woman Two' },
  dame3:       { id: 'dame3',       name: 'Woman Three' },
  // Used only as CAMPAIGN_CHAPTERS[10]'s bossId (the map's boss-teaser
  // corner) and Level 100's own bossId (so the "Chapter Boss" seat tag
  // and the in-hand leave-menu's boss name resolve to something,
  // exactly like every other boss level) — mechanically it substitutes
  // into the SAME seat that was already dame3, with the same portrait,
  // so nothing actually changes at the table. That's deliberate: no
  // seat physically turns over at Level 100 the way it does in every
  // earlier chapter, because all three women were already seated since
  // Level 91.
  dame_de_pique:{ id: 'dame_de_pique', name: 'Dame de Pique' },
  // Two one-off speakers for Level 100's ending, same "single-appearance
  // named character" treatment as Chapter 8's nervous_player. Both share
  // the identical portrait too — even after the "reveal," her face never
  // changes, which is the point.
  the_three_women:    { id: 'the_three_women',    name: 'The Three Women' },
  the_remaining_woman:{ id: 'the_remaining_woman',name: 'The Remaining Woman' },
  player:      { id: 'player',      name: null },
};

// Who sits at an ordinary (non-boss) table per chapter, and which of
// those three seats the chapter boss takes over at the x0 level. The
// Glass Baron stays on at the Rooftop table after escorting the PLAYER
// up there — he keeps speaking through Chapter 2 in the screenplay, so
// he holds a real chair rather than hovering behind one. The Sharp then
// takes Rooftop Player #2's seat at Level 20 — the screenplay's own
// seat-claim beat ("Your seat." / "There it is."), reattributed along
// with the rest of its #3 lines (see CAMPAIGN_CHARACTERS above).
const CAMPAIGN_CHAPTER_ROSTER = {
  1: { regulars: ['reg1', 'reg2', 'reg3'], bossSeat: 2 },
  2: { regulars: ['glass_baron', 'rooftop1', 'rooftop2'], bossSeat: 2 },
  // Chapter 3 needs no carried-over guest: The Scholar watches from a
  // reading desk rather than a chair, so the three library players hold
  // all three seats until he taps #3 out at Level 30 — exactly the
  // screenplay's staging, no reattribution needed.
  3: { regulars: ['lib1', 'lib2', 'lib3'], bossSeat: 2 },
  // The Wildcard roams the room rather than sitting, so again all three
  // chairs are the chapter's own players until he claims #3's at Level 39
  // ("Recess." / "That means my seat, does it?").
  4: { regulars: ['lounge1', 'lounge2', 'lounge3'], bossSeat: 2 },
  5: { regulars: ['cons1', 'cons2', 'cons3'], bossSeat: 2 },
  // The Jester also roams rather than sitting — Cabaret Player #3 "stays
  // seated for the hand but looks resigned" through Level 59 and only
  // actually stands at the Level 59→60 transition (postClear, after the
  // chair-claim threat lands), the same one-level-early tease every
  // other chapter's boss uses before claiming seat #3 at the x0 level.
  6: { regulars: ['cabaret1', 'cabaret2', 'cabaret3'], bossSeat: 2 },
  // The Charmer mingles rather than sitting, same as every other roaming
  // boss — he claims seat #3 at the Level 69→70 transition (postClear,
  // "Only if our guest clears." / "Shall we?"), the same one-level-early
  // tease every other chapter's boss uses before the x0 level.
  7: { regulars: ['ballroom1', 'ballroom2', 'ballroom3'], bossSeat: 2 },
  // The Closer roams too, right up until Level 79's postClear ("That
  // means me." / "It does.") — the same one-level-early tease as every
  // other chapter boss before he takes seat #3 for Level 80.
  8: { regulars: ['vault1', 'vault2', 'vault3'], bossSeat: 2 },
  // The Countess never sits until she claims seat #3 for Level 90 —
  // same one-level-early tease, at Level 89's postClear ("PRIVATE
  // PLAYER #3 stands. THE COUNTESS rises from her chair and crosses to
  // the table.").
  9: { regulars: ['private1', 'private2', 'private3'], bossSeat: 2 },
  // All three seats are the "identical" women from Level 91 on — there
  // is no ordinary-regulars-then-boss-arrives structure here. Level
  // 100's bossId substitutes dame3's own seat with dame_de_pique (same
  // portrait), a cosmetic relabel rather than a real seat change.
  10: { regulars: ['dame1', 'dame2', 'dame3'], bossSeat: 2 },
};
// The three AI seats (1..3) for a level, boss substitution applied.
function campaignSeatCharacters(level) {
  const chapter = (CAMPAIGN_CHAPTERS.find(c => c.id === level.chapter) || {}).id;
  const roster = CAMPAIGN_CHAPTER_ROSTER[chapter] || CAMPAIGN_CHAPTER_ROSTER[1];
  const ids = roster.regulars.slice();
  if (level.type === 'BOSS' && level.bossId) ids[roster.bossSeat] = level.bossId;
  return ids;
}

const CAMPAIGN_CHAPTERS = [
  // The screenplay's own chapter name ("De Fluwelen Entree") is Dutch —
  // inconsistent with ROADMAP.md's decided English/international
  // audience, so this uses its English equivalent instead. Real chapter
  // background art is at public/campaign/chapters/velvet_entrance.webp.
  { id: 1, title: 'Velvet Entrance', levelStart: 1, levelEnd: 10, slug: 'velvet_entrance', bossId: 'glass_baron' },
  // No real art supplied for this one yet — falls back to the CSS/SVG
  // placeholder (campaignBgImg's onerror path) exactly like every
  // character portrait did before Chapter 1's were dropped in. Drop a
  // file at public/campaign/chapters/rooftop.webp whenever it's ready,
  // no code change needed.
  { id: 2, title: 'The Rooftop', levelStart: 11, levelEnd: 20, slug: 'rooftop', bossId: 'the_sharp' },
  // No background art supplied yet — falls back to the CSS/SVG
  // placeholder until public/campaign/chapters/grand_library.webp exists.
  { id: 3, title: 'The Grand Library', levelStart: 21, levelEnd: 30, slug: 'grand_library', bossId: 'the_scholar' },
  { id: 4, title: 'The Carnival Lounge', levelStart: 31, levelEnd: 40, slug: 'carnival_lounge', bossId: 'the_wildcard' },
  // This room already exists in the game as an equippable scene, so the
  // client points this slug at /scenes/conservatory.webp rather than a
  // duplicated file — see CAMPAIGN_BG_SRC.
  { id: 5, title: 'The Conservatory', levelStart: 41, levelEnd: 50, slug: 'conservatory', bossId: 'the_optimist' },
  { id: 6, title: 'The Cabaret of Oddities', levelStart: 51, levelEnd: 60, slug: 'cabaret_of_oddities', bossId: 'the_jester' },
  { id: 7, title: 'The Grand Ballroom', levelStart: 61, levelEnd: 70, slug: 'grand_ballroom', bossId: 'the_charmer' },
  // No background art supplied yet — falls back to the CSS/SVG
  // placeholder until public/campaign/chapters/vault.webp exists.
  { id: 8, title: 'The Vault', levelStart: 71, levelEnd: 80, slug: 'vault', bossId: 'the_closer' },
  { id: 9, title: "The Countess's Antechamber", levelStart: 81, levelEnd: 90, slug: 'countess_antechamber', bossId: 'the_countess' },
  { id: 10, title: 'The Hidden Throne Room', levelStart: 91, levelEnd: 100, slug: 'hidden_throne_room', bossId: 'dame_de_pique' },
];

// Objective shapes (evaluated by evaluateCampaignObjective):
//   { type:'score', min, gold }
//   { type:'suitVoid', suit, voidByTrick, goldByTrick, goldScoreBar? }
//   { type:'avoidQueen', goldScoreBar }
//   { type:'cleanHand', goldScoreBar }
//   { type:'trickCount', minTricks, goldTricks, goldMoon?, goldScoreBar? }
// goldScoreBar is optional on suitVoid/trickCount (added for Levels 29/32
// — "void by trick N AND score X+", "win N tricks AND score X+") and
// AND-composes with the type's own base gold condition, exactly the same
// pattern avoidQueen/cleanHand already used for their own goldScoreBar.
// trickCount's goldMoon AND-composes the same way, independently of
// goldScoreBar — a level could in principle carry both.
// All four non-score mini-ladder types are now in use — Chapter 1 wove in
// Suit Void and Avoid the Queen, Chapter 2 (below) completes the set with
// Clean Hand and Trick Count — so every level in both chapters uses a
// mechanic the game actually teaches somewhere.
//
// L3 and L5 deliberately do NOT use the main level-data sheet's own score
// objective for those two slots — they're swapped for the "Suit Void" and
// "Avoid the Queen" mini-ladders' own Level 1 (see the campaign plan doc),
// matching those two levels' own screenplay beats ("count what is gone",
// "the queen stays out") exactly. L13 and L15 do the same swap in Chapter
// 2, using each mini-ladder's Level 2 rung (Chapter 1 already spent Level
// 1 of the other two) against "he saw it two tricks ago" (decisive trick-
// taking) and "I have been trying to fool you... changing how you play"
// (staying clean rather than getting baited into a penalty) respectively.
// The dialogue was written to react to play style in general rather than
// to a specific mechanic, so neither swap needed any screenplay changes.
const CAMPAIGN_LEVELS = {
  1: { id: 1, chapter: 1, type: 'Normal', forcePassDir: 'keep', hands: 1,
       seed: 'ddp-main-refine-L1-c690', hand: parseHand('2♠ K♣ A♥ 7♥ 2♥ 9♦ Q♣ J♠ A♠ 5♣ 7♠ Q♦ 3♦'),
       objective: { type: 'score', min: -27, gold: 20 } },
  2: { id: 2, chapter: 1, type: 'Normal', forcePassDir: 'keep', hands: 1,
       seed: 'ddp-main-refine-L2-c134', hand: parseHand('Q♦ Q♠ 8♣ A♥ J♥ 5♠ 7♥ 10♠ 2♣ 4♦ J♣ 6♠ A♣'),
       objective: { type: 'score', min: -26, gold: 19 } },
  3: { id: 3, chapter: 1, type: 'Harder', forcePassDir: 'keep', hands: 1,
       seed: 'ddp-goal-void-refine-L1-c25', hand: parseHand('9♥ Q♠ A♦ A♣ 6♥ 5♥ J♠ 6♠ 7♥ 7♦ 3♣ 8♦ 2♦'),
       objective: { type: 'suitVoid', suit: '♣', voidByTrick: 10, goldByTrick: 3 } },
  4: { id: 4, chapter: 1, type: 'Normal', forcePassDir: 'keep', hands: 1,
       seed: 'ddp-main-refine-L4-c742', hand: parseHand('4♥ 10♣ 5♦ 2♣ Q♠ A♠ K♦ K♥ J♥ A♣ 8♣ 7♠ 8♦'),
       objective: { type: 'score', min: -15, gold: 9 } },
  5: { id: 5, chapter: 1, type: 'Normal', forcePassDir: 'keep', hands: 1,
       seed: 'ddp-goal-queen-refine-L1-c277', hand: parseHand('10♥ 3♣ 6♦ A♥ J♥ A♣ 9♥ 6♥ 8♥ J♠ 2♥ 7♥ 5♦'),
       objective: { type: 'avoidQueen', goldScoreBar: 20 } },
  6: { id: 6, chapter: 1, type: 'Harder', forcePassDir: 'left', hands: 1,
       seed: 'ddp-main-refine-L6-c573', hand: parseHand('6♠ 2♦ 3♣ 2♥ J♣ 9♠ Q♦ K♠ 10♦ 10♠ 8♠ 4♠ 6♣'),
       objective: { type: 'score', min: -14, gold: 13 } },
  7: { id: 7, chapter: 1, type: 'Normal', forcePassDir: 'left', hands: 1,
       seed: 'ddp-main-refine-L7-c337', hand: parseHand('2♦ 10♣ 10♠ 6♠ J♦ 8♥ 9♦ 8♠ 4♣ 9♥ Q♦ K♦ 3♥'),
       objective: { type: 'score', min: -22, gold: 20 } },
  8: { id: 8, chapter: 1, type: 'Normal', forcePassDir: 'left', hands: 1,
       seed: 'ddp-main-refine-L8-c63', hand: parseHand('8♠ A♦ 4♦ 7♠ 10♠ K♣ K♦ 9♥ 2♠ 5♥ J♦ 3♦ 9♣'),
       objective: { type: 'score', min: -12, gold: 30 } },
  9: { id: 9, chapter: 1, type: 'Harder', forcePassDir: 'left', hands: 1,
       seed: 'ddp-main-refine-L9-c122', hand: parseHand('K♦ 4♥ A♥ A♦ 9♥ 3♦ 2♦ 5♦ A♠ 3♠ 7♥ Q♦ 5♠'),
       objective: { type: 'score', min: -1, gold: 60 } },
  // Boss levels are a 4-hand mini-match, pass cycling Left→Right→Across→
  // Keep naturally (forcePassDir stays null — round 1-4 already lands on
  // exactly that cycle via the ordinary passDir(round) formula, see
  // roundPassDir). `hands4[i]` is the fixed player hand for round i+1.
  10: { id: 10, chapter: 1, type: 'BOSS', forcePassDir: null, hands: 4, bossId: 'glass_baron',
        seed: 'ddp-boss-refine-L10-c8',
        hands4: [
          parseHand('Q♦ 6♣ J♣ 7♥ 8♦ 8♥ 10♠ K♦ 2♥ 8♠ 2♠ 2♣ 7♣'),
          parseHand('7♣ 3♥ Q♦ J♥ K♠ 3♦ K♥ 4♣ 6♠ 3♣ 5♠ A♥ Q♣'),
          parseHand('J♥ 9♣ 4♥ 2♠ K♠ 4♠ 5♦ A♠ Q♦ 10♣ 7♥ 3♣ 7♣'),
          parseHand('A♣ K♣ 10♥ 7♦ 2♦ K♦ 6♥ 6♣ 6♦ 5♥ 3♣ 7♣ A♠'),
        ],
        objective: { type: 'score', min: -11, gold: 49 } },

  // Chapter 2 — every level here is 'keep' (no passing at all this
  // chapter) — that's the source sheet's own data, not an oversight; the
  // Rooftop table apparently doesn't pass.
  11: { id: 11, chapter: 2, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L11-c177', hand: parseHand('Q♠ 6♣ 3♣ 2♦ 6♠ 4♦ Q♦ 8♠ Q♥ 2♥ 9♥ K♣ 8♦'),
        objective: { type: 'score', min: -11, gold: 16 } },
  12: { id: 12, chapter: 2, type: 'Harder', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L12-c211', hand: parseHand('K♣ 9♣ K♥ 8♠ 6♣ A♦ 3♦ 7♦ 2♦ 10♣ J♥ 7♥ Q♥'),
        objective: { type: 'score', min: -4, gold: 31 } },
  // Original main-sheet objective for L13 was score (min -17 / gold 6).
  // Swapped for the Trick Count mini-ladder's own Level 2 rung.
  // Gold here is deliberately a rare trophy rather than the usual
  // ~1-in-10: it asks for a SHOT MOON on top of the trick minimum.
  // goldMoon is only meaningful on a single-hand level — G.moonShooter
  // holds the last round's shooter, so on a multi-hand boss it would
  // read only the final hand. Nothing uses it that way today; keep it
  // that way, or make it a per-round accumulator first.
  13: { id: 13, chapter: 2, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-goal-tricks-refine-L2-c59', hand: parseHand('9♣ 9♠ 8♥ 10♥ Q♣ 8♦ A♥ A♣ Q♥ 2♦ J♠ 6♠ J♥'),
        objective: { type: 'trickCount', minTricks: 3, goldTricks: 3, goldMoon: true } },
  14: { id: 14, chapter: 2, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L14-c97', hand: parseHand('J♦ Q♦ 7♣ 5♦ 3♥ 2♥ 6♥ 6♠ 8♣ J♠ A♥ 2♠ 2♦'),
        objective: { type: 'score', min: -16, gold: 20 } },
  // Original main-sheet objective for L15 was score (min 3 / gold 28).
  // Swapped for the Clean Hand mini-ladder's own Level 2 rung.
  15: { id: 15, chapter: 2, type: 'Harder', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-goal-clean-refine-L2-c210', hand: parseHand('4♣ 3♣ K♣ J♠ 8♦ Q♦ 6♠ 9♠ 5♥ 3♠ 4♥ J♥ 8♣'),
        objective: { type: 'cleanHand', goldScoreBar: 20 } },
  16: { id: 16, chapter: 2, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L16-c262', hand: parseHand('A♥ 9♦ K♣ A♦ J♦ 2♣ 5♦ 2♥ 4♠ 8♠ 6♠ 6♦ Q♣'),
        objective: { type: 'score', min: -15, gold: 7 } },
  17: { id: 17, chapter: 2, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L17-c31', hand: parseHand('9♠ 3♦ J♥ K♥ Q♥ 2♥ J♦ 7♣ 3♥ 3♣ 2♦ 3♠ Q♣'),
        objective: { type: 'score', min: -14, gold: 10 } },
  18: { id: 18, chapter: 2, type: 'Harder', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L18-c70', hand: parseHand('10♥ 5♦ 8♣ 2♠ J♥ 9♦ Q♣ 9♣ 4♠ 7♥ 5♥ 2♣ A♣'),
        objective: { type: 'score', min: 1, gold: 20 } },
  19: { id: 19, chapter: 2, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L19-c9', hand: parseHand('2♥ A♥ 5♠ 9♥ J♥ 6♠ Q♠ J♣ 10♥ A♣ 6♣ 7♦ Q♦'),
        objective: { type: 'score', min: -12, gold: 20 } },
  20: { id: 20, chapter: 2, type: 'BOSS', forcePassDir: null, hands: 4, bossId: 'the_sharp',
        seed: 'ddp-boss-refine-L20-c292',
        hands4: [
          parseHand('9♦ 2♣ A♦ 9♥ 2♥ K♥ 8♣ J♣ 2♦ 3♣ 8♥ 4♠ J♠'),
          parseHand('2♠ 9♣ 8♠ Q♠ Q♦ 10♦ Q♣ 4♥ 5♥ A♣ 4♦ Q♥ 10♣'),
          parseHand('Q♠ J♣ Q♣ 8♦ 4♠ 2♥ Q♦ 6♦ 9♦ 7♣ 10♠ 5♠ 5♥'),
          parseHand('J♣ 5♦ 10♠ 7♥ 3♣ Q♠ 2♠ 6♦ K♣ K♠ J♥ A♣ 6♣'),
        ],
        objective: { type: 'score', min: 14, gold: 44 } },

  // Chapter 3 — also all 'keep' per the source sheet.
  21: { id: 21, chapter: 3, type: 'Harder', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L21-c168', hand: parseHand('5♥ 2♦ 7♦ 9♥ K♠ J♣ 2♣ 3♣ 5♣ K♥ 7♥ 4♦ 5♠'),
        objective: { type: 'score', min: 3, gold: 13 } },
  22: { id: 22, chapter: 3, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L22-c159', hand: parseHand('5♦ 2♠ J♣ K♦ 7♥ 9♣ A♥ 4♠ 2♥ Q♥ K♥ 3♣ 9♥'),
        objective: { type: 'score', min: 20, gold: 60 } },
  // Original main-sheet objective for L23 was score (min -9 / gold 29).
  // Swapped for the Avoid-the-Queen ladder's rung 2 — Chapter 1 spent
  // rung 1 — against this level's own "Where the Queen Lands" beat.
  23: { id: 23, chapter: 3, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-goal-queen-refine-L2-c495', hand: parseHand('A♦ J♠ 6♣ 7♣ K♣ 6♦ 2♠ 5♦ 10♥ A♣ Q♦ K♥ Q♥'),
        objective: { type: 'avoidQueen', goldScoreBar: 23 } },
  24: { id: 24, chapter: 3, type: 'Harder', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L24-c13', hand: parseHand('7♠ 2♠ 7♦ 7♥ 10♣ Q♠ 5♦ K♣ 2♣ 4♠ 2♦ J♦ 3♥'),
        objective: { type: 'score', min: 0, gold: 23 } },
  25: { id: 25, chapter: 3, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L25-c0', hand: parseHand('A♣ K♣ 9♦ A♦ 2♣ 8♦ 6♥ 5♦ 9♣ J♦ Q♣ 3♣ J♥'),
        objective: { type: 'score', min: 20, gold: 60 } },
  26: { id: 26, chapter: 3, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L26-c294', hand: parseHand('9♠ 4♥ 6♠ 3♣ A♠ 2♣ 7♣ J♣ A♥ 5♥ K♠ J♥ 8♠'),
        objective: { type: 'score', min: 7, gold: 25 } },
  27: { id: 27, chapter: 3, type: 'Harder', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L27-c121', hand: parseHand('2♣ 3♣ 5♣ Q♦ 8♥ 7♦ 5♥ 7♠ 10♣ K♦ 2♦ J♣ K♥'),
        objective: { type: 'score', min: 8, gold: 19 } },
  28: { id: 28, chapter: 3, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L28-c443', hand: parseHand('9♠ 8♦ J♥ 2♠ 5♦ A♣ K♦ 3♥ 2♣ 3♠ 10♥ 4♥ 4♠'),
        objective: { type: 'score', min: -5, gold: 12 } },
  // Original main-sheet objective for L29 was score (min -10 / gold 27).
  // Swapped for the Suit Void ladder's rung 2 — this level's own beat is
  // "tracking a late void and unloading the dangerous card at the only
  // safe moment", which is precisely what that objective measures.
  29: { id: 29, chapter: 3, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-goal-void-refine-L2-c60', hand: parseHand('9♦ 6♣ 7♠ 10♣ J♣ 2♣ Q♦ 6♥ K♣ 2♥ 7♦ 4♣ 10♠'),
        objective: { type: 'suitVoid', suit: '♦', voidByTrick: 5, goldByTrick: 5, goldScoreBar: 10 } },
  30: { id: 30, chapter: 3, type: 'BOSS', forcePassDir: null, hands: 4, bossId: 'the_scholar',
        seed: 'ddp-boss-refine-L30-c570',
        hands4: [
          parseHand('8♠ 7♦ 6♣ A♦ A♣ 7♠ 5♠ K♣ Q♥ 4♠ Q♠ J♣ 3♥'),
          parseHand('J♣ 4♦ 6♦ 3♠ 7♦ 5♦ 6♥ 6♠ 5♥ 7♣ 3♣ 9♥ 9♣'),
          parseHand('10♦ 4♦ 8♠ 10♥ 9♥ K♥ K♦ 7♥ 2♥ 6♦ Q♣ 5♦ 3♥'),
          parseHand('5♣ 5♦ J♠ 10♠ Q♥ K♥ 4♦ 7♣ 6♣ 9♥ K♠ 8♦ K♦'),
        ],
        objective: { type: 'score', min: 30, gold: 90 } },

  // Chapter 4 — the first chapter that MIXES pass directions (31-32 keep,
  // 33-39 left, 40 cycles). Worth noting for the two objective swaps
  // below: a mini-ladder hand was calibrated under its own direction, so
  // dropping one onto a level with a different direction would invalidate
  // that calibration (the pass changes the hand). Both swaps here keep
  // their ladder's direction — see L35's note.
  31: { id: 31, chapter: 4, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L31-c314', hand: parseHand('10♠ 5♠ K♠ 2♦ Q♦ A♥ A♦ 5♣ 2♠ Q♠ A♠ 7♦ 4♥'),
        objective: { type: 'score', min: -2, gold: 21 } },
  // Original main-sheet objective was score (min -1 / gold 14). Swapped
  // for the Trick Count ladder's rung 3 — already 'keep', so no
  // direction change and the calibration carries over intact.
  32: { id: 32, chapter: 4, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-goal-tricks-refine-L3-c73', hand: parseHand('5♦ J♣ 10♦ A♣ 4♠ A♥ Q♣ 5♣ Q♦ A♠ J♦ 6♣ 7♥'),
        objective: { type: 'trickCount', minTricks: 5, goldTricks: 5, goldScoreBar: 20 } },
  33: { id: 33, chapter: 4, type: 'Harder', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L33-c51', hand: parseHand('Q♠ 10♦ 10♠ 5♦ 9♠ 5♠ 3♠ J♣ Q♣ 4♥ Q♦ A♦ K♥'),
        objective: { type: 'score', min: 6, gold: 19 } },
  34: { id: 34, chapter: 4, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L34-c66', hand: parseHand('10♠ K♥ 8♦ J♣ 5♠ 9♥ 2♣ A♦ 2♠ K♠ 3♣ 6♥ 7♦'),
        objective: { type: 'score', min: 1, gold: 24 } },
  // Original main-sheet objective was score (min 1 / gold 41) at
  // direction 'left'. Swapped for the Clean Hand ladder's rung 3 against
  // this level's own beat ("How are you still clean?"), and the
  // direction is pinned to that ladder's 'keep' rather than the
  // chapter's 'left' — the hand's measured clear rate assumes no pass,
  // and passing 2 cards away would make it a different hand entirely.
  // The one direction anomaly in the chapter, and a deliberate one.
  35: { id: 35, chapter: 4, type: 'Normal', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-goal-clean-refine-L3-c9', hand: parseHand('7♦ 3♣ 6♠ 2♣ Q♣ 7♠ 8♣ 4♥ 10♣ J♦ Q♦ 4♠ 5♠'),
        objective: { type: 'cleanHand', goldScoreBar: 20 } },
  36: { id: 36, chapter: 4, type: 'Harder', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L36-c273', hand: parseHand('J♠ 8♠ 7♦ 3♠ 5♦ 2♣ 4♥ 5♣ 4♣ Q♣ K♦ Q♦ 9♠'),
        objective: { type: 'score', min: 8, gold: 21 } },
  37: { id: 37, chapter: 4, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L37-c383', hand: parseHand('2♠ 6♠ 2♦ 9♥ 7♥ K♥ 8♠ Q♦ 3♥ A♦ 5♣ K♦ J♣'),
        objective: { type: 'score', min: -3, gold: 12 } },
  38: { id: 38, chapter: 4, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L38-c48', hand: parseHand('5♣ 5♥ J♣ 2♥ 2♣ 6♠ 10♦ K♣ 2♦ 6♦ 8♣ 7♠ 5♦'),
        objective: { type: 'score', min: 10, gold: 20 } },
  39: { id: 39, chapter: 4, type: 'Harder', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L39-c27', hand: parseHand('6♦ Q♣ Q♠ K♠ 3♠ 10♦ 2♦ 7♠ 7♦ 7♥ 8♣ 6♥ 9♠'),
        objective: { type: 'score', min: 10, gold: 18 } },
  40: { id: 40, chapter: 4, type: 'BOSS', forcePassDir: null, hands: 4, bossId: 'the_wildcard',
        seed: 'ddp-boss-refine-L40-c86',
        hands4: [
          parseHand('Q♠ 9♠ 2♦ 2♣ Q♣ 2♠ 2♥ 10♠ J♥ 4♥ K♠ 4♦ 9♣'),
          parseHand('10♠ J♠ 10♥ 9♠ Q♣ 2♥ 3♥ 8♣ 5♦ 4♣ A♦ 8♥ 6♥'),
          parseHand('J♣ 6♠ 5♦ Q♠ A♥ 7♣ 9♥ 10♣ 4♦ 3♣ 10♥ 6♦ 6♣'),
          parseHand('2♥ 3♦ 9♥ 5♥ J♣ J♦ 10♠ 10♦ 9♣ 3♥ 8♣ Q♠ 8♠'),
        ],
        objective: { type: 'score', min: 28, gold: 80 } },

  // Chapter 5 — all 'left', and both mini-ladder rungs used here are
  // 'left' too, so unlike Chapter 4 there is no direction anomaly.
  41: { id: 41, chapter: 5, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L41-c99', hand: parseHand('3♦ 5♦ 3♥ A♥ 3♣ 4♠ J♥ Q♠ 5♠ K♥ 8♥ A♠ 4♦'),
        objective: { type: 'score', min: 20, gold: 60 } },
  42: { id: 42, chapter: 5, type: 'Harder', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L42-c514', hand: parseHand('K♣ 7♥ 6♦ Q♠ A♥ 9♣ K♦ A♣ J♦ Q♦ K♥ 10♠ 3♠'),
        objective: { type: 'score', min: 21, gold: 60 } },
  43: { id: 43, chapter: 5, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L43-c817', hand: parseHand('A♠ 10♦ 8♦ 6♣ 8♠ 10♠ Q♦ J♥ 3♦ 4♣ 2♣ J♣ K♠'),
        objective: { type: 'score', min: -7, gold: 0 } },
  // Original main-sheet objective was score (min 8 / gold 21). Swapped
  // for the Suit Void ladder's rung 4 against this level's own lesson —
  // "watch who is void before you lead the suit".
  44: { id: 44, chapter: 5, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-goal-void-refine-L4-c29', hand: parseHand('10♥ 7♠ 3♥ K♦ J♠ 10♠ 6♣ 5♠ 9♠ 7♣ 6♦ 2♠ 9♦'),
        objective: { type: 'suitVoid', suit: '♦', voidByTrick: 10, goldByTrick: 7 } },
  45: { id: 45, chapter: 5, type: 'Harder', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L45-c109', hand: parseHand('Q♦ 8♥ K♥ 7♣ A♦ 3♦ A♥ 5♦ 3♠ 8♣ 10♥ Q♠ 2♠'),
        objective: { type: 'score', min: 6, gold: 18 } },
  46: { id: 46, chapter: 5, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L46-c50', hand: parseHand('9♠ 7♠ 4♥ 10♠ 3♥ 8♥ 5♥ 6♠ 8♦ Q♠ J♠ Q♣ Q♦'),
        objective: { type: 'score', min: 10, gold: 22 } },
  // Original main-sheet objective was score (min 18 / gold 32). Swapped
  // for the Avoid-the-Queen ladder's rung 4 — this level's own action
  // line is literally "reads a late sequence perfectly, avoids the
  // Queen and finishes with a strong clear".
  47: { id: 47, chapter: 5, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-goal-queen-refine-L4-c584', hand: parseHand('10♥ 10♦ J♦ Q♦ 7♠ 2♠ 3♠ Q♣ A♥ K♦ 5♦ 2♣ 8♦'),
        objective: { type: 'avoidQueen', goldScoreBar: 5 } },
  48: { id: 48, chapter: 5, type: 'Harder', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L48-c491', hand: parseHand('A♦ J♣ 5♥ Q♠ 2♥ 2♣ 3♠ 5♠ 5♦ J♦ 6♠ K♣ 10♣'),
        objective: { type: 'score', min: 26, gold: 41 } },
  49: { id: 49, chapter: 5, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L49-c181', hand: parseHand('K♣ 10♦ 10♠ 9♥ K♠ 9♦ 3♣ 6♥ 5♥ 8♦ 2♥ 2♠ 7♠'),
        objective: { type: 'score', min: 6, gold: 19 } },
  50: { id: 50, chapter: 5, type: 'BOSS', forcePassDir: null, hands: 4, bossId: 'the_optimist',
        seed: 'ddp-boss-refine-L50-c72',
        hands4: [
          parseHand('4♠ A♦ J♣ Q♠ 5♥ 8♦ 7♦ 8♥ 3♠ 7♥ 10♣ 8♠ K♣'),
          parseHand('Q♥ 8♦ 10♦ 7♣ 2♦ 2♣ K♠ 3♣ 5♥ 9♣ K♣ Q♠ 3♦'),
          parseHand('9♣ J♠ 8♥ 6♦ Q♣ 5♥ K♥ 6♥ 9♥ 2♦ K♠ 4♣ J♥'),
          parseHand('10♦ 4♣ 7♠ K♥ 5♠ 8♥ 3♦ 4♠ J♠ K♠ A♠ 8♠ Q♣'),
        ],
        objective: { type: 'score', min: 6, gold: 41 } },

  // Chapter 6 — plain score objectives throughout, straight off the main
  // level-data sheet's own Min/Gold Target columns for every level
  // (51-59) — unlike chapters 1-5, none of these are swapped for the
  // suitVoid/avoidQueen/trickCount/cleanHand mini-ladders. Introducing a
  // new ladder rung wasn't asked for here and needs its own calibration
  // pass to pick correctly, so this chapter is deliberately left as pure
  // score levels rather than guessing at one.
  51: { id: 51, chapter: 6, type: 'Harder', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L51-c350', hand: parseHand('J♠ A♠ 8♦ Q♥ 8♠ Q♦ 2♦ 4♦ 6♦ 2♥ 2♠ 10♥ Q♣'),
        objective: { type: 'score', min: 18, gold: 45 } },
  52: { id: 52, chapter: 6, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L52-c735', hand: parseHand('7♦ 9♥ 2♣ 2♦ 10♠ 3♣ A♠ 8♥ 8♦ 5♦ 4♣ Q♦ A♣'),
        objective: { type: 'score', min: 15, gold: 29 } },
  53: { id: 53, chapter: 6, type: 'Normal', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L53-c284', hand: parseHand('4♥ 4♠ 6♣ 3♣ 7♥ J♣ 6♠ 5♥ 6♥ 7♦ 10♦ 3♥ A♠'),
        objective: { type: 'score', min: 8, gold: 22 } },
  54: { id: 54, chapter: 6, type: 'Harder', forcePassDir: 'left', hands: 1,
        seed: 'ddp-main-refine-L54-c821', hand: parseHand('J♠ 3♣ 7♦ Q♣ J♥ 2♠ K♦ 8♦ 4♠ 3♠ A♣ 5♦ J♦'),
        objective: { type: 'score', min: 11, gold: 21 } },
  55: { id: 55, chapter: 6, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L55-c475', hand: parseHand('3♣ 7♠ 2♠ J♥ Q♦ 5♥ 5♠ 6♣ K♦ 10♦ 7♣ A♦ Q♣'),
        objective: { type: 'score', min: 18, gold: 36 } },
  56: { id: 56, chapter: 6, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L56-c339', hand: parseHand('2♥ 5♣ 9♦ 10♠ K♣ 8♠ 7♠ 4♥ Q♦ 5♥ 5♠ A♣ J♣'),
        objective: { type: 'score', min: 17, gold: 54 } },
  57: { id: 57, chapter: 6, type: 'Harder', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L57-c25', hand: parseHand('Q♠ 2♣ 6♥ 2♥ K♣ 9♠ J♦ Q♥ K♠ 10♣ 10♦ J♣ A♦'),
        objective: { type: 'score', min: 13, gold: 27 } },
  58: { id: 58, chapter: 6, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L58-c187', hand: parseHand('A♠ A♥ J♣ 10♠ 2♦ 7♣ J♥ 2♣ 3♦ 4♥ 4♠ 6♥ 10♣'),
        objective: { type: 'score', min: -2, gold: 12 } },
  59: { id: 59, chapter: 6, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L59-c522', hand: parseHand('K♣ 8♦ 2♣ J♠ 6♠ 7♣ 8♠ 6♦ 2♦ A♣ 10♥ J♣ 7♥'),
        objective: { type: 'score', min: 12, gold: 42 } },
  60: { id: 60, chapter: 6, type: 'BOSS', forcePassDir: null, hands: 4, bossId: 'the_jester',
        seed: 'ddp-boss-refine-L60-c208',
        hands4: [
          parseHand('3♣ 2♦ 6♥ 7♥ 2♠ 6♦ 6♠ 4♠ 4♥ 5♣ 10♠ 9♥ 9♦'),
          parseHand('Q♣ 3♠ 10♥ 7♦ 5♥ 2♦ 4♣ 4♥ 3♣ 6♠ K♥ 6♦ 9♠'),
          parseHand('3♥ 2♣ A♦ 4♥ 8♦ J♦ 9♣ 3♣ J♣ 4♣ 10♣ 3♠ Q♠'),
          parseHand('6♠ 4♦ 2♠ J♣ 5♣ 6♣ 5♠ K♦ 7♦ Q♠ K♣ 9♠ 9♥'),
        ],
        objective: { type: 'score', min: 1, gold: 17 } },

  // Chapter 7 — plain score objectives throughout, same call as Chapter
  // 6: straight off the main sheet, no mini-ladder swaps.
  61: { id: 61, chapter: 7, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L61-c287', hand: parseHand('3♥ Q♣ J♣ 3♦ J♥ 4♦ K♣ A♥ 9♠ K♠ 4♥ 9♦ 7♥'),
        objective: { type: 'score', min: 5, gold: 19 } },
  62: { id: 62, chapter: 7, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L62-c47', hand: parseHand('K♦ 10♣ J♠ 6♦ 4♣ A♦ 5♠ A♣ Q♠ 8♠ 3♣ 10♥ 2♠'),
        objective: { type: 'score', min: 14, gold: 31 } },
  63: { id: 63, chapter: 7, type: 'Harder', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L63-c155', hand: parseHand('3♦ 5♣ A♣ 6♣ 7♥ A♦ 9♦ 8♥ 8♣ J♣ Q♦ 7♠ K♠'),
        objective: { type: 'score', min: 10, gold: 20 } },
  64: { id: 64, chapter: 7, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L64-c315', hand: parseHand('6♦ J♦ K♦ 5♦ 2♣ 7♠ 3♣ 10♥ 3♠ 6♥ A♣ 4♥ 5♥'),
        objective: { type: 'score', min: 8, gold: 22 } },
  65: { id: 65, chapter: 7, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L65-c329', hand: parseHand('4♣ J♠ 3♦ 5♠ Q♥ J♣ 10♥ 7♥ 7♣ 5♥ 2♥ 6♥ A♣'),
        objective: { type: 'score', min: 16, gold: 38 } },
  66: { id: 66, chapter: 7, type: 'Harder', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L66-c1093', hand: parseHand('6♥ 4♠ 10♥ 6♠ 9♥ Q♠ 4♦ 2♥ 6♣ J♦ A♦ 9♠ Q♣'),
        objective: { type: 'score', min: 19, gold: 22 } },
  67: { id: 67, chapter: 7, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L67-c824', hand: parseHand('9♦ 10♠ 7♥ J♠ 9♣ 6♥ 3♣ 9♥ 6♦ 8♣ 5♥ K♦ Q♦'),
        objective: { type: 'score', min: 18, gold: 44 } },
  68: { id: 68, chapter: 7, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L68-c805', hand: parseHand('K♦ A♥ 9♣ 8♥ 10♣ J♥ 10♥ 8♦ J♦ 9♥ 2♠ Q♦ A♦'),
        objective: { type: 'score', min: 18, gold: 77 } },
  69: { id: 69, chapter: 7, type: 'Harder', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L69-c98', hand: parseHand('9♦ 3♥ 5♠ Q♠ A♦ 2♣ K♥ Q♣ 4♣ J♠ 10♥ 3♣ 4♦'),
        objective: { type: 'score', min: 20, gold: 40 } },
  70: { id: 70, chapter: 7, type: 'BOSS', forcePassDir: null, hands: 4, bossId: 'the_charmer',
        seed: 'ddp-boss-refine-L70-c654',
        hands4: [
          parseHand('7♠ 6♦ 4♠ 2♠ 8♦ Q♣ J♣ 3♠ 5♣ 7♦ 10♠ 10♦ 5♠'),
          parseHand('K♥ 9♠ 7♣ 10♠ 6♥ 5♦ J♥ 6♦ Q♥ 8♠ 4♥ 9♦ Q♣'),
          parseHand('3♦ J♥ J♠ 7♠ 5♦ K♥ 10♣ K♠ 7♥ 3♠ Q♥ 8♠ A♣'),
          parseHand('3♠ Q♥ K♠ J♥ 7♠ J♠ 3♦ 9♥ Q♦ 4♦ 4♣ 6♣ 3♥'),
        ],
        objective: { type: 'score', min: 14, gold: 37 } },

  // Chapter 8 — plain score objectives throughout, same call as Chapters
  // 6-7: straight off the main sheet, no mini-ladder swaps.
  71: { id: 71, chapter: 8, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L71-c31', hand: parseHand('7♠ K♦ 4♦ 4♥ 3♠ 7♣ 9♥ J♦ A♣ 6♣ 4♣ 2♣ 4♠'),
        objective: { type: 'score', min: 20, gold: 31 } },
  72: { id: 72, chapter: 8, type: 'Harder', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L72-c742', hand: parseHand('5♠ 10♠ 6♠ 10♣ K♣ J♠ K♦ 7♣ Q♦ 9♥ Q♥ A♣ 7♥'),
        objective: { type: 'score', min: 33, gold: 57 } },
  73: { id: 73, chapter: 8, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L73-c371', hand: parseHand('5♦ 3♥ J♦ 10♠ 2♠ 5♠ J♥ 3♣ 4♠ Q♣ Q♦ Q♠ K♠'),
        objective: { type: 'score', min: 13, gold: 32 } },
  74: { id: 74, chapter: 8, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L74-c232', hand: parseHand('5♠ 5♣ A♣ K♣ 4♣ 8♠ 7♦ K♠ 7♣ 4♥ 10♥ A♥ 4♦'),
        objective: { type: 'score', min: 29, gold: 50 } },
  75: { id: 75, chapter: 8, type: 'Harder', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L75-c646', hand: parseHand('J♣ 8♠ Q♥ Q♣ 10♠ 4♣ 2♠ 8♦ K♠ J♥ A♣ 3♣ 5♣'),
        objective: { type: 'score', min: 48, gold: 68 } },
  76: { id: 76, chapter: 8, type: 'Normal', forcePassDir: 'right', hands: 1,
        seed: 'ddp-main-refine-L76-c225', hand: parseHand('8♦ A♣ Q♠ K♦ 4♠ 8♥ K♥ 5♣ J♥ 2♣ 9♠ 3♣ 9♣'),
        objective: { type: 'score', min: 15, gold: 36 } },
  77: { id: 77, chapter: 8, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L77-c302', hand: parseHand('A♣ 9♠ A♦ 10♥ 3♦ 6♣ 7♠ 6♦ Q♣ 3♠ K♥ 5♥ 5♣'),
        objective: { type: 'score', min: 16, gold: 37 } },
  78: { id: 78, chapter: 8, type: 'Harder', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L78-c814', hand: parseHand('9♠ J♠ 10♣ 10♥ 6♦ 5♠ A♠ K♣ 9♥ 3♥ 5♥ 8♥ J♣'),
        objective: { type: 'score', min: 25, gold: 33 } },
  79: { id: 79, chapter: 8, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L79-c758', hand: parseHand('8♣ Q♣ K♦ 4♠ 10♥ 10♠ J♠ 2♥ J♣ 3♥ 2♦ 8♠ K♠'),
        objective: { type: 'score', min: 16, gold: 37 } },
  80: { id: 80, chapter: 8, type: 'BOSS', forcePassDir: null, hands: 4, bossId: 'the_closer',
        seed: 'ddp-boss-refine-L80-c278',
        hands4: [
          parseHand('6♠ A♠ 7♥ 9♠ 9♣ 6♣ 5♦ K♥ J♥ J♠ 8♦ J♦ K♣'),
          parseHand('6♥ A♦ 10♥ 3♥ 10♠ 6♣ 7♠ 9♥ 8♣ 7♦ 4♥ 5♠ 3♠'),
          parseHand('3♦ Q♠ 5♣ 10♥ 10♦ 3♥ K♠ 2♥ J♠ 8♣ 2♦ 9♣ 7♠'),
          parseHand('J♦ J♥ 8♦ J♠ K♦ A♣ K♥ Q♦ 8♥ 7♠ 6♥ 10♣ 9♣'),
        ],
        objective: { type: 'score', min: 21, gold: 63 } },

  // Chapter 9 — plain score objectives throughout, same call as
  // Chapters 6-8.
  81: { id: 81, chapter: 9, type: 'Harder', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L81-c575', hand: parseHand('J♥ A♦ 2♦ 5♥ 4♥ 8♥ 10♦ 8♣ 7♣ 7♦ J♠ K♣ K♦'),
        objective: { type: 'score', min: 38, gold: 57 } },
  82: { id: 82, chapter: 9, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L82-c311', hand: parseHand('3♦ 6♠ Q♥ 7♥ 9♥ K♣ 2♥ 8♥ J♦ J♠ A♣ 3♠ 10♦'),
        objective: { type: 'score', min: 16, gold: 42 } },
  83: { id: 83, chapter: 9, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L83-c388', hand: parseHand('7♥ 2♥ J♠ 2♠ 3♦ 10♠ Q♣ A♠ J♥ A♣ Q♠ J♦ 10♣'),
        objective: { type: 'score', min: 17, gold: 35 } },
  84: { id: 84, chapter: 9, type: 'Harder', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L84-c91', hand: parseHand('4♣ A♣ 5♣ 6♥ J♥ J♦ 2♦ 2♣ J♠ K♣ 8♠ 9♣ A♦'),
        objective: { type: 'score', min: 41, gold: 72 } },
  85: { id: 85, chapter: 9, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L85-c3', hand: parseHand('5♣ J♠ 4♦ 10♠ 6♥ 6♦ Q♣ 3♦ 7♣ 7♦ K♥ 2♦ Q♠'),
        objective: { type: 'score', min: 20, gold: 28 } },
  86: { id: 86, chapter: 9, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L86-c65', hand: parseHand('8♥ 9♣ K♦ A♥ 5♣ A♣ K♥ 8♦ K♠ 3♥ 2♦ 5♥ 6♠'),
        objective: { type: 'score', min: 20, gold: 26 } },
  87: { id: 87, chapter: 9, type: 'Harder', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L87-c639', hand: parseHand('J♦ 10♥ 5♦ Q♥ 4♦ A♦ 4♠ Q♠ 7♦ 5♣ 9♦ 10♠ K♦'),
        objective: { type: 'score', min: 58, gold: 64 } },
  88: { id: 88, chapter: 9, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L88-c66', hand: parseHand('A♦ 6♠ K♦ 9♣ Q♥ 3♣ K♣ 5♣ 10♠ A♥ A♣ 5♠ 9♦'),
        objective: { type: 'score', min: 21, gold: 44 } },
  89: { id: 89, chapter: 9, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L89-c359', hand: parseHand('Q♥ Q♦ 10♦ 3♣ A♣ 2♠ J♠ A♥ 4♣ 5♠ 5♦ 8♥ K♦'),
        objective: { type: 'score', min: 22, gold: 39 } },
  90: { id: 90, chapter: 9, type: 'BOSS', forcePassDir: null, hands: 4, bossId: 'the_countess',
        seed: 'ddp-boss-refine-L90-c957',
        hands4: [
          parseHand('10♠ 8♦ K♣ 4♠ J♠ 2♦ 9♥ K♠ 8♠ 6♦ 8♥ 5♦ A♦'),
          parseHand('8♦ 4♣ 5♣ 10♦ 7♣ K♠ 6♣ K♣ 4♦ 9♥ 9♣ A♠ 5♥'),
          parseHand('3♦ 2♣ 4♥ 10♦ 2♠ Q♦ 3♥ 4♦ 6♠ A♦ 8♣ 8♦ Q♠'),
          parseHand('Q♦ A♦ 3♠ 7♦ J♣ 10♣ 4♠ 6♣ 2♥ A♣ K♣ 6♠ 5♦'),
        ],
        objective: { type: 'score', min: 26, gold: 42 } },

  // Chapter 10 — plain score objectives throughout, same call as
  // Chapters 6-9. Level 99's gold(35) sitting BELOW its own min(21) is
  // verbatim off the sheet, not a transcription error — Measured
  // P(gold) equals Measured P(clear) at 8%, i.e. clearing the (higher)
  // min automatically satisfies the (lower) gold bar for this one level.
  91: { id: 91, chapter: 10, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L91-c965', hand: parseHand('6♣ 2♦ 5♠ 4♣ 5♥ Q♣ 9♥ 10♣ 8♦ A♦ A♠ K♥ J♠'),
        objective: { type: 'score', min: 23, gold: 41 } },
  92: { id: 92, chapter: 10, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L92-c66', hand: parseHand('K♦ 3♠ Q♥ A♣ A♠ 7♥ 8♣ 4♠ 6♦ 4♥ 4♣ A♦ J♣'),
        objective: { type: 'score', min: 23, gold: 36 } },
  93: { id: 93, chapter: 10, type: 'Harder', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L93-c332', hand: parseHand('J♦ 3♠ 4♦ 4♥ 2♣ 9♦ Q♥ A♦ 2♠ 9♥ 8♠ 6♥ Q♣'),
        objective: { type: 'score', min: 23, gold: 30 } },
  94: { id: 94, chapter: 10, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L94-c354', hand: parseHand('10♥ A♣ 7♥ J♠ A♥ 9♥ A♦ 5♦ 9♦ 7♠ K♣ 5♣ 2♦'),
        objective: { type: 'score', min: 25, gold: 34 } },
  95: { id: 95, chapter: 10, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L95-c795', hand: parseHand('Q♣ A♦ K♥ K♠ 8♥ 8♠ 2♦ 9♠ 7♣ 6♦ A♥ 3♦ A♣'),
        objective: { type: 'score', min: 37, gold: 52 } },
  96: { id: 96, chapter: 10, type: 'Harder', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L96-c83', hand: parseHand('10♠ A♠ Q♣ K♠ J♠ 10♥ 2♣ J♥ K♣ 5♣ 4♣ A♥ J♣'),
        objective: { type: 'score', min: 49, gold: 51 } },
  97: { id: 97, chapter: 10, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L97-c42', hand: parseHand('A♦ 4♥ 3♣ 10♠ K♥ A♣ 2♣ 8♣ K♠ J♥ A♠ Q♥ 7♦'),
        objective: { type: 'score', min: 26, gold: 56 } },
  98: { id: 98, chapter: 10, type: 'Normal', forcePassDir: 'across', hands: 1,
        seed: 'ddp-main-refine-L98-c1016', hand: parseHand('9♠ J♣ 9♥ 6♠ 5♣ Q♠ A♣ 5♦ K♣ 10♠ 4♣ K♠ 10♥'),
        objective: { type: 'score', min: 53, gold: 95 } },
  99: { id: 99, chapter: 10, type: 'Harder', forcePassDir: 'keep', hands: 1,
        seed: 'ddp-main-refine-L99-c300', hand: parseHand('K♣ Q♥ J♦ 5♠ K♥ J♥ 3♦ A♣ 8♥ 10♠ A♥ 9♥ Q♣'),
        objective: { type: 'score', min: 51, gold: 35 } },
  100: { id: 100, chapter: 10, type: 'BOSS', forcePassDir: null, hands: 4, bossId: 'dame_de_pique',
        seed: 'ddp-boss-refine-L100-c93',
        hands4: [
          parseHand('J♠ K♦ J♣ A♦ 4♣ 3♥ 3♦ 9♠ 10♥ J♦ 8♦ 5♥ 4♥'),
          parseHand('8♠ 2♣ A♠ J♥ 4♠ Q♠ 6♣ A♥ 5♥ 3♠ 7♦ 3♥ 5♠'),
          parseHand('6♦ 3♥ 6♠ 9♥ A♥ 7♠ 4♠ 2♠ 8♦ J♠ Q♥ 10♣ A♦'),
          parseHand('2♣ 7♠ 5♠ 10♥ 3♣ 3♦ Q♦ 9♠ 4♦ Q♣ 6♣ A♥ 7♥'),
        ],
        objective: { type: 'score', min: 21, gold: 55 } },
};
const CAMPAIGN_LEVEL_LIST = Object.values(CAMPAIGN_LEVELS).sort((a, b) => a.id - b.id);
function campaignLevelById(id) { return CAMPAIGN_LEVELS[id] || null; }

// Story cues, fed in verbatim from the screenplay per the brief's own
// instruction not to paraphrase or hard-code score numbers into the
// lines. `order` sequences multiple lines sharing one (levelId, trigger)
// bucket so the client's dialogue overlay steps through them as one
// conversation; it only needs to be consistent WITHIN that bucket, since
// it's only ever used to sort a filtered subset (campaignCuesFor).
// `pick: 'random'` marks a bucket where the screenplay itself says
// "randomize between these lines" (only Level 10's failure lines, in
// this chapter) — the client picks ONE from that bucket instead of
// sequencing through all of them. Triggers used here: chapterEnter,
// preLevel, postClear, postFail, bossIntro, bossMidpoint, bossDefeat,
// chapterExit — postGold is deliberately unused in Chapter 1 (no
// gold-specific line exists in the screenplay; the client's own gold
// flourish covers it, see the brief's "additional restrained gold
// flourish" note) and bossTease is left for a later chapter's more
// clearly separable boss-glimpse beats rather than fragmenting Chapter
// 1's own regular-table banter across two trigger buckets.
// `speakerId: null` marks a STORY BOX — narration rather than spoken
// dialogue (see campaignDialogueStep client-side, which renders these
// without a portrait or name). They live inline in the SAME bucket as
// the dialogue lines they're inserted between, not a separate list, so
// `order` alone decides where a narration beat falls relative to the
// speech around it.
// `id` is keyed by (levelId, trigger, a counter LOCAL to that one
// bucket) rather than a running counter over the whole file — the id
// used to embed a global sequence number, which meant inserting a cue
// anywhere but the very end of the file shifted every later cue's id
// and silently replayed already-seen dialogue for real accounts. A
// per-bucket counter means inserting a new STORY BOX into, say, Level
// 1's postClear only ever renumbers Level 1's OWN postClear cues after
// the insertion point — every other level and trigger is untouched, so
// this is now safe to do for any level, not just the last one written.
const _campaignCueSeqByBucket = {};
function ccue(levelId, trigger, speakerId, text, extra) {
  const bucketKey = levelId + ':' + trigger;
  const n = (_campaignCueSeqByBucket[bucketKey] = (_campaignCueSeqByBucket[bucketKey] || 0) + 1);
  return { id: `ch1-l${levelId}-${trigger}-${n}`, levelId, trigger, speakerId, text,
            order: n, ...extra };
}
const CAMPAIGN_STORY_CUES = [
  // Prologue, fires once on first ever campaign-map entry.
  ccue(1, 'chapterEnter', 'concierge', 'First time here?'),
  ccue(1, 'chapterEnter', 'player', 'Is it that obvious?'),
  ccue(1, 'chapterEnter', 'concierge', 'Only to people who remember their first time.'),
  ccue(1, 'chapterEnter', null, 'The CONCIERGE turns toward the gaming floor.'),
  ccue(1, 'chapterEnter', 'concierge', 'Your seat is ready.'),

  // Level 1 — First Hand
  ccue(1, 'preLevel', null, 'The CONCIERGE stops beside a four-seat card table. Three regulars are already seated. The fourth chair is empty.'),
  ccue(1, 'preLevel', 'concierge', 'This one is yours.'),
  ccue(1, 'preLevel', 'reg1', 'First night?'),
  ccue(1, 'preLevel', 'reg2', 'Go easy. First hands tell on people.'),
  ccue(1, 'postClear', null, 'The PLAYER sits. The hand begins. The PLAYER does not chase tricks, keeps the dangerous cards moving and finishes with few enough penalty points to clear the minimum.'),
  ccue(1, 'postClear', null, 'For a moment, nobody says anything.'),
  ccue(1, 'postClear', 'reg3', 'Huh.'),
  ccue(1, 'postClear', 'reg1', 'You actually played that out properly.'),
  ccue(1, 'postClear', 'reg2', 'Most first-timers collect half the table before they understand what happened.'),
  ccue(1, 'postClear', 'concierge', 'One hand. Do not build a legend out of it yet.'),

  // Level 2 — Not An Accident
  ccue(2, 'preLevel', null, 'The same four seats. A new fixed hand. The regulars are noticeably less relaxed now.'),
  ccue(2, 'preLevel', 'reg1', 'All right. Do it twice.'),
  ccue(2, 'postClear', null, 'The PLAYER lets an opponent take a harmless trick rather than winning it unnecessarily. Later, the PLAYER unloads a dangerous card at the right moment.'),
  ccue(2, 'postClear', 'reg2', 'You knew not to take that.'),
  ccue(2, 'postClear', 'reg3', 'Either lucky or you know the game.'),
  ccue(2, 'postClear', 'player', 'Maybe I know when I do not want a trick.'),
  ccue(2, 'postClear', 'reg1', 'That answer worries me more.'),
  ccue(2, 'postClear', 'reg2', 'Twice is harder to call luck.'),

  // Level 3 — Count What Is Gone (Suit Void)
  ccue(3, 'preLevel', null, 'The hand develops unevenly. One suit disappears quickly from the PLAYER hand.'),
  ccue(3, 'preLevel', 'reg3', "You are watching what is left, aren't you?"),
  ccue(3, 'postClear', null, 'The PLAYER uses the void to avoid taking a costly trick.'),
  ccue(3, 'postClear', 'reg1', 'There. You knew exactly when that suit was dead for you.'),
  ccue(3, 'postClear', 'reg2', 'Counting cards already? In the entrance room?'),
  ccue(3, 'postClear', 'concierge', 'Counting is not cheating when the cards were played in front of everyone.'),
  ccue(3, 'postClear', 'reg3', 'Fine. I am officially paying attention.'),

  // Level 4 — The Man With The Glass
  ccue(4, 'preLevel', null, 'As the next hand is dealt, REGULAR #2 glances toward the far end of the room.'),
  ccue(4, 'preLevel', 'reg2', 'Do not turn around.'),
  ccue(4, 'preLevel', 'player', 'That usually makes people turn around.'),
  ccue(4, 'preLevel', 'reg2', 'The Glass Baron is watching this table.'),
  ccue(4, 'preLevel', null, 'The PLAYER looks anyway. At the far railing, THE GLASS BARON stands with a cut-glass tumbler in one hand. He does not wave. He simply watches.'),
  ccue(4, 'preLevel', 'reg1', 'Now you have done it.'),
  ccue(4, 'preLevel', null, 'The PLAYER avoids a late dangerous trick and clears again.'),
  ccue(4, 'postClear', null, 'Across the room, THE GLASS BARON lifts his glass by half an inch. Nothing more.'),

  // Level 5 — The Queen Stays Out (Avoid ♠Q)
  ccue(5, 'preLevel', null, 'The Queen of Spades remains unplayed deep into the hand. The table grows careful.'),
  ccue(5, 'preLevel', 'reg1', 'There she is somewhere.'),
  ccue(5, 'preLevel', 'reg3', 'And nobody wants to ask where.'),
  ccue(5, 'postClear', null, 'The PLAYER refuses an obvious-looking lead that could invite the Queen onto the trick.'),
  ccue(5, 'postClear', 'reg2', 'You saw that trap.'),
  ccue(5, 'postClear', 'player', 'I saw thirteen reasons not to take it.'),
  ccue(5, 'postClear', 'reg3', 'That was almost clever.'),
  ccue(5, 'postClear', 'reg1', 'Almost? That was annoyingly clever.'),
  // Added buildup (not in the source screenplay, written to match it): an
  // ambient sighting rather than a line FROM him — "distant glimpse" is
  // the brief's own pacing for early levels, and Level 4 already spent
  // the direct-glimpse beat, so this one stays at arm's length. First
  // appearance of the glass-swirl detail that recurs at Level 6 and in
  // his Level 10 introduction art (he's holding the same tumbler there).
  ccue(5, 'postClear', 'reg2', 'He is still by the rail. Same glass, still full — I do not think he has taken one sip all night.'),

  // Level 6 — Good Enough To Pass
  ccue(6, 'postClear', null, 'The PLAYER takes a few penalty points early. REGULAR #2 smiles as if the spell has broken.'),
  ccue(6, 'postClear', 'reg2', 'There we go. Human after all.'),
  ccue(6, 'postClear', null, 'Instead of chasing a perfect hand, the PLAYER limits the damage and keeps the total beneath the clear line.'),
  ccue(6, 'postClear', 'reg1', 'You stopped trying to make it pretty.'),
  ccue(6, 'postClear', 'player', 'Pretty was not the target.'),
  ccue(6, 'postClear', 'reg3', 'That might be the first smart thing anybody has said in this room tonight.'),
  // Added buildup: his first WORD since Level 4, and it's one word — the
  // brief's "middle levels: one or two short interactions" beat. Said to
  // nobody in particular, which is the point; Regular #1 flags how out
  // of character even that much is, seeding why Level 9's actual line to
  // the PLAYER later lands as a bigger moment.
  ccue(6, 'postClear', 'glass_baron', 'Interesting.'),
  ccue(6, 'postClear', 'reg1', 'He does not usually say even that much.'),
  ccue(6, 'postClear', null, 'THE GLASS BARON has moved closer. He now watches from beside the velvet rope.'),

  // Level 7 — Maybe You Know The Game
  ccue(7, 'postClear', null, 'A quick exchange leaves REGULAR #1 exposed in one suit. The PLAYER notices immediately and changes the route of the hand.'),
  ccue(7, 'postClear', 'reg1', 'You counted that.'),
  ccue(7, 'postClear', 'reg2', 'He counted all of it.'),
  ccue(7, 'postClear', 'reg3', 'Maybe our first-timer actually knows how this game works.'),
  ccue(7, 'postClear', null, 'THE GLASS BARON passes behind the table. He does not stop.'),
  ccue(7, 'postClear', 'glass_baron', 'Maybe.'),
  ccue(7, 'postClear', null, 'He keeps walking.'),
  ccue(7, 'postClear', 'reg2', 'Well. Now I am definitely not relaxing.'),

  // Level 8 — He Is Still Watching
  ccue(8, 'preLevel', null, 'The room feels busier, but the PLAYER table has become strangely quiet.'),
  ccue(8, 'preLevel', 'reg3', 'He has watched three full hands now.'),
  ccue(8, 'preLevel', 'player', 'Who?'),
  ccue(8, 'preLevel', 'reg3', 'Very funny.'),
  ccue(8, 'postClear', null, "The PLAYER slips a dangerous heart away on an opponent's winning trick and preserves the clear."),
  ccue(8, 'postClear', 'reg1', 'That was clean.'),
  ccue(8, 'postClear', null, 'THE GLASS BARON stands at the bar, speaking to nobody, eyes still on the table.'),
  ccue(8, 'postClear', 'reg2', 'I think he is waiting for something.'),

  // Level 9 — An Empty Chair
  ccue(9, 'preLevel', null, 'The hand ends. Before the next deal, REGULAR #3 receives a quiet tap on the shoulder from the CONCIERGE.'),
  ccue(9, 'preLevel', 'reg3', 'That my cue?'),
  ccue(9, 'preLevel', 'concierge', 'It is.'),
  ccue(9, 'preLevel', null, 'REGULAR #3 stands and leaves the fourth seat empty.'),
  ccue(9, 'preLevel', 'reg1', 'Oh, no.'),
  ccue(9, 'preLevel', 'reg2', 'Congratulations. You have been noticed.'),
  ccue(9, 'preLevel', null, 'THE GLASS BARON finally walks toward the table, glass in hand. He stops behind the empty chair but does not sit yet.'),
  ccue(9, 'preLevel', 'glass_baron', 'Finish this one first.'),
  ccue(9, 'preLevel', null, 'The PLAYER does.'),
  ccue(9, 'postClear', 'glass_baron', 'Good. Now we can stop guessing.'),

  // Level 10 — BOSS: The Glass Baron
  // Payoff for the Level 5/6 buildup (the glass he never drinks from) —
  // added alongside that buildup, not in the source screenplay.
  ccue(10, 'bossIntro', null, 'The PLAYER remains seated with two regulars. THE GLASS BARON takes the chair REGULAR #3 left behind and places his glass beside his cards.'),
  ccue(10, 'bossIntro', 'player', 'You never actually drink that, do you?'),
  ccue(10, 'bossIntro', 'glass_baron', 'It gives my hands something respectable to do while I watch.'),
  ccue(10, 'bossIntro', 'glass_baron', 'I have been watching you since your fourth hand.'),
  ccue(10, 'bossIntro', 'player', 'That sounds unhealthy.'),
  ccue(10, 'bossIntro', 'glass_baron', 'It is a casino. We have worse habits.'),
  ccue(10, 'bossIntro', null, 'A small smile.'),
  ccue(10, 'bossIntro', 'glass_baron', 'You play your cards well. You remember what is gone. You know when a trick is not worth taking.'),
  ccue(10, 'bossIntro', null, 'He squares the cards in front of him.'),
  ccue(10, 'bossIntro', 'glass_baron', 'Let us see if you can beat me.'),
  ccue(10, 'bossMidpoint', null, 'The Baron studies the running score.'),
  ccue(10, 'bossMidpoint', 'glass_baron', 'Still keeping the damage low. Sensible.'),
  ccue(10, 'bossMidpoint', 'player', 'You sound disappointed.'),
  ccue(10, 'bossMidpoint', 'glass_baron', 'No. Interested.'),
  ccue(10, 'postFail', 'glass_baron', 'Again. Same hand. Better answer.', { pick: 'random' }),
  ccue(10, 'postFail', 'glass_baron', 'You saw the danger. You simply saw it one trick too late.', { pick: 'random' }),
  ccue(10, 'postFail', 'glass_baron', 'Do not chase the hand you wanted. Play the hand that is here.', { pick: 'random' }),
  ccue(10, 'bossDefeat', null, 'The final score settles.'),
  ccue(10, 'bossDefeat', null, 'THE GLASS BARON looks at the result, then finishes his drink.'),
  ccue(10, 'bossDefeat', 'glass_baron', 'All right.'),
  ccue(10, 'bossDefeat', 'player', 'That is all I get?'),
  ccue(10, 'bossDefeat', 'glass_baron', 'No. You get an invitation.'),
  ccue(10, 'bossDefeat', null, 'He stands.'),
  ccue(10, 'bossDefeat', 'glass_baron', 'There is another table where I would like you to join me.'),
  ccue(10, 'bossDefeat', 'player', 'Where?'),
  ccue(10, 'bossDefeat', 'glass_baron', 'Rooftop. Higher rollers. Sharper eyes.'),
  ccue(10, 'chapterExit', null, 'He gestures toward a private lift.'),
  ccue(10, 'chapterExit', 'glass_baron', 'Come. I want to see what they make of you.'),

  // ── Chapter 2 — The Rooftop, Boss: The Sharp ──
  // Level 11 — Higher Up
  ccue(11, 'preLevel', null, 'The lift doors open onto city lights and cold air. THE GLASS BARON leads the PLAYER to a table with three new opponents.'),
  ccue(11, 'preLevel', 'glass_baron', 'Everyone here earned their chair. They will not underestimate you for long.'),
  ccue(11, 'preLevel', null, 'A strange sound comes from the balcony corridor.'),
  ccue(11, 'preLevel', 'the_sharp', 'Five hundred thirty-seven... five hundred thirty-eight...'),
  ccue(11, 'preLevel', null, 'The PLAYER looks over. A man in an immaculate suit is doing pull-ups from the decorative balcony crossbar as if this is perfectly normal.'),
  ccue(11, 'preLevel', 'rooftop1', 'Do not ask.'),
  ccue(11, 'preLevel', 'rooftop2', 'He likes an audience.'),
  ccue(11, 'postClear', null, 'The hand begins. The PLAYER keeps the penalty low enough to clear.'),
  ccue(11, 'postClear', 'glass_baron', 'The rooftop suits you.'),

  // Level 12 — Do Not Waste Motion
  ccue(12, 'preLevel', null, 'THE SHARP drops lightly from the balcony bar, adjusts his cuffs and walks past the table without appearing out of breath.'),
  ccue(12, 'preLevel', 'the_sharp', 'You took one trick you did not need.'),
  ccue(12, 'preLevel', 'player', 'Hello to you too.'),
  ccue(12, 'preLevel', 'the_sharp', 'Greetings are also unnecessary motion.'),
  ccue(12, 'preLevel', null, 'He keeps walking.'),
  ccue(12, 'preLevel', 'rooftop2', 'That was him being friendly.'),
  ccue(12, 'postClear', null, 'The PLAYER plays a cleaner hand.'),
  ccue(12, 'postClear', 'rooftop1', 'He is irritating. He is also usually right.'),

  // Level 13 — Two Tricks Ahead (Trick Count)
  ccue(13, 'postClear', null, 'An opponent changes strategy mid-hand. The PLAYER adjusts before the trap closes.'),
  ccue(13, 'postClear', 'rooftop2', 'I thought you would take that.'),
  ccue(13, 'postClear', 'rooftop1', 'He saw it two tricks ago.'),
  ccue(13, 'postClear', null, 'At the railing, THE SHARP is now doing slow push-ups, jacket still on.'),
  ccue(13, 'postClear', 'the_sharp', 'Thirty-nine... forty...'),
  ccue(13, 'postClear', 'rooftop2', 'Show-off.'),
  ccue(13, 'postClear', null, 'THE SHARP looks up from the floor exactly as the credit counter finishes rolling.'),

  // Level 14 — Razor Comment
  ccue(14, 'postClear', null, 'The Queen of Spades appears late. The PLAYER routes around it and leaves another opponent holding the dangerous trick.'),
  ccue(14, 'postClear', 'rooftop1', 'That was good.'),
  ccue(14, 'postClear', 'the_sharp', 'It was adequate.'),
  ccue(14, 'postClear', null, 'THE SHARP is leaning against the corridor now, perfectly composed.'),
  ccue(14, 'postClear', 'the_sharp', 'Good would have cost fewer points two tricks earlier.'),
  ccue(14, 'postClear', 'player', 'Do you ever compliment anyone?'),
  ccue(14, 'postClear', 'the_sharp', 'When necessary.'),
  ccue(14, 'postClear', 'rooftop2', 'I would take "adequate." That is practically a standing ovation from him.'),

  // Level 15 — Make Them Change (Clean Hand)
  ccue(15, 'postClear', null, 'ROOFTOP PLAYER #3 attempts the same bait twice. The PLAYER refuses it twice.'),
  ccue(15, 'postClear', 'rooftop2', 'I have been trying to fool you for three rounds.'),
  ccue(15, 'postClear', 'rooftop1', 'And now you are changing how you play because of it.'),
  ccue(15, 'postClear', 'glass_baron', 'That is usually the moment a table becomes interesting.'),
  ccue(15, 'postClear', null, 'THE SHARP watches from the far balcony, arms folded.'),
  ccue(15, 'postClear', 'rooftop2', 'Fine. I need a new plan.'),

  // Level 16 — The Cut
  ccue(16, 'postClear', null, 'The PLAYER reveals a void slightly earlier than ideal. The hand still clears.'),
  ccue(16, 'postClear', 'the_sharp', 'You showed them too much.'),
  ccue(16, 'postClear', 'player', 'I passed.'),
  ccue(16, 'postClear', 'the_sharp', 'Passing does not make the mistake disappear.'),
  ccue(16, 'postClear', null, 'A beat. He points once toward the table.'),
  ccue(16, 'postClear', 'the_sharp', 'Next time, make them discover it. Do not announce it.'),
  ccue(16, 'postClear', 'rooftop2', 'See? Knife first. Advice second.'),

  // Level 17 — Close Still Counts
  ccue(17, 'postClear', null, 'The margin is tight. The PLAYER finishes just inside the clear requirement.'),
  ccue(17, 'postClear', 'rooftop1', 'Close.'),
  ccue(17, 'postClear', 'player', 'Close still counts.'),
  ccue(17, 'postClear', 'the_sharp', 'Only if you learn why it was close.'),
  ccue(17, 'postClear', 'player', 'You really cannot help yourself, can you?'),
  ccue(17, 'postClear', 'the_sharp', 'No.'),
  ccue(17, 'postClear', null, 'For the first time, THE GLASS BARON laughs aloud.'),

  // Level 18 — He Stops Moving
  ccue(18, 'preLevel', null, 'No pull-ups. No push-ups. No pacing. THE SHARP stands completely still behind the rooftop table and watches every card.'),
  ccue(18, 'preLevel', 'rooftop1', 'That is worse.'),
  ccue(18, 'preLevel', 'rooftop2', 'Much worse.'),
  ccue(18, 'postClear', null, 'The PLAYER notices an opponent is void, uses it, and avoids a costly late trick.'),
  ccue(18, 'postClear', 'the_sharp', 'You counted the void.'),
  ccue(18, 'postClear', 'player', 'You sound surprised.'),
  ccue(18, 'postClear', 'the_sharp', 'I am not.'),
  ccue(18, 'postClear', null, 'THE SHARP remains behind the table after the others begin to stand.'),

  // Level 19 — Sharp Eyes
  ccue(19, 'preLevel', null, 'Before the deal, ROOFTOP PLAYER #3 glances back at THE SHARP.'),
  ccue(19, 'preLevel', 'rooftop2', 'You planning to stand there all night?'),
  ccue(19, 'preLevel', 'the_sharp', 'No.'),
  ccue(19, 'postClear', null, 'The hand begins. THE SHARP watches without a word. The PLAYER clears.'),
  ccue(19, 'postClear', 'the_sharp', 'You remember cards. You read people. You recover from imperfect hands.'),
  ccue(19, 'postClear', 'player', 'Is that a compliment?'),
  ccue(19, 'postClear', 'the_sharp', 'It is an assessment.'),
  ccue(19, 'postClear', null, 'He looks at ROOFTOP PLAYER #3.'),
  ccue(19, 'postClear', 'the_sharp', 'Your seat.'),
  ccue(19, 'postClear', 'rooftop2', 'There it is.'),
  ccue(19, 'postClear', null, 'The opponent stands.'),
  ccue(19, 'postClear', 'glass_baron', 'I told you: sharper eyes.'),

  // Level 20 — BOSS: The Sharp
  ccue(20, 'bossIntro', null, 'THE SHARP takes the open chair. He smooths his suit jacket as if the previous five hundred repetitions never happened.'),
  ccue(20, 'bossIntro', 'the_sharp', 'The Baron says you understand cards.'),
  ccue(20, 'bossIntro', 'player', 'And you disagree?'),
  ccue(20, 'bossIntro', 'the_sharp', 'Cards are easy. People leak information.'),
  ccue(20, 'bossIntro', null, 'He looks at the two remaining rooftop opponents, then back to the PLAYER.'),
  ccue(20, 'bossIntro', 'the_sharp', 'Let us see whether you notice before they do.'),
  ccue(20, 'bossMidpoint', 'the_sharp', 'Better. You changed after one mistake instead of defending it.'),
  ccue(20, 'bossMidpoint', 'player', 'That almost sounded kind.'),
  ccue(20, 'bossMidpoint', 'the_sharp', 'Do not ruin it.'),
  ccue(20, 'postFail', 'the_sharp', 'Again. You saw the card. You missed the person.', { pick: 'random' }),
  ccue(20, 'postFail', 'the_sharp', 'Too much motion. Too little purpose.', { pick: 'random' }),
  ccue(20, 'postFail', 'the_sharp', 'You knew what was gone. You did not ask what that forced them to hold.', { pick: 'random' }),
  ccue(20, 'bossDefeat', null, 'The score settles.'),
  ccue(20, 'bossDefeat', null, 'THE SHARP studies the result for a long second.'),
  ccue(20, 'bossDefeat', 'the_sharp', 'You adapt.'),
  ccue(20, 'bossDefeat', 'player', 'Interesting?'),
  ccue(20, 'bossDefeat', 'the_sharp', 'Annoyingly.'),
  ccue(20, 'bossDefeat', null, 'He rises and gestures toward a narrow brass door beyond the rooftop bar.'),
  ccue(20, 'bossDefeat', 'the_sharp', 'There is someone downstairs who believes every decision can be explained.'),
  ccue(20, 'bossDefeat', 'glass_baron', 'You two will either get along beautifully or not at all.'),
  ccue(20, 'chapterExit', 'the_sharp', 'Come. The library is quieter.'),

  // ── Chapter 3 — The Grand Library, Boss: The Scholar ──
  // Level 21 — The Reader
  ccue(21, 'preLevel', null, 'The brass door opens into near-silence. Three library players wait at the next four-seat table.'),
  ccue(21, 'preLevel', null, 'At a reading desk beyond them sits THE SCHOLAR, glasses low on his nose, absorbed in a thick book.'),
  ccue(21, 'preLevel', 'the_scholar', 'Woof.'),
  ccue(21, 'preLevel', null, 'Nobody reacts.'),
  ccue(21, 'preLevel', 'player', 'Did he just—'),
  ccue(21, 'preLevel', 'lib1', 'Yes.'),
  ccue(21, 'preLevel', 'player', 'Why?'),
  ccue(21, 'preLevel', 'lib1', 'We stopped asking.'),
  ccue(21, 'preLevel', null, 'The hand begins. The PLAYER clears with a restrained defensive line.'),
  ccue(21, 'postClear', null, 'THE SCHOLAR turns one page without looking up.'),

  // Level 22 — One Line In The Margin
  ccue(22, 'postClear', null, 'The PLAYER adjusts immediately when an opponent changes the route of a suit.'),
  ccue(22, 'postClear', 'lib2', 'Most people need two tricks to see that.'),
  ccue(22, 'postClear', 'lib3', 'You needed one.'),
  ccue(22, 'postClear', null, 'Across the room, THE SCHOLAR writes a single line in the margin of his book.'),
  ccue(22, 'postClear', 'player', 'Is he taking notes on us?'),
  ccue(22, 'postClear', 'lib1', 'Probably on you.'),
  ccue(22, 'postClear', null, 'THE SCHOLAR pushes his glasses back up and continues reading.'),

  // Level 23 — Where The Queen Lands (Avoid the Queen)
  ccue(23, 'preLevel', null, 'The Queen of Spades stays hidden deep into the hand. The table tightens.'),
  ccue(23, 'preLevel', 'lib3', 'Nobody wants to open that door.'),
  ccue(23, 'postClear', null, 'The PLAYER chooses a safe route that forces the dangerous card away from their own pile.'),
  ccue(23, 'postClear', 'lib2', 'You knew where she could land.'),
  ccue(23, 'postClear', 'the_scholar', 'Woof.'),
  ccue(23, 'postClear', 'lib1', 'That might be approval.'),

  // Level 24 — Sacrifice The Trick
  ccue(24, 'postClear', null, 'The PLAYER deliberately gives up an early trick to preserve a safer endgame.'),
  ccue(24, 'postClear', 'lib1', 'You let that go on purpose.'),
  ccue(24, 'postClear', 'player', 'It was cheaper.'),
  ccue(24, 'postClear', 'lib2', 'Most people hate losing a trick even when winning it hurts them.'),
  ccue(24, 'postClear', null, 'THE SCHOLAR looks up from his book for the first time, then writes another note.'),
  ccue(24, 'postClear', 'lib3', 'He noticed that one.'),

  // Level 25 — Luck Is The Excuse
  ccue(25, 'preLevel', null, 'Between hands, LIBRARY PLAYER #2 closes a small notebook of their own.'),
  ccue(25, 'preLevel', 'lib2', 'People downstairs call this luck.'),
  ccue(25, 'preLevel', 'lib1', 'People downstairs are downstairs.'),
  ccue(25, 'postClear', null, 'The hand turns awkward. The PLAYER limits the penalty instead of forcing an impossible clean finish.'),
  ccue(25, 'postClear', 'lib3', 'That is the difference. You stop fighting the hand before the hand punishes you for it.'),
  ccue(25, 'postClear', null, 'THE SCHOLAR quietly changes books.'),

  // Level 26 — Rewrite The Plan
  ccue(26, 'postClear', null, 'Hearts break earlier than expected. The PLAYER abandons the first plan and pivots.'),
  ccue(26, 'postClear', 'lib1', 'You changed everything in one trick.'),
  ccue(26, 'postClear', 'player', 'The table changed first.'),
  ccue(26, 'postClear', null, "THE SCHOLAR looks over the top of his book."),
  ccue(26, 'postClear', 'the_scholar', 'Correct.'),
  // Deliberately its own card, not appended to the line above — the beat
  // between "Correct." and this IS the joke. The story-box guide's own
  // "A beat." narration for this exact gap confirms the pacing this
  // comment already described; see it below rather than duplicated here.
  ccue(26, 'postClear', null, 'A beat.'),
  ccue(26, 'postClear', 'the_scholar', 'Woof.'),
  ccue(26, 'postClear', 'player', 'I was almost taking you seriously.'),
  ccue(26, 'postClear', null, "A tiny smile appears behind THE SCHOLAR's book."),

  // Level 27 — The Book Is Not The Game
  ccue(27, 'preLevel', null, 'More spectators gather between the shelves. THE SCHOLAR has moved to a chair closer to the PLAYER table, book still open.'),
  ccue(27, 'preLevel', 'lib3', 'He has not read a line in five minutes.'),
  ccue(27, 'preLevel', 'lib2', 'He is reading something else now.'),
  ccue(27, 'postClear', null, 'The PLAYER avoids bait on two consecutive tricks.'),
  ccue(27, 'postClear', 'the_scholar', 'Patterns are useful until the opponent knows you prefer them.'),
  ccue(27, 'postClear', 'player', 'That advice free?'),
  ccue(27, 'postClear', 'the_scholar', 'For now.'),

  // Level 28 — Book Closed
  ccue(28, 'preLevel', null, 'The PLAYER arrives. THE SCHOLAR closes his thick book before the first card is dealt.'),
  ccue(28, 'preLevel', 'lib1', 'That is new.'),
  ccue(28, 'postClear', null, 'THE SCHOLAR removes his glasses, folds them and sets them on top of the book. He watches the entire hand directly.'),
  ccue(28, 'postClear', null, 'The PLAYER refuses a tempting but dangerous trick and clears.'),
  ccue(28, 'postClear', 'the_scholar', 'You no longer need the obvious answer.'),
  ccue(28, 'postClear', 'player', 'Neither do you, apparently.'),
  ccue(28, 'postClear', null, 'THE SCHOLAR does not reopen the book.'),

  // Level 29 — Studying You (Suit Void)
  ccue(29, 'preLevel', null, 'The table is ready. THE SCHOLAR stands behind LIBRARY PLAYER #3 for the entire hand.'),
  ccue(29, 'preLevel', 'lib3', 'You are making this very comfortable.'),
  ccue(29, 'preLevel', 'the_scholar', 'Good.'),
  ccue(29, 'postClear', null, 'The PLAYER clears after tracking a late void and unloading the dangerous card at the only safe moment.'),
  ccue(29, 'postClear', 'the_scholar', 'Enough.'),
  ccue(29, 'postClear', null, 'He taps LIBRARY PLAYER #3 on the shoulder.'),
  ccue(29, 'postClear', 'lib3', 'My seat?'),
  ccue(29, 'postClear', 'the_scholar', 'Your seat.'),
  ccue(29, 'postClear', 'lib1', 'He likes you. I think.'),
  ccue(29, 'postClear', null, 'LIBRARY PLAYER #3 stands. THE SCHOLAR takes one step toward the chair.'),

  // Level 30 — BOSS: The Scholar
  ccue(30, 'bossIntro', null, 'THE SCHOLAR reaches the empty chair. Before sitting, he looks directly at the PLAYER.'),
  ccue(30, 'bossIntro', 'the_scholar', 'Woof.'),
  ccue(30, 'bossIntro', null, 'He sits. Nobody reacts.'),
  ccue(30, 'bossIntro', 'the_scholar', 'I have read every game you played in this building tonight.'),
  ccue(30, 'bossIntro', 'player', 'Read?'),
  ccue(30, 'bossIntro', 'the_scholar', 'Cards are text. Decisions are annotations. Mistakes are revisions.'),
  ccue(30, 'bossIntro', null, 'He places the closed book beside him.'),
  ccue(30, 'bossIntro', 'the_scholar', 'Let us add one more chapter.'),
  ccue(30, 'bossMidpoint', 'the_scholar', 'Interesting. You are not following the pattern I wrote down.'),
  ccue(30, 'bossMidpoint', 'player', 'Then your notes are wrong.'),
  ccue(30, 'bossMidpoint', 'the_scholar', 'No. They are becoming useful.'),
  ccue(30, 'postFail', 'the_scholar', 'Again. The result changed before your plan did.', { pick: 'random' }),
  ccue(30, 'postFail', 'the_scholar', 'You remembered the cards. You forgot the reason they mattered.', { pick: 'random' }),
  ccue(30, 'postFail', 'the_scholar', 'A mistake is only expensive if you insist on repeating it.', { pick: 'random' }),
  ccue(30, 'bossDefeat', null, 'The score settles.'),
  ccue(30, 'bossDefeat', null, 'THE SCHOLAR opens his book, crosses out one full line, then closes it again.'),
  ccue(30, 'bossDefeat', 'the_scholar', 'You do not merely follow patterns.'),
  ccue(30, 'bossDefeat', 'player', 'No?'),
  ccue(30, 'bossDefeat', 'the_scholar', 'You create new ones.'),
  ccue(30, 'bossDefeat', null, 'He puts his glasses back on and walks toward a bronze double door.'),
  ccue(30, 'bossDefeat', 'the_scholar', 'Knowledge brought you this far.'),
  ccue(30, 'chapterExit', null, 'He opens the doors. Laughter and music spill into the library.'),
  ccue(30, 'chapterExit', 'the_scholar', 'The next room is less respectful of knowledge.'),
  ccue(30, 'chapterExit', 'player', 'You are not coming?'),
  ccue(30, 'chapterExit', 'the_scholar', 'Of course I am coming.'),
  ccue(30, 'chapterExit', null, 'A beat.'),
  ccue(30, 'chapterExit', 'the_scholar', 'Woof.'),

  // ── Chapter 4 — The Carnival Lounge, Boss: The Wildcard ──
  // Level 31 — That Laugh
  ccue(31, 'preLevel', null, 'The bronze doors swing open. Before the PLAYER sees anyone, a huge laugh rolls across the room.'),
  ccue(31, 'preLevel', 'the_wildcard', 'Ha! No, no, no — that was magnificent.'),
  ccue(31, 'preLevel', null, 'THE WILDCARD walks past another table with a beer in one hand. A player there has just swallowed the Queen of Spades.'),
  ccue(31, 'preLevel', 'the_wildcard', 'You found the worst possible card and adopted it like a stray dog. Very generous.'),
  ccue(31, 'preLevel', null, 'The embarrassed player laughs.'),
  ccue(31, 'preLevel', 'the_wildcard', 'Next time, watch who is void before you lead that suit. Same courage, better timing.'),
  ccue(31, 'preLevel', null, 'He wanders on, still laughing. The PLAYER sits with three new opponents.'),
  ccue(31, 'preLevel', 'lounge1', 'You get used to him.'),
  ccue(31, 'preLevel', 'lounge2', 'No, you do not.'),
  ccue(31, 'postClear', null, "THE WILDCARD's laugh sounds again from somewhere behind the PLAYER."),

  // Level 32 — Gold Star (Trick Count)
  ccue(32, 'preLevel', null, 'LOUNGE PLAYER #3 makes an aggressive play that backfires.'),
  ccue(32, 'preLevel', 'the_wildcard', 'Bold! Wrong, but bold!'),
  ccue(32, 'postClear', null, 'He appears beside the table, beer still in hand.'),
  ccue(32, 'postClear', 'the_wildcard', 'You wanted to get rid of the danger before checking who could hand it back. Tiny detail. Enormous consequences.'),
  ccue(32, 'postClear', 'lounge3', 'Thank you, professor.'),
  ccue(32, 'postClear', 'the_wildcard', 'Gold star. No sticker. Budget cuts.'),
  ccue(32, 'postClear', null, 'He laughs and moves on.'),
  ccue(32, 'postClear', 'lounge1', 'He teaches like the school burned down years ago.'),

  // Level 33 — Nice Escape
  ccue(33, 'postClear', null, 'The PLAYER escapes a dangerous trick by using a void at exactly the right time.'),
  ccue(33, 'postClear', 'the_wildcard', 'Nice escape!'),
  ccue(33, 'postClear', null, 'He passes behind the table without stopping, beer raised in salute.'),
  ccue(33, 'postClear', 'the_wildcard', 'You saw the exit before the room caught fire. Keep that.'),
  ccue(33, 'postClear', 'player', 'Do you comment on every table?'),
  ccue(33, 'postClear', 'the_wildcard', 'Only the educational ones!'),
  ccue(33, 'postClear', null, 'He is gone before the sentence finishes.'),

  // Level 34 — Wrong Card, Great Confidence
  ccue(34, 'postClear', null, 'LOUNGE PLAYER #2 confidently throws a card that immediately costs them.'),
  ccue(34, 'postClear', 'the_wildcard', 'Wrong card. Great confidence, though.'),
  ccue(34, 'postClear', 'lounge2', 'Helpful.'),
  ccue(34, 'postClear', 'the_wildcard', 'I am helping. You will remember this because I made it embarrassing.'),
  ccue(34, 'postClear', null, 'He points at the trick.'),
  ccue(34, 'postClear', 'the_wildcard', 'Next time, count what is gone before you decide what is safe.'),
  ccue(34, 'postClear', null, 'He takes a sip of beer and looks at the PLAYER.'),
  ccue(34, 'postClear', 'the_wildcard', 'You already do that. Annoying.'),

  // Level 35 — Class Is In Session (Clean Hand)
  ccue(35, 'postClear', null, 'The hand becomes chaotic. Two players dump danger early. The PLAYER stays patient.'),
  ccue(35, 'postClear', 'lounge1', 'How are you still clean?'),
  ccue(35, 'postClear', 'the_wildcard', 'Because our new student is doing homework!'),
  ccue(35, 'postClear', null, 'Laughter. THE WILDCARD leans over the back of an empty spectator chair.'),
  ccue(35, 'postClear', 'the_wildcard', 'Everybody else is trying to win tricks. You are trying to win the hand. Different subject.'),
  ccue(35, 'postClear', null, 'THE WILDCARD taps his beer bottle against the table edge like a school bell, then moves away.'),

  // Level 36 — Joke, Then Lesson
  ccue(36, 'postClear', null, 'LOUNGE PLAYER #3 gets trapped with a pile of hearts.'),
  ccue(36, 'postClear', 'the_wildcard', 'Congratulations! You have collected the complete red set.'),
  ccue(36, 'postClear', null, 'The table laughs, including LOUNGE PLAYER #3.'),
  ccue(36, 'postClear', 'the_wildcard', 'Now the boring part: you showed your void too early and they used it against you. Hide information until it buys you something.'),
  ccue(36, 'postClear', 'lounge3', 'See? There it is. Joke, then homework.'),
  ccue(36, 'postClear', 'the_wildcard', 'Education is a gift.'),
  ccue(36, 'postClear', null, 'He walks away with the beer still in hand.'),

  // Level 37 — He Notices You
  ccue(37, 'postClear', null, 'The PLAYER makes a deliberately strange-looking move that becomes correct two tricks later.'),
  ccue(37, 'postClear', 'lounge2', 'I thought that was a mistake.'),
  ccue(37, 'postClear', 'the_wildcard', 'So did I.'),
  ccue(37, 'postClear', null, 'For once, THE WILDCARD has stopped walking. He watches the last two tricks closely.'),
  ccue(37, 'postClear', 'the_wildcard', 'Oh, that is fun.'),
  ccue(37, 'postClear', 'player', 'Educational?'),
  ccue(37, 'postClear', 'the_wildcard', 'Deeply.'),
  ccue(37, 'postClear', null, 'He remains near the table instead of drifting back into the room.'),

  // Level 38 — The Laughter Moves Closer
  ccue(38, 'postClear', null, 'THE WILDCARD stands directly behind the PLAYER table for the entire hand, beer in hand.'),
  ccue(38, 'postClear', null, 'The PLAYER redirects the Queen away and keeps the penalty under control.'),
  ccue(38, 'postClear', 'the_wildcard', 'Ha! You knew exactly who could not follow suit.'),
  ccue(38, 'postClear', 'lounge1', 'He has been watching every card.'),
  ccue(38, 'postClear', 'the_wildcard', 'Of course. I can drink and count.'),
  ccue(38, 'postClear', 'player', 'That should not sound impressive.'),
  ccue(38, 'postClear', 'the_wildcard', 'And yet.'),

  // Level 39 — When The Laughter Stops
  ccue(39, 'preLevel', null, 'The room is still loud, but THE WILDCARD is not. He stands behind LOUNGE PLAYER #3, beer in hand, watching in complete silence.'),
  ccue(39, 'preLevel', 'lounge3', 'I preferred the jokes.'),
  ccue(39, 'postClear', null, 'The PLAYER clears after a tense final sequence.'),
  ccue(39, 'postClear', 'the_wildcard', 'Good.'),
  ccue(39, 'postClear', null, 'No laugh. He looks at LOUNGE PLAYER #3.'),
  ccue(39, 'postClear', 'the_wildcard', 'Recess.'),
  ccue(39, 'postClear', 'lounge3', 'That means my seat, does it?'),
  ccue(39, 'postClear', 'the_wildcard', 'You are learning.'),
  ccue(39, 'postClear', 'the_wildcard', 'All right. Class starts next hand.'),
  ccue(39, 'postClear', null, 'LOUNGE PLAYER #3 stands. THE WILDCARD keeps the beer in hand and pulls the chair back.'),

  // Level 40 — BOSS: The Wildcard
  ccue(40, 'bossIntro', null, 'THE WILDCARD sits with his beer still in one hand and his cards in the other.'),
  ccue(40, 'bossIntro', 'the_wildcard', 'Right, class. Tiny problem.'),
  ccue(40, 'bossIntro', 'player', 'You are the teacher?'),
  ccue(40, 'bossIntro', 'the_wildcard', 'Exactly. Terrifying, is it not?'),
  ccue(40, 'bossIntro', null, 'He laughs.'),
  ccue(40, 'bossIntro', 'the_wildcard', 'Let us see whether the teacher can still pass the exam.'),
  ccue(40, 'bossMidpoint', null, 'A strange play from THE WILDCARD turns out to have purpose.'),
  ccue(40, 'bossMidpoint', 'the_wildcard', 'There is the lesson: unpredictable is not the same as random.'),
  ccue(40, 'bossMidpoint', 'player', 'You rehearsed that line.'),
  ccue(40, 'bossMidpoint', 'the_wildcard', 'For years.'),
  ccue(40, 'postFail', 'the_wildcard', 'Again! Same classroom, same exam, less creative suffering.', { pick: 'random' }),
  ccue(40, 'postFail', 'the_wildcard', 'You watched my joke and missed my card. Classic.', { pick: 'random' }),
  ccue(40, 'postFail', 'the_wildcard', 'Good idea. Bad timing. Fortunately, timing is teachable.', { pick: 'random' }),
  ccue(40, 'bossDefeat', null, 'The final score settles.'),
  ccue(40, 'bossDefeat', null, 'THE WILDCARD stares at the result, then bursts out laughing and raises his beer.'),
  ccue(40, 'bossDefeat', 'the_wildcard', 'Excellent!'),
  ccue(40, 'bossDefeat', 'player', 'That sounded sincere.'),
  ccue(40, 'bossDefeat', 'the_wildcard', 'It is. You learned the important bit.'),
  ccue(40, 'bossDefeat', 'player', 'Which bit?'),
  ccue(40, 'bossDefeat', 'the_wildcard', 'When I make noise, watch the cards.'),
  ccue(40, 'chapterExit', null, 'He gets up and walks toward a pair of glass doors, beer still in hand.'),
  ccue(40, 'chapterExit', 'the_wildcard', 'Come on. Next room has flowers, sunlight and a man with opinions about absolutely everything.'),
  ccue(40, 'chapterExit', 'player', 'Worse than you?'),
  ccue(40, 'chapterExit', 'the_wildcard', 'Much more direct.'),

  // ── Chapter 5 — The Conservatory, Boss: The Optimist ──
  // Level 41 — No Hard Feelings
  ccue(41, 'preLevel', null, 'Sunlight floods through the glass roof. THE WILDCARD steps aside as the PLAYER enters.'),
  ccue(41, 'preLevel', null, 'Near a fountain, THE OPTIMIST is speaking to a woman at another table.'),
  ccue(41, 'preLevel', 'the_optimist', 'Dinner tonight?'),
  ccue(41, 'preLevel', 'cons_guest', 'No.'),
  ccue(41, 'preLevel', 'the_optimist', 'Perfect. Saves us both an awkward dessert. Have a beautiful evening.'),
  ccue(41, 'preLevel', null, 'He turns immediately toward a nearby game where a player has just made a disastrous move.'),
  ccue(41, 'preLevel', 'the_optimist', 'Whoa. That was really bad.'),
  ccue(41, 'preLevel', null, 'The player stares at him.'),
  ccue(41, 'preLevel', 'the_optimist', 'Good news: lead lower next time and half the problem disappears. You are welcome.'),
  ccue(41, 'preLevel', null, 'He laughs and walks on. The PLAYER sits with three new opponents.'),
  ccue(41, 'preLevel', 'cons1', 'That is him.'),
  ccue(41, 'preLevel', 'cons2', 'You will know when he dislikes a play.'),
  ccue(41, 'preLevel', null, 'THE OPTIMIST gives the PLAYER a cheerful thumbs-up from across the room.'),

  // Level 42 — Blunt First
  ccue(42, 'postClear', null, 'The PLAYER chooses an overly safe line but still clears.'),
  ccue(42, 'postClear', 'the_optimist', 'Too timid.'),
  ccue(42, 'postClear', null, 'He has appeared behind the table without warning.'),
  ccue(42, 'postClear', 'player', 'It worked.'),
  ccue(42, 'postClear', 'the_optimist', 'Yes. And crossing the street with your eyes closed can work once.'),
  ccue(42, 'postClear', null, 'He grins before the line can sting.'),
  ccue(42, 'postClear', 'the_optimist', 'Next time, keep the safety but use the information you already earned. You had more room than you thought.'),
  ccue(42, 'postClear', 'cons3', 'Blunt first. Advice second.'),
  ccue(42, 'postClear', 'the_optimist', 'Still a clear. Take the win.'),

  // Level 43 — Rejected, Still Smiling
  ccue(43, 'preLevel', null, 'Between hands, THE OPTIMIST spots another woman passing the table.'),
  ccue(43, 'preLevel', 'the_optimist', 'Coffee tomorrow?'),
  ccue(43, 'preLevel', 'cons_guest', 'Absolutely not.'),
  ccue(43, 'preLevel', 'the_optimist', 'Strong answer. I respect the confidence.'),
  ccue(43, 'postClear', null, 'He turns back to the game, completely unfazed.'),
  ccue(43, 'postClear', 'the_optimist', 'Speaking of strong answers — that discard was good.'),
  ccue(43, 'postClear', 'player', 'Do you recover from everything that quickly?'),
  ccue(43, 'postClear', 'the_optimist', 'Why waste a perfectly good next minute on the previous one?'),

  // Level 44 — That Was Really Bad (Suit Void)
  ccue(44, 'postClear', null, 'CONSERVATORY PLAYER #2 misreads the table and takes a painful trick.'),
  ccue(44, 'postClear', 'the_optimist', 'Oh, wow. That was really bad.'),
  ccue(44, 'postClear', 'cons2', 'Thank you.'),
  ccue(44, 'postClear', 'the_optimist', 'No, listen — this is good.'),
  ccue(44, 'postClear', 'cons2', 'How?'),
  ccue(44, 'postClear', 'the_optimist', 'Because now you will never do exactly that again. Next time, watch who is void before you lead the suit. Easy fix.'),
  ccue(44, 'postClear', null, 'He laughs. Even CONSERVATORY PLAYER #2 smiles.'),
  ccue(44, 'postClear', 'cons1', 'He insults the mistake, then rescues the person.'),

  // Level 45 — That One Is On You
  ccue(45, 'postClear', null, 'The PLAYER makes a small mistake and gets punished for it.'),
  ccue(45, 'postClear', 'the_optimist', 'That one is on you.'),
  ccue(45, 'postClear', 'player', 'You really go straight for it.'),
  ccue(45, 'postClear', 'the_optimist', 'Would you prefer I lie first?'),
  ccue(45, 'postClear', null, 'He points toward the previous trick.'),
  ccue(45, 'postClear', 'the_optimist', 'You gave them control of the suit one trick too early. Hold it once longer next time and you are fine.'),
  ccue(45, 'postClear', 'player', 'And the optimism?'),
  ccue(45, 'postClear', 'the_optimist', 'You noticed the mistake. That already makes the next hand better.'),
  ccue(45, 'postClear', null, 'The PLAYER clears despite the error. THE OPTIMIST nods as if this proves his point.'),

  // Level 46 — Progress
  ccue(46, 'postClear', null, 'CONSERVATORY PLAYER #3 makes an ugly misplay.'),
  ccue(46, 'postClear', 'the_optimist', 'Terrible.'),
  ccue(46, 'postClear', null, 'A beat.'),
  ccue(46, 'postClear', 'the_optimist', 'But impressive commitment.'),
  ccue(46, 'postClear', 'cons3', 'There is the soft landing.'),
  ccue(46, 'postClear', 'the_optimist', 'And here is the useful part: do not throw danger until you know who can return it. Try that and you will look like a different player next hand.'),
  ccue(46, 'postClear', null, 'He notices a woman at the next table and opens his mouth.'),
  ccue(46, 'postClear', 'cons_guest', 'No.'),
  ccue(46, 'postClear', 'the_optimist', 'I had not even asked yet.'),
  ccue(46, 'postClear', 'cons_guest', 'Still no.'),
  ccue(46, 'postClear', 'the_optimist', 'Efficient. I like it.'),

  // Level 47 — Annoyingly Good (Avoid the Queen)
  ccue(47, 'postClear', null, 'The PLAYER reads a late sequence perfectly, avoids the Queen and finishes with a strong clear.'),
  ccue(47, 'postClear', 'the_optimist', 'Okay.'),
  ccue(47, 'postClear', null, 'He folds his arms, pretending to be disappointed.'),
  ccue(47, 'postClear', 'the_optimist', 'That was good.'),
  ccue(47, 'postClear', 'player', 'Only good?'),
  ccue(47, 'postClear', 'the_optimist', 'Annoyingly good. I had a whole speech ready.'),
  ccue(47, 'postClear', 'cons1', 'You can still give it.'),
  ccue(47, 'postClear', 'the_optimist', "No. Waste of everybody's time. Next hand."),
  ccue(47, 'postClear', null, 'He stays beside the table instead of returning to the room.'),

  // Level 48 — No Joke This Time
  ccue(48, 'postClear', null, 'THE OPTIMIST watches the full hand from directly behind the PLAYER. He says nothing until the last card.'),
  ccue(48, 'postClear', null, 'The PLAYER tracks every suit correctly and clears.'),
  ccue(48, 'postClear', 'the_optimist', 'No joke this time.'),
  ccue(48, 'postClear', 'player', 'That serious?'),
  ccue(48, 'postClear', 'the_optimist', 'You saw the whole hand. Not just your cards. The whole table.'),
  ccue(48, 'postClear', null, 'He smiles.'),
  ccue(48, 'postClear', 'the_optimist', 'That is the part people usually cannot be taught.'),

  // Level 49 — Probably Ready
  ccue(49, 'preLevel', null, 'Before the hand, THE OPTIMIST spots a woman by the fountain.'),
  ccue(49, 'preLevel', 'the_optimist', 'One drink after this?'),
  ccue(49, 'preLevel', 'cons_guest', 'No.'),
  ccue(49, 'preLevel', 'the_optimist', 'Excellent. I have a boss fight anyway.'),
  ccue(49, 'preLevel', null, 'He turns to the PLAYER table as if nothing happened.'),
  ccue(49, 'preLevel', 'cons2', 'You never get discouraged, do you?'),
  ccue(49, 'preLevel', 'the_optimist', 'Of course I do. For about four seconds.'),
  ccue(49, 'postClear', null, 'The hand begins. He watches from behind CONSERVATORY PLAYER #3. The PLAYER clears.'),
  ccue(49, 'postClear', 'the_optimist', 'You are ready.'),
  ccue(49, 'postClear', null, 'A beat.'),
  ccue(49, 'postClear', 'the_optimist', 'Probably.'),
  ccue(49, 'postClear', 'cons3', 'That means my seat, right?'),
  ccue(49, 'postClear', 'the_optimist', 'See? You are learning too.'),
  ccue(49, 'postClear', null, 'CONSERVATORY PLAYER #3 stands.'),
  ccue(49, 'postClear', 'the_optimist', 'All right. No sugarcoating next hand.'),

  // Level 50 — BOSS: The Optimist
  ccue(50, 'bossIntro', null, 'THE OPTIMIST takes the open seat. He looks genuinely pleased to be there.'),
  ccue(50, 'bossIntro', 'the_optimist', 'All right. No sugarcoating. Show me what you have got.'),
  ccue(50, 'bossIntro', 'player', 'And if it is bad?'),
  ccue(50, 'bossIntro', 'the_optimist', 'I will tell you immediately.'),
  ccue(50, 'bossIntro', 'player', 'I was afraid of that.'),
  ccue(50, 'bossIntro', 'the_optimist', 'Then I will tell you how to fix it. Much more useful.'),
  ccue(50, 'bossIntro', null, 'The cards are dealt.'),
  // The screenplay gives this boss TWO alternative midpoint stingers (one
  // after a mistake, one after a strong adjustment). There's only one
  // bossMidpoint trigger and no signal to pick between them, so the
  // encouraging one is used — it fits a boss whose whole character is
  // that he tells you the fix — and the other is kept as a failure line
  // below, where its "you gave away control too early" note belongs.
  // The story-box guide's own beat for that failure line ("He lets the
  // sentence sit for exactly one beat") has no clean anchor here as a
  // result — it was written against the screenplay's original two-line
  // exchange, which this repurposing collapsed into one postFail string
  // inside a pick:'random' bucket — so it's deliberately not inserted
  // rather than force-split a random-pick line.
  ccue(50, 'bossMidpoint', 'the_optimist', 'There.'),
  ccue(50, 'bossMidpoint', null, 'He points at the table.'),
  ccue(50, 'bossMidpoint', 'the_optimist', 'That is better. Same problem, better answer. See? Progress.'),
  ccue(50, 'postFail', 'the_optimist', 'That was bad. Good news: now we know exactly what to fix.', { pick: 'random' }),
  ccue(50, 'postFail', 'the_optimist', 'You lost the hand, not the ability. Again.', { pick: 'random' }),
  ccue(50, 'postFail', 'the_optimist', 'Four seconds of disappointment. One... two... three... four. Done. Deal again.', { pick: 'random' }),
  ccue(50, 'postFail', 'the_optimist', 'Whoa. That was really bad. But you know why — you gave away control too early. Fix it on the next hand and we never have to talk about it again.', { pick: 'random' }),
  ccue(50, 'bossDefeat', null, 'The final score settles.'),
  ccue(50, 'bossDefeat', null, 'THE OPTIMIST leans back and grins.'),
  ccue(50, 'bossDefeat', 'the_optimist', 'See?'),
  ccue(50, 'bossDefeat', 'player', 'See what?'),
  ccue(50, 'bossDefeat', 'the_optimist', 'Told you you would get it.'),
  ccue(50, 'chapterExit', null, 'He stands and gestures toward the next set of doors beyond the conservatory.'),
  ccue(50, 'chapterExit', 'the_optimist', 'Come on. There is another room waiting.'),
  ccue(50, 'chapterExit', 'player', 'Another table?'),
  ccue(50, 'chapterExit', 'the_optimist', 'Always.'),
  ccue(50, 'chapterExit', null, 'He starts walking, then glances toward a woman passing by.'),
  ccue(50, 'chapterExit', 'the_optimist', 'Quick question—'),
  ccue(50, 'chapterExit', 'cons_guest', 'No.'),
  ccue(50, 'chapterExit', 'the_optimist', 'Worth a try.'),
  ccue(50, 'chapterExit', null, 'He turns back to the PLAYER, still smiling.'),
  ccue(50, 'chapterExit', 'the_optimist', 'Onward.'),

  // ── Chapter 6 — The Cabaret of Oddities, Boss: The Jester ──
  // A handful of lines carry a "From across the room:"/"From somewhere
  // unseen:" staging prefix in the source doc — stripped here exactly
  // like the earlier chapters' "- O.S." tag, since it describes WHERE
  // he's calling out from rather than something he'd actually say.
  // "RANDOM REGULAR" (Level 53) is assigned to cabaret2 specifically
  // because #1 and #3 already have their own lines later in that same
  // level — this way all three regulars get exactly one line each.
  // Level 51 — The Laugh Ahead
  ccue(51, 'preLevel', null, 'The glass doors of the conservatory close behind the PLAYER. The light changes from garden-bright to amber and red. Somewhere deeper in the room, someone laughs so hard that two nearby tables start laughing with him without knowing why.'),
  ccue(51, 'preLevel', 'the_optimist', 'That laugh is your next problem.'),
  ccue(51, 'preLevel', 'player', 'Problem?'),
  ccue(51, 'preLevel', 'the_optimist', 'Very friendly problem. Which is sometimes worse.'),
  ccue(51, 'preLevel', null, 'A playing card sails over the crowd, vanishes behind a lamp, then appears in the hand of a man across the room. THE JESTER bows to a table full of regulars.'),
  ccue(51, 'preLevel', 'cabaret1', 'He has been here all night.'),
  ccue(51, 'preLevel', 'cabaret2', 'He is here every night.'),
  ccue(51, 'preLevel', 'cabaret3', 'And somehow still has new material.'),
  ccue(51, 'preLevel', null, 'The PLAYER sits. Three opponents complete the four-player table. The hand begins.'),
  ccue(51, 'preLevel', 'the_jester', 'Nice recovery! Completely accidental-looking. My favorite kind.'),
  ccue(51, 'preLevel', 'cabaret1', 'Do not encourage him.'),
  ccue(51, 'postClear', null, 'THE JESTER raises both hands as if the PLAYER has just completed a stage act, then returns to his friends.'),

  // Level 52 — Berries
  ccue(52, 'preLevel', null, 'Before the next hand, THE JESTER wanders past while shuffling a deck one-handed.'),
  ccue(52, 'preLevel', 'the_jester', 'Bananas are berries. Strawberries are not.'),
  ccue(52, 'preLevel', 'cabaret2', 'No.'),
  ccue(52, 'preLevel', 'the_jester', 'Excellent argument. Very confident. Still wrong.'),
  ccue(52, 'preLevel', null, 'He keeps walking.'),
  ccue(52, 'preLevel', 'player', 'Does he just say things?'),
  ccue(52, 'preLevel', 'cabaret3', 'Constantly.'),
  ccue(52, 'preLevel', 'cabaret1', 'The irritating part is checking later.'),
  ccue(52, 'preLevel', null, 'The hand starts. The PLAYER remembers which dangerous cards have already appeared and avoids taking unnecessary penalty points.'),
  ccue(52, 'preLevel', 'cabaret2', 'You keep a lot in your head.'),
  ccue(52, 'preLevel', 'player', 'Only the things that matter.'),
  ccue(52, 'preLevel', 'the_jester', 'That is what everybody says right before forgetting something important!'),

  // Level 53 — Older Than Trees
  ccue(53, 'preLevel', null, 'THE JESTER is now sitting backward on a chair at another table, beer-free and somehow holding three decks at once.'),
  ccue(53, 'preLevel', 'the_jester', 'Sharks existed before trees.'),
  ccue(53, 'preLevel', 'cabaret2', 'That cannot be true.'),
  ccue(53, 'preLevel', 'the_jester', 'It is. Which means somewhere in history a shark could complain there was not enough shade.'),
  ccue(53, 'preLevel', null, 'The room laughs.'),
  ccue(53, 'preLevel', 'cabaret1', 'Why do I learn more biology here than at school?'),
  ccue(53, 'preLevel', 'the_jester', 'Because school rarely lets you lose credits while learning.'),
  ccue(53, 'preLevel', null, 'The PLAYER clears an awkward hand by refusing a tempting trick.'),
  ccue(53, 'preLevel', 'cabaret3', 'You ignored the obvious play.'),
  ccue(53, 'preLevel', 'player', 'It was obvious. That did not make it good.'),
  ccue(53, 'preLevel', 'the_jester', 'Exactly! Most true things look strange before they look obvious.'),

  // Level 54 — He Calls It
  ccue(54, 'preLevel', null, 'Midway through the hand, THE JESTER passes behind the table without stopping.'),
  ccue(54, 'preLevel', 'the_jester', 'Three tricks from now, somebody over there is going to hate that heart.'),
  ccue(54, 'preLevel', 'cabaret2', 'What heart?'),
  ccue(54, 'preLevel', null, 'THE JESTER points at nothing in particular and disappears into the crowd.'),
  ccue(54, 'preLevel', null, 'Three tricks later, CABARET PLAYER #2 is forced to take a painful heart-heavy trick.'),
  ccue(54, 'preLevel', 'cabaret2', 'I hate him.'),
  ccue(54, 'preLevel', 'cabaret1', 'You hate the heart.'),
  ccue(54, 'preLevel', 'cabaret2', 'I can hate both.'),
  ccue(54, 'preLevel', 'player', 'He saw the suit distribution.'),
  ccue(54, 'preLevel', 'cabaret3', 'Or he is a witch.'),
  ccue(54, 'preLevel', 'player', 'Those are not equally likely.'),
  ccue(54, 'preLevel', 'the_jester', 'Thank you!'),

  // Level 55 — Wrong Mystery
  ccue(55, 'preLevel', null, 'The PLAYER catches THE JESTER staring from behind a crooked mirror. The reflection makes his grin look twice as wide.'),
  ccue(55, 'preLevel', 'player', 'You have been watching my table.'),
  ccue(55, 'preLevel', 'the_jester', 'Of course.'),
  ccue(55, 'preLevel', 'player', 'Why?'),
  ccue(55, 'preLevel', 'the_jester', 'Because you are trying very hard to understand me.'),
  ccue(55, 'preLevel', null, 'He steps out from behind the mirror.'),
  ccue(55, 'preLevel', 'the_jester', 'Wrong mystery. Understand your cards first.'),
  ccue(55, 'preLevel', 'player', 'And then you?'),
  ccue(55, 'preLevel', 'the_jester', 'Terrible use of an evening.'),
  ccue(55, 'preLevel', null, 'He laughs and leaves. The hand begins.'),
  ccue(55, 'preLevel', 'cabaret1', 'That sounded like nonsense.'),
  ccue(55, 'preLevel', 'player', 'It was not.'),
  ccue(55, 'preLevel', null, 'The PLAYER focuses on the table rather than the distraction around it and clears.'),

  // Level 56 — Three Hearts
  ccue(56, 'preLevel', null, 'THE JESTER has gathered half a dozen regulars around a tiny aquarium built into the bar.'),
  ccue(56, 'preLevel', 'the_jester', 'Octopuses have three hearts.'),
  ccue(56, 'preLevel', 'cabaret2', 'Why do you know that?'),
  ccue(56, 'preLevel', 'the_jester', 'Because one heart sounds stressful enough and I needed perspective.'),
  ccue(56, 'preLevel', null, 'He notices the PLAYER taking a seat.'),
  ccue(56, 'preLevel', 'the_jester', 'Speaking of hearts: do not collect them.'),
  ccue(56, 'preLevel', 'player', 'That one was almost useful.'),
  ccue(56, 'preLevel', 'the_jester', 'Do not get used to it.'),
  ccue(56, 'preLevel', null, 'During the hand, an opponent tries to push danger toward the PLAYER. The PLAYER reads the setup and returns it elsewhere.'),
  ccue(56, 'preLevel', 'cabaret3', 'You saw that coming.'),
  ccue(56, 'preLevel', 'player', 'I saw enough.'),
  ccue(56, 'postClear', null, 'THE JESTER applauds with exaggerated seriousness.'),

  // Level 57 — Everybody Knows Him
  ccue(57, 'preLevel', null, "As the PLAYER crosses to the next table, three different people greet THE JESTER by name. He remembers all of theirs, asks about a birthday, a broken wrist and somebody's dog without missing a beat."),
  ccue(57, 'preLevel', 'player', 'You know everyone.'),
  ccue(57, 'preLevel', 'the_jester', 'Almost. Give me time.'),
  ccue(57, 'preLevel', 'cabaret1', 'He was at my wedding.'),
  ccue(57, 'preLevel', 'cabaret2', 'He was at my divorce party.'),
  ccue(57, 'preLevel', 'the_jester', 'Both excellent buffets.'),
  ccue(57, 'preLevel', null, 'The table laughs. The hand starts a little too casually. One opponent makes a careless mistake.'),
  ccue(57, 'preLevel', 'the_jester', 'Ah. Laughter lowers the guard. Useful thing to remember.'),
  ccue(57, 'preLevel', 'cabaret2', 'You did that on purpose?'),
  ccue(57, 'preLevel', 'the_jester', 'I do many things on purpose after they happen.'),

  // Level 58 — The Laugh Stops
  ccue(58, 'preLevel', null, 'For the first time, THE JESTER does not roam the room. He stands behind CABARET PLAYER #3 and watches the entire hand.'),
  ccue(58, 'preLevel', null, 'No tricks. No facts. No jokes.'),
  ccue(58, 'preLevel', 'cabaret1', 'This is unsettling.'),
  ccue(58, 'preLevel', 'player', 'The silence?'),
  ccue(58, 'preLevel', 'cabaret1', 'Him being serious.'),
  ccue(58, 'preLevel', null, 'The PLAYER works through a difficult sequence and clears without taking the bait of a flashy play.'),
  ccue(58, 'preLevel', 'the_jester', 'Good.'),
  ccue(58, 'preLevel', 'player', 'That is all?'),
  ccue(58, 'preLevel', 'the_jester', 'Do not worry. I am saving the nonsense.'),
  ccue(58, 'postClear', null, 'He remains near the table.'),

  // Level 59 — One Seat Short
  ccue(59, 'preLevel', null, 'THE JESTER arrives before the PLAYER and is already speaking with CABARET PLAYER #3.'),
  ccue(59, 'preLevel', 'the_jester', 'You like that chair?'),
  ccue(59, 'preLevel', 'cabaret3', 'Very much.'),
  ccue(59, 'preLevel', 'the_jester', 'Wonderful. Stand up.'),
  ccue(59, 'preLevel', 'cabaret3', 'I knew this was coming.'),
  ccue(59, 'preLevel', null, 'CABARET PLAYER #3 stays seated for the hand but looks resigned. THE JESTER watches from directly behind.'),
  ccue(59, 'preLevel', 'the_jester', 'Last free observation: the PLAYER has stopped playing the room and started playing the table.'),
  ccue(59, 'preLevel', 'cabaret2', 'That sounds almost serious.'),
  ccue(59, 'preLevel', 'the_jester', 'Do not spread it around.'),
  ccue(59, 'preLevel', null, 'The PLAYER clears.'),
  ccue(59, 'postClear', null, 'CABARET PLAYER #3 stands and offers the chair.'),
  ccue(59, 'postClear', 'cabaret3', 'Try not to make me look bad.'),
  ccue(59, 'postClear', 'the_jester', 'No promises.'),

  // Level 60 — BOSS: The Jester
  ccue(60, 'bossIntro', null, 'THE JESTER drops into the open seat, spins once, stops perfectly aligned with the table and places both hands flat on the felt.'),
  ccue(60, 'bossIntro', 'the_jester', 'Finally. A serious game.'),
  ccue(60, 'bossIntro', null, 'A beat.'),
  ccue(60, 'bossIntro', 'the_jester', 'That was a joke. Please never make me say that again.'),
  ccue(60, 'bossIntro', 'player', 'You have been watching since I walked in.'),
  ccue(60, 'bossIntro', 'the_jester', 'I watch everybody. You were simply harder to distract.'),
  ccue(60, 'bossIntro', null, 'The boss match begins.'),
  // The screenplay gives two separate midpoint stingers (one for avoiding
  // a trap, one a random "strange fact") rather than alternatives to pick
  // between — unlike Level 50's case, nothing marks them as mutually
  // exclusive, so both play in sequence off the one bossMidpoint trigger.
  ccue(60, 'bossMidpoint', 'the_jester', 'There it is. You laughed with the game without laughing away the information.'),
  ccue(60, 'bossMidpoint', 'player', 'That sentence should not make sense.'),
  ccue(60, 'bossMidpoint', 'the_jester', 'The best ones rarely do on the first pass.'),
  ccue(60, 'bossMidpoint', 'the_jester', 'One last fact: an octopus has three hearts, sharks are older than trees, and somehow you are still the strangest thing at this table.'),
  ccue(60, 'bossMidpoint', 'player', 'That is not a fact.'),
  ccue(60, 'bossMidpoint', 'the_jester', 'Give history time.'),
  ccue(60, 'postFail', 'the_jester', 'Excellent! Catastrophic, but excellent. Again.', { pick: 'random' }),
  ccue(60, 'postFail', 'the_jester', 'You found a completely new way to be wrong. I respect the creativity. Deal again.', { pick: 'random' }),
  ccue(60, 'postFail', 'the_jester', 'That one hurt. Good. Pain is memorable. Next hand.', { pick: 'random' }),
  ccue(60, 'bossDefeat', null, 'The final score settles.'),
  ccue(60, 'bossDefeat', null, 'THE JESTER stares at the result for half a second, then throws his head back and laughs until the nearby tables join in.'),
  ccue(60, 'bossDefeat', 'the_jester', 'That was fun.'),
  ccue(60, 'bossDefeat', 'player', 'You lost.'),
  ccue(60, 'bossDefeat', 'the_jester', 'Yes. Still fun. People keep confusing those two things.'),
  ccue(60, 'chapterExit', null, 'He stands and offers the PLAYER a theatrical bow.'),
  ccue(60, 'chapterExit', 'the_jester', 'You are going upstairs.'),
  ccue(60, 'chapterExit', 'player', 'Who is there?'),
  ccue(60, 'chapterExit', 'the_jester', 'Everybody loves him.'),
  ccue(60, 'chapterExit', 'player', 'That sounds reassuring.'),
  ccue(60, 'chapterExit', 'the_jester', 'It should not.'),
  ccue(60, 'chapterExit', null, 'He points toward tall double doors where warm music can already be heard.'),
  ccue(60, 'chapterExit', 'the_jester', 'Laugh with him. Enjoy the stories. Just do not let the charm play your cards for you.'),
  ccue(60, 'chapterExit', 'the_jester', 'Play the table, not the smile.'),
  ccue(60, 'chapterExit', null, 'He opens the doors.'),

  // ── Chapter 7 — The Grand Ballroom, Boss: The Charmer ──
  // Same two staging-prefix strips as Chapter 6 ("From nearby:",
  // "Without looking over:") — kept out of the displayed line for the
  // same reason: they describe where/how he's speaking, not something
  // he'd say aloud.
  // Level 61 — Everyone Knows His Name
  ccue(61, 'preLevel', null, "The PLAYER enters to a completely different kind of noise: warm conversation instead of laughter. THE CHARMER stands near the bar, greeting a server by name, then a couple at a table, then a woman crossing the room."),
  ccue(61, 'preLevel', 'ballroom1', 'He remembers everybody.'),
  ccue(61, 'preLevel', 'ballroom2', 'Names, birthdays, dogs, children, favorite drink.'),
  ccue(61, 'preLevel', 'ballroom3', 'Do not ask me how.'),
  ccue(61, 'preLevel', null, "THE CHARMER looks across the room and meets the PLAYER's eyes."),
  ccue(61, 'preLevel', 'the_charmer', 'Welcome. I heard the Jester laughed for real.'),
  ccue(61, 'preLevel', 'player', 'Does news travel that fast?'),
  ccue(61, 'preLevel', 'the_charmer', 'Good news does.'),
  ccue(61, 'preLevel', null, 'He smiles and returns to his conversation. The PLAYER sits with three opponents.'),
  ccue(61, 'postClear', null, 'At the end of the hand, THE CHARMER raises his glass in quiet acknowledgment.'),

  // Level 62 — A Small Compliment
  ccue(62, 'preLevel', null, 'THE CHARMER passes the table just as the PLAYER chooses a restrained line.'),
  ccue(62, 'preLevel', 'the_charmer', 'Interesting style.'),
  ccue(62, 'preLevel', 'player', 'Good interesting or bad interesting?'),
  ccue(62, 'preLevel', 'the_charmer', 'If I told you, the compliment would become advice.'),
  ccue(62, 'preLevel', null, 'He keeps walking.'),
  ccue(62, 'preLevel', 'ballroom1', 'He does that.'),
  ccue(62, 'preLevel', 'player', 'What?'),
  ccue(62, 'preLevel', 'ballroom1', 'Leaves you feeling good and thinking too much.'),
  ccue(62, 'preLevel', null, 'The hand continues. The PLAYER clears.'),

  // Level 63 — He Remembers
  ccue(63, 'preLevel', null, 'Before the next hand, THE CHARMER approaches with a quiet smile.'),
  ccue(63, 'preLevel', 'the_charmer', 'You prefer watching the first few tricks before you commit, do you not?'),
  ccue(63, 'preLevel', 'player', 'You got that from two hands?'),
  ccue(63, 'preLevel', 'the_charmer', 'Three.'),
  ccue(63, 'preLevel', 'player', 'You counted.'),
  ccue(63, 'preLevel', 'the_charmer', 'I remember people. The cards are attached to them.'),
  ccue(63, 'preLevel', null, 'He turns to BALLROOM PLAYER #2.'),
  ccue(63, 'preLevel', 'the_charmer', 'How is Milo?'),
  ccue(63, 'preLevel', 'ballroom2', 'The dog? Better. Vet says the leg is fine.'),
  ccue(63, 'preLevel', 'the_charmer', 'Good. Tell him I asked.'),
  ccue(63, 'preLevel', null, 'He leaves before the PLAYER can ask another question.'),

  // Level 64 — The Geese
  ccue(64, 'preLevel', null, "THE CHARMER joins a conversation beside the PLAYER's table while the next hand is being dealt."),
  ccue(64, 'preLevel', 'the_charmer', 'Do you know why geese fly in a V?'),
  ccue(64, 'preLevel', 'ballroom3', 'Aerodynamics.'),
  ccue(64, 'preLevel', 'the_charmer', 'Exactly. The birds behind benefit from the air moved by the ones in front. When the leader tires, another takes the front.'),
  ccue(64, 'preLevel', 'player', 'Is this about cards?'),
  ccue(64, 'preLevel', 'the_charmer', 'Everything is about cards if you wait long enough.'),
  ccue(64, 'preLevel', null, 'During the hand, the PLAYER uses the pressure created by one opponent to avoid carrying the danger personally.'),
  ccue(64, 'preLevel', 'the_charmer', 'See? Let somebody else take the wind.'),

  // Level 65 — Comfort
  ccue(65, 'preLevel', null, 'THE CHARMER sits at the edge of a neighboring table, not playing, simply talking. The players around him loosen visibly.'),
  ccue(65, 'preLevel', 'ballroom1', 'That is his real trick.'),
  ccue(65, 'preLevel', 'player', 'What is?'),
  ccue(65, 'preLevel', 'ballroom1', 'Everybody relaxes.'),
  ccue(65, 'preLevel', 'ballroom2', 'Then everybody talks.'),
  ccue(65, 'preLevel', 'player', 'And gives things away.'),
  ccue(65, 'preLevel', 'the_charmer', 'Only if they were trying too hard to hide them.'),
  ccue(65, 'preLevel', null, 'The PLAYER smiles despite themself. The hand begins.'),

  // Level 66 — The Heron
  ccue(66, 'preLevel', null, 'The PLAYER reaches a difficult point and hesitates. THE CHARMER is standing near a tall window, watching birds at the garden fountain below.'),
  ccue(66, 'preLevel', 'the_charmer', 'Ever watch a heron hunt?'),
  ccue(66, 'preLevel', 'player', 'Not during a card game.'),
  ccue(66, 'preLevel', 'the_charmer', 'It can stand still for a very long time. Then one movement. Done.'),
  ccue(66, 'preLevel', 'player', 'You are telling me to wait.'),
  ccue(66, 'preLevel', 'the_charmer', 'I am talking about birds.'),
  ccue(66, 'preLevel', null, 'The PLAYER waits. The later opening is better.'),
  ccue(66, 'preLevel', 'ballroom3', 'He was telling you to wait.'),
  ccue(66, 'preLevel', 'the_charmer', 'I would never.'),

  // Level 67 — The Room Likes Him
  ccue(67, 'preLevel', null, 'THE CHARMER crosses the ballroom and seems to improve the mood everywhere he passes. A server laughs. Two tense players unclench. Someone calls him over from another table.'),
  ccue(67, 'preLevel', 'player', 'Do you ever get tired of people?'),
  ccue(67, 'preLevel', 'the_charmer', 'Never. People are the interesting part.'),
  ccue(67, 'preLevel', 'player', 'Not the game?'),
  ccue(67, 'preLevel', 'the_charmer', 'Cards repeat. People improvise.'),
  ccue(67, 'preLevel', null, "He looks at the PLAYER's three opponents in turn."),
  ccue(67, 'preLevel', 'the_charmer', 'One of you is already worried. One is pretending not to be. One is having a lovely evening.'),
  ccue(67, 'preLevel', 'ballroom2', 'Which am I?'),
  ccue(67, 'preLevel', 'the_charmer', 'You tell me.'),
  ccue(67, 'preLevel', null, 'He walks away. Nobody answers.'),

  // Level 68 — Trees Do Not Hurry
  ccue(68, 'preLevel', null, "THE CHARMER now stays within sight of the PLAYER's table for the whole hand."),
  ccue(68, 'preLevel', 'the_charmer', 'I like old trees.'),
  ccue(68, 'preLevel', 'player', 'Of course you do.'),
  ccue(68, 'preLevel', 'the_charmer', 'They never look rushed, but somehow they keep growing.'),
  ccue(68, 'preLevel', 'player', 'That one is definitely advice.'),
  ccue(68, 'preLevel', 'the_charmer', 'Maybe you are getting to know me.'),
  ccue(68, 'preLevel', null, 'The PLAYER refuses to rush a bad position and clears late.'),
  ccue(68, 'preLevel', 'the_charmer', 'Exactly.'),
  ccue(68, 'postClear', null, 'His smile is the same as before, but now the PLAYER notices how carefully he watches reactions after every comment.'),

  // Level 69 — The Smile Is Watching
  ccue(69, 'preLevel', null, 'THE CHARMER stands directly behind BALLROOM PLAYER #3. He chats casually while watching every card.'),
  ccue(69, 'preLevel', 'the_charmer', 'Beautiful room, is it not?'),
  ccue(69, 'preLevel', 'player', 'You are not looking at the room.'),
  ccue(69, 'preLevel', 'the_charmer', 'No.'),
  ccue(69, 'preLevel', 'player', 'You are looking at me.'),
  ccue(69, 'preLevel', 'the_charmer', 'Finally noticed.'),
  ccue(69, 'preLevel', null, 'BALLROOM PLAYER #3 sighs and begins gathering personal items before the hand is even over.'),
  ccue(69, 'preLevel', 'ballroom3', 'That means my chair, does it not?'),
  ccue(69, 'preLevel', 'the_charmer', 'Only if our guest clears.'),
  ccue(69, 'preLevel', null, 'The PLAYER clears.'),
  ccue(69, 'postClear', 'ballroom3', 'Of course.'),
  ccue(69, 'postClear', null, 'BALLROOM PLAYER #3 stands. THE CHARMER rests one hand on the empty chair.'),
  ccue(69, 'postClear', 'the_charmer', 'Shall we?'),

  // Level 70 — BOSS: The Charmer
  ccue(70, 'bossIntro', null, 'THE CHARMER sits. The music continues. Nothing about the room announces danger, which makes the table feel more dangerous.'),
  ccue(70, 'bossIntro', 'the_charmer', 'I am glad we finally get to play.'),
  ccue(70, 'bossIntro', 'player', 'You have been playing for ten levels.'),
  ccue(70, 'bossIntro', 'the_charmer', 'Good. The Jester did warn you.'),
  ccue(70, 'bossIntro', null, 'The cards are dealt.'),
  // Same call as Level 60 — two midpoint stingers, not alternatives, so
  // both play in sequence off the one bossMidpoint trigger.
  ccue(70, 'bossMidpoint', 'the_charmer', 'There. That little pause.'),
  ccue(70, 'bossMidpoint', 'player', 'What about it?'),
  ccue(70, 'bossMidpoint', 'the_charmer', 'Nothing. Unless you make the same pause again.'),
  ccue(70, 'bossMidpoint', 'the_charmer', 'Better. You changed the rhythm.'),
  ccue(70, 'bossMidpoint', 'player', 'You were reading me.'),
  ccue(70, 'bossMidpoint', 'the_charmer', 'I was enjoying the conversation.'),
  ccue(70, 'bossMidpoint', 'player', 'Same thing to you?'),
  ccue(70, 'bossMidpoint', 'the_charmer', 'Often.'),
  ccue(70, 'postFail', 'the_charmer', 'You played my expression instead of the table. Again.', { pick: 'random' }),
  ccue(70, 'postFail', 'the_charmer', 'You trusted the comfortable line. Comfort is not evidence.', { pick: 'random' }),
  ccue(70, 'postFail', 'the_charmer', 'Still smiling? Good. Deal again.', { pick: 'random' }),
  ccue(70, 'bossDefeat', null, 'The final score settles.'),
  ccue(70, 'bossDefeat', 'the_charmer', 'Well played.'),
  ccue(70, 'bossDefeat', 'player', 'No trick?'),
  ccue(70, 'bossDefeat', 'the_charmer', 'The trick was getting you to look for one.'),
  ccue(70, 'chapterExit', null, 'He stands and straightens the empty chair.'),
  ccue(70, 'chapterExit', 'the_charmer', 'Friendship opens doors.'),
  ccue(70, 'chapterExit', 'player', 'And the next one?'),
  ccue(70, 'chapterExit', 'the_charmer', 'He closes them.'),
  ccue(70, 'chapterExit', null, 'He gestures toward a heavy steel lift at the far end of the ballroom.'),
  ccue(70, 'chapterExit', 'the_charmer', 'The Vault. Do not expect warmth down there.'),
  ccue(70, 'chapterExit', 'player', 'What should I expect?'),
  ccue(70, 'chapterExit', 'the_charmer', 'A man who spent years knowing exactly when a deal was already done.'),
  ccue(70, 'chapterExit', null, 'The lift doors open with a metallic tone.'),
  ccue(70, 'chapterExit', 'the_charmer', 'He does not waste energy. Make sure you are worth his.'),

  // Chapter 8 — The Vault. Nothing follows "ON CLEAR" in the source for
  // most of these levels (just the SYSTEM/NOT SHOWN credit-counter note,
  // never turned into a cue — same skip as every earlier chapter), so
  // most levels here have no postClear bucket at all; only 75, 78 and 79
  // have a real line after the marker.
  ccue(71, 'preLevel', null, 'The lift descends. When the doors open, the music is gone. Steel walls. Dark stone. A row of illuminated credit totals behind thick glass.'),
  ccue(71, 'preLevel', 'vault1', 'First time down here?'),
  ccue(71, 'preLevel', 'player', 'Is it obvious?'),
  ccue(71, 'preLevel', 'vault2', 'You are looking around.'),
  ccue(71, 'preLevel', 'vault3', 'Regulars stop doing that.'),
  ccue(71, 'preLevel', null, 'At the far end of the room, THE CLOSER speaks quietly with a man in a dark coat. The man signs a paper. THE CLOSER does not celebrate.'),
  ccue(71, 'preLevel', 'vault1', 'He used to close deals for a living.'),
  ccue(71, 'preLevel', 'vault2', 'Still does, depending who you ask.'),
  ccue(71, 'preLevel', 'vault3', 'He can tell who will sign before they know.'),
  ccue(71, 'preLevel', null, 'The PLAYER sits. The hand begins.'),

  ccue(72, 'preLevel', null, 'THE CLOSER crosses the room, passes two active tables without looking, and stops at a third for exactly five seconds.'),
  ccue(72, 'preLevel', 'player', 'Why that table?'),
  ccue(72, 'preLevel', 'vault1', 'Because something changed.'),
  ccue(72, 'preLevel', 'player', 'What?'),
  ccue(72, 'preLevel', 'vault1', 'Ask him.'),
  // "Without turning:" is a stage direction glued to the line, not
  // something he says — stripped, same treatment as Cabaret's "From
  // across the room:"/"From somewhere unseen:" prefixes.
  ccue(72, 'preLevel', 'the_closer', 'You would not understand it yet.'),
  ccue(72, 'preLevel', null, 'He keeps walking.'),
  ccue(72, 'preLevel', 'vault2', 'That is about as friendly as he gets.'),
  ccue(72, 'preLevel', null, 'The PLAYER clears a hand by resisting a useless fight for control.'),
  ccue(72, 'preLevel', 'vault3', 'You let that go.'),
  ccue(72, 'preLevel', 'player', 'Was not worth the energy.'),
  ccue(72, 'preLevel', null, 'Across the room, THE CLOSER glances over once.'),

  ccue(73, 'preLevel', null, 'The PLAYER studies a difficult hand. THE CLOSER appears beside the table as if he has been there all along.'),
  ccue(73, 'preLevel', 'the_closer', 'You are protecting a weak position.'),
  ccue(73, 'preLevel', 'player', 'Which one?'),
  ccue(73, 'preLevel', 'the_closer', 'If I tell you, I am protecting it too.'),
  ccue(73, 'preLevel', null, 'He walks away.'),
  ccue(73, 'preLevel', 'vault2', 'He used to do that in meetings.'),
  ccue(73, 'preLevel', 'player', 'Insult people and leave?'),
  ccue(73, 'preLevel', 'vault2', 'Tell them exactly where the deal was dying. Then leave.'),
  ccue(73, 'preLevel', null, 'The PLAYER changes the plan and clears.'),

  ccue(74, 'preLevel', null, 'At a neighboring table, a nervous player is talking quickly to THE CLOSER.'),
  ccue(74, 'preLevel', 'nervous_player', 'I am still thinking about it.'),
  ccue(74, 'preLevel', 'the_closer', 'No, you are not.'),
  ccue(74, 'preLevel', 'nervous_player', 'Excuse me?'),
  ccue(74, 'preLevel', 'the_closer', 'You decided two minutes ago. Now you are looking for permission.'),
  ccue(74, 'preLevel', null, 'The nervous player goes quiet.'),
  ccue(74, 'preLevel', 'player', 'You do that with cards too?'),
  ccue(74, 'preLevel', 'the_closer', 'Cards are easier. They do not pretend to be undecided.'),
  ccue(74, 'preLevel', null, 'He leaves. The PLAYER watches the table more carefully than the cards alone.'),

  ccue(75, 'preLevel', null, 'THE CLOSER stands behind the PLAYER for one trick, then speaks.'),
  ccue(75, 'preLevel', 'the_closer', 'People show you their decision by where their attention goes.'),
  ccue(75, 'preLevel', 'player', 'And mine?'),
  ccue(75, 'preLevel', 'the_closer', 'Still divided.'),
  ccue(75, 'preLevel', 'player', 'Between what?'),
  ccue(75, 'preLevel', 'the_closer', 'Winning the hand and avoiding the mistake.'),
  ccue(75, 'preLevel', 'player', 'Those are different?'),
  ccue(75, 'preLevel', 'the_closer', 'Very.'),
  ccue(75, 'preLevel', null, 'The PLAYER commits to the better line instead of merely avoiding danger.'),
  ccue(75, 'postClear', 'the_closer', 'Better.'),

  ccue(76, 'preLevel', null, 'A VAULT PLAYER loses a painful trick and immediately becomes aggressive.'),
  ccue(76, 'preLevel', 'vault3', 'I am getting that back.'),
  ccue(76, 'preLevel', 'the_closer', 'No.'),
  ccue(76, 'preLevel', 'vault3', 'No?'),
  ccue(76, 'preLevel', 'the_closer', 'You are about to spend three tricks recovering one feeling.'),
  ccue(76, 'preLevel', null, 'The table falls silent.'),
  ccue(76, 'preLevel', 'player', 'You never chase?'),
  ccue(76, 'preLevel', 'the_closer', 'I chase outcomes. Not pride.'),
  ccue(76, 'preLevel', null, 'The PLAYER clears by letting a previous loss remain irrelevant.'),

  ccue(77, 'preLevel', null, 'THE CLOSER watches the three opponents before looking at the PLAYER.'),
  ccue(77, 'preLevel', 'the_closer', 'In sales, the first mistake is trying to close everyone.'),
  ccue(77, 'preLevel', 'player', 'And the second?'),
  ccue(77, 'preLevel', 'the_closer', 'Spending equal energy on unequal chances.'),
  ccue(77, 'preLevel', 'vault1', 'He is going to turn this into a lecture.'),
  ccue(77, 'preLevel', 'the_closer', 'No. Lectures are poor conversion tools.'),
  ccue(77, 'preLevel', null, 'He gestures toward the table.'),
  ccue(77, 'preLevel', 'the_closer', 'Know where pressure can move something. Ignore the rest.'),
  ccue(77, 'preLevel', null, 'The PLAYER uses that principle to choose which opponent to pressure and clears.'),

  ccue(78, 'preLevel', null, "For the first time, THE CLOSER remains beside the PLAYER's table from the deal to the final card."),
  ccue(78, 'preLevel', 'vault2', 'That is new.'),
  ccue(78, 'preLevel', 'player', 'He is watching.'),
  ccue(78, 'preLevel', 'the_closer', 'Obviously.'),
  ccue(78, 'preLevel', null, 'The hand develops badly. The PLAYER hesitates, then commits to a difficult but coherent line.'),
  ccue(78, 'preLevel', 'the_closer', 'There.'),
  ccue(78, 'preLevel', 'player', 'What?'),
  ccue(78, 'preLevel', 'the_closer', 'You decided.'),
  ccue(78, 'postClear', null, 'He does not praise the result. He simply stays for the next table assignment.'),

  ccue(79, 'preLevel', null, 'The three VAULT PLAYERS take their seats. THE CLOSER stands behind VAULT PLAYER #3.'),
  ccue(79, 'preLevel', 'the_closer', 'One more.'),
  ccue(79, 'preLevel', 'player', 'Then you sit?'),
  ccue(79, 'preLevel', 'the_closer', 'If you give me a reason.'),
  ccue(79, 'preLevel', null, 'The hand begins. The PLAYER has an opening to play defensively but instead chooses the line that best controls the final outcome.'),
  ccue(79, 'preLevel', 'vault1', 'That was committed.'),
  ccue(79, 'preLevel', 'the_closer', 'Yes.'),
  ccue(79, 'preLevel', null, 'The PLAYER clears.'),
  ccue(79, 'postClear', 'the_closer', 'All right.'),
  ccue(79, 'postClear', 'vault3', 'That means me.'),
  ccue(79, 'postClear', 'the_closer', 'It does.'),
  ccue(79, 'postClear', null, 'VAULT PLAYER #3 stands. THE CLOSER takes the chair without another word.'),

  ccue(80, 'bossIntro', null, 'The steel doors seal. THE CLOSER sits opposite the PLAYER. No music. No audience noise. Only cards and the soft click of the credit display.'),
  ccue(80, 'bossIntro', 'the_closer', 'I spent years closing deals.'),
  ccue(80, 'bossIntro', 'player', 'I heard.'),
  ccue(80, 'bossIntro', 'the_closer', 'Most people think closing means convincing someone.'),
  ccue(80, 'bossIntro', 'player', 'It does not?'),
  ccue(80, 'bossIntro', 'the_closer', 'It means recognizing when they have already decided - and not ruining it.'),
  ccue(80, 'bossIntro', null, 'The boss match begins.'),
  // Two stinger blocks fire in sequence off the one trigger, same pattern
  // as Level 70's and Level 60's combined bossMidpoint blocks — nothing
  // marks them mutually exclusive.
  ccue(80, 'bossMidpoint', 'the_closer', 'You are hesitating.'),
  ccue(80, 'bossMidpoint', 'player', 'I am thinking.'),
  ccue(80, 'bossMidpoint', 'the_closer', 'No. Thinking looks forward. Hesitation looks backward.'),
  ccue(80, 'bossMidpoint', 'the_closer', 'Now you are playing not to lose.'),
  ccue(80, 'bossMidpoint', 'player', 'Is that wrong?'),
  ccue(80, 'bossMidpoint', 'the_closer', 'Only if winning requires a decision.'),
  ccue(80, 'postFail', 'the_closer', 'You knew the right line and did not close it. Again.', { pick: 'random' }),
  ccue(80, 'postFail', 'the_closer', 'Too much energy after the decision point. Reset.', { pick: 'random' }),
  ccue(80, 'postFail', 'the_closer', 'That hand was over before you admitted it. Deal again.', { pick: 'random' }),
  ccue(80, 'bossDefeat', null, 'The final score locks in.'),
  ccue(80, 'bossDefeat', null, 'THE CLOSER looks at the total, then at the PLAYER.'),
  ccue(80, 'bossDefeat', 'the_closer', 'Closed.'),
  ccue(80, 'bossDefeat', 'player', 'That is it?'),
  ccue(80, 'bossDefeat', 'the_closer', 'That is the point.'),
  ccue(80, 'bossDefeat', 'the_closer', 'You earned those.'),
  ccue(80, 'chapterExit', 'player', 'Where is the next door?'),
  ccue(80, 'chapterExit', null, 'THE CLOSER looks toward the lift the PLAYER used to enter.'),
  ccue(80, 'chapterExit', 'the_closer', 'Behind you.'),
  ccue(80, 'chapterExit', 'player', 'I go back?'),
  ccue(80, 'chapterExit', 'the_closer', 'The Vault is not a destination. It is where people store what they already won.'),
  ccue(80, 'chapterExit', null, 'The lift opens.'),
  ccue(80, 'chapterExit', 'the_closer', 'Go back upstairs.'),
  ccue(80, 'chapterExit', 'player', 'And then?'),
  ccue(80, 'chapterExit', 'the_closer', 'Someone has been waiting longer than you know.'),

  // Chapter 9 — The Countess's Antechamber. Same "nothing after ON
  // CLEAR → no postClear bucket" rule as Chapter 8; only 81, 85, 88 and
  // 89 have real content after the marker.
  ccue(81, 'preLevel', null, 'The lift opens. The PLAYER steps out, expecting the Grand Ballroom corridor. Before the public doors can open, a calm voice comes from the shadow beside them.'),
  ccue(81, 'preLevel', 'the_countess', 'Do not go back in yet.'),
  ccue(81, 'preLevel', null, 'THE COUNTESS steps into the light. Elegant, composed, impossible to place by age. She does not introduce herself.'),
  ccue(81, 'preLevel', 'player', 'Who are you?'),
  ccue(81, 'preLevel', 'the_countess', 'I have been following you since the moment you entered this casino.'),
  ccue(81, 'preLevel', 'player', 'That is not an answer.'),
  ccue(81, 'preLevel', 'the_countess', 'No. It is a reason to come with me.'),
  ccue(81, 'preLevel', null, 'She opens a narrow door the PLAYER never noticed. Beyond it: a private salon and a four-seat table.'),
  ccue(81, 'preLevel', 'the_countess', 'Come.'),
  ccue(81, 'preLevel', null, 'Three private players are waiting. THE COUNTESS remains standing as the PLAYER sits.'),
  ccue(81, 'postClear', null, 'She watches the entire hand without blinking at the wrong moments.'),

  ccue(82, 'preLevel', null, 'The next table is set in the same private salon. THE COUNTESS stands beside a black curtain embroidered with a single silver spade.'),
  ccue(82, 'preLevel', 'the_countess', 'Do you know who you are chasing?'),
  ccue(82, 'preLevel', 'player', 'The next boss?'),
  ccue(82, 'preLevel', 'the_countess', 'No.'),
  ccue(82, 'preLevel', 'player', 'Dame de Pique?'),
  ccue(82, 'preLevel', 'the_countess', 'That is a name. I asked if you know who.'),
  ccue(82, 'preLevel', 'player', 'Then no.'),
  ccue(82, 'preLevel', 'the_countess', 'Good. Certainty would be more dangerous at this point.'),
  ccue(82, 'preLevel', null, 'The hand begins.'),
  ccue(82, 'postClear', 'private1', 'She does that.'),
  ccue(82, 'postClear', 'player', 'Answers questions with more questions?'),
  ccue(82, 'postClear', 'private1', 'Usually worse ones.'),

  ccue(83, 'preLevel', null, 'THE COUNTESS places a fresh deck on the table before the dealer can.'),
  ccue(83, 'preLevel', 'the_countess', 'I know when people cheat.'),
  ccue(83, 'preLevel', 'player', 'Are you accusing me?'),
  ccue(83, 'preLevel', 'the_countess', 'No.'),
  ccue(83, 'preLevel', 'player', 'Then why say it?'),
  ccue(83, 'preLevel', 'the_countess', 'Because if you were cheating, you would now be wondering how I knew.'),
  ccue(83, 'preLevel', 'player', 'And if I am not?'),
  ccue(83, 'preLevel', 'the_countess', 'You wonder why I said it.'),
  ccue(83, 'preLevel', null, 'She gives the faintest smile.'),
  ccue(83, 'preLevel', 'the_countess', 'Both reactions tell me something.'),
  ccue(83, 'preLevel', null, 'The hand begins. The PLAYER clears cleanly.'),

  ccue(84, 'preLevel', null, 'A portrait hangs in the antechamber: a woman in black, face turned away, a spade worked into the frame.'),
  ccue(84, 'preLevel', 'player', 'Is that her?'),
  ccue(84, 'preLevel', 'the_countess', 'Perhaps.'),
  ccue(84, 'preLevel', 'player', 'You do not know?'),
  ccue(84, 'preLevel', 'the_countess', 'I did not say that.'),
  ccue(84, 'preLevel', 'player', 'What do people say?'),
  ccue(84, 'preLevel', 'the_countess', 'That there is someone above the rooms. Someone who knows the games, the players, the houses.'),
  ccue(84, 'preLevel', 'player', 'Controls them?'),
  ccue(84, 'preLevel', 'the_countess', 'Rumors prefer dramatic verbs.'),
  ccue(84, 'preLevel', null, 'She turns away from the portrait.'),
  ccue(84, 'preLevel', 'the_countess', 'Play.'),

  ccue(85, 'preLevel', null, 'The PLAYER looks again at the silver-spade curtain. No one has passed through it.'),
  ccue(85, 'preLevel', 'player', 'Why has nobody told me about this room?'),
  ccue(85, 'preLevel', 'the_countess', 'Because almost nobody sees it.'),
  ccue(85, 'preLevel', 'player', 'Why me?'),
  ccue(85, 'preLevel', 'the_countess', 'Because you kept climbing when the rooms changed around you.'),
  ccue(85, 'preLevel', 'player', 'That cannot be enough.'),
  ccue(85, 'preLevel', 'the_countess', 'It is not.'),
  ccue(85, 'preLevel', 'player', 'Then what else?'),
  ccue(85, 'preLevel', 'the_countess', 'Win this hand first.'),
  ccue(85, 'preLevel', null, 'The PLAYER does.'),
  ccue(85, 'postClear', 'the_countess', 'Still curious. Good.'),

  ccue(86, 'preLevel', null, 'THE COUNTESS walks the PLAYER past a narrow gallery of locked doors, each marked only with a subtle suit symbol worked into the metal.'),
  ccue(86, 'preLevel', 'player', 'Spades.'),
  ccue(86, 'preLevel', 'the_countess', 'Here, yes.'),
  ccue(86, 'preLevel', 'player', 'And the others?'),
  ccue(86, 'preLevel', 'the_countess', 'Every great casino has rooms nobody advertises.'),
  ccue(86, 'preLevel', 'player', 'Throne rooms?'),
  ccue(86, 'preLevel', 'the_countess', 'That is what some insiders call them.'),
  ccue(86, 'preLevel', 'player', 'Who sits in them?'),
  ccue(86, 'preLevel', 'the_countess', "You are asking tomorrow's question during tonight's hand."),
  ccue(86, 'preLevel', null, 'She returns the PLAYER to the table.'),

  ccue(87, 'preLevel', null, 'The private players speak more quietly than before. THE COUNTESS watches from beside the curtain.'),
  ccue(87, 'preLevel', 'private2', 'You really did not know?'),
  ccue(87, 'preLevel', 'player', 'Know what?'),
  ccue(87, 'preLevel', 'private2', 'Who people whisper about at the top.'),
  ccue(87, 'preLevel', 'the_countess', 'Enough.'),
  ccue(87, 'preLevel', null, 'The room goes silent immediately.'),
  ccue(87, 'preLevel', 'player', 'Dame de Pique.'),
  ccue(87, 'preLevel', 'the_countess', 'You have heard a name now. Do not mistake that for understanding it.'),
  ccue(87, 'preLevel', 'player', 'Is she real?'),
  ccue(87, 'preLevel', 'the_countess', 'Play the hand.'),
  ccue(87, 'preLevel', null, 'The PLAYER clears, but the question remains unanswered.'),

  ccue(88, 'preLevel', null, 'For the first time, THE COUNTESS stands directly behind the PLAYER for the full hand.'),
  ccue(88, 'preLevel', null, 'The silver-spade curtain behind her moves slightly, although there is no visible draft.'),
  ccue(88, 'preLevel', 'player', 'What is behind that?'),
  ccue(88, 'preLevel', 'the_countess', 'A door.'),
  ccue(88, 'preLevel', 'player', 'You know what I mean.'),
  ccue(88, 'preLevel', 'the_countess', 'Yes.'),
  ccue(88, 'preLevel', 'player', 'And?'),
  ccue(88, 'preLevel', 'the_countess', 'You are not there yet.'),
  ccue(88, 'preLevel', null, 'The PLAYER clears.'),
  ccue(88, 'postClear', 'the_countess', 'Closer.'),

  ccue(89, 'preLevel', null, 'The Countess is already seated in the room when the PLAYER arrives, but not at the game table. She watches from a high-backed chair beside the curtain.'),
  ccue(89, 'preLevel', 'the_countess', 'One more table before mine.'),
  ccue(89, 'preLevel', 'player', 'And if I win yours?'),
  ccue(89, 'preLevel', 'the_countess', 'Then I open the curtain.'),
  ccue(89, 'preLevel', 'player', 'And I meet Dame de Pique?'),
  ccue(89, 'preLevel', 'the_countess', 'You meet what is waiting behind it.'),
  ccue(89, 'preLevel', null, 'The PLAYER looks at the three private opponents. PRIVATE PLAYER #3 slowly stands after the deal is completed.'),
  ccue(89, 'preLevel', 'private3', 'I suppose that will be my chair next.'),
  ccue(89, 'preLevel', 'the_countess', 'If the PLAYER clears.'),
  ccue(89, 'preLevel', null, 'The PLAYER clears.'),
  ccue(89, 'postClear', null, 'PRIVATE PLAYER #3 stands. THE COUNTESS rises from her chair and crosses to the table.'),

  ccue(90, 'bossIntro', null, 'THE COUNTESS takes the open seat. Behind her, the silver-spade curtain remains closed.'),
  ccue(90, 'bossIntro', 'the_countess', 'Before we begin, one last question.'),
  ccue(90, 'bossIntro', 'player', 'Go on.'),
  ccue(90, 'bossIntro', 'the_countess', 'If the truth is stranger than the rumor, do you still want it?'),
  ccue(90, 'bossIntro', 'player', 'Yes.'),
  ccue(90, 'bossIntro', 'the_countess', 'Good. I would have known if that answer was false.'),
  ccue(90, 'bossIntro', null, 'The boss match begins.'),
  // Two stinger blocks fire in sequence off the one trigger, same
  // pattern as every earlier boss level's combined midpoint.
  ccue(90, 'bossMidpoint', 'the_countess', 'You are not cheating.'),
  ccue(90, 'bossMidpoint', 'player', 'I told you that.'),
  ccue(90, 'bossMidpoint', 'the_countess', 'You told me nothing. Your play did.'),
  ccue(90, 'bossMidpoint', 'the_countess', 'You have spent ninety levels learning people.'),
  ccue(90, 'bossMidpoint', 'player', 'And now?'),
  ccue(90, 'bossMidpoint', 'the_countess', 'Now you meet a problem that may not be one person.'),
  ccue(90, 'postFail', 'the_countess', 'Not yet. Curiosity is not qualification. Again.', { pick: 'random' }),
  ccue(90, 'postFail', 'the_countess', 'You looked beyond the table too soon. Deal again.', { pick: 'random' }),
  ccue(90, 'postFail', 'the_countess', 'The door stays closed until the game says otherwise.', { pick: 'random' }),
  ccue(90, 'bossDefeat', null, 'The final score settles.'),
  ccue(90, 'bossDefeat', null, 'THE COUNTESS stands. For the first time, she looks almost pleased.'),
  ccue(90, 'bossDefeat', 'the_countess', 'All right.'),
  ccue(90, 'bossDefeat', 'player', 'The curtain?'),
  ccue(90, 'bossDefeat', 'the_countess', 'The curtain.'),
  ccue(90, 'chapterExit', null, 'She pulls it aside. Behind it are enormous black doors traced with silver spades. No handle is visible.'),
  ccue(90, 'chapterExit', 'player', 'You said almost nobody sees this.'),
  ccue(90, 'chapterExit', 'the_countess', 'That remains true.'),
  ccue(90, 'chapterExit', null, 'THE COUNTESS presses one gloved hand to the center spade. The doors unlock from within with a deep mechanical sound.'),
  ccue(90, 'chapterExit', 'the_countess', 'Do not waste your first question asking which one is real.'),
  ccue(90, 'chapterExit', 'player', 'Which one?'),
  ccue(90, 'chapterExit', null, 'THE COUNTESS looks at the opening doors.'),
  ccue(90, 'chapterExit', 'the_countess', 'Exactly.'),

  // Chapter 10 — The Hidden Throne Room. Same "nothing after ON CLEAR →
  // no postClear bucket" rule as every chapter since 8; only 91-99 (all
  // of them, for once) have a real line after the marker, since the
  // screenplay closes almost every hand here with a lingering unease
  // beat. Level 100's ending is delivered as plain sequential dialogue/
  // narration cues in bossDefeat/chapterExit — no dedicated cinematic
  // overlay was built for it (a deliberate scope call, not an
  // oversight: see CLAUDE.md's own note on this chapter).
  ccue(91, 'preLevel', null, 'The black doors open. The PLAYER stops.'),
  ccue(91, 'preLevel', null, 'At a four-seat table beneath the distant throne sit THREE IDENTICAL WOMEN. Each wears the same black gown, the same silver crown and the same spade pendant. Their posture is identical. Their expressions are identical.'),
  ccue(91, 'preLevel', 'player', 'Which one of you is Dame de Pique?'),
  ccue(91, 'preLevel', null, 'The three women look at one another, then back at the PLAYER.'),
  ccue(91, 'preLevel', 'dame1', 'Why do you assume there is only one?'),
  ccue(91, 'preLevel', 'player', 'Because there is only one name.'),
  ccue(91, 'preLevel', 'dame2', 'Names are convenient.'),
  ccue(91, 'preLevel', 'dame3', 'Reality is less considerate.'),
  ccue(91, 'preLevel', null, 'The PLAYER sits. The three women begin the hand without introducing themselves.'),
  ccue(91, 'postClear', null, 'After the final card, all three rise at exactly the same moment, exchange seats and sit again.'),
  ccue(91, 'postClear', 'player', 'You changed places.'),
  ccue(91, 'postClear', 'dame1', 'Did we?'),

  ccue(92, 'preLevel', null, 'The PLAYER studies their hands before the deal. WOMAN TWO appears to wear a thin black ring on her right hand.'),
  ccue(92, 'preLevel', 'player', 'There. The ring.'),
  ccue(92, 'preLevel', 'dame2', 'What about it?'),
  ccue(92, 'preLevel', 'player', 'You did not all have one yesterday.'),
  ccue(92, 'preLevel', 'dame3', 'Are you certain?'),
  ccue(92, 'preLevel', null, 'The cards are dealt. Halfway through the hand, the PLAYER looks up. Now WOMAN ONE wears the ring. WOMAN TWO does not.'),
  ccue(92, 'preLevel', 'player', 'You moved it.'),
  ccue(92, 'preLevel', 'dame1', 'Or you moved the memory.'),
  ccue(92, 'preLevel', 'dame2', 'Which is easier to prove?'),
  ccue(92, 'postClear', null, 'The PLAYER looks back at the ring. All three women are wearing one.'),

  ccue(93, 'preLevel', null, 'The three women enter from different doors but reach their chairs at the same time.'),
  ccue(93, 'preLevel', 'player', 'Are you sisters?'),
  ccue(93, 'preLevel', 'dame3', 'Would that explain us?'),
  ccue(93, 'preLevel', 'player', 'It would explain the faces.'),
  ccue(93, 'preLevel', 'dame1', 'And create a family.'),
  ccue(93, 'preLevel', 'dame2', 'Which gives you more people to investigate.'),
  ccue(93, 'preLevel', 'player', 'So yes?'),
  ccue(93, 'preLevel', 'dame3', 'You wanted one answer.'),
  ccue(93, 'preLevel', 'dame1', 'Now you have two questions.'),
  ccue(93, 'preLevel', null, 'The hand begins.'),
  ccue(93, 'postClear', null, "When the women stand, the PLAYER notices their footsteps sound identical on the marble."),

  ccue(94, 'preLevel', null, 'The PLAYER looks beyond the table to the throne.'),
  ccue(94, 'preLevel', 'player', 'Who built this place?'),
  ccue(94, 'preLevel', 'dame1', 'Wrong question.'),
  ccue(94, 'preLevel', 'player', 'What is the right question?'),
  ccue(94, 'preLevel', 'dame2', 'Why was it built?'),
  ccue(94, 'preLevel', 'player', 'Why was it built?'),
  ccue(94, 'preLevel', 'dame3', 'Better.'),
  ccue(94, 'preLevel', 'player', 'For you?'),
  ccue(94, 'preLevel', 'dame1', 'Warmer.'),
  ccue(94, 'preLevel', 'player', 'For what, then?'),
  ccue(94, 'preLevel', 'dame2', 'Play.'),
  ccue(94, 'preLevel', null, 'The women deal. No answer follows.'),
  ccue(94, 'postClear', null, 'After the clear, the lights above the throne brighten by one degree, revealing older suit symbols carved beneath the spades.'),

  ccue(95, 'preLevel', null, 'The PLAYER sits without waiting for an invitation.'),
  ccue(95, 'preLevel', 'player', 'People say someone here controls card games far beyond this casino.'),
  ccue(95, 'preLevel', 'dame2', 'People say many things after losing.'),
  ccue(95, 'preLevel', 'player', 'Do you?'),
  ccue(95, 'preLevel', 'dame3', 'Would you play differently if we said yes?'),
  ccue(95, 'preLevel', 'player', 'Maybe.'),
  ccue(95, 'preLevel', 'dame1', 'Then you would be playing the rumor.'),
  ccue(95, 'preLevel', 'dame2', 'Not the cards.'),
  ccue(95, 'preLevel', 'player', 'That sounds like something the Jester told me.'),
  ccue(95, 'preLevel', 'dame3', 'He tells the truth more often than people notice.'),
  ccue(95, 'preLevel', null, 'The hand begins.'),
  ccue(95, 'postClear', 'player', 'You know him.'),
  ccue(95, 'postClear', 'dame1', 'Another question.'),

  ccue(96, 'preLevel', null, 'The PLAYER watches the three women take their seats.'),
  ccue(96, 'preLevel', 'player', 'Why was I invited?'),
  ccue(96, 'preLevel', 'dame1', 'You accepted.'),
  ccue(96, 'preLevel', 'player', 'That is not what I asked.'),
  ccue(96, 'preLevel', 'dame2', 'Many are invited to something.'),
  ccue(96, 'preLevel', 'dame3', 'Few keep going when the invitation stops explaining itself.'),
  ccue(96, 'preLevel', 'player', 'So I am here because I kept climbing?'),
  ccue(96, 'preLevel', 'dame1', 'Partly.'),
  ccue(96, 'preLevel', 'player', 'What is the other part?'),
  ccue(96, 'preLevel', 'dame2', 'If we told you, would you trust the answer?'),
  ccue(96, 'preLevel', null, 'The PLAYER has no reply. The cards are dealt.'),
  ccue(96, 'postClear', null, 'For the first time, one of the women smiles slightly - but the PLAYER cannot tell which one a second later.'),

  ccue(97, 'preLevel', null, 'The PLAYER arrives early and marks details mentally: a tiny fold in one sleeve, the angle of one crown, a faint beauty mark near one eye.'),
  ccue(97, 'preLevel', 'player', 'I can tell you apart now.'),
  ccue(97, 'preLevel', 'dame3', 'Can you?'),
  ccue(97, 'preLevel', null, 'The hand starts. After two tricks, the sleeve fold is on WOMAN ONE. The crown angle belongs to WOMAN TWO. The beauty mark appears on WOMAN THREE - then is gone when the PLAYER looks back.'),
  ccue(97, 'preLevel', 'player', 'That is impossible.'),
  ccue(97, 'preLevel', 'dame2', 'Memory is easier to influence than eyesight.'),
  ccue(97, 'preLevel', 'dame1', 'Eyesight is easier to influence than certainty.'),
  ccue(97, 'preLevel', 'player', 'Which one are you influencing?'),
  ccue(97, 'preLevel', 'dame3', 'Yes.'),
  ccue(97, 'postClear', null, 'The PLAYER does not smile.'),

  ccue(98, 'preLevel', null, 'The three women sit. This time they do not wait for the PLAYER to ask anything.'),
  ccue(98, 'preLevel', 'dame1', 'You are still trying-'),
  ccue(98, 'preLevel', 'dame2', '-to decide which of us-'),
  ccue(98, 'preLevel', 'dame3', '-is the real one.'),
  ccue(98, 'preLevel', 'player', 'Are you?'),
  ccue(98, 'preLevel', 'dame1', 'Real-'),
  ccue(98, 'preLevel', 'dame2', '-is a useful word-'),
  ccue(98, 'preLevel', 'dame3', '-for people who need one answer.'),
  ccue(98, 'preLevel', 'player', 'And if there is no one answer?'),
  ccue(98, 'preLevel', 'dame2', 'Then perhaps you finally have the right question.'),
  ccue(98, 'preLevel', null, "The hand begins. They continue finishing one another's observations as if sharing a single thought."),
  ccue(98, 'postClear', null, 'At the end, all three look toward the throne at the same time. The PLAYER follows their gaze, but the throne is empty.'),

  ccue(99, 'preLevel', null, 'The PLAYER enters and sits without studying the women.'),
  ccue(99, 'preLevel', 'dame1', 'No ring?'),
  ccue(99, 'preLevel', 'dame2', 'No crown?'),
  ccue(99, 'preLevel', 'dame3', 'No search for a mark?'),
  ccue(99, 'preLevel', 'player', 'No.'),
  ccue(99, 'preLevel', 'dame1', 'Why?'),
  ccue(99, 'preLevel', 'player', 'Because it changes nothing about the hand.'),
  ccue(99, 'preLevel', null, 'For the first time, all three women smile at exactly the same moment.'),
  ccue(99, 'preLevel', 'dame2', 'Finally.'),
  ccue(99, 'preLevel', 'dame3', 'You stopped looking at faces.'),
  ccue(99, 'preLevel', 'dame1', 'You started playing the table.'),
  ccue(99, 'preLevel', null, 'The hand is the quietest of the entire campaign. No riddles during play. No distractions. The PLAYER clears.'),
  ccue(99, 'postClear', null, 'The three women remain seated.'),
  ccue(99, 'postClear', 'dame1', 'One table remains.'),
  ccue(99, 'postClear', 'dame2', 'One result.'),
  ccue(99, 'postClear', 'dame3', 'As many answers as you can carry.'),
  ccue(99, 'postClear', null, 'The throne behind them illuminates fully. The silver spades along the floor form a path to the final table.'),

  ccue(100, 'bossIntro', null, 'The PLAYER walks the silver-spade path and takes the fourth seat. The same three women sit opposite. The throne remains behind them, empty.'),
  ccue(100, 'bossIntro', 'player', 'Before we start: are any of you actually Dame de Pique?'),
  ccue(100, 'bossIntro', 'dame1', 'You are still asking.'),
  ccue(100, 'bossIntro', 'dame2', 'But now you know-'),
  ccue(100, 'bossIntro', 'dame3', '-the answer will not help you.'),
  ccue(100, 'bossIntro', 'player', 'Maybe I just want to hear it.'),
  ccue(100, 'bossIntro', 'dame1', 'Then earn the disappointment.'),
  ccue(100, 'bossIntro', null, 'The final boss match begins.'),
  // Two stinger blocks fire in sequence off the one trigger, same
  // pattern as every earlier boss level. The first name-checks all nine
  // earlier bosses in one breath — every id it references already
  // exists, cross-checked before shipping.
  ccue(100, 'bossMidpoint', 'dame2', 'The Baron noticed restraint.'),
  ccue(100, 'bossMidpoint', 'dame3', 'The Sharp noticed discipline.'),
  ccue(100, 'bossMidpoint', 'dame1', 'The Scholar noticed memory.'),
  ccue(100, 'bossMidpoint', 'dame2', 'The Wildcard noticed adaptation.'),
  ccue(100, 'bossMidpoint', 'dame3', 'The Optimist noticed recovery.'),
  ccue(100, 'bossMidpoint', 'dame1', 'The Jester noticed perspective.'),
  ccue(100, 'bossMidpoint', 'dame2', 'The Charmer noticed people.'),
  ccue(100, 'bossMidpoint', 'dame3', 'The Closer noticed commitment.'),
  ccue(100, 'bossMidpoint', 'dame1', 'The Countess noticed honesty.'),
  ccue(100, 'bossMidpoint', 'player', 'And what do you notice?'),
  ccue(100, 'bossMidpoint', 'the_three_women', 'Whether you needed us to be one person.'),
  ccue(100, 'bossMidpoint', 'player', 'If I win, do I get the truth?'),
  ccue(100, 'bossMidpoint', 'dame1', 'You get an ending.'),
  ccue(100, 'bossMidpoint', 'dame2', 'Truth is more expensive.'),
  ccue(100, 'bossMidpoint', 'dame3', 'And usually sold in another room.'),
  ccue(100, 'postFail', 'dame1', 'You looked for certainty and missed the table. Again.', { pick: 'random' }),
  ccue(100, 'postFail', 'dame2', 'The rumor distracted you. Deal again.', { pick: 'random' }),
  ccue(100, 'postFail', 'dame3', 'You climbed one hundred levels. Do not become impatient at the last chair.', { pick: 'random' }),
  // The immediate table-side reaction to the win — same boundary rule
  // as every earlier boss's bossDefeat/chapterExit split (see Level
  // 70/80/90's own notes): everything up to and including the vanish
  // itself stays bossDefeat, since it's still the direct consequence of
  // the result just posted; the transition to what's next (the
  // Countess, the empty casino, the exterior tease) is chapterExit.
  ccue(100, 'bossDefeat', null, 'The last card lands. Silence.'),
  ccue(100, 'bossDefeat', null, 'The final score settles.'),
  ccue(100, 'bossDefeat', null, 'The three women look at the result. Then all three stand.'),
  ccue(100, 'bossDefeat', 'dame1', 'Better.'),
  ccue(100, 'bossDefeat', 'dame2', 'Much better.'),
  ccue(100, 'bossDefeat', 'dame3', 'You finally stopped asking which of us mattered.'),
  ccue(100, 'bossDefeat', 'player', 'So which one is-'),
  ccue(100, 'bossDefeat', null, 'A single playing card slips from somewhere high above and strikes the marble floor with a sharp crack.'),
  ccue(100, 'bossDefeat', null, 'The PLAYER looks down for less than a second.'),
  ccue(100, 'bossDefeat', null, 'When the PLAYER looks up, only ONE WOMAN remains.'),
  ccue(100, 'bossDefeat', null, 'The other two chairs are empty. No footsteps. No doors moving. Nothing.'),
  ccue(100, 'chapterExit', 'player', 'What-'),
  ccue(100, 'chapterExit', 'the_remaining_woman', 'You were doing so well without the question.'),
  ccue(100, 'chapterExit', 'player', 'Are you Dame de Pique?'),
  ccue(100, 'chapterExit', null, 'She walks slowly toward the throne.'),
  ccue(100, 'chapterExit', 'the_remaining_woman', 'Do you think a name can control every table in every city?'),
  ccue(100, 'chapterExit', 'player', 'People say you do.'),
  ccue(100, 'chapterExit', 'the_remaining_woman', 'People need someone to blame when chance feels organized.'),
  ccue(100, 'chapterExit', 'player', 'That is not a denial.'),
  ccue(100, 'chapterExit', 'the_remaining_woman', 'Good.'),
  ccue(100, 'chapterExit', null, 'She reaches the throne, turns and produces a QUEEN OF SPADES card between two fingers.'),
  ccue(100, 'chapterExit', 'the_remaining_woman', 'Keep asking better questions.'),
  ccue(100, 'chapterExit', null, 'She flicks the card toward the PLAYER.'),
  ccue(100, 'chapterExit', null, 'Before it reaches the table, black smoke blooms around the throne. A fan of playing cards flashes through it like silver birds.'),
  ccue(100, 'chapterExit', null, 'The smoke clears. The throne is empty. The QUEEN OF SPADES card lies face-up on the table.'),
  ccue(100, 'chapterExit', 'player', 'Dame?'),
  ccue(100, 'chapterExit', null, 'No answer. The PLAYER turns the card over.'),
  ccue(100, 'chapterExit', null, 'On the back, where the casino crest should be, is a single RED HEART.'),
  ccue(100, 'chapterExit', null, 'The black doors behind the PLAYER open. THE COUNTESS stands there.'),
  ccue(100, 'chapterExit', 'player', 'Where did she go?'),
  ccue(100, 'chapterExit', 'the_countess', 'Which one?'),
  ccue(100, 'chapterExit', 'player', 'Do not do that.'),
  ccue(100, 'chapterExit', null, 'For the first time, THE COUNTESS almost laughs.'),
  ccue(100, 'chapterExit', 'the_countess', 'Come. You have been inside long enough.'),
  ccue(100, 'chapterExit', null, 'THE COUNTESS leads the PLAYER back through the casino. It is empty.'),
  ccue(100, 'chapterExit', null, 'Every table is still set. Lamps are on. Glasses sit where people left them. But there are no dealers, no regulars, no bosses, no music. The rooms that were crowded all night now feel abandoned.'),
  ccue(100, 'chapterExit', 'player', 'Where is everyone?'),
  ccue(100, 'chapterExit', 'the_countess', 'Gone.'),
  ccue(100, 'chapterExit', 'player', 'How long was I in there?'),
  ccue(100, 'chapterExit', 'the_countess', 'Long enough.'),
  ccue(100, 'chapterExit', 'player', 'It felt like minutes.'),
  ccue(100, 'chapterExit', 'the_countess', 'That room has poor manners with time.'),
  ccue(100, 'chapterExit', null, 'They reach the front doors. The PLAYER still holds the Queen of Spades card with the red heart on its back.'),
  ccue(100, 'chapterExit', 'player', 'Was any of that real?'),
  ccue(100, 'chapterExit', 'the_countess', 'Check your credits.'),
  ccue(100, 'chapterExit', null, 'The PLAYER looks. The campaign balance is still there. So is the final emblem.'),
  ccue(100, 'chapterExit', 'the_countess', 'Rest.'),
  ccue(100, 'chapterExit', 'player', 'And then?'),
  ccue(100, 'chapterExit', null, 'THE COUNTESS looks at the red heart on the card.'),
  ccue(100, 'chapterExit', 'the_countess', 'If you still want the truth, follow the heart.'),
  ccue(100, 'chapterExit', null, 'The PLAYER steps outside. The street is almost empty. Behind them, the spade casino doors close without a sound.'),
  ccue(100, 'chapterExit', null, 'Across the city, far beyond the rooftops, a distant red glow pulses once like a heartbeat.'),
  ccue(100, 'chapterExit', null, 'CAMPAIGN COMPLETE: DAME DE PIQUE — One hundred tables cleared. The heart is waiting.'),

  // Prologue cinematic — the screenplay's opening EXT. CITY STREET beat
  // (motorcar, envelope, facade), fed in verbatim like every other cue.
  // Still appended at the very end of the array rather than moved up
  // alongside ch1's other cues, though that's no longer load-bearing —
  // it was, back when ccue()'s id embedded a single counter running over
  // the WHOLE file (see the id-scheme note above ccue() itself, and the
  // one on the story-box cues threaded through Levels 2-50 below for how
  // that got fixed). levelId 1 + a dedicated 'prologue' trigger keeps
  // this bucket out of every other level/trigger filter without needing
  // a level 0. speakerId is deliberately null —
  // these are narrator/scene-direction lines with nobody to anchor a
  // portrait to, so the client renders this trigger through its own
  // full-bleed cinematic overlay (campaignMaybeShowPrologue) instead of
  // the small #camp-dialogue speech-bubble card campaignDialogueStep
  // draws for every other trigger. `bg` (1/2/3) selects which of the
  // three /campaign/prologue/*.webp stills is behind the line; the
  // letter-reveal beat carries no text of its own (the invitation's copy
  // is baked into still #2) and `hold` tells the client to replace
  // tap-to-advance with a 2s pause then an explicit Continue button,
  // exactly as asked for that one beat. The final line hands off
  // straight into ch1's existing chapterEnter cues above ("First time
  // here?"), which is the screenplay's very next line after this one.
  ccue(1, 'prologue', null, 'Rain stripes the pavement. A black motorcar stops beside the PLAYER. No driver is visible through the smoked glass.', { bg: 1 }),
  ccue(1, 'prologue', null, 'A gloved hand extends from the rear window and offers a black envelope sealed with a gold spade.', { bg: 1 }),
  ccue(1, 'prologue', null, 'The PLAYER opens it.', { bg: 1 }),
  ccue(1, 'prologue', null, '', { bg: 2, hold: 2000 }),
  ccue(1, 'prologue', null, 'The car pulls away before the PLAYER can answer.', { bg: 3 }),
  ccue(1, 'prologue', null, 'Across the street, an Art Deco facade glows through the rain. Above the doors: a single gold spade.', { bg: 3 }),
  ccue(1, 'prologue', null, 'The doors open. The CONCIERGE waits inside.', { bg: 3 }),
];
function campaignCuesFor(levelId, trigger) {
  return CAMPAIGN_STORY_CUES.filter(c => c.levelId === levelId && c.trigger === trigger);
}

// Mirrors createDailyRoom: no lobby, no seat draw, player at 0, AI at
// 1-3. G.dealer is fixed at 3 rather than drawn — campaign has no
// draw/cut ceremony — so the player (seat 0) always leads trick 1, which
// matches the screenplay framing every level opens on the player's own
// play. Boss seat gets no different AI logic, only different presented
// identity (campaignBoss in publicState) — see the plan doc.
async function createCampaignRoom(name, avatar, accountId, socketId, levelId) {
  const level = campaignLevelById(levelId);
  const G = createRoom(name, avatar, accountId, { forcePassDir: level.forcePassDir });
  // Set directly, exactly like createDailyRoom does for its own
  // roundsTotal=1 — a single-hand level's roundsTotal (1) isn't one of
  // the offered ROUND_OPTIONS values, so it has to bypass createRoom's
  // opts-driven sanitizeRoundsTotal entirely.
  G.roundsTotal = level.hands;
  G.campaign = true;
  G.campaignLevelId = level.id;
  G.campaignObjective = level.objective;
  G.campaignBossId = level.bossId || null;
  G.campaignResultSubmitted = false;
  G.campaignVoidTrick = null;
  G.dealer = 3;
  const token = makeToken();
  Object.assign(G.players[0], { socketId, connected: true, token });
  if (accountId) Object.assign(G.players[0], await lookupSeatCosmetics(accountId));
  G.hostSocket = socketId;
  G.hostToken = token;
  // Seats 1-3 are the chapter's own cast (boss substituted in at an x0
  // level), not "Computer 2/3/4" — the whole point of a story mode is
  // that you're playing these specific people. seatAvatar dresses the
  // seat with real avatar art where that character has some; campaignCharId
  // is sent alongside it so the client can render the SAME dialogue
  // portrait (real photo if CAMPAIGN_PORTRAIT_SRC has one, the gold
  // monogram badge otherwise) for every character at the table, not just
  // the handful who happen to already be a House Regular avatar — before
  // this field existed, every AI seat's table/roster/summary/final avatar
  // was hardcoded to the generic robot glyph regardless of `avatar`.
  const seatIds = campaignSeatCharacters(level);
  for (let i = 1; i < 4; i++) {
    const cid = seatIds[i - 1];
    const ch = CAMPAIGN_CHARACTERS[cid] || {};
    Object.assign(G.players[i], {
      name: ch.name || `Computer ${i + 1}`,
      avatar: ch.seatAvatar ? sanitizeAvatar(ch.seatAvatar) : null,
      campaignCharId: cid || null,
      // Marks the boss's seat wherever it lands (it is NOT always seat 1 —
      // each chapter's roster decides which chair the boss takes over).
      // Set here rather than client-side for exactly that reason.
      title: (level.type === 'BOSS' && cid === level.bossId) ? 'Chapter Boss' : null,
      accountId: null, isAI: true, connected: true, socketId: null, token: null,
    });
  }
  return { G, token };
}

// dealRound's deck-selection hook (see the G.campaign branch added there):
// returns a full 52-card deck with the level's exact fixed player hand at
// indices 0-12 and the remaining 39 cards seeded-shuffled across the
// other three seats — reproducible retry-to-retry. See the plan doc for
// why this doesn't attempt to reproduce the source spreadsheet's own
// generation seed byte-for-byte.
function buildCampaignDeck(G) {
  const level = campaignLevelById(G.campaignLevelId);
  const playerHand = level.hands === 4 ? level.hands4[G.round - 1] : level.hand;
  const rest = makeDeck().filter(c => !playerHand.some(h => h.rank === c.rank && h.suit === c.suit));
  return [...playerHand, ...seededShuffle(rest, level.seed + '-r' + G.round)];
}

// Reads seat 0's final state for the level and reports clear/gold against
// its objective. cleanHand/trickCount aren't wired here since no Chapter
// 1 level uses them yet — add both a case here and an entry in the
// objective-shape comment above together if a later chapter needs one.
function evaluateCampaignObjective(G) {
  const level = campaignLevelById(G.campaignLevelId);
  const obj = level.objective;
  const p = G.players[0];
  const score = p.score;
  if (obj.type === 'score') {
    return { cleared: score >= obj.min, gold: score >= obj.gold, metric: score };
  }
  if (obj.type === 'suitVoid') {
    // G.campaignVoidTrick is set live in resolveTrick the first time the
    // player's hand has zero cards of the target suit; null if it never
    // happened. See resolveTrick for the write side.
    const voidTrick = G.campaignVoidTrick;
    const cleared = voidTrick != null && voidTrick <= obj.voidByTrick;
    // Optional goldScoreBar, same AND-composition as avoidQueen/cleanHand
    // below: gold requires the void AND a score floor, not just the void.
    const gold = voidTrick != null && voidTrick <= obj.goldByTrick
      && (!obj.goldScoreBar || score >= obj.goldScoreBar);
    return { cleared, gold, metric: voidTrick };
  }
  if (obj.type === 'avoidQueen') {
    const tookQueen = p.tricks.some(c => c.suit === '♠' && c.rank === 'Q');
    const avoided = !tookQueen;
    return { cleared: avoided, gold: avoided && score >= obj.goldScoreBar, metric: score };
  }
  if (obj.type === 'cleanHand') {
    // Same penalty-card check recordRoundAchievements already uses for
    // the Clean Hand achievement stat (server.js's achBuf.clean) — zero
    // hearts and no Q♠ among this player's captured tricks this round.
    const penalties = p.tricks.filter(c => c.suit === '♥' || (c.suit === '♠' && c.rank === 'Q')).length;
    const clean = penalties === 0;
    return { cleared: clean, gold: clean && score >= obj.goldScoreBar, metric: score };
  }
  if (obj.type === 'trickCount') {
    const tricksWon = p.tricks.length / 4;
    // goldMoon adds "...and shoot the moon" to the gold condition. Read
    // off G.moonShooter, the same field submitDailyResult uses for its
    // own shot-moon flag — set in endRound, so it's already settled by
    // the time this runs. See the objective's own note on why this is
    // single-hand only.
    // Optional goldScoreBar, same AND-composition as avoidQueen/cleanHand/
    // suitVoid: gold can require the trick count AND a score floor, not
    // just the trick count, alongside the pre-existing goldMoon flag.
    const gold = tricksWon >= obj.goldTricks && (!obj.goldMoon || G.moonShooter === 0)
      && (!obj.goldScoreBar || score >= obj.goldScoreBar);
    return { cleared: tricksWon >= obj.minTricks, gold, metric: tricksWon };
  }
  return { cleared: false, gold: false, metric: score };
}

function campaignLevelCredits(level, gold) {
  const base = CAMPAIGN_CREDITS_BY_TYPE[level.type] || CAMPAIGN_CREDITS_BY_TYPE.Normal;
  return gold ? Math.round(base * 1.5) : base;
}

// Called once, from recordGameFinishedForAll, when a campaign level's
// hand(s) are done. Mirrors submitDailyResult's shape closely: an
// in-memory one-shot guard, a guest branch that reports the result
// without persisting anything, and a trackStat-wrapped write for real
// accounts. Credits are granted ONCE EVER per level (first clear only,
// via db.grantCredits' own idempotent (account,type,reference) — a
// replay that clears again simply grants nothing, `granted` comes back
// null) — a third, deliberately different economy shape from casual's
// once/day and ranked's uncapped, so infinite retries can't farm credits.
function submitCampaignLevelResult(G) {
  if (G.campaignResultSubmitted) return;
  G.campaignResultSubmitted = true;
  // This runs synchronously off a setTimeout chain (resolveTrick ->
  // endRound -> advanceRound, or finishEarly), with nothing upstream
  // that catches a throw — an uncaught exception here used to be a hard
  // process crash (see the global handlers near server.listen for why
  // that reads as "the whole game froze"). Guarded now so a bug in this
  // one level's result costs a clean error, not everyone's game.
  let level, p, cleared, gold, metric;
  try {
    level = campaignLevelById(G.campaignLevelId);
    p = G.players[0];
    ({ cleared, gold, metric } = evaluateCampaignObjective(G));
  } catch (e) {
    console.error('submitCampaignLevelResult evaluate error:', e.stack || e.message);
    const sid = G.players[0] && G.players[0].socketId;
    if (sid) io.to(sid).emit('campaignError', { msg: "Couldn't score that table. Your attempt was not counted against you — please report this." });
    return;
  }
  const socketId = p.socketId;
  const payload = { levelId: level.id, cleared, gold, metric, score: p.score };

  if (!DB_ENABLED || !p.accountId) {
    // Guests can't reach this at all today (campaign requires login — see
    // the startCampaignLevel handler), but this mirrors submitDailyResult's
    // own guest branch defensively rather than assuming that gate can
    // never change.
    if (socketId) io.to(socketId).emit('campaignResult', { ...payload, guest: true, creditsAwarded: 0, newUnlock: null });
    return;
  }

  trackStat(async () => {
    await db.upsertCampaignLevelResult(p.accountId, level.id, p.score, cleared, gold);
    let creditsAwarded = 0;
    if (cleared) {
      const amount = campaignLevelCredits(level, gold);
      const granted = await db.grantCredits(p.accountId, amount, 'campaign_reward', 'campaign-' + level.id);
      if (granted) creditsAwarded = amount;
    }
    let newUnlock = null;
    if (cleared) {
      const unlock = await db.advanceCampaignUnlock(p.accountId, level.id);
      if (unlock.advanced) newUnlock = unlock.highestUnlockedLevel;
    }
    if (socketId) io.to(socketId).emit('campaignResult', { ...payload, creditsAwarded, newUnlock });
  });
}

// Assembles everything the map screen needs in one round trip — chapter/
// level static data plus the account's live progress — same "compose
// once, send once" style as loadPlayerCosmetics.
async function buildCampaignMapPayload(accountId) {
  const state = await db.getCampaignState(accountId, CAMPAIGN_MAX_ATTEMPTS, CAMPAIGN_ATTEMPT_REFILL_MS);
  const resultsByLevel = {};
  for (const r of state.results) resultsByLevel[r.levelId] = r;
  return {
    chapters: CAMPAIGN_CHAPTERS,
    levels: CAMPAIGN_LEVEL_LIST.map(l => ({
      id: l.id, chapter: l.chapter, type: l.type, bossId: l.bossId || null,
      // Sent so the client can render the level-detail popup's objective
      // text and pass-direction line without a second round trip.
      objective: l.objective, hands: l.hands, forcePassDir: l.forcePassDir,
      unlocked: l.id <= state.highestUnlockedLevel,
      result: resultsByLevel[l.id] || null,
    })),
    // The client has no other way to know what a character actually says
    // — cues are only ever authored here — so the whole (small, Chapter-1-
    // only) cue list ships with every map load rather than being fetched
    // per level. Trigger/sequencing logic lives client-side; this is pure
    // content.
    storyCues: CAMPAIGN_STORY_CUES,
    characters: CAMPAIGN_CHARACTERS,
    highestUnlockedLevel: state.highestUnlockedLevel,
    // While the playtest flag is on, the pool is reported as unlimited
    // rather than faked to a full 15 — the client shows ∞ so it's always
    // obvious this is the temporary mode and not a real full bar.
    attempts: CAMPAIGN_UNLIMITED_ATTEMPTS
      ? { unlimited: true, available: CAMPAIGN_MAX_ATTEMPTS, max: CAMPAIGN_MAX_ATTEMPTS, nextRefillAt: null }
      : state.attempts,
    storyCuesSeen: state.storyCuesSeen,
  };
}

// ── Ranked matchmaking ────────────────────────────────────────────
// Ranked is a FIXED 8 rounds — it no longer inherits DEFAULT_ROUNDS (16)
// the way every other createRoom call site does. Casual keeps the full
// 4/8/12/16 picker; ranked deliberately has one length so every ladder
// game is the same shape.
// Note for stats: recordRankedGameFinished's best/worst-game and average
// columns now mix pre-change 16-round totals with 8-round ones. That is
// the same incomparability that gave Blitz its own columns; it was a
// deliberate call not to split or migrate ranked's, so treat ranked
// per-GAME aggregates from before this change as not comparable. Per-round
// and per-trick records are unaffected — a round is 13 tricks in any mode.
const RANKED_ROUNDS = 8;
function formRankedMatch(group) {
  const G = createRoom(group[0].name, group[0].avatar, group[0].accountId,
                       { roundsTotal: RANKED_ROUNDS });
  G.ranked = true;
  for (let i = 0; i < 4; i++) {
    const p = group[i];
    const token = makeToken();
    Object.assign(G.players[i], {
      name: p.name, avatar: sanitizeAvatar(p.avatar), accountId: p.accountId,
      ...(p.seatCos || NO_SEAT_COSMETICS),
      socketId: p.socketId, token, connected: true, isAI: false,
    });
    if (i === 0) { G.hostSocket = p.socketId; G.hostToken = token; }
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.join(G.code);
    io.to(p.socketId).emit('rankedMatchFound', { code: G.code, playerIndex: i, token, isHost: i === 0 });
    if (p.accountId) trackStat(() => db.recordRankedGameStarted(p.accountId));
  }
  startDraw(G, 1);
}

function radiusFor(entry, now) {
  return RANKED_MIN_RADIUS + RANKED_RADIUS_STEP * Math.floor((now - entry.queuedAt) / RANKED_RADIUS_GROW_MS);
}

setInterval(() => {
  const now = Date.now();
  for (const entry of rankedQueue) {
    io.to(entry.socketId).emit('rankedQueueUpdate', {
      elapsedMs: now - entry.queuedAt,
      radius: radiusFor(entry, now),
      queueSize: rankedQueue.length,
    });
  }
  if (rankedQueue.length < 4) return;
  const sorted = [...rankedQueue].sort((a, b) => a.mmr - b.mmr);
  for (let i = 0; i <= sorted.length - 4; i++) {
    const group = sorted.slice(i, i + 4);
    const spread = group[group.length - 1].mmr - group[0].mmr;
    const tightestRadius = Math.min(...group.map(p => radiusFor(p, now)));
    if (spread <= tightestRadius) {
      for (const p of group) {
        const idx = rankedQueue.findIndex(q => q.socketId === p.socketId);
        if (idx !== -1) rankedQueue.splice(idx, 1);
      }
      formRankedMatch(group);
      break; // queue mutated — re-scan cleanly next tick
    }
  }
}, 2000);

// ── Auto-advance & room closing ─────────────────────────────────
function clearAuto(G) {
  if (G.autoTimer) clearTimeout(G.autoTimer);
  G.autoTimer = null;
  G.autoAt = 0;
}
function armAuto(G, fn, ms) {
  clearAuto(G);
  G.autoAt = Date.now() + ms;
  G.autoTimer = setTimeout(() => { G.autoTimer = null; G.autoAt = 0; fn(); }, ms);
}
function closeRoom(G, reason) {
  clearAuto(G);
  clearVote(G);
  for (let i = 0; i < 4; i++) clearRankedTakeover(G, i);
  // campaign flag for the same reason leaveRoom sends one — it decides
  // where the client lands (chapter map vs casual landing screen).
  io.to(G.code).emit('roomClosed', { reason, campaign: !!G.campaign });
  delete rooms[G.code];
}

// Ranked has no AI seats by choice — but a disconnected human still gets a
// short grace period to come back before the game hands their seat to the
// computer so the other three aren't stuck waiting indefinitely.
function clearRankedTakeover(G, idx) {
  if (G.rankedTimers && G.rankedTimers[idx]) {
    clearTimeout(G.rankedTimers[idx]);
    G.rankedTimers[idx] = null;
  }
}
function scheduleRankedTakeover(G, idx) {
  clearRankedTakeover(G, idx);
  G.rankedTimers[idx] = setTimeout(() => {
    G.rankedTimers[idx] = null;
    const p = G.players[idx];
    if (!rooms[G.code] || p.connected || p.isAI) return;
    p.isAI = true;
    resumeAfterSeatChange(G);
    broadcastRoom(G);
  }, RANKED_RECONNECT_MS);
}

// Re-arm whatever timer belongs to the phase we're sitting in.
function rearmAuto(G) {
  if (G.phase === 'roundSummary') {
    armAuto(G, () => advanceRound(G), ROUND_CONFIRM_MS);
  } else if (G.phase === 'drawDone') {
    armAuto(G, () => { if (G.phase === 'drawDone') dealRound(G); }, AUTO_ADVANCE_MS);
  } else if (G.phase === 'draw') {
    armAuto(G, () => {
      if (G.phase !== 'draw') return;
      for (let i = 0; i < 4; i++) if (!G.drawRevealed[i]) revealDrawCard(G, i);
    }, AUTO_ADVANCE_MS);
  } else if (G.phase === 'pass') {
    armAuto(G, () => autoPassRemaining(G), PASS_SELECT_MS);
  }
}

// Everyone with a real seat (not AI, not empty) needs to actively confirm
// before the round moves on — AI/empty seats are pre-confirmed since they
// have no one to click anything.
function checkRoundReady(G) {
  if (G.phase !== 'roundSummary' || !G.roundReady) return false;
  for (let i = 0; i < 4; i++) if (G.players[i].isAI) G.roundReady[i] = true;
  if (G.roundReady.every(Boolean)) { advanceRound(G); return true; }
  return false;
}

// ── Ending the game early (needs everyone's agreement) ──────────
function clearVote(G) {
  if (G.voteTimer) clearTimeout(G.voteTimer);
  G.voteTimer = null;
  G.voteAt = 0;
}

function flashVoteMsg(G, msg) {
  G.voteMsg = msg;
  broadcastRoom(G);
  setTimeout(() => {
    if (rooms[G.code] && G.voteMsg === msg) { G.voteMsg = ''; broadcastRoom(G); }
  }, 4500);
}

function cancelVote(G, msg) {
  clearVote(G);
  G.endVote = null;
  rearmAuto(G);           // the round countdown resumes where it left off
  if (msg) flashVoteMsg(G, msg); else broadcastRoom(G);
}

// Called from both ways a game can actually conclude: the natural
// 16-round finish and an early-end vote. Either way it's a real, complete
// game as far as stats are concerned.
function applyRankedResult(G) {
  if (!G.ranked) return;
  const scores = G.players.map(p => p.score);
  const deltas = computeMmrChanges(scores);
  for (let i = 0; i < 4; i++) {
    const acctId = G.players[i].accountId;
    if (!acctId) continue;
    const socketId = G.players[i].socketId;
    trackStat(async () => {
      const { mmr, placementGamesPlayed } = await db.applyRankedMmr(acctId, deltas[i]);
      const isPlacement = placementGamesPlayed < 5;
      if (socketId) {
        io.to(socketId).emit('rankedResult', {
          mmrChange: deltas[i], mmr, placementGamesPlayed, isPlacement,
          rank: isPlacement ? null : rankForMmr(mmr),
        });
      }
    });
  }
}

// `natural` distinguishes a game that played out its full round count
// from one cut short by the end-early vote — the only difference that
// matters to The Silent Dealer, and the reason finishEarly passes false.
// ── Credits ──────────────────────────────────────────────────────
// A second progression track, parallel to MMR and deliberately never
// touching it: credits measure engagement, never skill, and nothing here
// is read by matchmaking or by rank derivation.
const CREDIT_PLACEMENT = [50, 40, 32, 24];   // 1st..4th
const CREDIT_MOON_BONUS = 10;                // per moon this player fired
const DAILY_CREDIT_FLOOR = 5;                // just for completing
const DAILY_CREDIT_PER_POINT = 0.2;          // positive finishes only

// credits = round(placementBase * x) + 10 * moons, where x scales with
// how well the game was played rather than just where it finished:
//   x = clamp(1 + 0.02 * (totalScore / roundsPlayed), 0.75, 1.25)
// Dividing by roundsPlayed is what makes this length-agnostic, so a
// 4-round Blitz and a 16-round casual game pay comparably for comparable
// play — no per-length calibration needed.
function computeGameCredits(placeIndex, totalScore, roundsPlayed, moons) {
  const avgRoundScore = roundsPlayed > 0 ? totalScore / roundsPlayed : 0;
  const x = Math.min(1.25, Math.max(0.75, 1 + 0.02 * avgRoundScore));
  const base = CREDIT_PLACEMENT[Math.min(3, Math.max(0, placeIndex))];
  return Math.round(base * x) + CREDIT_MOON_BONUS * (moons || 0);
}

// Standard competition ranking: equal scores share a placement, so a tie
// for first pays both players the 1st-place base. Same generosity rule
// the win achievement already uses — the game has no tiebreak, so
// inventing one purely to pay someone less would be worse.
function placementIndexes(scores) {
  const sorted = [...scores].sort((a, b) => b - a);
  return scores.map(sc => sorted.indexOf(sc));
}

// Casual pays at most ONE game a day, whoever the opponents are; ranked is
// uncapped and is the only mode where volume turns into credits. The claim
// is atomic in SQL, so two casual games finishing together can't both pay.
async function awardGameCredits(G, acctId, placeIndex, finalScore, moons) {
  const amount = computeGameCredits(placeIndex, finalScore, G.round, moons);
  if (amount <= 0) return 0;
  const ref = `${G.code}-${G.startedAt}`;
  if (!G.ranked) {
    // Passing the ref keeps this idempotent under trackStat's retries —
    // see claimCasualCreditDay. Without it a retried grant would be
    // refused by the cap it set itself on the first attempt.
    const claimed = await db.claimCasualCreditDay(acctId, dailyDateKey(), ref);
    if (!claimed) return 0;             // another game already had today's casual payout
  }
  await db.grantCredits(acctId, amount, 'game_reward', ref);
  // Returned (not just granted) so the final-standings screen can show
  // exactly what each seat earned, including a real 0 for the casual
  // daily-cap case above — not just "some positive amount" that the
  // client would have no way to distinguish from "not paid yet".
  return amount;
}

// The final-standings screen's own credits column. Recomputes the SAME
// numbers awardGameCredits already wrote via the trackStat-wrapped call
// below, rather than threading a value through it — deliberately NOT
// itself trackStat-wrapped, since this only ever adds numbers to a
// screen that's already showing (the 'final' phase broadcast already
// went out by the time this resolves), so it doesn't need trackStat's
// retry durability, and awaiting it inline would gate that broadcast on
// a DB round trip for no reason. Calling awardGameCredits a second time
// for the same (account, ref) pair is safe — both grantCredits and
// claimCasualCreditDay are idempotent on that pair (see their own
// comments), so this can't double-pay or double-claim the casual cap.
async function broadcastFinalCredits(G, places) {
  const credits = await Promise.all(G.players.map(async (p, i) => {
    if (!p.accountId) return null;      // AI/guest seats never earn credits
    const moons = (G.moonCounts && G.moonCounts[i]) || 0;
    try {
      return await awardGameCredits(G, p.accountId, places[i], p.score, moons);
    } catch (e) {
      console.error('broadcastFinalCredits error:', e.message);
      return null;
    }
  }));
  io.to(G.code).emit('finalCreditsOk', { credits });
}

function recordGameFinishedForAll(G, natural) {
  // The Daily Challenge and Campaign Mode each finish through their own
  // pipeline — neither may touch casual/ranked stats or the achievement
  // buffer (achBuf still accumulates during their rounds, harmlessly,
  // since the flush code below that would ever read it is exactly what
  // this early return skips).
  if (G.daily) { submitDailyResult(G); return; }
  if (G.campaign) { submitCampaignLevelResult(G); return; }
  applyRankedResult(G);
  // Highest score wins. A tie counts as a win for everyone tied — the
  // game has no tiebreak rule, so inventing one here just to deny an
  // achievement would be worse than being generous.
  const topScore = Math.max(...G.players.map(p => p.score));
  const places = placementIndexes(G.players.map(p => p.score));
  for (let i = 0; i < 4; i++) {
    const acctId = G.players[i].accountId;
    if (!acctId) continue;
    const finalScore = G.players[i].score;
    const moons = (G.moonCounts && G.moonCounts[i]) || 0;
    const won = finalScore === topScore;
    // NO ACHIEVEMENT COUNTS UNLESS THE GAME ACTUALLY FINISHED. `natural`
    // is false only for the end-early vote, and that is exactly the case
    // that must bank nothing: otherwise four players could vote out of a
    // game one round in and farm queens, dealt hands, slams and clean
    // hands off it. Everything here is buffered on the room all game (see
    // achBuf), so skipping the write discards the whole lot.
    //
    // Gates ONLY this call - deliberately not a `continue`, which would
    // also skip the credit grant and the casual/ranked/blitz stat writes
    // below. Stats are not gated on purpose: a statistic about an
    // abandoned game is still true, an achievement for it is not.
    //
    // Gating everything on `natural` would have made gamesCompleted
    // identical to gamesCompletedFull, leaving The Silent Dealer measuring
    // exactly what Card Master does. So completedFull now means something
    // it can still uniquely mean: you were STILL IN YOUR OWN SEAT at the
    // end. A player who disconnects or leaves keeps their accountId on the
    // seat (isAI flips, accountId is deliberately not cleared - see
    // scheduleRankedTakeover), so they still bank everything they
    // personally did; they just don't get credit for seeing it through.
    const b = achBuf(G);
    if (natural) trackStat(() => db.recordAchievementGame(acctId, {
      completed: 1,
      completedFull: G.players[i].isAI ? 0 : 1,
      won: won ? 1 : 0,
      wonPositive: won && finalScore > 0 ? 1 : 0,
      rankedWon: G.ranked && won ? 1 : 0,
      moons,
      fourSuit: won && (G.players[i].suitsWon || []).length === 4 ? 1 : 0,
      // Buffered on the room all game and flushed here, so an abandoned
      // game contributes nothing.
      queens: b.queens[i],
      dealerRounds: b.dealt[i],
      slams: b.slams[i],
      cleanRounds: b.clean[i],
      // Never took her in ANY hand of a completed game.
      queenless: b.queens[i] === 0 ? 1 : 0,
      bestRound: b.best[i],
      worstRound: b.worst[i],
      bestGame: finalScore,
      worstGame: finalScore,
    }));
    // Credits: only a FINISHED game pays, in any mode. `natural` is false
    // for an early-end vote, which is exactly the case that must not pay —
    // otherwise four players could vote out of a game a round in and farm.
    if (natural) trackStat(() => awardGameCredits(G, acctId, places[i], finalScore, moons));
    if (G.ranked) trackStat(() => db.recordRankedGameFinished(acctId, finalScore, moons));
    // A 4- or 8-round game's final score isn't comparable with a 16-round
    // one, so Blitz totals (best/worst game, average, win streak) get their
    // own columns rather than dragging the casual averages down.
    else if (isBlitz(G)) trackStat(() => db.recordBlitzGameFinished(acctId, finalScore, moons));
    else trackStat(() => db.recordGameFinished(acctId, finalScore, moons));
    // Casual games played, broken down by match length — natural finishes
    // only (an early-end vote shouldn't inflate a length bucket, same
    // reasoning as the achievement/credit gates above), covers both Blitz
    // lengths and the plain 16-round game alike.
    if (natural && !G.ranked) trackStat(() => db.recordCasualLengthFinished(acctId, G.roundsTotal));
    // Steady Hand: this length only counts if EVERY hand this game netted
    // this player >= 0 (achBuf.noNegRound) — same natural-finish, casual-
    // only gate as the length breakdown just above.
    if (natural && !G.ranked && b.noNegRound[i]) {
      trackStat(() => db.recordCleanLengthGame(acctId, G.roundsTotal));
    }
  }
  // Not gated by DB_ENABLED here — broadcastFinalCredits checks per-seat
  // accountId itself (all null when accounts aren't configured, so the
  // Promise.all just resolves to a room full of nulls and the client's
  // credits column quietly shows nothing, same as the guest case).
  if (natural) broadcastFinalCredits(G, places).catch(e => console.error('broadcastFinalCredits error:', e.message));
}

function finishEarly(G) {
  clearVote(G);
  clearAuto(G);
  G.endVote = null;
  G.voteMsg = '';
  G.phase = 'final';
  recordGameFinishedForAll(G, false);   // ended early by vote — see The Silent Dealer
  broadcastRoom(G);
}

// Everyone who still has to say yes: real people only, and not the one asking.
function votersNeeded(G, proposer) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    if (i === proposer) continue;
    const p = G.players[i];
    if (p.isAI || !p.token) continue;   // computers and empty seats always agree
    out.push(i);
  }
  return out;
}

function checkVoteComplete(G) {
  const v = G.endVote;
  if (!v) return false;
  if (v.needed.every(i => v.agreed.includes(i))) { finishEarly(G); return true; }
  return false;
}

function publicState(G) {
  return {
    code: G.code,
    phase: G.phase,
    ranked: !!G.ranked,
    players: G.players.map((p, i) => ({
      name: p.name, avatar: p.avatar || null, title: p.title || null,
      // Only a real account's id, never a bot's or a not-yet-logged-in
      // guest's — this is what lets the lobby seat card open the same
      // profile popup the daily leaderboard and friends list already use
      // (see getPlayerProfile), and both those callers already gate on
      // it being truthy before rendering a click affordance.
      accountId: p.accountId || null,
      // Which campaign character this AI seat is playing, if any — lets
      // the client render that character's own portrait (see
      // createCampaignRoom) instead of the generic AI glyph. Always null
      // outside campaign rooms.
      campaignCharId: p.campaignCharId || null,
      rankMaterial: p.rankMaterial || null,
      crest: p.crest || null, crestLevel: p.crestLevel || 1,
      crest2: p.crest2 || null, crest2Level: p.crest2Level || 1,
      isAI: p.isAI, score: p.score,
      roundScore: p.score - (G.roundBefore[i] || 0),
      tricksWon: p.tricks.length / 4,
      connected: p.connected, cardCount: p.hand.length, hasPassed: p.hasPassed,
    })),
    daily: !!G.daily,
    campaign: !!G.campaign,
    campaignLevel: G.campaignLevelId || null,
    campaignObjective: G.campaignObjective || null,
    // The boss's identity, for the client to swap seat 1's presented
    // name/portrait — the seat itself is still a plain AI opponent in
    // game logic, this is purely presentational (see createCampaignRoom).
    campaignBoss: G.campaignBossId || null,
    // So the pass/play table screens can show the same chapter background
    // as the map, without the client needing campaignData (which may
    // never have been fetched this session on a cold reconnect straight
    // into a hand — see updateSceneLayer client-side).
    campaignChapterSlug: G.campaign
      ? (((CAMPAIGN_CHAPTERS.find(c => c.id === (campaignLevelById(G.campaignLevelId) || {}).chapter)) || {}).slug || null)
      : null,
    // Sent rather than re-derived client-side: renderPass used to compute
    // it from (round-1)%4 itself, which is wrong for any room that pins a
    // direction (the Daily Challenge draws one from the date).
    passDir: roundPassDir(G),
    round: G.round,
    totalRounds: G.roundsTotal,
    isLastRound: G.round >= G.roundsTotal,
    dealer: G.dealer,
    drawRound: G.drawRound,
    heartsbroken: G.heartsbroken,
    currentTrick: G.currentTrick,
    trickLeader: G.trickLeader,
    trickNum: G.trickNum,
    lastTrick: G.lastTrick || null,
    drawCards: G.drawCards.map((c, i) => (G.drawRevealed[i] ? c : null)),
    drawRevealed: G.drawRevealed,
    roundBefore: G.roundBefore,
    lastTrickMsg: G.lastTrickMsg || '',
    moonShooter: G.moonShooter,
    roundReady: G.roundReady || null,
    history: G.history,
    autoIn: G.autoAt ? Math.max(0, G.autoAt - Date.now()) : 0,
    endVote: G.endVote ? { by: G.endVote.by, needed: G.endVote.needed, agreed: G.endVote.agreed } : null,
    voteIn: G.voteAt ? Math.max(0, G.voteAt - Date.now()) : 0,
    voteMsg: G.voteMsg || '',
    passLetters: Array.from({ length: G.roundsTotal }, (_, i) => roundPassLetter(G, i + 1)),
  };
}

function broadcastRoom(G) {
  G.lastActivity = Date.now();
  const pub = publicState(G);
  for (let i = 0; i < 4; i++) {
    const p = G.players[i];
    if (!p.isAI && p.socketId) {
      io.to(p.socketId).emit('gameState', {
        ...pub,
        myIndex: i,
        isHost: p.token != null && p.token === G.hostToken,
        myHand: sortH(p.hand),
        myReceived: G.receivedThisRound ? G.receivedThisRound[i] : [],
        myPassed: G.passSelected ? (G.passSelected[i] || []) : [],
        passToIndex: roundPassDir(G) === 'keep' ? null : passTarget(i, roundPassDir(G)),
        passFromIndex: roundPassDir(G) === 'keep' ? null : passSource(i, roundPassDir(G)),
        legalCards: G.phase === 'play' ? legalCards(G, i).map(c => c.rank + '|' + c.suit) : [],
      });
    }
  }
}

// ── Draw phase ──────────────────────────────────────────────────
function startDraw(G, round) {
  G.phase = 'draw';
  G.drawRound = round;
  // Round 1's cut is the start of the game proper, so the game-scoped
  // achievement accumulator resets here. Belt-and-braces: a room only
  // ever plays one game today, so this is already [] from createRoom.
  if (round === 1) for (const p of G.players) p.suitsWon = [];
  const deck = shuffle(makeDeck());
  G.drawCards = deck.slice(0, 4);
  G.drawRevealed = [false, false, false, false];
  broadcastRoom(G);
  for (let i = 0; i < 4; i++) {
    if (G.players[i].isAI) setTimeout(() => revealDrawCard(G, i), 500 + i * 500);
  }
  // Nobody should be able to hold the game up at the cut.
  armAuto(G, () => {
    if (G.phase !== 'draw') return;
    for (let i = 0; i < 4; i++) if (!G.drawRevealed[i]) revealDrawCard(G, i);
  }, AUTO_ADVANCE_MS);
}

// Physically reassigns table seats (array position 0-3) based on the round-1
// draw: highest card sits seat 0, then descending around the table. Player
// objects move as a whole (token, socketId, isAI, name, connected all travel
// together), so reconnection — which looks players up by token, never by
// index — and host detection — keyed off hostToken/hostSocket, not seat
// index — both keep working correctly after the shuffle.
function reseatByDraw(G) {
  const order = [0, 1, 2, 3].sort((a, b) => RV[G.drawCards[b].rank] - RV[G.drawCards[a].rank]);
  G.players = order.map(i => G.players[i]);
  G.drawCards = order.map(i => G.drawCards[i]);
  G.drawRevealed = order.map(i => G.drawRevealed[i]);
}

function revealDrawCard(G, i) {
  if (G.phase !== 'draw' || G.drawRevealed[i]) return;
  G.drawRevealed[i] = true;
  if (G.drawRevealed.every(Boolean)) {
    if (G.drawRound === 1) {
      // Round 1 settles everyone into their seats around the table
      // (highest card sits first). Now cut again to decide who deals first.
      reseatByDraw(G);
      G.phase = 'draw1Done';
      armAuto(G, () => { if (G.phase === 'draw1Done') startDraw(G, 2); }, AUTO_ADVANCE_MS);
    } else {
      let best = 0;
      for (let j = 1; j < 4; j++)
        if (RV[G.drawCards[j].rank] > RV[G.drawCards[best].rank]) best = j;
      G.dealer = best;
      G.phase = 'drawDone';
      armAuto(G, () => { if (G.phase === 'drawDone') dealRound(G); }, AUTO_ADVANCE_MS);
    }
  }
  broadcastRoom(G);
}

// ── Deal & pass ─────────────────────────────────────────────────
function dealRound(G) {
  clearAuto(G);
  // The Daily Challenge's single hand comes off a deck seeded from the UTC
  // date, so everyone playing that day gets exactly the same deal. A
  // campaign level's deck comes off its own fixed hand (see
  // buildCampaignDeck) so a retry replays the same setup. Every other
  // room shuffles for real.
  const deck = G.campaign
    ? buildCampaignDeck(G)
    : G.daily
      ? seededShuffle(makeDeck(), 'ddp-daily-' + G.dailyDate)
      : shuffle(makeDeck());
  for (let i = 0; i < 4; i++) {
    G.players[i].hand = deck.slice(i * 13, (i + 1) * 13);
    G.players[i].tricks = [];
    G.players[i].hasPassed = false;
  }
  G.passSelected = [null, null, null, null];
  G.receivedThisRound = [[], [], [], []];
  G.heartsbroken = false;
  G.currentTrick = [];
  G.trickNum = 1;
  G.moonShooter = -1;
  G.roundReady = null;
  G.lastTrickMsg = '';
  G.playLog = [];
  G.roundBefore = G.players.map(p => p.score);
  // Reset per round — see resolveTrick for where this gets set, and
  // evaluateCampaignObjective for how a Suit Void level reads it.
  if (G.campaign) G.campaignVoidTrick = null;

  // The Dealer achievement. Counted here, once per hand actually dealt,
  // rather than per game — a 16-round game deals 16 hands and a Blitz
  // deals 4, which is exactly the difference the achievement is about.
  const dealer = G.players[G.dealer];
  // Buffered, not written: see achBuf. Counts the seat, not the account,
  // so a seat handed to the computer mid-game simply stops accruing.
  if (dealer) achBuf(G).dealt[G.dealer]++;

  if (roundPassDir(G) === 'keep') { startTricks(G); return; }

  G.phase = 'pass';
  for (let i = 0; i < 4; i++) {
    if (G.players[i].isAI) {
      G.passSelected[i] = aiSelectPass(G, i);
      G.players[i].hasPassed = true;
    }
  }
  rearmAuto(G);
  broadcastRoom(G);
  checkAllPassed(G);
}

// A minute to choose, then any straggler gets 2 random cards picked for
// them so the round can't be held hostage by someone who wandered off.
function autoPassRemaining(G) {
  if (G.phase !== 'pass') return;
  let changed = false;
  for (let i = 0; i < 4; i++) {
    if (!G.passSelected[i]) {
      G.passSelected[i] = shuffle(G.players[i].hand).slice(0, 2);
      G.players[i].hasPassed = true;
      changed = true;
    }
  }
  if (changed) broadcastRoom(G);
  checkAllPassed(G);
}

function checkAllPassed(G) {
  if (G.passSelected.every(s => s && s.length === 2)) {
    clearAuto(G);
    setTimeout(() => executePass(G), 400);
  }
}

function executePass(G) {
  if (G.phase !== 'pass') return;
  const toAdd = [[], [], [], []];
  for (let i = 0; i < 4; i++) {
    const tgt = passTarget(i, roundPassDir(G));
    for (const c of G.passSelected[i]) {
      const idx = G.players[i].hand.findIndex(x => eqC(x, c));
      if (idx !== -1) toAdd[tgt].push(G.players[i].hand.splice(idx, 1)[0]);
    }
  }
  for (let i = 0; i < 4; i++) G.players[i].hand.push(...toAdd[i]);
  G.receivedThisRound = toAdd.map(cards => cards.map(c => ({ rank: c.rank, suit: c.suit })));

  // A brief, deliberate pause so everyone actually sees what landed in
  // their hand before tricks start — same idea as the draw/deal beats,
  // just short enough not to drag.
  G.phase = 'passReveal';
  broadcastRoom(G);
  setTimeout(() => {
    if (rooms[G.code] && G.phase === 'passReveal') startTricks(G);
  }, 1500);
}

// ── Trick play ──────────────────────────────────────────────────
function startTricks(G) {
  G.phase = 'play';
  G.heartsbroken = false;
  G.currentTrick = [];
  G.trickNum = 1;
  G.trickLeader = (G.dealer + 1) % 4;
  G.lastTrickMsg = '';
  broadcastRoom(G);
  scheduleAI(G);
}

function currentPlayer(G) { return (G.trickLeader + G.currentTrick.length) % 4; }

function scheduleAI(G) {
  if (G.phase !== 'play' || G.currentTrick.length === 4) return;
  const cp = currentPlayer(G);
  if (G.players[cp].isAI) setTimeout(() => doAIPlay(G), 650);
}

function doAIPlay(G) {
  if (G.phase !== 'play' || G.currentTrick.length === 4) return;
  const cp = currentPlayer(G);
  if (!G.players[cp].isAI) return;
  doPlayCard(G, cp, aiChoose(G, cp));
}

function doPlayCard(G, pi, card) {
  const idx = G.players[pi].hand.findIndex(c => eqC(c, card));
  if (idx === -1) return;
  G.players[pi].hand.splice(idx, 1);
  G.currentTrick.push({ player: pi, card });
  if (card.suit === '♥' || (card.suit === '♠' && card.rank === 'Q')) G.heartsbroken = true;
  G.lastTrickMsg = '';
  broadcastRoom(G);

  if (G.currentTrick.length === 4) setTimeout(() => resolveTrick(G), 800);
  else scheduleAI(G);
}

function resolveTrick(G) {
  if (G.phase !== 'play' || G.currentTrick.length !== 4) return;
  const winner = trickWinner(G.currentTrick);
  const penPts = G.currentTrick.reduce((s, t) => s + cardVal(t.card), 0);
  const trickScore = 10 + penPts;
  G.players[winner].score += trickScore;
  G.players[winner].tricks.push(...G.currentTrick.map(t => t.card));
  // Game-scoped, mode-agnostic and kept regardless of whether the winner
  // is even logged in — it's read once at game end, where the account
  // check happens. The led suit is what a trick "is": you can't win a
  // trick in a suit you didn't follow.
  const ledSuit = G.currentTrick[0].card.suit;
  if (!G.players[winner].suitsWon.includes(ledSuit)) G.players[winner].suitsWon.push(ledSuit);
  const gotQueen = G.currentTrick.some(t => t.card.suit === '♠' && t.card.rank === 'Q');
  if (G.players[winner].accountId && !G.daily && !G.campaign) {
    const acctId = G.players[winner].accountId;
    if (G.ranked) {
      trackStat(() => db.recordRankedTrick(acctId, trickScore));
      if (gotQueen) trackStat(() => db.recordRankedQueenTaken(acctId));
    } else {
      trackStat(() => db.recordTrick(acctId, trickScore));
      if (gotQueen) trackStat(() => db.recordQueenTaken(acctId));
    }
  }
  // Buffered on the room rather than written now - see achBuf. Still
  // deliberately outside the casual/ranked branch and outside its
  // !G.daily guard: taking the queen in the Daily Challenge is still
  // taking the queen. It is indexed by SEAT; the account is resolved once,
  // at the flush, so a seat that changes hands mid-game can't misattribute
  // what the previous occupant did.
  if (gotQueen) achBuf(G).queens[winner]++;
  // Suit Void objective: the first trick after which seat 0 holds zero
  // cards of the target suit. Checked here (hand already shrunk by the
  // card just played) rather than reconstructed after the fact — trickNum
  // still refers to the trick that just resolved, since it's incremented
  // below.
  if (G.campaign && G.campaignObjective && G.campaignObjective.type === 'suitVoid' && G.campaignVoidTrick == null) {
    if (!G.players[0].hand.some(c => c.suit === G.campaignObjective.suit)) G.campaignVoidTrick = G.trickNum;
  }
  G.lastTrickMsg = `${G.players[winner].name} wins trick ${G.trickNum} · +10${penPts !== 0 ? ' ' + penPts : ''}`;
  if (!G.playLog) G.playLog = [];
  G.playLog.push(G.currentTrick.map(t => ({ player: t.player, card: t.card })));
  G.lastTrick = {
    round: G.round,
    trickNum: G.trickNum,
    winner,
    cards: G.currentTrick.map(t => ({ player: t.player, card: t.card })),
  };
  G.currentTrick = [];
  G.trickNum++;
  G.trickLeader = winner;
  broadcastRoom(G);

  // A moon shot is locked in the instant one player holds all 13 hearts +
  // Q♠ among their won tricks — every remaining heart/Q has already been
  // played and captured, so no later trick can change the outcome. No
  // point playing out the rest of the round when the score is already
  // fixed at +60/-20. Tell the room right away (while everyone's still
  // looking at the play screen) so the celebration plays there, then give
  // it time to finish before actually ending the round.
  const moonShooter = checkMoon(G);
  if (moonShooter >= 0) {
    io.to(G.code).emit('moonShot', { shooter: moonShooter });
    setTimeout(() => endRound(G), MOON_FX_MS);
  } else if (G.trickNum > 13) {
    setTimeout(() => endRound(G), 1200);
  } else {
    setTimeout(() => scheduleAI(G), 850);
  }
}

function endRound(G) {
  const moon = checkMoon(G);
  G.moonShooter = moon;

  if (moon >= 0) {
    // Shooting the moon REPLACES everything scored this round:
    // the shooter ends on exactly +60 and everyone else on exactly -20,
    // regardless of which tricks were won along the way.
    for (let i = 0; i < 4; i++) {
      G.players[i].score = G.roundBefore[i] + (i === moon ? 60 : -20);
    }
  }

  // Record this round on the scoresheet (guard against a double call)
  if (!G.history.some(h => h.round === G.round)) {
    const deltas = G.players.map((p, i) => p.score - G.roundBefore[i]);
    G.history.push({
      round: G.round,
      dir: roundPassLetter(G, G.round),
      deltas,
      totals: G.players.map(p => p.score),
      moon,
    });
    if (moon >= 0) {
      if (!G.moonCounts) G.moonCounts = [0, 0, 0, 0];
      G.moonCounts[moon]++;
    }
    // Best/worst hand, clean hands and slams, all buffered until the game
    // finishes. Inside the same double-call guard as the history row, so a
    // repeated endRound can't count a hand twice.
    recordRoundAchievements(G, deltas);
    // Per-round records are match-length-agnostic (a round is 13 tricks in
    // every mode), so Blitz rounds blend into the same bucket quite
    // correctly — only *game*-level totals need splitting out, below in
    // recordGameFinishedForAll. The Daily Challenge and Campaign are both
    // excluded entirely: each has its own result pipeline and shouldn't
    // move casual/ranked numbers at all.
    if (!G.daily && !G.campaign) {
      for (let i = 0; i < 4; i++) {
        const acctId = G.players[i].accountId;
        if (!acctId) continue;
        if (G.ranked) trackStat(() => db.recordRankedRound(acctId, deltas[i]));
        else trackStat(() => db.recordRound(acctId, deltas[i]));
      }
    }
  }

  // Always show a summary for the final round too, then move on to standings.
  G.phase = 'roundSummary';
  // Every real seat has to confirm before moving on — AI/empty seats start
  // pre-confirmed since there's no one there to click anything.
  G.roundReady = G.players.map(p => p.isAI || !p.token);
  // If not everyone confirms, it carries on by itself anyway.
  rearmAuto(G);
  broadcastRoom(G);
}

function advanceRound(G) {
  if (!rooms[G.code] || G.phase !== 'roundSummary') return;
  clearAuto(G);
  if (G.round >= G.roundsTotal) { G.phase = 'final'; recordGameFinishedForAll(G, true); broadcastRoom(G); return; }
  G.round++;
  G.dealer = (G.dealer + 1) % 4;
  dealRound(G);
}

// A seat just became a computer — make sure play doesn't stall on it.
function resumeAfterSeatChange(G) {
  if (G.phase === 'draw') {
    for (let i = 0; i < 4; i++)
      if (G.players[i].isAI && !G.drawRevealed[i]) revealDrawCard(G, i);
  } else if (G.phase === 'pass') {
    for (let i = 0; i < 4; i++) {
      if (G.players[i].isAI && !G.players[i].hasPassed) {
        G.passSelected[i] = aiSelectPass(G, i);
        G.players[i].hasPassed = true;
      }
    }
    checkAllPassed(G);
  } else if (G.phase === 'play') {
    scheduleAI(G);
  } else if (G.phase === 'roundSummary') {
    checkRoundReady(G);
  }
}

// ── Socket handlers ─────────────────────────────────────────────
function findRoom(code) { return rooms[String(code || '').toUpperCase()]; }
function isHostSocket(G, socket) { return G.hostSocket === socket.id; }

// Marks this socket as belonging to accountId for friend presence/invite
// purposes, and tells the account's online friends it just came online
// (skipped if it already had another tab/device connected, so a second
// tab from the same account doesn't re-announce). Call this at every
// point a socket actually becomes "this account" — signup, login, and
// resumeSession — not updateProfile, which re-authenticates an already-
// attached socket and would just be a harmless no-op there anyway.
function attachAccountSocket(socket, accountId) {
  socket.accountId = accountId;
  let set = accountSockets.get(accountId);
  const wasOffline = !set || set.size === 0;
  if (!set) { set = new Set(); accountSockets.set(accountId, set); }
  set.add(socket.id);
  if (wasOffline) announceFriendPresence(accountId, true);
}
async function announceFriendPresence(accountId, online) {
  if (!DB_ENABLED) return;
  try {
    const friends = await db.getFriends(accountId);
    for (const f of friends) notifySocketsForAccount(f.id, 'friendPresence', { id: accountId, online });
  } catch (e) {
    console.error('announceFriendPresence error:', e.message);
  }
}
// The disconnect/logout-time mirror of attachAccountSocket. Only
// announces "offline" once the *last* socket for that account is gone —
// a second open tab keeps the account online for friends.
function detachAccountSocket(socket) {
  const accountId = socket.accountId;
  if (!accountId) return;
  const set = accountSockets.get(accountId);
  if (set) {
    set.delete(socket.id);
    if (set.size === 0) {
      accountSockets.delete(accountId);
      announceFriendPresence(accountId, false);
    }
  }
  socket.accountId = null;
}

io.on('connection', (socket) => {

  // ── Accounts ─────────────────────────────────────────────────
  socket.on('signup', async ({ username, password, nickname, avatar }) => {
    if (!DB_ENABLED) return socket.emit('authError', { msg: 'Accounts aren\'t set up on this server yet.' });
    const u = String(username || '').trim();
    const p = String(password || '');
    const nick = String(nickname || u).trim().slice(0, 16) || u;
    if (!USERNAME_RE.test(u)) {
      return socket.emit('authError', { msg: 'Username must be 3-20 characters: letters, numbers, underscore only.' });
    }
    if (p.length < 6) {
      return socket.emit('authError', { msg: 'Password needs to be at least 6 characters.' });
    }
    try {
      const existing = await db.findAccountByUsername(u);
      if (existing) return socket.emit('authError', { msg: 'That username is already taken.' });
      const passwordHash = await bcrypt.hash(p, 10);
      const account = await db.createAccount({ username: u, passwordHash, nickname: nick, avatar: sanitizeAvatar(avatar) });
      const token = makeToken();
      await db.createSession(account.id, token);
      attachAccountSocket(socket, account.id);
      socket.emit('authOk', { token, account: db.toPublic(account) });
    } catch (e) {
      console.error('signup error:', e.message);
      socket.emit('authError', { msg: 'Something went wrong creating your account. Try again.' });
    }
  });

  socket.on('login', async ({ username, password }) => {
    if (!DB_ENABLED) return socket.emit('authError', { msg: 'Accounts aren\'t set up on this server yet.' });
    const u = String(username || '').trim();
    const p = String(password || '');
    const uLower = u.toLowerCase();
    if (loginRateLimited(uLower)) {
      return socket.emit('authError', { msg: 'Too many attempts — wait a few minutes and try again.' });
    }
    try {
      const account = await db.findAccountByUsername(u);
      const ok = account && await bcrypt.compare(p, account.password_hash);
      recordLoginAttempt(uLower, !ok);
      if (!ok) return socket.emit('authError', { msg: 'Wrong username or password.' });
      const token = makeToken();
      await db.createSession(account.id, token);
      attachAccountSocket(socket, account.id);
      socket.emit('authOk', { token, account: db.toPublic(account) });
    } catch (e) {
      console.error('login error:', e.message);
      socket.emit('authError', { msg: 'Something went wrong logging in. Try again.' });
    }
  });

  socket.on('resumeSession', async ({ token }) => {
    if (!DB_ENABLED || !token) return;
    try {
      const account = await db.findAccountByToken(token);
      if (account) {
        attachAccountSocket(socket, account.id);
        socket.emit('authOk', { token, account: db.toPublic(account) });
      }
    } catch (e) {
      console.error('resumeSession error:', e.message);
    }
  });

  socket.on('logout', async ({ token }) => {
    if (!DB_ENABLED || !token) return;
    detachAccountSocket(socket);
    try { await db.deleteSession(token); } catch (e) { /* not actionable client-side */ }
  });

  socket.on('updateProfile', async ({ token, nickname, avatar }) => {
    if (!DB_ENABLED || !token) return;
    const nick = String(nickname || '').trim().slice(0, 16);
    if (!nick) return socket.emit('authError', { msg: 'Pick a nickname first.' });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('authError', { msg: 'Your session expired — log in again.' });
      // sanitizeAvatar only checks the id is a KNOWN portrait/emoji — it
      // doesn't know about price. A crafted message asking for a locked
      // portrait avatar is re-validated here, same "server re-derives
      // unlock state" rule saveCosmetics already applies to every other
      // cosmetic: fall back to whatever they were already wearing rather
      // than erroring out and blocking the nickname change too.
      let finalAvatar = sanitizeAvatar(avatar);
      if (finalAvatar) {
        const { catalog } = await loadPlayerCosmetics(account.id);
        const found = catalog.avatars.find(a => a.id === finalAvatar);
        if (found && !found.unlocked) finalAvatar = account.avatar;
      }
      const updated = await db.updateProfile(account.id, { nickname: nick, avatar: finalAvatar });
      socket.emit('authOk', { token, account: db.toPublic(updated) });
    } catch (e) {
      console.error('updateProfile error:', e.message);
      socket.emit('authError', { msg: 'Could not save your profile. Try again.' });
    }
  });

  // Sets or changes the recovery email on the CURRENTLY logged-in
  // account — not part of signup, so it works for existing accounts that
  // predate this column too. Re-uses the authOk/authError pair
  // updateProfile does, since the client-side shape (an updated account
  // object) is identical.
  socket.on('updateEmail', async ({ token, email }) => {
    if (!DB_ENABLED || !token) return;
    const e2 = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(e2)) return socket.emit('authError', { msg: 'That doesn\'t look like a valid email address.' });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('authError', { msg: 'Your session expired — log in again.' });
      const existing = await db.findAccountByEmail(e2);
      if (existing && existing.id !== account.id) {
        return socket.emit('authError', { msg: 'That email is already on another account.' });
      }
      const updated = await db.setAccountEmail(account.id, e2);
      socket.emit('authOk', { token, account: db.toPublic(updated) });
    } catch (e) {
      console.error('updateEmail error:', e.message);
      socket.emit('authError', { msg: 'Could not save that email. Try again.' });
    }
  });

  // ── Password recovery ───────────────────────────────────────
  // Deliberately logged-OUT flows — a locked-out player has no token.
  // Always emits the SAME generic success message whether or not the
  // email matched an account, so this can't be used to test which emails
  // have accounts here (the classic account-enumeration leak). The only
  // branch that differs is entirely server-side (whether an email actually
  // goes out).
  socket.on('requestPasswordReset', async ({ email }) => {
    if (!DB_ENABLED) return socket.emit('authError', { msg: 'Accounts aren\'t set up on this server yet.' });
    const e2 = String(email || '').trim().toLowerCase();
    const GENERIC_OK = { msg: 'If that email is on an account, a reset link is on its way.' };
    if (!EMAIL_RE.test(e2)) return socket.emit('authError', { msg: 'That doesn\'t look like a valid email address.' });
    if (resetRequestRateLimited(e2)) {
      // Same generic message, not a rate-limit-specific one — telling an
      // attacker "you're rate limited" still confirms the endpoint is
      // being hit; better to look identical to the success case.
      return socket.emit('passwordResetRequested', GENERIC_OK);
    }
    recordResetRequestAttempt(e2);
    try {
      const account = await db.findAccountByEmail(e2);
      if (account) {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        await db.createPasswordReset(account.id, tokenHash);
        const resetUrl = `${PUBLIC_URL}/?resetToken=${rawToken}`;
        sendPasswordResetEmail(account.email, resetUrl).catch(() => {});
      }
      socket.emit('passwordResetRequested', GENERIC_OK);
    } catch (e) {
      console.error('requestPasswordReset error:', e.message);
      // Still generic — an internal error here shouldn't tell the caller
      // anything more than "try again later" would.
      socket.emit('passwordResetRequested', GENERIC_OK);
    }
  });

  socket.on('resetPassword', async ({ token: rawToken, password }) => {
    if (!DB_ENABLED) return socket.emit('authError', { msg: 'Accounts aren\'t set up on this server yet.' });
    const p = String(password || '');
    const t = String(rawToken || '');
    if (!t) return socket.emit('authError', { msg: 'Missing or invalid reset link.' });
    if (p.length < 6) return socket.emit('authError', { msg: 'Password needs to be at least 6 characters.' });
    try {
      const tokenHash = crypto.createHash('sha256').update(t).digest('hex');
      const reset = await db.findValidPasswordReset(tokenHash);
      if (!reset) {
        return socket.emit('authError', { msg: 'This reset link is invalid or has expired — request a new one.' });
      }
      const passwordHash = await bcrypt.hash(p, 10);
      await db.updatePassword(reset.account_id, passwordHash);
      await db.usePasswordReset(tokenHash);
      // Every existing session is signed out, including this one if it
      // happened to be logged in elsewhere — the same "changing your
      // password logs you out everywhere" convention most accounts use.
      await db.deleteSessionsForAccount(reset.account_id);
      socket.emit('passwordResetOk', { msg: 'Password changed — log in with your new password.' });
    } catch (e) {
      console.error('resetPassword error:', e.message);
      socket.emit('authError', { msg: 'Could not reset your password. Try again.' });
    }
  });

  // ── Friends ──────────────────────────────────────────────────
  socket.on('getFriendCode', async ({ token }) => {
    if (!DB_ENABLED || !token) return;
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendsError', { msg: 'Your session expired — log in again.' });
      const code = await db.getOrCreateFriendCode(account.id);
      socket.emit('friendCodeOk', { code });
    } catch (e) {
      console.error('getFriendCode error:', e.message);
      socket.emit('friendsError', { msg: 'Could not load your friend code. Try again.' });
    }
  });

  socket.on('getFriends', async ({ token }) => {
    if (!DB_ENABLED || !token) return socket.emit('friendsError', { msg: 'Accounts aren\'t set up on this server yet.' });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendsError', { msg: 'Your session expired — log in again.' });
      const friends = await db.getFriends(account.id);
      socket.emit('friendsOk', {
        friends: friends.map(f => ({ ...f, online: accountSockets.has(f.id) })),
      });
    } catch (e) {
      console.error('getFriends error:', e.message);
      socket.emit('friendsError', { msg: 'Could not load your friends. Try again.' });
    }
  });

  socket.on('addFriendByCode', async ({ token, code }) => {
    if (!DB_ENABLED || !token) return socket.emit('friendsError', { msg: 'Accounts aren\'t set up on this server yet.' });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendsError', { msg: 'Your session expired — log in again.' });
      const c = String(code || '').trim();
      if (!c) return socket.emit('friendsError', { msg: 'Enter a friend code first.' });
      const target = await db.findAccountByFriendCode(c);
      if (!target) return socket.emit('friendsError', { msg: 'No player found with that code.' });
      if (target.id === account.id) return socket.emit('friendsError', { msg: "That's your own code." });
      await db.addFriend(account.id, target.id);
      const friends = await db.getFriends(account.id);
      socket.emit('friendsOk', { friends: friends.map(f => ({ ...f, online: accountSockets.has(f.id) })) });
      // Tell the other side too, live, if they're online right now — no
      // need to wait for them to reload their own Friends tab to see it.
      notifySocketsForAccount(target.id, 'friendAdded', {
        id: account.id, nickname: account.nickname, avatar: account.avatar, online: true,
      });
    } catch (e) {
      console.error('addFriendByCode error:', e.message);
      socket.emit('friendsError', { msg: 'Could not add that friend. Try again.' });
    }
  });

  socket.on('removeFriend', async ({ token, friendId }) => {
    if (!DB_ENABLED || !token) return;
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendsError', { msg: 'Your session expired — log in again.' });
      await db.removeFriend(account.id, Number(friendId));
      const friends = await db.getFriends(account.id);
      socket.emit('friendsOk', { friends: friends.map(f => ({ ...f, online: accountSockets.has(f.id) })) });
    } catch (e) {
      console.error('removeFriend error:', e.message);
      socket.emit('friendsError', { msg: 'Could not remove that friend. Try again.' });
    }
  });

  // ── Friend requests ──
  // The profile card's "Add Friend" button — unlike addFriendByCode above,
  // this doesn't add anyone outright; it creates a pending row the TARGET
  // has to accept. Reuses the same friendsOk/friendAdded shape addFriendByCode
  // already emits for the mutual/auto-accept case, so the client's existing
  // listeners for those need nothing new.
  socket.on('sendFriendRequest', async ({ token, targetId }) => {
    if (!DB_ENABLED || !token) return socket.emit('friendsError', { msg: 'Accounts aren\'t set up on this server yet.' });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendsError', { msg: 'Your session expired — log in again.' });
      const tid = Number(targetId);
      if (!Number.isInteger(tid)) return socket.emit('friendsError', { msg: 'Unknown player.' });
      const targetAccount = await db.findAccountById(tid);
      if (!targetAccount) return socket.emit('friendsError', { msg: 'That player no longer exists.' });
      const res = await db.sendFriendRequest(account.id, tid);
      if (!res.ok) {
        return socket.emit('friendsError', { msg: res.reason === 'self' ? "That's you." : "You're already friends." });
      }
      if (res.autoAccepted) {
        // They'd already sent ME one — this just completed it, same
        // instant-mutual result as addFriendByCode.
        const friends = await db.getFriends(account.id);
        socket.emit('friendsOk', { friends: friends.map(f => ({ ...f, online: accountSockets.has(f.id) })) });
        socket.emit('friendRequestStatus', { targetId: tid, status: 'friends' });
        notifySocketsForAccount(tid, 'friendAdded', {
          id: account.id, nickname: account.nickname, avatar: account.avatar, online: true,
        });
      } else {
        socket.emit('friendRequestStatus', { targetId: tid, status: 'outgoing' });
        notifySocketsForAccount(tid, 'friendRequestReceived', {
          id: account.id, nickname: account.nickname, avatar: account.avatar,
        });
      }
    } catch (e) {
      console.error('sendFriendRequest error:', e.message);
      socket.emit('friendsError', { msg: 'Could not send that request. Try again.' });
    }
  });

  socket.on('acceptFriendRequest', async ({ token, requesterId }) => {
    if (!DB_ENABLED || !token) return;
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendsError', { msg: 'Your session expired — log in again.' });
      const rid = Number(requesterId);
      if (!Number.isInteger(rid)) return;
      await db.acceptFriendRequest(account.id, rid);
      const friends = await db.getFriends(account.id);
      socket.emit('friendsOk', { friends: friends.map(f => ({ ...f, online: accountSockets.has(f.id) })) });
      socket.emit('friendRequestsOk', { requests: await db.getIncomingFriendRequests(account.id) });
      socket.emit('friendRequestStatus', { targetId: rid, status: 'friends' });
      notifySocketsForAccount(rid, 'friendRequestAccepted', {
        id: account.id, nickname: account.nickname, avatar: account.avatar, online: true,
      });
    } catch (e) {
      console.error('acceptFriendRequest error:', e.message);
      socket.emit('friendsError', { msg: 'Could not accept that request. Try again.' });
    }
  });

  socket.on('declineFriendRequest', async ({ token, requesterId }) => {
    if (!DB_ENABLED || !token) return;
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendsError', { msg: 'Your session expired — log in again.' });
      const rid = Number(requesterId);
      if (!Number.isInteger(rid)) return;
      await db.declineFriendRequest(account.id, rid);
      socket.emit('friendRequestsOk', { requests: await db.getIncomingFriendRequests(account.id) });
      socket.emit('friendRequestStatus', { targetId: rid, status: 'none' });
    } catch (e) {
      console.error('declineFriendRequest error:', e.message);
      socket.emit('friendsError', { msg: 'Could not decline that request. Try again.' });
    }
  });

  // The "Request Sent" button on the profile card doubles as a cancel —
  // tapping it again withdraws the ask, same toggle-off feel as tapping
  // an already-selected avatar in the picker.
  socket.on('cancelFriendRequest', async ({ token, targetId }) => {
    if (!DB_ENABLED || !token) return;
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendsError', { msg: 'Your session expired — log in again.' });
      const tid = Number(targetId);
      if (!Number.isInteger(tid)) return;
      await db.cancelFriendRequest(account.id, tid);
      socket.emit('friendRequestStatus', { targetId: tid, status: 'none' });
    } catch (e) {
      console.error('cancelFriendRequest error:', e.message);
      socket.emit('friendsError', { msg: 'Could not cancel that request. Try again.' });
    }
  });

  socket.on('getFriendRequests', async ({ token }) => {
    if (!DB_ENABLED || !token) return;
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendsError', { msg: 'Your session expired — log in again.' });
      socket.emit('friendRequestsOk', { requests: await db.getIncomingFriendRequests(account.id) });
    } catch (e) {
      console.error('getFriendRequests error:', e.message);
      socket.emit('friendsError', { msg: 'Could not load your requests. Try again.' });
    }
  });

  // Invites a friend into the room the sender is currently seated in —
  // it deliberately does NOT create a room on the friend's behalf; that
  // keeps this from having to duplicate createRoom's seating/AI/options
  // logic. If the sender isn't in a live casual room, the honest answer
  // is "go create or join one first, then invite from the lobby".
  socket.on('inviteFriend', async ({ token, friendId, code }) => {
    if (!DB_ENABLED || !token) return;
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendsError', { msg: 'Your session expired — log in again.' });
      const G = findRoom(code);
      if (!G || G.ranked || G.daily) {
        return socket.emit('friendsError', { msg: 'Create or join a casual room first, then invite from the lobby.' });
      }
      const inRoom = G.players.some(p => p.socketId === socket.id);
      if (!inRoom) return socket.emit('friendsError', { msg: "That's not your room." });
      const isFriend = await db.areFriends(account.id, Number(friendId));
      if (!isFriend) return socket.emit('friendsError', { msg: 'Not on your friends list.' });
      const sent = notifySocketsForAccount(Number(friendId), 'friendInvite', {
        code: G.code, fromName: account.nickname, fromAvatar: account.avatar || '',
      });
      if (sent) socket.emit('friendInviteSent', { friendId: Number(friendId) });
      else socket.emit('friendsError', { msg: "They're not online right now." });
    } catch (e) {
      console.error('inviteFriend error:', e.message);
      socket.emit('friendsError', { msg: 'Could not send the invite. Try again.' });
    }
  });

  // The friend-card popup: rank, equipped cosmetics, casual + ranked
  // stats for someone ELSE's account. `getFriendProfile` is gated on
  // friendship; `getPlayerProfile` below is the same card opened from a
  // lobby seat or the daily leaderboard, where a playerId is discovered
  // without any friendship at all, so it's gated on login instead. Both
  // funnel into emitProfileCard so the two gates can't drift apart in
  // what they actually send.
  // Deliberately sends only IDs for cosmetics (equipped.rankSet/crest/
  // scene), not a full catalog — RANK_COSMETICS/CREST_ART/SCENE art are
  // static registries already mirrored client-side (same contract the
  // table seats' rankMaterial/title already rely on), so the client can
  // render all of it from an id alone. titleName is the one exception,
  // resolved here via the same titleNameFor() a seat join uses, since
  // title *display strings* aren't otherwise duplicated client-side.
  async function emitProfileCard(sock, targetId, viewerId) {
    const fid = Number(targetId);
    if (!Number.isInteger(fid)) return sock.emit('friendProfileError', { msg: 'Unknown player.' });
    const targetAccount = await db.findAccountById(fid);
    if (!targetAccount) return sock.emit('friendProfileError', { msg: 'That player no longer exists.' });
    const [rankedProfile, stats, rankedStats, cos, friendStatus] = await Promise.all([
      db.getOrCreateRankedProfile(fid),
      db.getStats(fid),
      db.getRankedStats(fid),
      loadPlayerCosmetics(fid),
      db.getFriendRequestStatus(viewerId, fid),
    ]);
    const isPlacement = rankedProfile.placementGamesPlayed < 5;
    sock.emit('friendProfileOk', {
      id: fid,
      nickname: targetAccount.nickname,
      avatar: targetAccount.avatar,
      online: accountSockets.has(fid),
      rank: isPlacement ? null : rankForMmr(rankedProfile.mmr),
      isPlacement,
      placementGamesPlayed: rankedProfile.placementGamesPlayed,
      stats, rankedStats,
      equipped: cos.equipped,
      titleName: titleNameFor(cos.equipped.title),
      // Unlocked achievements only — an unearned secret's name/desc is
      // already blanked by evaluateAchievements, but there's no reason
      // to hand another player's client the locked half at all.
      crests: cos.achievements.filter(a => a.unlocked).map(a => ({
        id: a.id, name: a.name, crest: a.crest, level: a.level, maxLevel: a.maxLevel,
      })),
      // Drives the Add Friend / Request Sent / Accept-Decline button on
      // the card — always 'friends' on the getFriendProfile path below
      // (it's gated on friendship already), the interesting values show
      // up via getPlayerProfile, where the viewer and target have no
      // established relationship yet.
      friendStatus,
    });
  }
  socket.on('getFriendProfile', async ({ token, friendId }) => {
    if (!DB_ENABLED || !token) return socket.emit('friendProfileError', { msg: 'Accounts aren\'t set up on this server yet.' });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendProfileError', { msg: 'Your session expired — log in again.' });
      const fid = Number(friendId);
      if (!Number.isInteger(fid)) return socket.emit('friendProfileError', { msg: 'Unknown player.' });
      const isFriend = await db.areFriends(account.id, fid);
      if (!isFriend) return socket.emit('friendProfileError', { msg: 'Not on your friends list.' });
      await emitProfileCard(socket, fid, account.id);
    } catch (e) {
      console.error('getFriendProfile error:', e.message);
      socket.emit('friendProfileError', { msg: 'Could not load that profile. Try again.' });
    }
  });
  // Opened by tapping a seat in the game lobby or a row on the daily
  // leaderboard — both already hand the client a real accountId
  // (publicState's players[].accountId, and dailyLeaderboardOk's
  // rows[].accountId/you.accountId), neither of which implies any
  // friendship. Gated on being logged in at all, not on friendship —
  // a lobby opponent or a leaderboard entry is never a friend by
  // definition, so reusing getFriendProfile's gate would just always
  // reject.
  socket.on('getPlayerProfile', async ({ token, playerId }) => {
    if (!DB_ENABLED || !token) return socket.emit('friendProfileError', { msg: 'Accounts aren\'t set up on this server yet.' });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('friendProfileError', { msg: 'Your session expired — log in again.' });
      await emitProfileCard(socket, playerId, account.id);
    } catch (e) {
      console.error('getPlayerProfile error:', e.message);
      socket.emit('friendProfileError', { msg: 'Could not load that profile. Try again.' });
    }
  });

  socket.on('getStats', async ({ token }) => {
    if (!DB_ENABLED || !token) return socket.emit('statsError', { msg: 'Accounts aren\'t set up on this server yet.' });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('statsError', { msg: 'Your session expired — log in again.' });
      const stats = await db.getStats(account.id);
      socket.emit('statsOk', { stats });
    } catch (e) {
      console.error('getStats error:', e.message);
      socket.emit('statsError', { msg: 'Could not load your stats. Try again.' });
    }
  });

  socket.on('getRankedStats', async ({ token }) => {
    if (!DB_ENABLED || !token) return socket.emit('rankedStatsError', { msg: 'Accounts aren\'t set up on this server yet.' });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('rankedStatsError', { msg: 'Your session expired — log in again.' });
      const stats = await db.getRankedStats(account.id);
      socket.emit('rankedStatsOk', { stats });
    } catch (e) {
      console.error('getRankedStats error:', e.message);
      socket.emit('rankedStatsError', { msg: 'Could not load your ranked stats. Try again.' });
    }
  });

  // ── Achievements & cosmetics ─────────────────────────────────
  // One event covers both: the account screen always needs the unlock
  // state and the equipped set together (a picker can't render either
  // half on its own), and unlock state is derived from the same query
  // the achievement list needs anyway.
  socket.on('getProfileCosmetics', async ({ token }) => {
    if (!DB_ENABLED || !token) {
      return socket.emit('profileCosmeticsError', { msg: 'Accounts aren\'t set up on this server yet.' });
    }
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('profileCosmeticsError', { msg: 'Your session expired — log in again.' });
      const { achievements, catalog, equipped, fresh, credits } = await loadPlayerCosmetics(account.id);
      socket.emit('profileCosmeticsOk', { achievements, catalog, equipped, fresh, credits });
    } catch (e) {
      console.error('getProfileCosmetics error:', e.message);
      socket.emit('profileCosmeticsError', { msg: 'Could not load your collection. Try again.' });
    }
  });

  // Every incoming ID is re-checked against a freshly evaluated unlock
  // set — the client's copy of the catalog is presentation only and is
  // never trusted. An unrecognised or still-locked ID is dropped rather
  // than rejected outright, so a partially-stale client (one that hasn't
  // reloaded since a cosmetic was renamed) still saves the fields it got
  // right instead of failing the whole request.
  socket.on('saveCosmetics', async ({ token, scene, cardFront, crest, crest2, title, rankSet, tableTheme }) => {
    if (!DB_ENABLED || !token) return;
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('profileCosmeticsError', { msg: 'Your session expired — log in again.' });
      const { catalog } = await loadPlayerCosmetics(account.id);
      const pick = (list, id) => {
        if (id === undefined) return undefined;          // field not being changed
        if (!id) return '';                              // explicit unequip
        const found = list.find(c => c.id === id);
        return found && found.unlocked ? id : undefined; // locked/unknown: leave as-is
      };
      await db.saveCosmetics(account.id, {
        scene: pick(catalog.scenes, scene),
        cardFront: pick(catalog.cardFronts, cardFront),
        crest: pick(catalog.crests, crest),
        crest2: pick(catalog.crests, crest2),
        title: pick(catalog.titles, title),
        rankSet: pick(catalog.rankSets, rankSet),
        tableTheme: pick(catalog.tableThemes, tableTheme),
      });
      const after = await loadPlayerCosmetics(account.id);
      socket.emit('profileCosmeticsOk', {
        achievements: after.achievements, catalog: after.catalog,
        equipped: after.equipped, fresh: after.fresh, credits: after.credits, saved: true,
      });
    } catch (e) {
      console.error('saveCosmetics error:', e.message);
      socket.emit('profileCosmeticsError', { msg: 'Could not save that. Try again.' });
    }
  });

  // Balance on its own, for the main-menu box — much cheaper than the full
  // cosmetics payload, which is what the account screen uses.
  socket.on('getCredits', async ({ token }) => {
    if (!DB_ENABLED || !token) return socket.emit('creditsOk', { balance: 0, lifetime: 0, guest: true });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('creditsOk', { balance: 0, lifetime: 0, guest: true });
      socket.emit('creditsOk', await db.getCredits(account.id));
    } catch (e) {
      console.error('getCredits error:', e.message);
    }
  });

  // The purchase. Price comes from THIS registry, never from the client —
  // the client's catalog copy is presentation only, exactly like the unlock
  // state it renders. Both the price and whether an item is purchasable at
  // all are re-derived here, so a crafted message can't buy a crest, buy a
  // rank set, or set its own price.
  socket.on('buyCosmetic', async ({ token, itemId }) => {
    if (!DB_ENABLED || !token) return socket.emit('shopError', { msg: "Accounts aren't set up on this server yet." });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('shopError', { msg: 'Your session expired — log in again.' });
      // Only the four purchasable categories are even searched, so an id
      // from any other category simply isn't found.
      const item = [...COSMETICS.scenes, ...COSMETICS.cardFronts, ...COSMETICS.tableThemes, ...COSMETICS.avatars].find(c => c.id === itemId);
      if (!item || !item.price) return socket.emit('shopError', { msg: "That item isn't for sale." });
      const res = await db.purchaseItem(account.id, item.id, item.price);
      if (!res.ok) {
        return socket.emit('shopError', {
          msg: res.reason === 'funds' ? 'Not enough credits yet.' : 'You already own that.',
        });
      }
      const after = await loadPlayerCosmetics(account.id);
      socket.emit('shopOk', { itemId: item.id, name: item.name, price: item.price, balance: res.balance });
      socket.emit('profileCosmeticsOk', {
        achievements: after.achievements, catalog: after.catalog,
        equipped: after.equipped, fresh: after.fresh, credits: after.credits,
      });
    } catch (e) {
      console.error('buyCosmetic error:', e.message);
      socket.emit('shopError', { msg: 'Could not complete that purchase. Try again.' });
    }
  });

  // Fire-and-forget: the client calls this once it has shown the unlock
  // celebration for a set of achievements, so they're not celebrated
  // again on the next visit.
  socket.on('markAchievementsSeen', async ({ token, ids }) => {
    if (!DB_ENABLED || !token || !Array.isArray(ids) || !ids.length) return;
    const valid = ids.filter(id => ACHIEVEMENTS.some(a => a.id === id));
    if (!valid.length) return;
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return;
      await db.markAchievementsSeen(account.id, valid);
    } catch (e) {
      console.error('markAchievementsSeen error:', e.message);
    }
  });

  socket.on('getRankedProfile', async ({ token }) => {
    if (!DB_ENABLED || !token) return socket.emit('rankedProfileError', { msg: 'Accounts aren\'t set up on this server yet.' });
    try {
      const account = await db.findAccountByToken(token);
      if (!account) return socket.emit('rankedProfileError', { msg: 'Your session expired — log in again.' });
      const { mmr, placementGamesPlayed } = await db.getOrCreateRankedProfile(account.id);
      const isPlacement = placementGamesPlayed < 5;
      socket.emit('rankedProfileOk', {
        mmr, placementGamesPlayed, isPlacement,
        rank: isPlacement ? null : rankForMmr(mmr),
      });
    } catch (e) {
      console.error('getRankedProfile error:', e.message);
      socket.emit('rankedProfileError', { msg: 'Could not load your rank. Try again.' });
    }
  });

  socket.on('getLeaderboard', async ({ token } = {}) => {
    if (!DB_ENABLED) return socket.emit('leaderboardError', { msg: 'Accounts aren\'t set up on this server yet.' });
    try {
      const LEADERBOARD_LIMIT = 100;
      const raw = await db.getLeaderboard(LEADERBOARD_LIMIT);
      const rows = raw.map(r => {
        const isPlacement = r.placementGamesPlayed < 5;
        return {
          accountId: r.accountId, nickname: r.nickname, avatar: r.avatar, mmr: r.mmr,
          isPlacement, placementGamesPlayed: r.placementGamesPlayed,
          rank: isPlacement ? null : rankForMmr(r.mmr),
        };
      });

      // If the requester is logged in and isn't visible in the top slice
      // above, look up their overall position so the client can pin a
      // "you" row at the bottom instead of leaving them wondering.
      let you = null;
      const acct = await lookupAccountByToken(token);
      if (acct && !rows.some(r => r.accountId === acct.id)) {
        const pos = await db.getRankForAccount(acct.id);
        if (pos) {
          const isPlacement = pos.placementGamesPlayed < 5;
          you = {
            position: pos.position, nickname: acct.nickname, avatar: acct.avatar, mmr: pos.mmr,
            isPlacement, placementGamesPlayed: pos.placementGamesPlayed,
            rank: isPlacement ? null : rankForMmr(pos.mmr),
          };
        }
      }

      socket.emit('leaderboardOk', { rows, you });
    } catch (e) {
      console.error('getLeaderboard error:', e.message);
      socket.emit('leaderboardError', { msg: 'Could not load the leaderboard. Try again.' });
    }
  });

  socket.on('joinRankedQueue', async ({ accountToken }) => {
    if (!DB_ENABLED) return socket.emit('errorMsg', { msg: 'Ranked isn\'t available on this server yet.' });
    const acct = await lookupAccountByToken(accountToken);
    if (!acct) return socket.emit('errorMsg', { msg: 'Log in to play ranked.' });
    if (rankedQueue.some(q => q.socketId === socket.id)) return;
    const { mmr, placementGamesPlayed } = await db.getOrCreateRankedProfile(acct.id);
    rankedQueue.push({
      socketId: socket.id, accountId: acct.id,
      name: acct.nickname, avatar: acct.avatar, seatCos: await lookupSeatCosmetics(acct.id),
      mmr, placementGamesPlayed, queuedAt: Date.now(),
    });
    socket.emit('rankedQueueUpdate', { elapsedMs: 0, radius: RANKED_MIN_RADIUS, queueSize: rankedQueue.length });
  });

  socket.on('leaveRankedQueue', () => {
    const idx = rankedQueue.findIndex(q => q.socketId === socket.id);
    if (idx !== -1) rankedQueue.splice(idx, 1);
  });

  // ── Daily Challenge ──
  // Whether today's hand is still available, plus streak and standing.
  // Works for guests too (everything account-shaped just comes back null).
  socket.on('getDailyStatus', async ({ accountToken }) => {
    const date = dailyDateKey();
    // Today's pass direction is public before you play — you'd see it on
    // the pass screen anyway, so it confers nothing, and showing it is
    // what makes "the whole hand changes daily" visible on the tile.
    const passDir = dailyPassDir(date);
    const acct = await lookupAccountByToken(accountToken);
    if (!DB_ENABLED || !acct) {
      return socket.emit('dailyStatus', {
        date, passDir, guest: true, playedToday: false, score: null,
        streak: 0, bestStreak: 0, position: null, entries: null,
      });
    }
    try {
      const mine = await db.getDailyScore(acct.id, date);
      const streak = await db.getDailyStreak(acct.id, date);
      const standing = mine ? await db.getDailyStanding(acct.id, date) : null;
      socket.emit('dailyStatus', {
        date, passDir, guest: false,
        playedToday: !!mine,
        score: mine ? mine.score : null,
        tricksWon: mine ? mine.tricksWon : null,
        shotMoon: mine ? mine.shotMoon : false,
        streak: streak.streak, bestStreak: streak.bestStreak,
        position: standing ? standing.position : null,
        entries: standing ? standing.entries : null,
      });
    } catch (e) {
      console.error('getDailyStatus error:', e.message);
      socket.emit('dailyError', { msg: "Couldn't load today's challenge. Try again." });
    }
  });

  // Gated on the REQUESTER having finished TODAY's hand first — same
  // "don't leak information about a challenge you haven't attempted yet"
  // reasoning as the campaign level-detail popup's friends' scores.
  // Resets for free every day: `mine` is looked up against dailyDateKey(),
  // so a new day with no score yet is locked again with no extra state to
  // clear. Enforced here, not just hidden client-side, same "don't trust
  // the client to hide it" reasoning as getCampaignFriendsResults.
  socket.on('getDailyLeaderboard', async ({ accountToken }) => {
    const date = dailyDateKey();
    if (!DB_ENABLED) return socket.emit('dailyLeaderboardOk', { date, rows: [], you: null, locked: false });
    try {
      const acct = await lookupAccountByToken(accountToken);
      // Guests can play but nothing is banked for them (see the Daily
      // Challenge section of CLAUDE.md), so there's never a finished-today
      // score to unlock the board with — always locked for a guest.
      const mine = acct ? await db.getDailyScore(acct.id, date) : null;
      if (!mine) return socket.emit('dailyLeaderboardOk', { date, rows: [], you: null, locked: true });
      const rows = await db.getDailyLeaderboard(date, 100);
      // Sent whenever the player has a score today, even if they're
      // already visible in the top 100 — the client pins it to the bottom
      // of the board as a permanent "you are here", not as an
      // outside-the-list fallback the way the ranked ladder does.
      const standing = await db.getDailyStanding(acct.id, date);
      const you = standing ? {
        accountId: acct.id, position: standing.position, entries: standing.entries,
        nickname: acct.nickname, avatar: acct.avatar, score: standing.score,
      } : null;
      socket.emit('dailyLeaderboardOk', { date, rows, you, locked: false });
    } catch (e) {
      console.error('getDailyLeaderboard error:', e.message);
      socket.emit('dailyError', { msg: "Couldn't load the leaderboard. Try again." });
    }
  });

  socket.on('startDailyChallenge', async ({ name, avatar, accountToken }) => {
    const date = dailyDateKey();
    const clean = String(name || '').trim().slice(0, 16) || 'Player';
    const acct = await lookupAccountByToken(accountToken);
    // One attempt per account per day. The UNIQUE constraint on
    // (account_id, challenge_date) is the real enforcement; this is just
    // the friendly refusal before a hand is dealt.
    if (DB_ENABLED && acct) {
      try {
        const mine = await db.getDailyScore(acct.id, date);
        if (mine) return socket.emit('dailyError', { msg: "You've already played today's challenge. Come back tomorrow." });
      } catch (e) { /* a lookup blip shouldn't block play — the UNIQUE constraint still holds */ }
    }
    const { G, token } = createDailyRoom(clean, sanitizeAvatar(avatar), acct ? acct.id : null, socket.id);
    if (acct) Object.assign(G.players[0], await lookupSeatCosmetics(acct.id));
    socket.join(G.code);
    socket.emit('joined', { code: G.code, playerIndex: 0, token, isHost: true });
    dealRound(G);   // no seat draw, no dealer cut, no pass phase — straight into the hand
  });

  // ── Campaign Mode ────────────────────────────────────────────────
  // Account-gated, no guest path — a campaign level's whole point is
  // persisted progress (unlocks, best results, attempts, story seen),
  // which a guest session can't carry, unlike Daily Challenge's "guest
  // can play, nothing saves" pattern.
  socket.on('getCampaignState', async ({ accountToken }) => {
    if (!DB_ENABLED) return socket.emit('campaignStateErr', { msg: 'Campaign needs an account.' });
    const acct = await lookupAccountByToken(accountToken);
    if (!acct) return socket.emit('campaignStateErr', { msg: 'Log in to play Campaign Mode.' });
    try {
      const payload = await buildCampaignMapPayload(acct.id);
      socket.emit('campaignStateOk', payload);
    } catch (e) {
      console.error('getCampaignState error:', e.message);
      socket.emit('campaignStateErr', { msg: "Couldn't load Campaign. Try again." });
    }
  });

  socket.on('markCampaignCuesSeen', async ({ accountToken, ids }) => {
    if (!DB_ENABLED || !Array.isArray(ids) || !ids.length) return;
    const acct = await lookupAccountByToken(accountToken);
    if (!acct) return;
    trackStat(() => db.markCampaignCuesSeen(acct.id, ids.slice(0, 50).map(String)));
  });

  // For the level-detail popup's Friends section. Guests and DB-disabled
  // both degrade to an empty list rather than an error — same "nothing
  // to show" pattern as getDailyStatus's guest branch. `locked` is true
  // only when the requester hasn't cleared this level yet themselves —
  // see getCampaignFriendsResults' own note on why that's enforced in
  // the DB layer, not just left to the client to hide.
  socket.on('getCampaignLevelFriends', async ({ accountToken, levelId }) => {
    const lvl = Number(levelId);
    if (!DB_ENABLED) return socket.emit('campaignLevelFriendsOk', { levelId: lvl, rows: [], locked: false });
    const acct = await lookupAccountByToken(accountToken);
    if (!acct) return socket.emit('campaignLevelFriendsOk', { levelId: lvl, rows: [], locked: false });
    try {
      const { locked, rows } = await db.getCampaignFriendsResults(acct.id, lvl);
      socket.emit('campaignLevelFriendsOk', { levelId: lvl, rows, locked });
    } catch (e) {
      console.error('getCampaignLevelFriends error:', e.message);
      socket.emit('campaignLevelFriendsOk', { levelId: lvl, rows: [], locked: false });
    }
  });

  socket.on('startCampaignLevel', async ({ name, avatar, accountToken, levelId }) => {
    if (!DB_ENABLED) return socket.emit('campaignError', { msg: 'Campaign needs an account.' });
    const acct = await lookupAccountByToken(accountToken);
    if (!acct) return socket.emit('campaignError', { msg: 'Log in to play Campaign Mode.' });
    const level = campaignLevelById(Number(levelId));
    if (!level) return socket.emit('campaignError', { msg: 'Unknown level.' });
    // Everything below is in one try/catch, not just the DB calls — a
    // player reported the game freezing mid-hand, and dealRound/
    // createCampaignRoom (deck construction, cosmetics lookup) were
    // previously unguarded here. A throw from either used to become an
    // unhandled rejection with nothing sent back to the client, which
    // looks exactly like a hang from the player's side. See the global
    // uncaughtException/unhandledRejection handlers near server.listen
    // for the other half of this — this is the friendly-error half.
    try {
      const state = await db.getCampaignState(acct.id, CAMPAIGN_MAX_ATTEMPTS, CAMPAIGN_ATTEMPT_REFILL_MS);
      if (level.id > state.highestUnlockedLevel) {
        return socket.emit('campaignError', { msg: 'That table is still locked.' });
      }
      if (!CAMPAIGN_UNLIMITED_ATTEMPTS) {
        const spend = await db.consumeCampaignAttempt(acct.id, CAMPAIGN_MAX_ATTEMPTS, CAMPAIGN_ATTEMPT_REFILL_MS);
        if (!spend.ok) return socket.emit('campaignError', { msg: 'Out of attempts — wait for a refill.' });
      }
      const clean = String(name || '').trim().slice(0, 16) || acct.nickname || 'Player';
      const { G, token } = await createCampaignRoom(clean, sanitizeAvatar(avatar), acct.id, socket.id, level.id);
      socket.join(G.code);
      socket.emit('joined', { code: G.code, playerIndex: 0, token, isHost: true });
      dealRound(G);   // no seat draw, no dealer cut for a campaign level either
    } catch (e) {
      console.error('startCampaignLevel error:', e.stack || e.message);
      return socket.emit('campaignError', { msg: "Couldn't start that table. Try again." });
    }
  });

  socket.on('createRoom', async ({ name, avatar, accountToken, roundsTotal }) => {
    const clean = String(name || '').trim().slice(0, 16) || 'Player';
    const acct = await lookupAccountByToken(accountToken);
    const G = createRoom(clean, sanitizeAvatar(avatar), acct ? acct.id : null,
                         { roundsTotal: sanitizeRoundsTotal(roundsTotal) });
    const token = makeToken();
    Object.assign(G.players[0], acct ? await lookupSeatCosmetics(acct.id) : NO_SEAT_COSMETICS);
    G.players[0].socketId = socket.id;
    G.players[0].connected = true;
    G.players[0].token = token;
    G.hostSocket = socket.id;
    G.hostToken = token;
    socket.join(G.code);
    socket.emit('joined', { code: G.code, playerIndex: 0, token, isHost: true });
    broadcastRoom(G);
  });

  socket.on('joinRoom', async ({ code, name, avatar, accountToken }) => {
    const G = findRoom(code);
    if (!G) return socket.emit('errorMsg', { msg: 'Room not found. Check the code.' });
    if (G.ranked) return socket.emit('errorMsg', { msg: 'Ranked seats are matched automatically.' });
    if (G.phase !== 'lobby') return socket.emit('errorMsg', { msg: 'That game has already started.' });

    let slot = -1;
    for (let i = 1; i < 4; i++) {
      if (!G.players[i].connected && !G.players[i].isAI) { slot = i; break; }
    }
    if (slot === -1) return socket.emit('errorMsg', { msg: 'That room is full.' });

    const acct = await lookupAccountByToken(accountToken);
    // Resolved BEFORE the seat-taken re-check below, not after: every
    // await here is a window in which another socket can claim the same
    // slot, and that check is what closes it. Awaiting anything between
    // it and the assignments would reopen exactly the race it exists for.
    const seatCos = acct ? await lookupSeatCosmetics(acct.id) : NO_SEAT_COSMETICS;
    if (!rooms[code] || G.players[slot].connected) return socket.emit('errorMsg', { msg: 'That seat just got taken — try again.' });

    const token = makeToken();
    G.players[slot].name = String(name || '').trim().slice(0, 16) || `Player ${slot + 1}`;
    G.players[slot].avatar = sanitizeAvatar(avatar);
    G.players[slot].accountId = acct ? acct.id : null;
    Object.assign(G.players[slot], seatCos);
    G.players[slot].socketId = socket.id;
    G.players[slot].connected = true;
    G.players[slot].token = token;
    socket.join(G.code);
    socket.emit('joined', { code: G.code, playerIndex: slot, token, isHost: false });
    broadcastRoom(G);
  });

  // Reconnect after the phone backgrounds / network blips
  socket.on('rejoin', ({ code, token }) => {
    const G = findRoom(code);
    if (!G) return socket.emit('rejoinFailed');
    const idx = G.players.findIndex(p => p.token && p.token === token);
    if (idx === -1) return socket.emit('rejoinFailed');
    G.players[idx].socketId = socket.id;
    G.players[idx].connected = true;
    if (G.ranked) { clearRankedTakeover(G, idx); G.players[idx].isAI = false; }
    const host = G.hostToken === token;
    if (host) G.hostSocket = socket.id;
    socket.join(G.code);
    socket.emit('joined', { code: G.code, playerIndex: idx, token, isHost: host });
    broadcastRoom(G);
  });

  socket.on('setAI', ({ code, slotIndex, isAI }) => {
    const G = findRoom(code);
    if (!G || G.ranked || G.phase !== 'lobby' || !isHostSocket(G, socket)) return;
    if (slotIndex < 1 || slotIndex > 3) return;
    const p = G.players[slotIndex];
    if (p.connected && !p.isAI) return; // a human is sitting there
    p.isAI = !!isAI;
    p.connected = !!isAI;
    p.name = isAI ? `Computer ${slotIndex + 1}` : 'Empty seat';
    p.avatar = null;
    p.accountId = null;
    p.token = null;
    p.socketId = null;
    broadcastRoom(G);
  });

  socket.on('startGame', ({ code }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'lobby' || !isHostSocket(G, socket)) return;
    if (!G.players.every(p => p.connected || p.isAI))
      return socket.emit('errorMsg', { msg: 'All four seats need a player or an AI.' });
    for (const p of G.players) {
      if (!p.accountId) continue;
      if (isBlitz(G)) trackStat(() => db.recordBlitzGameStarted(p.accountId));
      else trackStat(() => db.recordGameStarted(p.accountId));
    }
    startDraw(G, 1);
  });

  socket.on('revealDraw', ({ code, playerIndex }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'draw') return;
    if (G.players[playerIndex]?.socketId !== socket.id) return;
    revealDrawCard(G, playerIndex);
  });

  socket.on('startRound', ({ code }) => {
    const G = findRoom(code);
    if (!G || !isHostSocket(G, socket)) return;
    if (G.phase === 'draw1Done') { startDraw(G, 2); return; }
    if (G.phase === 'drawDone') { dealRound(G); return; }
  });

  socket.on('selectPass', ({ code, playerIndex, cards }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'pass') return;
    if (G.players[playerIndex]?.socketId !== socket.id) return;
    if (!Array.isArray(cards) || cards.length !== 2) return;
    if (eqC(cards[0], cards[1])) return;
    for (const c of cards) if (!G.players[playerIndex].hand.some(x => eqC(x, c))) return;
    G.passSelected[playerIndex] = cards;
    G.players[playerIndex].hasPassed = true;
    broadcastRoom(G);
    checkAllPassed(G);
  });

  socket.on('playCard', ({ code, playerIndex, card }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'play') return;
    if (G.currentTrick.length >= 4) return; // trick is full, waiting on resolveTrick — not anyone's turn
    if (G.players[playerIndex]?.socketId !== socket.id) return;
    if (playerIndex !== currentPlayer(G)) return;
    const real = G.players[playerIndex].hand.find(c => eqC(c, card));
    if (!real || !canPlay(G, playerIndex, real)) return;
    doPlayCard(G, playerIndex, real);
  });

  socket.on('confirmRound', ({ code, playerIndex }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'roundSummary' || !G.roundReady) return;
    if (G.players[playerIndex]?.socketId !== socket.id) return;
    if (G.roundReady[playerIndex]) return;
    G.roundReady[playerIndex] = true;
    if (!checkRoundReady(G)) broadcastRoom(G);
  });

  // Host asks to stop early. Everyone human has to agree; computers always do.
  socket.on('endGame', ({ code }) => {
    const G = findRoom(code);
    if (!G || !isHostSocket(G, socket)) return;
    if (G.phase === 'lobby' || G.phase === 'final') return;
    // Daily Challenge and Campaign are both single-hand-or-short attempts
    // with no partial-credit path — there's no "end early" that could
    // bank a partial score. Leaving abandons the attempt instead
    // (leaveRoom closes the room outright). Also moot for campaign in
    // practice since it's solo-vs-AI (votersNeeded is always empty), but
    // explicit here rather than relying on that.
    if (G.daily || G.campaign) return;
    if (G.endVote) return;

    const by = G.players.findIndex(p => p.socketId === socket.id);
    if (by === -1) return;

    const needed = votersNeeded(G, by);
    if (needed.length === 0) { finishEarly(G); return; }   // only computers left to ask

    G.endVote = { by, needed, agreed: [] };
    clearAuto(G);                                          // hold the round countdown
    clearVote(G);
    G.voteAt = Date.now() + END_VOTE_MS;
    G.voteTimer = setTimeout(() => {
      G.voteTimer = null; G.voteAt = 0;
      if (!rooms[G.code] || !G.endVote) return;
      cancelVote(G, 'No answer from everyone — the game carries on.');
    }, END_VOTE_MS);
    broadcastRoom(G);
  });

  socket.on('endVote', ({ code, agree }) => {
    const G = findRoom(code);
    if (!G || !G.endVote) return;
    const idx = G.players.findIndex(p => p.socketId === socket.id);
    if (idx === -1 || !G.endVote.needed.includes(idx)) return;

    if (!agree) {
      cancelVote(G, `${G.players[idx].name} would rather keep playing.`);
      return;
    }
    if (!G.endVote.agreed.includes(idx)) G.endVote.agreed.push(idx);
    if (!checkVoteComplete(G)) broadcastRoom(G);
  });

  socket.on('leaveRoom', ({ code }) => {
    const G = findRoom(code);
    if (!G) return;
    const idx = G.players.findIndex(p => p.socketId === socket.id);
    if (idx === -1) return;

    const wasHost = !!(G.hostToken && G.players[idx].token === G.hostToken);
    socket.leave(G.code);
    // The flag routes the client home correctly: a campaign player goes
    // back to the chapter map, not the casual landing screen. Read off G
    // here rather than client-side, since the room may be closed (and the
    // client's own state cleared) by the time this is handled.
    socket.emit('leftRoom', { campaign: !!G.campaign });

    if (G.phase === 'lobby' || G.phase === 'final') {
      // Free the seat entirely
      Object.assign(G.players[idx], {
        name: 'Empty seat', avatar: null, accountId: null, title: null, rankMaterial: null,
        crest: null, crestLevel: 1, crest2: null, crest2Level: 1,
        isAI: false, socketId: null, token: null,
        connected: false, score: 0, hand: [], tricks: [], hasPassed: false, suitsWon: [],
      });
    } else if (G.ranked) {
      // Ranked seats are never handed straight to AI — treat an explicit
      // leave like a disconnect: reserved, human-rejoinable by token, with
      // the same 15s grace period before the computer takes over.
      G.players[idx].socketId = null;
      G.players[idx].connected = false;
      scheduleRankedTakeover(G, idx);
    } else {
      // Mid-game: hand the seat to the computer so the others can finish
      Object.assign(G.players[idx], { isAI: true, avatar: null, accountId: null, title: null, rankMaterial: null, crest: null, crestLevel: 1, crest2: null, crest2Level: 1, connected: true, socketId: null, token: null });
    }

    if (wasHost) {
      const next = G.players.find(p => p.token && !p.isAI);
      G.hostToken  = next ? next.token : null;
      G.hostSocket = next ? next.socketId : null;
    }

    if (!G.players.some(p => p.token && !p.isAI)) { closeRoom(G, 'Everyone left the game.'); return; }

    // Keep any open "end early" request honest after a seat changes hands
    if (G.endVote) {
      if (G.endVote.by === idx) {
        cancelVote(G, 'The request to end early was dropped.');
      } else {
        G.endVote.needed = G.endVote.needed.filter(i => G.players[i].token && !G.players[i].isAI);
        G.endVote.agreed = G.endVote.agreed.filter(i => G.endVote.needed.includes(i));
        if (checkVoteComplete(G)) return;
      }
    }

    resumeAfterSeatChange(G);
    broadcastRoom(G);
  });

  socket.on('disconnect', () => {
    detachAccountSocket(socket);
    const qIdx = rankedQueue.findIndex(q => q.socketId === socket.id);
    if (qIdx !== -1) rankedQueue.splice(qIdx, 1);
    for (const code in rooms) {
      const G = rooms[code];
      for (let i = 0; i < 4; i++) {
        const p = G.players[i];
        if (p.socketId === socket.id) {
          p.socketId = null;
          p.connected = false;
          if (G.ranked && G.phase !== 'lobby' && G.phase !== 'final') scheduleRankedTakeover(G, i);
          broadcastRoom(G);
        }
      }
    }
  });
});

// Close rooms that have gone quiet, or that everyone has walked away from —
// except a solo player against AI opponents (casual only; ranked never has
// AI seats to begin with). That game is theirs to sit on for as long as
// they like — it only ends when they hit "Leave", never on a timer.
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    const G = rooms[code];

    // A Daily Challenge room is deliberately NOT covered by the
    // solo-vs-AI exemption below: it's a single five-minute hand, the
    // result is already banked in Postgres the moment it ends, and
    // there's nothing to come back to — so let it close on the normal
    // timers instead of lingering for the life of the process.
    //
    // A CAMPAIGN room is covered, exactly like a solo-vs-AI casual game:
    // an in-progress level must survive the player closing the app,
    // backgrounding it, or losing connection, and must only be lost when
    // they deliberately leave (the home button, which closes the room via
    // leaveRoom). So no idle/empty timer may reap it. The known limit is
    // the same one solo casual has: rooms are in-memory, so a server
    // restart/redeploy still loses it — see CLAUDE.md.
    if (!G.ranked && !G.daily && G.players.filter(p => !p.isAI).length === 1) {
      G.emptySince = null;
      continue;
    }

    const anyoneHere = G.players.some(p => p.token && !p.isAI && p.connected);
    if (anyoneHere) {
      G.emptySince = null;
    } else {
      if (!G.emptySince) G.emptySince = now;
      if (now - G.emptySince > EMPTY_CLOSE_MS) { closeRoom(G, 'Everyone left.'); continue; }
    }

    if (now - G.lastActivity > IDLE_CLOSE_MS) {
      closeRoom(G, 'Closed after 10 minutes with nothing happening.');
    }
  }
}, 20 * 1000);

// A player reported the whole game freezing mid-hand. There was no
// global safety net anywhere in this file: an uncaught synchronous throw
// or unhandled promise rejection ANYWHERE — in a socket handler, in a
// setTimeout callback like the ones resolveTrick/endRound schedule —
// crashes the entire Node process, which takes down every connected
// player's game at once (all room state is in-memory, so a crash-
// triggered restart loses it outright) and reads exactly like "the game
// froze" until the process comes back up. This logs instead of dying —
// it can't undo whatever state a bug left half-written, but a real bug
// now costs one broken game and a log line instead of the whole server.
// MUST be registered before server.listen so it's active for the whole
// process lifetime, not just requests after this point.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (process kept alive):', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection (process kept alive):', err && err.stack || err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Dame de Pique running on port ${PORT}`));
