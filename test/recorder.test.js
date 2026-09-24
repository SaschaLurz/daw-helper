'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Recorder = require('../recorder.js');
const Analysis = require('../analysis.js');

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const block = (peaks, opts = {}) => ({
  peak: peaks,
  sumSq: peaks.map((p) => (opts.rms === undefined ? p / Math.SQRT2 : opts.rms) ** 2 * (opts.frames || 1600)),
  clips: peaks.map((p) => p >= 0.999),
  frames: opts.frames || 1600,
});

test('the meter jumps up at once and falls back at 20 dB per second', () => {
  const m = Recorder.createMeter();
  m.update(block([0.5]), 0);
  const peak = Recorder.dbfs(0.5);
  assert.ok(near(m.read(0).channels[0].peakDb, peak));
  assert.ok(near(m.read(0.5).channels[0].peakDb, peak - 10));
  m.update(block([0.01]), 0.5);              // a quieter block does not pull the bar down faster
  assert.ok(near(m.read(0.5).channels[0].peakDb, peak - 10));
  m.update(block([0.9]), 0.6);
  assert.ok(near(m.read(0.6).channels[0].peakDb, Recorder.dbfs(0.9)));
});

test('the peak hold stays put for 1.5 s, then falls', () => {
  const m = Recorder.createMeter();
  m.update(block([0.5]), 0);
  m.update(block([0.1]), 1);
  assert.ok(near(m.read(1.4).channels[0].holdDb, Recorder.dbfs(0.5)));
  assert.ok(near(m.read(2).channels[0].holdDb, Recorder.dbfs(0.5) - 10));
});

test('RMS covers the last 300 ms and empties when blocks stop coming', () => {
  const m = Recorder.createMeter();
  for (let i = 0; i < 10; i++) m.update(block([0.5], { rms: 0.25 }), i * 0.033);
  assert.ok(near(m.read(0.3).channels[0].rmsDb, Recorder.dbfs(0.25), 1e-9));
  assert.equal(m.read(2).channels[0].rmsDb, -Infinity);
});

test('clips latch, the loudest peak is remembered, and reset clears both', () => {
  const m = Recorder.createMeter();
  m.update(block([0.2, 1]), 0);
  m.update(block([0.05, 0.05]), 3);
  let r = m.read(3);
  assert.deepEqual(r.channels.map((c) => c.clipped), [false, true]);
  assert.equal(r.clipped, true);
  assert.equal(r.maxDb, 0);
  m.reset();
  r = m.read(3);
  assert.equal(r.clipped, false);
  assert.equal(r.maxDb, -Infinity);
  assert.equal(r.channels[1].clipped, false);
});

test('the meter follows the input’s channel count', () => {
  const m = Recorder.createMeter();
  m.update(block([0.1, 0.2]), 0);
  assert.equal(m.read(0).channels.length, 2);
  m.update(block([0.1]), 0.1);
  assert.equal(m.read(0.1).channels.length, 1);
});

test('level advice uses the report’s targets', () => {
  const s = (db, clipped) => Recorder.levelStatus(db, clipped).status;
  assert.equal(s(-Infinity), 'info');
  assert.equal(s(-70), 'info');
  assert.equal(s(-30), 'bad');
  assert.equal(s(-20), 'warn');
  assert.equal(s(-15), 'good');
  assert.equal(s(-12), 'good');
  assert.equal(s(-11.96), 'good');     // shown as −12.0
  assert.equal(s(-11.94), 'warn');     // shown as −11.9
  assert.equal(s(-9), 'warn');
  assert.equal(s(-3), 'bad');
  assert.equal(s(-15, true), 'bad');
  assert.match(Recorder.levelStatus(-30).text, /turn the gain up/);
  assert.match(Recorder.levelStatus(-3).text, /turn the gain down/);
});

test('WAV files have a valid header the analysis can read', () => {
  const sr = 48000;
  const left = Float32Array.from({ length: sr / 2 }, (_, i) => 0.5 * Math.sin(i / 10));
  const right = left.map((v) => -v);
  const wav = Recorder.encodeWav([left, right], sr, 24);
  assert.equal(wav.byteLength, 44 + left.length * 2 * 3);
  const info = Analysis.sniff(wav);
  assert.equal(info.format, 'wav');
  assert.equal(info.sampleRate, sr);
  assert.equal(info.channels, 2);
  assert.equal(info.bitDepth, 24);
  assert.ok(near(info.duration, 0.5, 1e-9));

  const mono16 = Recorder.encodeWav([left], 44100, 16);
  const info16 = Analysis.sniff(mono16);
  assert.deepEqual([info16.channels, info16.bitDepth, info16.sampleRate], [1, 16, 44100]);
});

test('WAV samples round-trip within one step and are clipped to full scale', () => {
  const samples = Float32Array.from([0, 0.25, -0.25, 0.999999, -1, 1, 1.7, -3, NaN]);
  const view = new DataView(Recorder.encodeWav([samples], 48000, 24));
  const read = (i) => {
    const p = 44 + i * 3;
    const v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16);
    return v / 8388608;
  };
  const expected = [0, 0.25, -0.25, 0.999999, -1, 1, 1, -1, 0];
  expected.forEach((e, i) => assert.ok(Math.abs(read(i) - e) <= 1 / 8388608 + 1e-12, `sample ${i}: ${read(i)} vs ${e}`));
});

// A few seconds of "room" as the capture would deliver it.
function room(seconds, opts = {}) {
  const sr = 48000;
  let s = opts.seed || 5;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  const noise = opts.noise === undefined ? 0.0003 : opts.noise;          // ≈ −70 dBFS RMS
  return Float32Array.from({ length: seconds * sr }, (_, i) => {
    let v = noise * 3.46 * rand();
    if (opts.humDb !== undefined) {
      const a = Math.pow(10, opts.humDb / 20) * Math.SQRT2;
      v += a * (Math.sin(2 * Math.PI * 50 * i / sr) + 0.5 * Math.sin(2 * Math.PI * 150 * i / sr));
    }
    if (opts.bump && i === sr * 2) v += 0.5;
    return v;
  });
}

test('a quiet room gets a good verdict and a signal-to-noise estimate', () => {
  const r = Analysis.analyse([room(5)], 48000, {});
  const v = Recorder.noiseVerdict(r, -10);
  assert.equal(v.status, 'good');
  assert.ok(v.noiseDb < -65 && v.noiseDb > -75, `noise ${v.noiseDb}`);
  const hum = v.lines.find((l) => l.label === 'Mains hum');
  assert.equal(hum.value, 'none found');
  const snr = v.lines.find((l) => l.label === 'Signal-to-noise');
  assert.equal(snr.status, 'good');
  assert.match(snr.text, /loudest peak at −10 dBFS/);
  assert.deepEqual(v.warnings, []);
  // Without a measured peak it assumes the target of −12 dBFS.
  assert.match(Recorder.noiseVerdict(r, -Infinity).lines.find((l) => l.label === 'Signal-to-noise').text, /If your loudest peaks reach −12 dBFS/);
});

test('hum and loud noise are called out', () => {
  const r = Analysis.analyse([room(5, { noise: 0.004, humDb: -45 })], 48000, {});
  const v = Recorder.noiseVerdict(r, -12);
  assert.equal(v.status, 'bad');
  const hum = v.lines.find((l) => l.label === 'Mains hum');
  assert.match(hum.value, /^50 Hz/);
  assert.notEqual(hum.status, 'good');
  assert.equal(v.lines.find((l) => l.label === 'Signal-to-noise').status, 'bad');
});

test('digital silence and a noisy moment are explained', () => {
  const silent = Analysis.analyse([new Float32Array(48000 * 3)], 48000, {});
  assert.equal(Recorder.noiseVerdict(silent, -12).status, 'info');
  const bumped = Analysis.analyse([room(5, { bump: true })], 48000, {});
  assert.equal(Recorder.noiseVerdict(bumped, -12).warnings.length, 1);
});
