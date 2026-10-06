// music.js — background music and room ambience (campaign).
//
// TWO independent layers, both behind the Music toggle (the Sound toggle is
// sfx.js's and stays separate):
//
//  1. MUSIC — one looping track per House, played from an mp3 under
//     /audio/music/<id>.mp3 ("spades", "hearts", "clubs", "diamonds", and an
//     optional "<house>-endgame" for each House's final chapter). A track that
//     doesn't exist yet is simply silent (one 404, remembered) — drop the file
//     in and it plays, no code change.
//  2. AMBIENCE — a "room bed" per chapter, synthesized live from filtered noise
//     and random events. Procedural on purpose: it has no loop point, so it can
//     run for an hour without a seam, costs no bytes, and one recipe table
//     gives all 40 rooms their own sound. A recorded loop can replace any
//     of them later.
//
// Shares sfx.js's AudioContext (SFX.context()) so there's one unlock.

const Music = (() => {
  // Where each track should sit: this RMS, in dBFS. Sound effects peak around
  // -14 dBFS, so music has to sit well under them or the cards get buried.
  const TARGET_DB = -26;

  let ctx = null, outGain = null, musicBus = null, bedBus = null, analyser = null;
  let muted = false;
  let trackGen = 0;                       // supersedes in-flight track loads

  const buffers = new Map();              // id -> {buffer, loopEnd, xfade, gain}
  const missing = new Set();              // ids that 404'd — never asked twice
  const loading = {};                     // id -> Promise

  let want = { track: null, fallback: null, bed: null, tension: false };
  let cur = null;                         // the running loop
  let curBed = null;                      // the running ambience bed

  // ---- graph --------------------------------------------------------------
  function ensure() {
    if (ctx) return true;
    ctx = (typeof SFX !== 'undefined' && SFX.context) ? SFX.context() : null;
    if (!ctx) return false;
    outGain = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    outGain.connect(analyser);
    analyser.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.connect(outGain);
    bedBus = ctx.createGain();
    bedBus.gain.value = 0.48;
    bedBus.connect(outGain);
    document.addEventListener('visibilitychange', onVisibility);
    return true;
  }

  // Backgrounded: fade out and stop the clock so nothing plays behind another
  // app (a phone call, another game). Foregrounded: bring it back.
  function onVisibility() {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (document.hidden) {
      outGain.gain.cancelScheduledValues(now);
      outGain.gain.setValueAtTime(outGain.gain.value, now);
      outGain.gain.linearRampToValueAtTime(0, now + 0.25);
      setTimeout(() => { if (document.hidden && ctx.state === 'running') ctx.suspend(); }, 350);
    } else {
      const p = ctx.resume();
      const up = () => {
        const t = ctx.currentTime;
        outGain.gain.cancelScheduledValues(t);
        outGain.gain.setValueAtTime(outGain.gain.value, t);
        outGain.gain.linearRampToValueAtTime(1, t + 0.6);
      };
      if (p && p.then) p.then(up).catch(up); else up();
    }
  }

  // ---- music: load + analyse ---------------------------------------------
  // Finds where the music actually ENDS. Suno-style tracks fade out, and a
  // loop that crossfades through the fade-out dips every lap, so the loop
  // point is the last stretch that is still at normal energy (>= 70% of the
  // track's median level, measured in 2s windows). Also measures loudness so
  // every track lands at TARGET_DB without hand-tuning.
  function analyse(buffer) {
    const d = buffer.getChannelData(0);
    const W = Math.floor(buffer.sampleRate * 2);
    const wins = [];
    let total = 0;
    for (let i = 0; i + W <= d.length; i += W) {
      let s = 0;
      for (let k = i; k < i + W; k++) s += d[k] * d[k];
      total += s;
      wins.push(Math.sqrt(s / W));
    }
    const rmsAll = Math.sqrt(total / Math.max(1, wins.length * W));
    const mid = wins.slice(Math.floor(wins.length * 0.1), Math.max(Math.floor(wins.length * 0.7), 2))
                    .slice().sort((a, b) => a - b);
    const median = mid[Math.floor(mid.length / 2)] || rmsAll;
    let last = wins.length - 1;
    while (last > 0 && wins[last] < median * 0.7) last--;
    let loopEnd = (last + 1) * 2;
    if (loopEnd < 20 || loopEnd > buffer.duration) loopEnd = buffer.duration;
    const rmsDb = 20 * Math.log10(rmsAll + 1e-9);
    const gain = Math.max(0.15, Math.min(1.5, Math.pow(10, (TARGET_DB - rmsDb) / 20)));
    return { buffer, loopEnd, xfade: Math.min(6, loopEnd * 0.08), gain, rmsDb };
  }

  function load(id) {
    if (buffers.has(id)) return Promise.resolve(buffers.get(id));
    if (missing.has(id)) return Promise.resolve(null);
    if (loading[id]) return loading[id];
    loading[id] = (async () => {
      try {
        const res = await fetch('/audio/music/' + id + '.mp3');
        if (!res.ok) { missing.add(id); return null; }
        const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
        const t = analyse(buffer);
        buffers.set(id, t);
        return t;
      } catch (e) {
        missing.add(id);
        return null;
      } finally {
        delete loading[id];
      }
    })();
    return loading[id];
  }

  // ---- music: the crossfading loop ---------------------------------------
  // Equal-power curves, so the overlap of the loop's end and its own start
  // doesn't dip in the middle.
  const N = 64;
  const IN = new Float32Array(N), OUT = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    IN[i] = Math.sin((i / (N - 1)) * Math.PI / 2);
    OUT[i] = Math.cos((i / (N - 1)) * Math.PI / 2);
  }
  const scaled = (curve, k) => curve.map((v) => v * k);

  // One "voice" is one pass through the track. A new voice is started
  // `xfade` seconds before the current one ends and fades in over that same
  // span while the old one fades out — a seamless lap, whatever the mp3's own
  // encoder padding does to its first and last milliseconds.
  function startVoice(loop, when, fadeIn) {
    const t = loop.t, k = t.gain, L = t.loopEnd, X = t.xfade;
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(loop.gain);
    g.gain.setValueAtTime(0, when);
    g.gain.setValueCurveAtTime(scaled(IN, k), when, fadeIn);
    g.gain.setValueAtTime(k, when + fadeIn);
    g.gain.setValueCurveAtTime(scaled(OUT, k), when + L - X, X);
    src.start(when);
    src.stop(when + L + 0.05);
    loop.voices.add(src);
    src.onended = () => { loop.voices.delete(src); try { g.disconnect(); } catch (e) {} };
    loop.nextAt = when + L - X;
    // Queue the next lap ~2s before it is due.
    const ahead = Math.max(0, loop.nextAt - ctx.currentTime - 2) * 1000;
    loop.timer = setTimeout(() => { if (!loop.stopped) startVoice(loop, loop.nextAt, X); }, ahead);
  }

  function startLoop(id, t) {
    if (cur) stopLoop(cur, 2.0);
    const loop = { id, t, gain: ctx.createGain(), voices: new Set(), timer: null, stopped: false, nextAt: 0 };
    loop.gain.connect(musicBus);
    cur = loop;
    startVoice(loop, ctx.currentTime + 0.05, 2.5);
    // Only the playing track stays decoded (a 2:30 stereo track is ~57MB).
    for (const k of Array.from(buffers.keys())) if (k !== id) buffers.delete(k);
  }

  function stopLoop(loop, fade) {
    if (!loop || loop.stopped) return;
    loop.stopped = true;
    clearTimeout(loop.timer);
    const now = ctx.currentTime;
    loop.gain.gain.cancelScheduledValues(now);
    loop.gain.gain.setValueAtTime(loop.gain.gain.value, now);
    loop.gain.gain.linearRampToValueAtTime(0, now + fade);
    setTimeout(() => {
      loop.voices.forEach((s) => { try { s.stop(); } catch (e) {} });
      try { loop.gain.disconnect(); } catch (e) {}
    }, (fade + 0.3) * 1000);
    if (cur === loop) cur = null;
  }

  async function applyTrack() {
    const ids = [want.track, want.fallback].filter(Boolean);
    if (!ids.length) { stopLoop(cur, 1.5); return; }
    const gen = ++trackGen;
    for (const id of ids) {
      if (cur && cur.id === id && !cur.stopped) return;      // already on it
      if (missing.has(id)) continue;
      const t = buffers.get(id) || await load(id);
      if (gen !== trackGen || muted) return;                  // superseded
      if (!t) continue;
      startLoop(id, t);
      return;
    }
    stopLoop(cur, 1.5);                                       // nothing available
  }

  // ---- ambience: procedural room beds ------------------------------------
  const noiseCache = {};
  function noiseBuffer(color) {
    if (noiseCache[color]) return noiseCache[color];
    const len = ctx.sampleRate * 4;
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    if (color === 'white') {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } else if (color === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {                                                  // brown
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    noiseCache[color] = b;
    return b;
  }

  const rand = (a, b) => a + Math.random() * (b - a);

  // A running bed. `env.later` runs a function after a delay for as long as the
  // bed is alive; `env.stops` collects whatever must be stopped with it.
  function makeEnv(out) {
    const env = { ctx, out, alive: true, timers: new Set(), stops: [] };
    env.later = (fn, ms) => {
      const id = setTimeout(() => { env.timers.delete(id); if (env.alive) fn(); }, ms);
      env.timers.add(id);
    };
    env.every = (delayFn, fn) => {
      const tick = () => { fn(); env.later(tick, delayFn()); };
      env.later(tick, delayFn());
    };
    env.noise = (color, chain, gain) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(color);
      src.loop = true;
      src.loopStart = rand(0, 1);
      let node = src;
      chain.forEach((f) => { const b = ctx.createBiquadFilter(); b.type = f[0]; b.frequency.value = f[1]; b.Q.value = f[2] || 0.7; node.connect(b); node = b; });
      const g = ctx.createGain();
      g.gain.value = gain;
      node.connect(g);
      g.connect(out);
      src.start();
      env.stops.push(() => src.stop());
      return g;
    };
    env.lfo = (param, freq, depth) => {
      const o = ctx.createOscillator();
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g);
      g.connect(param);
      o.start();
      env.stops.push(() => o.stop());
    };
    env.tone = (freq, gain) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(out);
      o.start();
      env.stops.push(() => o.stop());
      return g;
    };
    // a short filtered puff of noise (a raindrop, a fire pop, a page)
    env.puff = (f, Q, dur, gain) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer('white');
      const b = ctx.createBiquadFilter();
      b.type = 'bandpass'; b.frequency.value = f; b.Q.value = Q;
      const g = ctx.createGain();
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(b); b.connect(g); g.connect(out);
      src.start(t, rand(0, 3), dur + 0.05);
    };
    // a short pitched blip (a drip, a tick, a bell)
    env.blip = (f0, f1, dur, gain, type) => {
      const o = ctx.createOscillator();
      o.type = type || 'sine';
      const t = ctx.currentTime;
      o.frequency.setValueAtTime(f0, t);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur + 0.05);
    };
    return env;
  }

  // The components. Each takes (env, {i: intensity, ...}); gains are small on
  // purpose — a bed should be felt, not noticed.
  const PART = {
    // steady rain on glass/stone: a hiss plus individual drops
    rain(env, o) {
      const i = o.i == null ? 0.6 : o.i;
      const g = env.noise('pink', [['highpass', 700], ['lowpass', 8000]], 0.2 * i);
      env.lfo(g.gain, 0.17, 0.04 * i);
      env.every(() => rand(35, 110), () => env.puff(rand(2500, 6500), 3, 0.03, rand(0.02, 0.05) * i));
    },
    // wind that swells and settles
    wind(env, o) {
      const i = o.i == null ? 0.6 : o.i;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer('brown'); src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 500; f.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.value = 0.34 * i;
      src.connect(f); f.connect(g); g.connect(env.out); src.start();
      env.stops.push(() => src.stop());
      env.lfo(f.frequency, 0.07, 260);
      env.lfo(g.gain, 0.05, 0.12 * i);
    },
    // room tone: a low hum plus a breath of lowpassed noise
    hum(env, o) {
      const i = o.i == null ? 1 : o.i, f = o.f || 55;
      env.tone(f, 0.022 * i);
      env.tone(f * 1.5, 0.012 * i);
      env.noise('brown', [['lowpass', 160]], 0.05 * i);
    },
    // distant city: a very low, wide rumble
    city(env, o) {
      const i = o.i == null ? 0.6 : o.i;
      env.noise('brown', [['lowpass', 180]], 0.09 * i);
    },
    // a murmur of voices that swells and falls, nobody saying anything
    crowd(env, o) {
      const i = o.i == null ? 0.5 : o.i, lp = o.lp || 1400;
      const g = env.out.context.createGain();
      g.gain.value = 0.2 * i;
      g.connect(env.out);
      [[330, 1.2], [720, 1.4], [1250, 1.6]].forEach(([fq, q]) => {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer('pink'); src.loop = true; src.loopStart = rand(0, 2);
        const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = fq; b.Q.value = q;
        const l = ctx.createBiquadFilter(); l.type = 'lowpass'; l.frequency.value = lp;
        src.connect(b); b.connect(l); l.connect(g); src.start();
        env.stops.push(() => src.stop());
      });
      env.lfo(g.gain, 0.11, 0.07 * i);
      env.lfo(g.gain, 0.29, 0.05 * i);
    },
    // a clock: tick, tock
    clock(env, o) {
      const i = o.i == null ? 0.7 : o.i, rate = o.rate || 1;
      let n = 0;
      env.every(() => 1000 / rate, () => {
        const hi = (n++ % 2) === 0;
        env.puff(hi ? 2400 : 1800, 4, 0.02, 0.05 * i);
        env.blip(hi ? 1900 : 1500, null, 0.03, 0.02 * i, 'triangle');
      });
    },
    // a hearth: a low roar and random pops
    fire(env, o) {
      const i = o.i == null ? 0.5 : o.i;
      env.noise('brown', [['lowpass', 450]], 0.05 * i);
      env.every(() => rand(90, 520), () => env.puff(rand(1200, 4200), 1, rand(0.01, 0.05), rand(0.02, 0.09) * i));
    },
    // water: slow drips and a faint hiss
    drip(env, o) {
      const i = o.i == null ? 0.6 : o.i;
      env.noise('pink', [['lowpass', 900]], 0.015 * i);
      env.every(() => rand(1200, 4200), () => { const f = rand(700, 1100); env.blip(f, f * 0.55, 0.13, 0.03 * i); });
    },
    // glass/bell tones far away
    chimes(env, o) {
      const i = o.i == null ? 0.6 : o.i;
      env.every(() => rand(2500, 7000), () => {
        const f = [1568, 1760, 2093, 2349][Math.floor(Math.random() * 4)];
        env.blip(f, null, 2.2, 0.012 * i);
        env.blip(f * 2.76, null, 1.2, 0.004 * i);
      });
    },
    // endgame tension: a very low drone and a slow heartbeat
    pulse(env, o) {
      const i = o.i == null ? 0.8 : o.i;
      const g = env.tone(43, 0.05 * i);
      env.lfo(g.gain, 0.12, 0.025 * i);
      env.every(() => 1150, () => {
        env.blip(62, 40, 0.18, 0.09 * i);
        env.later(() => env.blip(58, 38, 0.16, 0.06 * i), 230);
      });
    },
  };

  // Every chapter's room. Same ingredients, different mix — the ones named for
  // a place sound like it (rain on the roof, a fire in the library, a lantern
  // room), and each House's final chapter gets the heartbeat via `tension`.
  const BEDS = {
    // House of Spades
    velvet_entrance:     [['rain', { i: 0.5 }], ['crowd', { i: 0.3, lp: 600 }], ['hum']],
    // (rooftop / lounge / cabaret / ballroom: the voices-in-the-background layer
    //  is to be a recorded loop, so no synthesized chatter here meanwhile)
    rooftop:             [['wind', { i: 0.4 }]],
    grand_library:       [['hum', { i: 0.7 }], ['clock', { rate: 0.8 }], ['fire', { i: 0.4 }]],
    carnival_lounge:     [['hum', { i: 0.5 }]],
    conservatory:        [['drip', { i: 0.9 }], ['wind', { i: 0.15 }], ['rain', { i: 0.2 }]],
    cabaret_of_oddities: [['hum', { i: 0.7 }], ['chimes', { i: 0.4 }]],
    grand_ballroom:      [['hum', { i: 0.5, f: 49 }], ['clock', { rate: 0.5, i: 0.5 }]],
    vault:               [['hum', { i: 1.2, f: 41 }], ['clock', { rate: 0.5 }]],
    countess_antechamber:[['hum', { i: 0.6 }], ['clock', { rate: 0.6 }], ['fire', { i: 0.25 }]],
    hidden_throne_room:  [['hum', { i: 1, f: 36 }]],
    // House of Hearts
    red_foyer:           [['crowd', { i: 0.35, lp: 800 }], ['hum', { i: 0.6 }], ['fire', { i: 0.25 }]],
    mirror_gallery:      [['hum', { i: 0.7 }], ['chimes', { i: 0.7 }]],
    letter_archive:      [['hum', { i: 0.6 }], ['clock', { rate: 0.7 }], ['fire', { i: 0.3 }]],
    crimson_cabaret:     [['crowd', { i: 0.7, lp: 1100 }], ['hum', { i: 0.7 }]],
    rose_conservatory:   [['drip', { i: 0.7 }], ['wind', { i: 0.2 }], ['chimes', { i: 0.3 }]],
    menagerie_salon:     [['crowd', { i: 0.35, lp: 700 }], ['wind', { i: 0.25 }], ['hum']],
    salon_of_secrets:    [['hum', { i: 0.7 }], ['fire', { i: 0.45 }], ['clock', { rate: 0.6, i: 0.5 }]],
    gilded_exchange:     [['crowd', { i: 0.7, lp: 1500 }], ['clock', { rate: 1.2, i: 0.5 }]],
    inner_circle:        [['hum', { i: 0.8 }], ['fire', { i: 0.3 }]],
    rose_throne:         [['hum', { i: 1, f: 38 }], ['chimes', { i: 0.4 }]],
    // House of Clubs
    green_vestibule:     [['hum', { i: 0.6 }], ['wind', { i: 0.25 }], ['drip', { i: 0.3 }]],
    map_room:            [['hum', { i: 0.6 }], ['fire', { i: 0.35 }], ['clock', { rate: 0.7 }]],
    service_maze:        [['hum', { i: 1, f: 50 }], ['drip', { i: 0.5 }]],
    common_chamber:      [['crowd', { i: 0.5, lp: 1000 }], ['fire', { i: 0.4 }]],
    root_gallery:        [['wind', { i: 0.4 }], ['drip', { i: 0.5 }], ['hum', { i: 0.5 }]],
    lantern_salon:       [['fire', { i: 0.55 }], ['crowd', { i: 0.25, lp: 700 }]],
    ledger_room:         [['clock', { rate: 1, i: 0.8 }], ['hum', { i: 0.7 }]],
    council_gallery:     [['crowd', { i: 0.35, lp: 800 }], ['hum', { i: 0.7, f: 46 }]],
    twin_table_hall:     [['crowd', { i: 0.4, lp: 900 }], ['clock', { rate: 0.8, i: 0.6 }], ['hum']],
    root_crown_chamber:  [['hum', { i: 1, f: 38 }], ['wind', { i: 0.3 }]],
    // House of Diamonds
    facet_hall:          [['chimes', { i: 0.7 }], ['hum', { i: 0.6 }]],
    the_exchange:        [['crowd', { i: 0.7, lp: 1500 }], ['clock', { rate: 1.3, i: 0.5 }]],
    echo_gallery:        [['chimes', { i: 0.8 }], ['hum', { i: 0.8, f: 44 }]],
    split_chamber:       [['hum', { i: 1, f: 52 }], ['clock', { rate: 0.9, i: 0.5 }]],
    mirror_vault:        [['hum', { i: 1, f: 41 }], ['chimes', { i: 0.6 }]],
    gilded_auction:      [['crowd', { i: 0.8, lp: 1400 }], ['clock', { rate: 1.2, i: 0.4 }]],
    tribunal_of_play:    [['hum', { i: 0.9, f: 48 }], ['crowd', { i: 0.25, lp: 700 }]],
    pressure_engine:     [['hum', { i: 1.3, f: 60 }], ['clock', { rate: 1.6, i: 0.6 }]],
    hall_of_keepers:     [['crowd', { i: 0.3, lp: 700 }], ['fire', { i: 0.35 }], ['hum']],
    diamond_crown:       [['hum', { i: 1, f: 36 }], ['chimes', { i: 0.5 }]],
  };
  const DEFAULT_BED = [['hum', { i: 0.7 }]];

  function buildBed(key, parts) {
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(bedBus);
    const env = makeEnv(out);
    parts.forEach(([name, opt]) => { try { PART[name](env, opt || {}); } catch (e) { console.warn('Music bed part failed', name, e); } });
    const t = ctx.currentTime;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(1, t + 2.5);
    return {
      key,
      stop(fade) {
        env.alive = false;
        const now = ctx.currentTime;
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(out.gain.value, now);
        out.gain.linearRampToValueAtTime(0, now + fade);
        setTimeout(() => {
          env.timers.forEach(clearTimeout);
          env.stops.forEach((f) => { try { f(); } catch (e) {} });
          try { out.disconnect(); } catch (e) {}
        }, (fade + 0.3) * 1000);
      },
    };
  }

  function applyBed() {
    const key = want.bed ? want.bed + (want.tension ? '+t' : '') : null;
    if (!key) { if (curBed) { curBed.stop(2); curBed = null; } return; }
    if (curBed && curBed.key === key) return;
    if (curBed) curBed.stop(2);
    const parts = (BEDS[want.bed] || DEFAULT_BED).slice();
    if (want.tension) parts.push(['pulse', { i: 0.9 }]);
    curBed = buildBed(key, parts);
  }

  // ---- public ------------------------------------------------------------
  function apply() {
    if (muted || !ensure()) return;
    applyBed();
    applyTrack();
  }

  // Say what SHOULD be playing; this works out the difference. Idempotent, so
  // it is safe to call on every screen change.
  //   track     — music id to play (or null for none)
  //   fallback  — played instead if `track` has no file (e.g. a House's
  //               endgame track before it exists)
  //   bed       — ambience recipe key (a chapter slug), or null
  //   tension   — add the heartbeat layer (a House's final chapter)
  //
  // Asking for nothing doesn't stop things at once: a hand ends on the final
  // screen and the player lands back on the map a few seconds later, and the
  // same room should simply carry on through that rather than restart.
  let graceTimer = null;
  const GRACE_MS = 6000;
  //
  // `set(null, {now:true})` skips the grace and fades out in under a second:
  // for leaving on purpose (back to the menu, or the House picker), where
  // music carrying on would just feel like a bug.
  function set(opts, flags) {
    const o = opts || {};
    const next = { track: o.track || null, fallback: o.fallback || null, bed: o.bed || null, tension: !!o.tension };
    clearTimeout(graceTimer);
    graceTimer = null;
    if (!next.track && !next.bed) {
      if (flags && flags.now) {
        want = next;
        trackGen++;
        if (ctx) {
          stopLoop(cur, 0.7);
          if (curBed) { curBed.stop(0.7); curBed = null; }
        }
        return;
      }
      if (!cur && !curBed) { want = next; return; }          // nothing to wind down
      graceTimer = setTimeout(() => { want = next; if (!muted) apply(); }, GRACE_MS);
      return;
    }
    want = next;
    if (muted) return;
    apply();
  }

  function setMuted(m) {
    muted = !!m;
    if (muted) {
      if (!ctx) return;
      trackGen++;
      stopLoop(cur, 0.5);
      if (curBed) { curBed.stop(0.5); curBed = null; }
    } else if (want.track || want.bed) {
      apply();                         // (no graph yet and nothing wanted: stay lazy)
    }
  }

  // Dialogue and cinematics: tuck the music under the voices.
  function duck(on) {
    if (!ctx) return;
    const now = ctx.currentTime;
    musicBus.gain.cancelScheduledValues(now);
    musicBus.gain.setValueAtTime(musicBus.gain.value, now);
    musicBus.gain.linearRampToValueAtTime(on ? 0.45 : 1, now + 0.4);
  }

  // For tests: what is actually going on right now.
  function debug() {
    let level = null;
    if (analyser) {
      const a = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(a);
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i] * a[i];
      level = +(20 * Math.log10(Math.sqrt(s / a.length) + 1e-9)).toFixed(1);
    }
    return {
      muted, track: cur && !cur.stopped ? cur.id : null, bed: curBed ? curBed.key : null,
      ctxState: ctx ? ctx.state : null, levelDb: level, missing: Array.from(missing),
      loop: cur && cur.t ? { loopEnd: cur.t.loopEnd, xfade: cur.t.xfade, gain: +cur.t.gain.toFixed(3), rmsDb: +cur.t.rmsDb.toFixed(1) } : null,
    };
  }

  return { set, setMuted, isMuted: () => muted, duck, debug, BEDS: Object.keys(BEDS) };
})();
