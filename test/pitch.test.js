'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Pitch = require('../pitch.js');

const SAMPLE_RATE = 48000;
const SIZE = 4096;

// Deterministic noise so failures are reproducible.
function makeRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

// A plucked-string-ish tone: fundamental plus decaying harmonics.
function tone(freq, opts = {}) {
  const harmonics = opts.harmonics || [1, 0.6, 0.4, 0.25, 0.15, 0.1];
  const amp = opts.amp === undefined ? 0.3 : opts.amp;
  const noise = opts.noise === undefined ? 0.002 : opts.noise;
  const rand = makeRandom(opts.seed || 1);
  const out = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    const t = i / SAMPLE_RATE;
    let v = 0;
    for (let k = 0; k < harmonics.length; k++) {
      v += harmonics[k] * Math.sin(2 * Math.PI * freq * (k + 1) * t + k * 0.7);
    }
    out[i] = amp * v + noise * rand();
  }
  return out;
}

const centsBetween = (a, b) => 1200 * Math.log2(a / b);
const STRINGS = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63];

test('open strings are detected within half a cent', () => {
  const det = Pitch.createDetector({ sampleRate: SAMPLE_RATE, bufferSize: SIZE });
  for (const f of STRINGS) {
    const r = det.detect(tone(f));
    assert.ok(r.frequency > 0, `${f} Hz: no pitch (clarity ${r.clarity.toFixed(3)})`);
    const err = centsBetween(r.frequency, f);
    assert.ok(Math.abs(err) < 0.5, `${f} Hz → ${r.frequency.toFixed(3)} Hz (${err.toFixed(2)} cents off)`);
  }
});

test('ukulele and mandolin strings are detected within half a cent', () => {
  const det = Pitch.createDetector({ sampleRate: SAMPLE_RATE, bufferSize: SIZE });
  // G3 up to E5 (659 Hz), the mandolin's top string; brighter, faster-decaying overtones.
  for (const midi of [55, 60, 62, 64, 67, 69, 76]) {
    const f = Pitch.midiToFreq(midi, 440);
    const r = det.detect(tone(f, { harmonics: [1, 0.35, 0.15, 0.06] }));
    const err = centsBetween(r.frequency, f);
    assert.ok(Math.abs(err) < 0.5, `${f.toFixed(2)} Hz → ${r.frequency.toFixed(3)} Hz (${err.toFixed(2)} cents off)`);
  }
});

test('detuned strings are tracked accurately', () => {
  const det = Pitch.createDetector({ sampleRate: SAMPLE_RATE, bufferSize: SIZE });
  for (const f of STRINGS) {
    for (const offset of [-45, -12, -3, 3, 7, 33, 48]) {
      const target = f * Math.pow(2, offset / 1200);
      const r = det.detect(tone(target));
      const err = centsBetween(r.frequency, target);
      assert.ok(Math.abs(err) < 0.5, `${f} Hz ${offset}c → ${err.toFixed(2)} cents off`);
    }
  }
});

test('a dominant second harmonic does not cause an octave error', () => {
  const det = Pitch.createDetector({ sampleRate: SAMPLE_RATE, bufferSize: SIZE });
  for (const f of STRINGS) {
    const r = det.detect(tone(f, { harmonics: [0.3, 1, 0.5, 0.3, 0.1] }));
    const err = centsBetween(r.frequency, f);
    assert.ok(Math.abs(err) < 1, `${f} Hz → ${r.frequency.toFixed(3)} Hz (${err.toFixed(2)} cents off)`);
  }
});

test('quiet input and noise produce no pitch', () => {
  const det = Pitch.createDetector({ sampleRate: SAMPLE_RATE, bufferSize: SIZE });
  assert.equal(det.detect(new Float32Array(SIZE)).frequency, 0);
  assert.equal(det.detect(tone(110, { amp: 0.0005 })).frequency, 0);
  const rand = makeRandom(7);
  const noise = Float32Array.from({ length: SIZE }, () => 0.2 * rand());
  assert.equal(det.detect(noise).frequency, 0);
});

test('a DC offset does not disturb detection', () => {
  const det = Pitch.createDetector({ sampleRate: SAMPLE_RATE, bufferSize: SIZE });
  const samples = tone(146.83).map((v) => v + 0.1);
  const r = det.detect(samples);
  assert.ok(Math.abs(centsBetween(r.frequency, 146.83)) < 0.5);
});

test('note helpers map frequencies to notes', () => {
  const e2 = Pitch.describe(82.41, 440);
  assert.equal(e2.name, 'E');
  assert.equal(e2.octave, 2);
  assert.ok(Math.abs(e2.cents) < 0.5);

  const a4 = Pitch.describe(440, 440);
  assert.deepEqual([a4.name, a4.octave, a4.midi], ['A', 4, 69]);
  assert.equal(a4.cents, 0);

  const sharp = Pitch.describe(466.16, 440);
  assert.equal(sharp.name, 'A♯');

  const flat = Pitch.describe(440 * Math.pow(2, -20 / 1200), 440);
  assert.equal(flat.name, 'A');
  assert.ok(Math.abs(flat.cents + 20) < 0.01);

  // Reference pitch shifts the whole grid.
  assert.equal(Pitch.describe(432, 432).cents, 0);
  assert.ok(Math.abs(Pitch.midiToFreq(40, 440) - 82.407) < 0.01);
});

// A bass note as a pickup delivers it: the fundamental weaker than the octave
// above, stiff-string overtones that run slightly sharp (inharmonicity B), a
// decay and some noise.
function bassTone(freq, opts = {}) {
  const size = opts.size || BASS_SIZE;
  const harmonics = opts.harmonics || [0.45, 1, 0.7, 0.45, 0.3, 0.2, 0.12, 0.08];
  const B = opts.inharmonicity === undefined ? 0 : opts.inharmonicity;
  const rand = makeRandom(opts.seed || 3);
  const decay = opts.decay === undefined ? 1.5 : opts.decay;   // per second
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const t = i / SAMPLE_RATE;
    let v = 0;
    for (let k = 0; k < harmonics.length; k++) {
      const n = k + 1;
      v += harmonics[k] * Math.sin(2 * Math.PI * freq * n * Math.sqrt(1 + B * n * n) * t + k * 1.3);
    }
    out[i] = 0.25 * Math.exp(-decay * t) * v + 0.003 * rand();
  }
  return out;
}

const BASS_SIZE = 8192;
const bassDetector = () => Pitch.createDetector({ sampleRate: SAMPLE_RATE, bufferSize: BASS_SIZE, minFreq: 24 });
// B0 (5-string) up to C3 (top string of a 6-string bass).
const BASS_STRINGS = [23, 26, 28, 33, 38, 43, 48].map((m) => Pitch.midiToFreq(m, 440));

test('bass strings from low B to high C are detected within half a cent', () => {
  const det = bassDetector();
  for (const f of BASS_STRINGS) {
    const r = det.detect(bassTone(f));
    assert.ok(r.frequency > 0, `${f.toFixed(2)} Hz: no pitch (clarity ${r.clarity.toFixed(3)})`);
    const err = centsBetween(r.frequency, f);
    assert.ok(Math.abs(err) < 0.5, `${f.toFixed(2)} Hz → ${r.frequency.toFixed(3)} Hz (${err.toFixed(2)} cents off)`);
  }
});

test('a low E whose fundamental is almost missing still reads E1, not E2', () => {
  const det = bassDetector();
  const e1 = Pitch.midiToFreq(28, 440);
  for (const harmonics of [[0.2, 1, 0.8, 0.5, 0.3], [0.1, 1, 0.3, 0.6, 0.2, 0.3], [0.15, 0.6, 1, 0.4, 0.2]]) {
    const r = det.detect(bassTone(e1, { harmonics }));
    const err = centsBetween(r.frequency, e1);
    assert.ok(Math.abs(err) < 1, `[${harmonics}] → ${r.frequency.toFixed(3)} Hz (${err.toFixed(2)} cents off)`);
  }
});

test('detuned low strings are tracked, including stiff-string overtones', () => {
  const det = bassDetector();
  for (const midi of [23, 28, 33]) {
    for (const offset of [-40, -8, 0, 5, 30]) {
      const f = Pitch.midiToFreq(midi, 440) * Math.pow(2, offset / 1200);
      const clean = centsBetween(det.detect(bassTone(f)).frequency, f);
      assert.ok(Math.abs(clean) < 0.5, `midi ${midi} ${offset}c → ${clean.toFixed(2)} cents off`);
      // Real strings: overtones slightly sharp. The reading may lean a little sharp too, like any tuner.
      const stiff = centsBetween(det.detect(bassTone(f, { inharmonicity: 1e-4 })).frequency, f);
      assert.ok(stiff > -0.5 && stiff < 1.5, `midi ${midi} ${offset}c stiff → ${stiff.toFixed(2)} cents off`);
    }
  }
});

test('a quiet, decaying low E is still picked up', () => {
  const det = bassDetector();
  const e1 = Pitch.midiToFreq(28, 440);
  // About −40 dBFS and fading fast: the tail end of a note.
  const quiet = bassTone(e1, { decay: 6 }).map((v) => v * 0.05);
  const r = det.detect(quiet);
  assert.ok(r.frequency > 0, `no pitch, rms ${r.rms.toFixed(4)}, clarity ${r.clarity.toFixed(3)}`);
  assert.ok(Math.abs(centsBetween(r.frequency, e1)) < 1, `${r.frequency.toFixed(3)} Hz`);
});

test('detection is fast enough for real-time use', () => {
  const det = Pitch.createDetector({ sampleRate: SAMPLE_RATE, bufferSize: SIZE });
  const samples = tone(82.41);
  det.detect(samples); // warm up
  const runs = 50;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) det.detect(samples);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
  console.log(`  detect(): ${ms.toFixed(2)} ms per ${SIZE}-sample window`);
  assert.ok(ms < 15, `too slow: ${ms.toFixed(2)} ms`);
});

test('bass detection (longer window, lower range) is fast enough too', () => {
  const det = bassDetector();
  const samples = bassTone(41.2);
  det.detect(samples);
  const runs = 30;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) det.detect(samples);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
  console.log(`  detect(): ${ms.toFixed(2)} ms per ${BASS_SIZE}-sample bass window`);
  assert.ok(ms < 15, `too slow: ${ms.toFixed(2)} ms`);
});
