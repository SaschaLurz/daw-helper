/*
 * analysis-worker.js — runs Analysis.analyse() off the main thread.
 *
 * Receives { channels: Float32Array[], sampleRate }, posts
 * { type: 'progress', fraction, stage } along the way and finally
 * { type: 'result', result } or { type: 'error', message }.
 */
'use strict';
importScripts('pitch.js', 'analysis.js');

self.onmessage = (e) => {
  const { channels, sampleRate } = e.data;
  let lastPost = 0;
  try {
    const result = Analysis.analyse(channels, sampleRate, {}, (fraction, stage) => {
      const now = Date.now();
      if (now - lastPost < 40 && fraction < 1) return;
      lastPost = now;
      self.postMessage({ type: 'progress', fraction, stage });
    });
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
