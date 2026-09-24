'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../pitch.js'); // Analysis picks the pitch detector up from the global, as the worker does
const Analysis = require('../analysis.js');

const SR = 48000;
const dbOf = (v) => 20 * Math.log10(v);

// Deterministic noise so failures are reproducible.
function makeRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

/** A signal built from a per-sample callback. */
function signal(seconds, sr, fn) {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / sr, i);
  return out;
}

/** Uniform noise with the given RMS level in dBFS. */
function noiseAt(levelDb, seed) {
  const rand = makeRandom(seed || 1);
  const amp = Math.pow(10, levelDb / 20) * Math.sqrt(12); // uniform(-0.5,0.5) has RMS 1/√12
  return () => amp * rand();
}

/** A vocal-ish tone: fundamental plus decaying harmonics, sung in phrases with pauses. */
function phrases(f0, peakAmp, onSeconds, offSeconds) {
  const harmonics = [1, 0.5, 0.35, 0.2, 0.1];
  const norm = harmonics.reduce((a, b) => a + b, 0);
  return (t) => {
    const cycle = t % (onSeconds + offSeconds);
    if (cycle >= onSeconds) return 0;
    const env = Math.min(1, cycle / 0.02, (onSeconds - cycle) / 0.02);
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) v += harmonics[h] * Math.sin(2 * Math.PI * f0 * (h + 1) * t + h);
    return (peakAmp * env * v) / norm;
  };
}

function analyse(channels, sr, options) {
  return Analysis.analyse(channels, sr, options || {}, () => {});
}

// ------------------------------------------------------------ file headers

function bytes(...parts) {
  const chunks = parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)));
  const buf = Buffer.concat(chunks);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
const u16 = (v) => [v & 255, (v >> 8) & 255];
const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const be32 = (v) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
const be16 = (v) => [(v >> 8) & 255, v & 255];
const box = (type, ...content) => {
  const body = Buffer.concat(content.map((c) => Buffer.from(c)));
  return Buffer.concat([Buffer.from(be32(8 + body.length)), Buffer.from(type, 'latin1'), body]);
};

test('sniff reads a WAV header, including the extensible variant', () => {
  const dataBytes = 96000 * 2 * 3;
  const wav = bytes('RIFF', u32(36 + dataBytes), 'WAVE', 'fmt ', u32(16), u16(1), u16(2), u32(96000), u32(96000 * 6), u16(6), u16(24), 'data', u32(dataBytes), new Uint8Array(dataBytes));
  assert.deepEqual(Analysis.sniff(wav), { format: 'wav', sampleRate: 96000, channels: 2, bitDepth: 24, encoding: 'pcm', duration: 1 });

  const guid = [3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]; // IEEE float sub-format
  const ext = bytes('RIFF', u32(60), 'WAVE', 'fmt ', u32(40), u16(0xfffe), u16(1), u32(44100), u32(44100 * 4), u16(4), u16(32), u16(22), u16(32), u32(4), guid, 'data', u32(0));
  const info = Analysis.sniff(ext);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.bitDepth, 32);
  assert.equal(info.encoding, 'float');
});

test('sniff reads FLAC, MP3 and M4A headers', () => {
  // FLAC STREAMINFO: 48000 Hz (20 bits), 1 channel (3 bits: 0), 24 bit (5 bits: 23), 96000 samples.
  const packed = (48000 << 12) | (0 << 9) | (23 << 4) | 0;
  const flac = bytes('fLaC', [0x80, 0, 0, 34], new Uint8Array(10), be32(packed >>> 0), be32(96000), new Uint8Array(16));
  assert.deepEqual(Analysis.sniff(flac), { format: 'flac', sampleRate: 48000, channels: 1, bitDepth: 24, encoding: 'pcm', duration: 2 });

  // MP3: ID3v2 tag of 20 bytes, then two 128 kbps MPEG-1 layer III frames at 44.1 kHz (417 bytes each).
  const frame = [0xff, 0xfb, 0x90, 0x00].concat(new Array(413).fill(0));
  const mp3 = bytes('ID3', [3, 0, 0, 0, 0, 0, 20], new Uint8Array(20), frame, frame);
  const m = Analysis.sniff(mp3);
  assert.equal(m.format, 'mp3');
  assert.equal(m.sampleRate, 44100);
  assert.equal(m.channels, 2);

  // M4A: the sample entry carries the rate; mdhd carries duration.
  const mp4a = box('mp4a', new Uint8Array(16), be16(1), be16(16), new Uint8Array(4), be16(44100), be16(0));
  const stsd = box('stsd', [0, 0, 0, 0], be32(1), mp4a);
  const mdhd = box('mdhd', [0, 0, 0, 0], be32(0), be32(0), be32(44100), be32(44100 * 3), be16(0), be16(0));
  const hdlr = box('hdlr', [0, 0, 0, 0], [0, 0, 0, 0], 'soun', new Uint8Array(13));
  const trak = box('trak', box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd))));
  const m4a = bytes(box('ftyp', 'M4A ', be32(0), 'M4A mp42'), box('moov', trak));
  const a = Analysis.sniff(m4a);
  assert.equal(a.format, 'm4a');
  assert.equal(a.sampleRate, 44100);
  assert.equal(a.channels, 1);
  assert.equal(a.duration, 3);

  assert.equal(Analysis.sniff(bytes('OggS', new Uint8Array(100))), null);
});

// ----------------------------------------------------------- channel choice

test('channel choice: dual mono, one-sided stereo, and a real stereo sum', () => {
  const l = signal(1, SR, phrases(220, 0.3, 1, 0));
  assert.equal(Analysis.pickChannel([l, Float32Array.from(l)]).layout, 'dual-mono');

  const quiet = signal(1, SR, noiseAt(-90, 3));
  assert.equal(Analysis.pickChannel([l, quiet]).layout, 'left-only');
  assert.equal(Analysis.pickChannel([quiet, l]).layout, 'right-only');

  const r = signal(1, SR, phrases(330, 0.3, 1, 0));
  const pick = Analysis.pickChannel([l, r]);
  assert.equal(pick.layout, 'sum');
  assert.ok(Math.abs(pick.samples[1000] - (l[1000] + r[1000]) / 2) < 1e-6);
});

// ------------------------------------------------------------------ levels

test('peak, RMS and crest factor of a sine are exact', () => {
  const x = signal(2, SR, (t) => 0.25 * Math.sin(2 * Math.PI * 1000 * t));
  const r = analyse([x], SR);
  assert.ok(Math.abs(r.peak.db - dbOf(0.25)) < 0.01, `peak ${r.peak.db}`);
  assert.ok(Math.abs(r.rms.db - dbOf(0.25 / Math.SQRT2)) < 0.01, `rms ${r.rms.db}`);
  assert.ok(Math.abs(r.crest.db - 3.01) < 0.02, `crest ${r.crest.db}`);
  assert.ok(Math.abs(r.dc.offset) < 1e-4);
});

test('noise floor, SNR and noise at mix level follow the noise between phrases', () => {
  const voice = phrases(196, 0.25, 1.5, 1);
  const hiss = noiseAt(-70, 5);
  const x = signal(10, SR, (t) => voice(t) + hiss());
  const r = analyse([x], SR);
  assert.ok(Math.abs(r.noiseFloor.db + 70) < 1, `noise floor ${r.noiseFloor.db}`);
  assert.ok(Math.abs(r.snr.db - (r.peak.db + 70)) < 1, `snr ${r.snr.db}`);
  assert.ok(Math.abs(r.noiseAtMix.db - (-3 - r.snr.db)) < 1e-9);
});

test('digital silence is left out of the noise floor', () => {
  const hiss = noiseAt(-70, 6);
  const x = signal(6, SR, (t) => (t < 3 ? 0 : hiss()));
  const r = analyse([x], SR);
  assert.ok(Math.abs(r.noiseFloor.db + 70) < 1, `noise floor ${r.noiseFloor.db}`);
  assert.ok(r.noiseFloor.silentBlocks >= 14);
  assert.ok(r.silenceSeconds > 2.9 && r.silenceSeconds < 3.1);
  assert.equal(r.dropouts.zeroRuns.count, 0); // leading silence is not a dropout
});

test('true peak sees the peak between samples', () => {
  // A quarter-rate sine with a 45° phase never lands on its peak: samples read 0.707, the waveform reaches 1.0.
  const sr = 44100;
  const x = signal(1, sr, (t, i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
  const r = analyse([x], sr);
  assert.ok(Math.abs(r.peak.db + 3.01) < 0.05, `sample peak ${r.peak.db}`);
  assert.ok(r.truePeak.db > -0.4 && r.truePeak.db < 0.3, `true peak ${r.truePeak.db}`);
  // On a smooth low-frequency sine the two agree.
  const s = analyse([signal(1, sr, (t) => 0.5 * Math.sin(2 * Math.PI * 100 * t))], sr);
  assert.ok(Math.abs(s.truePeak.db - s.peak.db) < 0.05);
});

test('a DC offset is reported', () => {
  const x = signal(2, SR, (t) => 0.2 * Math.sin(2 * Math.PI * 300 * t) + 0.02);
  const r = analyse([x], SR);
  assert.ok(Math.abs(r.dc.offset - 0.02) < 1e-4);
  // …and does not leak into the sub-40 Hz measurement.
  assert.ok(r.subsonic.peakDb < -60, `subsonic ${r.subsonic.peakDb}`);
});

// ---------------------------------------------------------------- loudness

test('K-weighting reproduces the BS.1770 coefficients at 48 kHz', () => {
  const k = Analysis.kWeighting(48000);
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(close(k.shelf.b0, 1.53512485958697) && close(k.shelf.b1, -2.69169618940638) && close(k.shelf.b2, 1.19839281085285));
  assert.ok(close(k.shelf.a1, -1.69065929318241) && close(k.shelf.a2, 0.73248077421585));
  assert.ok(close(k.highpass.a1, -1.99004745483398) && close(k.highpass.a2, 0.99007225036621));
});

test('a 997 Hz sine at −20 dBFS reads −23 LUFS at any sample rate', () => {
  for (const sr of [44100, 48000, 96000]) {
    const x = signal(3, sr, (t) => 0.1 * Math.sin(2 * Math.PI * 997 * t));
    const r = Analysis.integratedLoudness([x], sr, () => {});
    assert.ok(Math.abs(r.lufs + 23.01) < 0.1, `${sr} Hz: ${r.lufs}`);
  }
  // The same signal on both channels of a stereo file is 3 LU louder.
  const x = signal(3, SR, (t) => 0.1 * Math.sin(2 * Math.PI * 997 * t));
  assert.ok(Math.abs(Analysis.integratedLoudness([x, x], SR, () => {}).lufs + 20) < 0.1);
});

test('loudness gating ignores silence and quiet passages', () => {
  const tone = (t) => 0.1 * Math.sin(2 * Math.PI * 997 * t);
  // Three seconds of tone, then silence: the silent blocks are gated out and
  // only the three blocks straddling the edge pull the reading down a little.
  const padded = signal(8, SR, (t) => (t < 3 ? tone(t) : 0));
  const r = Analysis.integratedLoudness([padded], SR, () => {});
  assert.ok(Math.abs(r.lufs + 23.01) < 0.5, `gated ${r.lufs}`);
  assert.ok(r.gatedBlocks < r.blocks / 2);
  // A quiet passage 30 dB down is dropped by the relative gate.
  const withQuiet = signal(8, SR, (t) => (t < 4 ? tone(t) : tone(t) / 31.6));
  const q = Analysis.integratedLoudness([withQuiet], SR, () => {});
  assert.ok(Math.abs(q.lufs + 23.01) < 0.5, `relative gate ${q.lufs}`);
});

// ---------------------------------------------------------------- clipping

test('clipping needs three full-scale samples in a row, nearby runs are one event', () => {
  const x = signal(2, SR, (t) => 0.3 * Math.sin(2 * Math.PI * 200 * t));
  x[10000] = 1; x[10001] = -1; // two isolated full-scale samples: not clipping
  x[20000] = 1; x[20001] = 1;  // two in a row: still not
  x[30000] = 0.9995; x[30001] = 1; x[30002] = 0.999; // three: clipping
  x[30500] = -1; x[30501] = -1; x[30502] = -1; x[30503] = -1; // 10 ms later: same event
  x[60000] = 1; x[60001] = 1; x[60002] = 1; // 625 ms later: a second event
  const r = analyse([x], SR);
  assert.equal(r.clipping.count, 2);
  assert.equal(r.clipping.samples, 10);
  assert.equal(r.clipping.runs, 3);
  assert.ok(Math.abs(r.clipping.events[0].t - 30000 / SR) < 1e-6);
});

test('clipping on one channel of a real stereo file is still found', () => {
  const l = signal(2, SR, phrases(220, 0.3, 2, 0));
  const r = signal(2, SR, phrases(330, 0.3, 2, 0));
  r[40000] = 1; r[40001] = 1; r[40002] = 1;
  const res = analyse([l, r], SR);
  assert.equal(res.layout, 'sum');
  assert.equal(res.clipping.count, 1);
  assert.equal(res.clipping.events[0].channel, 1);
});

// ---------------------------------------------------------------- dropouts

test('runs of zeros in the middle of the signal are dropouts, long ones are silence', () => {
  const x = signal(5, SR, (t) => 0.3 * Math.sin(2 * Math.PI * 200 * t) + 0.001 * Math.sin(2 * Math.PI * 7 * t));
  for (let i = 48000; i < 48100; i++) x[i] = 0;           // 100 zeros: dropout
  for (let i = 96000; i < 96015; i++) x[i] = 0;           // 15 zeros: too short to count
  for (let i = 110000; i < 110000 + 2 * SR; i++) x[i] = 0; // 2 s: deliberate silence
  const r = analyse([x], SR);
  assert.equal(r.dropouts.zeroRuns.count, 1);
  assert.ok(Math.abs(r.dropouts.zeroRuns.events[0].t - 1) < 1e-6);
  assert.equal(r.dropouts.zeroRuns.events[0].samples, 100);
  assert.ok(Math.abs(r.silenceSeconds - 2) < 0.01);
});

test('a step in the waveform is a jump; smooth signals and pure tones are not', () => {
  const clean = signal(3, SR, (t) => 0.3 * Math.sin(2 * Math.PI * 220 * (1 + 0.01 * Math.sin(2 * Math.PI * 6 * t)) * t));
  assert.equal(analyse([clean], SR).dropouts.jumps.count, 0);

  const bright = signal(2, SR, (t, i) => 0.3 * Math.sin((Math.PI / 2) * i) + 0.2 * Math.sin(2 * Math.PI * 8000 * t));
  assert.equal(analyse([bright], SR).dropouts.jumps.count, 0);

  // A skipped buffer: the waveform continues from a later phase.
  const skipped = signal(3, SR, (t) => 0.3 * Math.sin(2 * Math.PI * 220 * (t < 1.5 ? t : t + 0.002)));
  const r = analyse([skipped], SR);
  assert.equal(r.dropouts.jumps.count, 1);
  assert.ok(Math.abs(r.dropouts.jumps.events[0].t - 1.5) < 0.001);
});

// ---------------------------------------------------------------- spectrum

test('spectral balance puts a sine in its band and the level scale is calibrated', () => {
  const r = analyse([signal(2, SR, (t) => 0.5 * Math.sin(2 * Math.PI * 1000 * t))], SR);
  const band = r.balance.find((b) => b.lo === 640);
  assert.ok(band.percent > 99, `band share ${band.percent}`);
  assert.ok(Math.abs(band.db - dbOf(0.5 / Math.SQRT2)) < 0.2, `band level ${band.db}`);
});

test('rumble below 40 Hz is measured at the right level', () => {
  const x = signal(3, SR, (t) => 0.03 * Math.sin(2 * Math.PI * 30 * t) + 0.2 * Math.sin(2 * Math.PI * 500 * t));
  const r = analyse([x], SR);
  assert.ok(Math.abs(r.subsonic.peakDb - dbOf(0.03 / Math.SQRT2)) < 1.5, `subsonic peak ${r.subsonic.peakDb}`);
  const clean = analyse([signal(3, SR, (t) => 0.2 * Math.sin(2 * Math.PI * 500 * t))], SR);
  assert.ok(clean.subsonic.peakDb < -80, `clean subsonic ${clean.subsonic.peakDb}`);
});

test('a plosive thump is listed with its time', () => {
  const voice = phrases(196, 0.2, 2, 1);
  const x = signal(8, SR, (t) => {
    let v = voice(t);
    if (t >= 3.5 && t < 3.7) v += 0.3 * Math.sin(2 * Math.PI * 30 * (t - 3.5)) * Math.exp(-(t - 3.5) * 20);
    return v;
  });
  const r = analyse([x], SR);
  assert.equal(r.plosives.count, 1);
  assert.ok(Math.abs(r.plosives.events[0].t - 3.5) < 0.12, `plosive at ${r.plosives.events[0].t}`);
  assert.ok(r.plosives.events[0].db > -30);
});

test('sibilance: S-like bursts are counted, vowels are not', () => {
  const voice = phrases(196, 0.2, 1.5, 1);
  const rand = makeRandom(9);
  const sib = Array.from({ length: 40 }, () => [5000 + 4000 * (rand() + 0.5), 2 * Math.PI * rand()]);
  const x = signal(10, SR, (t) => {
    let v = voice(t);
    const cycle = t % 2.5;
    if (cycle >= 1.6 && cycle < 1.72) {                       // an S in each pause
      let s = 0;
      for (const [f, p] of sib) s += Math.sin(2 * Math.PI * f * t + p);
      v += 0.03 * s;
    }
    return v;
  });
  const r = analyse([x], SR);
  assert.equal(r.sibilance.count, 4, `sibilant events ${r.sibilance.count}`);
  assert.ok(r.sibilance.events[0].ratioDb > -1);
  assert.ok(Math.abs(r.sibilance.events[0].t - 1.6) < 0.1);
  const clean = analyse([signal(5, SR, voice)], SR);
  assert.equal(clean.sibilance.count, 0);
});

test('mains hum: 50 and 60 Hz families are told apart, clean files pass', () => {
  const voice = phrases(196, 0.2, 1.5, 1.5);
  const hiss = noiseAt(-80, 11);
  const level = Math.pow(10, -55 / 20) * Math.SQRT2;
  for (const mains of [50, 60]) {
    const x = signal(12, SR, (t) => {
      let v = voice(t) + hiss();
      for (let h = 1; h <= 3; h++) v += (level / h) * Math.sin(2 * Math.PI * mains * h * t);
      return v;
    });
    const r = analyse([x], SR);
    assert.equal(r.hum.mains, mains);
    assert.equal(r.hum.measuredOn, 'quiet');
    assert.ok(r.hum.hits >= 2, `hits ${r.hum.hits}`);
    assert.ok(Math.abs(r.hum.levelDb + 55) < 1.5, `level ${r.hum.levelDb}`);
  }
  const clean = analyse([signal(12, SR, (t) => voice(t) + hiss())], SR);
  assert.equal(clean.hum.mains, null);
  // The same hum 30 dB down is irrelevant and stays below the level floor.
  const faint = analyse([signal(12, SR, (t) => voice(t) + hiss() + (level / 1000) * Math.sin(2 * Math.PI * 50 * t))], SR);
  assert.equal(faint.hum.mains, null);
});

// ------------------------------------------------------------------- pitch

test('pitch: a sung tone gives a range and a small wobble, noise is not tonal', () => {
  const x = signal(6, SR, phrases(220, 0.3, 1.5, 0.5));
  const r = analyse([x], SR);
  assert.equal(r.pitch.tonal, true);
  assert.ok(Math.abs(r.pitch.lowHz - 220) < 2 && Math.abs(r.pitch.highHz - 220) < 2, `range ${r.pitch.lowHz}–${r.pitch.highHz}`);
  assert.ok(r.pitch.wobbleCents < 3, `wobble ${r.pitch.wobbleCents}`);
  assert.ok(r.pitch.voicedRatio > 0.8);

  const noisy = analyse([signal(6, SR, noiseAt(-20, 4))], SR);
  assert.equal(noisy.pitch.tonal, false);
  const short = analyse([signal(0.05, SR, phrases(220, 0.3, 1, 0))], SR);
  assert.equal(short.pitch, null);
});

test('pitch works at 44.1 and 96 kHz through the decimator', () => {
  for (const sr of [44100, 96000]) {
    const r = analyse([signal(4, sr, phrases(330, 0.3, 4, 0))], sr);
    assert.equal(r.pitch.tonal, true, `${sr}: not tonal`);
    assert.ok(Math.abs(r.pitch.medianHz - 330) < 2, `${sr}: ${r.pitch.medianHz}`);
  }
});

// ----------------------------------------------------------------- general

test('long files are cut to the limit and progress runs to the end', () => {
  const x = signal(12, SR, phrases(220, 0.3, 1, 1));
  const seen = [];
  const r = Analysis.analyse([x], SR, { maxSeconds: 5 }, (f, stage) => seen.push([f, stage]));
  assert.equal(r.truncated, true);
  assert.equal(r.duration, 5);
  assert.equal(seen[seen.length - 1][0], 1);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][0] >= seen[i - 1][0] - 1e-9, 'progress went backwards');
  assert.ok(new Set(seen.map((s) => s[1])).size >= 5, 'stages were reported');
});

test('a minute of audio is analysed in a few seconds', () => {
  const x = signal(60, SR, phrases(220, 0.3, 2, 1));
  const t0 = process.hrtime.bigint();
  analyse([x], SR);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  analyse(): ${ms.toFixed(0)} ms for 60 s at 48 kHz`);
  assert.ok(ms < 8000, `too slow: ${ms} ms`);
});
