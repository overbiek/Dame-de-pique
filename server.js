const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Game constants ──────────────────────────────────────────────
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RV = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const SO = {'♠':0,'♥':1,'♦':2,'♣':3};

// ── In-memory rooms ─────────────────────────────────────────────
const rooms = {}; // roomCode -> gameState

function makeCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
  return d;
}

function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
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

function passDir(round) {
  return ['left', 'right', 'across', 'keep'][(round - 1) % 4];
}

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

function legalCards(G, pi) {
  return G.players[pi].hand.filter(c => canPlay(G, pi, c));
}

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

// ── AI logic ────────────────────────────────────────────────────
function aiSelectPass(G, i) {
  const hand = G.players[i].hand;
  const sorted = [...hand].sort((a, b) => {
    const sa = a.suit === '♠' && a.rank === 'Q' ? 1000 : a.suit === '♥' ? RV[a.rank] + 50 : RV[a.rank];
    const sb = b.suit === '♠' && b.rank === 'Q' ? 1000 : b.suit === '♥' ? RV[b.rank] + 50 : RV[b.rank];
    return sb - sa;
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
    } else {
      if (last && winners.length) return winners.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
      if (losers.length) return losers.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
      return following.sort((a, b) => RV[a.rank] - RV[b.rank])[0];
    }
  }

  const qs = legal.find(c => c.suit === '♠' && c.rank === 'Q');
  if (qs) return qs;
  const hearts = legal.filter(c => c.suit === '♥').sort((a, b) => RV[b.rank] - RV[a.rank]);
  if (hearts.length) return hearts[0];
  return legal.sort((a, b) => RV[b.rank] - RV[a.rank])[0];
}

// ── Game state helpers ──────────────────────────────────────────
function createRoom(hostName) {
  const code = makeCode();
  rooms[code] = {
    code,
    phase: 'lobby',   // lobby | draw | pass | play | roundSummary | final
    players: [
      { name: hostName, isAI: false, socketId: null, score: 0, hand: [], tricks: [], connected: true },
      { name: 'Waiting...', isAI: false, socketId: null, score: 0, hand: [], tricks: [], connected: false },
      { name: 'Waiting...', isAI: false, socketId: null, score: 0, hand: [], tricks: [], connected: false },
      { name: 'Waiting...', isAI: false, socketId: null, score: 0, hand: [], tricks: [], connected: false },
    ],
    hostSocket: null,
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
  };
  return rooms[code];
}

function roomPublicState(G) {
  // Strip hands — each player only gets their own hand via private emit
  return {
    code: G.code,
    phase: G.phase,
    players: G.players.map(p => ({
      name: p.name,
      isAI: p.isAI,
      score: p.score,
      connected: p.connected,
      cardCount: p.hand.length,
      hasPassed: p.hasPassed || false,
    })),
    round: G.round,
    dealer: G.dealer,
    heartsbroken: G.heartsbroken,
    currentTrick: G.currentTrick,
    trickLeader: G.trickLeader,
    trickNum: G.trickNum,
    drawCards: G.drawCards,
    drawRevealed: G.drawRevealed,
    roundBefore: G.roundBefore,
    lastTrickMsg: G.lastTrickMsg || '',
    moonShooter: G.moonShooter ?? -1,
  };
}

function emitRoom(G) {
  const pub = roomPublicState(G);
  // Send each human player their private hand
  for (let i = 0; i < 4; i++) {
    const p = G.players[i];
    if (!p.isAI && p.socketId) {
      io.to(p.socketId).emit('gameState', {
        ...pub,
        myIndex: i,
        myHand: sortH(p.hand),
        legalCards: G.phase === 'play' ? legalCards(G, i).map(c => c.rank + '|' + c.suit) : [],
        myPassSelected: G.passSelected[i] || [],
      });
    }
  }
}

function broadcastRoom(G) {
  emitRoom(G);
}

// ── Start draw phase ────────────────────────────────────────────
function startDraw(G) {
  G.phase = 'draw';
  const deck = shuffle(makeDeck());
  G.drawCards = deck.slice(0, 4);
  G.drawRevealed = [false, false, false, false];
  broadcastRoom(G);
  // AI players auto-reveal
  for (let i = 0; i < 4; i++) {
    if (G.players[i].isAI) {
      setTimeout(() => revealDrawCard(G, i), 400 + i * 500);
    }
  }
  // If ALL are AI, auto-proceed
  checkAllDrawn(G);
}

function revealDrawCard(G, i) {
  if (G.drawRevealed[i]) return;
  G.drawRevealed[i] = true;
  if (G.drawRevealed.every(r => r)) {
    let best = -1, bestV = -1;
    for (let j = 0; j < 4; j++) {
      const v = RV[G.drawCards[j].rank];
      if (v > bestV) { bestV = v; best = j; }
    }
    G.dealer = best;
    G.phase = 'drawDone';
    broadcastRoom(G);
    // If host is AI or all AI, auto-start
    setTimeout(() => {
      if (G.players.every(p => p.isAI)) dealRound(G);
    }, 1500);
  } else {
    broadcastRoom(G);
  }
}

function checkAllDrawn(G) {
  if (G.drawRevealed.every(r => r)) revealDrawCard(G, -1); // trigger resolution
}

// ── Deal & pass ─────────────────────────────────────────────────
function dealRound(G) {
  const deck = shuffle(makeDeck());
  for (let i = 0; i < 4; i++) G.players[i].hand = deck.slice(i * 13, (i + 1) * 13);
  G.passSelected = [null, null, null, null];
  G.heartsbroken = false;
  G.currentTrick = [];
  G.trickNum = 1;
  G.roundBefore = G.players.map(p => p.score);
  for (let i = 0; i < 4; i++) {
    G.players[i].tricks = [];
    G.players[i].hasPassed = false;
  }

  const dir = passDir(G.round);
  if (dir === 'keep') {
    startTricks(G);
    return;
  }

  G.phase = 'pass';
  // AI selects pass cards
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
  if (G.passSelected.every(s => s !== null && s.length === 2)) {
    executePass(G);
  }
}

function executePass(G) {
  const toAdd = [[], [], [], []];
  for (let i = 0; i < 4; i++) {
    const tgt = passTarget(i, G.round);
    for (const c of G.passSelected[i]) {
      const idx = G.players[i].hand.findIndex(x => eqC(x, c));
      toAdd[tgt].push(G.players[i].hand.splice(idx, 1)[0]);
    }
  }
  for (let i = 0; i < 4; i++) G.players[i].hand.push(...toAdd[i]);
  startTricks(G);
}

// ── Tricks ──────────────────────────────────────────────────────
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

function scheduleAI(G) {
  const cp = (G.trickLeader + G.currentTrick.length) % 4;
  if (G.players[cp].isAI && G.currentTrick.length < 4) {
    setTimeout(() => doAIPlay(G), 900);
  }
}

function doAIPlay(G) {
  if (G.phase !== 'play') return;
  const cp = (G.trickLeader + G.currentTrick.length) % 4;
  if (!G.players[cp].isAI) return;
  const card = aiChoose(G, cp);
  doPlayCard(G, cp, card);
}

function doPlayCard(G, pi, card) {
  const idx = G.players[pi].hand.findIndex(c => eqC(c, card));
  if (idx === -1) return;
  G.players[pi].hand.splice(idx, 1);
  G.currentTrick.push({ player: pi, card });
  if (card.suit === '♥') G.heartsbroken = true;
  if (card.suit === '♠' && card.rank === 'Q') G.heartsbroken = true;
  broadcastRoom(G);

  if (G.currentTrick.length === 4) {
    setTimeout(() => resolveTrick(G), 700);
  } else {
    scheduleAI(G);
  }
}

function resolveTrick(G) {
  const winner = trickWinner(G.currentTrick);
  const penPts = G.currentTrick.reduce((s, t) => s + cardVal(t.card), 0);
  G.players[winner].score += 10 + penPts;
  G.players[winner].tricks.push(...G.currentTrick.map(t => t.card));
  const extra = penPts !== 0 ? ` (${penPts > 0 ? '+' : ''}${penPts})` : '';
  G.lastTrickMsg = `${G.players[winner].name} wins trick ${G.trickNum} — +10${extra}`;
  G.currentTrick = [];
  G.trickNum++;
  G.trickLeader = winner;

  broadcastRoom(G);

  if (G.trickNum > 13) {
    setTimeout(() => endRound(G), 1000);
  } else {
    setTimeout(() => {
      broadcastRoom(G);
      scheduleAI(G);
    }, 800);
  }
}

function endRound(G) {
  const moon = checkMoon(G);
  G.moonShooter = moon;
  if (moon >= 0) {
    for (let i = 0; i < 4; i++) G.players[i].score += i === moon ? 60 : -20;
  }
  G.phase = G.round >= 16 ? 'final' : 'roundSummary';
  broadcastRoom(G);
}

// ── Socket.io events ────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }) => {
    const G = createRoom(name);
    G.players[0].socketId = socket.id;
    G.players[0].connected = true;
    G.hostSocket = socket.id;
    socket.join(G.code);
    socket.emit('roomCreated', { code: G.code, playerIndex: 0 });
    broadcastRoom(G);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const G = rooms[code.toUpperCase()];
    if (!G) { socket.emit('error', { msg: 'Room not found.' }); return; }
    if (G.phase !== 'lobby') { socket.emit('error', { msg: 'Game already started.' }); return; }

    // Find first open human slot
    let slot = -1;
    for (let i = 1; i < 4; i++) {
      if (!G.players[i].connected && !G.players[i].isAI) { slot = i; break; }
    }
    if (slot === -1) { socket.emit('error', { msg: 'Room is full.' }); return; }

    G.players[slot].name = name;
    G.players[slot].socketId = socket.id;
    G.players[slot].connected = true;
    socket.join(G.code);
    socket.emit('roomJoined', { code: G.code, playerIndex: slot });
    broadcastRoom(G);
  });

  socket.on('setAI', ({ code, slotIndex, isAI }) => {
    const G = rooms[code];
    if (!G || G.phase !== 'lobby') return;
    if (socket.id !== G.hostSocket) return;
    if (slotIndex === 0) return; // host can't make themselves AI
    G.players[slotIndex].isAI = isAI;
    G.players[slotIndex].connected = isAI;
    G.players[slotIndex].name = isAI ? 'Computer ' + (slotIndex + 1) : 'Waiting...';
    G.players[slotIndex].socketId = null;
    broadcastRoom(G);
  });

  socket.on('startGame', ({ code }) => {
    const G = rooms[code];
    if (!G) return;
    if (socket.id !== G.hostSocket) return;
    // All slots must be filled (human connected or AI)
    const allReady = G.players.every(p => p.connected || p.isAI);
    if (!allReady) { socket.emit('error', { msg: 'Not all players have joined yet.' }); return; }
    startDraw(G);
  });

  socket.on('revealDraw', ({ code, playerIndex }) => {
    const G = rooms[code];
    if (!G || G.phase !== 'draw') return;
    if (G.players[playerIndex].socketId !== socket.id) return;
    revealDrawCard(G, playerIndex);
  });

  socket.on('startRound', ({ code }) => {
    const G = rooms[code];
    if (!G || G.phase !== 'drawDone') return;
    if (socket.id !== G.hostSocket) return;
    dealRound(G);
  });

  socket.on('selectPass', ({ code, playerIndex, cards }) => {
    const G = rooms[code];
    if (!G || G.phase !== 'pass') return;
    if (G.players[playerIndex].socketId !== socket.id) return;
    if (cards.length !== 2) return;
    // Validate cards are in hand
    for (const c of cards) {
      if (!G.players[playerIndex].hand.some(x => eqC(x, c))) return;
    }
    G.passSelected[playerIndex] = cards;
    G.players[playerIndex].hasPassed = true;
    broadcastRoom(G);
    checkAllPassed(G);
  });

  socket.on('playCard', ({ code, playerIndex, card }) => {
    const G = rooms[code];
    if (!G || G.phase !== 'play') return;
    if (G.players[playerIndex].socketId !== socket.id) return;
    const cp = (G.trickLeader + G.currentTrick.length) % 4;
    if (playerIndex !== cp) return;
    if (!canPlay(G, playerIndex, card)) return;
    const realCard = G.players[playerIndex].hand.find(c => eqC(c, card));
    if (!realCard) return;
    doPlayCard(G, playerIndex, realCard);
  });

  socket.on('nextRound', ({ code }) => {
    const G = rooms[code];
    if (!G || G.phase !== 'roundSummary') return;
    if (socket.id !== G.hostSocket) return;
    G.round++;
    G.dealer = (G.dealer + 1) % 4;
    dealRound(G);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const G = rooms[code];
      for (const p of G.players) {
        if (p.socketId === socket.id) {
          p.connected = false;
          broadcastRoom(G);
        }
      }
    }
  });
});

// ── Start server ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Dame de Pique running on port ${PORT}`));
