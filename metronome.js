/*
 * metronome.js — the metronome's timing, without any sound.
 *
 * A clock that hands out ticks (beats and their subdivisions) with exact
 * times, so the page can schedule them on the Web Audio clock a little ahead
 * of time. Tempo and pattern changes take effect from the next beat, which
 * keeps every beat on the grid. An optional count-in plays whole bars of plain
 * beats before the pattern starts.
 *
 * Loaded as a plain <script> in the browser (window.Metronome) and via
 * require() in Node for the tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.Metronome = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SUBDIVISIONS = [1, 2, 3, 4];   // quarters, eighths, triplets, sixteenths
  const COUNT_IN_BEATS_UNACCENTED = 4; // count-in bar length when there is no bar

  /**
   * options: bpm, beats (per bar; 1 means no accent), subdivision (1–4),
   * countIn (bars). Times are in seconds, on whatever clock start() is given.
   */
  function createClock(options) {
    let opts = normalise(options || {});
    let running = false;
    let beatStart = 0;   // time of the current beat
    let beatLength = 0;  // its length, fixed when its first tick is handed out
    let subs = 1;        // its subdivision, likewise
    let sub = 0;         // next tick within the beat
    let beat = 0;        // beat within the bar
    let bar = 0;
    let countIn = 0;     // count-in beats left, the current one included

    function set(changes) {
      opts = normalise(Object.assign({}, opts, changes));
    }

    function start(time) {
      running = true;
      beatStart = time;
      sub = 0;
      beat = 0;
      bar = 0;
      countIn = opts.countIn * countInBar();
    }

    function stop() {
      running = false;
    }

    /** Every tick due before `until`, in order; later calls carry on from there. */
    function ticksUntil(until) {
      const out = [];
      while (running && nextTime() < until) {
        if (sub === 0) {
          beatLength = 60 / opts.bpm;
          subs = countIn > 0 ? 1 : opts.subdivision;
        }
        out.push(current());
        advance();
      }
      return out;
    }

    function countInBar() {
      return opts.beats > 1 ? opts.beats : COUNT_IN_BEATS_UNACCENTED;
    }

    function nextTime() {
      return sub === 0 ? beatStart : beatStart + (sub * beatLength) / subs;
    }

    function current() {
      let accent = 'beat';
      if (sub > 0) accent = 'sub';
      else if (beat === 0 && opts.beats > 1) accent = 'bar';
      return { time: nextTime(), beatLength, bar, beat, sub, accent, countIn };
    }

    function advance() {
      sub++;
      if (sub < subs) return;
      sub = 0;
      beatStart += beatLength;
      beat++;
      if (countIn > 0) {
        countIn--;
        if (beat >= countInBar() || countIn === 0) beat = 0;  // the pattern starts on a bar line
      } else if (beat >= opts.beats) {
        beat = 0;
        bar++;
      }
    }

    return {
      set,
      start,
      stop,
      ticksUntil,
      get running() { return running; },
      get options() { return Object.assign({}, opts); },
    };
  }

  function normalise(o) {
    const int = (v, lo, hi, fallback) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    return {
      bpm: Number(o.bpm) > 0 ? Number(o.bpm) : 120,
      beats: int(o.beats, 1, 12, 4),
      subdivision: SUBDIVISIONS.includes(Number(o.subdivision)) ? Number(o.subdivision) : 1,
      countIn: int(o.countIn, 0, 4, 0),
    };
  }

  return { createClock, SUBDIVISIONS };
});
