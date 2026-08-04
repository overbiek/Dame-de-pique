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
