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
  Promise.resolve().then(fn).catch(err => console.error('Stats tracking error:', err.message));
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
const TOTAL_ROUNDS = 16;
const AUTO_ADVANCE_MS = 60 * 1000;      // host has a minute, then it moves on by itself
const IDLE_CLOSE_MS   = 10 * 60 * 1000; // nothing happening at all
const EMPTY_CLOSE_MS   = 2 * 60 * 1000; // nobody connected
const END_VOTE_MS      = 60 * 1000;     // how long an "end early" request stays open

const rooms = {};

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
function cardVal(c) {
  if (c.suit === '♥') return -RV[c.rank];
  if (c.suit === '♠' && c.rank === 'Q') return -26;
  return 0;
}
function sortH(h) {
  return [...h].sort((a, b) => SO[a.suit] - SO[b.suit] || RV[a.rank] - RV[b.rank]);
}
function eqC(a, b) { return a.rank === b.rank && a.suit === b.suit; }

function passDir(round) { return ['left', 'right', 'across', 'keep'][(round - 1) % 4]; }
function passLetter(round) { return { left: 'L', right: 'R', across: 'O', keep: 'K' }[passDir(round)]; }
function passTarget(from, round) {
  const d = passDir(round);
  if (d === 'left')   return (from + 1) % 4;
  if (d === 'right')  return (from + 3) % 4;
  if (d === 'across') return (from + 2) % 4;
  return from;
}

function passSource(to, round) {
  const d = passDir(round);
  if (d === 'left')   return (to + 3) % 4;
  if (d === 'right')  return (to + 1) % 4;
  if (d === 'across') return (to + 2) % 4;
  return to;
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

  // Try all C(13,2)=78 two-card passes, keep the one that leaves the
  // safest 11-card hand behind. A high heart is only allowed to leave in
  // a candidate pass if the hand doesn't already have at least 2 low
  // hearts (7 or under) to fall back on — otherwise it's safer buried
  // behind that cover and dealt with later than handed away now.
  let best = null, bestRisk = Infinity;
  for (let a = 0; a < hand.length; a++) {
    for (let b = a + 1; b < hand.length; b++) {
      const c1 = hand[a], c2 = hand[b];
      if (isHighHeart(c1) && lowHeartsBeside(c1) >= 2) continue;
      if (isHighHeart(c2) && lowHeartsBeside(c2) >= 2) continue;
      const remaining = hand.filter((_, idx) => idx !== a && idx !== b);
      const r = handRisk(remaining);
      if (r < bestRisk) { bestRisk = r; best = [c1, c2]; }
    }
  }
  // Fallback for the vanishingly unlikely case every combo got filtered:
  // ignore the high-heart guard and just take the safest one regardless.
  if (!best) {
    for (let a = 0; a < hand.length; a++) {
      for (let b = a + 1; b < hand.length; b++) {
        const remaining = hand.filter((_, idx) => idx !== a && idx !== b);
        const r = handRisk(remaining);
        if (r < bestRisk) { bestRisk = r; best = [hand[a], hand[b]]; }
      }
    }
  }
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

    // Hunt mode: holding none of Q♠/A♠/K♠ means leading spades carries no
    // risk of scooping the queen myself — flush her out of hiding.
    const spadesHeld = hand.filter(c => c.suit === '♠');
    const hasTopSpade = spadesHeld.some(c => c.rank === 'Q' || c.rank === 'A' || c.rank === 'K');
    const qsCaptured = G.players.some(p => p.tricks.some(c => c.suit === '♠' && c.rank === 'Q'));
    const legalSpades = legal.filter(c => c.suit === '♠');
    if (!hasTopSpade && legalSpades.length && !qsCaptured) {
      return legalSpades.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
    }

    // Bank a free +10: lead a card that's provably unbeatable in its suit
    // right now (every higher card is already gone or safe in my own hand).
    const safe = legal.filter(c => cardVal(c) === 0);
    const guaranteed = safe.filter(c => isGuaranteedWinner(G, c, hand));
    if (guaranteed.length) return guaranteed.sort((a, b) => RV[b.rank] - RV[a.rank])[0];

    // No sure thing on offer. If I'm holding low hearts, this is close to
    // a free way to shed one: as long as at least two higher hearts are
    // still unaccounted for, someone else almost always has to cover it —
    // no need to be afraid of a low heart when the math favors it.
    const lowHearts = legal.filter(c => c.suit === '♥' && RV[c.rank] <= 7)
      .sort((a, b) => RV[a.rank] - RV[b.rank]);
    if (lowHearts.length) {
      const cheapest = lowHearts[0];
      const played = playedCardsThisRound(G);
      const higherHeartsUnseen = RANKS.filter(r => RV[r] > RV[cheapest.rank])
        .filter(r => !played.some(c => c.suit === '♥' && c.rank === r))
        .filter(r => !hand.some(c => c.suit === '♥' && c.rank === r)).length;
      if (higherHeartsUnseen >= 2) return cheapest;
    }

    // Nothing clever on offer — lead the highest safe card.
    const pool = safe.length ? safe : legal;
    return pool.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
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
    const wantToWin = penInTrick === 0 || amMoonPace || (oppMoonPace && penInTrick > 0);
    if (wantToWin && winners.length) {
      return winners.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
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
  if (G.passSelected && passDir(G.round) !== 'keep' && G.passSelected[pi] && G.passSelected[pi].length === 2) {
    const tgt = passTarget(pi, G.round);
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
    const samples = samplesFor(legal.length, G.trickNum);
    const totals = new Array(legal.length).fill(0);

    for (let s = 0; s < samples; s++) {
      const world = sampleWorld(G, pi);
      for (let ci = 0; ci < legal.length; ci++) {
        totals[ci] += evaluateCandidate(G, pi, legal[ci], world);
      }
    }

    let bestIdx = 0, bestAvg = -Infinity;
    for (let ci = 0; ci < legal.length; ci++) {
      const avg = totals[ci] / samples;
      if (avg > bestAvg) { bestAvg = avg; bestIdx = ci; }
    }
    return legal[bestIdx];
  } catch (e) {
    return heuristicChoose(G, pi);
  }
}

// ── Room lifecycle ──────────────────────────────────────────────
function sanitizeAvatar(a) {
  const s = String(a || '').trim().slice(0, 8);
  return s || null;
}

function createRoom(hostName, hostAvatar, hostAccountId) {
  const code = makeCode();
  rooms[code] = {
    code,
    phase: 'lobby',
    players: Array.from({ length: 4 }, (_, i) => ({
      name: i === 0 ? hostName : 'Empty seat',
      avatar: i === 0 ? sanitizeAvatar(hostAvatar) : null,
      accountId: i === 0 ? (hostAccountId || null) : null,
      isAI: false, socketId: null, token: null,
      score: 0, hand: [], tricks: [], connected: false, hasPassed: false,
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
  io.to(G.code).emit('roomClosed', { reason });
  delete rooms[G.code];
}

// Re-arm whatever timer belongs to the phase we're sitting in.
function rearmAuto(G) {
  if (G.phase === 'roundSummary') {
    armAuto(G, () => advanceRound(G), AUTO_ADVANCE_MS);
  } else if (G.phase === 'drawDone') {
    armAuto(G, () => { if (G.phase === 'drawDone') dealRound(G); }, AUTO_ADVANCE_MS);
  } else if (G.phase === 'draw') {
    armAuto(G, () => {
      if (G.phase !== 'draw') return;
      for (let i = 0; i < 4; i++) if (!G.drawRevealed[i]) revealDrawCard(G, i);
    }, AUTO_ADVANCE_MS);
  }
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
function recordGameFinishedForAll(G) {
  for (let i = 0; i < 4; i++) {
    const acctId = G.players[i].accountId;
    if (!acctId) continue;
    const finalScore = G.players[i].score;
    const moons = (G.moonCounts && G.moonCounts[i]) || 0;
    trackStat(() => db.recordGameFinished(acctId, finalScore, moons));
  }
}

function finishEarly(G) {
  clearVote(G);
  clearAuto(G);
  G.endVote = null;
  G.voteMsg = '';
  G.phase = 'final';
  recordGameFinishedForAll(G);
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
    players: G.players.map((p, i) => ({
      name: p.name, avatar: p.avatar || null, isAI: p.isAI, score: p.score,
      roundScore: p.score - (G.roundBefore[i] || 0),
      connected: p.connected, cardCount: p.hand.length, hasPassed: p.hasPassed,
    })),
    round: G.round,
    totalRounds: TOTAL_ROUNDS,
    isLastRound: G.round >= TOTAL_ROUNDS,
    dealer: G.dealer,
    drawRound: G.drawRound,
    heartsbroken: G.heartsbroken,
    currentTrick: G.currentTrick,
    trickLeader: G.trickLeader,
    trickNum: G.trickNum,
    drawCards: G.drawCards.map((c, i) => (G.drawRevealed[i] ? c : null)),
    drawRevealed: G.drawRevealed,
    roundBefore: G.roundBefore,
    lastTrickMsg: G.lastTrickMsg || '',
    moonShooter: G.moonShooter,
    history: G.history,
    autoIn: G.autoAt ? Math.max(0, G.autoAt - Date.now()) : 0,
    endVote: G.endVote ? { by: G.endVote.by, needed: G.endVote.needed, agreed: G.endVote.agreed } : null,
    voteIn: G.voteAt ? Math.max(0, G.voteAt - Date.now()) : 0,
    voteMsg: G.voteMsg || '',
    passLetters: Array.from({ length: TOTAL_ROUNDS }, (_, i) => passLetter(i + 1)),
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
        passToIndex: passDir(G.round) === 'keep' ? null : passTarget(i, G.round),
        passFromIndex: passDir(G.round) === 'keep' ? null : passSource(i, G.round),
        legalCards: G.phase === 'play' ? legalCards(G, i).map(c => c.rank + '|' + c.suit) : [],
      });
    }
  }
}

// ── Draw phase ──────────────────────────────────────────────────
function startDraw(G, round) {
  G.phase = 'draw';
  G.drawRound = round;
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
  const deck = shuffle(makeDeck());
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
  G.lastTrickMsg = '';
  G.playLog = [];
  G.roundBefore = G.players.map(p => p.score);

  if (passDir(G.round) === 'keep') { startTricks(G); return; }

  G.phase = 'pass';
  for (let i = 0; i < 4; i++) {
    if (G.players[i].isAI) {
      G.passSelected[i] = aiSelectPass(G, i);
      G.players[i].hasPassed = true;
    }
  }
  broadcastRoom(G);
  checkAllPassed(G);
}

function checkAllPassed(G) {
  if (G.passSelected.every(s => s && s.length === 2)) setTimeout(() => executePass(G), 400);
}

function executePass(G) {
  if (G.phase !== 'pass') return;
  const toAdd = [[], [], [], []];
  for (let i = 0; i < 4; i++) {
    const tgt = passTarget(i, G.round);
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
  if (G.players[winner].accountId) {
    const acctId = G.players[winner].accountId;
    trackStat(() => db.recordTrick(acctId, trickScore));
  }
  G.lastTrickMsg = `${G.players[winner].name} wins trick ${G.trickNum} · +10${penPts !== 0 ? ' ' + penPts : ''}`;
  if (!G.playLog) G.playLog = [];
  G.playLog.push(G.currentTrick.map(t => ({ player: t.player, card: t.card })));
  G.currentTrick = [];
  G.trickNum++;
  G.trickLeader = winner;
  broadcastRoom(G);

  if (G.trickNum > 13) setTimeout(() => endRound(G), 1200);
  else setTimeout(() => scheduleAI(G), 850);
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
    G.history.push({
      round: G.round,
      dir: passLetter(G.round),
      deltas: G.players.map((p, i) => p.score - G.roundBefore[i]),
      totals: G.players.map(p => p.score),
      moon,
    });
    if (moon >= 0) {
      if (!G.moonCounts) G.moonCounts = [0, 0, 0, 0];
      G.moonCounts[moon]++;
    }
  }

  // Always show a summary for the final round too, then move on to standings.
  G.phase = 'roundSummary';
  // If the host doesn't press the button, carry on without them.
  armAuto(G, () => advanceRound(G), AUTO_ADVANCE_MS);
  broadcastRoom(G);
}

function advanceRound(G) {
  if (!rooms[G.code] || G.phase !== 'roundSummary') return;
  clearAuto(G);
  if (G.round >= TOTAL_ROUNDS) { G.phase = 'final'; recordGameFinishedForAll(G); broadcastRoom(G); return; }
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
  }
}

// ── Socket handlers ─────────────────────────────────────────────
function findRoom(code) { return rooms[String(code || '').toUpperCase()]; }
function isHostSocket(G, socket) { return G.hostSocket === socket.id; }

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
      if (account) socket.emit('authOk', { token, account: db.toPublic(account) });
    } catch (e) {
      console.error('resumeSession error:', e.message);
    }
  });

  socket.on('logout', async ({ token }) => {
    if (!DB_ENABLED || !token) return;
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

  socket.on('createRoom', async ({ name, avatar, accountToken }) => {
    const clean = String(name || '').trim().slice(0, 16) || 'Player';
    const acct = await lookupAccountByToken(accountToken);
    const G = createRoom(clean, sanitizeAvatar(avatar), acct ? acct.id : null);
    const token = makeToken();
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
    if (G.phase !== 'lobby') return socket.emit('errorMsg', { msg: 'That game has already started.' });

    let slot = -1;
    for (let i = 1; i < 4; i++) {
      if (!G.players[i].connected && !G.players[i].isAI) { slot = i; break; }
    }
    if (slot === -1) return socket.emit('errorMsg', { msg: 'That room is full.' });

    const acct = await lookupAccountByToken(accountToken);
    if (!rooms[code] || G.players[slot].connected) return socket.emit('errorMsg', { msg: 'That seat just got taken — try again.' });

    const token = makeToken();
    G.players[slot].name = String(name || '').trim().slice(0, 16) || `Player ${slot + 1}`;
    G.players[slot].avatar = sanitizeAvatar(avatar);
    G.players[slot].accountId = acct ? acct.id : null;
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
    const host = G.hostToken === token;
    if (host) G.hostSocket = socket.id;
    socket.join(G.code);
    socket.emit('joined', { code: G.code, playerIndex: idx, token, isHost: host });
    broadcastRoom(G);
  });

  socket.on('setAI', ({ code, slotIndex, isAI }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'lobby' || !isHostSocket(G, socket)) return;
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
      if (p.accountId) trackStat(() => db.recordGameStarted(p.accountId));
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

  socket.on('nextRound', ({ code }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'roundSummary' || !isHostSocket(G, socket)) return;
    advanceRound(G);
  });

  // Host asks to stop early. Everyone human has to agree; computers always do.
  socket.on('endGame', ({ code }) => {
    const G = findRoom(code);
    if (!G || !isHostSocket(G, socket)) return;
    if (G.phase === 'lobby' || G.phase === 'final') return;
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
        name: 'Empty seat', avatar: null, accountId: null, isAI: false, socketId: null, token: null,
        connected: false, score: 0, hand: [], tricks: [], hasPassed: false,
      });
    } else {
      // Mid-game: hand the seat to the computer so the others can finish
      Object.assign(G.players[idx], { isAI: true, avatar: null, accountId: null, connected: true, socketId: null, token: null });
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
    for (const code in rooms) {
      const G = rooms[code];
      for (const p of G.players) {
        if (p.socketId === socket.id) {
          p.socketId = null;
          p.connected = false;
          broadcastRoom(G);
        }
      }
    }
  });
});

// Close rooms that have gone quiet, or that everyone has walked away from.
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    const G = rooms[code];

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
