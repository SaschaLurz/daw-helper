/*
 * instruments.js — Sound lab's sounds, all synthesised (nothing to download):
 * the plain waves, keys, guitars and strings, synths, basses and a drum kit;
 * the mix they play into (a reverb send per part, and a limiter so the sum
 * never clips); and a player for progressions that works on any audio
 * context — the page's own, or an offline one that renders a WAV file, so an
 * export sounds exactly like playback.
 *
 * Engines:
 *   wave   one oscillator: sine, triangle, square, sawtooth or the soft wave
 *   synth  oscillators (detuned, panned, or a unison stack) → filter with its
 *          own envelope → amplitude envelope, with optional vibrato
 *   fm     a sine carrier whose frequency a second sine modulates, the
 *          modulation fading as the note rings: electric piano, bells
 *   pluck  Karplus–Strong: a burst of noise circulating in a delay one period
 *          long, averaged on each pass, which rings and dulls like a string.
 *          Rendered into a buffer per pitch and cached
 *   piano  slightly inharmonic sine partials, each dying away at its own
 *          rate, two strings a hair apart, and a felt hammer's thump
 *
 * Loaded as a plain <script> in the browser (window.Instruments) after
 * tones.js, and via require() in Node, where the tests check the presets,
 * the string model and (with a stand-in context) that every voice builds.
 */
(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./tones.js') : root.Tones);
  root.Instruments = api;
  if (node) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Tones) {
  'use strict';

  // gain: a trim that makes the presets about equally loud; reverb: the send
  // to the room; program: the General MIDI instrument for exports.
  const PRESETS = [
    { id: 'soft', group: 'Waves', name: 'Soft', engine: 'wave', gain: 0.43, program: 79 },
    { id: 'sine', group: 'Waves', name: 'Sine', engine: 'wave', gain: 0.35, program: 79 },
    { id: 'triangle', group: 'Waves', name: 'Triangle', engine: 'wave', gain: 0.43, program: 79 },
    { id: 'square', group: 'Waves', name: 'Square', engine: 'wave', gain: 0.3, program: 80 },
    { id: 'sawtooth', group: 'Waves', name: 'Sawtooth', engine: 'wave', gain: 0.51, program: 81 },

    { id: 'piano', group: 'Keys', name: 'Piano', engine: 'piano', gain: 0.87, reverb: 0.22, program: 0 },
    {
      id: 'e-piano', group: 'Keys', name: 'Electric piano', engine: 'fm', gain: 0.39, reverb: 0.25, program: 4,
      ratio: 1, index: 1.5, indexDecay: 0.9, decay: 6, release: 0.3,
      tine: { ratio: 14, index: 0.3, decay: 0.05 }, tremolo: { rate: 4.8, depth: 0.14 },
    },
    {
      id: 'organ', group: 'Keys', name: 'Organ', engine: 'synth', gain: 0.63, reverb: 0.25, program: 16,
      oscs: [{ harmonics: [0, 1, 0.9, 0.55, 0.65, 0, 0.35, 0, 0.3] }, { harmonics: [0, 1], octave: -1, gain: 0.6 }],
      amp: { attack: 0.006, decay: 0.05, sustain: 1, release: 0.07 }, vibrato: { rate: 6.4, depth: 7 },
    },
    {
      id: 'music-box', group: 'Keys', name: 'Music box', engine: 'fm', gain: 0.43, reverb: 0.4, program: 10,
      ratio: 4, index: 1.1, indexDecay: 0.35, decay: 1.8, release: 0.4, octave: 1,
    },

    {
      id: 'guitar', group: 'Guitars & strings', name: 'Acoustic guitar', engine: 'pluck', gain: 1.28, reverb: 0.18, program: 25,
      brightness: 0.62, decay: 3.2, body: [[105, 1.3, 5], [215, 1.6, 3], [2800, 0.9, -3]],
    },
    {
      id: 'nylon', group: 'Guitars & strings', name: 'Nylon guitar', engine: 'pluck', gain: 1.33, reverb: 0.2, program: 24,
      brightness: 0.35, decay: 2.8, body: [[100, 1.2, 5], [200, 1.5, 3]],
    },
    { id: 'harp', group: 'Guitars & strings', name: 'Harp', engine: 'pluck', gain: 1.25, reverb: 0.4, program: 46, brightness: 0.45, decay: 5 },
    {
      id: 'strings', group: 'Guitars & strings', name: 'Strings', engine: 'synth', gain: 0.84, reverb: 0.4, program: 48,
      oscs: [{ type: 'sawtooth', detune: -9, pan: -0.5 }, { type: 'sawtooth' }, { type: 'sawtooth', detune: 9, pan: 0.5 }],
      filter: { freq: 2400, q: 0.6, keyTrack: 0.3 }, amp: { attack: 0.28, decay: 0.4, sustain: 0.85, release: 0.55 },
      vibrato: { rate: 5.2, depth: 9, delay: 0.25 },
    },

    {
      id: 'warm-pad', group: 'Synths', name: 'Warm pad', engine: 'synth', gain: 0.98, reverb: 0.5, program: 89,
      oscs: [{ type: 'sawtooth', detune: -7, pan: -0.6 }, { type: 'sawtooth', detune: 7, pan: 0.6 }, { type: 'square', octave: -1, gain: 0.35 }],
      filter: { freq: 700, q: 1.1, keyTrack: 0.4, env: { amount: 1600, attack: 1.2, decay: 2.5, sustain: 0.35 } },
      amp: { attack: 0.7, decay: 1, sustain: 0.85, release: 1.4 },
    },
    {
      id: 'dream-pad', group: 'Synths', name: 'Dream pad', engine: 'synth', gain: 0.68, reverb: 0.65, program: 88,
      oscs: [{ type: 'triangle', detune: -12, pan: -0.7 }, { type: 'triangle' }, { type: 'triangle', detune: 12, pan: 0.7 }, { type: 'sine', octave: 1, gain: 0.2 }],
      filter: { freq: 3000, q: 0.5 }, amp: { attack: 1.4, decay: 1, sustain: 0.9, release: 2.2 }, vibrato: { rate: 0.4, depth: 6 },
    },
    {
      id: 'supersaw', group: 'Synths', name: 'Supersaw', engine: 'synth', gain: 1.45, reverb: 0.35, program: 81,
      unison: { voices: 7, spread: 24, width: 0.9 }, oscs: [{ type: 'sawtooth' }],
      filter: { freq: 5200, q: 0.5 }, amp: { attack: 0.015, decay: 0.3, sustain: 0.8, release: 0.4 },
    },
    {
      id: 'poly', group: 'Synths', name: 'Analog poly', engine: 'synth', gain: 0.93, reverb: 0.25, program: 90,
      oscs: [{ type: 'sawtooth', detune: -5, pan: -0.3 }, { type: 'sawtooth', detune: 5, pan: 0.3 }],
      filter: { freq: 600, q: 2.2, keyTrack: 0.5, env: { amount: 2800, attack: 0.06, decay: 0.5, sustain: 0.3 } },
      amp: { attack: 0.02, decay: 0.3, sustain: 0.8, release: 0.3 },
    },
    {
      id: 'synth-pluck', group: 'Synths', name: 'Synth pluck', engine: 'synth', gain: 0.51, reverb: 0.35, program: 84,
      oscs: [{ type: 'sawtooth' }, { type: 'square', detune: -6, gain: 0.5 }],
      filter: { freq: 300, q: 3, keyTrack: 0.6, env: { amount: 4500, attack: 0.002, decay: 0.2, sustain: 0 } },
      amp: { attack: 0.002, decay: 0.9, sustain: 0, release: 0.25 },
    },
    {
      id: 'glass', group: 'Synths', name: 'Glass bells', engine: 'fm', gain: 0.39, reverb: 0.45, program: 14,
      ratio: 3.5, index: 2.2, indexDecay: 1.4, decay: 4, release: 0.8,
    },
    {
      id: 'chip', group: 'Synths', name: '8-bit', engine: 'synth', gain: 0.63, reverb: 0.05, program: 80,
      oscs: [{ pulse: 0.25 }], amp: { attack: 0.002, decay: 0.1, sustain: 0.7, release: 0.05 },
    },

    {
      id: 'finger-bass', group: 'Bass', name: 'Finger bass', engine: 'pluck', gain: 2.4, reverb: 0.04, program: 33,
      brightness: 0.32, decay: 2.4, lowpass: 2400,
    },
    {
      id: 'synth-bass', group: 'Bass', name: 'Synth bass', engine: 'synth', gain: 0.63, reverb: 0.04, program: 38,
      oscs: [{ type: 'sawtooth' }, { type: 'square', octave: -1, gain: 0.5 }],
      filter: { freq: 220, q: 4, keyTrack: 0.5, env: { amount: 1400, attack: 0.004, decay: 0.22, sustain: 0.15 } },
      amp: { attack: 0.004, decay: 0.3, sustain: 0.75, release: 0.08 },
    },
    {
      id: 'sub-bass', group: 'Bass', name: 'Sub bass', engine: 'synth', gain: 0.39, reverb: 0, program: 39,
      oscs: [{ type: 'sine' }, { type: 'triangle', gain: 0.25 }], amp: { attack: 0.008, decay: 0.2, sustain: 0.9, release: 0.1 },
    },
  ];

  const DRUMS = ['kick', 'snare', 'clap', 'hat', 'openhat', 'click-hi', 'click'];
  const GROUPS = Array.from(new Set(PRESETS.map((p) => p.group)));

  function byId(id) {
    return PRESETS.find((p) => p.id === id) || null;
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ------------------------------------------------------------ plucking

  // A small deterministic noise source, so a string sounds the same every time (and in tests).
  function noise(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2147483648 - 1;
    };
  }

  /**
   * One plucked string (Karplus–Strong) as samples. The averaging on each pass
   * adds half a sample to the loop, so the string rings at
   * sampleRate / (period + ½); `rate` says exactly where, and a player tunes
   * it with its playback rate. brightness 0–1 shapes the pluck, `decay` is how
   * long a string around A3 rings, in seconds (lower strings ring longer).
   */
  function pluckSamples(sampleRate, freq, brightness, decay) {
    const period = Math.max(2, Math.round(sampleRate / freq - 0.5));
    const rate = sampleRate / (period + 0.5);
    const seconds = clamp(decay * Math.pow(220 / rate, 0.25), 0.5, 6);
    const length = Math.ceil(sampleRate * seconds);
    const out = new Float32Array(length);
    const rand = noise(period * 7919);
    const a = 0.08 + 0.9 * brightness;   // one-pole low-pass on the pluck: softer fingers, fewer highs
    let y = 0;
    let sum = 0;
    for (let i = 0; i < period && i < length; i++) {
      y += a * (rand() - y);
      out[i] = y;
      sum += y;
    }
    const dc = sum / period;
    for (let i = 0; i < period && i < length; i++) out[i] -= dc;
    // The loss per pass that brings the fundamental down 60 dB over `seconds`.
    const loss = Math.pow(10, -3 / (seconds * rate));
    for (let i = period; i < length; i++) out[i] = loss * 0.5 * (out[i - period] + (i > period ? out[i - period - 1] : 0));
    const fade = Math.min(length, Math.round(sampleRate * 0.02));
    for (let i = 0; i < fade; i++) out[length - 1 - i] *= i / fade;
    return { samples: out, rate };
  }

  const pluckCache = new Map();

  function pluckBuffer(ctx, preset, freq) {
    const period = Math.max(2, Math.round(ctx.sampleRate / freq - 0.5));
    const key = `${ctx.sampleRate}|${preset.id}|${period}`;
    let hit = pluckCache.get(key);
    if (!hit) {
      const { samples, rate } = pluckSamples(ctx.sampleRate, freq, preset.brightness, preset.decay);
      const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.copyToChannel(samples, 0);
      hit = { buffer, rate };
      pluckCache.set(key, hit);
      if (pluckCache.size > 96) pluckCache.delete(pluckCache.keys().next().value);   // the oldest string goes
    }
    return hit;
  }

  // --------------------------------------------------------------- shared

  const contextCache = new WeakMap();

  function cache(ctx) {
    let c = contextCache.get(ctx);
    if (!c) contextCache.set(ctx, c = { waves: new Map(), noise: null });
    return c;
  }

  function periodicWave(ctx, key, real, imag) {
    const c = cache(ctx);
    if (!c.waves.has(key)) c.waves.set(key, ctx.createPeriodicWave(Float32Array.from(real), Float32Array.from(imag)));
    return c.waves.get(key);
  }

  // An oscillator's shape: a built-in type, sine partials (organ drawbars, the soft wave) or a pulse.
  function shape(ctx, osc, o, key) {
    if (o.harmonics) {
      osc.setPeriodicWave(periodicWave(ctx, key, new Array(o.harmonics.length).fill(0), o.harmonics));
    } else if (o.pulse) {
      const n = 40;
      const real = [0];
      for (let k = 1; k < n; k++) real.push((2 / (k * Math.PI)) * Math.sin(k * Math.PI * o.pulse));
      osc.setPeriodicWave(periodicWave(ctx, key, real, new Array(n).fill(0)));
    } else {
      osc.type = o.type || 'sine';
    }
  }

  function whiteNoise(ctx) {
    const c = cache(ctx);
    if (!c.noise) {
      const length = ctx.sampleRate;
      c.noise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = new Float32Array(length);
      const rand = noise(12345);
      for (let i = 0; i < length; i++) data[i] = rand();
      c.noise.copyToChannel(data, 0);
    }
    return c.noise;
  }

  function holdAt(param, t) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else param.cancelScheduledValues(t);
  }

  function safeStop(source, t) {
    try {
      source.stop(t);
    } catch {
      /* already stopped */
    }
  }

  /**
   * What playNote() returns. sources: what to stop; env: the gain the release
   * fades; freqs: [AudioParam, multiplier] pairs that follow the pitch;
   * ends: when the note dies away by itself (Infinity for sustaining sounds).
   */
  function voice(sources, env, release, freqs, ends) {
    let stopped = false;
    sources.forEach((s) => { if (Number.isFinite(ends)) safeStop(s, ends); });
    sources[0].onended = () => env.disconnect();
    return {
      ends,
      setFreq(freq, at) {
        freqs.forEach(([param, mult]) => param.setTargetAtTime(freq * mult, at, 0.008));
      },
      stop(at) {
        if (stopped) return;
        stopped = true;
        holdAt(env.gain, at);
        env.gain.setTargetAtTime(0, at, release / 4);
        const end = Math.min(ends, at + release * 1.5 + 0.05);
        sources.forEach((s) => safeStop(s, end));
      },
    };
  }

  // Attack to the peak, decay to the sustain level.
  function envelope(param, t, peak, amp) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + amp.attack);
    param.setTargetAtTime(peak * amp.sustain, t + amp.attack, Math.max(0.001, amp.decay / 3));
  }

  function connectPanned(ctx, node, pan, dest) {
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node.connect(p);
      p.connect(dest);
    } else {
      node.connect(dest);
    }
  }

  // --------------------------------------------------------------- engines

  const ENGINES = {
    wave(ctx, out, p, freq, t, vel) {
      const osc = ctx.createOscillator();
      shape(ctx, osc, p.id === 'soft' ? { harmonics: Tones.SOFT_HARMONICS } : { type: p.id }, 'soft');
      osc.frequency.value = freq;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.setTargetAtTime(vel * (p.gain || 1), t, 0.008);
      osc.connect(env);
      env.connect(out);
      osc.start(t);
      return voice([osc], env, 0.04, [[osc.frequency, 1]], Infinity);
    },

    synth(ctx, out, p, freq, t, vel) {
      const amp = ctx.createGain();
      let input = amp;
      if (p.filter) {
        const f = p.filter;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = f.q || 0.7;
        const base = Math.min(18000, f.freq * Math.pow(freq / 261.63, f.keyTrack || 0));
        if (f.env) {
          const peak = Math.min(18000, base + f.env.amount * (0.6 + 0.4 * vel));
          filter.frequency.setValueAtTime(base, t);
          filter.frequency.linearRampToValueAtTime(peak, t + f.env.attack);
          filter.frequency.setTargetAtTime(base + (peak - base) * f.env.sustain, t + f.env.attack, f.env.decay / 3);
        } else {
          filter.frequency.value = base;
        }
        filter.connect(amp);
        input = filter;
      }
      const oscs = p.unison
        ? Array.from({ length: p.unison.voices }, (_, i) => {
          const x = p.unison.voices > 1 ? (2 * i) / (p.unison.voices - 1) - 1 : 0;   // −1 … 1 across the stack
          return Object.assign({}, p.oscs[0], { detune: x * p.unison.spread, pan: x * p.unison.width });
        })
        : p.oscs;
      const total = oscs.reduce((s, o) => s + (o.gain === undefined ? 1 : o.gain), 0);
      const sources = [];
      const freqs = [];
      oscs.forEach((o, i) => {
        const osc = ctx.createOscillator();
        shape(ctx, osc, o, `${p.id}:${i}`);
        const mult = Math.pow(2, o.octave || 0);
        osc.frequency.value = freq * mult;
        osc.detune.value = o.detune || 0;
        const g = ctx.createGain();
        g.gain.value = (o.gain === undefined ? 1 : o.gain) / total;
        osc.connect(g);
        connectPanned(ctx, g, o.pan, input);
        osc.start(t);
        sources.push(osc);
        freqs.push([osc.frequency, mult]);
      });
      if (p.vibrato) {
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = p.vibrato.rate;
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(p.vibrato.depth, t + (p.vibrato.delay || 0) + 0.3);
        lfo.connect(depth);
        sources.forEach((osc) => depth.connect(osc.detune));
        lfo.start(t);
        sources.push(lfo);
      }
      envelope(amp.gain, t, vel * (p.gain || 1), p.amp);
      amp.connect(out);
      const ends = p.amp.sustain === 0 ? t + p.amp.attack + p.amp.decay * 2.5 : Infinity;
      return voice(sources, amp, p.amp.release, freqs, ends);
    },

    fm(ctx, out, p, freq, t, vel) {
      const oct = Math.pow(2, p.octave || 0);
      const f0 = freq * oct;
      const carrier = ctx.createOscillator();
      carrier.frequency.value = f0;
      const sources = [carrier];
      const freqs = [[carrier.frequency, oct]];
      const modulate = (ratio, index, decay) => {
        const mod = ctx.createOscillator();
        const depth = ctx.createGain();
        const hz = index * f0 * ratio * (0.5 + 0.5 * vel);   // modulation depth: the index times the modulator's frequency
        mod.frequency.value = f0 * ratio;
        depth.gain.setValueAtTime(hz, t);
        depth.gain.setTargetAtTime(hz * 0.12, t, decay / 3);
        mod.connect(depth);
        depth.connect(carrier.frequency);
        mod.start(t);
        sources.push(mod);
        freqs.push([mod.frequency, oct * ratio]);
      };
      modulate(p.ratio, p.index, p.indexDecay);
      if (p.tine) modulate(p.tine.ratio, p.tine.index, p.tine.decay);
      const amp = ctx.createGain();
      const peak = vel * (p.gain || 1);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(peak, t + 0.004);
      amp.gain.setTargetAtTime(0, t + 0.004, p.decay / 6.9);
      let last = carrier;
      if (p.tremolo) {
        const trem = ctx.createGain();
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        trem.gain.value = 1 - p.tremolo.depth;
        lfo.frequency.value = p.tremolo.rate;
        depth.gain.value = p.tremolo.depth;
        lfo.connect(depth);
        depth.connect(trem.gain);
        carrier.connect(trem);
        lfo.start(t);
        sources.push(lfo);
        last = trem;
      }
      last.connect(amp);
      amp.connect(out);
      carrier.start(t);
      return voice(sources, amp, p.release, freqs, t + p.decay * 1.2 + 0.3);
    },

    pluck(ctx, out, p, freq, t, vel) {
      const { buffer, rate } = pluckBuffer(ctx, p, freq);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = freq / rate;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = (p.lowpass || 9000) * (0.45 + 0.55 * vel);
      src.connect(tone);
      let last = tone;
      (p.body || []).forEach(([f, q, gain]) => {
        const body = ctx.createBiquadFilter();
        body.type = 'peaking';
        body.frequency.value = f;
        body.Q.value = q;
        body.gain.value = gain;
        last.connect(body);
        last = body;
      });
      const amp = ctx.createGain();
      amp.gain.value = vel * (p.gain || 1);
      last.connect(amp);
      amp.connect(out);
      src.start(t);
      return voice([src], amp, p.release || 0.12, [[src.playbackRate, 1 / rate]], t + buffer.duration / src.playbackRate.value + 0.05);
    },

    piano(ctx, out, p, freq, t, vel) {
      const B = 0.00035;                                               // string stiffness: partials run a little sharp
      const rings = clamp(7 * Math.pow(261.63 / freq, 0.55), 0.8, 14);   // seconds: longer in the bass
      const soft = 0.35 + 0.65 * vel;                                  // a harder strike is brighter
      const amp = ctx.createGain();
      const sources = [];
      const freqs = [];
      const partials = [];
      for (let n = 1; n <= 7; n++) {
        const mult = n * Math.sqrt(1 + B * n * n);
        if (freq * mult > 16000) break;
        partials.push({ n, mult, level: Math.pow(n, -1.2) * Math.pow(soft, n - 1) });
      }
      const total = partials.reduce((s, x) => s + x.level, 0);
      partials.forEach(({ n, mult, level }) => {
        const g = ctx.createGain();
        const a = level / total;
        const ringsN = rings / (1 + 0.6 * (n - 1));
        // A quick drop after the strike, then the long ring.
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(a, t + 0.003);
        g.gain.setTargetAtTime(a * 0.45, t + 0.003, 0.12);
        g.gain.setTargetAtTime(0, t + 0.35, ringsN / 6.9);
        // The two lowest partials come from two strings a hair apart, which gives the tone its slow shimmer.
        [0, n === 1 ? 0.9 : null].forEach((cents) => {
          if (cents === null) return;
          const osc = ctx.createOscillator();
          osc.frequency.value = freq * mult;
          osc.detune.value = cents;
          const half = ctx.createGain();
          half.gain.value = n === 1 ? 0.5 : 1;
          osc.connect(half);
          half.connect(g);
          osc.start(t);
          sources.push(osc);
          freqs.push([osc.frequency, mult]);
        });
        g.connect(amp);
      });
      const hammer = ctx.createBufferSource();
      hammer.buffer = whiteNoise(ctx);
      const felt = ctx.createBiquadFilter();
      felt.type = 'bandpass';
      felt.frequency.value = Math.min(5000, freq * 6);
      felt.Q.value = 1;
      const thump = ctx.createGain();
      thump.gain.setValueAtTime(0.08 * vel, t);
      thump.gain.setTargetAtTime(0, t, 0.008);
      hammer.connect(felt);
      felt.connect(thump);
      thump.connect(amp);
      hammer.start(t);
      hammer.stop(t + 0.1);
      amp.gain.value = vel * (p.gain || 1);
      amp.connect(out);
      return voice(sources, amp, 0.25, freqs, t + rings + 0.5);
    },
  };

  /**
   * Plays one note on `out` at `time`, `duration` seconds long (Infinity: until
   * the returned voice's stop()). velocity 0–1. Works on any AudioContext or
   * OfflineAudioContext. Returns { setFreq(freq, at), stop(at), ends }.
   */
  function playNote(ctx, out, presetId, freq, time, duration, velocity) {
    const p = byId(presetId) || PRESETS[0];
    const v = ENGINES[p.engine](ctx, out, p, freq, time, velocity === undefined ? 1 : velocity);
    if (Number.isFinite(duration)) v.stop(time + duration);
    return v;
  }

  // ----------------------------------------------------------------- drums

  function noiseHit(ctx, out, t, type, freq, q, level, fall, length) {
    const src = ctx.createBufferSource();
    src.buffer = whiteNoise(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.setTargetAtTime(0, t, fall);
    src.connect(filter);
    filter.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + length);
    src.onended = () => g.disconnect();
    return g;
  }

  function toneHit(ctx, out, t, type, from, to, sweep, level, fall, length) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + sweep);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.setTargetAtTime(0, t + 0.002, fall);
    osc.connect(g);
    g.connect(out);
    osc.start(t);
    osc.stop(t + length);
    osc.onended = () => g.disconnect();
  }

  /** One drum hit: kick, snare, clap, hat, openhat, click-hi or click. */
  function playDrum(ctx, out, drum, t, velocity) {
    const v = velocity === undefined ? 1 : velocity;
    switch (drum) {
      case 'kick':
        toneHit(ctx, out, t, 'sine', 150, 45, 0.1, 0.8 * v, 0.11, 0.6);
        noiseHit(ctx, out, t, 'highpass', 2500, 0.7, 0.12 * v, 0.003, 0.03);
        break;
      case 'snare':
        toneHit(ctx, out, t, 'triangle', 200, 165, 0.05, 0.38 * v, 0.035, 0.2);
        noiseHit(ctx, out, t, 'highpass', 1400, 0.6, 0.56 * v, 0.05, 0.35);
        break;
      case 'clap':
        [0, 0.011, 0.022].forEach((d) => noiseHit(ctx, out, t + d, 'bandpass', 1100, 0.9, 0.9 * v, 0.006, 0.03));
        noiseHit(ctx, out, t + 0.03, 'bandpass', 1100, 0.9, 0.75 * v, 0.05, 0.3);
        break;
      case 'hat':
        noiseHit(ctx, out, t, 'highpass', 7500, 0.8, 0.3 * v, 0.012, 0.08);
        break;
      case 'openhat':
        noiseHit(ctx, out, t, 'highpass', 7000, 0.8, 0.26 * v, 0.09, 0.5);
        break;
      default:
        toneHit(ctx, out, t, 'sine', drum === 'click-hi' ? 1760 : 1320, drum === 'click-hi' ? 1760 : 1320, 0, 0.45 * v, 0.012, 0.06);
    }
  }

  // ------------------------------------------------------------------- mix

  // A room: stereo noise that dies away over about two seconds, darker as it goes.
  function impulse(ctx) {
    const rate = ctx.sampleRate;
    const length = Math.round(rate * 2.4);
    const pre = Math.round(rate * 0.012);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
      const data = new Float32Array(length);
      const rand = noise(c ? 777 : 333);
      let y = 0;
      for (let i = pre; i < length; i++) {
        const s = (i - pre) / rate;
        const a = 0.9 * Math.exp(-s * 1.6) + 0.05;   // later reflections lose their highs
        y += a * (rand() - y);
        data[i] = y * Math.exp(-s * 3.2);
      }
      buffer.copyToChannel(data, c);
    }
    return buffer;
  }

  /**
   * The mix on a context: parts (tones, chords, bass, drums …), each with a
   * volume and a send to a shared reverb, summed into a limiter so the whole
   * never clips. part(name) → { input, send }; output: the limiter, for an
   * analyser to listen to.
   */
  function createMixer(ctx, destination) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    limiter.connect(destination || ctx.destination);
    const master = ctx.createGain();
    master.connect(limiter);
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx);
    reverb.connect(master);
    const parts = {};
    function part(name) {
      if (!parts[name]) {
        const input = ctx.createGain();
        const send = ctx.createGain();
        send.gain.value = 0;
        input.connect(master);
        input.connect(send);
        send.connect(reverb);
        parts[name] = { input, send };
      }
      return parts[name];
    }
    return {
      output: limiter,
      part,
      /** Sets a part's reverb to its sound's. */
      setSound(name, presetId) {
        const p = byId(presetId);
        part(name).send.gain.value = (p && p.reverb) || 0;
      },
    };
  }

  // ------------------------------------------------------------ progressions

  // How loud each part's notes are before its volume: chords are several notes at once.
  const PART_LEVEL = { chords: 0.5, bass: 0.9, drums: 0.55 };

  /**
   * Plays one event of Song.arrange() at `time` into its part's bus.
   * buses: { chords, bass, drums } nodes; options: { secondsPerBeat, sounds: { chords, bass }, a4 }.
   */
  function playEvent(ctx, buses, e, time, options) {
    const out = buses[e.part];
    if (e.part === 'drums') playDrum(ctx, out, e.drum, time, e.vel);
    else playNote(ctx, out, options.sounds[e.part], Tones.midiToFreq(e.midi, options.a4), time, e.dur * options.secondsPerBeat, e.vel * PART_LEVEL[e.part]);
  }

  /**
   * Renders a progression offline: `repeats` passes of the loop as stereo
   * Float32Arrays at `sampleRate`, seamless — the first pass is rendered and
   * dropped, so the result starts with the tail (release, reverb) that the
   * last chord leaves when the loop comes round, and loops without a click.
   * options: { bpm, repeats, sounds, volumes: { chords, bass, drums }, parts: [names], a4, sampleRate }
   */
  function render(arrangement, options) {
    const rate = options.sampleRate || 48000;
    const spb = 60 / options.bpm;
    const loopSeconds = arrangement.beats * spb;
    const passes = options.repeats + 1;
    const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    const ctx = new Offline(2, Math.ceil(loopSeconds * passes * rate) + 1, rate);
    const mixer = createMixer(ctx, ctx.destination);
    options.parts.forEach((name) => {
      mixer.part(name).input.gain.value = options.volumes[name];
      if (name !== 'drums') mixer.setSound(name, options.sounds[name]);
      else mixer.part(name).send.gain.value = 0.08;
    });
    const settings = { secondsPerBeat: spb, sounds: options.sounds, a4: options.a4 };
    const buses = { chords: mixer.part('chords').input, bass: mixer.part('bass').input, drums: mixer.part('drums').input };
    for (let pass = 0; pass < passes; pass++) {
      arrangement.events.forEach((e) => {
        if (options.parts.includes(e.part)) playEvent(ctx, buses, e, (pass * arrangement.beats + e.t) * spb, settings);
      });
    }
    return ctx.startRendering().then((buffer) => {
      const skip = Math.round(loopSeconds * rate);
      const length = Math.round(loopSeconds * options.repeats * rate);
      return [0, 1].map((c) => buffer.getChannelData(c).slice(skip, skip + length));
    });
  }

  return {
    PRESETS, GROUPS, DRUMS, PART_LEVEL, byId, pluckSamples, playNote, playDrum, createMixer, playEvent, render,
  };
});
