'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Tempo = require('../tempo.js');

// Feed evenly spaced taps (optionally jittered) and return the final state.
function tapSeries(tt, bpm, count, start = 0, jitter = 0, seed = 1) {
  const interval = 60000 / bpm;
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  let t = start;
  let state;
  for (let i = 0; i < count; i++) {
    state = tt.tap(t + (i ? jitter * rand() : 0));
    t += interval;
  }
  return { state, next: t };
}

test('a steady beat is measured exactly', () => {
  const tt = Tempo.createTapTempo();
  const { state } = tapSeries(tt, 120, 8);
  assert.equal(Math.round(state.bpm), 120);
  assert.equal(state.count, 8);
  assert.equal(state.steady, true);
});

test('one tap is not enough for a reading', () => {
  const tt = Tempo.createTapTempo();
  const state = tt.tap(1000);
  assert.equal(state.bpm, 0);
  assert.equal(state.count, 1);
});

test('human jitter still gives a close, steady reading', () => {
  const tt = Tempo.createTapTempo();
  const { state } = tapSeries(tt, 100, 12, 0, 30);
  assert.ok(Math.abs(state.bpm - 100) < 2, `got ${state.bpm}`);
  assert.equal(state.steady, true);
});

test('a single mis-tap is ignored', () => {
  const tt = Tempo.createTapTempo();
  const { next } = tapSeries(tt, 120, 5);
  tt.tap(next - 320);            // stray early tap, then back on the grid
  const { state } = tapSeries(tt, 120, 3, next);
  assert.ok(Math.abs(state.bpm - 120) < 1, `got ${state.bpm}`);
});

test('a pause starts a fresh measurement', () => {
  const tt = Tempo.createTapTempo();
  const { next } = tapSeries(tt, 120, 8);
  const first = tt.tap(next + 5000);
  assert.equal(first.bpm, 0);
  assert.equal(first.count, 1);
  const { state } = tapSeries(tt, 90, 6, next + 5000 + 60000 / 90);
  assert.ok(Math.abs(state.bpm - 90) < 0.5, `got ${state.bpm}`);
});

test('a slow beat is not mistaken for a pause', () => {
  const tt = Tempo.createTapTempo();
  const { state } = tapSeries(tt, 40, 6);   // 1.5 s between taps stays under the 2 s reset
  assert.equal(Math.round(state.bpm), 40);
  assert.equal(state.count, 6);
});

test('the reading follows a tempo change without a pause', () => {
  const tt = Tempo.createTapTempo();
  const { next } = tapSeries(tt, 120, 8);
  const { state } = tapSeries(tt, 80, 10, next);
  assert.ok(Math.abs(state.bpm - 80) < 1, `got ${state.bpm}`);
});

test('bounced double events are dropped', () => {
  const tt = Tempo.createTapTempo();
  tt.tap(0); tt.tap(20);          // second event 20 ms later is a bounce
  tt.tap(500); tt.tap(1000);
  assert.equal(tt.state.count, 3);
  assert.equal(Math.round(tt.state.bpm), 120);
});

test('reset clears everything', () => {
  const tt = Tempo.createTapTempo();
  tapSeries(tt, 120, 4);
  const state = tt.reset();
  assert.equal(state.bpm, 0);
  assert.equal(state.count, 0);
});

test('note lengths at 120 bpm match the usual delay chart', () => {
  const rows = Object.fromEntries(Tempo.noteLengths(120).map((r) => [r.label, r]));
  assert.deepEqual(Object.keys(rows), ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32']);
  assert.equal(rows['1/4'].straight, 500);
  assert.equal(rows['1/4'].dotted, 750);
  assert.ok(Math.abs(rows['1/4'].triplet - 333.333) < 0.001);
  assert.equal(rows['1/1'].straight, 2000);
  assert.equal(rows['1/8'].dotted, 375);
  assert.equal(rows['1/16'].straight, 125);
  assert.equal(1000 / rows['1/4'].straight, 2);   // LFO synced to quarters: 2 Hz
});

test('note lengths scale inversely with tempo', () => {
  const slow = Tempo.noteLengths(60);
  const fast = Tempo.noteLengths(180);
  slow.forEach((row, i) => assert.ok(Math.abs(row.straight - 3 * fast[i].straight) < 1e-9));
});

test('typed tempos accept a decimal comma and stay in range', () => {
  assert.equal(Tempo.parseBpm('120'), 120);
  assert.equal(Tempo.parseBpm(' 98,5 '), 98.5);
  assert.equal(Tempo.parseBpm('120.46'), 120.5);
  assert.equal(Tempo.parseBpm('1000'), Tempo.MAX_BPM);
  assert.equal(Tempo.parseBpm('5'), Tempo.MIN_BPM);
  assert.ok(Number.isNaN(Tempo.parseBpm('')));
  assert.ok(Number.isNaN(Tempo.parseBpm('fast')));
  assert.ok(Number.isNaN(Tempo.parseBpm('-80')));
  assert.equal(Tempo.clampBpm(119.96), 120);
});
