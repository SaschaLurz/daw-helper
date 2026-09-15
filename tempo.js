/*
 * tempo.js — tap-tempo estimation.
 *
 * Keeps the most recent taps, throws away intervals that are clearly mis-taps
 * (far from the median), and averages the rest. A long pause starts a fresh
 * measurement, so the reading follows tempo changes instead of dragging the
 * old tempo along.
 *
 * Loaded as a plain <script> in the browser (window.Tempo) and via require()
 * in Node for the tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.Tempo = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createTapTempo(options) {
    const opts = options || {};
    const maxTaps = opts.maxTaps || 9;            // 8 intervals: precise but still quick to follow changes
    const resetMs = opts.resetMs || 2000;         // a pause at least this long starts over…
    const resetFactor = opts.resetFactor || 2.5;  // …or 2.5 beats at the current tempo, whichever is longer
    const debounceMs = opts.debounceMs || 60;     // taps closer than this are one bounced event
    const outlier = opts.outlier || 0.35;         // intervals this far off the median are ignored
    const steadyCv = opts.steadyCv || 0.04;       // coefficient of variation that counts as steady

    let taps = [];
    let state = empty();

    function empty() {
      return { bpm: 0, interval: 0, count: 0, steady: false, lastTap: -Infinity };
    }

    function tap(now) {
      const gap = now - state.lastTap;
      const limit = state.interval ? Math.max(resetMs, state.interval * resetFactor) : resetMs;
      if (gap > limit) taps = [];
      else if (gap < debounceMs) return state;

      taps.push(now);
      if (taps.length > maxTaps) taps.shift();
      state = estimate(now);
      return state;
    }

    function estimate(now) {
      const count = taps.length;
      if (count < 2) return { bpm: 0, interval: 0, count, steady: false, lastTap: now };

      const intervals = [];
      for (let i = 1; i < count; i++) intervals.push(taps[i] - taps[i - 1]);
      const med = median(intervals);
      const kept = intervals.filter((v) => Math.abs(v - med) <= outlier * med);

      const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
      let variance = 0;
      kept.forEach((v) => { variance += (v - mean) * (v - mean); });
      const cv = Math.sqrt(variance / kept.length) / mean;

      return {
        bpm: 60000 / mean,
        interval: mean,
        count,
        steady: kept.length >= 4 && cv <= steadyCv,
        lastTap: now,
      };
    }

    function reset() {
      taps = [];
      state = empty();
      return state;
    }

    return { tap, reset, get state() { return state; } };
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return { createTapTempo };
});
