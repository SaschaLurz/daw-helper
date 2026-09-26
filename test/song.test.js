'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Song = require('../song.js');
const Tones = require('../tones.js');

const SOUNDS = ['soft', 'piano', 'e-piano', 'finger-bass', 'synth-bass'];
const loopWith = (changes) => Object.assign(Song.normaliseLoop({}, SOUNDS), changes);
const names = (midis) => midis.map((m) => Tones.NAMES[m % 12] + Tones.octaveOf(m));

test('keys are named as their key signatures spell them', () => {
  assert.equal(Song.keyName(0, 'major'), 'C major');
  assert.equal(Song.keyName(3, 'major'), 'E♭ major');
  assert.equal(Song.keyName(1, 'major'), 'D♭ major');
  assert.equal(Song.keyName(1, 'minor'), 'C♯ minor');
  assert.equal(Song.keyName(8, 'minor'), 'G♯ minor');
  assert.equal(Song.keyName(10, 'minor'), 'B♭ minor');
});

test('Roman numerals: case for quality, accidentals for chords outside the key', () => {
  assert.equal(Song.numeral(0, 'major', 'major'), 'I');
  assert.equal(Song.numeral(9, 'minor', 'major'), 'vi');
  assert.equal(Song.numeral(7, '7', 'major'), 'V7');
  assert.equal(Song.numeral(2, 'm7', 'major'), 'ii7');
  assert.equal(Song.numeral(11, 'dim', 'major'), 'vii°');
  assert.equal(Song.numeral(11, 'm7b5', 'major'), 'viiø7');
  assert.equal(Song.numeral(10, 'major', 'major'), '♭VII');
  assert.equal(Song.numeral(8, 'major', 'major'), '♭VI');
  assert.equal(Song.numeral(3, 'maj7', 'major'), '♭IIImaj7');
  assert.equal(Song.numeral(6, 'dim', 'major'), '♯iv°');
  assert.equal(Song.numeral(0, 'minor', 'minor'), 'i');
  assert.equal(Song.numeral(10, 'major', 'minor'), 'VII');       // minor keys number from their own scale
  assert.equal(Song.numeral(8, 'major', 'minor'), 'VI');
  assert.equal(Song.numeral(7, 'major', 'minor'), 'V');
  assert.equal(Song.numeral(11, 'dim7', 'minor'), 'vii°7');       // the leading tone of harmonic minor
  assert.equal(Song.numeral(4, 'major', 'minor'), '♮III');
  assert.equal(Song.numeral(0, 'aug', 'major'), 'I+');
  assert.equal(Song.numeral(5, 'mmaj7', 'major'), 'ivmaj7');
});

test('each key offers its own chords, and a minor key its major V too', () => {
  assert.deepEqual(Song.diatonic('major', false).map((c) => c.numeral), ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
  assert.deepEqual(Song.diatonic('major', true).map((c) => c.numeral), ['Imaj7', 'ii7', 'iii7', 'IVmaj7', 'V7', 'vi7', 'viiø7']);
  assert.deepEqual(Song.diatonic('minor', false).map((c) => c.numeral), ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII', 'V']);
  assert.deepEqual(Song.diatonic('minor', true).map((c) => c.numeral), ['i7', 'iiø7', 'IIImaj7', 'iv7', 'v7', 'VImaj7', 'VII7', 'V7']);
  // In E♭ major the chords are the ones musicians expect.
  const symbols = Song.diatonic('major', false).map((c) => Tones.chordAt(c.chord, (3 + c.degree) % 12).symbol);
  assert.deepEqual(symbols, ['E♭', 'Fm', 'Gm', 'A♭', 'B♭', 'Cm', 'Ddim']);
});

test('famous progressions load as blocks, a bar each unless said otherwise', () => {
  assert.deepEqual(Song.progressionBlocks('pop'), [
    { degree: 0, chord: 'major', beats: 4 }, { degree: 7, chord: 'major', beats: 4 },
    { degree: 9, chord: 'minor', beats: 4 }, { degree: 5, chord: 'major', beats: 4 },
  ]);
  const blues = Song.progressionBlocks('blues');
  assert.equal(blues.reduce((s, b) => s + b.beats, 0), 48);   // twelve bars
  const ids = new Set();
  for (const p of Song.PROGRESSIONS) {
    assert.ok(!ids.has(p.id), p.id);
    ids.add(p.id);
    assert.ok(p.mode === 'major' || p.mode === 'minor', p.id);
    Song.progressionBlocks(p.id).forEach((b) => {
      assert.ok(Tones.chordById(b.chord), `${p.id}: ${b.chord}`);
      assert.ok(b.beats >= Song.MIN_BEATS && b.beats <= Song.MAX_BEATS, p.id);
    });
    // The name's numerals are the chords' numerals.
    const numerals = Song.progressionBlocks(p.id).map((b) => Song.numeral(b.degree, b.chord, p.mode));
    if (p.id !== 'blues') assert.ok(p.name.endsWith(Array.from(new Set(numerals)).length === numerals.length ? numerals.join('–') : p.name.split(' · ')[1]), `${p.id}: ${numerals.join('–')}`);
  }
});

test('smooth voicing moves as little as it can; root position jumps', () => {
  const chords = [[0, 'major'], [7, 'major'], [9, 'minor'], [5, 'major']].map(([rootPc, chord]) => ({ rootPc, chord }));
  const smooth = Song.voiceChords(chords, 'smooth');
  const root = Song.voiceChords(chords, 'root');
  assert.deepEqual(names(smooth[0]), ['C4', 'E4', 'G4']);
  assert.deepEqual(names(root[1]), ['G3', 'B3', 'D4']);
  // The textbook voice leading: common tones stay, the others step.
  assert.deepEqual(smooth.map(names), [['C4', 'E4', 'G4'], ['B3', 'D4', 'G4'], ['C4', 'E4', 'A4'], ['C4', 'F4', 'A4']]);
  const travel = (vs) => vs.slice(1).reduce((s, v, i) => s + Song.movement(v, vs[i]), 0);
  assert.ok(travel(smooth) < travel(root), `${travel(smooth)} vs ${travel(root)}`);
  const jazz = Song.voiceChords([[2, 'm7'], [7, '7'], [0, 'maj7']].map(([rootPc, chord]) => ({ rootPc, chord })), 'smooth');
  assert.deepEqual(jazz.map(names), [['D4', 'F4', 'A4', 'C5'], ['D4', 'F4', 'G4', 'B4'], ['E4', 'G4', 'B4', 'C5']]);
  // Every chord is complete and sits between E3 and the top of the treble staff.
  smooth.forEach((v, i) => {
    assert.deepEqual(Array.from(new Set(v.map((m) => m % 12))).sort(), Tones.chordAt(chords[i].chord, chords[i].rootPc).names
      .map((n, pc) => (n ? pc : null)).filter((pc) => pc !== null).sort());
    assert.ok(v[0] >= 52 && v[v.length - 1] <= 84, names(v).join(' '));
  });
  // A long progression doesn't creep up or down the keyboard.
  const long = Song.voiceChords(Array.from({ length: 40 }, (_, i) => chords[i % 4]), 'smooth');
  long.forEach((v) => assert.ok(v[0] >= 52 && v[0] <= 67));
});

test('bass notes sit in a bass guitar’s first octave', () => {
  assert.equal(Song.bassNote(4), 28);    // E1
  assert.equal(Song.bassNote(3), 39);    // D♯2
  assert.equal(Song.bassNote(0), 36);    // C2
  assert.equal(Song.bassNote(9), 33);    // A1
});

test('playing styles spread the chord over the block and stop at its end', () => {
  const v = [60, 64, 67];
  const held = Song.chordEvents(v, 4, 4, 'held');
  assert.deepEqual(held.map((e) => [e.t, e.dur, e.midi]), [[4, 4, 60], [4, 4, 64], [4, 4, 67]]);
  assert.equal(Song.chordEvents(v, 0, 4, 'quarters').length, 12);
  assert.equal(Song.chordEvents(v, 0, 2, 'eighths').length, 12);
  const strum = Song.chordEvents(v, 0, 4, 'strum');
  const downs = strum.filter((e) => e.t < 0.1).map((e) => e.midi);
  assert.deepEqual(downs, [60, 64, 67]);                                  // a down strum goes low to high…
  const up = strum.filter((e) => e.t >= 1.5 && e.t < 1.6).map((e) => e.midi);
  assert.deepEqual(up, [67, 64, 60]);                                     // …an up strum high to low
  assert.ok(strum.every((e) => e.t + e.dur <= 4 + 1e-9));
  const arp = Song.chordEvents(v, 0, 4, 'arp-updown').map((e) => e.midi);
  assert.deepEqual(arp, [60, 64, 67, 64, 60, 64, 67, 64]);
  // A one-beat block cuts every style short.
  for (const s of Song.STYLES) Song.chordEvents(v, 8, 1, s.id).forEach((e) => assert.ok(e.t >= 8 && e.t + e.dur <= 9 + 1e-9, s.id));
});

test('bass patterns and drum grooves', () => {
  assert.deepEqual(Song.bassEvents(33, 0, 4, 'root-fifth').map((e) => [e.t, e.midi]), [[0, 33], [2, 40]]);
  assert.deepEqual(Song.bassEvents(33, 0, 1, 'octaves').map((e) => e.midi), [33, 45]);
  assert.deepEqual(Song.bassEvents(33, 0, 4, 'off'), []);
  const pop = Song.drumEvents('pop', 8);
  assert.deepEqual(pop.filter((e) => e.drum === 'snare').map((e) => e.t), [1, 3, 5, 7]);
  assert.ok(pop.filter((e) => e.drum === 'hat' && e.t % 1 === 0).every((e) => e.vel > pop.find((h) => h.drum === 'hat' && h.t === 0.5).vel));
  assert.ok(Song.drumEvents('four', 6).every((e) => e.t < 6));             // cut where the loop ends
  for (const p of Song.DRUM_PATTERNS) Song.drumEvents(p.id, 4).forEach((e) => assert.ok(Song.GM_DRUMS[e.drum], `${p.id}: ${e.drum}`));
});

test('a loop arranges into sorted notes, relative to its key', () => {
  const loop = loopWith({ key: { tonic: 2, mode: 'major' }, style: 'held', bass: { on: true, pattern: 'held', sound: 'finger-bass', volume: 1 }, drums: { on: true, pattern: 'off', volume: 1 } });
  const a = Song.arrange(loop);
  assert.equal(a.beats, 16);
  assert.deepEqual(a.blocks.map((b) => b.start), [0, 4, 8, 12]);
  assert.deepEqual(a.blocks.map((b) => b.rootPc), [2, 9, 11, 7]);         // D–A–Bm–G: I–V–vi–IV in D
  assert.deepEqual(a.events.filter((e) => e.part === 'bass').map((e) => e.midi), [38, 33, 35, 31]);
  a.events.forEach((e, i) => assert.ok(i === 0 || e.t >= a.events[i - 1].t));
  assert.deepEqual(Song.arrange(loopWith({ blocks: [] })), { beats: 0, blocks: [], events: [] });
});

// A small reader for the MIDI files the tests write.
function readMidi(bytes) {
  const b = Buffer.from(bytes);
  assert.equal(b.toString('latin1', 0, 4), 'MThd');
  const header = { format: b.readUInt16BE(8), tracks: b.readUInt16BE(10), ppq: b.readUInt16BE(12) };
  const tracks = [];
  let pos = 14;
  for (let t = 0; t < header.tracks; t++) {
    assert.equal(b.toString('latin1', pos, pos + 4), 'MTrk');
    const end = pos + 8 + b.readUInt32BE(pos + 4);
    let i = pos + 8;
    let tick = 0;
    const events = [];
    const vlq = () => {
      let n = 0;
      let byte;
      do { byte = b[i++]; n = (n << 7) | (byte & 0x7f); } while (byte & 0x80);
      return n;
    };
    while (i < end) {
      tick += vlq();
      const status = b[i++];
      if (status === 0xff) {
        const type = b[i++];
        const len = vlq();
        events.push({ tick, meta: type, data: b.subarray(i, i + len) });
        i += len;
      } else {
        const len = (status & 0xf0) === 0xc0 ? 1 : 2;
        events.push({ tick, status, data: Array.from(b.subarray(i, i + len)) });
        i += len;
      }
    }
    assert.equal(i, end);
    tracks.push(events);
    pos = end;
  }
  return { header, tracks };
}

test('MIDI export: tempo, one track per part, notes that match the loop', () => {
  const loop = loopWith({ style: 'held', drums: { on: true, pattern: 'pop', volume: 1 } });
  const a = Song.arrange(loop);
  const midi = readMidi(Song.toMidi(a, { bpm: 96, repeats: 2, name: 'Verse idea', parts: { chords: 0, bass: 33, drums: true } }));
  assert.deepEqual(midi.header, { format: 1, tracks: 4, ppq: Song.PPQ });
  const [conductor, chords, bass, drums] = midi.tracks;
  const tempo = conductor.find((e) => e.meta === 0x51).data;
  assert.equal((tempo[0] << 16) | (tempo[1] << 8) | tempo[2], 625000);   // 96 bpm
  assert.equal(Buffer.from(conductor.find((e) => e.meta === 0x03).data).toString(), 'Verse idea');
  assert.deepEqual(chords.find((e) => e.status === 0xc0).data, [0]);
  assert.deepEqual(bass.find((e) => e.status === 0xc1).data, [33]);
  const ons = (track) => track.filter((e) => (e.status & 0xf0) === 0x90);
  assert.equal(ons(chords).length, 2 * a.events.filter((e) => e.part === 'chords').length);
  assert.equal(ons(bass)[4].tick, 16 * Song.PPQ);                         // the second time round starts after 16 beats
  assert.ok(ons(drums).every((e) => e.status === 0x99));                  // drums on channel 10
  assert.ok(ons(drums).some((e) => e.data[0] === 38));                    // GM snare
  // Every note ends, after it starts, and every track ends with the loop.
  for (const track of midi.tracks.slice(1)) {
    const open = new Map();
    track.forEach((e) => {
      const kind = e.status & 0xf0;
      if (kind === 0x90) open.set(e.data[0], (open.get(e.data[0]) || 0) + 1);
      if (kind === 0x80) open.set(e.data[0], open.get(e.data[0]) - 1);
    });
    assert.ok(Array.from(open.values()).every((n) => n === 0));
    assert.equal(track[track.length - 1].meta, 0x2f);
    assert.equal(track[track.length - 1].tick, 32 * Song.PPQ);
  }
  // Parts left out of the export get no track.
  assert.equal(readMidi(Song.toMidi(a, { bpm: 96, repeats: 1, parts: { chords: 0, bass: null, drums: null } })).header.tracks, 2);
});

test('ZIP: a known checksum, and archives that read back', () => {
  assert.equal(Song.crc32(Buffer.from('123456789')), 0xcbf43926);
  const files = [{ name: 'Chords.wav', data: Uint8Array.from([1, 2, 3]) }, { name: 'Bässe.wav', data: new Uint8Array(1000).fill(7) }];
  const bytes = Buffer.from(Song.zip(files, new Date(2026, 8, 26, 12, 30, 10)));
  // Walk the local headers, then check the end record points at the central directory.
  let pos = 0;
  files.forEach((f) => {
    assert.equal(bytes.readUInt32LE(pos), 0x04034b50);
    assert.equal(bytes.readUInt16LE(pos + 8), 0);                          // stored
    assert.equal(bytes.readUInt32LE(pos + 14), Song.crc32(f.data));
    const size = bytes.readUInt32LE(pos + 18);
    const nameLength = bytes.readUInt16LE(pos + 26);
    assert.equal(bytes.toString('utf8', pos + 30, pos + 30 + nameLength), f.name);
    assert.deepEqual(Array.from(bytes.subarray(pos + 30 + nameLength, pos + 30 + nameLength + size)), Array.from(f.data));
    pos += 30 + nameLength + size;
  });
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 10), 2);
  assert.equal(bytes.readUInt32LE(end + 16), pos);                         // the central directory follows the files
  assert.equal(bytes.readUInt32LE(pos), 0x02014b50);
});

test('stored loops and songs are repaired rather than trusted', () => {
  const fresh = Song.normaliseLoop(undefined, SOUNDS);
  assert.equal(fresh.blocks.length, 4);
  assert.equal(fresh.chords.sound, 'piano');
  const repaired = Song.normaliseLoop({
    key: { tonic: 14, mode: 'dorian' }, blocks: [{ degree: 3, chord: 'maj7', beats: 99 }, { degree: 12, chord: 'major' }, { degree: 2, chord: 'nope' }, null],
    style: 'polka', chords: { sound: 'kazoo', volume: 3 }, bass: { pattern: 'walking', on: false }, drums: { pattern: 'four' }, repeats: 3,
  }, SOUNDS);
  assert.deepEqual(repaired.key, { tonic: 0, mode: 'major' });
  assert.deepEqual(repaired.blocks, [{ degree: 3, chord: 'maj7', beats: 4 }]);
  assert.equal(repaired.style, 'eighths');
  assert.deepEqual(repaired.chords, { on: true, sound: 'piano', volume: 0.8 });
  assert.equal(repaired.bass.on, false);
  assert.equal(repaired.bass.pattern, 'held');
  assert.equal(repaired.drums.pattern, 'four');
  assert.equal(repaired.repeats, 2);
  assert.deepEqual(Song.normaliseLoop({ blocks: [] }, SOUNDS).blocks, []);   // an emptied loop stays empty
  const songs = Song.normaliseSongs([{ id: 'a', name: '  Verse  ', bpm: 500, loop: {} }, { id: 'b', name: ' ' }, 'x'], SOUNDS);
  assert.equal(songs.length, 1);
  assert.equal(songs[0].name, 'Verse');
  assert.equal(songs[0].bpm, 120);
  assert.deepEqual(Song.normaliseSongs(null, SOUNDS), []);
});
