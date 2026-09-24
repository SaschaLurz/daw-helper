/*
 * tunings.js — the tuner's instruments and tunings, and the notation for them.
 *
 * A tuning is written the way players write it: notes with their octave,
 * lowest string first, separated by spaces ("E2 A2 D3 G3 B3 E4"). Strings that
 * share a course are joined with a slash ("E2/E3" on a 12-string); the first
 * one is shown as the main string, the others as its partners. Written with
 * flats, a tuning is also displayed with flats.
 *
 * The presets use exactly the notation a user types for a custom tuning, so
 * both go through parseTuning().
 *
 * Loaded as a plain <script> in the browser (window.Tunings) and via require()
 * in Node for the tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.Tunings = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LOWEST = 21;       // A0, 27.5 Hz: the detector's reliable range…
  const HIGHEST = 88;      // …up to E6, 1319 Hz
  const MAX_COURSES = 12;
  const MAX_PER_COURSE = 3;

  const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  // Keep ids stable: they are what the app remembers.
  const PRESETS = [
    { id: 'standard', group: 'Guitar', name: 'Standard', strings: 'E2 A2 D3 G3 B3 E4' },
    { id: 'drop-d', group: 'Guitar', name: 'Drop D', strings: 'D2 A2 D3 G3 B3 E4' },
    { id: 'eb', group: 'Guitar', name: 'E♭ Standard', strings: 'Eb2 Ab2 Db3 Gb3 Bb3 Eb4' },
    { id: 'd', group: 'Guitar', name: 'D Standard', strings: 'D2 G2 C3 F3 A3 D4' },
    { id: 'drop-c', group: 'Guitar', name: 'Drop C', strings: 'C2 G2 C3 F3 A3 D4' },
    { id: 'dadgad', group: 'Guitar', name: 'DADGAD', strings: 'D2 A2 D3 G3 A3 D4' },
    { id: 'open-g', group: 'Guitar', name: 'Open G', strings: 'D2 G2 D3 G3 B3 D4' },
    { id: 'open-d', group: 'Guitar', name: 'Open D', strings: 'D2 A2 D3 F#3 A3 D4' },
    { id: 'open-e', group: 'Guitar', name: 'Open E', strings: 'E2 B2 E3 G#3 B3 E4' },
    { id: 'open-c', group: 'Guitar', name: 'Open C', strings: 'C2 G2 C3 G3 C4 E4' },
    { id: 'seven', group: 'Guitar', name: '7-string', strings: 'B1 E2 A2 D3 G3 B3 E4' },
    { id: 'eight', group: 'Guitar', name: '8-string', strings: 'F#1 B1 E2 A2 D3 G3 B3 E4' },
    { id: 'baritone', group: 'Guitar', name: 'Baritone guitar', strings: 'B1 E2 A2 D3 F#3 B3' },

    { id: 'twelve', group: '12-string', name: '12-string', strings: 'E2/E3 A2/A3 D3/D4 G3/G4 B3/B3 E4/E4' },
    { id: 'twelve-d', group: '12-string', name: '12-string D', strings: 'D2/D3 G2/G3 C3/C4 F3/F4 A3/A3 D4/D4' },

    { id: 'bass', group: 'Bass', name: 'Bass', strings: 'E1 A1 D2 G2' },
    { id: 'bass-drop-d', group: 'Bass', name: 'Bass Drop D', strings: 'D1 A1 D2 G2' },
    { id: 'bass-eb', group: 'Bass', name: 'Bass E♭', strings: 'Eb1 Ab1 Db2 Gb2' },
    { id: 'bass-bead', group: 'Bass', name: 'Bass BEAD', strings: 'B0 E1 A1 D2' },
    { id: 'bass-5', group: 'Bass', name: 'Bass 5-string', strings: 'B0 E1 A1 D2 G2' },
    { id: 'bass-6', group: 'Bass', name: 'Bass 6-string', strings: 'B0 E1 A1 D2 G2 C3' },

    { id: 'ukulele', group: 'Ukulele', name: 'Ukulele', strings: 'G4 C4 E4 A4' },
    { id: 'ukulele-low-g', group: 'Ukulele', name: 'Low G uke', strings: 'G3 C4 E4 A4' },
    { id: 'ukulele-d', group: 'Ukulele', name: 'Ukulele D', strings: 'A4 D4 F#4 B4' },
    { id: 'ukulele-baritone', group: 'Ukulele', name: 'Baritone uke', strings: 'D3 G3 B3 E4' },
    { id: 'guitalele', group: 'Ukulele', name: 'Guitalele', strings: 'A2 D3 G3 C4 E4 A4' },

    // The 5-string banjo's short drone string comes first, as banjo players write it.
    { id: 'banjo', group: 'Banjo', name: 'Banjo open G', strings: 'G4 D3 G3 B3 D4' },
    { id: 'banjo-double-c', group: 'Banjo', name: 'Banjo double C', strings: 'G4 C3 G3 C4 D4' },
    { id: 'banjo-open-d', group: 'Banjo', name: 'Banjo open D', strings: 'F#4 D3 F#3 A3 D4' },
    { id: 'banjo-tenor', group: 'Banjo', name: 'Tenor banjo', strings: 'C3 G3 D4 A4' },
    { id: 'banjo-irish', group: 'Banjo', name: 'Irish tenor banjo', strings: 'G2 D3 A3 E4' },
    { id: 'banjo-plectrum', group: 'Banjo', name: 'Plectrum banjo', strings: 'C3 G3 B3 D4' },

    { id: 'mandolin', group: 'Mandolin', name: 'Mandolin', strings: 'G3 D4 A4 E5' },
    { id: 'mandola', group: 'Mandolin', name: 'Mandola', strings: 'C3 G3 D4 A4' },
    { id: 'octave-mandolin', group: 'Mandolin', name: 'Octave mandolin', strings: 'G2 D3 A3 E4' },
    { id: 'mandocello', group: 'Mandolin', name: 'Mandocello', strings: 'C2 G2 D3 A3' },

    { id: 'violin', group: 'Violin family', name: 'Violin', strings: 'G3 D4 A4 E5' },
    { id: 'viola', group: 'Violin family', name: 'Viola', strings: 'C3 G3 D4 A4' },
    { id: 'cello', group: 'Violin family', name: 'Cello', strings: 'C2 G2 D3 A3' },
    { id: 'double-bass', group: 'Violin family', name: 'Double bass', strings: 'E1 A1 D2 G2' },

    { id: 'dobro', group: 'Other', name: 'Dobro open G', strings: 'G2 B2 D3 G3 B3 D4' },
    { id: 'lap-steel-c6', group: 'Other', name: 'Lap steel C6', strings: 'C3 E3 G3 A3 C4 E4' },
    { id: 'bouzouki-irish', group: 'Other', name: 'Irish bouzouki', strings: 'G2 D3 A3 D4' },
    { id: 'bouzouki-greek', group: 'Other', name: 'Greek bouzouki', strings: 'C3/C4 F3/F4 A3/A3 D4/D4' },
  ];

  /** "F#3", "Bb1", "g4", "E♭2" → { midi, accidental: 'sharp' | 'flat' | null }, or null. */
  function parseNote(text) {
    const m = /^([A-Ga-g])(#|♯|b|♭)?(\d)$/.exec(String(text).trim());
    if (!m) return null;
    const shift = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
    return {
      midi: (Number(m[3]) + 1) * 12 + PITCH_CLASS[m[1].toUpperCase()] + shift,
      accidental: shift > 0 ? 'sharp' : shift < 0 ? 'flat' : null,
    };
  }

  function noteName(midi, flats) {
    return (flats ? FLAT_NAMES : SHARP_NAMES)[((midi % 12) + 12) % 12];
  }

  function noteOctave(midi) {
    return Math.floor(midi / 12) - 1;
  }

  function noteLabel(midi, flats) {
    return `${noteName(midi, flats)}${noteOctave(midi)}`;
  }

  /**
   * "E2/E3 A2/A3 …" → { courses: [[40, 52], [45, 57], …], flats }, or
   * { error } with a sentence saying what to fix.
   */
  function parseTuning(text) {
    const tokens = String(text || '').trim().split(/[\s,]+/).filter(Boolean);
    if (!tokens.length) return { error: 'Type the strings as notes, lowest first — for example E2 A2 D3 G3 B3 E4.' };
    if (tokens.length > MAX_COURSES) return { error: `That’s ${tokens.length} strings; the tuner shows up to ${MAX_COURSES}.` };
    const courses = [];
    let sharps = 0;
    let flats = 0;
    for (const token of tokens) {
      const parts = token.split('/').filter(Boolean);
      if (parts.length > MAX_PER_COURSE) return { error: `“${token}”: a course can hold up to ${MAX_PER_COURSE} strings, like G3/G4.` };
      const course = [];
      for (const part of parts) {
        const note = parseNote(part);
        if (!note) return { error: `“${part}” isn’t a note. Write the letter, then # or b if needed, then the octave: F#3, Bb1.` };
        if (note.midi < LOWEST || note.midi > HIGHEST) {
          return { error: `${part} is outside what the tuner can hear reliably (A0 to E6).` };
        }
        if (note.accidental === 'sharp') sharps++;
        if (note.accidental === 'flat') flats++;
        if (!course.includes(note.midi)) course.push(note.midi);   // unison pairs count once
      }
      courses.push(course);
    }
    return { courses, flats: flats > sharps };
  }

  /**
   * A tuning ready for the tuner: its courses, and every distinct target in
   * display order ({ midi, course, main }). Null if the notation is invalid.
   */
  function build(def) {
    const parsed = parseTuning(def.strings);
    if (parsed.error) return null;
    const targets = [];
    parsed.courses.forEach((notes, course) => notes.forEach((midi, k) => targets.push({ midi, course, main: k === 0 })));
    return {
      id: def.id,
      group: def.group,
      name: def.name,
      strings: def.strings,
      custom: !!def.custom,
      courses: parsed.courses,
      flats: parsed.flats,
      targets,
      lowest: Math.min.apply(null, targets.map((t) => t.midi)),
    };
  }

  /** How a course reads in a list: "E2/E3". */
  function courseLabel(course, flats) {
    return course.map((m) => noteLabel(m, flats)).join('/');
  }

  return { PRESETS, parseNote, parseTuning, build, noteName, noteOctave, noteLabel, courseLabel, LOWEST, HIGHEST, MAX_COURSES };
});
