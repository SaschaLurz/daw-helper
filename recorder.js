/*
 * recorder.js — the maths behind Record mode, without any audio.
 *
 * - createMeter(): peak/RMS meter ballistics from the blocks the capture
 *   worklet reports (instant attack, steady fall, peak hold, clip latch).
 * - levelStatus(): what the loudest peak says about the input gain, with the
 *   same targets as the Analysis report.
 * - encodeWav(): channels of float samples → a PCM WAV file.
 * - noiseVerdict(): turns an Analysis.analyse() result of a few seconds of
 *   silence into a noise, hum and signal-to-noise verdict.
 *
 * Loaded as a plain <script> in the browser (window.Recorder) and via
 * require() in Node for the tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.Recorder = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Peak targets for recording, matching the Analysis report.
  const TARGET = { floor: -24, low: -18, high: -12, ceiling: -6 };
  const NO_SIGNAL_DB = -60;

  const dbfs = (linear) => (linear > 0 ? 20 * Math.log10(linear) : -Infinity);

  // ------------------------------------------------------------------ meter

  /**
   * update(block, t): block = { peak: [], sumSq: [], clips: [], frames } per
   * channel, t in seconds. read(t) gives each channel's bar (peakDb, falling
   * back after a peak), hold marker (holdDb), rmsDb and clip latch, plus the
   * loudest peak since the last reset.
   */
  function createMeter(options) {
    const o = Object.assign({ decayDbPerSecond: 20, holdSeconds: 1.5, rmsSeconds: 0.3 }, options);
    let channels = [];
    let maxDb = -Infinity;
    let clipped = false;

    const fallen = (db, since, t) => db - o.decayDbPerSecond * Math.max(0, t - since);
    const barDb = (c, t) => fallen(c.level, c.levelAt, t);
    const holdDb = (c, t) => (t - c.holdAt <= o.holdSeconds ? c.hold : fallen(c.hold, c.holdAt + o.holdSeconds, t));

    function update(block, t) {
      const count = block.peak.length;
      while (channels.length < count) {
        channels.push({ level: -Infinity, levelAt: t, hold: -Infinity, holdAt: t, blocks: [], clipped: false });
      }
      channels.length = count;
      for (let i = 0; i < count; i++) {
        const c = channels[i];
        const d = dbfs(block.peak[i]);
        if (d >= barDb(c, t)) { c.level = d; c.levelAt = t; }
        if (d >= holdDb(c, t)) { c.hold = d; c.holdAt = t; }
        c.blocks.push({ t, sumSq: block.sumSq[i], frames: block.frames });
        while (c.blocks.length && c.blocks[0].t <= t - o.rmsSeconds) c.blocks.shift();
        if (block.clips[i]) { c.clipped = true; clipped = true; }
        if (d > maxDb) maxDb = d;
      }
    }

    function rmsDb(c, t) {
      let sum = 0;
      let frames = 0;
      for (const b of c.blocks) {
        if (b.t > t - o.rmsSeconds) { sum += b.sumSq; frames += b.frames; }
      }
      return frames ? dbfs(Math.sqrt(sum / frames)) : -Infinity;
    }

    function read(t) {
      return {
        channels: channels.map((c) => ({ peakDb: barDb(c, t), holdDb: holdDb(c, t), rmsDb: rmsDb(c, t), clipped: c.clipped })),
        maxDb,
        clipped,
      };
    }

    function reset() {
      maxDb = -Infinity;
      clipped = false;
      channels.forEach((c) => { c.clipped = false; c.hold = -Infinity; });
    }

    return { update, read, reset };
  }

  /**
   * What the loudest peak so far says about the gain. Judged at the 0.1 dB the
   * meter shows, so "−12.0" never reads as too hot.
   */
  function levelStatus(peak, clipped) {
    const peakDb = Math.round(peak * 10) / 10;
    if (clipped) return { status: 'bad', text: 'Clipped — turn the gain down, then reset the peak' };
    if (!(peakDb > NO_SIGNAL_DB)) return { status: 'info', text: 'Play or sing the loudest part to set the gain' };
    if (peakDb < TARGET.floor) return { status: 'bad', text: 'Too quiet — turn the gain up' };
    if (peakDb < TARGET.low) return { status: 'warn', text: 'A little quiet — turn the gain up a bit' };
    if (peakDb <= TARGET.high) return { status: 'good', text: 'Good level' };
    if (peakDb <= TARGET.ceiling) return { status: 'warn', text: 'A little hot — a louder moment could clip' };
    return { status: 'bad', text: 'Too hot — turn the gain down' };
  }

  // -------------------------------------------------------------------- WAV

  /** PCM WAV (16 or 24 bit) from equally long Float32Array channels. */
  function encodeWav(channels, sampleRate, bitDepth) {
    const bits = bitDepth || 24;
    const bytes = bits / 8;
    const count = channels.length;
    const frames = count ? channels[0].length : 0;
    const dataSize = frames * count * bytes;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const text = (pos, s) => { for (let i = 0; i < s.length; i++) view.setUint8(pos + i, s.charCodeAt(i)); };

    text(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                             // PCM
    view.setUint16(22, count, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * count * bytes, true);   // bytes per second
    view.setUint16(32, count * bytes, true);                // bytes per frame
    view.setUint16(34, bits, true);
    text(36, 'data');
    view.setUint32(40, dataSize, true);

    const out = new Uint8Array(buffer);
    const full = Math.pow(2, bits - 1);
    let pos = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < count; c++) {
        const v = channels[c][i];
        const clamped = v > 1 ? 1 : v < -1 ? -1 : v || 0;
        const q = Math.min(full - 1, Math.round(clamped * full));
        out[pos++] = q & 0xff;
        out[pos++] = (q >> 8) & 0xff;
        if (bytes === 3) out[pos++] = (q >> 16) & 0xff;
      }
    }
    return buffer;
  }

  // ------------------------------------------------------------------ noise

  const fmt = (db) => `${db < 0 ? '−' : ''}${Math.abs(db).toFixed(0)}`;

  /**
   * Verdict on a few seconds of room silence. `r` is an Analysis.analyse()
   * result of that recording; `peakDb` is the loudest peak seen on the meter
   * (or -Infinity), used for the signal-to-noise estimate.
   */
  function noiseVerdict(r, peakDb) {
    const noiseDb = r.rms.db;   // everything in the clip is noise, so its RMS is the noise level
    const nf = r.noiseFloor;
    if (nf.blocks > 0 && nf.silentBlocks >= nf.blocks) {
      return {
        status: 'info', noiseDb, title: 'The input is completely silent',
        text: 'Not even the interface’s own hiss is coming in. Check that the right input and channel are selected and the cable is plugged in.',
        lines: [],
      };
    }
    const status = noiseDb > -50 ? 'bad' : noiseDb > -60 ? 'warn' : 'good';
    const lines = [];

    const h = r.hum;
    if (h && h.mains) {
      const humStatus = h.excessDb > 15 && (h.hits > 1 || h.levelDb > -55) ? 'bad' : 'warn';
      lines.push({
        status: humStatus,
        label: 'Mains hum',
        value: `${h.mains} Hz, ${h.excessDb.toFixed(0)} dB above its surroundings`,
        text: 'Points at a ground loop, a charger or power supply near the cables, or a dimmer. Unplug things one at a time until it stops, and try another wall socket for the interface.',
      });
    } else if (h) {
      lines.push({ status: 'good', label: 'Mains hum', value: 'none found', text: '' });
    }

    // A "loudest peak" barely above the noise is the noise itself, not a playing level.
    const known = peakDb > NO_SIGNAL_DB && peakDb > noiseDb + 10;
    const peak = known ? peakDb : TARGET.high;
    const snr = peak - noiseDb;
    const snrStatus = snr < 40 ? 'bad' : snr < 50 ? 'warn' : 'good';
    lines.push({
      status: snrStatus,
      label: 'Signal-to-noise',
      value: `${fmt(snr)} dB`,
      text: known
        ? `With your loudest peak at ${fmt(peakDb)} dBFS. 50 dB or more is good, 60 is very good.`
        : `If your loudest peaks reach ${fmt(TARGET.high)} dBFS. Play the loudest part first to use your real level. 50 dB or more is good.`,
    });

    const warnings = [];
    if (r.peak.db > -30) {
      warnings.push('Something loud happened during the check, which pushes these numbers up. Try again in silence.');
    }

    const advice = {
      good: 'Quiet enough: the background will disappear behind the music.',
      warn: 'Noticeable in quiet passages. Listen to a few seconds of this silence on headphones: fans, traffic or hiss can often be moved, closed or turned off.',
      bad: 'Loud enough to hear clearly. Find the source first — computer fan, air conditioning, the preamp at very high gain — before recording.',
    };
    return {
      status,
      noiseDb,
      title: `Noise floor ${fmt(noiseDb)} dBFS`,
      text: advice[status],
      lines,
      warnings,
    };
  }

  return { createMeter, levelStatus, encodeWav, noiseVerdict, dbfs, TARGET };
});
