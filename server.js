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
    // Restriction applies in round 1 only, until hearts/Q♠ are broken
    if (G.round === 1 && !G.heartsbroken) {
      if (card.suit === '♥' && G.players[pi].hand.some(c => c.suit !== '♥')) return false;
      if (card.suit === '♠' && card.rank === 'Q' &&
          G.players[pi].hand.some(c => !(c.suit === '♠' && c.rank === 'Q'))) return false;
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
function aiSelectPass(G, i) {
  const sorted = [...G.players[i].hand].sort((a, b) => {
    const w = c => (c.suit === '♠' && c.rank === 'Q') ? 1000 : c.suit === '♥' ? RV[c.rank] + 50 : RV[c.rank];
    return w(b) - w(a);
  });
  return sorted.slice(0, 2).map(c => ({ rank: c.rank, suit: c.suit }));
}

function aiChoose(G, pi) {
  const legal = legalCards(G, pi);
  if (legal.length === 1) return legal[0];
  const trick = G.currentTrick;

  if (trick.length === 0) {
    const safe = legal.filter(c => cardVal(c) === 0);
    const pool = safe.length ? safe : legal;
    return pool.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
  }

  const led = trick[0].card.suit;
  const following = legal.filter(c => c.suit === led);

  if (following.length > 0) {
    const highInTrick = [...trick].filter(t => t.card.suit === led)
      .sort((a, b) => RV[b.card.rank] - RV[a.card.rank])[0].card;
    const winners = following.filter(c => RV[c.rank] > RV[highInTrick.rank]);
    const losers  = following.filter(c => RV[c.rank] < RV[highInTrick.rank]);
    const penInTrick = trick.reduce((s, t) => s + Math.abs(cardVal(t.card)), 0);
    const last = trick.length === 3;

    if (penInTrick > 0) {
      if (losers.length) return losers.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
      return (winners.length ? winners : following).sort((a, b) => RV[a.rank] - RV[b.rank])[0];
    }
    if (last && winners.length) return winners.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
    if (losers.length) return losers.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
    return following.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
  }

  const qs = legal.find(c => c.suit === '♠' && c.rank === 'Q');
  if (qs) return qs;
  const hearts = legal.filter(c => c.suit === '♥').sort((a, b) => RV[b.rank] - RV[a.rank]);
  if (hearts.length) return hearts[0];
  return legal.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
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
    lastTrickMsg: '',
    moonShooter: -1,
    lastActivity: Date.now(),
  };
  return rooms[code];
}

function publicState(G) {
  return {
    code: G.code,
    phase: G.phase,
    players: G.players.map(p => ({
      name: p.name, isAI: p.isAI, score: p.score,
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
  }
  broadcastRoom(G);
}

// ── Deal & pass ─────────────────────────────────────────────────
function dealRound(G) {
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
  broadcastRoom(G);
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
    if (G.players[playerIndex]?.socketId !== socket.id) return;
    if (playerIndex !== currentPlayer(G)) return;
    const real = G.players[playerIndex].hand.find(c => eqC(c, card));
    if (!real || !canPlay(G, playerIndex, real)) return;
    doPlayCard(G, playerIndex, real);
  });

  socket.on('nextRound', ({ code }) => {
    const G = findRoom(code);
    if (!G || G.phase !== 'roundSummary' || !isHostSocket(G, socket)) return;
    if (G.round >= TOTAL_ROUNDS) { G.phase = 'final'; broadcastRoom(G); return; }
    G.round++;
    G.dealer = (G.dealer + 1) % 4;
    dealRound(G);
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

// Sweep abandoned rooms so memory doesn't grow forever
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000; // 3 hours idle
  for (const code in rooms) if (rooms[code].lastActivity < cutoff) delete rooms[code];
}, 15 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Dame de Pique running on port ${PORT}`));
