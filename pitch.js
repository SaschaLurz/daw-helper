/*
 * pitch.js — pitch detection and note helpers for the tuner.
 *
 * Detection uses the McLeod Pitch Method: a normalised square difference
 * function (NSDF) is computed over the analysis window, the highest point of
 * every positive lobe is collected as a key maximum, and the first maximum
 * that comes within `keyRatio` of the tallest one is refined with parabolic
 * interpolation. Picking the *first* qualifying maximum (rather than the
 * tallest) is what keeps octave errors away on harmonically rich guitar tones.
 *
 * Loaded as a plain <script> in the browser (window.Pitch) and via require()
 * in Node for the tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.Pitch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

  /**
   * Create a detector bound to a sample rate and window size. The returned
   * `detect(samples)` reuses its scratch buffers, so call it from one place.
   */
  function createDetector(options) {
    const sampleRate = options.sampleRate;
    const size = options.bufferSize;
    const minFreq = options.minFreq || 55;
    const maxFreq = options.maxFreq || 1400;
    const keyRatio = options.keyRatio || 0.9;      // key-maximum acceptance ratio
    const minClarity = options.minClarity || 0.85; // below this the input is noise
    const minRms = options.minRms || 0.003;        // input gate, linear (≈ -50 dBFS)

    const maxLag = Math.min(size - 2, Math.ceil(sampleRate / minFreq));
    const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));

    const x = new Float32Array(size);
    const nsdf = new Float32Array(maxLag + 2);
    const energy = new Float64Array(size + 1); // prefix sums of x²
    const peaks = new Int32Array(maxLag + 2);

    function detect(input) {
      // Remove DC and measure level.
      let mean = 0;
      for (let i = 0; i < size; i++) mean += input[i];
      mean /= size;
      let sum = 0;
      for (let i = 0; i < size; i++) {
        const v = input[i] - mean;
        x[i] = v;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / size);
      if (rms < minRms) return { frequency: 0, clarity: 0, rms };

      energy[0] = 0;
      for (let i = 0; i < size; i++) energy[i + 1] = energy[i] + x[i] * x[i];

      // NSDF: 2·acf(τ) / (Σx[j]² + Σx[j+τ]²), both energy terms from prefix sums.
      for (let tau = 0; tau <= maxLag; tau++) {
        const n = size - tau;
        let acf = 0;
        for (let j = 0; j < n; j++) acf += x[j] * x[j + tau];
        const m = energy[n] + (energy[size] - energy[tau]);
        nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
      }

      // Key maxima: the peak of each positive lobe after the first zero crossing.
      let i = 1;
      while (i <= maxLag && nsdf[i] > 0) i++;
      let count = 0;
      let highest = 0;
      while (i <= maxLag) {
        while (i <= maxLag && nsdf[i] <= 0) i++;
        let bestValue = 0;
        let bestTau = -1;
        while (i <= maxLag && nsdf[i] > 0) {
          if (nsdf[i] > bestValue) {
            bestValue = nsdf[i];
            bestTau = i;
          }
          i++;
        }
        if (bestTau >= minLag && bestTau < maxLag) {
          peaks[count++] = bestTau;
          if (bestValue > highest) highest = bestValue;
        }
      }
      if (count === 0) return { frequency: 0, clarity: 0, rms };

      const cutoff = keyRatio * highest;
      let tau = peaks[0];
      for (let p = 0; p < count; p++) {
        if (nsdf[peaks[p]] >= cutoff) {
          tau = peaks[p];
          break;
        }
      }

      // Parabolic interpolation through the three samples around the peak.
      const a = nsdf[tau - 1];
      const b = nsdf[tau];
      const c = nsdf[tau + 1];
      const denom = a - 2 * b + c;
      let delta = 0;
      let clarity = b;
      if (denom < 0) {
        delta = (a - c) / (2 * denom);
        clarity = b - ((a - c) * delta) / 4;
      }
      if (clarity < minClarity) return { frequency: 0, clarity, rms };

      return { frequency: sampleRate / (tau + delta), clarity, rms };
    }

    return { detect, sampleRate, bufferSize: size };
  }

  function freqToMidi(frequency, a4) {
    return 69 + 12 * Math.log2(frequency / (a4 || 440));
  }

  function midiToFreq(midi, a4) {
    return (a4 || 440) * Math.pow(2, (midi - 69) / 12);
  }

  function noteName(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12];
  }

  function noteOctave(midi) {
    return Math.floor(midi / 12) - 1;
  }

  /** Nearest chromatic note to a frequency, and the offset from it in cents. */
  function describe(frequency, a4) {
    const exact = freqToMidi(frequency, a4);
    const midi = Math.round(exact);
    return {
      midi,
      name: noteName(midi),
      octave: noteOctave(midi),
      cents: (exact - midi) * 100,
    };
  }

  return { createDetector, freqToMidi, midiToFreq, noteName, noteOctave, describe, NOTE_NAMES };
});
