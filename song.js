/*
 * song.js — chord progressions for Sound lab: keys and Roman numerals, the
 * famous progressions, and how a loop of chords becomes notes (voicings,
 * playing styles, a bass line and a drum groove), plus the files a loop
 * exports to: MIDI, and a ZIP to carry the WAV stems. No sound.
 *
 * A chord in the loop is stored relative to the key: its root as semitones
 * above the tonic, so changing the key transposes the whole progression.
 *
 * Loaded as a plain <script> in the browser (window.Song) after tones.js, and
 * via require() in Node for the tests.
 */
(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./tones.js') : root.Tones);
  root.Song = api;
  if (node) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Tones) {
  'use strict';

  const BEATS_PER_BAR = 4;
  const MIN_BEATS = 1;
  const MAX_BEATS = 8;
  const MAX_BLOCKS = 32;
  const REPEATS = [1, 2, 4, 8];
  const MAX_SONGS = 100;

  const MODES = {
    major: {
      scale: [0, 2, 4, 5, 7, 9, 11],
      triads: ['major', 'minor', 'minor', 'major', 'major', 'minor', 'dim'],
      sevenths: ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'],
    },
    minor: {
      scale: [0, 2, 3, 5, 7, 8, 10],
      triads: ['minor', 'dim', 'major', 'minor', 'minor', 'major', 'major'],
      sevenths: ['m7', 'm7b5', 'maj7', 'm7', 'm7', 'maj7', '7'],
    },
  };

  // The numeral for each semitone above the tonic, as it is usually written in each mode.
  const DEGREE_NUMERALS = {
    major: ['I', '♭II', 'II', '♭III', 'III', 'IV', '♭V', 'V', '♭VI', 'VI', '♭VII', 'VII'],
    minor: ['I', '♭II', 'II', 'III', '♮III', 'IV', '♭V', 'V', 'VI', '♮VI', 'VII', '♮VII'],
  };
  const NUMERAL_SUFFIX = {
    major: '', minor: '', dim: '°', aug: '+', sus2: 'sus2', sus4: 'sus4', power: '5',
    7: '7', maj7: 'maj7', m7: '7', m7b5: 'ø7', dim7: '°7', mmaj7: 'maj7', '7sus4': '7sus4',
    6: '6', m6: '6', add9: 'add9', madd9: 'add9', 9: '9', maj9: 'maj9', m9: '9',
  };
  const DIMINISHED = ['dim', 'dim7', 'm7b5'];

  // chords: [semitones above the tonic, chord, beats (default a bar)].
  const PROGRESSIONS = [
    { id: 'pop', name: 'Pop · I–V–vi–IV', mode: 'major', chords: [[0, 'major'], [7, 'major'], [9, 'minor'], [5, 'major']] },
    { id: 'fifties', name: '50s · I–vi–IV–V', mode: 'major', chords: [[0, 'major'], [9, 'minor'], [5, 'major'], [7, 'major']] },
    { id: 'emotional', name: 'Emotional · vi–IV–I–V', mode: 'major', chords: [[9, 'minor'], [5, 'major'], [0, 'major'], [7, 'major']] },
    {
      id: 'canon', name: 'Canon · I–V–vi–iii–IV–I–IV–V', mode: 'major',
      chords: [[0, 'major'], [7, 'major'], [9, 'minor'], [4, 'minor'], [5, 'major'], [0, 'major'], [5, 'major'], [7, 'major']],
    },
    { id: 'rock', name: 'Rock · I–♭VII–IV–I', mode: 'major', chords: [[0, 'major'], [10, 'major'], [5, 'major'], [0, 'major']] },
    { id: 'royal-road', name: 'Royal road · IVmaj7–V7–iii7–vi', mode: 'major', chords: [[5, 'maj7'], [7, '7'], [4, 'm7'], [9, 'minor']] },
    { id: 'jazz', name: 'Jazz · ii7–V7–Imaj7', mode: 'major', chords: [[2, 'm7'], [7, '7'], [0, 'maj7', 8]] },
    { id: 'neo-soul', name: 'Neo-soul · ii9–V9–Imaj9–vi9', mode: 'major', chords: [[2, 'm9'], [7, '9'], [0, 'maj9'], [9, 'm9']] },
    {
      id: 'blues', name: '12-bar blues', mode: 'major',
      chords: [[0, '7', 8], [0, '7', 8], [5, '7', 8], [0, '7', 8], [7, '7'], [5, '7'], [0, '7'], [7, '7']],
    },
    { id: 'andalusian', name: 'Andalusian · i–VII–VI–V', mode: 'minor', chords: [[0, 'minor'], [10, 'major'], [8, 'major'], [7, 'major']] },
    { id: 'epic', name: 'Epic · i–VI–III–VII', mode: 'minor', chords: [[0, 'minor'], [8, 'major'], [3, 'major'], [10, 'major']] },
    { id: 'minor-cadence', name: 'Minor · i–iv–V–i', mode: 'minor', chords: [[0, 'minor'], [5, 'minor'], [7, 'major'], [0, 'minor']] },
  ];

  const STYLES = [
    { id: 'held', name: 'Held' },
    { id: 'quarters', name: 'Every beat' },
    { id: 'eighths', name: 'Eighths' },
    { id: 'strum', name: 'Strum' },
    { id: 'arp-up', name: 'Arpeggio up' },
    { id: 'arp-updown', name: 'Arpeggio up & down' },
  ];
  const VOICINGS = [
    { id: 'smooth', name: 'Smooth' },
    { id: 'root', name: 'Root position' },
  ];
  const BASS_PATTERNS = [
    { id: 'off', name: 'Off' },
    { id: 'held', name: 'Held roots' },
    { id: 'quarters', name: 'Every beat' },
    { id: 'eighths', name: 'Eighths' },
    { id: 'root-fifth', name: 'Root & fifth' },
    { id: 'octaves', name: 'Octaves' },
  ];

  // 16 steps a bar: the steps each drum plays on. Hats are accented on the beat.
  const EIGHTHS = [0, 2, 4, 6, 8, 10, 12, 14];
  const DRUM_PATTERNS = [
    { id: 'off', name: 'Off', bar: {} },
    { id: 'click', name: 'Click', bar: { 'click-hi': [0], click: [4, 8, 12] } },
    { id: 'pop', name: 'Pop', bar: { kick: [0, 8, 11], snare: [4, 12], hat: EIGHTHS } },
    { id: 'rock', name: 'Rock', bar: { kick: [0, 8, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12], openhat: [14] } },
    { id: 'ballad', name: 'Half-time ballad', bar: { kick: [0, 11], snare: [8], hat: EIGHTHS } },
    { id: 'hiphop', name: 'Hip-hop', bar: { kick: [0, 7, 10], snare: [4, 12], hat: EIGHTHS } },
    { id: 'four', name: 'Four on the floor', bar: { kick: [0, 4, 8, 12], clap: [4, 12], hat: [0, 4, 8, 12], openhat: [2, 6, 10, 14] } },
  ];
  const DRUM_VELOCITY = { kick: 0.95, snare: 0.85, clap: 0.8, hat: 0.5, openhat: 0.55, 'click-hi': 0.9, click: 0.7 };

  // Chord voicings start between E3 and G4, so they sit above the bass and
  // below a melody; bass notes are kept between E1 and D♯2, a bass guitar's first octave.
  const VOICE_LOW = 52;
  const VOICE_HIGH = 67;
  const VOICE_CENTRE = 62;
  const BASS_LOW = 28;
  const STRUM_GAP = 0.03;      // beats between the strings of a strum
  const STRUM = [[0, 'down', 0.9], [1, 'down', 0.7], [1.5, 'up', 0.55], [2.5, 'up', 0.55], [3, 'down', 0.7], [3.5, 'up', 0.55]];

  function mod12(n) {
    return ((n % 12) + 12) % 12;
  }

  function clampInt(v, lo, hi, fallback) {
    return Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
  }

  const has = (list, id) => list.some((x) => x.id === id);

  // ------------------------------------------------------------------ keys

  /** "E♭ major", "C♯ minor": the tonic spelled as its key signature does. */
  function keyName(tonic, mode) {
    return `${tonicName(tonic, mode)} ${mode}`;
  }

  function tonicName(tonic, mode) {
    return Tones.chordAt(mode === 'minor' ? 'minor' : 'major', tonic).rootName;
  }

  /** A chord's Roman numeral in a key: vi, ♭VII, V7, ii°, iiø7 … */
  function numeral(degree, chordId, mode) {
    const d = mod12(degree);
    const chord = Tones.chordById(chordId);
    let base = DEGREE_NUMERALS[mode][d];
    // A diminished chord a tritone up in major is the raised fourth's (♯iv°), and in minor the leading tone's (vii°).
    if (DIMINISHED.includes(chordId) && mode === 'major' && d === 6) base = '♯IV';
    if (DIMINISHED.includes(chordId) && mode === 'minor' && d === 11) base = 'VII';
    return (chord.minor ? base.toLowerCase() : base) + NUMERAL_SUFFIX[chordId];
  }

  /**
   * The chords that belong to a key, as triads or seventh chords. A minor key
   * also gets the major V of harmonic minor, which minor songs lean on.
   */
  function diatonic(mode, sevenths) {
    const m = MODES[mode];
    const list = m.scale.map((degree, i) => ({ degree, chord: (sevenths ? m.sevenths : m.triads)[i] }));
    if (mode === 'minor') list.push({ degree: 7, chord: sevenths ? '7' : 'major' });
    return list.map((c) => Object.assign(c, { numeral: numeral(c.degree, c.chord, mode) }));
  }

  function progressionById(id) {
    return PROGRESSIONS.find((p) => p.id === id) || null;
  }

  /** A famous progression as loop blocks. */
  function progressionBlocks(id) {
    const p = progressionById(id);
    return p ? p.chords.map(([degree, chord, beats]) => ({ degree, chord, beats: beats || BEATS_PER_BAR })) : [];
  }

  // --------------------------------------------------------------- voicing

  function unique(list) {
    return Array.from(new Set(list)).sort((a, b) => a - b);
  }

  /** A chord's notes in root position, the root between F3 and E4. */
  function rootPosition(rootPc, chordId) {
    let base = 48 + mod12(rootPc);
    if (base < 53) base += 12;
    return unique(Tones.chordById(chordId).intervals.map((i) => base + i));
  }

  /** Every inversion of a chord whose lowest note is in the voicing range. */
  function voicingCandidates(rootPc, chordId) {
    const intervals = Tones.chordById(chordId).intervals;
    const seen = new Set();
    const out = [];
    for (let k = 0; k < intervals.length; k++) {
      const shape = unique(intervals.map((iv, i) => iv + (i < k ? 12 : 0)));
      for (let base = mod12(rootPc); base < 90; base += 12) {
        const notes = shape.map((x) => base + x);
        const key = notes.join(',');
        if (notes[0] >= VOICE_LOW && notes[0] <= VOICE_HIGH && !seen.has(key)) {
          seen.add(key);
          out.push(notes);
        }
      }
    }
    return out;
  }

  // How far the notes of one voicing move to reach another: each note to its nearest note in the other, both ways.
  function movement(a, b) {
    const nearest = (x, ys) => Math.min.apply(null, ys.map((y) => Math.abs(x - y)));
    return a.reduce((s, x) => s + nearest(x, b), 0) + b.reduce((s, y) => s + nearest(y, a), 0);
  }

  const mean = (notes) => notes.reduce((s, x) => s + x, 0) / notes.length;

  /**
   * Voicings for a list of chords ({ rootPc, chord }). "smooth" starts in root
   * position and then picks, for each chord, the inversion that moves the
   * fewest semitones from the one before (voice leading), drifting back to
   * the middle when it can; "root" plays every chord in root position.
   */
  function voiceChords(chords, style) {
    const out = [];
    chords.forEach((c, i) => {
      if (style === 'root' || i === 0) {
        out.push(rootPosition(c.rootPc, c.chord));
        return;
      }
      const prev = out[i - 1];
      let best = null;
      let bestScore = Infinity;
      voicingCandidates(c.rootPc, c.chord).forEach((cand) => {
        const score = movement(cand, prev) + 0.3 * Math.abs(mean(cand) - VOICE_CENTRE);
        if (score < bestScore - 1e-9) {
          best = cand;
          bestScore = score;
        }
      });
      out.push(best || rootPosition(c.rootPc, c.chord));
    });
    return out;
  }

  /** The bass note for a root: between E1 and D♯2. */
  function bassNote(rootPc) {
    return BASS_LOW + mod12(rootPc - BASS_LOW);
  }

  // ---------------------------------------------------------- arrangement

  function upAndDown(notes) {
    return notes.length < 3 ? notes : notes.concat(notes.slice(1, -1).reverse());
  }

  /** The chord part of one block: its voicing played in a style. Times in beats. */
  function chordEvents(voicing, start, beats, style) {
    const out = [];
    const end = start + beats;
    const hit = (t, dur, vel, notes, gap) => notes.forEach((midi, i) => {
      const at = start + t + i * (gap || 0);
      if (at < end - 1e-9) out.push({ part: 'chords', t: at, dur: Math.min(dur, end - at), midi, vel });
    });
    if (style === 'held') {
      hit(0, beats, 0.8, voicing);
    } else if (style === 'quarters') {
      for (let b = 0; b < beats; b++) hit(b, 0.9, b % BEATS_PER_BAR === 0 ? 0.85 : 0.7, voicing);
    } else if (style === 'eighths') {
      for (let s = 0; s < beats * 2; s++) hit(s / 2, 0.45, s % 2 ? 0.55 : 0.75, voicing);
    } else if (style === 'strum') {
      // Down, down-up, up-down-up: a down strum starts on the lowest string, an up strum on the highest three.
      for (let bar = 0; bar < beats; bar += BEATS_PER_BAR) {
        STRUM.forEach(([t, dir, vel], k) => {
          const next = k + 1 < STRUM.length ? STRUM[k + 1][0] : BEATS_PER_BAR;
          const notes = dir === 'down' ? voicing : voicing.slice().reverse().slice(0, 3);
          hit(bar + t, next - t, vel, notes, STRUM_GAP);
        });
      }
    } else {
      const seq = style === 'arp-updown' ? upAndDown(voicing) : voicing;
      // One note at a time: played harder than a chord's notes, so the part keeps its level.
      for (let s = 0; s < beats * 2; s++) hit(s / 2, 0.5, s % 2 ? 0.8 : 0.95, [seq[s % seq.length]]);
    }
    return out;
  }

  /** The bass part of one block. */
  function bassEvents(root, start, beats, pattern) {
    const out = [];
    const note = (t, dur, midi, vel) => {
      if (t < beats - 1e-9) out.push({ part: 'bass', t: start + t, dur: Math.min(dur, beats - t), midi, vel });
    };
    if (pattern === 'held') note(0, beats, root, 0.85);
    else if (pattern === 'quarters') for (let b = 0; b < beats; b++) note(b, 0.9, root, b % BEATS_PER_BAR === 0 ? 0.9 : 0.75);
    else if (pattern === 'eighths') for (let s = 0; s < beats * 2; s++) note(s / 2, 0.45, root, s % 2 ? 0.6 : 0.8);
    else if (pattern === 'root-fifth') for (let b = 0; b < beats; b += 2) note(b, 1.9, b % 4 === 0 ? root : root + 7, 0.85);
    else if (pattern === 'octaves') for (let s = 0; s < beats * 2; s++) note(s / 2, 0.45, s % 2 ? root + 12 : root, s % 2 ? 0.65 : 0.85);
    return out;
  }

  /** The drum part: the pattern's bar over and over, cut where the loop ends. */
  function drumEvents(patternId, beats) {
    const pattern = DRUM_PATTERNS.find((p) => p.id === patternId);
    const out = [];
    if (!pattern) return out;
    for (let bar = 0; bar < beats; bar += BEATS_PER_BAR) {
      Object.keys(pattern.bar).forEach((drum) => pattern.bar[drum].forEach((step) => {
        const t = bar + step / 4;
        const accent = drum === 'hat' && step % 4 !== 0 ? 0.7 : 1;
        if (t < beats - 1e-9) out.push({ part: 'drums', t, dur: 0.25, drum, vel: DRUM_VELOCITY[drum] * accent });
      }));
    }
    return out;
  }

  /**
   * A loop as notes: { beats, blocks: [{ start, beats, rootPc, voicing, bass }],
   * events: [{ part, t, dur, midi | drum, vel }] } with times in beats, sorted.
   * Every part is arranged; whether a part is heard is up to the mix.
   */
  function arrange(loop) {
    const chords = loop.blocks.map((b) => ({ rootPc: mod12(loop.key.tonic + b.degree), chord: b.chord }));
    const voicings = voiceChords(chords, loop.voicing);
    const blocks = [];
    let events = [];
    let start = 0;
    loop.blocks.forEach((b, i) => {
      const bass = bassNote(chords[i].rootPc);
      blocks.push({ start, beats: b.beats, rootPc: chords[i].rootPc, chord: b.chord, voicing: voicings[i], bass });
      events = events.concat(chordEvents(voicings[i], start, b.beats, loop.style), bassEvents(bass, start, b.beats, loop.bass.pattern));
      start += b.beats;
    });
    events = events.concat(drumEvents(loop.drums.pattern, start));
    events.sort((a, b) => a.t - b.t);
    return { beats: start, blocks, events };
  }

  // ------------------------------------------------------------------ MIDI

  const PPQ = 480;
  const GM_DRUMS = { kick: 36, snare: 38, clap: 39, hat: 42, openhat: 46, 'click-hi': 76, click: 77 };
  const MIDI_PARTS = [
    { part: 'chords', name: 'Chords', channel: 0 },
    { part: 'bass', name: 'Bass', channel: 1 },
    { part: 'drums', name: 'Drums', channel: 9 },
  ];

  function vlq(n) {
    const bytes = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) bytes.unshift((v & 0x7f) | 0x80);
    return bytes;
  }

  const text = (s) => Array.from(new TextEncoder().encode(s));
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

  // A track chunk from [{ tick, order, bytes }]: at the same tick, note-offs (order 0) go before note-ons.
  function track(events, endTick) {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const data = [];
    let last = 0;
    events.forEach((e) => {
      data.push(...vlq(e.tick - last), ...e.bytes);
      last = e.tick;
    });
    data.push(...vlq(Math.max(0, endTick - last)), 0xff, 0x2f, 0x00);
    return [0x4d, 0x54, 0x72, 0x6b, ...u32(data.length), ...data];
  }

  /**
   * A standard MIDI file (type 1) of an arrangement, `repeats` times round:
   * a tempo track, then one track per part that is included, with the
   * General MIDI program of its sound; drums on channel 10.
   * options: { bpm, repeats, name, parts: { chords: program | null, bass: …, drums: true | null } }
   */
  function toMidi(arrangement, options) {
    const repeats = options.repeats || 1;
    const endTick = Math.round(arrangement.beats * repeats * PPQ);
    const tempo = Math.round(60000000 / options.bpm);
    const title = text(options.name || 'Chord loop');
    const tracks = [track([
      { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(title.length), ...title] },
      { tick: 0, order: 1, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] },
      { tick: 0, order: 2, bytes: [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] },
    ], endTick)];
    MIDI_PARTS.forEach(({ part, name, channel }) => {
      const program = options.parts[part];
      if (program === null || program === undefined) return;
      const events = [{ tick: 0, order: -2, bytes: [0xff, 0x03, ...vlq(text(name).length), ...text(name)] }];
      if (part !== 'drums') events.push({ tick: 0, order: -1, bytes: [0xc0 | channel, program & 0x7f] });
      for (let r = 0; r < repeats; r++) {
        arrangement.events.forEach((e) => {
          if (e.part !== part) return;
          const key = part === 'drums' ? GM_DRUMS[e.drum] : e.midi;
          const on = Math.round((e.t + r * arrangement.beats) * PPQ);
          const off = Math.max(on + 1, Math.round((e.t + e.dur + r * arrangement.beats) * PPQ));
          const vel = Math.max(1, Math.min(127, Math.round(e.vel * 127)));
          events.push({ tick: on, order: 1, bytes: [0x90 | channel, key, vel] });
          events.push({ tick: off, order: 0, bytes: [0x80 | channel, key, 0] });
        });
      }
      tracks.push(track(events, endTick));
    });
    const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (PPQ >> 8) & 255, PPQ & 255];
    return Uint8Array.from(header.concat(...tracks));
  }

  // ------------------------------------------------------------------- ZIP

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * A ZIP archive holding files as they are (WAV doesn't compress much, so
   * nothing is compressed). files: [{ name, data: Uint8Array }].
   */
  function zip(files, date) {
    const d = date || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const le16 = (n) => [n & 255, (n >> 8) & 255];
    const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach((f) => {
      const name = text(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      // version 2.0, UTF-8 names, stored
      const common = [...le16(20), ...le16(0x0800), ...le16(0), ...le16(time), ...le16(day), ...le32(crc), ...le32(size), ...le32(size), ...le16(name.length)];
      const local = Uint8Array.from([...le32(0x04034b50), ...common, ...le16(0), ...name]);
      central.push(...le32(0x02014b50), ...le16(20), ...common, ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...name);
      parts.push(local, f.data);
      offset += local.length + size;
    });
    const end = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length), ...le32(central.length), ...le32(offset), ...le16(0)];
    parts.push(Uint8Array.from(central), Uint8Array.from(end));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    parts.forEach((p) => {
      out.set(p, pos);
      pos += p.length;
    });
    return out;
  }

  // -------------------------------------------------------------- settings

  function defaultLoop() {
    return {
      key: { tonic: 0, mode: 'major' },
      sevenths: false,
      blocks: progressionBlocks('pop'),
      style: 'eighths',
      voicing: 'smooth',
      chords: { on: true, sound: 'piano', volume: 0.8 },
      bass: { on: true, pattern: 'held', sound: 'finger-bass', volume: 0.8 },
      drums: { on: true, pattern: 'pop', volume: 0.7 },
      repeats: 2,
    };
  }

  /**
   * A stored loop, repaired: anything missing or out of range gets its
   * default. `sounds` lists the sound ids that exist.
   */
  function normaliseLoop(stored, sounds) {
    const d = defaultLoop();
    const s = stored && typeof stored === 'object' ? stored : {};
    const obj = (v) => (v && typeof v === 'object' ? v : {});
    const volume = (v, fallback) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : fallback);
    const sound = (v, fallback) => (sounds.includes(v) ? v : fallback);
    const key = obj(s.key);
    const chords = obj(s.chords);
    const bass = obj(s.bass);
    const drums = obj(s.drums);
    const blocks = Array.isArray(s.blocks)
      ? s.blocks
        .filter((b) => b && Number.isInteger(b.degree) && b.degree >= 0 && b.degree < 12 && Tones.chordById(b.chord))
        .slice(0, MAX_BLOCKS)
        .map((b) => ({ degree: b.degree, chord: b.chord, beats: clampInt(b.beats, MIN_BEATS, MAX_BEATS, BEATS_PER_BAR) }))
      : d.blocks;
    return {
      key: { tonic: clampInt(key.tonic, 0, 11, 0), mode: MODES[key.mode] ? key.mode : 'major' },
      sevenths: s.sevenths === true,
      blocks,
      style: has(STYLES, s.style) ? s.style : d.style,
      voicing: has(VOICINGS, s.voicing) ? s.voicing : d.voicing,
      chords: { on: chords.on !== false, sound: sound(chords.sound, d.chords.sound), volume: volume(chords.volume, d.chords.volume) },
      bass: {
        on: bass.on !== false,
        pattern: has(BASS_PATTERNS, bass.pattern) ? bass.pattern : d.bass.pattern,
        sound: sound(bass.sound, d.bass.sound),
        volume: volume(bass.volume, d.bass.volume),
      },
      drums: { on: drums.on !== false, pattern: has(DRUM_PATTERNS, drums.pattern) ? drums.pattern : d.drums.pattern, volume: volume(drums.volume, d.drums.volume) },
      repeats: REPEATS.includes(s.repeats) ? s.repeats : d.repeats,
    };
  }

  /** Saved progressions, repaired: [{ id, name, bpm, loop }]. */
  function normaliseSongs(stored, sounds) {
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && s.name.trim())
      .slice(0, MAX_SONGS)
      .map((s) => ({
        id: s.id,
        name: s.name.trim().slice(0, 60),
        bpm: typeof s.bpm === 'number' && s.bpm >= 20 && s.bpm <= 300 ? s.bpm : 120,
        loop: normaliseLoop(s.loop, sounds),
      }));
  }

  return {
    BEATS_PER_BAR, MIN_BEATS, MAX_BEATS, MAX_BLOCKS, REPEATS, PPQ, GM_DRUMS,
    PROGRESSIONS, STYLES, VOICINGS, BASS_PATTERNS, DRUM_PATTERNS,
    keyName, tonicName, numeral, diatonic, progressionById, progressionBlocks,
    rootPosition, voiceChords, movement, bassNote, chordEvents, bassEvents, drumEvents, arrange,
    toMidi, crc32, zip, defaultLoop, normaliseLoop, normaliseSongs,
  };
});
