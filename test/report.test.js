'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../pitch.js'); // Report uses it for note names, when present
const Report = require('../report.js');

/** A clean take, with fields overridden per test. */
function result(overrides) {
  const base = {
    sampleRate: 48000,
    samples: 48000 * 30,
    duration: 30,
    truncated: false,
    layout: 'mono',
    layoutDetail: { channels: 1 },
    silenceSeconds: 0,
    peak: { db: -14, linear: 0.2, t: 12.3 },
    truePeak: { db: -13.8, linear: 0.204 },
    rms: { db: -28 },
    crest: { db: 14 },
    noiseFloor: { db: -72, blocks: 150, silentBlocks: 0, blockSeconds: 0.2 },
    snr: { db: 58 },
    noiseAtMix: { db: -61 },
    loudness: { lufs: -20, blocks: 297, gatedBlocks: 200, channels: 1 },
    clipping: { count: 0, samples: 0, runs: 0, events: [] },
    dropouts: { zeroRuns: { count: 0, events: [] }, jumps: { count: 0, events: [] } },
    dc: { offset: 0.0001, db: -80 },
    subsonic: { peakDb: -60, rmsDb: -75 },
    plosives: { count: 0, events: [] },
    sibilance: { loudFrames: 400, flaggedFrames: 6, share: 0.015, maxRatioDb: -3, count: 4, events: [{ t: 1, end: 1.05, ratioDb: -3, db: -20 }] },
    hum: { mains: null, hits: 0, excessDb: 2, levelDb: -Infinity, harmonics: [], measuredOn: 'quiet', quietSeconds: 8, resolutionHz: 2.9 },
    balance: [[20, 80], [80, 160], [160, 320], [320, 640], [640, 1250], [1250, 2500], [2500, 5000], [5000, 10000], [10000, 20000]]
      .map(([lo, hi], i) => ({ lo, hi, percent: [1, 8, 40, 25, 15, 7, 3, 1, 0][i], db: -40 })),
    pitch: { tonal: true, frames: 500, hopSeconds: 0.06, loudFrames: 300, voicedFrames: 280, voicedRatio: 0.93, track: new Float32Array(500).fill(220), clarity: new Float32Array(500), lowHz: 196, highHz: 392, medianHz: 261, wobbleCents: 9 },
    elapsedMs: 400,
  };
  return Object.assign(base, overrides || {});
}

const item = (report, id) => report.headline.concat(report.items).find((i) => i.id === id);

test('formatting helpers', () => {
  assert.equal(Report.fmtDb(-12.34), '−12.3 dBFS');
  assert.equal(Report.fmtDb(-0.001), '0.0 dBFS');
  assert.equal(Report.fmtDb(3.2, 'dB'), '3.2 dB');
  assert.equal(Report.fmtDb(-Infinity, 'LUFS'), 'silent');
  assert.equal(Report.fmtTime(0), '0:00.0');
  assert.equal(Report.fmtTime(75.26), '1:15.3');
  assert.equal(Report.fmtRange(160, 320), '160–320 Hz');
  assert.equal(Report.fmtRange(5000, 10000), '5–10 kHz');
  assert.equal(Report.noteLabel(440), 'A4');
});

test('a clean take is all green with nothing to do', () => {
  const r = Report.build(result());
  assert.equal(r.headline.length, 2);
  assert.equal(r.headline[0].id, 'snr');
  assert.equal(r.headline[1].id, 'noise-at-mix');
  for (const i of r.headline.concat(r.items)) {
    assert.ok(['good', 'info'].includes(i.status), `${i.id} is ${i.status}`);
    assert.ok(i.value && i.target && i.explanation.length >= 2, `${i.id} is incomplete`);
  }
  assert.equal(r.summary.allGood, true);
  assert.equal(r.summary.status, 'good');
  assert.equal(r.summary.actions.length, 0);
  assert.match(r.summary.intro, /Nothing to fix/);
});

test('SNR and noise-at-mix thresholds', () => {
  const at = (snr) => item(Report.build(result({ snr: { db: snr }, noiseAtMix: { db: -3 - snr } })), 'snr');
  assert.equal(at(35).status, 'bad');
  assert.equal(at(45).status, 'warn');
  assert.equal(at(55).status, 'good');
  assert.equal(at(65).note, 'very good');

  const mix = (db) => item(Report.build(result({ noiseAtMix: { db } })), 'noise-at-mix').status;
  assert.equal(mix(-45), 'bad');
  assert.equal(mix(-55), 'warn');
  assert.equal(mix(-65), 'good');
});

test('peak thresholds and their actions', () => {
  const peak = (db) => Report.build(result({ peak: { db, linear: 0, t: 0 } }));
  assert.equal(item(peak(-15), 'peak').status, 'good');
  assert.equal(item(peak(-20), 'peak').status, 'warn');
  assert.equal(item(peak(-30), 'peak').status, 'bad');
  assert.equal(item(peak(-3), 'peak').status, 'bad');
  assert.match(peak(-30).summary.actions[0].title, /gain/i);
  assert.match(peak(-3).summary.actions[0].title, /headroom/i);
});

test('a quiet, noisy take is told to record louder; a loud, noisy one to fix the noise', () => {
  const quiet = Report.build(result({ peak: { db: -26, linear: 0, t: 0 }, noiseFloor: { db: -66, blocks: 1, silentBlocks: 0, blockSeconds: 0.2 }, snr: { db: 40 }, noiseAtMix: { db: -43 } }));
  assert.match(quiet.summary.actions[0].title, /Record louder/);
  assert.equal(quiet.summary.actions.filter((a) => /gain you have/.test(a.title)).length, 0, 'no duplicate gain advice');

  const noisy = Report.build(result({ peak: { db: -12, linear: 0, t: 0 }, noiseFloor: { db: -52, blocks: 1, silentBlocks: 0, blockSeconds: 0.2 }, snr: { db: 40 }, noiseAtMix: { db: -43 } }));
  assert.match(noisy.summary.actions[0].title, /Reduce the noise/);
  assert.match(noisy.summary.actions[0].text, /more gain will not help/);
});

test('clipping is a problem and comes first', () => {
  const r = Report.build(result({
    peak: { db: 0, linear: 1, t: 4 },
    truePeak: { db: 0.8, linear: 1.1 },
    snr: { db: 42 },
    noiseAtMix: { db: -45 },
    clipping: { count: 3, samples: 200, runs: 7, events: [{ t: 4, end: 4.1, samples: 120, runs: 4, channel: 0 }, { t: 9, end: 9.02, samples: 80, runs: 3, channel: 0 }] },
    dropouts: { zeroRuns: { count: 1, events: [{ t: 20, end: 20.01, samples: 400 }] }, jumps: { count: 0, events: [] } },
  }));
  const clip = item(r, 'clipping');
  assert.equal(clip.status, 'bad');
  assert.equal(clip.events.length, 2);
  assert.equal(clip.eventsTotal, 3);
  assert.equal(r.summary.status, 'bad');
  assert.match(r.summary.actions[0].title, /gain down/);
  assert.match(r.summary.actions[1].title, /dropouts/);
  assert.match(r.summary.actions[2].title, /noise/i);
  // Peaks at 0 dBFS do not get a separate "headroom" action on top of the clipping one.
  assert.equal(r.summary.actions.filter((a) => /headroom/.test(a.title)).length, 0);
  assert.equal(item(r, 'true-peak').note, 'above the master limit');
});

test('jumps alone are borderline and ask for a listen', () => {
  const r = Report.build(result({ dropouts: { zeroRuns: { count: 0, events: [] }, jumps: { count: 2, events: [{ t: 3, size: 0.2 }, { t: 7, size: 0.1 }] } } }));
  assert.equal(item(r, 'dropouts').status, 'warn');
  assert.equal(item(r, 'dropouts').events.length, 2);
  assert.match(r.summary.actions[0].title, /Listen/);
});

test('plosives, rumble, sibilance, hum, DC offset and compression each get advice', () => {
  const r = Report.build(result({
    subsonic: { peakDb: -35, rmsDb: -55 },
    plosives: { count: 2, events: [{ t: 5, end: 5.1, db: -30 }, { t: 15, end: 15.1, db: -35 }] },
    sibilance: { loudFrames: 400, flaggedFrames: 40, share: 0.1, maxRatioDb: 1, count: 20, events: [] },
    hum: { mains: 60, hits: 3, excessDb: 18, levelDb: -58, harmonics: [{ hz: 60, excessDb: 18, levelDb: -58, hit: true }], measuredOn: 'all', quietSeconds: 0, resolutionHz: 2.9 },
    dc: { offset: -0.02, db: -34 },
    crest: { db: 4.5 },
  }));
  assert.equal(item(r, 'subsonic').status, 'warn');
  assert.equal(item(r, 'plosives').status, 'warn');
  assert.equal(item(r, 'sibilance').status, 'warn');
  assert.equal(item(r, 'hum').status, 'bad');
  assert.match(item(r, 'hum').value, /^60 Hz/);
  assert.match(item(r, 'hum').explanation[0].text, /no quiet passages/);
  assert.equal(item(r, 'dc').status, 'bad');
  assert.equal(item(r, 'crest').status, 'warn');
  const titles = r.summary.actions.map((a) => a.title).join(' | ');
  assert.match(titles, /Pop filter/);
  assert.match(titles, /S sounds/);
  assert.match(titles, /60 Hz hum/);
  assert.match(titles, /DC offset/);
  assert.match(titles, /without compression/);
  assert.equal(r.summary.allGood, false);
});

test('plosives become a problem when frequent', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ t: i * 2, end: i * 2 + 0.1, db: -30 }));
  const r = Report.build(result({ plosives: { count: 12, events: many.slice(0, 10) } }));
  assert.equal(item(r, 'plosives').status, 'bad');
  assert.equal(item(r, 'plosives').events.length, 10);
  assert.equal(item(r, 'plosives').eventsTotal, 12);
});

test('the pitch section is hidden when the material is not tonal, hum when the file is too short', () => {
  const r = Report.build(result({ pitch: { tonal: false, voicedRatio: 0.1 }, hum: null }));
  assert.equal(item(r, 'pitch'), undefined);
  assert.equal(item(r, 'hum').status, 'info');
  assert.equal(Report.build(result({ pitch: null })).items.some((i) => i.id === 'pitch'), false);
  const p = item(Report.build(result()), 'pitch');
  assert.match(p.value, /^G3 – G4/);
  assert.equal(p.chart.type, 'pitch');
});

test('information-only items say so and the balance chart names the dominant band', () => {
  const r = Report.build(result());
  for (const id of ['true-peak', 'rms', 'loudness', 'balance', 'pitch']) assert.equal(item(r, id).status, 'info');
  assert.match(item(r, 'balance').value, /160–320 Hz \(40 %\)/);
  assert.equal(item(r, 'balance').chart.bands.length, 9);
  assert.match(item(r, 'loudness').explanation[1].text, /mono file/);
  assert.equal(item(Report.build(result({ loudness: { lufs: -20, blocks: 1, gatedBlocks: 1, channels: 2 } })), 'loudness').explanation[1].text.includes('mono file'), false);
});

test('digital silence and gating are mentioned on the noise floor', () => {
  const r = Report.build(result({ noiseFloor: { db: -72, blocks: 150, silentBlocks: 20, blockSeconds: 0.2 } }));
  assert.match(item(r, 'noise-floor').explanation[3].text, /4\.0 s of the file are pure digital silence/);
});
