'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Metronome = require('../metronome.js');

const near = (a, b) => Math.abs(a - b) < 1e-9;
const times = (ticks) => ticks.map((t) => Number(t.time.toFixed(6)));
const accents = (ticks) => ticks.map((t) => t.accent);

test('quarter notes at 120 bpm land every half second with the bar accented', () => {
  const clock = Metronome.createClock({ bpm: 120, beats: 4 });
  clock.start(10);
  const ticks = clock.ticksUntil(12.4);
  assert.deepEqual(times(ticks), [10, 10.5, 11, 11.5, 12]);
  assert.deepEqual(accents(ticks), ['bar', 'beat', 'beat', 'beat', 'bar']);
  assert.deepEqual(ticks.map((t) => t.bar), [0, 0, 0, 0, 1]);
  assert.ok(near(ticks[0].beatLength, 0.5));
});

test('successive calls carry on without repeating or skipping a tick', () => {
  const clock = Metronome.createClock({ bpm: 120, beats: 3 });
  clock.start(0);
  const a = clock.ticksUntil(1.2);
  const b = clock.ticksUntil(1.2);
  const c = clock.ticksUntil(2.1);
  assert.deepEqual(times(a), [0, 0.5, 1]);
  assert.deepEqual(b, []);
  assert.deepEqual(times(c), [1.5, 2]);
  assert.deepEqual(accents(a.concat(c)), ['bar', 'beat', 'beat', 'bar', 'beat']);
});

test('subdivisions split each beat evenly and are marked as such', () => {
  const eighths = Metronome.createClock({ bpm: 120, beats: 2, subdivision: 2 });
  eighths.start(0);
  const e = eighths.ticksUntil(1);
  assert.deepEqual(times(e), [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(accents(e), ['bar', 'sub', 'beat', 'sub']);

  const triplets = Metronome.createClock({ bpm: 60, beats: 4, subdivision: 3 });
  triplets.start(0);
  assert.deepEqual(times(triplets.ticksUntil(1)), [0, 0.333333, 0.666667]);

  const sixteenths = Metronome.createClock({ bpm: 60, subdivision: 4 });
  sixteenths.start(0);
  assert.deepEqual(times(sixteenths.ticksUntil(1)), [0, 0.25, 0.5, 0.75]);
});

test('one beat per bar means no accent', () => {
  const clock = Metronome.createClock({ bpm: 120, beats: 1 });
  clock.start(0);
  assert.deepEqual(accents(clock.ticksUntil(2)), ['beat', 'beat', 'beat', 'beat']);
});

test('a tempo change takes effect from the next beat, keeping the current one on the grid', () => {
  const clock = Metronome.createClock({ bpm: 120, subdivision: 2 });
  clock.start(0);
  assert.deepEqual(times(clock.ticksUntil(0.3)), [0, 0.25]);
  clock.set({ bpm: 60 });
  // The beat that started at 0 is still 0.5 s long; from 0.5 on, beats are 1 s.
  assert.deepEqual(times(clock.ticksUntil(1.6)), [0.5, 1, 1.5]);
});

test('a smaller subdivision or bar mid-way does not break the pattern', () => {
  const clock = Metronome.createClock({ bpm: 60, beats: 4, subdivision: 4 });
  clock.start(0);
  clock.ticksUntil(2.3);            // well into beat 3, at its second sixteenth
  clock.set({ subdivision: 1, beats: 2 });
  const ticks = clock.ticksUntil(4.1);
  // The rest of beat 3 keeps its sixteenths; then quarters in a two-beat bar.
  assert.deepEqual(times(ticks), [2.5, 2.75, 3, 4]);
  assert.deepEqual(accents(ticks), ['sub', 'sub', 'bar', 'beat']);
});

test('a count-in plays plain beats, counts down and starts the pattern on a bar line', () => {
  const clock = Metronome.createClock({ bpm: 120, beats: 3, subdivision: 2, countIn: 1 });
  clock.start(0);
  const ticks = clock.ticksUntil(2.2);
  assert.deepEqual(times(ticks), [0, 0.5, 1, 1.5, 1.75, 2]);
  assert.deepEqual(ticks.map((t) => t.countIn), [3, 2, 1, 0, 0, 0]);
  assert.deepEqual(accents(ticks), ['bar', 'beat', 'beat', 'bar', 'sub', 'beat']);
  assert.deepEqual(ticks.map((t) => t.bar), [0, 0, 0, 0, 0, 0]);
});

test('without a bar, a count-in is four beats per bar', () => {
  const clock = Metronome.createClock({ bpm: 60, beats: 1, countIn: 2 });
  clock.start(0);
  const ticks = clock.ticksUntil(9);
  assert.deepEqual(ticks.map((t) => t.countIn), [8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test('stop ends the ticks and start begins afresh', () => {
  const clock = Metronome.createClock({ bpm: 120, beats: 4 });
  clock.start(0);
  clock.ticksUntil(0.8);
  clock.stop();
  assert.equal(clock.running, false);
  assert.deepEqual(clock.ticksUntil(5), []);
  clock.start(7);
  const ticks = clock.ticksUntil(7.1);
  assert.deepEqual(times(ticks), [7]);
  assert.equal(ticks[0].accent, 'bar');
});

test('options are kept in range', () => {
  const clock = Metronome.createClock({ bpm: -5, beats: 40, subdivision: 5, countIn: 'x' });
  assert.deepEqual(clock.options, { bpm: 120, beats: 12, subdivision: 1, countIn: 0 });
});
