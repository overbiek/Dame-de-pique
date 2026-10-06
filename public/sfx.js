// sfx.js — sound effects for Dame de Pique
// Card-handling sounds (deal, place, pass, fan, shuffle) use real recorded
// samples from Kenney's Casino Audio pack (CC0). Everything else — chimes,
// UI clicks, win/lose stingers — is synthesized live via Web Audio, so no
// extra files are needed for those.

const SFX = (() => {
  let ctx = null;
  let masterGain = null;
  let muted = false;

  // name -> array of decoded AudioBuffers (multiple = randomized variation)
  const sampleBuffers = {};

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.7; // samples are quieter-headroom than synth tones
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // ---- sample loading --------------------------------------------------

  async function fetchAndDecode(url) {
    const c = getCtx();
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    return c.decodeAudioData(arrayBuffer);
  }

  // Load one or more variations under a single sound name, e.g.
  // SFX.load('cardDeal', ['sounds/card-deal-1.ogg', 'sounds/card-deal-2.ogg'])
  async function load(name, urls) {
    const list = Array.isArray(urls) ? urls : [urls];
    const buffers = await Promise.all(list.map(fetchAndDecode));
    sampleBuffers[name] = buffers;
    return buffers.length;
  }

  // Convenience loader for the default Kenney card-sound set. Assumes files
  // live under basePath with these exact names (adjust map if you renamed them).
  async function loadCardSounds(basePath = 'sounds/') {
    const map = {
      cardDeal:    ['card-deal-1.ogg', 'card-deal-2.ogg', 'card-deal-3.ogg', 'card-deal-4.ogg'],
      cardPlace:   ['card-place-1.ogg', 'card-place-2.ogg'],
      cardPass:    ['card-pass-1.ogg', 'card-pass-2.ogg'],
      cardFan:     ['card-fan-1.ogg', 'card-fan-2.ogg'],
      cardShuffle: ['card-shuffle.ogg'],
    };
    await Promise.all(
      Object.entries(map).map(([name, files]) =>
        load(name, files.map((f) => basePath + f))
      )
    );
  }

  function playSample(name, { gain = 1, rate = 1 } = {}) {
    const arr = sampleBuffers[name];
    if (!arr || !arr.length) return false;
    const c = getCtx();
    const buffer = arr[Math.floor(Math.random() * arr.length)];
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(masterGain);
    src.start();
    return true;
  }

  // ---- synthesis building blocks (unchanged from the original module) --

  function tone({ freq = 440, type = 'sine', duration = 0.15, delay = 0,
                  attack = 0.005, decay = 0.1, sustain = 0, gain = 1,
                  freqEnd = null, detune = 0 }) {
    const c = getCtx();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime + delay);
    osc.detune.value = detune;
    if (freqEnd !== null) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(freqEnd, 1), c.currentTime + delay + duration
      );
    }
    const t0 = c.currentTime + delay;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.linearRampToValueAtTime(gain * sustain, t0 + attack + decay);
    g.gain.linearRampToValueAtTime(0, t0 + duration);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function noise({ duration = 0.2, delay = 0, gain = 1,
                    filterType = 'bandpass', freqStart = 1000, freqEnd = 1000,
                    Q = 1, attack = 0.005, decay = 0.15 }) {
    const c = getCtx();
    const bufferSize = c.sampleRate * duration;
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const src = c.createBufferSource();
    src.buffer = buffer;

    const filter = c.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = Q;
    const t0 = c.currentTime + delay;
    filter.frequency.setValueAtTime(freqStart, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);

    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.linearRampToValueAtTime(0, t0 + attack + decay);

    src.connect(filter);
    filter.connect(g);
    g.connect(masterGain);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
  }

  // Synth fallbacks — used automatically if the matching sample hasn't
  // been loaded yet (e.g. loadCardSounds() hasn't resolved).
  function synthCardDeal() {
    noise({ duration: 0.1, gain: 0.5, filterType: 'highpass',
            freqStart: 2500, freqEnd: 1500, Q: 0.7, decay: 0.06 });
  }
  function synthCardPass() {
    noise({ duration: 0.22, gain: 0.35, filterType: 'bandpass',
            freqStart: 800, freqEnd: 300, Q: 0.9, decay: 0.18 });
    tone({ freq: 660, type: 'triangle', duration: 0.15, delay: 0.05,
           attack: 0.01, decay: 0.1, sustain: 0.3, gain: 0.2 });
  }

  // ---- presets -----------------------------------------------------------

  const presets = {

    // Single card sliding onto the table — uses real sample if loaded
    cardDeal() {
      if (!playSample('cardDeal', { gain: 0.9 })) synthCardDeal();
    },

    // Stagger cardDeal for the opening 13-card hand
    cardDealAll(count = 13, gapMs = 90) {
      for (let i = 0; i < count; i++) {
        setTimeout(() => presets.cardDeal(), i * gapMs);
      }
    },

    // A card settling into place (e.g. laid down to a trick)
    cardPlace() {
      if (!playSample('cardPlace', { gain: 0.9 })) synthCardDeal();
    },

    // Shuffling before a new hand
    cardShuffle() {
      if (!playSample('cardShuffle', { gain: 0.8 })) {
        noise({ duration: 0.5, gain: 0.3, filterType: 'bandpass',
                freqStart: 1200, freqEnd: 900, Q: 0.5, decay: 0.4 });
      }
    },

    // Cards fanning open in hand (e.g. reveal at seating draw / hand view)
    cardFan() {
      if (!playSample('cardFan', { gain: 0.85 })) {
        noise({ duration: 0.25, gain: 0.35, filterType: 'highpass',
                freqStart: 1800, freqEnd: 1200, Q: 0.8, decay: 0.2 });
      }
    },

    // Card flip / reveal (still synthesized — distinct "whoosh" character)
    cardFlip() {
      noise({ duration: 0.14, gain: 0.45, filterType: 'bandpass',
              freqStart: 600, freqEnd: 2200, Q: 1.2, decay: 0.1 });
    },

    // Card being picked up / selected
    cardPickup() {
      tone({ freq: 900, freqEnd: 1200, type: 'sine', duration: 0.06,
             attack: 0.002, decay: 0.03, gain: 0.25 });
    },

    // Passing three cards to another player — real sample if loaded
    passCards() {
      if (!playSample('cardPass', { gain: 0.9 })) synthCardPass();
    },

    // Confirmation chime — pass locked in, seat confirmed, etc.
    confirm() {
      [523.25, 783.99].forEach((f, i) => {
        tone({ freq: f, type: 'sine', duration: 0.18, delay: i * 0.07,
               attack: 0.005, decay: 0.1, sustain: 0.2, gain: 0.3 });
      });
    },

    // Won the trick — bright ascending triad
    trickWin() {
      [523.25, 659.25, 783.99].forEach((f, i) => {
        tone({ freq: f, type: 'triangle', duration: 0.22, delay: i * 0.06,
               attack: 0.005, decay: 0.12, sustain: 0.25, gain: 0.28 });
      });
    },

    // Took the Queen of Spades / a penalty card
    penaltyCard() {
      tone({ freq: 220, freqEnd: 110, type: 'sawtooth', duration: 0.4,
             attack: 0.005, decay: 0.3, sustain: 0.15, gain: 0.3 });
      noise({ duration: 0.3, gain: 0.25, filterType: 'lowpass',
              freqStart: 500, freqEnd: 150, Q: 0.6, decay: 0.25 });
    },

    // Trick lost / took penalty points, softer than penaltyCard
    trickLose() {
      [392, 329.63].forEach((f, i) => {
        tone({ freq: f, type: 'triangle', duration: 0.2, delay: i * 0.08,
               attack: 0.005, decay: 0.14, sustain: 0.2, gain: 0.25 });
      });
    },

    // Seating draw ceremony — sparkly ascending flourish
    seatingDraw() {
      const notes = [392, 440, 523.25, 587.33, 659.25, 783.99];
      notes.forEach((f, i) => {
        tone({ freq: f, type: 'sine', duration: 0.3, delay: i * 0.045,
               attack: 0.01, decay: 0.15, sustain: 0.1, gain: 0.18,
               detune: (Math.random() - 0.5) * 8 });
      });
    },

    // Round/game won — small fanfare
    gameWin() {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => {
        tone({ freq: f, type: 'triangle', duration: 0.3, delay: i * 0.09,
               attack: 0.005, decay: 0.15, sustain: 0.3, gain: 0.3 });
      });
    },

    // Round/game lost — short descending minor phrase
    gameLose() {
      const notes = [440, 392, 349.23, 293.66];
      notes.forEach((f, i) => {
        tone({ freq: f, type: 'sawtooth', duration: 0.28, delay: i * 0.1,
               attack: 0.005, decay: 0.18, sustain: 0.15, gain: 0.22 });
      });
    },

    // Generic UI click
    click() {
      tone({ freq: 1000, type: 'square', duration: 0.03, attack: 0.001,
             decay: 0.02, gain: 0.12 });
    },

    // Subtle error / invalid move buzz
    invalid() {
      tone({ freq: 180, type: 'square', duration: 0.12, attack: 0.001,
             decay: 0.08, sustain: 0.4, gain: 0.2 });
    },

    // Your turn notification
    yourTurn() {
      [587.33, 880].forEach((f, i) => {
        tone({ freq: f, type: 'sine', duration: 0.12, delay: i * 0.09,
               attack: 0.01, decay: 0.08, sustain: 0.1, gain: 0.2 });
      });
    },

    // ── Trick sweep: the four cards gathered off the table toward whoever won
    // them. `heavy` (a trick with hearts or the queen in it) adds a low thud.
    trickSweep(heavy) {
      noise({ duration: 0.3, gain: 0.34, filterType: 'bandpass',
              freqStart: 500, freqEnd: 2600, Q: 0.8, attack: 0.03, decay: 0.24 });
      noise({ duration: 0.22, delay: 0.16, gain: 0.2, filterType: 'highpass',
              freqStart: 2400, freqEnd: 1400, Q: 0.7, attack: 0.005, decay: 0.16 });
      tone({ freq: 130, freqEnd: 70, type: 'sine', duration: 0.18, delay: 0.2,
             attack: 0.004, decay: 0.12, gain: heavy ? 0.34 : 0.16 });
      if (heavy) {
        tone({ freq: 98, freqEnd: 58, type: 'sine', duration: 0.32, delay: 0.24,
               attack: 0.004, decay: 0.22, gain: 0.22 });
      }
    },

    // ── Queen of Spades hits the table: a low dissonant stab (a minor second),
    // a cymbal-like hiss, a falling squeal and a deep thump. The most dramatic
    // card in the game now sounds like it.
    queenSting() {
      tone({ freq: 98, type: 'sawtooth', duration: 1.1, attack: 0.01,
             decay: 0.8, sustain: 0.25, gain: 0.22 });
      tone({ freq: 103.83, type: 'sawtooth', duration: 1.1, attack: 0.01,
             decay: 0.8, sustain: 0.25, gain: 0.2 });
      tone({ freq: 392, type: 'square', duration: 0.5, attack: 0.004,
             decay: 0.4, sustain: 0.1, gain: 0.08 });
      tone({ freq: 415.3, type: 'square', duration: 0.5, attack: 0.004,
             decay: 0.4, sustain: 0.1, gain: 0.07 });
      tone({ freq: 62, freqEnd: 36, type: 'sine', duration: 0.5, attack: 0.003,
             decay: 0.4, gain: 0.5 });
      noise({ duration: 0.8, gain: 0.22, filterType: 'highpass',
              freqStart: 4200, freqEnd: 1800, Q: 0.5, attack: 0.005, decay: 0.7 });
      tone({ freq: 1568, freqEnd: 740, type: 'triangle', duration: 0.7,
             delay: 0.05, attack: 0.02, decay: 0.55, sustain: 0.1, gain: 0.07 });
    },

    // ── Moon pace: one player holds every penalty card so far. `level` is how
    // far along they are (0..1) — the riser climbs and the heartbeat quickens.
    moonBuild(level) {
      const l = Math.max(0, Math.min(1, Number(level) || 0.3));
      const f = 146.83 * Math.pow(2, l * 1.7);
      tone({ freq: f, freqEnd: f * 1.05, type: 'triangle', duration: 0.8,
             attack: 0.04, decay: 0.55, sustain: 0.3, gain: 0.14 + 0.1 * l });
      tone({ freq: f * 1.498, type: 'sine', duration: 0.7, delay: 0.04,
             attack: 0.04, decay: 0.5, sustain: 0.2, gain: 0.07 + 0.07 * l });
      noise({ duration: 0.7, gain: 0.05 + 0.1 * l, filterType: 'highpass',
              freqStart: 1500 + 2500 * l, freqEnd: 5000, Q: 0.6,
              attack: 0.25, decay: 0.4 });
      const gap = 0.34 - 0.14 * l;
      [0, gap, gap * 2.6, gap * 3.6].forEach((d, i) => {
        tone({ freq: 70, freqEnd: 45, type: 'sine', duration: 0.16, delay: d,
               attack: 0.003, decay: 0.12,
               gain: (i % 2 ? 0.26 : 0.36) * (0.5 + 0.5 * l) });
      });
    },

    // ── The moon shot itself, in two parts that match the on-screen rocket:
    // a rising rumble while it launches, then the boom + fanfare on impact.
    moonLaunch() {
      noise({ duration: 1.0, gain: 0.34, filterType: 'lowpass',
              freqStart: 180, freqEnd: 1800, Q: 0.7, attack: 0.08, decay: 0.9 });
      tone({ freq: 70, freqEnd: 520, type: 'sawtooth', duration: 1.0,
             attack: 0.05, decay: 0.85, sustain: 0.2, gain: 0.14 });
      tone({ freq: 140, freqEnd: 1040, type: 'triangle', duration: 1.0,
             attack: 0.05, decay: 0.85, sustain: 0.15, gain: 0.08 });
    },
    moonImpact() {
      tone({ freq: 72, freqEnd: 30, type: 'sine', duration: 0.9, attack: 0.003,
             decay: 0.8, gain: 0.7 });
      noise({ duration: 0.8, gain: 0.4, filterType: 'lowpass',
              freqStart: 1400, freqEnd: 120, Q: 0.6, attack: 0.003, decay: 0.7 });
      noise({ duration: 1.1, delay: 0.04, gain: 0.2, filterType: 'highpass',
              freqStart: 5000, freqEnd: 2500, Q: 0.5, attack: 0.01, decay: 1.0 });
      [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568].forEach((f, i) => {
        tone({ freq: f, type: 'triangle', duration: 0.5, delay: 0.12 + i * 0.075,
               attack: 0.005, decay: 0.3, sustain: 0.3, gain: 0.24 });
      });
      [261.63, 329.63, 392, 523.25].forEach((f) => {
        tone({ freq: f, type: 'sine', duration: 1.6, delay: 0.5, attack: 0.04,
               decay: 1.2, sustain: 0.3, gain: 0.12 });
      });
      for (let i = 0; i < 9; i++) {
        tone({ freq: 2200 + Math.random() * 3200, type: 'sine', duration: 0.18,
               delay: 0.25 + Math.random() * 0.9, attack: 0.002, decay: 0.12,
               gain: 0.07 });
      }
    },

    // ── Last five seconds of an auto-advance countdown. `left` is the seconds
    // remaining (5..1): the tick climbs in pitch and the last one lands.
    timerTick(left) {
      const n = Math.max(1, Math.min(5, Number(left) || 3));
      const f = 880 + (5 - n) * 150;
      tone({ freq: f, type: 'sine', duration: 0.07, attack: 0.002, decay: 0.05,
             gain: n === 1 ? 0.3 : 0.2 });
      tone({ freq: f * 2, type: 'sine', duration: 0.04, attack: 0.002,
             decay: 0.03, gain: 0.07 });
      if (n === 1) {
        tone({ freq: f * 0.75, type: 'triangle', duration: 0.25, delay: 0.05,
               attack: 0.004, decay: 0.2, gain: 0.12 });
      }
    },

    // ── Credit counter: a tiny coin tick per step (pitch climbs with progress
    // 0..1), then a bright register ring when the total lands.
    creditTick(p) {
      const f = 1500 + 1400 * Math.max(0, Math.min(1, Number(p) || 0));
      tone({ freq: f, type: 'triangle', duration: 0.05, attack: 0.001,
             decay: 0.035, gain: 0.1 });
      tone({ freq: f * 1.5, type: 'sine', duration: 0.035, attack: 0.001,
             decay: 0.025, gain: 0.05 });
    },
    creditTally() {
      [1318.5, 1760, 2093].forEach((f, i) => {
        tone({ freq: f, type: 'triangle', duration: 0.5, delay: i * 0.055,
               attack: 0.002, decay: 0.4, sustain: 0.1, gain: 0.2 });
      });
      noise({ duration: 0.3, delay: 0.02, gain: 0.12, filterType: 'highpass',
              freqStart: 6000, freqEnd: 4000, Q: 0.7, attack: 0.002, decay: 0.25 });
    },

    // ── Ranked: three rising bells when a table has been found.
    matchFound() {
      [659.25, 987.77, 1318.5].forEach((f, i) => {
        tone({ freq: f, type: 'sine', duration: 0.5, delay: i * 0.11,
               attack: 0.005, decay: 0.4, sustain: 0.15, gain: 0.26 });
      });
      [329.63, 493.88].forEach((f) => {
        tone({ freq: f, type: 'triangle', duration: 0.7, delay: 0.1,
               attack: 0.01, decay: 0.5, sustain: 0.2, gain: 0.14 });
      });
      noise({ duration: 0.5, gain: 0.12, filterType: 'bandpass',
              freqStart: 400, freqEnd: 3000, Q: 0.8, attack: 0.04, decay: 0.35 });
    },

    // ── Ranked: promoted to a new TIER. `tier` is 1..7 (the new tier's index —
    // Apprentice=1 ... Legend=7). Every tier is the same idea played bigger:
    // a longer climbing arpeggio, a fuller chord, more sparkle, and from Ace
    // up a low pad; Legend adds bell strikes.
    rankUp(tier) {
      const t = Math.max(1, Math.min(7, Math.round(Number(tier)) || 1));
      const root = 261.63 * Math.pow(2, (t - 1) * 2 / 12);
      const steps = [0, 4, 7, 12, 16, 19, 24, 28, 31, 36];
      const n = 3 + t;
      for (let i = 0; i < n; i++) {
        const f = root * Math.pow(2, steps[i % steps.length] / 12);
        tone({ freq: f, type: 'triangle', duration: 0.4, delay: i * 0.075,
               attack: 0.004, decay: 0.28, sustain: 0.25, gain: 0.22 });
        if (t >= 3) {
          tone({ freq: f * 2, type: 'sine', duration: 0.25, delay: i * 0.075,
                 attack: 0.004, decay: 0.18, gain: 0.07 });
        }
      }
      const end = n * 0.075;
      [0, 4, 7].concat(t >= 3 ? [12] : [], t >= 5 ? [16] : []).forEach((st) => {
        tone({ freq: root * Math.pow(2, st / 12), type: 'sine',
               duration: 1.1 + 0.12 * t, delay: end, attack: 0.02,
               decay: 0.8 + 0.1 * t, sustain: 0.3, gain: 0.14 });
      });
      for (let i = 0; i < t * 2; i++) {
        tone({ freq: 2400 + Math.random() * 3000, type: 'sine', duration: 0.2,
               delay: end * 0.5 + Math.random() * 0.8, attack: 0.002,
               decay: 0.14, gain: 0.06 });
      }
      if (t >= 5) {
        tone({ freq: root / 2, type: 'sine', duration: 1.8, delay: end,
               attack: 0.05, decay: 1.4, sustain: 0.3, gain: 0.22 });
      }
      if (t >= 7) {
        [1046.5, 1568, 1046.5 * 2.76].forEach((f, i) => {
          tone({ freq: f, type: 'sine', duration: 2.0, delay: end + i * 0.12,
                 attack: 0.003, decay: 1.7, sustain: 0.05, gain: 0.14 });
        });
      }
    },
  };

  // ---- public API ---------------------------------------------------------

  function play(name, ...args) {
    if (muted) return;
    const fn = presets[name];
    if (!fn) return console.warn(`SFX: unknown sound "${name}"`);
    try {
      fn(...args);
    } catch (e) {
      console.warn('SFX playback failed', e);
    }
  }

  function setVolume(v) {
    getCtx();
    masterGain.gain.value = Math.max(0, Math.min(1, v));
  }

  function setMuted(m) {
    muted = m;
  }

  function unlock() {
    getCtx();
  }

  return { play, setVolume, setMuted, unlock, load, loadCardSounds, presets };
})();

// Example usage:
// document.getElementById('startBtn').addEventListener('click', async () => {
//   SFX.unlock();
//   await SFX.loadCardSounds('sounds/'); // point at wherever you host the .ogg files
//   SFX.play('cardDealAll');
// });
//
// socket.on('trickWon', () => SFX.play('trickWin'));
// socket.on('queenOfSpadesPlayed', () => SFX.play('penaltyCard'));
// socket.on('cardPassed', () => SFX.play('passCards'));
