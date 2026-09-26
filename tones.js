/*
 * tones.js — the maths behind Sound lab: tones in Hz, intervals, chords and
 * the experiments, without any sound.
 *
 * A tone is a frequency; note names, cents, intervals and chord names are
 * worked out from it. Chords are recognised from their pitch classes, so any
 * voicing, octave doubling or inversion is named, and they are spelled the
 * way musicians write them: C minor has an E♭, not a D♯.
 *
 * Loaded as a plain <script> in the browser (window.Tones) and via require()
 * in Node for the tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.Tones = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_HZ = 20;          // about the range of human hearing
  const MAX_HZ = 20000;
  const MAX_VOICES = 8;
  const BEAT_MAX_HZ = 20;     // tones closer than this are heard as one tone that beats
  const SLIDER_STEPS = 1000;

  // Sine-term amplitudes of the "soft" sound, which the tuner's reference tone
  // uses too: mellow, with enough overtones to carry on small speakers.
  const SOFT_HARMONICS = [0, 1, 0.5, 0.3, 0.18, 0.1, 0.06];

  const WAVES = [
    { id: 'soft', name: 'Soft' },
    { id: 'sine', name: 'Sine' },
    { id: 'triangle', name: 'Triangle' },
    { id: 'square', name: 'Square' },
    { id: 'sawtooth', name: 'Sawtooth' },
  ];

  const LETTERS = 'CDEFGAB';
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
  // Black keys by their everyday names; minor chords prefer sharps (C♯m, G♯m), as key signatures do.
  const NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const MINOR_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
  const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

  // Indexed by semitones. ratio: the pure (just) version; song: an ascending melody that starts with it.
  const INTERVALS = [
    { id: 'P1', semis: 0, name: 'Unison', degree: 1, ratio: [1, 1] },
    {
      id: 'm2', semis: 1, name: 'Minor 2nd', degree: 2, ratio: [16, 15], song: 'the “Jaws” theme',
      text: 'The smallest step in most Western music: one fret, or one key to the next. Played together, the two notes grind.',
    },
    {
      id: 'M2', semis: 2, name: 'Major 2nd', degree: 2, ratio: [9, 8], song: '“Happy Birthday”, from “-py” to “birth”',
      text: 'A whole step, two frets. Together the notes rub gently; one after the other, it is the step most melodies move in.',
    },
    {
      id: 'm3', semis: 3, name: 'Minor 3rd', degree: 3, ratio: [6, 5], song: '“Greensleeves”, or the “Smoke on the Water” riff',
      text: 'The interval that makes a chord minor. Soft and a little sad.',
    },
    {
      id: 'M3', semis: 4, name: 'Major 3rd', degree: 3, ratio: [5, 4], song: '“When the Saints Go Marching In”',
      text: 'The interval that makes a chord major. Bright and warm.',
    },
    {
      id: 'P4', semis: 5, name: 'Perfect 4th', degree: 4, ratio: [4, 3], song: '“Here Comes the Bride”',
      text: 'Open and a little hollow. It is the distance between neighbouring strings on a bass, and on most of a guitar.',
    },
    {
      id: 'TT', semis: 6, name: 'Tritone', degree: 4, ratio: null, song: '“Maria” from West Side Story, or the opening of “The Simpsons”',
      text: 'Exactly half an octave: three whole steps. Restless and unstable; for centuries it was called “the devil in music”.',
    },
    {
      id: 'P5', semis: 7, name: 'Perfect 5th', degree: 5, ratio: [3, 2], song: '“Twinkle, Twinkle, Little Star”, or the “Star Wars” theme',
      text: 'The most stable interval after the octave, and a power chord on its own. The pure 3:2 and the piano’s fifth are only 2 cents apart.',
    },
    {
      id: 'm6', semis: 8, name: 'Minor 6th', degree: 6, ratio: [8, 5], song: '“The Entertainer”, on its first leap up',
      text: 'Bittersweet. Turn a major 3rd upside down (move its lower note up an octave) and you get a minor 6th.',
    },
    {
      id: 'M6', semis: 9, name: 'Major 6th', degree: 6, ratio: [5, 3], song: '“My Bonnie Lies over the Ocean”',
      text: 'Warm and open: a minor 3rd turned upside down.',
    },
    {
      id: 'm7', semis: 10, name: 'Minor 7th', degree: 7, ratio: [16, 9], song: 'the original “Star Trek” theme',
      text: 'Bluesy and unresolved: the note that turns a chord into a seventh chord.',
    },
    {
      id: 'M7', semis: 11, name: 'Major 7th', degree: 7, ratio: [15, 8], song: null,
      text: 'A semitone short of the octave. Bright but yearning, as if it wants to climb that last step.',
    },
    {
      id: 'P8', semis: 12, name: 'Octave', degree: 8, ratio: [2, 1], song: '“Somewhere Over the Rainbow”, on “Some-where”',
      text: 'The same note at twice the frequency. It blends so completely that people singing “the same” tune are often an octave apart.',
    },
  ];

  // intervals: semitones above the root as the chord is voiced; degrees: which
  // letter each note is written on (3 = the third), for the spelling.
  const CHORDS = [
    {
      id: 'major', group: 'Triads', name: 'major', suffix: '', intervals: [0, 4, 7], degrees: [1, 3, 5],
      text: 'Root, major 3rd and perfect 5th. Bright and settled: the chord most songs come home to.',
    },
    {
      id: 'minor', group: 'Triads', name: 'minor', suffix: 'm', intervals: [0, 3, 7], degrees: [1, 3, 5],
      text: 'Lower the major chord’s 3rd by a semitone and it turns darker and sadder. Only that one note changes.',
    },
    {
      id: 'dim', group: 'Triads', name: 'diminished', suffix: 'dim', intervals: [0, 3, 6], degrees: [1, 3, 5],
      text: 'Two minor 3rds stacked. Tense and unstable; it wants to move on to another chord.',
    },
    {
      id: 'aug', group: 'Triads', name: 'augmented', suffix: 'aug', intervals: [0, 4, 8], degrees: [1, 3, 5],
      text: 'Two major 3rds stacked. Dreamy and unresolved. It splits the octave into three equal parts, so any of its notes can be heard as the root.',
    },
    {
      id: 'sus2', group: 'Triads', name: 'suspended 2nd', suffix: 'sus2', intervals: [0, 2, 7], degrees: [1, 2, 5],
      text: 'The 3rd is swapped for the 2nd, so the chord is neither major nor minor. Open and airy.',
    },
    {
      id: 'sus4', group: 'Triads', name: 'suspended 4th', suffix: 'sus4', intervals: [0, 5, 7], degrees: [1, 4, 5],
      text: 'The 3rd is swapped for the 4th, which leans on the 5th and wants to fall back to the 3rd.',
    },
    {
      id: 'power', group: 'Triads', name: 'power chord', suffix: '5', intervals: [0, 7, 12], degrees: [1, 5, 1],
      text: 'Just the root, the 5th and the octave. Without a 3rd it is neither major nor minor, and it stays clean under heavy distortion: the rock guitar staple.',
    },
    {
      id: '7', group: 'Sevenths', name: 'dominant 7th', suffix: '7', intervals: [0, 4, 7, 10], degrees: [1, 3, 5, 7],
      text: 'A major chord with a minor 7th on top. Bluesy, and it pulls hard toward the chord a 5th below: G7 wants to go to C.',
    },
    {
      id: 'maj7', group: 'Sevenths', name: 'major 7th', suffix: 'maj7', intervals: [0, 4, 7, 11], degrees: [1, 3, 5, 7],
      text: 'A major chord plus the major 7th, a semitone under the octave. Soft, jazzy and a little wistful.',
    },
    {
      id: 'm7', group: 'Sevenths', name: 'minor 7th', suffix: 'm7', intervals: [0, 3, 7, 10], degrees: [1, 3, 5, 7],
      text: 'A minor chord plus a minor 7th. Mellow; everywhere in soul, funk and jazz.',
    },
    {
      id: 'm7b5', group: 'Sevenths', name: 'half-diminished', suffix: 'm7♭5', intervals: [0, 3, 6, 10], degrees: [1, 3, 5, 7],
      text: 'A diminished chord with a minor 7th. Dark and searching; in minor keys it often comes just before the dominant chord.',
    },
    {
      id: 'dim7', group: 'Sevenths', name: 'diminished 7th', suffix: 'dim7', intervals: [0, 3, 6, 9], degrees: [1, 3, 5, 7],
      text: 'Three minor 3rds stacked, splitting the octave into four equal parts. Pure suspense: the silent-film villain’s chord.',
    },
    {
      id: 'mmaj7', group: 'Sevenths', name: 'minor-major 7th', suffix: 'm(maj7)', intervals: [0, 3, 7, 11], degrees: [1, 3, 5, 7],
      text: 'A minor chord with a major 7th. Mysterious; think of the end of a spy film.',
    },
    {
      id: '7sus4', group: 'Sevenths', name: '7th suspended 4th', suffix: '7sus4', intervals: [0, 5, 7, 10], degrees: [1, 4, 5, 7],
      text: 'A dominant 7th with the 4th in place of the 3rd. It floats without quite resolving; common in funk and soul.',
    },
    {
      id: '6', group: 'Sixths & added', name: 'major 6th', suffix: '6', intervals: [0, 4, 7, 9], degrees: [1, 3, 5, 6],
      text: 'A major chord plus the 6th. Sweet and a little old-fashioned: the last chord of many swing tunes.',
    },
    {
      id: 'm6', group: 'Sixths & added', name: 'minor 6th', suffix: 'm6', intervals: [0, 3, 7, 9], degrees: [1, 3, 5, 6],
      text: 'A minor chord plus the major 6th. Cool and smoky, with a hint of tension.',
    },
    {
      id: 'add9', group: 'Sixths & added', name: 'add 9', suffix: 'add9', intervals: [0, 4, 7, 14], degrees: [1, 3, 5, 9],
      text: 'A major chord with the 9th added: the 2nd, an octave up. Shimmering and open.',
    },
    {
      id: 'madd9', group: 'Sixths & added', name: 'minor add 9', suffix: 'm(add9)', intervals: [0, 3, 7, 14], degrees: [1, 3, 5, 9],
      text: 'A minor chord with the 9th added. Wistful and spacious.',
    },
    {
      id: '9', group: 'Ninths', name: 'dominant 9th', suffix: '9', intervals: [0, 4, 7, 10, 14], degrees: [1, 3, 5, 7, 9],
      text: 'A dominant 7th with the 9th on top. Rich and funky.',
    },
    {
      id: 'maj9', group: 'Ninths', name: 'major 9th', suffix: 'maj9', intervals: [0, 4, 7, 11, 14], degrees: [1, 3, 5, 7, 9],
      text: 'A major 7th with the 9th on top. Lush; a favourite of ballads and neo-soul.',
    },
    {
      id: 'm9', group: 'Ninths', name: 'minor 9th', suffix: 'm9', intervals: [0, 3, 7, 10, 14], degrees: [1, 3, 5, 7, 9],
      text: 'A minor 7th with the 9th on top. Smooth and moody.',
    },
  ];
  CHORDS.forEach((c) => {
    c.pcs = Array.from(new Set(c.intervals.map(mod12))).sort((a, b) => a - b);
    c.minor = c.pcs.includes(3) && !c.pcs.includes(4);
  });

  // What a chord tone is called, by the letter it is written on and its distance from the root.
  const ROLES = {
    1: { 0: 'Root' },
    2: { 2: '2nd' },
    3: { 3: 'Minor 3rd', 4: 'Major 3rd' },
    4: { 5: '4th' },
    5: { 6: 'Flat 5th', 7: '5th', 8: 'Sharp 5th' },
    6: { 9: '6th' },
    7: { 9: 'Diminished 7th', 10: 'Minor 7th', 11: 'Major 7th' },
    9: { 2: '9th' },
  };
  const INVERSIONS = { 3: 'first inversion', 5: 'second inversion', 7: 'third inversion' };

  // Voices are { note (MIDI), ratio, cents, plusHz, gain, on }: the frequency
  // follows A4, so the experiments work at any reference pitch.
  const EXPERIMENTS = [
    {
      id: 'beating', name: 'Beating', wave: 'sine',
      voices: [{ note: 69 }, { note: 69, plusHz: 3 }],
      text: 'Two tones 3 Hz apart don’t sound like two notes: you hear one note that swells and fades three times a second. '
        + 'That is beating, and its rate is simply the difference between the two frequencies. Tuning by ear means turning a string '
        + 'until the beats slow down and stop. Try it: click the second tone’s frequency and press the down arrow (1 Hz per press) '
        + 'until it matches the first.',
    },
    {
      id: 'pure-third', name: 'Pure or piano third', wave: 'sawtooth',
      voices: [{ note: 69 }, { note: 69, ratio: 5 / 4 }, { note: 73, on: false }],
      text: 'A pure major 3rd vibrates at exactly 5:4, five cycles of the upper tone for every four of the lower, and sounds smooth '
        + 'and still. The piano’s 3rd is 14 cents wider and gives off a fast shimmer. Switch the two upper tones on and off to compare. '
        + 'Keyboards and fretted instruments all make this compromise so that they can play in every key.',
    },
    {
      id: 'harmonics', name: 'Harmonic series', wave: 'sine',
      voices: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ note: 45, ratio: n, gain: Math.round(100 / n) / 100 })),
      text: 'Tones at 1, 2, 3 … 8 times the frequency of the lowest, each quieter than the last. They fuse into a single A2 with a '
        + 'bright, buzzy colour; this exact recipe is how a sawtooth wave is built. Every note an instrument plays is a stack like this, '
        + 'and the balance of its overtones is its timbre. Switch tones off one by one: the colour changes, the pitch stays.',
    },
    {
      id: 'missing-fundamental', name: 'Missing fundamental', wave: 'sine',
      voices: [{ note: 28, on: false }, { note: 28, ratio: 2 }, { note: 28, ratio: 3 }, { note: 28, ratio: 4 }, { note: 28, ratio: 5 }, { note: 28, ratio: 6 }],
      text: 'These tones are 2 to 6 times the frequency of a bass’s low E (about 41 Hz), but the low E itself is switched off. '
        + 'Your brain fills it in, so most people still hear that low E. It is why a bass stays recognisable on laptop and phone '
        + 'speakers that can’t reproduce its lowest notes. Switch the lowest tone on: the sound gets fuller, the pitch hardly moves.',
    },
    {
      id: 'supersaw', name: 'Detuned unison', wave: 'sawtooth',
      voices: [{ note: 57, cents: -12 }, { note: 57 }, { note: 57, cents: 12 }],
      text: 'Three sawtooth waves on the same A, two of them detuned by 12 cents either way. They drift in and out of phase, which '
        + 'makes the sound wide and moving instead of static: the “supersaw” of trance and EDM leads, and what a chorus effect does '
        + 'to a guitar. Change the outer tones’ frequencies and the movement speeds up or slows down.',
    },
  ];

  function mod12(n) {
    return ((n % 12) + 12) % 12;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function gcd(a, b) {
    return b ? gcd(b, a % b) : a;
  }

  function freqToMidi(freq, a4) {
    return 69 + 12 * Math.log2(freq / a4);
  }

  function midiToFreq(midi, a4) {
    return a4 * Math.pow(2, (midi - 69) / 12);
  }

  function inRange(hz) {
    return hz >= MIN_HZ && hz <= MAX_HZ;
  }

  function octaveOf(midi) {
    return Math.floor(midi / 12) - 1;
  }

  // -------------------------------------------------------------- spelling

  function accidental(name) {
    return name[1] === '♯' ? 1 : name[1] === '♭' ? -1 : 0;
  }

  /**
   * The note `semis` above the root, written on the letter `degree` steps up:
   * a minor 3rd above C is E♭, not D♯, and the 7th of D♭7 is C♭. Double sharps
   * and flats (`double` is set) give way to the plain name: C dim7 ends on A,
   * not B♭♭, as most chord charts write it.
   */
  function spell(rootName, semis, degree, flats) {
    const letter = LETTERS.indexOf(rootName[0]);
    const pc = mod12(LETTER_PC[letter] + accidental(rootName) + semis);
    const target = (letter + degree - 1) % 7;
    let shift = pc - LETTER_PC[target];
    if (shift > 6) shift -= 12;
    if (shift < -6) shift += 12;
    if (Math.abs(shift) > 1) return { name: (flats ? FLAT_NAMES : SHARP_NAMES)[pc], double: true };
    return { name: LETTERS[target] + (shift > 0 ? '♯' : shift < 0 ? '♭' : ''), double: false };
  }

  function prefersFlats(rootName, minor) {
    return accidental(rootName) < 0 || (accidental(rootName) === 0 && minor);
  }

  /** The octave a note is written in under a name: C♭5 and B4 are the same key. */
  function writtenOctave(name, midi) {
    return octaveOf(midi) + (name === 'C♭' ? 1 : name === 'B♯' ? -1 : 0);
  }

  /** Names of two notes an interval apart, spelled as that interval: C and E♭ for a minor 3rd. */
  function spellInterval(lowMidi, highMidi) {
    const low = NAMES[mod12(lowMidi)];
    const simple = mod12(highMidi - lowMidi);
    const flats = prefersFlats(low, false);
    let high = spell(low, simple, INTERVALS[simple].degree, flats).name;
    // A tritone is an augmented 4th (C to F♯) unless a diminished 5th reads better (B to F, not E♯).
    if (simple === 6 && /[EB]♯|[CF]♭/.test(high)) high = spell(low, 6, 5, flats).name;
    return [low, high];
  }

  // --------------------------------------------------------------- chords

  function chordById(id) {
    return CHORDS.find((c) => c.id === id) || null;
  }

  /** The MIDI notes of a chord, voiced upward from the root. */
  function chordNotes(id, rootMidi) {
    const chord = chordById(id);
    return chord ? chord.intervals.map((i) => rootMidi + i) : [];
  }

  /**
   * Everything the page shows about a chord on a root (pitch class), with an
   * optional other bass note: its symbol ("Cm7/G"), long name, spelled notes,
   * and per pitch class the spelled name and the note's role.
   */
  function describeChord(chord, rootPc, bassPc) {
    const rootName = chordRootName(chord, rootPc);
    const flats = prefersFlats(rootName, chord.minor);
    const names = new Array(12);
    const roles = new Array(12);
    const degrees = new Array(12);
    const notes = [];
    chord.intervals.forEach((semis, k) => {
      const pc = mod12(rootPc + semis);
      if (names[pc]) return;
      const degree = chord.degrees[k];
      names[pc] = spell(rootName, semis, degree, flats).name;
      roles[pc] = (ROLES[degree] && ROLES[degree][mod12(semis)]) || INTERVALS[mod12(semis)].name;
      degrees[pc] = degree;
      notes.push(names[pc]);
    });
    const bass = bassPc === undefined || bassPc === rootPc ? null : names[bassPc];
    return {
      id: chord.id,
      chord,
      rootPc,
      rootName,
      suffix: chord.suffix,
      bass,
      symbol: rootName + chord.suffix + (bass ? `/${bass}` : ''),
      name: `${rootName} ${chord.name}`,
      inversion: bass ? INVERSIONS[degrees[bassPc]] || `${bass} in the bass` : null,
      notes,
      names,
      roles,
      text: chord.text,
    };
  }

  // The usual name for the root (D♭ major, C♯ minor), unless its other name
  // spells the chord without double sharps or flats: D♯dim7 rather than E♭dim7.
  function chordRootName(chord, rootPc) {
    const usual = (chord.minor ? MINOR_NAMES : NAMES)[rootPc];
    const doubles = (name) => chord.intervals
      .filter((semis, k) => spell(name, semis, chord.degrees[k], prefersFlats(name, chord.minor)).double).length;
    const other = [SHARP_NAMES[rootPc], FLAT_NAMES[rootPc]].find((name) => name !== usual);
    return other && doubles(other) < doubles(usual) ? other : usual;
  }

  function chordAt(id, rootPc) {
    const chord = chordById(id);
    return chord ? describeChord(chord, mod12(rootPc)) : null;
  }

  /**
   * The chord some notes (MIDI numbers, any order) make, or null. The bass
   * note is tried as the root first, so C E G A reads as C6 and A C E G as
   * Am7; otherwise it is an inversion, written with a slash: C/E.
   */
  function identifyChord(midis) {
    const pcs = [];
    midis.slice().sort((a, b) => a - b).forEach((m) => {
      if (!pcs.includes(mod12(m))) pcs.push(mod12(m));
    });
    if (pcs.length < 2) return null;
    for (const rootPc of pcs) {
      const set = pcs.map((p) => mod12(p - rootPc)).sort((a, b) => a - b);
      const chord = CHORDS.find((c) => c.pcs.length === set.length && c.pcs.every((p, i) => p === set[i]));
      if (chord) return describeChord(chord, rootPc, pcs[0]);
    }
    return null;
  }

  // ------------------------------------------------------------ intervals

  function intervalById(id) {
    return INTERVALS.find((i) => i.id === id) || null;
  }

  function intervalName(semis) {
    const octaves = Math.floor(semis / 12);
    const simple = semis - 12 * octaves;
    if (simple === 0) return octaves === 0 ? 'Unison' : octaves === 1 ? 'Octave' : `${octaves} octaves`;
    return INTERVALS[simple].name + (octaves === 0 ? '' : octaves === 1 ? ' + octave' : ` + ${octaves} octaves`);
  }

  /**
   * Two frequencies as an interval: its name, size in semitones and cents,
   * the pure ratio it is closest to ("3:2", "3:1" for a 5th plus an octave)
   * and how many cents it is off that ratio.
   */
  function describeInterval(f1, f2) {
    const lo = Math.min(f1, f2);
    const hi = Math.max(f1, f2);
    const cents = 1200 * Math.log2(hi / lo);
    const semitones = Math.round(cents / 100);
    const octaves = Math.floor(semitones / 12);
    const simple = semitones - 12 * octaves;
    const base = INTERVALS[simple].ratio;
    let ratio = null;
    let offPure = null;
    if (base) {
      let n = base[0] * Math.pow(2, octaves);
      let d = base[1];
      const g = gcd(n, d);
      n /= g;
      d /= g;
      ratio = `${n}:${d}`;
      offPure = cents - 1200 * Math.log2(n / d);
    }
    const song = semitones >= 1 && semitones <= 12 ? INTERVALS[semitones].song || null : null;
    return { name: intervalName(semitones), semitones, cents, ratio, offPure, song };
  }

  // ---------------------------------------------------------------- tones

  /**
   * A typed tone: a frequency ("440", "261,6", "440 Hz", "1.5k") or a note
   * ("A4", "Eb2", "F#3") at the given A4. { hz } or { error } saying what to fix.
   */
  function parseTone(text, a4) {
    const s = String(text || '').trim();
    let hz;
    const note = /^([A-Ga-g])(#|♯|b|♭)?(\d)$/.exec(s);
    if (note) {
      const shift = note[2] === '#' || note[2] === '♯' ? 1 : note[2] ? -1 : 0;
      hz = midiToFreq((Number(note[3]) + 1) * 12 + LETTER_PC[LETTERS.indexOf(note[1].toUpperCase())] + shift, a4);
    } else {
      const m = /^(\d+(?:[.,]\d*)?|[.,]\d+)\s*(k)?(?:hz)?$/i.exec(s);
      if (!m) return { error: 'Type a frequency such as 440, or a note such as A4 or Eb2.' };
      hz = Number(m[1].replace(',', '.')) * (m[2] ? 1000 : 1);
    }
    if (!inRange(hz)) return { error: 'Sound lab plays from 20 Hz to 20 kHz, about the range of human hearing.' };
    return { hz };
  }

  /**
   * The next equal-tempered note below (dir < 0) or above (dir > 0). A tone
   * between notes goes to the nearest one on that side, so the − and +
   * buttons also snap a slid frequency back onto the notes. Null out of range.
   */
  function stepNote(freq, dir, a4) {
    const exact = freqToMidi(freq, a4);
    const midi = dir > 0 ? Math.floor(exact + 0.01) + 1 : Math.ceil(exact - 0.01) - 1;
    const hz = midiToFreq(midi, a4);
    return inRange(hz) ? hz : null;
  }

  // The frequency slider is logarithmic, so every octave gets the same room.
  function sliderToFreq(value) {
    return MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, clamp(value, 0, SLIDER_STEPS) / SLIDER_STEPS);
  }

  function freqToSlider(freq) {
    return Math.round((SLIDER_STEPS * Math.log(freq / MIN_HZ)) / Math.log(MAX_HZ / MIN_HZ));
  }

  /** A slid frequency rounded to what the slider can resolve: 0.1 Hz below 100 Hz, whole Hz above. */
  function tidyFreq(freq) {
    return freq < 100 ? Math.round(freq * 10) / 10 : Math.round(freq);
  }

  /**
   * The slowest beating between two of the frequencies, in Hz, or 0. Only
   * tones on the same note count (within half a semitone): that is the beating
   * tuning by ear listens for. Low notes a semitone apart are also a few Hz
   * apart, but what they make is an interval's roughness.
   */
  function beatRate(freqs) {
    let rate = 0;
    for (let i = 0; i < freqs.length; i++) {
      for (let j = i + 1; j < freqs.length; j++) {
        const d = Math.abs(freqs[i] - freqs[j]);
        const sameNote = Math.abs(1200 * Math.log2(freqs[i] / freqs[j])) < 50;
        if (sameNote && d >= 0.05 && d < BEAT_MAX_HZ && (!rate || d < rate)) rate = d;
      }
    }
    return rate;
  }

  function experimentById(id) {
    return EXPERIMENTS.find((e) => e.id === id) || null;
  }

  /** An experiment's tones at a reference pitch: [{ freq, gain, on }]. */
  function experimentVoices(id, a4) {
    const exp = experimentById(id);
    if (!exp) return [];
    return exp.voices.map((v) => ({
      freq: midiToFreq(v.note, a4) * (v.ratio || 1) * Math.pow(2, (v.cents || 0) / 1200) + (v.plusHz || 0),
      gain: v.gain === undefined ? 1 : v.gain,
      on: v.on !== false,
    }));
  }

  // ---------------------------------------------------------------- waves

  function softSample(p) {
    let v = 0;
    for (let n = 1; n < SOFT_HARMONICS.length; n++) v += SOFT_HARMONICS[n] * Math.sin(2 * Math.PI * n * p);
    return v;
  }

  // The browser scales a custom wave to a peak of 1; so does the drawing.
  const SOFT_PEAK = (function () {
    let peak = 0;
    for (let i = 0; i < 4096; i++) peak = Math.max(peak, Math.abs(softSample(i / 4096)));
    return peak;
  })();

  /** One sample of a wave at a phase in cycles, shaped like the browser's oscillators (rising from 0). */
  function waveSample(wave, phase) {
    const p = phase - Math.floor(phase);
    switch (wave) {
      case 'sine': return Math.sin(2 * Math.PI * p);
      case 'square': return p < 0.5 ? 1 : -1;
      case 'sawtooth': return p < 0.5 ? 2 * p : 2 * p - 2;
      case 'triangle': return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
      default: return softSample(p) / SOFT_PEAK;
    }
  }

  /**
   * The tones together at time t (s): each at its gain, scaled down when the
   * gains add up to more than 1 so the sum never exceeds full scale. That is
   * also how the page mixes them.
   */
  function mixSample(voices, wave, t) {
    const total = voices.reduce((s, v) => s + v.gain, 0);
    let sum = 0;
    voices.forEach((v) => { sum += v.gain * waveSample(wave, v.freq * t); });
    return sum / Math.max(1, total);
  }

  // ------------------------------------------------------------- settings

  /**
   * Sound lab's stored settings, repaired: anything missing or out of range
   * gets its default. `sounds` lists the sound ids that exist; a sound stored
   * under its old name, `wave`, is kept.
   */
  function normaliseState(stored, sounds) {
    const s = stored && typeof stored === 'object' ? stored : {};
    const known = sounds || WAVES.map((w) => w.id);
    const int = (v, lo, hi, fallback) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);
    const voices = Array.isArray(s.voices)
      ? s.voices
        .filter((v) => v && typeof v.freq === 'number' && inRange(v.freq))
        .slice(0, MAX_VOICES)
        .map((v) => ({ freq: v.freq, gain: typeof v.gain === 'number' ? clamp(v.gain, 0, 1) : 1, on: v.on !== false }))
      : [{ freq: 440, gain: 1, on: true }];
    return {
      voices,
      sound: known.includes(s.sound) ? s.sound : known.includes(s.wave) ? s.wave : 'soft',
      volume: typeof s.volume === 'number' ? clamp(s.volume, 0, 1) : 0.75,
      root: int(s.root, 0, 11, 0),
      octave: int(s.octave, 1, 6, 4),
      keys: int(s.keys, 1, 5, 3),
    };
  }

  return {
    MIN_HZ, MAX_HZ, MAX_VOICES, SLIDER_STEPS, SOFT_HARMONICS, WAVES, NAMES, INTERVALS, CHORDS, EXPERIMENTS,
    freqToMidi, midiToFreq, octaveOf, writtenOctave, spellInterval, chordById, chordNotes, chordAt, identifyChord,
    intervalById, intervalName, describeInterval, parseTone, stepNote, sliderToFreq, freqToSlider, tidyFreq,
    beatRate, experimentById, experimentVoices, waveSample, mixSample, normaliseState,
  };
});
