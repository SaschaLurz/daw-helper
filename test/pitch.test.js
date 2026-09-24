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
