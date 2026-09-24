'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Tunings = require('../tunings.js');

const midi = (text) => Tunings.parseNote(text).midi;
const byId = (id) => Tunings.build(Tunings.PRESETS.find((p) => p.id === id));
const notesOf = (id) => byId(id).targets.map((t) => t.midi);

test('notes are read the way players write them', () => {
  assert.equal(midi('E2'), 40);
  assert.equal(midi('A4'), 69);
  assert.equal(midi('F#3'), 54);
  assert.equal(midi('F♯3'), 54);
  assert.equal(midi('Gb3'), 54);
  assert.equal(midi('G♭3'), 54);
  assert.equal(midi('Bb1'), 34);
  assert.equal(midi('b3'), 59);        // lower case, as in banjo notation
  assert.equal(midi('bb3'), 58);
  assert.equal(midi('B#3'), 60);       // enharmonics land where they should
  assert.equal(midi('Cb4'), 59);
  assert.equal(Tunings.parseNote('F#3').accidental, 'sharp');
  assert.equal(Tunings.parseNote('Bb1').accidental, 'flat');
  for (const bad of ['H2', 'E', 'Eb', 'E#', '2E', 'E22', 'Ex3', '']) assert.equal(Tunings.parseNote(bad), null, bad);
});

test('a 12-string reads as six courses with octave partners; unison pairs count once', () => {
  const t = Tunings.parseTuning('E2/E3 A2/A3 D3/D4 G3/G4 B3/B3 E4/E4');
  assert.deepEqual(t.courses, [[40, 52], [45, 57], [50, 62], [55, 67], [59], [64]]);
  const built = byId('twelve');
  assert.equal(built.courses.length, 6);
  assert.equal(built.targets.length, 10);
  assert.deepEqual(built.targets.slice(0, 2), [{ midi: 40, course: 0, main: true }, { midi: 52, course: 0, main: false }]);
});

test('commas, extra spaces and mixed case are fine', () => {
  assert.deepEqual(Tunings.parseTuning('  d2, a2  d3 f#3,a3 d4 ').courses, [[38], [45], [50], [54], [57], [62]]);
});

test('a tuning written with flats is shown with flats', () => {
  assert.equal(Tunings.parseTuning('Eb2 Ab2 Db3 Gb3 Bb3 Eb4').flats, true);
  assert.equal(Tunings.parseTuning('D2 A2 D3 F#3 A3 D4').flats, false);
  assert.equal(Tunings.parseTuning('E2 A2 D3').flats, false);
  assert.equal(Tunings.noteLabel(39, true), 'E♭2');
  assert.equal(Tunings.noteLabel(39, false), 'D♯2');
  assert.equal(Tunings.courseLabel([40, 52], false), 'E2/E3');
  assert.equal(byId('eb').flats, true);
  assert.equal(byId('bass-eb').flats, true);
});

test('mistakes get a sentence that says what to fix', () => {
  assert.match(Tunings.parseTuning('').error, /Type the strings as notes/);
  assert.match(Tunings.parseTuning('E2 H2 D3').error, /“H2” isn’t a note/);
  assert.match(Tunings.parseTuning('E2 A').error, /“A” isn’t a note/);
  assert.match(Tunings.parseTuning('G0 E1').error, /G0 is outside .* \(A0 to E6\)/);
  assert.match(Tunings.parseTuning('E2 C7').error, /C7 is outside/);
  assert.match(Tunings.parseTuning('E2 A2 D3 G3 B3 E4 E2 A2 D3 G3 B3 E4 E2').error, /13 strings; the tuner shows up to 12/);
  assert.match(Tunings.parseTuning('G2/G3/G4/G5').error, /up to 3 strings/);
  assert.equal(Tunings.build({ id: 'x', name: 'x', strings: 'nope' }), null);
});

test('every preset is valid, in range, and has a unique id and name', () => {
  const ids = new Set();
  const names = new Set();
  for (const p of Tunings.PRESETS) {
    const t = Tunings.build(p);
    assert.ok(t, `${p.id} does not parse`);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    // The closed menu shows only the name, so it must identify the tuning on its own.
    assert.ok(!names.has(p.name), `duplicate name ${p.name}`);
    ids.add(p.id);
    names.add(p.name);
    t.targets.forEach((x) => assert.ok(x.midi >= Tunings.LOWEST && x.midi <= Tunings.HIGHEST, `${p.id}: ${x.midi}`));
    assert.ok(t.courses.length <= Tunings.MAX_COURSES);
  }
  const groups = Array.from(new Set(Tunings.PRESETS.map((p) => p.group)));
  assert.deepEqual(groups, ['Guitar', '12-string', 'Bass', 'Ukulele', 'Banjo', 'Mandolin', 'Violin family', 'Other']);
});

test('tunings that existed before keep their ids and notes', () => {
  const before = {
    standard: [40, 45, 50, 55, 59, 64], 'drop-d': [38, 45, 50, 55, 59, 64], eb: [39, 44, 49, 54, 58, 63],
    d: [38, 43, 48, 53, 57, 62], 'drop-c': [36, 43, 48, 53, 57, 62], dadgad: [38, 45, 50, 55, 57, 62],
    'open-g': [38, 43, 50, 55, 59, 62], seven: [35, 40, 45, 50, 55, 59, 64], eight: [30, 35, 40, 45, 50, 55, 59, 64],
    bass: [28, 33, 38, 43], 'bass-drop-d': [26, 33, 38, 43], 'bass-eb': [27, 32, 37, 42],
    'bass-5': [23, 28, 33, 38, 43], 'bass-6': [23, 28, 33, 38, 43, 48],
    ukulele: [67, 60, 64, 69], 'ukulele-low-g': [55, 60, 64, 69], 'ukulele-baritone': [50, 55, 59, 64], mandolin: [55, 62, 69, 76],
  };
  for (const [id, notes] of Object.entries(before)) assert.deepEqual(notesOf(id), notes, id);
});

test('a few instruments, spot-checked', () => {
  assert.deepEqual(notesOf('banjo'), [67, 50, 55, 59, 62]);            // gDGBD, short drone string first
  assert.deepEqual(notesOf('violin'), [55, 62, 69, 76]);
  assert.deepEqual(notesOf('double-bass'), [28, 33, 38, 43]);
  assert.deepEqual(byId('bouzouki-greek').courses, [[48, 60], [53, 65], [57], [62]]);
  assert.equal(byId('bass-5').lowest, 23);
});
