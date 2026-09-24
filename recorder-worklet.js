/*
 * recorder-worklet.js — AudioWorklet that sees every input sample.
 *
 * About 30 times a second it posts { type: 'meter', peak, sumSq, clips,
 * frames } per channel, so the meter never misses a peak between screen
 * frames. While recording ({ type: 'record', on: true } from the page) it also
 * posts the raw samples in ≈ 100 ms chunks ({ type: 'chunk', channels }), and
 * after { type: 'record', on: false } the rest followed by { type: 'stopped' }.
 */
'use strict';

const CLIP_LEVEL = 0.999;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.meterFrames = Math.round(sampleRate / 30);
    this.chunkFrames = Math.round(sampleRate / 10);
    this.resetMeter(0);
    this.recording = false;
    this.chunk = null;
    this.fill = 0;
    this.port.onmessage = (e) => {
      if (e.data.type !== 'record') return;
      if (e.data.on) {
        this.recording = true;
        this.chunk = null;
        this.fill = 0;
      } else if (this.recording) {
        this.recording = false;
        this.flush();
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  resetMeter(channels) {
    this.peak = new Array(channels).fill(0);
    this.sumSq = new Array(channels).fill(0);
    this.clips = new Array(channels).fill(false);
    this.frames = 0;
  }

  flush() {
    if (this.chunk && this.fill) {
      const channels = this.chunk.map((c) => c.slice(0, this.fill));
      this.port.postMessage({ type: 'chunk', channels }, channels.map((c) => c.buffer));
    }
    this.chunk = null;
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const count = input.length;
    if (!count) return true;
    const n = input[0].length;

    if (this.peak.length !== count) this.resetMeter(count);
    for (let c = 0; c < count; c++) {
      const x = input[c];
      let peak = this.peak[c];
      let sq = 0;
      for (let i = 0; i < n; i++) {
        const v = x[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sq += v * v;
      }
      this.peak[c] = peak;
      this.sumSq[c] += sq;
      if (peak >= CLIP_LEVEL) this.clips[c] = true;
    }
    this.frames += n;
    if (this.frames >= this.meterFrames) {
      this.port.postMessage({ type: 'meter', peak: this.peak, sumSq: this.sumSq, clips: this.clips, frames: this.frames });
      this.resetMeter(count);
    }

    if (this.recording) {
      if (this.chunk && this.chunk.length !== count) this.flush();   // the input changed shape
      for (let offset = 0; offset < n;) {
        if (!this.chunk) this.chunk = Array.from({ length: count }, () => new Float32Array(this.chunkFrames));
        const take = Math.min(n - offset, this.chunkFrames - this.fill);
        for (let c = 0; c < count; c++) this.chunk[c].set(input[c].subarray(offset, offset + take), this.fill);
        this.fill += take;
        offset += take;
        if (this.fill === this.chunkFrames) this.flush();
      }
    }
    return true;
  }
}

registerProcessor('capture', Capture);
