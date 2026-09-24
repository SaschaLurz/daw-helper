/*
 * report.js — turns the raw numbers from analysis.js into the report the page
 * shows: a status for every measurement (good / warn / bad / info), the target
 * range, a plain-language explanation, and a prioritised list of things to do.
 *
 * The tool measures; it doesn't diagnose. It can't tell room noise from preamp
 * hiss, or a plosive from a low note, so the texts talk about possible causes
 * and say where a value depends on what was sung.
 *
 * Loaded as a plain <script> in the browser (window.Report) and via require()
 * in Node for the tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.Report = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SEVERITY = { good: 0, info: 0, warn: 1, bad: 2 };
  const STATUS_LABEL = { good: 'good', warn: 'borderline', bad: 'problem', info: 'info' };

  // ------------------------------------------------------------- formatting

  const minus = (s) => String(s).replace(/-/g, '−');

  function fmtNum(v, digits) {
    const fixed = v.toFixed(digits);
    return minus(Number(fixed) === 0 ? fixed.replace('-', '') : fixed); // no "−0.0"
  }

  function fmtDb(v, unit, digits) {
    if (v === null || v === undefined || !isFinite(v)) return unit === 'LUFS' ? 'silent' : `−∞ ${unit || 'dBFS'}`;
    return `${fmtNum(v, digits === undefined ? 1 : digits)} ${unit || 'dBFS'}`;
  }

  function fmtTime(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  }

  function fmtHz(hz) {
    return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${hz} Hz`;
  }

  function fmtRange(lo, hi) {
    if (hi < 1000) return `${lo}–${hi} Hz`;
    if (lo >= 1000) return `${lo / 1000}–${fmtHz(hi)}`;
    return `${fmtHz(lo)}–${fmtHz(hi)}`;
  }

  function noteLabel(hz) {
    const pitch = typeof Pitch !== 'undefined' ? Pitch : null;
    if (!pitch || !(hz > 0)) return '';
    const d = pitch.describe(hz, 440);
    return `${d.name}${d.octave}`;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

  // ------------------------------------------------------------------ items

  function snrItem(r) {
    const v = r.snr.db;
    const status = v < 40 ? 'bad' : v < 50 ? 'warn' : 'good';
    return {
      id: 'snr',
      label: 'Signal-to-noise ratio',
      value: fmtDb(v, 'dB'),
      target: '50 dB or more · 60+ is very good',
      status,
      note: v >= 60 ? 'very good' : status === 'good' ? 'good' : status === 'warn' ? 'borderline' : 'too little',
      explanation: [
        { lead: 'What it is', text: 'The distance between the loudest moment of the take and its background noise, in dB: peak level minus noise floor. It is the single best number for how clean a recording is.' },
        { lead: 'Too low', text: 'The noise is not far enough below the voice. Possible causes: the gain was set low so the voice barely rises above the interface’s own hiss; a noisy room (computer fan, air conditioning, traffic); a long distance to the microphone; or a microphone or preamp that hisses at high gain. The tool can’t tell which of these it is.' },
        { lead: 'What to do', text: 'Get the voice louder at the source before anything else: 10–20 cm from the mic, a quieter room, then raise the gain until the loudest phrase peaks around −12 dBFS. Noise-reduction plug-ins can help afterwards, but they always cost some quality.' },
      ],
    };
  }

  function noiseAtMixItem(r) {
    const v = r.noiseAtMix.db;
    const status = v > -50 ? 'bad' : v > -60 ? 'warn' : 'good';
    return {
      id: 'noise-at-mix',
      label: 'Noise at mix level',
      value: fmtDb(v),
      target: 'below −60 dBFS · above −50 is clearly audible',
      status,
      note: status === 'bad' ? 'clearly audible' : status === 'warn' ? 'audible in quiet passages' : 'mostly hidden by the music',
      explanation: [
        { lead: 'What it is', text: `In the mix this take will be turned up until its peaks sit near −3 dBFS. This is where the background noise ends up when that happens — the noise floor of ${fmtDb(r.noiseFloor.db)} moved up by the same ${fmtDb(-3 - r.peak.db, 'dB')} as the voice. Above about −50 dBFS the noise is clearly audible in quiet passages; below −60 it mostly disappears behind the music.` },
        { lead: 'Too high', text: 'Same story as a low signal-to-noise ratio: the noise sits too close to the voice. Turning the file up later does not help, because the noise comes up by exactly the same amount.' },
        { lead: 'What to do', text: 'Record louder at the source and in a quieter room. If the take can’t be redone, a gate or noise reduction on the pauses hides some of it.' },
      ],
    };
  }

  function peakItem(r) {
    const v = r.peak.db;
    let status = 'good';
    if (v < -24 || v > -6) status = 'bad';
    else if (v < -18 || v > -12) status = 'warn';
    return {
      id: 'peak',
      label: 'Peak',
      value: fmtDb(v),
      target: '−18 to −12 dBFS',
      status,
      note: v < -18 ? 'quiet' : v > -12 ? 'hot' : 'good',
      explanation: [
        { lead: 'What it is', text: `The loudest single sample in the file (at ${fmtTime(r.peak.t)}), in dBFS. 0 dBFS is the loudest value a digital file can hold.` },
        { lead: 'Too high', text: 'Above −6 dBFS you are close to the ceiling; a slightly louder phrase would clip. Above −1 dBFS the take very likely clipped already.' },
        { lead: 'Too low', text: 'Below −24 dBFS the voice sits closer to the interface’s hiss than it needs to. The file can be turned up later, but the hiss comes with it.' },
        { lead: 'What to do', text: 'Aim for peaks between −18 and −12 dBFS on the loudest phrase. Sing the loudest line as a test before the real take and set the gain from that, not from quiet talking.' },
      ],
    };
  }

  function truePeakItem(r) {
    const v = r.truePeak.db;
    const over = v - r.peak.db;
    return {
      id: 'true-peak',
      label: 'True peak',
      value: fmtDb(v, 'dBTP'),
      target: 'for information · masters stay at or below −1 dBTP',
      status: 'info',
      note: v > -1 ? 'above the master limit' : `${fmtDb(over, 'dB')} above the sample peak`,
      explanation: [
        { lead: 'What it is', text: 'The peak after the waveform is reconstructed between the samples, the way the digital-to-analogue converter will play it (measured with 4× oversampling). It is usually a little higher than the sample peak — typically under 1 dB, more on very bright or clipped material.' },
        { lead: 'Note', text: 'For a raw take this is only for information. Finished masters are kept at or below −1 dBTP so that streaming encoders don’t distort. A value above 0 dBTP on a raw take usually means the converter clipped.' },
      ],
    };
  }

  function rmsItem(r) {
    return {
      id: 'rms',
      label: 'RMS level',
      value: fmtDb(r.rms.db),
      target: 'for information',
      status: 'info',
      note: 'depends on the material',
      explanation: [
        { lead: 'What it is', text: 'The average level of the whole file, in dBFS. It roughly tracks how loud the recording feels, and it is the other half of the crest factor.' },
        { lead: 'Note', text: 'There is no target for a raw take: pauses, phrasing and the song itself change it a lot. Compare it with the peak — the difference between the two is the crest factor.' },
      ],
    };
  }

  function crestItem(r) {
    const v = r.crest.db;
    const status = v >= 10 && v <= 20 ? 'good' : 'warn';
    return {
      id: 'crest',
      label: 'Crest factor',
      value: fmtDb(v, 'dB'),
      target: '10 to 20 dB for a natural vocal',
      status,
      note: v < 6 ? 'very dense' : v < 10 ? 'dense' : v > 20 ? 'very dynamic' : 'natural',
      explanation: [
        { lead: 'What it is', text: 'Peak minus RMS: how far the loudest moment sticks out above the average. A natural vocal take is usually between 10 and 20 dB. This depends a lot on what was sung, so treat it as a hint.' },
        { lead: 'Too low', text: 'Below about 6 dB the take is very dense, which usually means a compressor or limiter was working hard on the way in, or the file was processed before export. That can’t be undone later. A long, evenly loud shout can also read low without anything being wrong.' },
        { lead: 'Too high', text: 'Above 20 dB is not a fault: long pauses, a very quiet verse next to a loud chorus, or a few sharp consonants all push it up.' },
        { lead: 'What to do', text: 'If a compressor was in the recording path, record dry (or with gentle settings) and compress in the mix instead, where you can undo it.' },
      ],
    };
  }

  function noiseFloorItem(r) {
    const v = r.noiseFloor.db;
    const status = v > -50 ? 'bad' : v > -60 ? 'warn' : 'good';
    const silent = r.noiseFloor.silentBlocks * r.noiseFloor.blockSeconds;
    const explanation = [
      { lead: 'What it is', text: 'The level of the background noise when nobody is singing, in dBFS. The file is cut into 200 ms pieces, each is measured, and the value is the 5th percentile — the level the quietest 5 % of the file sits at. Pieces of pure digital silence are left out, because they say nothing about your recording chain.' },
      { lead: 'Too high', text: 'Above −60 dBFS the noise will need attention. Possible sources: the room (computer fans, air conditioning, traffic), the preamp at high gain, the microphone’s own self-noise, or a noisy USB power supply. The tool can’t tell them apart. A quick test: record a few seconds of silence at the same gain and listen closely.' },
      { lead: 'What to do', text: 'Reduce whatever you can hear on that silent test — move the computer, close windows, try another mic position. Then check whether the gain is unusually high; getting closer to the mic lets you turn it down.' },
    ];
    if (silent > 0.5) {
      explanation.push({ lead: 'Note', text: `${silent.toFixed(1)} s of the file are pure digital silence and were ignored. If a gate or noise reduction ran before export, this number describes the processed file, not your recording chain.` });
    }
    return {
      id: 'noise-floor',
      label: 'Noise floor',
      value: fmtDb(v),
      target: 'below −60 dBFS · below −70 is very good',
      status,
      note: v < -70 ? 'very quiet' : status === 'good' ? 'quiet' : status === 'warn' ? 'noticeable' : 'loud',
      explanation,
    };
  }

  function loudnessItem(r) {
    const v = r.loudness.lufs;
    const mono = r.loudness.channels === 1;
    return {
      id: 'loudness',
      label: 'Integrated loudness',
      value: fmtDb(v, 'LUFS'),
      target: 'no target for a raw take · masters aim for about −14 LUFS',
      status: 'info',
      note: !isFinite(v) ? 'too quiet to measure' : v > -16 ? 'louder than a typical raw take' : v < -24 ? 'quieter than a typical raw take' : 'typical for a raw take',
      explanation: [
        { lead: 'What it is', text: 'The perceived loudness of the whole file, measured the way streaming services and broadcasters do (ITU-R BS.1770-4): frequencies are weighted by how loud they sound to us, and silence and very quiet passages are ignored.' },
        { lead: 'Note', text: `Raw vocal takes typically land anywhere between −24 and −16 LUFS, and there is no target — it depends on the singer and the phrasing. Finished masters aim for about −14 LUFS for streaming. Don’t try to hit that with a raw take; loudness is set at the very end of the mix.${mono ? ' This is a mono file, measured as one channel; the same signal on both sides of a stereo bus reads about 3 LU higher.' : ''}` },
      ],
    };
  }

  function clippingItem(r) {
    const c = r.clipping;
    const status = c.count ? 'bad' : 'good';
    return {
      id: 'clipping',
      label: 'Clipping',
      value: c.count ? plural(c.count, 'place') : 'none',
      target: 'none',
      status,
      note: c.count ? `${c.samples} flattened samples` : 'no flattened peaks',
      eventsTitle: 'Clipped passages',
      eventsTotal: c.count,
      events: c.events.map((e) => ({ t: e.t, label: `${e.samples} samples${r.layout === 'sum' ? ` · channel ${e.channel + 1}` : ''}` })),
      explanation: [
        { lead: 'What it is', text: 'Runs of three or more samples in a row at full scale (|value| ≥ 0.999). That is the signature of a converter or plug-in that ran out of headroom: the top of the waveform is sliced flat. A single full-scale sample can be a coincidence; three in a row is not.' },
        { lead: 'Why it matters', text: 'Any real clipping is a problem. It sounds like a crackle or a harsh edge on the loudest notes, and no plug-in can restore what was cut off.' },
        { lead: 'What to do', text: 'Turn the interface gain down until peaks sit around −12 dBFS and record the take again. If it only happens on a few very loud notes, step back from the microphone for those.' },
      ],
    };
  }

  function dropoutsItem(r) {
    const z = r.dropouts.zeroRuns;
    const j = r.dropouts.jumps;
    const status = z.count ? 'bad' : j.count ? 'warn' : 'good';
    const parts = [];
    if (z.count) parts.push(plural(z.count, 'gap'));
    if (j.count) parts.push(plural(j.count, 'jump'));
    const events = z.events.map((e) => ({ t: e.t, label: `gap of ${e.samples} samples` }))
      .concat(j.events.map((e) => ({ t: e.t, label: `jump of ${fmtDb(20 * Math.log10(e.size), 'dB')}` })))
      .sort((a, b) => a.t - b.t);
    return {
      id: 'dropouts',
      label: 'Dropouts',
      value: parts.length ? parts.join(', ') : 'none',
      target: 'none',
      status,
      note: z.count ? 'gaps in the audio' : j.count ? 'listen to check' : 'continuous',
      eventsTitle: 'Where',
      eventsTotal: z.count + j.count,
      events,
      explanation: [
        { lead: 'What it is', text: 'Two checks for damage from a struggling computer: stretches of more than 20 exact zeros in the middle of the signal (a buffer that was never filled, a gap) and sudden jumps in the waveform that a continuous recording can’t produce (a buffer that was skipped or repeated). Long stretches of digital silence are treated as deliberate — a gate or an empty region in the DAW — not as dropouts.' },
        { lead: 'Why it matters', text: 'Real dropouts sound like a click or a tiny hole in the audio. A jump can also be an edit without a crossfade, so listen at the timestamps before you act.' },
        { lead: 'What to do', text: 'Raise the buffer size in your DAW’s audio settings (256 or 512 samples is fine for recording), close other programs, and don’t record onto a USB stick or a network drive. Edits get a short crossfade.' },
      ],
    };
  }

  function dcItem(r) {
    const v = Math.abs(r.dc.offset);
    const status = v > 0.01 ? 'bad' : v > 0.001 ? 'warn' : 'good';
    return {
      id: 'dc',
      label: 'DC offset',
      value: `${fmtNum(r.dc.offset, 4)} (${fmtDb(r.dc.db)})`,
      target: 'below 0.001',
      status,
      note: status === 'good' ? 'centred' : 'off centre',
      explanation: [
        { lead: 'What it is', text: 'The average of all samples. It should be zero; a waveform that sits a little above or below the centre line has a DC offset.' },
        { lead: 'Why it matters', text: 'A small offset is inaudible, but it eats headroom and causes clicks at edits and loop points. It usually comes from an older or cheap interface, or a plug-in with a bug.' },
        { lead: 'What to do', text: 'Put a high-pass filter (20–30 Hz) or your DAW’s DC-removal on the track. Most editors also have a “remove DC offset” function for clips.' },
      ],
    };
  }

  function subsonicItem(r) {
    const v = r.subsonic.peakDb;
    const status = v > -30 ? 'bad' : v > -45 ? 'warn' : 'good';
    return {
      id: 'subsonic',
      label: 'Rumble below 40 Hz',
      value: `peak ${fmtDb(v)} · average ${fmtDb(r.subsonic.rmsDb)}`,
      target: 'peak below −45 dBFS',
      status,
      note: status === 'good' ? 'clean' : 'low-frequency energy present',
      explanation: [
        { lead: 'What it is', text: 'How much energy sits below 40 Hz, a region a voice doesn’t produce. The peak is the loudest moment of that rumble, the average is over the whole file.' },
        { lead: 'Too high', text: 'Possible sources: plosives (puffs of air on P and B), handling noise, footsteps or traffic coming up through the stand, or a microphone very close to the mouth (proximity effect). The tool can’t tell which; the plosive check below narrows it down.' },
        { lead: 'What to do', text: 'A high-pass filter at about 80 Hz on the vocal track removes it without changing the voice. To keep it out of the recording: pop filter, sing slightly past the microphone rather than straight into it, and use a shock mount or a foam pad under the stand.' },
      ],
    };
  }

  function plosivesItem(r) {
    const p = r.plosives;
    const perMinute = p.count / Math.max(r.duration / 60, 1); // short files: the count itself
    const status = !p.count ? 'good' : perMinute > 3 ? 'bad' : 'warn';
    return {
      id: 'plosives',
      label: 'Plosives',
      value: p.count ? plural(p.count, 'burst') : 'none',
      target: 'none',
      status,
      note: p.count ? `${perMinute.toFixed(1)} per minute` : 'no low-frequency bursts',
      eventsTitle: 'Strongest bursts',
      eventsTotal: p.count,
      events: p.events.map((e) => ({ t: e.t, label: fmtDb(e.db) })),
      explanation: [
        { lead: 'What it is', text: 'Short bursts of energy below 45 Hz — typically the puff of air from a P, B or T hitting the capsule. Measured in 100 ms windows; windows above −50 dBFS are listed.' },
        { lead: 'Why it matters', text: 'Every listed timestamp is worth a listen. A loud plosive sounds like a thump and can’t be fully removed later; a mild one is usually handled by a high-pass filter. Low notes, handling noise and hard edits can show up here too.' },
        { lead: 'What to do', text: 'A pop filter 5–10 cm in front of the mic, or sing slightly off-axis (to the side of the capsule) so the air goes past it. A high-pass filter at 80 Hz catches what is left.' },
      ],
    };
  }

  function sibilanceItem(r) {
    const s = r.sibilance;
    const share = s.share * 100;
    const status = !s.count ? 'good' : share > 12 ? 'bad' : share > 5 ? 'warn' : 'good';
    return {
      id: 'sibilance',
      label: 'Sibilance',
      value: s.count ? `${plural(s.count, 'window')} · ${share.toFixed(1)} % of the loud material` : 'none',
      target: 'a few are normal · above 5 % worth a listen',
      status,
      note: !s.loudFrames ? 'too quiet to judge' : s.maxRatioDb === null ? '' : `strongest ${fmtDb(s.maxRatioDb, 'dB')}`,
      eventsTitle: 'Sharpest windows',
      eventsTotal: s.count,
      events: s.events.map((e) => ({ t: e.t, label: fmtDb(e.ratioDb, 'dB') })),
      explanation: [
        { lead: 'What it is', text: 'For each short window the energy between 5 and 9 kHz — where sharp S and SH sounds live — is compared with the whole signal. Windows where that band makes up more than about a quarter of the energy (a ratio above −6 dB) are listed; windows quieter than −30 dBFS are skipped.' },
        { lead: 'Why it matters', text: 'Some hits are normal: every S in the lyrics shows up. It becomes a problem when the S sounds jump out and hurt on headphones. Bright condenser microphones, singing very close, and some voices all push it up. The numbers say how often and how strongly it happens; whether it is too much is a listening decision — use the timestamps.' },
        { lead: 'What to do', text: 'Try the microphone slightly above the mouth or a little to the side, or step back a few centimetres. In the mix, a de-esser tames what is left.' },
      ],
    };
  }

  function humItem(r) {
    const h = r.hum;
    if (!h) {
      return {
        id: 'hum', label: 'Mains hum', value: 'file too short', target: 'peaks less than 6 dB above their surroundings', status: 'info', note: '',
        explanation: [{ lead: 'Note', text: 'The hum check needs at least a third of a second of audio.' }],
      };
    }
    const status = !h.mains ? 'good' : h.excessDb > 15 && (h.hits > 1 || h.levelDb > -55) ? 'bad' : 'warn';
    const where = h.measuredOn === 'quiet'
      ? `Measured over ${h.quietSeconds.toFixed(1)} s of quiet passages, so the voice did not get in the way.`
      : 'There were no quiet passages, so it was measured over the whole file — a sustained low note can look like hum here. Listen to a pause to be sure.';
    const detail = h.mains
      ? h.harmonics.filter((x) => x.hit).map((x) => `${x.hz} Hz: +${x.excessDb.toFixed(0)} dB at ${fmtDb(x.levelDb)}`).join(', ')
      : '';
    return {
      id: 'hum',
      label: 'Mains hum',
      value: h.mains ? `${h.mains} Hz, ${fmtDb(h.excessDb, 'dB').replace('−', '')} above surroundings` : 'none found',
      target: 'peaks less than 6 dB above their surroundings',
      status,
      note: h.mains ? `strongest at ${fmtDb(h.levelDb)}` : `largest peak ${h.excessDb.toFixed(1)} dB`,
      explanation: [
        { lead: 'What it is', text: `Looks for narrow peaks at 50 Hz or 60 Hz and their multiples up to 300 Hz that stick out above the surrounding spectrum (±20 Hz). ${where}${detail ? ` Found: ${detail}.` : ''}` },
        { lead: 'Why it matters', text: 'Hum at 50 Hz (Europe and most of the world) or 60 Hz (the Americas) points at a ground loop, an unbalanced cable near a power supply, a laptop charger, or a dimmer. Lots of harmonics sound like a buzz; the fundamental alone is a low hum.' },
        { lead: 'What to do', text: 'Unplug things one at a time until it stops: laptop charger, USB hub, lamps. Use balanced XLR cables, keep power supplies away from the microphone cable, and try a different wall socket for the interface. A narrow notch filter in the mix is the last resort.' },
      ],
    };
  }

  function balanceItem(r) {
    const top = r.balance.reduce((a, b) => (b.percent > a.percent ? b : a), r.balance[0]);
    return {
      id: 'balance',
      label: 'Spectral balance',
      value: `most energy at ${fmtRange(top.lo, top.hi)} (${top.percent.toFixed(0)} %)`,
      target: 'no target — depends entirely on what was sung',
      status: 'info',
      note: 'for information',
      chart: { type: 'bands', bands: r.balance },
      explanation: [
        { lead: 'What it is', text: 'How the energy of the whole file is spread across nine frequency bands, in percent. There is no target: a low male voice, a soprano and a whispered take all look completely different, and that is fine.' },
        { lead: 'How to read it', text: 'It is useful for spotting things that should not be there: a lot of energy in the lowest band with a voice that does not go that low suggests rumble or plosives; almost nothing above 5 kHz could mean the mic was pointed the wrong way or is very dull. Treat it as a picture, not a verdict.' },
      ],
    };
  }

  function pitchItem(r) {
    const p = r.pitch;
    if (!p || !p.tonal) return null;
    const low = noteLabel(p.lowHz);
    const high = noteLabel(p.highHz);
    return {
      id: 'pitch',
      label: 'Pitch',
      value: `${low ? `${low} – ${high}` : `${p.lowHz.toFixed(0)}–${p.highHz.toFixed(0)} Hz`} · wobble ${p.wobbleCents.toFixed(0)} ¢`,
      target: 'for information',
      status: 'info',
      note: `pitch found on ${(p.voicedRatio * 100).toFixed(0)} % of the loud material`,
      chart: { type: 'pitch', track: p.track, hopSeconds: p.hopSeconds, lowHz: p.lowHz, highHz: p.highHz },
      explanation: [
        { lead: 'What it is', text: 'The fundamental frequency of the singing over time, found with the same detector the tuner uses. It is only shown when the detector was confident on enough of the file.' },
        { lead: 'How to read it', text: 'Range is the 5th to 95th percentile of the detected pitch, so a few stray readings do not set it. Wobble is how far the pitch strays from its own short-term average, in cents: a steady voice reads under about 15 ¢, but vibrato and slides push it up, and neither is a fault. The detector can also skip an octave on breathy or very low notes.' },
      ],
    };
  }

  // ---------------------------------------------------------------- summary

  function summarise(r, items) {
    const item = (id) => items.find((i) => i.id === id);
    const actions = [];

    if (item('clipping').status === 'bad') {
      actions.push({
        title: 'Turn the gain down and record again',
        text: `The take clips at ${plural(r.clipping.count, 'place')}. Once the top of the waveform is cut off nothing can bring it back. Aim for peaks around −12 dBFS.`,
      });
    }

    const z = r.dropouts.zeroRuns.count;
    const j = r.dropouts.jumps.count;
    if (z) {
      actions.push({
        title: 'Fix the dropouts before the next take',
        text: `${plural(z, 'gap')} in the audio. Raise the buffer size in your DAW’s audio settings and close other programs while recording. The spots are listed under Dropouts; if there are only a few, you may be able to punch them in again.`,
      });
    } else if (j) {
      actions.push({
        title: 'Listen at the jumps',
        text: `${plural(j, 'sudden jump')} in the waveform. If they are clicks or gaps, raise the buffer size in your DAW and close other programs; if they are edits, add short crossfades.`,
      });
    }

    const snr = item('snr').status;
    const mix = item('noise-at-mix').status;
    const peak = r.peak.db;
    if (snr !== 'good' || mix !== 'good') {
      if (peak < -18) {
        actions.push({
          title: 'Record louder — the noise is close behind the voice',
          text: `Signal-to-noise ratio ${fmtDb(r.snr.db, 'dB')}, with peaks only at ${fmtDb(peak)}. Raise the interface gain until the loudest phrase peaks around −12 dBFS. Get closer to the microphone and make the room quieter at the same time, because more gain raises the noise too.`,
        });
      } else {
        actions.push({
          title: 'Reduce the noise at the source',
          text: `At mix level the noise will sit at ${fmtDb(r.noiseAtMix.db)} (signal-to-noise ratio ${fmtDb(r.snr.db, 'dB')}). The level itself is fine, so more gain will not help: find what hisses when nothing is playing — computer, air conditioning, the preamp at high gain — and get closer to the microphone so the gain can come down.`,
        });
      }
    } else if (peak < -24) {
      actions.push({
        title: 'Use the gain you have',
        text: `Peaks only reach ${fmtDb(peak)}, so a lot of gain is left unused. Raise it until the loudest phrase peaks around −12 dBFS.`,
      });
    }
    if (peak > -6 && item('clipping').status !== 'bad') {
      actions.push({
        title: 'Leave some headroom',
        text: `Peaks reach ${fmtDb(peak)}, very close to the ceiling. Lower the gain a little; peaks around −12 dBFS leave room for a louder phrase.`,
      });
    }

    if (item('subsonic').status !== 'good' || item('plosives').status !== 'good') {
      const found = [];
      if (r.plosives.count) found.push(plural(r.plosives.count, 'plosive burst'));
      if (item('subsonic').status !== 'good') found.push(`rumble peaking at ${fmtDb(r.subsonic.peakDb)}`);
      actions.push({
        title: 'Pop filter, off-axis, high-pass',
        text: `Found ${found.join(' and ')}. Use a pop filter, sing slightly past the microphone instead of straight into it, and put a high-pass filter at about 80 Hz on the track.`,
      });
    }

    if (item('sibilance').status !== 'good') {
      actions.push({
        title: 'Tame the S sounds',
        text: `The 5–9 kHz band dominates ${(r.sibilance.share * 100).toFixed(0)} % of the loud material. Listen at the timestamps; if the S sounds jump out, move the microphone slightly above the mouth or a little to the side, or use a de-esser in the mix.`,
      });
    }

    if (item('hum').status !== 'good' && item('hum').status !== 'info') {
      actions.push({
        title: `Find the ${r.hum.mains} Hz hum`,
        text: `A ${r.hum.mains} Hz component sticks out ${fmtDb(r.hum.excessDb, 'dB')} above its surroundings. Unplug chargers and power supplies near the microphone cable one at a time, use balanced cables, and try another wall socket — a ground loop or a power supply next to the cable are the usual suspects.`,
      });
    }

    if (item('dc').status !== 'good') {
      actions.push({
        title: 'Remove the DC offset',
        text: `The waveform sits ${fmtNum(r.dc.offset, 4)} off centre. Enable DC removal or a 20–30 Hz high-pass filter on the track.`,
      });
    }

    if (r.crest.db < 6) {
      actions.push({
        title: 'Record without compression',
        text: `The crest factor is only ${fmtDb(r.crest.db, 'dB')}, which suggests a compressor or limiter worked hard on the way in. If so, record dry and compress in the mix, where it can be undone.`,
      });
    }

    let worst = 'good';
    for (const i of items) if (SEVERITY[i.status] > SEVERITY[worst]) worst = i.status;

    return {
      status: worst,
      actions,
      allGood: actions.length === 0,
      intro: actions.length === 0
        ? 'Nothing to fix. Level, noise and cleanliness are where they should be for a raw take — go make music.'
        : `${plural(actions.length, 'thing')} to look at, most important first.`,
      note: 'These are measurements, not diagnoses: the tool can’t tell where noise comes from, or a plosive from a low note. The timestamps are there so you can listen.',
    };
  }

  // ------------------------------------------------------------------ build

  function build(result) {
    const headline = [snrItem(result), noiseAtMixItem(result)];
    const items = [
      peakItem(result),
      truePeakItem(result),
      rmsItem(result),
      crestItem(result),
      noiseFloorItem(result),
      loudnessItem(result),
      clippingItem(result),
      dropoutsItem(result),
      dcItem(result),
      subsonicItem(result),
      plosivesItem(result),
      sibilanceItem(result),
      humItem(result),
      balanceItem(result),
      pitchItem(result),
    ].filter(Boolean);
    const summary = summarise(result, headline.concat(items));
    return { headline, items, summary };
  }

  return { build, fmtDb, fmtTime, fmtHz, fmtRange, noteLabel, STATUS_LABEL };
});
