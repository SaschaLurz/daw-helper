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
 * The autocorrelation behind the NSDF is computed for every lag at once with
 * an FFT, so long windows and low notes (a bass's low B needs lags past 1500
 * samples) cost little more than a guitar's.
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
    // Zero-padding to twice the window turns the FFT's circular correlation into a linear one.
    const fftSize = nextPow2(2 * size);
    const fft = createFft(fftSize);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);

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

      // acf(τ) = Σ x[j]·x[j+τ] for all τ: the inverse transform of the power
      // spectrum. That spectrum is real and even, so a forward FFT inverts it
      // too (up to a factor of fftSize).
      re.fill(0);
      im.fill(0);
      re.set(x);
      fft(re, im);
      for (let k = 0; k < fftSize; k++) {
        re[k] = re[k] * re[k] + im[k] * im[k];
        im[k] = 0;
      }
      fft(re, im);

      // NSDF: 2·acf(τ) / (Σx[j]² + Σx[j+τ]²), both energy terms from prefix sums.
      for (let tau = 0; tau <= maxLag; tau++) {
        const n = size - tau;
        const acf = re[tau] / fftSize;
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

  function nextPow2(v) {
    let n = 1;
    while (n < v) n *= 2;
    return n;
  }

  /** In-place radix-2 forward FFT of length n (a power of two) on separate real/imaginary arrays. */
  function createFft(n) {
    const bits = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let len = 2; len <= n; len *= 2) {
        const half = len / 2;
        const step = n / len;
        for (let start = 0; start < n; start += len) {
          for (let j = start, k = 0; j < start + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = im[l] * cos[k] - re[l] * sin[k];
            re[l] = re[j] - tre;
            im[l] = im[j] - tim;
            re[j] += tre;
            im[j] += tim;
          }
        }
      }
    };
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
