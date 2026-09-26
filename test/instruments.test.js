'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Instruments = require('../instruments.js');
const Pitch = require('../pitch.js');
const Song = require('../song.js');

// A strict stand-in for an AudioContext: it builds no sound, but throws on
// what a browser would reject or silently get wrong (NaN values, stopping a
// source that never started, an exponential ramp to zero, unknown wave types).
function fakeContext() {
  const finite = (v, what) => { if (!Number.isFinite(v)) throw new TypeError(`${what}: ${v}`); };
  class Param {
    constructor(value) { this._value = value; }
    get value() { return this._value; }
    set value(v) { finite(v, 'value'); this._value = v; }
    setValueAtTime(v, t) { finite(v, 'setValueAtTime'); finite(t, 'time'); return this; }
    linearRampToValueAtTime(v, t) { finite(v, 'linearRamp'); finite(t, 'time'); return this; }
    exponentialRampToValueAtTime(v, t) { if (!(v > 0)) throw new RangeError('exponential ramp to ≤ 0'); finite(t, 'time'); return this; }
    setTargetAtTime(v, t, tc) { finite(v, 'target'); finite(t, 'time'); if (!(tc > 0)) throw new RangeError(`time constant ${tc}`); return this; }
    cancelScheduledValues(t) { finite(t, 'cancel'); }
    cancelAndHoldAtTime(t) { finite(t, 'hold'); }
  }
  const ctx = { sampleRate: 48000, currentTime: 0, sources: [], nodes: [] };
  class Node {
    constructor() { this.outputs = []; ctx.nodes.push(this); }
    connect(dest) { if (!dest) throw new Error('connect to nothing'); this.outputs.push(dest); return dest; }
    disconnect() {}
  }
  class Source extends Node {
    constructor() { super(); ctx.sources.push(this); }
    start(t) { finite(t === undefined ? 0 : t, 'start'); this.started = t || 0; }
    stop(t) { if (this.started === undefined) throw new Error('stop before start'); finite(t, 'stop'); this.stopped = t; }
  }
  class Osc extends Source {
    constructor() { super(); this.frequency = new Param(440); this.detune = new Param(0); this._type = 'sine'; }
    get type() { return this._type; }
    set type(t) { if (!['sine', 'square', 'sawtooth', 'triangle'].includes(t)) throw new TypeError(`wave ${t}`); this._type = t; }
    setPeriodicWave(w) { if (!w) throw new TypeError('no wave'); this._type = 'custom'; }
  }
  const node = (params) => () => {
    const n = new Node();
    Object.entries(params).forEach(([k, v]) => { n[k] = new Param(v); });
    return n;
  };
  Object.assign(ctx, {
    destination: new Node(),
    createOscillator: () => new Osc(),
    createBufferSource: () => Object.assign(new Source(), { playbackRate: new Param(1), buffer: null }),
    createGain: node({ gain: 1 }),
    createBiquadFilter: node({ frequency: 350, Q: 1, gain: 0 }),
    createStereoPanner: node({ pan: 0 }),
    createConvolver: () => new Node(),
    createDynamicsCompressor: node({ threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }),
    createPeriodicWave: (real, imag) => { assert.equal(real.length, imag.length); return {}; },
    createBuffer: (channels, length, rate) => ({ numberOfChannels: channels, length, duration: length / rate, copyToChannel() {} }),
  });
  return ctx;
}

test('every preset is complete, uniquely named and has a General MIDI program', () => {
  const ids = new Set();
  for (const p of Instruments.PRESETS) {
    assert.ok(!ids.has(p.id), p.id);
    ids.add(p.id);
    assert.ok(p.name && Instruments.GROUPS.includes(p.group), p.id);
    assert.ok(Number.isInteger(p.program) && p.program >= 0 && p.program < 128, p.id);
    if (p.engine === 'synth') assert.ok(p.oscs.length && p.amp, p.id);
    if (p.engine === 'pluck') assert.ok(p.brightness >= 0 && p.brightness <= 1 && p.decay > 0, p.id);
  }
  // The plain waves keep the names the experiments and stored settings use.
  ['soft', 'sine', 'triangle', 'square', 'sawtooth'].forEach((id) => assert.equal(Instruments.byId(id).engine, 'wave'));
  assert.ok(Instruments.PRESETS.filter((p) => p.group === 'Bass').length >= 3);
  // Every sound a loop defaults to exists.
  const loop = Song.defaultLoop();
  assert.ok(Instruments.byId(loop.chords.sound) && Instruments.byId(loop.bass.sound));
});

test('every preset builds a voice that plays, follows the pitch and stops', () => {
  for (const p of Instruments.PRESETS) {
    const release = (p.amp ? p.amp.release : p.release || 0.25) * 1.5 + 0.1;
    for (const freq of [41.2, 261.63, 2093]) {
      const ctx = fakeContext();
      const out = ctx.createGain();
      const v = Instruments.playNote(ctx, out, p.id, freq, 0.1, Infinity, 0.8);
      assert.ok(ctx.nodes.some((n) => n.outputs.includes(out)), `${p.id} reaches the output`);
      assert.ok(ctx.sources.length && ctx.sources.every((s) => s.started === 0.1 || s.started === undefined || s.stopped <= 0.3), p.id);
      v.setFreq(freq * 1.5, 0.5);
      v.stop(1);
      // Once released, nothing keeps running past the release.
      ctx.sources.forEach((s) => assert.ok(s.stopped !== undefined && s.stopped <= 1 + release, `${p.id} ${freq} Hz leaves a source running`));
    }
    // A note with a length stops by itself.
    const ctx = fakeContext();
    Instruments.playNote(ctx, ctx.createGain(), p.id, 440, 0, 0.5, 1);
    ctx.sources.forEach((s) => assert.ok(s.stopped <= 0.5 + release, `${p.id}: a half-second note ends`));
  }
});

test('drums and the mix build', () => {
  const ctx = fakeContext();
  const mixer = Instruments.createMixer(ctx, ctx.destination);
  Instruments.DRUMS.forEach((d) => Instruments.playDrum(ctx, mixer.part('drums').input, d, 0.2, 0.9));
  ctx.sources.forEach((s) => assert.ok(s.stopped > s.started && s.stopped < 1.5));
  mixer.setSound('chords', 'warm-pad');
  assert.equal(mixer.part('chords').send.gain.value, Instruments.byId('warm-pad').reverb);
  assert.equal(mixer.part('chords'), mixer.part('chords'));            // one bus per part
  const arrangement = Song.arrange(Song.normaliseLoop({}, Instruments.PRESETS.map((p) => p.id)));
  const options = { secondsPerBeat: 0.5, sounds: { chords: 'piano', bass: 'finger-bass' }, a4: 440 };
  const buses = { chords: mixer.part('chords').input, bass: mixer.part('bass').input, drums: mixer.part('drums').input };
  arrangement.events.forEach((e) => Instruments.playEvent(ctx, buses, e, e.t * 0.5, options));
});

test('a plucked string rings at the pitch it reports, and dies away', () => {
  const rate = 48000;
  for (const freq of [41.2, 110, 440]) {
    const { samples, rate: rings } = Instruments.pluckSamples(rate, freq, 0.5, 3);
    assert.ok(Math.abs(1200 * Math.log2(rings / freq)) < 60, `${freq} Hz: within half a semitone before tuning`);
    const size = 8192;
    const detector = Pitch.createDetector({ sampleRate: rate, bufferSize: size, minFreq: 30, maxFreq: 1400 });
    const window = samples.subarray(Math.round(0.15 * rate), Math.round(0.15 * rate) + size);
    const found = detector.detect(window).frequency;
    assert.ok(Math.abs(1200 * Math.log2(found / rings)) < 3, `${freq} Hz string: detected ${found}, expected ${rings}`);
    const rms = (from, to) => {
      let s = 0;
      for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) s += samples[i] * samples[i];
      return Math.sqrt(s / ((to - from) * rate));
    };
    assert.ok(rms(1, 1.2) < rms(0.05, 0.25) / 2, `${freq} Hz decays`);
    assert.ok(samples.every((x) => Math.abs(x) <= 1));
    assert.ok(samples[samples.length - 1] === 0);                        // faded out, no click at the end
  }
  // Brighter plucks carry more high frequencies: more change from one sample to the next.
  const roughness = (b) => {
    const s = Instruments.pluckSamples(rate, 220, b, 3).samples;
    let d = 0;
    for (let i = 1; i < 4800; i++) d += Math.abs(s[i] - s[i - 1]);
    return d;
  };
  assert.ok(roughness(0.9) > roughness(0.2) * 1.5);
});
