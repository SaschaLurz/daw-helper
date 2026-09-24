/*
 * analysis.js — offline measurements of a recording: levels, noise, loudness,
 * clipping, dropouts, spectral checks and a pitch track.
 *
 * Everything works on plain Float32Arrays so it can run in a Web Worker
 * (analysis-worker.js) and in Node for the tests. The page itself only calls
 * sniff() to read the native sample rate from the file header before decoding,
 * because decodeAudioData() resamples to the rate of the context it runs in.
 *
 * All spectral measurements come from one STFT (Hann, 4096 samples, 50 %
 * overlap) — except the mains-hum check, which needs about 3 Hz of resolution
 * to tell 50 Hz from 60 Hz and therefore averages a second, longer FFT over the
 * quiet parts of the file. Levels are in dBFS: 0 dBFS = |sample| of 1.0.
 *
 * The plain-language explanations of these numbers live in report.js.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.Analysis = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SECONDS = 300;          // longer files: only the first five minutes
  const FFT_SIZE = 4096;
  const HOP = FFT_SIZE / 2;
  const NOISE_BLOCK_S = 0.2;        // noise floor: RMS per block, then the 5th percentile
  const NOISE_PERCENTILE = 0.05;
  const CLIP_LEVEL = 0.999;
  const CLIP_RUN = 3;               // this many full-scale samples in a row is clipping
  const CLIP_MERGE_S = 0.05;        // clipped runs closer than this are one event
  const ZERO_RUN = 20;              // more exact zeros than this in a row is a dropout…
  const SILENCE_RUN_S = 1;          // …unless it is this long, which is deliberate silence
  const LOCAL_WINDOW_S = 0.05;
  const JUMP_MIN = 0.005;           // a jump must be at least this big (≈ −46 dBFS)…
  const JUMP_LOCAL = 0.1;           // …and this fraction of the local peak to matter
  const JUMP_RATIO = 6;             // …and this much bigger than the neighbouring steps
  const SUBSONIC_HZ = 40;
  const PLOSIVE_HZ = 45;
  const PLOSIVE_WINDOW_S = 0.1;
  const PLOSIVE_DB = -50;
  const SIBILANCE_LO = 5000;
  const SIBILANCE_HI = 9000;
  const SIBILANCE_GATE_DB = -30;    // only windows louder than this are judged
  const SIBILANCE_RATIO_DB = -6;    // band/broadband ratio above this is an S
  const HUM_FAMILIES = [50, 60];
  const HUM_MAX_HZ = 300;
  const HUM_EXCESS_DB = 6;
  const HUM_MIN_LEVEL_DB = -80;     // quieter peaks are irrelevant even if they stick out
  const HUM_QUIET_MARGIN_DB = 10;   // frames within this of the noise floor count as quiet
  const HUM_MIN_QUIET_FRAMES = 3;
  const BALANCE_BANDS = [
    [20, 80], [80, 160], [160, 320], [320, 640], [640, 1250],
    [1250, 2500], [2500, 5000], [5000, 10000], [10000, 20000],
  ];
  const PITCH_RATE = 16000;         // pitch tracking runs on a decimated copy
  const PITCH_SIZE = 2048;
  const PITCH_HOP_S = 0.06;
  const PITCH_MIN_VOICED = 0.4;     // share of loud frames with a pitch for "tonal"
  const MAX_EVENTS = 10;

  // ------------------------------------------------------------------- utils

  function db(amplitude) {
    return 20 * Math.log10(Math.max(amplitude, 1e-7));
  }

  function powerDb(power) {
    return 10 * Math.log10(Math.max(power, 1e-14));
  }

  function nextPow2(v) {
    return 1 << Math.ceil(Math.log2(v));
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = Array.from(values).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function percentile(sortedValues, p) {
    if (!sortedValues.length) return 0;
    const idx = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
    return sortedValues[idx];
  }

  /** Merge events whose start lies within `gap` seconds of the previous event's end. */
  function mergeEvents(events, gap, combine) {
    const out = [];
    events.sort((a, b) => a.t - b.t);
    for (const e of events) {
      const last = out[out.length - 1];
      if (last && e.t - (last.end !== undefined ? last.end : last.t) <= gap) out[out.length - 1] = combine(last, e);
      else out.push(Object.assign({}, e));
    }
    return out;
  }

  /** The `limit` strongest events by `key`, returned in time order. */
  function strongest(events, key, limit) {
    return events
      .slice()
      .sort((a, b) => b[key] - a[key])
      .slice(0, limit)
      .sort((a, b) => a.t - b.t);
  }

  // ------------------------------------------------------------ file headers

  function tag(view, pos) {
    if (pos < 0 || pos + 4 > view.byteLength) return '';
    return String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
  }

  /**
   * Read the native sample rate (plus channels, bit depth and duration where
   * the header has them) from a WAV, FLAC, MP4/M4A or MP3 file without
   * decoding it. Returns null for anything else.
   */
  function sniff(buffer) {
    const view = new DataView(buffer);
    return sniffWav(view) || sniffFlac(view) || sniffMp4(view) || sniffMp3(view);
  }

  function sniffWav(view) {
    if (tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') return null;
    const info = { format: 'wav', sampleRate: 0, channels: 0, bitDepth: null, encoding: 'pcm', duration: 0 };
    let dataBytes = 0;
    let pos = 12;
    while (pos + 8 <= view.byteLength) {
      const id = tag(view, pos);
      const size = view.getUint32(pos + 4, true);
      const body = pos + 8;
      if (id === 'fmt ' && size >= 16) {
        let format = view.getUint16(body, true);
        info.channels = view.getUint16(body + 2, true);
        info.sampleRate = view.getUint32(body + 4, true);
        info.bitDepth = view.getUint16(body + 14, true);
        if (format === 0xfffe && size >= 40) {
          const valid = view.getUint16(body + 18, true);
          if (valid) info.bitDepth = valid;
          format = view.getUint16(body + 24, true); // first word of the sub-format GUID
        }
        info.encoding = format === 3 ? 'float' : format === 1 ? 'pcm' : 'other';
      } else if (id === 'data') {
        dataBytes = Math.min(size, view.byteLength - body); // streaming WAVs lie about the size
      }
      pos = body + size + (size & 1);
    }
    if (!info.sampleRate) return null;
    if (dataBytes && info.channels && info.bitDepth) {
      info.duration = dataBytes / (info.channels * (info.bitDepth / 8)) / info.sampleRate;
    }
    return info;
  }

  function sniffFlac(view) {
    if (tag(view, 0) !== 'fLaC' || view.byteLength < 42) return null;
    // STREAMINFO is always the first metadata block; after 10 bytes of block
    // sizes come 20 bits sample rate, 3 bits channels−1, 5 bits bits−1, 36 bits samples.
    const hi = view.getUint32(18);
    const lo = view.getUint32(22);
    const sampleRate = hi >>> 12;
    const channels = ((hi >>> 9) & 7) + 1;
    const bitDepth = ((hi >>> 4) & 31) + 1;
    const samples = (hi & 15) * 4294967296 + lo;
    if (!sampleRate) return null;
    return { format: 'flac', sampleRate, channels, bitDepth, encoding: 'pcm', duration: samples / sampleRate };
  }

  // ISO base media (MP4/M4A): walk moov → trak → mdia → minf → stbl → stsd → mp4a.
  function readBox(view, pos, end) {
    if (pos + 8 > end) return null;
    let size = view.getUint32(pos);
    const type = tag(view, pos + 4);
    let start = pos + 8;
    if (size === 1) {
      if (pos + 16 > end) return null;
      size = view.getUint32(pos + 8) * 4294967296 + view.getUint32(pos + 12);
      start = pos + 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < start - pos) return null;
    return { type, start, end: Math.min(end, pos + size) };
  }

  function findBox(view, from, to, type) {
    let pos = from;
    while (pos < to) {
      const box = readBox(view, pos, to);
      if (!box) return null;
      if (box.type === type) return box;
      pos = box.end;
    }
    return null;
  }

  function sniffMp4(view) {
    if (tag(view, 4) !== 'ftyp') return null;
    const moov = findBox(view, 0, view.byteLength, 'moov');
    if (!moov) return null;
    let pos = moov.start;
    while (pos < moov.end) {
      const trak = readBox(view, pos, moov.end);
      if (!trak) break;
      pos = trak.end;
      if (trak.type !== 'trak') continue;
      const mdia = findBox(view, trak.start, trak.end, 'mdia');
      if (!mdia) continue;
      const hdlr = findBox(view, mdia.start, mdia.end, 'hdlr');
      if (hdlr && tag(view, hdlr.start + 8) !== 'soun') continue;

      const info = { format: 'm4a', sampleRate: 0, channels: 0, bitDepth: null, encoding: 'other', duration: 0 };
      const minf = findBox(view, mdia.start, mdia.end, 'minf');
      const stbl = minf && findBox(view, minf.start, minf.end, 'stbl');
      const stsd = stbl && findBox(view, stbl.start, stbl.end, 'stsd');
      const entry = stsd && readBox(view, stsd.start + 8, stsd.end); // skip version/flags + count
      if (entry && entry.start + 28 <= entry.end) {
        info.codec = entry.type;
        info.channels = view.getUint16(entry.start + 16);
        info.sampleRate = view.getUint16(entry.start + 24); // 16.16 fixed point, integer part
        if (entry.type === 'alac') info.encoding = 'pcm';
      }
      const mdhd = findBox(view, mdia.start, mdia.end, 'mdhd');
      if (mdhd) {
        const v1 = view.getUint8(mdhd.start) === 1;
        const timescale = view.getUint32(mdhd.start + (v1 ? 20 : 12));
        const duration = v1
          ? view.getUint32(mdhd.start + 24) * 4294967296 + view.getUint32(mdhd.start + 28)
          : view.getUint32(mdhd.start + 16);
        if (info.sampleRate < 8000) info.sampleRate = timescale;
        if (timescale) info.duration = duration / timescale;
      }
      if (info.sampleRate) return info;
    }
    return null;
  }

  const MP3_RATES = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]];
  const MP3_BITRATES = {
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],   // MPEG 1, layer III
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],       // MPEG 2 / 2.5, layer III
  };

  function mp3Header(view, pos) {
    if (pos + 4 > view.byteLength) return null;
    const b1 = view.getUint8(pos);
    const b2 = view.getUint8(pos + 1);
    const b3 = view.getUint8(pos + 2);
    const b4 = view.getUint8(pos + 3);
    if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null;
    const version = (b2 >> 3) & 3;
    const layer = (b2 >> 1) & 3;
    const bitrateIndex = b3 >> 4;
    const rateIndex = (b3 >> 2) & 3;
    if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
    const sampleRate = MP3_RATES[version][rateIndex];
    let length = 0;
    if (layer === 1) { // layer III: we know the frame length, so the next sync can be checked
      const kbps = MP3_BITRATES[version === 3 ? 3 : 2][bitrateIndex];
      length = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / sampleRate) + ((b3 >> 1) & 1);
    }
    return { sampleRate, channels: (b4 >> 6) === 3 ? 1 : 2, length };
  }

  function sniffMp3(view) {
    let pos = 0;
    if (tag(view, 0).slice(0, 3) === 'ID3' && view.byteLength >= 10) {
      const size = ((view.getUint8(6) & 127) << 21) | ((view.getUint8(7) & 127) << 14)
        | ((view.getUint8(8) & 127) << 7) | (view.getUint8(9) & 127);
      pos = 10 + size + (view.getUint8(5) & 16 ? 10 : 0);
    }
    const limit = Math.min(view.byteLength - 4, pos + 65536);
    for (; pos < limit; pos++) {
      const h = mp3Header(view, pos);
      if (!h) continue;
      if (h.length) {
        const next = mp3Header(view, pos + h.length);
        if (!next || next.sampleRate !== h.sampleRate) continue; // a stray sync pattern
      }
      return { format: 'mp3', sampleRate: h.sampleRate, channels: h.channels, bitDepth: null, encoding: 'other', duration: 0 };
    }
    return null;
  }

  // ----------------------------------------------------------- channel choice

  /**
   * Decide which signal to measure. Identical channels (dual mono) and a stereo
   * track with only one side connected are common with beginners' setups; in
   * both cases the single channel is the honest thing to analyse. Genuinely
   * different channels are summed to mono.
   */
  function pickChannel(channels) {
    if (channels.length === 1) return { samples: channels[0], layout: 'mono' };
    const n = Math.min.apply(null, channels.map((c) => c.length));
    if (channels.length === 2) {
      const [l, r] = channels;
      let sl = 0;
      let sr = 0;
      let sd = 0;
      for (let i = 0; i < n; i++) {
        const a = l[i];
        const b = r[i];
        sl += a * a;
        sr += b * b;
        sd += (a - b) * (a - b);
      }
      const rmsL = Math.sqrt(sl / n);
      const rmsR = Math.sqrt(sr / n);
      const rmsDiff = Math.sqrt(sd / n);
      const louder = Math.max(rmsL, rmsR);
      if (rmsDiff <= louder * 0.00316) {                     // difference 50 dB down: same signal
        return { samples: l, layout: 'dual-mono' };
      }
      if (rmsR <= rmsL * 0.01) {                              // right side 40 dB down: unused input
        return { samples: l, layout: 'left-only', otherDb: db(rmsR) - db(rmsL) };
      }
      if (rmsL <= rmsR * 0.01) {
        return { samples: r, layout: 'right-only', otherDb: db(rmsL) - db(rmsR) };
      }
    }
    const sum = new Float32Array(n);
    const scale = 1 / channels.length;
    for (let c = 0; c < channels.length; c++) {
      const x = channels[c];
      for (let i = 0; i < n; i++) sum[i] += x[i] * scale;
    }
    return { samples: sum, layout: 'sum', channels: channels.length };
  }

  // --------------------------------------------------------------------- FFT

  /** Iterative radix-2 FFT with precomputed tables; transforms in place. */
  function createFft(n) {
    const levels = Math.round(Math.log2(n));
    if (1 << levels !== n) throw new Error('FFT size must be a power of two');
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0, v = i; b < levels; b++, v >>>= 1) r = (r << 1) | (v & 1);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }

    function forward(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0, t = 0; k < half; k++, t += step) {
            const wr = cos[t];
            const wi = sin[t];
            const a = start + k;
            const b = a + half;
            const xr = re[b] * wr - im[b] * wi;
            const xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr;
            im[b] = im[a] - xi;
            re[a] += xr;
            im[a] += xi;
          }
        }
      }
    }

    return { forward, size: n };
  }

  function hann(n) {
    const w = new Float64Array(n);
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      sumSq += w[i] * w[i];
    }
    return { w, sumSq };
  }

  /**
   * Single-sided power spectrum of one windowed frame into `power` (bins 0…n/2,
   * inner bins doubled). Multiplying a bin sum by `msScale` gives the mean
   * square of the *unwindowed* signal in that band (Parseval, window energy
   * divided out) — so 10·log10 of it is a plain dBFS RMS level.
   */
  function createSpectrum(n) {
    const fft = createFft(n);
    const win = hann(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const power = new Float64Array(n / 2 + 1);
    const half = n / 2;
    const msScale = 1 / (n * win.sumSq);

    function analyse(x, offset, dc) {
      const w = win.w;
      const end = Math.min(n, x.length - offset);
      for (let i = 0; i < end; i++) {
        re[i] = (x[offset + i] - dc) * w[i];
        im[i] = 0;
      }
      for (let i = end; i < n; i++) { re[i] = 0; im[i] = 0; }
      fft.forward(re, im);
      power[0] = re[0] * re[0] + im[0] * im[0];
      for (let k = 1; k < half; k++) power[k] = 2 * (re[k] * re[k] + im[k] * im[k]);
      power[half] = re[half] * re[half] + im[half] * im[half];
      return power;
    }

    return { analyse, power, msScale, size: n };
  }

  function sumRange(arr, from, to) {
    let s = 0;
    for (let k = from; k < to; k++) s += arr[k];
    return s;
  }

  // ------------------------------------------------------------- time domain

  function levels(x) {
    let peak = 0;
    let peakIndex = 0;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const a = v < 0 ? -v : v;
      if (a > peak) { peak = a; peakIndex = i; }
      sum += v;
      sumSq += v * v;
    }
    return { peak, peakIndex, mean: sum / x.length, rms: Math.sqrt(sumSq / x.length) };
  }

  /**
   * Noise floor: RMS of 200 ms blocks, 5th percentile. Blocks of pure digital
   * silence say nothing about the recording chain (they come from a gate or an
   * empty region in the DAW), so they are left out and counted separately.
   */
  function noiseFloor(x, sr) {
    const block = Math.max(1, Math.round(NOISE_BLOCK_S * sr));
    const count = Math.floor(x.length / block);
    const rms = [];
    let silent = 0;
    for (let b = 0; b < count; b++) {
      const off = b * block;
      let s = 0;
      for (let i = 0; i < block; i++) {
        const v = x[off + i];
        s += v * v;
      }
      if (s === 0) silent++;
      else rms.push(Math.sqrt(s / block));
    }
    rms.sort((a, b) => a - b);
    return { rms: rms.length ? percentile(rms, NOISE_PERCENTILE) : 0, blocks: count, silentBlocks: silent };
  }

  function findClipping(x, sr, channel) {
    const runs = [];
    let run = 0;
    for (let i = 0; i <= x.length; i++) {
      const a = i < x.length ? Math.abs(x[i]) : 0;
      if (a >= CLIP_LEVEL) { run++; continue; }
      if (run >= CLIP_RUN) runs.push({ t: (i - run) / sr, end: i / sr, samples: run, runs: 1, channel });
      run = 0;
    }
    return runs;
  }

  function findZeroRuns(x, sr) {
    const events = [];
    let silence = 0;
    let run = 0;
    const n = x.length;
    for (let i = 0; i <= n; i++) {
      if (i < n && x[i] === 0) { run++; continue; }
      if (run > 0) {
        const start = i - run;
        if (start === 0 || i === n || run >= SILENCE_RUN_S * sr) silence += run;
        else if (run > ZERO_RUN) events.push({ t: start / sr, end: i / sr, samples: run });
      }
      run = 0;
    }
    return { events, silenceSamples: silence };
  }

  /**
   * Discontinuities. Note that the textbook bound — a band-limited signal can't
   * change by more than π·peak per sample — can never trigger, because a step
   * of size s always has a local peak of at least s/2. What does single out a
   * skipped or repeated buffer is that the step is *isolated*: the differences a
   * few samples either side are far smaller, which a smooth waveform never shows
   * (its difference sequence is itself band-limited). Clicks from hard edits
   * look the same, so the report calls them "jumps".
   */
  function findJumps(x, sr, zeroRuns) {
    const n = x.length;
    const block = Math.max(1, Math.round(LOCAL_WINDOW_S * sr));
    const blocks = Math.ceil(n / block);
    const blockPeak = new Float32Array(blocks);
    for (let b = 0; b < blocks; b++) {
      const end = Math.min(n, (b + 1) * block);
      let m = 0;
      for (let i = b * block; i < end; i++) {
        const a = x[i] < 0 ? -x[i] : x[i];
        if (a > m) m = a;
      }
      blockPeak[b] = m;
    }

    const R = 6;
    const events = [];
    for (let i = R + 1; i < n - R; i++) {
      const d = Math.abs(x[i] - x[i - 1]);
      if (d < JUMP_MIN) continue;
      const b = (i / block) | 0;
      const local = Math.max(blockPeak[b], b > 0 ? blockPeak[b - 1] : 0, b + 1 < blocks ? blockPeak[b + 1] : 0);
      if (d < JUMP_LOCAL * local) continue;
      let m = 0;
      for (let k = 2; k <= R; k++) {
        const before = Math.abs(x[i - k] - x[i - k - 1]);
        const after = Math.abs(x[i + k] - x[i + k - 1]);
        if (before > m) m = before;
        if (after > m) m = after;
      }
      if (d > JUMP_RATIO * m) events.push({ t: i / sr, size: d });
    }
    // The edges of a zero run are jumps too, but those are already reported.
    const nearZeroRun = (e) => zeroRuns.some((z) => e.t >= z.t - 0.001 && e.t <= z.end + 0.001);
    return mergeEvents(events.filter((e) => !nearZeroRun(e)), LOCAL_WINDOW_S,
      (a, b) => ({ t: a.t, end: b.t, size: Math.max(a.size, b.size) }));
  }

  /**
   * True peak: the signal 4× oversampled with a 12-taps-per-phase windowed-sinc
   * interpolator (a simple stand-in for the BS.1770 Annex 2 filter).
   */
  function truePeak(x, samplePeak) {
    const phases = 4;
    const taps = 12;
    const half = taps / 2;
    const h = [];
    for (let p = 1; p < phases; p++) {
      const coeffs = new Float64Array(taps);
      let sum = 0;
      for (let j = 0; j < taps; j++) {
        const t = j - half + 1 - p / phases;           // tap position relative to the interpolated point
        const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (half + 0.5));
        coeffs[j] = sinc * w;
        sum += coeffs[j];
      }
      for (let j = 0; j < taps; j++) coeffs[j] /= sum;
      h.push(coeffs);
    }
    let peak = samplePeak;
    const n = x.length;
    for (let i = half; i < n - half; i++) {
      for (let p = 0; p < h.length; p++) {
        const c = h[p];
        let acc = 0;
        for (let j = 0; j < taps; j++) acc += c[j] * x[i - half + 1 + j];
        if (acc < 0) acc = -acc;
        if (acc > peak) peak = acc;
      }
    }
    return peak;
  }

  // ---------------------------------------------------------------- loudness

  /**
   * ITU-R BS.1770-4 K-weighting for any sample rate (the formulation used by
   * libebur128; at 48 kHz it reproduces the coefficients printed in the standard).
   */
  function kWeighting(sr) {
    let f0 = 1681.974450955533;
    const G = 3.999843853973347;
    let Q = 0.7071752369554196;
    let K = Math.tan((Math.PI * f0) / sr);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const shelf = {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
    f0 = 38.13547087602444;
    Q = 0.5003270373238773;
    K = Math.tan((Math.PI * f0) / sr);
    a0 = 1 + K / Q + K * K;
    const highpass = {
      b0: 1, b1: -2, b2: 1,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
    return { shelf, highpass };
  }

  /**
   * Integrated loudness: K-weighted mean square in 400 ms blocks every 100 ms,
   * absolute gate at −70 LUFS, relative gate 10 LU below the mean of the rest.
   */
  function integratedLoudness(channels, sr, progress) {
    const sub = Math.round(0.1 * sr);
    const subCount = Math.floor(channels[0].length / sub);
    if (subCount < 4) return { lufs: -Infinity, blocks: 0, gatedBlocks: 0 };

    const weights = channels.length > 2 ? [1, 1, 1, 1.41, 1.41] : [1, 1];
    const subSq = new Float64Array(subCount);
    const { shelf, highpass } = kWeighting(sr);
    const total = subCount * sub;

    channels.forEach((x, c) => {
      const g = weights[c] === undefined ? 1 : weights[c];
      let s1 = 0, s2 = 0, t1 = 0, t2 = 0;
      for (let m = 0; m < subCount; m++) {
        const off = m * sub;
        let acc = 0;
        for (let i = off; i < off + sub; i++) {
          const v = x[i];
          const y = shelf.b0 * v + s1;
          s1 = shelf.b1 * v - shelf.a1 * y + s2;
          s2 = shelf.b2 * v - shelf.a2 * y;
          const z = highpass.b0 * y + t1;
          t1 = highpass.b1 * y - highpass.a1 * z + t2;
          t2 = highpass.b2 * y - highpass.a2 * z;
          acc += z * z;
        }
        subSq[m] += g * acc;
        if ((m & 63) === 0) progress((c + off / total) / channels.length);
      }
    });

    const blocks = subCount - 3;
    const z = new Float64Array(blocks);
    for (let j = 0; j < blocks; j++) z[j] = (subSq[j] + subSq[j + 1] + subSq[j + 2] + subSq[j + 3]) / (4 * sub);
    const loudness = (ms) => -0.691 + 10 * Math.log10(ms);

    let sum = 0;
    let count = 0;
    for (let j = 0; j < blocks; j++) {
      if (loudness(z[j]) > -70) { sum += z[j]; count++; }
    }
    if (!count) return { lufs: -Infinity, blocks, gatedBlocks: 0 };
    const relative = loudness(sum / count) - 10;
    sum = 0;
    count = 0;
    for (let j = 0; j < blocks; j++) {
      if (loudness(z[j]) > relative) { sum += z[j]; count++; }
    }
    return { lufs: count ? loudness(sum / count) : -Infinity, blocks, gatedBlocks: count };
  }

  // ---------------------------------------------------------------- spectrum

  function binRange(lo, hi, binHz, bins) {
    return [Math.min(bins, Math.ceil(lo / binHz)), Math.min(bins, Math.ceil(hi / binHz))];
  }

  /** One pass over the STFT: per-frame band levels and the whole-file band energies. */
  function spectralPass(x, sr, dc, progress) {
    const n = FFT_SIZE;
    const spec = createSpectrum(n);
    const bins = n / 2 + 1;
    const binHz = sr / n;
    const frames = x.length >= n ? Math.floor((x.length - n) / HOP) + 1 : 1;

    const subEnd = binRange(0, SUBSONIC_HZ, binHz, bins)[1];
    const ploEnd = binRange(0, PLOSIVE_HZ, binHz, bins)[1];
    const [sibLo, sibHi] = binRange(SIBILANCE_LO, SIBILANCE_HI, binHz, bins);
    const bands = BALANCE_BANDS.map(([lo, hi]) => binRange(lo, hi, binHz, bins));
    const bandPower = new Float64Array(bands.length);

    const sub = new Float32Array(frames);       // mean square below 40 Hz, per frame
    const plo = new Float32Array(frames);       // mean square below 45 Hz
    const wide = new Float32Array(frames);      // broadband mean square
    const sib = new Float32Array(frames);       // 5–9 kHz mean square

    for (let f = 0; f < frames; f++) {
      const power = spec.analyse(x, f * HOP, dc);
      sub[f] = sumRange(power, 0, subEnd) * spec.msScale;
      plo[f] = sumRange(power, 0, ploEnd) * spec.msScale;
      sib[f] = sumRange(power, sibLo, sibHi) * spec.msScale;
      wide[f] = sumRange(power, 0, bins) * spec.msScale;
      for (let b = 0; b < bands.length; b++) bandPower[b] += sumRange(power, bands[b][0], bands[b][1]);
      if ((f & 31) === 0) progress(f / frames);
    }

    return { frames, hopSeconds: HOP / sr, frameSeconds: n / sr, sub, plo, wide, sib, bandPower, msScale: spec.msScale };
  }

  function subsonic(s) {
    let peak = 0;
    let sum = 0;
    for (let f = 0; f < s.frames; f++) {
      if (s.sub[f] > peak) peak = s.sub[f];
      sum += s.sub[f];
    }
    return { peakDb: powerDb(peak), rmsDb: powerDb(sum / s.frames) };
  }

  /**
   * Plosives: 100 ms windows whose sub-45 Hz level exceeds −50 dBFS. Adjacent
   * windows are one event, stamped with the time of its loudest window.
   */
  function plosives(s) {
    const windowFrames = Math.max(1, Math.round(PLOSIVE_WINDOW_S / s.hopSeconds));
    const events = [];
    for (let f = 0; f < s.frames; f += windowFrames) {
      let peak = 0;
      for (let k = f; k < Math.min(s.frames, f + windowFrames); k++) if (s.plo[k] > peak) peak = s.plo[k];
      const level = powerDb(peak);
      if (level > PLOSIVE_DB) events.push({ t: f * s.hopSeconds, end: (f + windowFrames) * s.hopSeconds, db: level });
    }
    const merged = mergeEvents(events, 0.001, (a, b) => (b.db > a.db ? { t: b.t, end: b.end, db: b.db } : { t: a.t, end: b.end, db: a.db }));
    return { count: merged.length, events: strongest(merged, 'db', MAX_EVENTS) };
  }

  /**
   * Sibilance: 5–9 kHz level relative to the broadband level per frame; frames
   * quieter than −30 dBFS are skipped. The STFT hop (≈ 43–46 ms) stands in for
   * the 50 ms window. Every S in the lyrics shows up here, so the count is a
   * rate, not a verdict — the report says so.
   */
  function sibilance(s) {
    const gate = Math.pow(10, SIBILANCE_GATE_DB / 10);
    const events = [];
    let loud = 0;
    let flagged = 0;
    let maxRatio = -Infinity;
    for (let f = 0; f < s.frames; f++) {
      if (s.wide[f] < gate) continue;
      loud++;
      const ratio = powerDb(s.sib[f]) - powerDb(s.wide[f]);
      if (ratio > maxRatio) maxRatio = ratio;
      if (ratio > SIBILANCE_RATIO_DB) {
        flagged++;
        events.push({ t: f * s.hopSeconds, end: (f + 1) * s.hopSeconds, ratioDb: ratio, db: powerDb(s.wide[f]) });
      }
    }
    const merged = mergeEvents(events, 0.001, (a, b) => (b.ratioDb > a.ratioDb
      ? { t: b.t, end: b.end, ratioDb: b.ratioDb, db: b.db }
      : { t: a.t, end: b.end, ratioDb: a.ratioDb, db: a.db }));
    return {
      loudFrames: loud,
      flaggedFrames: flagged,
      share: loud ? flagged / loud : 0,
      maxRatioDb: loud ? maxRatio : null,
      count: merged.length,
      events: strongest(merged, 'ratioDb', MAX_EVENTS),
    };
  }

  function balance(s) {
    let total = 0;
    for (let b = 0; b < s.bandPower.length; b++) total += s.bandPower[b];
    return BALANCE_BANDS.map(([lo, hi], b) => ({
      lo, hi,
      percent: total ? (100 * s.bandPower[b]) / total : 0,
      db: powerDb((s.bandPower[b] * s.msScale) / s.frames),
    }));
  }

  /**
   * Mains hum: averaged power spectrum with ≈ 3 Hz bins over the quiet frames
   * (within 10 dB of the noise floor), or over everything if there are none.
   * Each harmonic of 50 and 60 Hz up to 300 Hz is compared with the median of
   * its ±20 Hz neighbourhood; the family with more peaks that stick out wins.
   */
  function humPass(x, sr, dc, noiseRms, progress) {
    const n = nextPow2(sr / 3);
    const frames = Math.floor(x.length / n);
    if (!frames) return null;
    const spec = createSpectrum(n);
    const bins = n / 2 + 1;
    const binHz = sr / n;
    const quietLimit = noiseRms * Math.pow(10, HUM_QUIET_MARGIN_DB / 20);
    const all = new Float64Array(bins);
    const quiet = new Float64Array(bins);
    let quietFrames = 0;

    for (let f = 0; f < frames; f++) {
      const off = f * n;
      let s = 0;
      for (let i = off; i < off + n; i++) s += x[i] * x[i];
      const isQuiet = Math.sqrt(s / n) <= quietLimit;
      const power = spec.analyse(x, off, dc);
      for (let k = 0; k < bins; k++) all[k] += power[k];
      if (isQuiet) {
        quietFrames++;
        for (let k = 0; k < bins; k++) quiet[k] += power[k];
      }
      if ((f & 7) === 0) progress(f / frames);
    }

    const useQuiet = quietFrames >= HUM_MIN_QUIET_FRAMES;
    const spectrum = useQuiet ? quiet : all;
    const count = useQuiet ? quietFrames : frames;
    const lobe = 2;                                             // Hann main lobe half-width in bins
    const search = Math.max(1, Math.round(3 / binHz));          // mains drifts a little
    const reach = Math.round(20 / binHz);

    const families = HUM_FAMILIES.map((f0) => {
      const harmonics = [];
      for (let f = f0; f <= HUM_MAX_HZ; f += f0) {
        const kc = Math.round(f / binHz);
        let kp = kc;
        for (let k = kc - search; k <= kc + search; k++) if (k >= 0 && k < bins && spectrum[k] > spectrum[kp]) kp = k;
        let lobeSum = 0;
        for (let k = kp - lobe; k <= kp + lobe; k++) if (k >= 0 && k < bins) lobeSum += spectrum[k];
        const around = [];
        for (let k = kp - reach; k <= kp + reach; k++) {
          if (k >= 0 && k < bins && Math.abs(k - kp) > lobe) around.push(spectrum[k]);
        }
        const excessDb = powerDb(spectrum[kp]) - powerDb(median(around));
        const levelDb = powerDb((lobeSum * spec.msScale) / count);
        harmonics.push({ hz: f, excessDb, levelDb, hit: excessDb > HUM_EXCESS_DB && levelDb > HUM_MIN_LEVEL_DB });
      }
      const hits = harmonics.filter((h) => h.hit);
      return {
        hz: f0,
        harmonics,
        hits: hits.length,
        score: hits.reduce((a, h) => a + h.excessDb, 0),
        excessDb: Math.max.apply(null, (hits.length ? hits : harmonics).map((h) => h.excessDb)),
        levelDb: hits.length ? Math.max.apply(null, hits.map((h) => h.levelDb)) : -Infinity,
      };
    });
    families.sort((a, b) => b.hits - a.hits || b.score - a.score);
    const best = families[0];
    return {
      mains: best.hits ? best.hz : null,
      hits: best.hits,
      excessDb: best.excessDb,
      levelDb: best.levelDb,
      harmonics: best.harmonics,
      measuredOn: useQuiet ? 'quiet' : 'all',
      quietSeconds: (quietFrames * n) / sr,
      resolutionHz: binHz,
    };
  }

  // ------------------------------------------------------------------- pitch

  /** Anti-aliased decimation by an integer factor (windowed-sinc low-pass). */
  function decimate(x, factor) {
    const taps = 16 * factor + 1;
    const half = (taps - 1) / 2;
    const fc = 0.45 / factor;
    const h = new Float64Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const t = i - half;
      const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
      const u = i / (taps - 1);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
      h[i] = sinc * w;
      sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;

    const n = x.length;
    const out = new Float32Array(Math.floor(n / factor));
    for (let m = 0; m < out.length; m++) {
      const c = m * factor;
      let acc = 0;
      if (c - half >= 0 && c + half < n) {
        for (let i = 0; i < taps; i++) acc += h[i] * x[c - half + i];
      } else {
        for (let i = 0; i < taps; i++) {
          const idx = c - half + i;
          if (idx >= 0 && idx < n) acc += h[i] * x[idx];
        }
      }
      out[m] = acc;
    }
    return out;
  }

  /**
   * f0 over time with the tuner's detector (McLeod), on a copy decimated to
   * ≈ 16 kHz so five minutes take a couple of seconds. Also decides whether the
   * material is tonal enough for the result to mean anything.
   */
  function pitchPass(x, sr, pitchApi, progress) {
    const factor = Math.max(1, Math.floor(sr / PITCH_RATE));
    const y = factor > 1 ? decimate(x, factor) : x;
    const rate = sr / factor;
    const size = PITCH_SIZE;
    const hop = Math.max(1, Math.round(PITCH_HOP_S * rate));
    if (y.length < size) return null;
    const frames = Math.floor((y.length - size) / hop) + 1;
    const detector = pitchApi.createDetector({ sampleRate: rate, bufferSize: size, minFreq: 60, maxFreq: 1200, minClarity: 0.8 });
    const minRms = 0.003;

    const track = new Float32Array(frames);
    const clarity = new Float32Array(frames);
    let loud = 0;
    let voiced = 0;
    for (let f = 0; f < frames; f++) {
      const r = detector.detect(y.subarray(f * hop, f * hop + size));
      clarity[f] = r.clarity;
      if (r.rms >= minRms) loud++;
      if (r.frequency > 0) { voiced++; track[f] = r.frequency; }
      if ((f & 15) === 0) progress(f / frames);
    }

    const voicedRatio = loud ? voiced / loud : 0;
    const tonal = loud >= 10 && voicedRatio >= PITCH_MIN_VOICED;
    const result = { tonal, frames, hopSeconds: hop / rate, loudFrames: loud, voicedFrames: voiced, voicedRatio, track, clarity };
    if (!tonal) return result;

    // Range: 5th–95th percentile so a stray octave error doesn't set it.
    const f0 = [];
    for (let f = 0; f < frames; f++) if (track[f] > 0) f0.push(track[f]);
    f0.sort((a, b) => a - b);
    result.lowHz = percentile(f0, 0.05);
    result.highHz = percentile(f0, 0.95);
    result.medianHz = median(f0);

    // Wobble: how far each voiced frame strays from the median of its ±150 ms.
    const reach = Math.max(1, Math.round(0.15 / result.hopSeconds));
    const deviations = [];
    for (let f = 0; f < frames; f++) {
      if (!(track[f] > 0)) continue;
      const near = [];
      for (let k = Math.max(0, f - reach); k <= Math.min(frames - 1, f + reach); k++) if (track[k] > 0) near.push(track[k]);
      deviations.push(Math.abs(1200 * Math.log2(track[f] / median(near))));
    }
    result.wobbleCents = median(deviations);
    return result;
  }

  // ----------------------------------------------------------------- analyse

  /**
   * Run every measurement. `channels` are the decoded channels of the file at
   * `sampleRate`; `progress(fraction, stage)` is called along the way.
   */
  function analyse(channels, sampleRate, options, onProgress) {
    const opts = options || {};
    const report = onProgress || function () {};
    const started = Date.now();
    const sr = sampleRate;
    const maxSamples = Math.floor((opts.maxSeconds || MAX_SECONDS) * sr);
    const truncated = channels.some((c) => c.length > maxSamples);
    const input = channels.map((c) => (c.length > maxSamples ? c.subarray(0, maxSamples) : c));
    const pick = pickChannel(input);
    const x = pick.samples;
    const n = x.length;
    if (!n) throw new Error('The file contains no audio.');

    const stage = (name, from, to) => (fraction) => report(from + (to - from) * Math.min(1, fraction), name);

    let progress = stage('Measuring levels', 0, 0.12);
    progress(0);
    const lv = levels(x);
    const noise = noiseFloor(x, sr);
    progress(0.3);
    const clipRuns = [];
    input.forEach((c, i) => clipRuns.push.apply(clipRuns, findClipping(c, sr, i)));
    const clipEvents = mergeEvents(clipRuns, CLIP_MERGE_S, (a, b) => ({
      t: a.t, end: Math.max(a.end, b.end), samples: a.samples + b.samples, runs: a.runs + b.runs, channel: a.channel,
    }));
    progress(0.5);
    const zeros = findZeroRuns(x, sr);
    progress(0.6);
    const jumps = findJumps(x, sr, zeros.events);
    progress(1);

    progress = stage('Checking true peak', 0.12, 0.28);
    progress(0);
    const tp = truePeak(x, lv.peak);
    progress(1);

    progress = stage('Measuring loudness', 0.28, 0.4);
    const loud = integratedLoudness(input, sr, progress);
    progress(1);

    // The DC offset is reported on its own; the spectral checks look at the
    // signal without it, otherwise it would show up as rumble and plosives.
    progress = stage('Analysing spectrum', 0.4, 0.7);
    const spec = spectralPass(x, sr, lv.mean, progress);
    progress(1);

    progress = stage('Looking for hum', 0.7, 0.78);
    const hum = humPass(x, sr, lv.mean, noise.rms, progress);
    progress(1);

    const pitchApi = opts.pitch || (typeof Pitch !== 'undefined' ? Pitch : null);
    let pitch = null;
    if (pitchApi) {
      progress = stage('Tracking pitch', 0.78, 1);
      pitch = pitchPass(x, sr, pitchApi, progress);
    }
    report(1, 'Done');

    const peakDb = db(lv.peak);
    const noiseDb = noise.rms > 0 ? db(noise.rms) : -Infinity;
    const snr = peakDb - noiseDb;
    const totalClipped = clipEvents.reduce((a, e) => a + e.samples, 0);

    return {
      sampleRate: sr,
      samples: n,
      duration: n / sr,
      truncated,
      layout: pick.layout,
      layoutDetail: { channels: channels.length, otherDb: pick.otherDb },
      silenceSeconds: zeros.silenceSamples / sr,
      peak: { db: peakDb, linear: lv.peak, t: lv.peakIndex / sr },
      truePeak: { db: db(tp), linear: tp },
      rms: { db: db(lv.rms) },
      crest: { db: peakDb - db(lv.rms) },
      noiseFloor: { db: noiseDb, blocks: noise.blocks, silentBlocks: noise.silentBlocks, blockSeconds: NOISE_BLOCK_S },
      snr: { db: snr },
      noiseAtMix: { db: noiseDb + (-3 - peakDb) },
      loudness: { lufs: loud.lufs, blocks: loud.blocks, gatedBlocks: loud.gatedBlocks, channels: input.length },
      clipping: { count: clipEvents.length, samples: totalClipped, runs: clipRuns.length, events: strongest(clipEvents, 'samples', MAX_EVENTS) },
      dropouts: {
        zeroRuns: { count: zeros.events.length, events: strongest(zeros.events, 'samples', MAX_EVENTS) },
        jumps: { count: jumps.length, events: strongest(jumps, 'size', MAX_EVENTS) },
      },
      dc: { offset: lv.mean, db: db(Math.abs(lv.mean)) },
      subsonic: subsonic(spec),
      plosives: plosives(spec),
      sibilance: sibilance(spec),
      hum,
      balance: balance(spec),
      pitch,
      elapsedMs: Date.now() - started,
    };
  }

  return {
    analyse,
    sniff,
    pickChannel,
    createFft,
    kWeighting,
    integratedLoudness,
    truePeak,
    decimate,
    db,
    MAX_SECONDS,
    FFT_SIZE,
    BALANCE_BANDS,
  };
});
