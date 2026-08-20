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

// Which player currently owns every heart/Q♠ trick captured so far this
// round — i.e. who (if anyone) is on pace to shoot the moon. -1 once two
// different players have each banked at least one penalty card, since
// the moon is then mathematically dead for the round.
function moonPaceOwner(G) {
  let owner = -1;
  for (let i = 0; i < 4; i++) {
    const hasPenalty = G.players[i].tricks.some(c => c.suit === '♥' || (c.suit === '♠' && c.rank === 'Q'));
    if (hasPenalty) {
      if (owner !== -1 && owner !== i) return -1;
      owner = i;
    }
  }
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
  // Hard protections: low/mid clubs are safe, plentiful cards worth
  // keeping all game for ducking; hearts this low cost almost nothing
  // to hold onto; and low/mid spades (2 through J) are the guards that
  // let a spade lead be ducked safely instead of forcing a scoop of
  // the queen — never pass any of these away.
  const neverPass = c =>
    (c.suit === '♣' && RV[c.rank] <= 11) ||
    (c.suit === '♥' && RV[c.rank] <= 5) ||
    (c.suit === '♠' && RV[c.rank] <= 11);

  // A club or diamond down to a single card is worth passing on even
  // though it would otherwise be protected: going fully void in that
  // suit is worth far more than the one card, since every future lead
  // in it becomes a free dump for a heart or the queen of spades.
  const suitCount = s => hand.filter(c => c.suit === s).length;
  const mustPass = hand.filter(c => (c.suit === '♣' || c.suit === '♦') && suitCount(c.suit) === 1);
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
    const highInTrick = [...trick].filter(t => t.card.suit === led)
      .sort((a, b) => RV[b.card.rank] - RV[a.card.rank])[0].card;
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
      const qsOut = G.players.some(p => p.tricks.some(c => c.suit === '♠' && c.rank === 'Q'))
        || trick.some(t => t.card.suit === '♠' && t.card.rank === 'Q');
      const safeToOvertake = trick.length === 3 && !qsOut;
      if (!safeToOvertake) {
        const withoutTopSpades = winners.filter(c => c.rank !== 'A' && c.rank !== 'K');
        if (withoutTopSpades.length) restrictedWinners = withoutTopSpades;
        else wantToWin = false; // only A♠/K♠ would win it, and it's not safe — don't
      }
    }

    if (wantToWin && restrictedWinners.length) {
      return restrictedWinners.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
    }

    if (losers.length) {
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
      const topSpades = legal.filter(c => c.suit === '♠' && (c.rank === 'A' || c.rank === 'K'));
      if (topSpades.length && topSpades.length < legal.length) {
        return legal.filter(c => !topSpades.includes(c));
      }
    }
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
    names: ['First Blood', 'Queen Hunter', 'Queen Collector', 'Queen of Queens'],
    desc: 'Take the Queen of Spades.',
    crest: 'crest_queen_of_spades', title: 'title_queen_hunter' },

  // 500 rather than 1000: a moon lands in roughly 2% of hands and the AI
  // actively defends against one (see oppMoonPace / moonPaceOwner), so a
  // 1000 rung works out at ~3,000 games - not extreme, just unreachable.
  { id: 'ach_moon_chaser',    stat: 'moonsTotal',         tiers: [1, 10, 50, 500],
    names: ['Lunar Debut', 'Moon Chaser', 'Moonstruck', 'Lord of the Moon'],
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

  { id: 'ach_ace_collector',  stat: 'gamesWon',           tiers: [5, 25, 75, 250],
    names: ['Ace Collector', 'Ace Hoarder', 'Ace Baron', 'Ace Sovereign'],
    desc: 'Win games - the long road.',
    crest: 'crest_ace',             title: 'title_ace_collector' },

  { id: 'ach_heartbreaker',   stat: 'gamesWonPositive',   tiers: [1, 10, 50, 200],
    names: ['Heartbreaker', 'Heartless', 'Heart of Stone', 'The Unmoved'],
    desc: 'Win a game finishing on a positive score.',
    crest: 'crest_rose',            title: 'title_heartbreaker' },

  { id: 'ach_four_suit',      stat: 'fourSuitGames',      tiers: [1, 10, 50, 200],
    names: ['All Four', 'Four-Suit Master', 'Suit Sovereign', 'Master of Suits'],
    desc: 'Win a game after taking tricks in all four suits.',
    crest: 'crest_four_suits',      title: 'title_four_suit_master' },

  { id: 'ach_silent_dealer',  stat: 'gamesCompletedFull', tiers: [1, 10, 50, 200],
    names: ['Stayed the Course', 'The Silent Dealer', 'Iron Resolve', 'Never Folds'],
    desc: 'See a game through to the end in your own seat.',
    crest: 'crest_raven',           title: 'title_dealers_nemesis' },

  { id: 'ach_card_master',    stat: 'gamesCompleted',     tiers: [1, 25, 100, 500],
    names: ['First Hand', 'Card Master', 'Table Regular', 'Living Legend'],
    desc: 'Complete a game.',
    crest: 'crest_card_fan',        title: 'title_trick_taker' },

  { id: 'ach_observer',       stat: 'gamesCompleted',     tiers: [10, 50, 200, 750],
    names: ['The Observer', 'The Watcher', 'The Archivist', 'The Chronicle'],
    desc: 'Complete games - the patient road.',
    crest: 'crest_eye',             title: 'title_clean_sweep' },

  { id: 'ach_the_dealer',     stat: 'dealerRounds',       tiers: [1, 25, 100, 500],
    names: ['Cut the Deck', 'The Dealer', 'House Dealer', 'Dealer Eternal'],
    desc: 'Deal a hand.',
    crest: 'crest_dealer_button',   title: 'title_blame_the_dealer' },

  // -- rank ladders --
  // Seven tiers are actually reachable (a new account starts mid-Novice),
  // which does not split into 4+4 - so Ace is the top rung of the first
  // ladder and the entry rung of the second. The thresholds are
  // RANK_TABLE's own tier-entry MMRs, and they read mmrPeak, so a losing
  // streak can never revoke one.
  { id: 'ach_high_roller',    stat: 'mmrPeak',            tiers: [500, 1000, 1500, 2000],
    names: ['Apprentice', 'Player', 'Gambler', 'Ace'],
    desc: 'Reach a new rank in ranked play.',
    crest: 'crest_diamond',         title: 'title_high_roller' },

  { id: 'ach_the_ascent',     stat: 'mmrPeak',            tiers: [2000, 2500, 3000, 3500],
    names: ['Ace', 'Master', 'Grand Master', 'Legend'],
    desc: 'Climb the top half of the ladder.',
    crest: 'crest_ascent',          title: 'title_the_ascent' },

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
  { id: 'ach_the_slam',       stat: 'slams',              tiers: [1, 3, 10, 25],
    names: ['The Slam', 'Double Slam', 'Slam Artist', 'Untouchable'],
    desc: 'Win every trick in a hand.',
    crest: 'crest_slam',            title: 'title_the_slam' },

  { id: 'ach_ledger',         stat: 'bestGame',           tiers: [250],
    names: ['The Ledger'],
    desc: 'Finish a game on +250 or better.',
    crest: 'crest_ledger',          title: 'title_the_ledger' },

  { id: 'ach_clean_sheet',    stat: 'cleanRounds',        tiers: [1, 10, 50, 200],
    names: ['Clean Sheet', 'Spotless', 'Immaculate', 'Without a Mark'],
    desc: 'Finish a hand without taking a single penalty card.',
    crest: 'crest_clean',           title: 'title_clean_sheet' },

  { id: 'ach_queen_dodger',   stat: 'queenlessGames',     tiers: [1, 10, 50, 200],
    names: ['Queen Dodger', 'Untouched', 'She Never Finds You', 'Ghost'],
    desc: 'Complete a whole game without ever taking the Queen of Spades.',
    crest: 'crest_veil',            title: 'title_queen_dodger' },

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
// Only scenes and card fronts are purchasable, deliberately. Crests are
// 1:1 with achievements — a crest IS the visible proof of one, so a bought
// crest would be a lie. Rank sets are earned by reaching a tier and are
// documented as never purchasable; selling them would also make credits
// look like they touch rank, which is this spec's own first non-goal.
// Neither carries a price, and buyCosmetic hard-rejects both.
const CREDIT_PRICES = { common: 600, rare: 2000, epic: 5000, legendary: 12000 };
const COSMETICS = {
  scenes: [
    { id: 'scene_velvet_room',   name: 'The Velvet Room',  unlock: null },
    { id: 'scene_rooftop',       name: 'The Rooftop',      unlock: 'ach_observer',     price: CREDIT_PRICES.rare },
    { id: 'scene_grand_library', name: 'The Grand Library', unlock: 'ach_card_master', price: CREDIT_PRICES.rare },
    { id: 'scene_winter_casino', name: 'The Winter Casino', unlock: 'ach_the_house',   price: CREDIT_PRICES.rare },
    { id: 'scene_moon_room',     name: 'The Moon Room',    unlock: 'ach_moon_chaser',  price: CREDIT_PRICES.rare },
    { id: 'scene_garden',        name: 'The Garden',       unlock: 'ach_heartbreaker', price: CREDIT_PRICES.rare },
    { id: 'scene_train',         name: 'The Train',        unlock: 'ach_the_dealer',   price: CREDIT_PRICES.rare },
    { id: 'scene_observatory',   name: 'The Observatory',  unlock: 'ach_high_roller',  price: CREDIT_PRICES.rare },
  ],
  cardFronts: [
    { id: 'cardfront_standard',    name: 'Classic',      unlock: null },
    // Royal Court no longer carries a `price` — it's back to
    // achievement-only, exactly as it was before the shop existed. The
    // shop slot (and the achievement's own unlock string) is now shared
    // with Nocturne Deck below, so reaching ach_queen_hunter grants BOTH;
    // this is a deliberate swap of "which deck the shop sells", not a
    // revocation — anyone who already owns/equips Royal Court keeps it,
    // since it's still a real, unlockable catalog entry.
    { id: 'cardfront_royal_court', name: 'Royal Court',  unlock: 'ach_queen_hunter' },
    // Real illustrated art (52 unique card faces + court portraits),
    // cropped from a reference sheet rather than drawn in CSS — see
    // cardFrontArtImg client-side for the loading contract. Takes over
    // Royal Court's old price/unlock slot in the shop.
    { id: 'cardfront_nocturne',    name: 'Nocturne Deck', unlock: 'ach_queen_hunter', price: CREDIT_PRICES.common },
    // Shop-EXCLUSIVE, deliberately: no `unlock` string at all, priced at
    // the epic tier. This is the first cosmetic with no free route —
    // see the `unlocked` formula's comment above for what that required.
    { id: 'cardfront_noir',        name: 'Noir Casino',   unlock: null, price: CREDIT_PRICES.epic },
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
    { id: 'title_ace_collector',     name: 'Ace Collector',       unlock: 'ach_ace_collector' },
    { id: 'title_heartbreaker',      name: 'Heartbreaker',        unlock: 'ach_heartbreaker' },
    { id: 'title_strategist',        name: 'The Strategist',      unlock: 'ach_strategist' },
    { id: 'title_dealers_nemesis',   name: "Dealer's Nemesis",    unlock: 'ach_silent_dealer' },
    { id: 'title_high_roller',       name: 'High Roller',         unlock: 'ach_high_roller' },
    { id: 'title_trick_taker',       name: 'The Trick Taker',     unlock: 'ach_card_master' },
    { id: 'title_clean_sweep',       name: 'Clean Sweep',         unlock: 'ach_observer' },
    { id: 'title_blame_the_dealer',  name: 'Blame the Dealer',    unlock: 'ach_the_dealer' },
    { id: 'title_the_ascent',        name: 'The Ascendant',       unlock: 'ach_the_ascent' },
    { id: 'title_beyond_moon',       name: 'Beyond the Moon',     unlock: 'ach_beyond_moon' },
    { id: 'title_the_slam',          name: 'The Slam',            unlock: 'ach_the_slam' },
    { id: 'title_the_ledger',        name: 'The Ledger',          unlock: 'ach_ledger' },
    { id: 'title_clean_sheet',       name: 'Clean Sheet',         unlock: 'ach_clean_sheet' },
    { id: 'title_queen_dodger',      name: 'The Queen Dodger',    unlock: 'ach_queen_dodger' },
    { id: 'title_abyss',             name: 'Out of the Abyss',    unlock: 'ach_abyss' },
    { id: 'title_rock_bottom',       name: 'Rock Bottom',         unlock: 'ach_rock_bottom' },
    // rankTier is a SLUG, not a display name — tierReached compares
    // against RANK_TABLE's slug, so a capitalised tier name here would
    // silently never match and lock every rank title forever.
    { id: 'title_rising_star',       name: 'Rising Star',         rankTier: 'silver' },
    { id: 'title_ace',               name: 'The Ace',             rankTier: 'gold' },
    { id: 'title_no_hearts_please',  name: 'No Hearts, Please',   rankTier: 'platinum' },
    { id: 'title_grandmaster',       name: 'The Grandmaster',     rankTier: 'diamond' },
    { id: 'title_definitely_not_counting_cards', name: 'Definitely Not Counting Cards', rankTier: 'master' },
    { id: 'title_one_more_game',     name: 'One More Game',       rankTier: 'grandmaster' },
    { id: 'title_the_legend',        name: 'The Legend',          rankTier: 'legend' },
  ],
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
// contract: each was supplied as a 1254x1254 circular medallion with a
// baked-in gold ring and house crest, cropped down to JUST the portrait
// at a fixed inset that clears the ring on every image, since the app's
// own state-reactive avatar border — gold on your turn, gold when
// selected in the picker — would otherwise compete with a second,
// permanent ring baked into the source).
//
// Only 7 shipped, not 8: an 8th source file ("the host", a big open
// smile) existed when this was scoped but was gone from disk by the
// time of actual cropping — most likely evicted by OneDrive's on-demand
// sync between being shown and being processed. Nothing references it;
// it can be added as an 8th entry here whenever the file resurfaces.
const AVATAR_COLLECTIONS = [
  { id: 'house_regulars', name: 'House Regulars', dir: 'house-regulars',
    // Second batch (belle..castaway) deliberately keeps its source's
    // baked-in gold ring/crest medallion, unlike the first 7 above (which
    // crop it away) — see this collection's note further up for why.
    avatars: [['regular_charmer', 'The Charmer', 'charmer'], ['regular_sharp', 'The Sharp', 'sharp'],
              ['regular_optimist', 'The Optimist', 'optimist'], ['regular_jester', 'The Jester', 'jester'],
              ['regular_scholar', 'The Scholar', 'scholar'], ['regular_wildcard', 'The Wildcard', 'wildcard'],
              ['regular_closer', 'The Closer', 'closer'],
              ['regular_belle', 'The Belle', 'belle'], ['regular_countess', 'The Countess', 'countess'],
              ['regular_envoy', 'The Envoy', 'envoy'], ['regular_baron', 'The Baron', 'baron'],
              ['regular_castaway', 'The Castaway', 'castaway']] },
];
const AVATAR_IDS = new Set(
  AVATAR_COLLECTIONS.flatMap(c => c.avatars.map(a => a[0]))
);

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
    scene: ok(catalog.scenes, equipped.scene) || 'scene_velvet_room',
    cardFront: ok(catalog.cardFronts, equipped.cardFront) || 'cardfront_standard',
    crest: ok(catalog.crests, equipped.crest),
    title: ok(catalog.titles, equipped.title),
    rankSet: ok(catalog.rankSets, equipped.rankSet) || (highestRank ? highestRank.id : null),
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
const NO_SEAT_COSMETICS = { title: null, rankMaterial: null };
async function lookupSeatCosmetics(accountId) {
  if (!DB_ENABLED || !accountId) return NO_SEAT_COSMETICS;
  try {
    const { equipped, catalog } = await loadPlayerCosmetics(accountId);
    const set = catalog.rankSets.find(r => r.id === equipped.rankSet);
    return {
      title: titleNameFor(equipped.title),
      rankMaterial: set ? set.material : null,
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
  io.to(G.code).emit('roomClosed', { reason });
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
  if (amount <= 0) return;
  const ref = `${G.code}-${G.startedAt}`;
  if (!G.ranked) {
    // Passing the ref keeps this idempotent under trackStat's retries —
    // see claimCasualCreditDay. Without it a retried grant would be
    // refused by the cap it set itself on the first attempt.
    const claimed = await db.claimCasualCreditDay(acctId, dailyDateKey(), ref);
    if (!claimed) return;               // another game already had today's casual payout
  }
  await db.grantCredits(acctId, amount, 'game_reward', ref);
}

function recordGameFinishedForAll(G, natural) {
  // The Daily Challenge finishes through its own pipeline
  // (submitDailyResult) — it must never touch casual or ranked stats.
  if (G.daily) { submitDailyResult(G); return; }
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
  }
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
      rankMaterial: p.rankMaterial || null,
      isAI: p.isAI, score: p.score,
      roundScore: p.score - (G.roundBefore[i] || 0),
      tricksWon: p.tricks.length / 4,
      connected: p.connected, cardCount: p.hand.length, hasPassed: p.hasPassed,
    })),
    daily: !!G.daily,
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
  // date, so everyone playing that day gets exactly the same deal. Every
  // other room shuffles for real.
  const deck = G.daily
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
  if (G.players[winner].accountId && !G.daily) {
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
    // recordGameFinishedForAll. The Daily Challenge is excluded entirely:
    // it has its own table and shouldn't move casual numbers at all.
    if (!G.daily) {
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
      const updated = await db.updateProfile(account.id, { nickname: nick, avatar: sanitizeAvatar(avatar) });
      socket.emit('authOk', { token, account: db.toPublic(updated) });
    } catch (e) {
      console.error('updateProfile error:', e.message);
      socket.emit('authError', { msg: 'Could not save your profile. Try again.' });
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
  socket.on('saveCosmetics', async ({ token, scene, cardFront, crest, title, rankSet }) => {
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
        title: pick(catalog.titles, title),
        rankSet: pick(catalog.rankSets, rankSet),
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
      // Only the two purchasable categories are even searched, so an id
      // from any other category simply isn't found.
      const item = [...COSMETICS.scenes, ...COSMETICS.cardFronts].find(c => c.id === itemId);
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

  socket.on('getDailyLeaderboard', async ({ accountToken }) => {
    const date = dailyDateKey();
    if (!DB_ENABLED) return socket.emit('dailyLeaderboardOk', { date, rows: [], you: null });
    try {
      const rows = await db.getDailyLeaderboard(date, 100);
      let you = null;
      const acct = await lookupAccountByToken(accountToken);
      // Sent whenever the player has a score today, even if they're
      // already visible in the top 100 — the client pins it to the bottom
      // of the board as a permanent "you are here", not as an
      // outside-the-list fallback the way the ranked ladder does.
      if (acct) {
        const standing = await db.getDailyStanding(acct.id, date);
        if (standing) {
          you = {
            accountId: acct.id, position: standing.position, entries: standing.entries,
            nickname: acct.nickname, avatar: acct.avatar, score: standing.score,
          };
        }
      }
      socket.emit('dailyLeaderboardOk', { date, rows, you });
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
    // Daily Challenge is a single hand with a leaderboard behind it —
    // there's no "end early" that could bank a partial score. Leaving
    // abandons the attempt instead (leaveRoom closes the room outright).
    if (G.daily) return;
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
    socket.emit('leftRoom');

    if (G.phase === 'lobby' || G.phase === 'final') {
      // Free the seat entirely
      Object.assign(G.players[idx], {
        name: 'Empty seat', avatar: null, accountId: null, title: null, rankMaterial: null,
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
      Object.assign(G.players[idx], { isAI: true, avatar: null, accountId: null, title: null, rankMaterial: null, connected: true, socketId: null, token: null });
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
    // result is already banked in Postgres the moment it ends, and there's
    // nothing to come back to — so let it close on the normal timers
    // instead of lingering for the life of the process.
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Dame de Pique running on port ${PORT}`));
