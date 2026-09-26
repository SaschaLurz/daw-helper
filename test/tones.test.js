'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Tones = require('../tones.js');

const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-6);
const hz = (midi) => Tones.midiToFreq(midi, 440);
const chord = (...midis) => Tones.identifyChord(midis);
const symbol = (...midis) => { const c = chord(...midis); return c && c.symbol; };

test('chords are named from any voicing, doubling or inversion', () => {
  assert.equal(symbol(60, 64, 67), 'C');
  assert.equal(symbol(48, 55, 60, 64, 67), 'C');              // doubled root and fifth
  assert.equal(symbol(67, 60, 64), 'C');                       // order doesn't matter, the lowest note does
  assert.equal(symbol(55, 60, 64), 'C/G');
  assert.equal(symbol(64, 67, 72), 'C/E');
  assert.equal(chord(64, 67, 72).inversion, 'first inversion');
  assert.equal(chord(55, 60, 64).inversion, 'second inversion');
  assert.equal(symbol(57, 60, 64), 'Am');
  assert.equal(symbol(55, 59, 62, 65), 'G7');
  assert.equal(symbol(60, 64, 67, 71), 'Cmaj7');
  assert.equal(symbol(59, 62, 65), 'Bdim');
  assert.equal(symbol(59, 62, 65, 69), 'Bm7♭5');
  assert.equal(symbol(48, 55, 60), 'C5');
  assert.equal(symbol(62, 67, 69), 'Dsus4');
  assert.equal(symbol(62, 64, 69), 'Dsus2');
  assert.equal(symbol(60, 64, 67, 74), 'Cadd9');
  assert.equal(symbol(48, 64, 70, 74), null);                  // C E B♭ D: a 9th without its 5th has no name here
  assert.equal(symbol(60, 62, 66), null);
  assert.equal(chord(60), null);
  assert.equal(chord(48, 60, 72), null);                       // octaves of one note
});

test('the bass decides between chords that share their notes', () => {
  assert.equal(symbol(60, 64, 67, 69), 'C6');
  assert.equal(symbol(57, 60, 64, 67), 'Am7');
  assert.equal(symbol(62, 67, 69), 'Dsus4');
  assert.equal(symbol(67, 69, 74), 'Gsus2');
  assert.equal(symbol(60, 63, 66, 69), 'Cdim7');
  assert.equal(symbol(63, 66, 69, 72), 'D♯dim7');
});

test('chords are spelled the way musicians write them', () => {
  assert.deepEqual(Tones.chordAt('minor', 0).notes, ['C', 'E♭', 'G']);
  assert.deepEqual(Tones.chordAt('major', 9).notes, ['A', 'C♯', 'E']);
  assert.deepEqual(Tones.chordAt('major', 3).notes, ['E♭', 'G', 'B♭']);
  assert.deepEqual(Tones.chordAt('major', 6).notes, ['F♯', 'A♯', 'C♯']);
  assert.deepEqual(Tones.chordAt('major', 1).notes, ['D♭', 'F', 'A♭']);
  assert.equal(Tones.chordAt('minor', 1).symbol, 'C♯m');       // minor chords take the sharp name
  assert.equal(Tones.chordAt('minor', 8).symbol, 'G♯m');
  assert.deepEqual(Tones.chordAt('minor', 8).notes, ['G♯', 'B', 'D♯']);
  assert.deepEqual(Tones.chordAt('7', 7).notes, ['G', 'B', 'D', 'F']);
  assert.deepEqual(Tones.chordAt('m7b5', 11).notes, ['B', 'D', 'F', 'A']);
  assert.deepEqual(Tones.chordAt('9', 7).notes, ['G', 'B', 'D', 'F', 'A']);
  // Every note on its own letter, E♯ and C♭ included…
  assert.deepEqual(Tones.chordAt('7', 1).notes, ['D♭', 'F', 'A♭', 'C♭']);
  assert.deepEqual(Tones.chordAt('maj7', 6).notes, ['F♯', 'A♯', 'C♯', 'E♯']);
  assert.deepEqual(Tones.chordAt('aug', 4).notes, ['E', 'G♯', 'B♯']);
  // …but no double flats or sharps: the root's other name if that avoids them, else the plain name.
  assert.equal(Tones.chordAt('dim7', 3).symbol, 'D♯dim7');
  assert.deepEqual(Tones.chordAt('dim7', 3).notes, ['D♯', 'F♯', 'A', 'C']);
  assert.equal(Tones.chordAt('aug', 6).symbol, 'G♭aug');
  assert.deepEqual(Tones.chordAt('aug', 6).notes, ['G♭', 'B♭', 'D']);
  assert.deepEqual(Tones.chordAt('dim7', 0).notes, ['C', 'E♭', 'G♭', 'A']);
  assert.equal(Tones.chordAt('major', 1).symbol, 'D♭');         // the usual name when both spell cleanly
  assert.equal(Tones.chordAt('major', 6).symbol, 'F♯');
  // C♭ and B♯ are written an octave off their key's number.
  assert.equal(Tones.writtenOctave('C♭', 71), 5);
  assert.equal(Tones.writtenOctave('B♯', 60), 3);
  assert.equal(Tones.writtenOctave('E♯', 65), 4);
  assert.equal(Tones.chordAt('m7', 0).name, 'C minor 7th');
  const c = chord(51, 55, 60);                                 // E♭ G C: C minor over its third
  assert.equal(c.symbol, 'Cm/E♭');
  assert.equal(c.roles[3], 'Minor 3rd');
  assert.equal(c.roles[0], 'Root');
  assert.equal(chord(60, 63, 66).roles[6], 'Flat 5th');
});

test('two notes are spelled as their interval', () => {
  assert.deepEqual(Tones.spellInterval(60, 63), ['C', 'E♭']);
  assert.deepEqual(Tones.spellInterval(60, 64), ['C', 'E']);
  assert.deepEqual(Tones.spellInterval(62, 66), ['D', 'F♯']);
  assert.deepEqual(Tones.spellInterval(60, 66), ['C', 'F♯']);
  assert.deepEqual(Tones.spellInterval(66, 72), ['F♯', 'C']);   // a tritone reads as a 5th rather than B♯…
  assert.deepEqual(Tones.spellInterval(71, 77), ['B', 'F']);    // …or E♯
  assert.deepEqual(Tones.spellInterval(63, 70), ['E♭', 'B♭']);
  assert.deepEqual(Tones.spellInterval(66, 77), ['F♯', 'E♯']);  // other intervals keep their letter
});

test('every chord preset is well formed and uniquely named', () => {
  const ids = new Set();
  const symbols = new Set();
  for (const c of Tones.CHORDS) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    assert.ok(!symbols.has(c.suffix), `duplicate suffix ${c.suffix}`);
    ids.add(c.id);
    symbols.add(c.suffix);
    assert.equal(c.intervals.length, c.degrees.length, c.id);
    assert.ok(c.intervals.length <= Tones.MAX_VOICES, c.id);
    assert.ok(c.text && c.group, c.id);
    // Loaded on any root, each chord is recognised as itself.
    for (let root = 0; root < 12; root++) {
      const found = Tones.identifyChord(Tones.chordNotes(c.id, 60 + root));
      assert.equal(found && found.symbol, Tones.chordAt(c.id, root).symbol, `${c.id} on ${root}`);
    }
  }
});

test('intervals are named, measured against their pure ratio and matched to a tune', () => {
  const fifth = Tones.describeInterval(440, hz(76));
  assert.equal(fifth.name, 'Perfect 5th');
  assert.equal(fifth.semitones, 7);
  assert.equal(fifth.ratio, '3:2');
  assert.ok(near(fifth.offPure, -1.955, 0.001));                // the piano's fifth is 2 ¢ narrow
  assert.match(fifth.song, /Twinkle/);

  const pure = Tones.describeInterval(440, 660);
  assert.ok(near(pure.offPure, 0));
  const third = Tones.describeInterval(hz(60), hz(64));
  assert.equal(third.ratio, '5:4');
  assert.ok(near(third.offPure, 13.686, 0.001));

  assert.equal(Tones.describeInterval(hz(48), hz(67)).name, 'Perfect 5th + octave');
  assert.equal(Tones.describeInterval(hz(48), hz(67)).ratio, '3:1');
  assert.equal(Tones.describeInterval(hz(36), hz(64)).name, 'Major 3rd + 2 octaves');
  assert.equal(Tones.describeInterval(hz(36), hz(60)).name, '2 octaves');
  assert.equal(Tones.describeInterval(220, 440).name, 'Octave');
  assert.equal(Tones.describeInterval(440, 443).name, 'Unison');
  assert.equal(Tones.describeInterval(hz(60), hz(66)).ratio, null);  // the tritone has no simple pure form
  assert.equal(Tones.describeInterval(hz(60), hz(71)).song, null);
  assert.equal(Tones.describeInterval(hz(48), hz(67)).song, null);   // tunes are for intervals within an octave
  assert.equal(Tones.describeInterval(660, 440).semitones, 7);       // order doesn't matter
  Tones.INTERVALS.forEach((iv, semis) => assert.equal(iv.semis, semis));
});

test('typed tones: frequencies and notes, with a sentence when it is neither', () => {
  assert.equal(Tones.parseTone('440', 440).hz, 440);
  assert.equal(Tones.parseTone(' 261,6 ', 440).hz, 261.6);
  assert.equal(Tones.parseTone('440 Hz', 440).hz, 440);
  assert.equal(Tones.parseTone('1.5kHz', 440).hz, 1500);
  assert.equal(Tones.parseTone('2k', 440).hz, 2000);
  assert.equal(Tones.parseTone('A4', 440).hz, 440);
  assert.equal(Tones.parseTone('a4', 432).hz, 432);
  assert.ok(near(Tones.parseTone('Eb2', 440).hz, 77.782, 0.001));
  assert.ok(near(Tones.parseTone('F#3', 440).hz, 184.997, 0.001));
  assert.match(Tones.parseTone('10', 440).error, /20 Hz to 20 kHz/);
  assert.match(Tones.parseTone('25k', 440).error, /20 Hz to 20 kHz/);
  assert.match(Tones.parseTone('C0', 440).error, /20 Hz to 20 kHz/);
  for (const bad of ['', 'abc', 'H2', '4 40', '-440']) assert.match(Tones.parseTone(bad, 440).error, /Type a frequency/, bad);
});

test('stepping goes to the next note, snapping a tone that sits between notes', () => {
  assert.ok(near(Tones.stepNote(440, 1, 440), hz(70)));
  assert.ok(near(Tones.stepNote(440, -1, 440), hz(68)));
  assert.ok(near(Tones.stepNote(450, -1, 440), 440));        // +39 ¢ above A4: down lands on A4
  assert.ok(near(Tones.stepNote(450, 1, 440), hz(70)));
  assert.ok(near(Tones.stepNote(430, 1, 440), 440));
  assert.ok(near(Tones.stepNote(439.9, 1, 440), hz(70)));    // within a cent counts as the note itself
  assert.ok(near(Tones.stepNote(432, 1, 432), Tones.midiToFreq(70, 432)));
  assert.equal(Tones.stepNote(20.5, -1, 440), null);
  assert.equal(Tones.stepNote(19950, 1, 440), null);
});

test('the frequency slider is logarithmic and round-trips', () => {
  assert.ok(near(Tones.sliderToFreq(0), 20));
  assert.ok(near(Tones.sliderToFreq(Tones.SLIDER_STEPS), 20000, 1e-6));
  assert.ok(near(Tones.sliderToFreq(500), Math.sqrt(20 * 20000)));
  for (const f of [20, 41.2, 440, 1000, 20000]) assert.ok(Math.abs(Tones.sliderToFreq(Tones.freqToSlider(f)) / f - 1) < 0.004, f);
  assert.equal(Tones.tidyFreq(437.3), 437);
  assert.equal(Tones.tidyFreq(41.23), 41.2);
});

test('beating is the smallest difference between close tones', () => {
  assert.equal(Tones.beatRate([440, 443]), 3);
  assert.ok(near(Tones.beatRate([440, 660, 441.5]), 1.5));
  assert.equal(Tones.beatRate([440, 660]), 0);
  assert.equal(Tones.beatRate([440, 440]), 0);               // a perfect unison doesn't beat
  assert.equal(Tones.beatRate([246.94, 261.63]), 0);         // B3 and C4: 15 Hz apart, but a semitone, not a mistuned note
  assert.ok(near(Tones.beatRate([41.2, 41.7]), 0.5));        // a low E a hair sharp still beats
  assert.equal(Tones.beatRate([440]), 0);
});

test('experiments follow A4, stay in range and fit the tone limit', () => {
  const beating = Tones.experimentVoices('beating', 440);
  assert.equal(beating[1].freq - beating[0].freq, 3);
  assert.equal(Tones.experimentVoices('beating', 432)[0].freq, 432);
  const third = Tones.experimentVoices('pure-third', 440);
  assert.ok(near(third[1].freq, 550));
  assert.equal(third[2].on, false);
  const series = Tones.experimentVoices('harmonics', 440);
  assert.deepEqual(series.map((v) => Math.round(v.freq)), [110, 220, 330, 440, 550, 660, 770, 880]);
  assert.equal(series[1].gain, 0.5);
  const missing = Tones.experimentVoices('missing-fundamental', 440);
  assert.equal(missing[0].on, false);
  assert.ok(near(missing[1].freq / missing[0].freq, 2));
  const ids = new Set();
  for (const e of Tones.EXPERIMENTS) {
    assert.ok(!ids.has(e.id), e.id);
    ids.add(e.id);
    assert.ok(Tones.WAVES.some((w) => w.id === e.wave), e.id);
    const voices = Tones.experimentVoices(e.id, 440);
    assert.ok(voices.length >= 2 && voices.length <= Tones.MAX_VOICES, e.id);
    voices.forEach((v) => assert.ok(v.freq >= Tones.MIN_HZ && v.freq <= Tones.MAX_HZ, e.id));
  }
  assert.deepEqual(Tones.experimentVoices('nope', 440), []);
});

test('waves are shaped like the browser’s oscillators and never exceed full scale', () => {
  assert.ok(near(Tones.waveSample('sine', 0.25), 1));
  assert.equal(Tones.waveSample('square', 0.1), 1);
  assert.equal(Tones.waveSample('square', 0.6), -1);
  assert.ok(near(Tones.waveSample('sawtooth', 0.25), 0.5));
  assert.ok(near(Tones.waveSample('sawtooth', 0.75), -0.5));
  assert.ok(near(Tones.waveSample('triangle', 0.25), 1));
  assert.ok(near(Tones.waveSample('triangle', 0.75), -1));
  assert.ok(near(Tones.waveSample('triangle', 1.25), 1));    // phases wrap
  let peak = 0;
  for (let i = 0; i < 1000; i++) peak = Math.max(peak, Math.abs(Tones.waveSample('soft', i / 1000)));
  assert.ok(peak <= 1 + 1e-9 && peak > 0.99);

  // Eight full-level square waves in phase: the mix still peaks at full scale.
  const voices = Array.from({ length: 8 }, (_, i) => ({ freq: 100 * (i + 1), gain: 1 }));
  assert.ok(near(Tones.mixSample(voices, 'square', 0.0001), 1));
  // Quiet tones are not turned up.
  assert.ok(near(Tones.mixSample([{ freq: 250, gain: 0.5 }], 'sine', 0.001), 0.5));
});

test('stored settings are repaired rather than trusted', () => {
  const sounds = ['soft', 'sine', 'square', 'piano'];
  const fresh = Tones.normaliseState(undefined, sounds);
  assert.deepEqual(fresh.voices, [{ freq: 440, gain: 1, on: true }]);
  assert.equal(fresh.sound, 'soft');
  const kept = Tones.normaliseState({ voices: [], sound: 'piano', volume: 0.3, root: 9, octave: 2, keys: 1 }, sounds);
  assert.deepEqual(kept, { voices: [], sound: 'piano', volume: 0.3, root: 9, octave: 2, keys: 1 });
  assert.equal(Tones.normaliseState({ wave: 'square' }, sounds).sound, 'square');   // stored before sounds had presets
  const repaired = Tones.normaliseState({
    voices: [{ freq: 5 }, null, { freq: 'x' }, { freq: 300, gain: 7, on: false }, ...Array(10).fill({ freq: 220 })],
    sound: 'noise', volume: 'loud', root: 12, octave: 0, keys: 2.5,
  }, sounds);
  assert.deepEqual(repaired.voices[0], { freq: 300, gain: 1, on: false });
  assert.equal(repaired.voices.length, Tones.MAX_VOICES);
  assert.deepEqual([repaired.sound, repaired.volume, repaired.root, repaired.octave, repaired.keys], ['soft', 0.75, 0, 4, 3]);
});
