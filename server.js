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
// Estimates how dangerous a hand is to hold, from a purely defensive/offensive
// blend appropriate to this ruleset (winning a trick is +10, not something to
// avoid — only the hearts/Q♠ riding along in that trick cost points). Lower
// is better. Used to pick which 2 cards to pass: try every combo, keep the
// one whose *remaining* 11-card hand scores lowest risk.
// Cards the AI should mostly hold onto rather than pass or discard away:
// aces/kings (trick-winning power) and 2s/3s (always-safe cards to have on
// hand) in the plain suits.
function isKeeper(c) {
  return (c.suit === '♦' || c.suit === '♣') &&
    (c.rank === 'A' || c.rank === 'K' || c.rank === '2' || c.rank === '3');
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
    // to duck with first makes this much safer.
    const guardFactor = Math.max(0.10, 1 - lowSpades * 0.22);
    risk += highSpades * 9 * guardFactor;
  }

  // Hearts cost scaled by rank; the very top hearts get an extra penalty
  // since they're the hardest to unload without winning a fat trick.
  for (const c of bySuit['♥']) {
    risk += RV[c.rank] * 0.9;
    if (RV[c.rank] >= RV.Q) risk += 4;
  }

  // Being void (or near-void) in a suit is good: it lets you dump danger
  // cards for free whenever that suit gets led later in the round.
  for (const s of SUITS) {
    const n = bySuit[s].length;
    if (n === 0) risk -= (s === '♠' ? 10 : s === '♥' ? 6 : 5);
    else if (n === 1) risk -= (s === '♠' ? 4 : s === '♥' ? 2 : 2);
  }

  // Keeper cards (A/K/2/3 of ♦/♣): discourage passing these away.
  for (const c of hand) {
    if (isKeeper(c)) risk -= 3;
  }

  return risk;
}

function aiSelectPass(G, i) {
  const hand = G.players[i].hand;
  let best = null, bestRisk = Infinity;
  // Try all C(13,2)=78 two-card passes, keep the one that leaves the
  // safest 11-card hand behind.
  for (let a = 0; a < hand.length; a++) {
    for (let b = a + 1; b < hand.length; b++) {
      const remaining = hand.filter((_, idx) => idx !== a && idx !== b);
      const r = handRisk(remaining);
      if (r < bestRisk) {
        bestRisk = r;
        best = [hand[a], hand[b]];
      }
    }
  }
  return best.map(c => ({ rank: c.rank, suit: c.suit }));
}

function aiChoose(G, pi) {
  const legal = legalCards(G, pi);
  if (legal.length === 1) return legal[0];
  const trick = G.currentTrick;

  if (trick.length === 0) {
    // Chase mode: if this hand holds none of Q♠/A♠/K♠ (so leading spades
    // carries no risk of scooping the queen itself) and isn't already long
    // in spades, lead spades low to help flush the queen out of hiding.
    // Skip it once the queen has already fallen this round.
    const hand = G.players[pi].hand;
    const spadesHeld = hand.filter(c => c.suit === '♠');
    const hasTopSpade = spadesHeld.some(c => c.rank === 'Q' || c.rank === 'A' || c.rank === 'K');
    const qsCaptured = G.players.some(p => p.tricks.some(c => c.suit === '♠' && c.rank === 'Q'));
    const legalSpades = legal.filter(c => c.suit === '♠');
    if (!hasTopSpade && spadesHeld.length > 0 && spadesHeld.length < 6 && !qsCaptured && legalSpades.length) {
      return legalSpades.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
    }
    // Otherwise, lead the highest safe (non-penalty) card to try to win it.
    const safe = legal.filter(c => cardVal(c) === 0);
    const pool = safe.length ? safe : legal;
    return pool.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
  }

  const led = trick[0].card.suit;
  const following = legal.filter(c => c.suit === led);

  if (following.length > 0) {
    const highInTrick = [...trick].filter(t => t.card.suit === led)
      .sort((a, b) => RV[b.card.rank] - RV[a.card.rank])[0].card;
    const winners = following.filter(c => RV[c.rank] > RV[highInTrick.rank]);
    const losers  = following.filter(c => RV[c.rank] < RV[highInTrick.rank]);
    const penInTrick = trick.reduce((s, t) => s + Math.abs(cardVal(t.card)), 0);

    if (led === '♥') {
      // Never chase a hearts trick — play the lowest heart to try to lose it,
      // or the cheapest heart that still wins if there's no way to duck.
      if (losers.length) return losers.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
      return (winners.length ? winners : following).sort((a, b) => RV[a.rank] - RV[b.rank])[0];
    }

    if (penInTrick > 0) {
      // A penalty is already riding on this trick — duck under it, preferably
      // without spending a keeper card if a non-keeper loser is available.
      if (losers.length) {
        const nonKeeper = losers.filter(c => !isKeeper(c));
        const pool = nonKeeper.length ? nonKeeper : losers;
        return pool.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
      }
      return (winners.length ? winners : following).sort((a, b) => RV[a.rank] - RV[b.rank])[0];
    }

    // Clean trick so far (no hearts, no Q♠ played yet): go for the +10 —
    // play the highest card of the led suit to try to win it outright.
    if (winners.length) return winners.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
    // Can't win: this loss is free either way, so protect keeper cards where possible.
    const nonKeeper = losers.filter(c => !isKeeper(c));
    const pool = nonKeeper.length ? nonKeeper : losers;
    return pool.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
  }

  const qs = legal.find(c => c.suit === '♠' && c.rank === 'Q');
  if (qs) return qs;
  const hearts = legal.filter(c => c.suit === '♥').sort((a, b) => RV[b.rank] - RV[a.rank]);
  if (hearts.length) return hearts[0];
  // Nothing dangerous to dump: this is a free discard, so protect keeper
  // cards first, and among the rest, let go of the lowest one to keep
  // higher plain-suit assets in hand (winning a trick is +10 here).
  const nonKeeper = legal.filter(c => !isKeeper(c));
  const pool = nonKeeper.length ? nonKeeper : legal;
  return pool.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
}

// ── Room lifecycle ──────────────────────────────────────────────
function createRoom(hostName) {
  const code = makeCode();
  rooms[code] = {
    code,
    phase: 'lobby',
    players: Array.from({ length: 4 }, (_, i) => ({
      name: i === 0 ? hostName : 'Empty seat',
      isAI: false, socketId: null, token: null,
      score: 0, hand: [], tricks: [], connected: false, hasPassed: false,
    })),
    hostSocket: null,
    hostToken: null,
    round: 1,
    dealer: -1,
    drawCards: [],
    drawRevealed: [false, false, false, false],
    heartsbroken: false,
    currentTrick: [],
    trickLeader: 0,
    trickNum: 1,
    passSelected: [null, null, null, null],
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

function finishEarly(G) {
  clearVote(G);
  clearAuto(G);
  G.endVote = null;
  G.voteMsg = '';
  G.phase = 'final';
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
      name: p.name, isAI: p.isAI, score: p.score,
      roundScore: p.score - (G.roundBefore[i] || 0),
      connected: p.connected, cardCount: p.hand.length, hasPassed: p.hasPassed,
    })),
    round: G.round,
    totalRounds: TOTAL_ROUNDS,
    isLastRound: G.round >= TOTAL_ROUNDS,
    dealer: G.dealer,
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
        legalCards: G.phase === 'play' ? legalCards(G, i).map(c => c.rank + '|' + c.suit) : [],
      });
    }
  }
}

// ── Draw phase ──────────────────────────────────────────────────
function startDraw(G) {
  G.phase = 'draw';
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

function revealDrawCard(G, i) {
  if (G.phase !== 'draw' || G.drawRevealed[i]) return;
  G.drawRevealed[i] = true;
  if (G.drawRevealed.every(Boolean)) {
    let best = 0;
    for (let j = 1; j < 4; j++)
      if (RV[G.drawCards[j].rank] > RV[G.drawCards[best].rank]) best = j;
    G.dealer = best;
    G.phase = 'drawDone';
    armAuto(G, () => { if (G.phase === 'drawDone') dealRound(G); }, AUTO_ADVANCE_MS);
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
  G.heartsbroken = false;
  G.currentTrick = [];
  G.trickNum = 1;
  G.moonShooter = -1;
  G.lastTrickMsg = '';
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
  startTricks(G);
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
  G.players[winner].score += 10 + penPts;
  G.players[winner].tricks.push(...G.currentTrick.map(t => t.card));
  G.lastTrickMsg = `${G.players[winner].name} wins trick ${G.trickNum} · +10${penPts !== 0 ? ' ' + penPts : ''}`;
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
  if (G.round >= TOTAL_ROUNDS) { G.phase = 'final'; broadcastRoom(G); return; }
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

  socket.on('createRoom', ({ name }) => {
    const clean = String(name || '').trim().slice(0, 16) || 'Player';
    const G = createRoom(clean);
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

  socket.on('joinRoom', ({ code, name }) => {
    const G = findRoom(code);
    if (!G) return socket.emit('errorMsg', { msg: 'Room not found. Check the code.' });
    if (G.phase !== 'lobby') return socket.emit('errorMsg', { msg: 'That game has already started.' });

    let slot = -1;
    for (let i = 1; i < 4; i++) {
      if (!G.players[i].connected && !G.players[i].isAI) { slot = i; break; }
    }
    if (slot === -1) return socket.emit('errorMsg', { msg: 'That room is full.' });

    const token = makeToken();
    G.players[slot].name = String(name || '').trim().slice(0, 16) || `Player ${slot + 1}`;
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
    p.token = null;
    p.socketId = null;
    broadcastRoom(G);
  });

  socket.on('startGame', ({ code }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'lobby' || !isHostSocket(G, socket)) return;
    if (!G.players.every(p => p.connected || p.isAI))
      return socket.emit('errorMsg', { msg: 'All four seats need a player or an AI.' });
    startDraw(G);
  });

  socket.on('revealDraw', ({ code, playerIndex }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'draw') return;
    if (G.players[playerIndex]?.socketId !== socket.id) return;
    revealDrawCard(G, playerIndex);
  });

  socket.on('startRound', ({ code }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'drawDone' || !isHostSocket(G, socket)) return;
    dealRound(G);
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
        name: 'Empty seat', isAI: false, socketId: null, token: null,
        connected: false, score: 0, hand: [], tricks: [], hasPassed: false,
      });
    } else {
      // Mid-game: hand the seat to the computer so the others can finish
      Object.assign(G.players[idx], { isAI: true, connected: true, socketId: null, token: null });
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
