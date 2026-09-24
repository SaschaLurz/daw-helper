/*
 * app.js — wires the audio input to the pitch detector and drives the UI.
 *
 * Signal path: audio interface → getUserMedia (all browser processing off)
 * → optional channel pick → high-pass 35 Hz → low-pass 2.2 kHz → AnalyserNode
 * → Pitch.detect() every ~20 ms → short median → display.
 *
 * With Tone switched on, clicking a string also plays its note (a periodic
 * wave with a few overtones) to tune by ear.
 *
 * Tempo mode needs no input: taps (pointer or keyboard) go to
 * Tempo.createTapTempo(), or a tempo is typed. The metronome takes its ticks
 * from Metronome.createClock() and schedules them on the Web Audio clock a
 * little ahead of time, so the click stays steady whatever the page is doing.
 *
 * Analysis mode takes a dropped file: header sniffed for the native sample
 * rate → decodeAudioData in an offline context at that rate → channels handed
 * to analysis-worker.js → Report.build() → cards, timestamps and a summary.
 */
(function () {
  'use strict';

  // Strings in playing order, as MIDI notes. Names must make sense on their
  // own: the closed menu shows the name without its group.
  const TUNINGS = [
    { id: 'standard', group: 'Guitar', name: 'Standard', notes: [40, 45, 50, 55, 59, 64] },
    { id: 'drop-d', group: 'Guitar', name: 'Drop D', notes: [38, 45, 50, 55, 59, 64] },
    { id: 'eb', group: 'Guitar', name: 'E♭ Standard', notes: [39, 44, 49, 54, 58, 63] },
    { id: 'd', group: 'Guitar', name: 'D Standard', notes: [38, 43, 48, 53, 57, 62] },
    { id: 'drop-c', group: 'Guitar', name: 'Drop C', notes: [36, 43, 48, 53, 57, 62] },
    { id: 'dadgad', group: 'Guitar', name: 'DADGAD', notes: [38, 45, 50, 55, 57, 62] },
    { id: 'open-g', group: 'Guitar', name: 'Open G', notes: [38, 43, 50, 55, 59, 62] },
    { id: 'ukulele', group: 'Ukulele', name: 'Ukulele', notes: [67, 60, 64, 69] },
    { id: 'ukulele-low-g', group: 'Ukulele', name: 'Low G uke', notes: [55, 60, 64, 69] },
    { id: 'ukulele-baritone', group: 'Ukulele', name: 'Baritone uke', notes: [50, 55, 59, 64] },
    { id: 'mandolin', group: 'Mandolin', name: 'Mandolin', notes: [55, 62, 69, 76] },
  ];

  const IN_TUNE_CENTS = 3;        // |cents| at or below this counts as in tune
  const HOLD_MS = 900;            // keep the last reading on screen this long after the note dies
  const HISTORY_MS = 260;         // readings inside this window are median-filtered
  const ANALYSIS_INTERVAL_MS = 20;
  const RING_TIMEOUT_MS = 20000;  // stop pulsing the tempo ring this long after the last tap
  const MAX_FILE_BYTES = 300 * 1024 * 1024;  // decodeAudioData holds the whole file in memory
  const PLAY_LEAD_S = 0.5;        // an excerpt starts this long before its timestamp…
  const PLAY_LENGTH_S = 3;        // …and lasts this long
  const MODES = ['tuner', 'tempo', 'analysis'];
  const THEMES = ['auto', 'light', 'dark'];
  const STORAGE_KEY = 'tuner.settings';

  // Reference tone: a mellow periodic wave whose overtones still carry on
  // small speakers, where a low E's fundamental alone would be inaudible.
  const TONE_HARMONICS = [0, 1, 0.5, 0.3, 0.18, 0.1, 0.06];
  const TONE_LEVEL = 0.25;
  const TONE_FADE_S = 0.03;

  // Metronome voices: pitch in Hz and peak level.
  const CLICK_SOUNDS = {
    bar: { freq: 1760, gain: 0.5 },
    beat: { freq: 1320, gain: 0.35 },
    sub: { freq: 990, gain: 0.18 },
  };
  const CLICK_DECAY_S = 0.04;
  const CLICK_TIMER_MS = 25;
  const CLICK_LOOKAHEAD_S = 0.12;        // clicks are scheduled this far ahead…
  const CLICK_LOOKAHEAD_HIDDEN_S = 1.5;  // …or this far in a hidden tab, whose timers fire about once a second
  const CLICK_START_DELAY_S = 0.08;

  // Meter geometry (SVG user units, viewBox 1000 × 170).
  const METER_LEFT = 90;
  const METER_RIGHT = 910;
  const METER_BASE = 116;
  const PX_PER_CENT = (METER_RIGHT - METER_LEFT) / 100;

  const $ = (id) => document.getElementById(id);
  const ui = {
    app: $('app'),
    device: $('device'),
    channelField: $('channel-field'),
    channel: $('channel'),
    tuning: $('tuning'),
    a4: $('a4'),
    a4Down: $('a4-down'),
    a4Up: $('a4-up'),
    tone: $('tone'),
    listen: $('listen'),
    stop: $('stop'),
    theme: $('theme'),
    noteName: $('note-name'),
    noteOctave: $('note-octave'),
    freq: $('freq'),
    hint: $('hint'),
    strings: $('strings'),
    level: $('level'),
    overlay: $('overlay'),
    start: $('start'),
    error: $('error'),
    meter: $('meter'),
    segs: Array.from(document.querySelectorAll('.seg[data-mode]')),
    tempoReset: $('tempo-reset'),
    beats: $('beats'),
    subdivision: $('subdivision'),
    countIn: $('count-in'),
    bpm: $('bpm'),
    bpmDown: $('bpm-down'),
    bpmUp: $('bpm-up'),
    tempoDetail: $('tempo-detail'),
    tap: $('tap'),
    tapRing: $('tap-ring'),
    click: $('click'),
    clickLabel: $('click-label'),
    beatDots: $('beat-dots'),
    lengths: $('lengths'),
    units: Array.from(document.querySelectorAll('.seg[data-unit]')),
    dropzone: $('dropzone'),
    browse: $('browse'),
    file: $('file'),
    analysisError: $('analysis-error'),
    analysisNew: $('analysis-new'),
    progress: $('progress'),
    progressText: $('progress-text'),
    progressFill: $('progress-fill'),
    report: $('report'),
    fileInfo: $('file-info'),
    headline: $('headline'),
    items: $('items'),
    summary: $('summary'),
  };

  const settings = loadSettings();
  const audio = { ctx: null, stream: null, nodes: [], analyser: null, buffer: null, detector: null, channels: 1 };
  const tapTempo = Tempo.createTapTempo();
  const tone = { on: false, osc: null, gain: null, string: -1, wave: null };
  // queue: scheduled beats not yet heard; beat: the one heard last.
  const metro = { clock: Metronome.createClock(clickOptions()), timer: 0, out: null, queue: [], beat: null, countIn: 0 };
  const analysis = { worker: null, buffer: null, file: null, token: 0 };
  const player = { source: null, button: null };

  let running = false;
  let lockedString = -1;          // index into the current tuning, or -1 for automatic
  let history = [];               // recent { t, f } readings
  let currentFreq = 0;
  let inputLevel = 0;
  let lastValid = -Infinity;
  let lastAnalysis = 0;
  let lastFrame = 0;
  let needleCents = 0;
  let needle = null;
  let stringEls = [];
  let lastRenderKey = '';

  // ---------------------------------------------------------------- settings

  function loadSettings() {
    const defaults = {
      deviceId: '', channel: 'mix', tuning: 'standard', a4: 440, mode: 'tuner', theme: 'auto',
      bpm: 120, beats: 4, subdivision: 1, countIn: 0, lengthUnit: 'ms',
    };
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      /* unreadable — start from the defaults */
    }
    const s = Object.assign(defaults, stored);
    s.bpm = Tempo.clampBpm(Number(s.bpm) || 120);
    if (!THEMES.includes(s.theme)) s.theme = 'auto';
    if (s.lengthUnit !== 'hz') s.lengthUnit = 'ms';
    return s;
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* private mode etc. — settings just won't persist */
    }
  }

  function currentTuning() {
    return TUNINGS.find((t) => t.id === settings.tuning) || TUNINGS[0];
  }

  // ------------------------------------------------------------------- audio

  function baseConstraints() {
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
    };
  }

  async function start() {
    ui.error.hidden = true;
    ui.start.disabled = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('This browser cannot access audio input. Try Chrome, Edge or Firefox.');
      }
      audioContext();
      if (audio.ctx.state === 'suspended') await audio.ctx.resume();
      await openStream(settings.deviceId);
      await refreshDevices();
      running = true;
      ui.app.classList.add('running');
      lastFrame = performance.now();
      syncOverlay();
    } catch (err) {
      if (tone.on) setToneMode(false);  // bring the overlay back, which shows the error
      showError(err);
    } finally {
      ui.start.disabled = false;
    }
  }

  function stop() {
    running = false;
    ui.app.classList.remove('running');
    stopStream();
    teardownGraph();
    resetReadings();
    applyView(null);
    needleCents = 0;
    needle.setAttribute('transform', 'translate(0 0)');
    ui.level.style.width = '0%';
    syncOverlay();
  }

  // The start overlay only belongs to the tuner, and only while it is not
  // listening. With Tone on the strings are usable without listening.
  function syncOverlay() {
    ui.overlay.hidden = running || settings.mode !== 'tuner' || tone.on;
  }

  async function openStream(deviceId) {
    let stream;
    try {
      const audioConstraints = deviceId
        ? Object.assign(baseConstraints(), { deviceId: { exact: deviceId } })
        : baseConstraints();
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (err) {
      if (!deviceId || err.name === 'NotAllowedError') throw err;
      // The remembered device is gone — fall back to whatever the browser offers.
      stream = await navigator.mediaDevices.getUserMedia({ audio: baseConstraints() });
    }

    stopStream();
    audio.stream = stream;
    const track = stream.getAudioTracks()[0];
    const trackSettings = track.getSettings ? track.getSettings() : {};
    if (trackSettings.deviceId) {
      settings.deviceId = trackSettings.deviceId;
      saveSettings();
    }
    audio.channels = trackSettings.channelCount || 1;
    ui.channelField.hidden = audio.channels < 2;
    track.addEventListener('ended', () => {
      // Interface unplugged: try to carry on with the default input.
      if (running) openStream('').then(refreshDevices).catch((err) => { showError(err); stop(); });
    });
    resetReadings();
    buildGraph();
  }

  function stopStream() {
    if (!audio.stream) return;
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.stream = null;
  }

  function teardownGraph() {
    audio.nodes.forEach((n) => {
      try { n.disconnect(); } catch { /* already disconnected */ }
    });
    audio.nodes = [];
    audio.analyser = null;
  }

  function buildGraph() {
    const ctx = audio.ctx;
    teardownGraph();

    const source = ctx.createMediaStreamSource(audio.stream);
    const nodes = [source];
    let tap = source;

    if (settings.channel !== 'mix' && audio.channels >= 2) {
      const splitter = ctx.createChannelSplitter(2);
      const pick = ctx.createGain();
      source.connect(splitter);
      splitter.connect(pick, Number(settings.channel), 0);
      nodes.push(splitter, pick);
      tap = pick;
    }

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 35;
    highpass.Q.value = 0.7;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 2200;
    lowpass.Q.value = 0.7;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = ctx.sampleRate > 60000 ? 8192 : 4096;
    analyser.smoothingTimeConstant = 0;

    // A muted sink keeps the graph "live" in every browser without making sound.
    const sink = ctx.createGain();
    sink.gain.value = 0;

    tap.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(analyser);
    analyser.connect(sink);
    sink.connect(ctx.destination);
    nodes.push(highpass, lowpass, analyser, sink);

    audio.nodes = nodes;
    audio.analyser = analyser;
    audio.buffer = new Float32Array(analyser.fftSize);
    audio.detector = Pitch.createDetector({
      sampleRate: ctx.sampleRate,
      bufferSize: analyser.fftSize,
      minFreq: 55,
      maxFreq: 1400,
    });
  }

  const isAlias = (d) => d.deviceId === 'default' || d.deviceId === 'communications';

  // The track of a stream opened via the system default reports the id "default"
  // (labelled "Default - <device>" on Windows). Map that back to the concrete device
  // so the menu shows the real interface and the remembered setting survives.
  function resolveDeviceId(concrete, id, label) {
    if (id && concrete.some((d) => d.deviceId === id)) return id;
    const stripped = (label || '').replace(/^(Default|Communications) - /, '');
    const match = concrete.find((d) => d.label && (d.label === stripped || d.label === label));
    return match ? match.deviceId : id;
  }

  async function refreshDevices() {
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    const all = devices.filter((d) => d.kind === 'audioinput');
    const concrete = all.filter((d) => !isAlias(d));

    const track = audio.stream && audio.stream.getAudioTracks()[0];
    const resolved = resolveDeviceId(concrete, settings.deviceId, track && track.label);
    if (resolved !== settings.deviceId) {
      settings.deviceId = resolved;
      saveSettings();
    }

    // Prefer concrete devices; keep an alias entry only if it is the one in use.
    let inputs = concrete.length ? concrete : all;
    if (settings.deviceId && !inputs.some((d) => d.deviceId === settings.deviceId)) {
      const alias = all.find((d) => d.deviceId === settings.deviceId);
      inputs = alias ? [alias].concat(inputs) : inputs;
    }

    ui.device.innerHTML = '';
    if (!inputs.some((d) => d.label)) {
      // No permission yet, so no labels or ids — show a placeholder until the tuner starts.
      ui.device.appendChild(new Option('Default input', ''));
      return;
    }
    inputs.forEach((d, i) => {
      ui.device.appendChild(new Option(d.label || `Input ${i + 1}`, d.deviceId));
    });
    if (settings.deviceId && !inputs.some((d) => d.deviceId === settings.deviceId)) {
      ui.device.prepend(new Option('Current input', settings.deviceId));
    }
    if (settings.deviceId) ui.device.value = settings.deviceId;
  }

  function showError(err) {
    const messages = {
      NotAllowedError: 'Microphone access was blocked. Allow it for this page in the browser’s site settings, then try again.',
      NotFoundError: 'No audio input was found. Check that your interface is connected and switched on.',
      NotReadableError: 'The input could not be opened. Another app may be using it exclusively.',
      OverconstrainedError: 'The selected input is not available.',
    };
    ui.error.textContent = messages[err && err.name] || (err && err.message) || String(err);
    ui.error.hidden = false;
  }

  // ---------------------------------------------------------------- analysis

  function resetReadings() {
    history = [];
    currentFreq = 0;
    inputLevel = 0;
    lastValid = -Infinity;
  }

  function frame(now) {
    if (settings.mode === 'tuner') {
      if (running) {
        if (now - lastAnalysis >= ANALYSIS_INTERVAL_MS) {
          lastAnalysis = now;
          analyse(now);
        }
        render(now);
      }
    } else if (settings.mode === 'tempo') {
      renderBeat();
      renderRing(now);
    }
    requestAnimationFrame(frame);
  }

  function analyse(now) {
    const { analyser, buffer, detector } = audio;
    if (!analyser) return;
    analyser.getFloatTimeDomainData(buffer);
    const result = detector.detect(buffer);
    inputLevel = result.rms;
    if (result.frequency > 0) {
      history.push({ t: now, f: result.frequency });
      lastValid = now;
    }
    while (history.length && now - history[0].t > HISTORY_MS) history.shift();
    if (history.length) currentFreq = median(history.map((h) => h.f));
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  // --------------------------------------------------------------- rendering

  function render(now) {
    const dt = Math.min(50, now - lastFrame);
    lastFrame = now;

    const active = currentFreq > 0 && now - lastValid < HOLD_MS;
    let view = null;
    if (active) {
      const tuning = currentTuning();
      const exact = Pitch.freqToMidi(currentFreq, settings.a4);
      const note = Pitch.describe(currentFreq, settings.a4);

      let nearest = 0;
      let best = Infinity;
      tuning.notes.forEach((m, i) => {
        const d = Math.abs(exact - m);
        if (d < best) { best = d; nearest = i; }
      });
      const target = lockedString >= 0 ? lockedString : nearest;
      const targetMidi = tuning.notes[target];
      const matched = note.midi === targetMidi;
      const cents = lockedString >= 0 ? (exact - targetMidi) * 100 : note.cents;
      const inTune = matched && Math.abs(cents) <= IN_TUNE_CENTS;
      view = { note, cents, target, targetMidi, matched, inTune, exact, freq: currentFreq };
    }

    // Needle eases toward the reading; time-based so it feels the same at any refresh rate.
    const goal = view ? clamp(view.cents, -50, 50) : 0;
    needleCents += (goal - needleCents) * (1 - Math.exp(-dt / 70));
    needle.setAttribute('transform', `translate(${(needleCents * PX_PER_CENT).toFixed(2)} 0)`);

    const db = 20 * Math.log10(Math.max(inputLevel, 1e-5));
    ui.level.style.width = `${(clamp((db + 60) / 60, 0, 1) * 100).toFixed(1)}%`;

    applyView(view);
  }

  function applyView(view) {
    const key = view
      ? [view.note.midi, Math.round(view.cents), Math.round(view.note.cents), view.target, view.matched, view.inTune, view.freq.toFixed(1), lockedString].join('|')
      : ['idle', lockedString, tone.string, tone.on, running].join('|');
    if (key === lastRenderKey) return;
    lastRenderKey = key;

    ui.app.classList.toggle('idle', !view);
    ui.app.classList.toggle('in-tune', !!(view && view.inTune));

    if (!view) {
      ui.noteName.textContent = '—';
      ui.noteOctave.textContent = '';
      ui.freq.textContent = 'Play a string';
      ui.hint.textContent = idleHint();
      stringEls.forEach((el) => el.classList.remove('near', 'match', 'in-tune'));
      return;
    }

    ui.noteName.innerHTML = noteMarkup(view.note.name);
    ui.noteOctave.textContent = String(view.note.octave);

    // The readout is always relative to the nearest note; only the meter follows a locked string.
    const rounded = Math.round(view.note.cents);
    const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
    ui.freq.textContent = `${view.freq.toFixed(1)} Hz · ${sign}${Math.abs(rounded)} ¢`;

    let hint;
    if (view.inTune) hint = 'In tune';
    else if (view.matched) hint = view.cents < 0 ? 'Tune up ↑' : 'Tune down ↓';
    else hint = `${view.exact < view.targetMidi ? 'Tune up ↑' : 'Tune down ↓'} to ${noteLabel(view.targetMidi)}`;
    if (lockedString >= 0) hint += ' · locked';
    ui.hint.textContent = hint;

    stringEls.forEach((el, i) => {
      const isTarget = i === view.target;
      el.classList.toggle('match', isTarget && view.matched);
      el.classList.toggle('near', isTarget && !view.matched);
      el.classList.toggle('in-tune', isTarget && view.inTune);
    });
  }

  function idleHint() {
    const notes = currentTuning().notes;
    if (tone.string >= 0) return `Playing ${noteLabel(notes[tone.string])} · click it again to stop`;
    if (lockedString >= 0) return `Locked to ${noteLabel(notes[lockedString])}`;
    if (tone.on) return 'Click a string to hear it';
    return '';
  }

  function noteMarkup(name) {
    return name.length > 1 ? `${name[0]}<sup>${name.slice(1)}</sup>` : name;
  }

  function noteLabel(midi) {
    return `${Pitch.noteName(midi)}${Pitch.noteOctave(midi)}`;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // ------------------------------------------------------------------- tempo

  function onTap(now) {
    const state = tapTempo.tap(now);
    ui.tap.classList.add('hit');
    setTimeout(() => ui.tap.classList.remove('hit'), 110);
    if (state.bpm) applyBpm(Math.round(state.bpm));
    renderTempo();
  }

  function resetTempo() {
    tapTempo.reset();
    renderTempo();
  }

  // A typed or nudged tempo replaces whatever was tapped.
  function setBpm(value) {
    tapTempo.reset();
    applyBpm(value);
    renderTempo();
  }

  function applyBpm(value) {
    settings.bpm = Tempo.clampBpm(value);
    saveSettings();
    metro.clock.set({ bpm: settings.bpm });
  }

  function commitTypedBpm() {
    const value = Tempo.parseBpm(ui.bpm.value);
    if (!Number.isNaN(value) && value !== settings.bpm) setBpm(value);
  }

  function renderTempo() {
    ui.app.classList.toggle('tempo-steady', tapTempo.state.steady);
    if (document.activeElement !== ui.bpm) showBpm();
    renderTempoDetail();
    renderLengths();
  }

  function showBpm() {
    ui.bpm.value = fmtNumber(settings.bpm, 1);
    fitBpm();
  }

  // The input is as wide as its digits, so the number stays centred.
  function fitBpm() {
    ui.bpm.style.width = `${Math.max(2, ui.bpm.value.length) + 0.2}ch`;
  }

  function renderTempoDetail() {
    const state = tapTempo.state;
    let text = 'Tap along, or type a tempo';
    if (metro.countIn > 0) text = `Count-in · ${metro.countIn}`;
    else if (state.count === 1) text = 'Keep tapping…';
    else if (state.count > 1) text = `${state.count} taps · ${Math.round(state.interval)} ms per beat`;
    ui.tempoDetail.textContent = text;
  }

  const fmtNumber = (v, digits) => String(Number(v.toFixed(digits)));

  function renderLengths() {
    const hz = settings.lengthUnit === 'hz';
    const fmt = (ms) => (hz ? fmtNumber(1000 / ms, ms > 1000 ? 3 : 2) : fmtNumber(ms, 1));
    ui.lengths.innerHTML = Tempo.noteLengths(settings.bpm).map((row) => `<tr><th scope="row">${row.label}</th>`
      + `<td>${fmt(row.straight)}</td><td>${fmt(row.dotted)}</td><td>${fmt(row.triplet)}</td></tr>`).join('');
    ui.units.forEach((b) => {
      const active = b.dataset.unit === settings.lengthUnit;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  }

  // A ring ripples out of the tap button on every beat: the metronome's while
  // it plays, otherwise the tapped tempo's.
  function renderRing(now) {
    let phase = -1;
    if (metro.clock.running) {
      if (metro.beat) phase = (heardTime() - metro.beat.time) / metro.beat.beatLength;
    } else {
      const state = tapTempo.state;
      const since = now - state.lastTap;
      if (state.bpm && since <= RING_TIMEOUT_MS) phase = (since % state.interval) / state.interval;
    }
    if (phase < 0) {
      ui.tapRing.style.opacity = '0';
      return;
    }
    phase = Math.min(phase, 1);
    ui.tapRing.style.transform = `scale(${(1 + 0.5 * phase).toFixed(3)})`;
    ui.tapRing.style.opacity = (0.6 * Math.pow(1 - phase, 1.6)).toFixed(3);
  }

  // ---------------------------------------------------------------- metronome

  function clickOptions() {
    return { bpm: settings.bpm, beats: settings.beats, subdivision: settings.subdivision, countIn: settings.countIn };
  }

  function startClick() {
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    // Every click goes through this node, so disconnecting it silences the ones already scheduled.
    metro.out = ctx.createGain();
    metro.out.connect(ctx.destination);
    metro.queue = [];
    metro.beat = null;
    metro.clock.set(clickOptions());
    metro.clock.start(ctx.currentTime + CLICK_START_DELAY_S);
    pumpClick();
    metro.timer = setInterval(pumpClick, CLICK_TIMER_MS);
    renderClickState();
  }

  function stopClick() {
    if (!metro.clock.running) return;
    clearInterval(metro.timer);
    metro.clock.stop();
    metro.out.disconnect();
    metro.out = null;
    metro.queue = [];
    metro.beat = null;
    metro.countIn = 0;
    renderClickState();
    renderTempoDetail();
  }

  function pumpClick() {
    const ctx = audio.ctx;
    const ahead = document.hidden ? CLICK_LOOKAHEAD_HIDDEN_S : CLICK_LOOKAHEAD_S;
    for (const tick of metro.clock.ticksUntil(ctx.currentTime + ahead)) {
      playClick(ctx, tick);
      if (tick.sub === 0) metro.queue.push(tick);
    }
  }

  function playClick(ctx, tick) {
    const sound = CLICK_SOUNDS[tick.accent];
    const t = tick.time;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.value = sound.freq;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(sound.gain, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0005, t + CLICK_DECAY_S);
    osc.connect(env);
    env.connect(metro.out);
    osc.start(t);
    osc.stop(t + CLICK_DECAY_S);
    osc.onended = () => env.disconnect();
  }

  // Audio-clock time of what is coming out of the speakers right now.
  function heardTime() {
    const ctx = audio.ctx;
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  // Moves the beat dots (and the count-in) along as each beat is heard.
  function renderBeat() {
    if (!metro.clock.running) return;
    const t = heardTime();
    let beat = null;
    while (metro.queue.length && metro.queue[0].time <= t) beat = metro.queue.shift();
    if (!beat) return;
    metro.beat = beat;
    const dots = ui.beatDots.children;
    const lit = beat.beat % dots.length;
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i === lit);
    if (beat.countIn !== metro.countIn) {
      metro.countIn = beat.countIn;
      renderTempoDetail();
    }
  }

  function renderClickState() {
    const on = metro.clock.running;
    ui.app.classList.toggle('clicking', on);
    ui.click.setAttribute('aria-pressed', String(on));
    ui.clickLabel.textContent = on ? 'Stop click' : 'Start click';
    if (!on) Array.from(ui.beatDots.children).forEach((d) => d.classList.remove('on'));
  }

  function buildBeatDots() {
    ui.beatDots.innerHTML = '';
    for (let i = 0; i < settings.beats; i++) {
      const dot = document.createElement('span');
      dot.className = i === 0 && settings.beats > 1 ? 'dot-beat first' : 'dot-beat';
      ui.beatDots.appendChild(dot);
    }
  }

  // ------------------------------------------------------------ reference tone

  function setToneMode(on) {
    tone.on = on;
    if (!on) stopTone();
    ui.app.classList.toggle('tone-on', on);
    ui.tone.setAttribute('aria-pressed', String(on));
    buildStrings();
    syncOverlay();
  }

  const toneFrequency = (i) => Pitch.midiToFreq(currentTuning().notes[i], settings.a4);

  function startTone(i) {
    stopTone();
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    if (!tone.wave) {
      tone.wave = ctx.createPeriodicWave(new Float32Array(TONE_HARMONICS.length), Float32Array.from(TONE_HARMONICS));
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    osc.setPeriodicWave(tone.wave);
    osc.frequency.value = toneFrequency(i);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(TONE_LEVEL, t + TONE_FADE_S);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    Object.assign(tone, { osc, gain, string: i });
    updateLockMarks();
  }

  function stopTone() {
    if (!tone.osc) return;
    const { osc, gain } = tone;
    const t = audio.ctx.currentTime;
    // Fade from wherever the level is now, even halfway through the fade-in.
    if (gain.gain.cancelAndHoldAtTime) gain.gain.cancelAndHoldAtTime(t);
    else gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(0, t, TONE_FADE_S / 3);
    osc.stop(t + TONE_FADE_S * 3);
    osc.onended = () => gain.disconnect();
    Object.assign(tone, { osc: null, gain: null, string: -1 });
    updateLockMarks();
  }

  function retuneTone() {
    if (tone.osc) tone.osc.frequency.setTargetAtTime(toneFrequency(tone.string), audio.ctx.currentTime, 0.01);
  }

  // -------------------------------------------------------------------- theme

  function applyTheme() {
    const root = document.documentElement;
    if (settings.theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    const label = { auto: 'Theme: follows the system', light: 'Theme: light', dark: 'Theme: dark' }[settings.theme];
    ui.theme.dataset.choice = settings.theme;
    ui.theme.setAttribute('aria-label', label);
    ui.theme.title = `${label} · click to change`;
  }

  function setMode(mode) {
    settings.mode = MODES.includes(mode) ? mode : 'tuner';
    saveSettings();
    MODES.forEach((m) => ui.app.classList.toggle(`mode-${m}`, settings.mode === m));
    if (settings.mode !== 'analysis') stopPlayback();
    if (settings.mode !== 'tempo') stopClick();
    if (settings.mode !== 'tuner') stopTone();
    ui.segs.forEach((b) => {
      const active = b.dataset.mode === settings.mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    syncOverlay();
  }

  // ---------------------------------------------------------------- analysis

  function audioContext() {
    if (!audio.ctx) {
      audio.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    }
    return audio.ctx;
  }

  function showAnalysisStage(stage) {
    ui.dropzone.hidden = stage !== 'drop';
    ui.progress.hidden = stage !== 'progress';
    ui.report.hidden = stage !== 'report';
    ui.app.classList.toggle('has-report', stage !== 'drop'); // "New file" also cancels a running analysis
  }

  function showAnalysisError(message) {
    showAnalysisStage('drop');
    ui.analysisError.textContent = message;
    ui.analysisError.hidden = false;
  }

  function setProgress(fraction, stage) {
    const pct = Math.round(fraction * 100);
    ui.progressFill.style.width = `${pct}%`;
    ui.progressText.textContent = fraction > 0 ? `${stage} · ${pct} %` : stage;
  }

  function resetAnalysis() {
    stopPlayback();
    if (analysis.worker) {
      analysis.worker.terminate();
      analysis.worker = null;
    }
    analysis.token++;              // any decode still in flight belongs to an older file now
    analysis.buffer = null;
    analysis.file = null;
    ui.analysisError.hidden = true;
    ui.file.value = '';
    showAnalysisStage('drop');
  }

  async function analyseFile(file) {
    resetAnalysis();
    const token = analysis.token;
    if (file.size > MAX_FILE_BYTES) {
      showAnalysisError(`That file is ${Math.round(file.size / 1048576)} MB, too big to decode in the browser. Export the first few minutes and try again.`);
      return;
    }
    showAnalysisStage('progress');
    setProgress(0, 'Reading file…');
    try {
      const bytes = await file.arrayBuffer();
      if (token !== analysis.token) return;
      const info = Analysis.sniff(bytes) || {};
      setProgress(0, 'Decoding…');
      const { buffer, rate } = await decodeAudio(bytes, info.sampleRate || 0);
      if (token !== analysis.token) return;
      analysis.buffer = buffer;
      analysis.file = {
        name: file.name,
        info,
        decodedAt: rate,
        resampled: !info.sampleRate || rate !== info.sampleRate,
        truncated: buffer.duration > Analysis.MAX_SECONDS,
      };
      runWorker(buffer, token);
    } catch (err) {
      if (token !== analysis.token) return;
      showAnalysisError(decodeErrorMessage(err));
    }
  }

  // decodeAudioData() resamples to the rate of its context, so decode in an
  // offline context running at the file's own rate (read from the header). If
  // the header could not be read, or the browser refuses that rate, 48 kHz it is.
  async function decodeAudio(bytes, nativeRate) {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const rates = nativeRate && nativeRate !== 48000 ? [nativeRate, 48000] : [48000];
    let lastError = null;
    for (const rate of rates) {
      let ctx;
      try {
        ctx = new Offline(1, 1, rate);
      } catch (err) {
        lastError = err;      // rate outside what this browser supports
        continue;
      }
      try {
        // Some browsers detach the buffer they are given, so each attempt gets a copy.
        const buffer = await decodeWith(ctx, bytes.slice(0));
        return { buffer, rate };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('The file could not be decoded.');
  }

  function decodeWith(ctx, bytes) {
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(bytes, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  function decodeErrorMessage(err) {
    const text = (err && err.message) || String(err);
    if (!err || err.name === 'EncodingError' || /decod/i.test(text)) {
      return 'The browser could not decode this file. WAV, MP3, FLAC and M4A normally work; check that the file plays in a media player.';
    }
    return text;
  }

  function runWorker(buffer, token) {
    const max = Math.floor(Analysis.MAX_SECONDS * buffer.sampleRate);
    const channels = [];
    const transfer = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      const copy = data.length > max ? data.slice(0, max) : data.slice();
      channels.push(copy);
      transfer.push(copy.buffer);
    }
    let worker;
    try {
      worker = new Worker('analysis-worker.js');
    } catch (err) {
      showAnalysisError('The analysis needs a Web Worker, which this browser refused to start. Serve the app with “npm start” rather than opening the file directly.');
      return;
    }
    analysis.worker = worker;
    const finish = () => {
      worker.terminate();
      if (analysis.worker === worker) analysis.worker = null;
    };
    worker.onmessage = (e) => {
      if (token !== analysis.token) return;
      const msg = e.data;
      if (msg.type === 'progress') {
        setProgress(msg.fraction, msg.stage);
      } else if (msg.type === 'result') {
        finish();
        try {
          renderReport(msg.result);
        } catch (err) {
          showAnalysisError(`The report could not be built: ${err.message}`);
        }
      } else if (msg.type === 'error') {
        finish();
        showAnalysisError(`The analysis failed: ${msg.message}`);
      }
    };
    worker.onerror = (e) => {
      if (token !== analysis.token) return;
      finish();
      showAnalysisError(`The analysis failed: ${e.message || 'unknown error'}`);
    };
    worker.postMessage({ channels, sampleRate: buffer.sampleRate }, transfer);
  }

  // ------------------------------------------------------- report rendering

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fmtDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds - m * 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function renderReport(result) {
    const report = Report.build(result);
    ui.fileInfo.innerHTML = fileInfoMarkup(result);
    ui.headline.innerHTML = report.headline.map(tileMarkup).join('');
    ui.items.innerHTML = report.items.map(itemMarkup).join('');
    ui.summary.className = `summary status-${report.summary.status}`;
    ui.summary.innerHTML = summaryMarkup(report.summary);
    showAnalysisStage('report');
    window.scrollTo(0, 0);
  }

  function fileInfoMarkup(r) {
    const { name, info, decodedAt, resampled, truncated } = analysis.file;
    const buffer = analysis.buffer;
    const facts = [fmtDuration(buffer.duration)];
    facts.push(`${(r.sampleRate / 1000).toFixed(r.sampleRate % 1000 ? 1 : 0)} kHz`);
    if (info.bitDepth) facts.push(`${info.bitDepth}-bit${info.encoding === 'float' ? ' float' : ''}`);
    else if (info.format === 'mp3' || info.format === 'm4a') facts.push('lossy');
    const ch = buffer.numberOfChannels;
    facts.push(ch === 1 ? 'mono' : ch === 2 ? 'stereo' : `${ch} channels`);

    const notes = [];
    if (r.layout === 'dual-mono') notes.push('Both channels are identical (dual mono), so one of them was analysed.');
    if (r.layout === 'left-only' || r.layout === 'right-only') {
      const used = r.layout === 'left-only' ? 'left' : 'right';
      const other = used === 'left' ? 'right' : 'left';
      const quieter = r.layoutDetail.otherDb < -100 ? 'silent' : `${Math.round(-r.layoutDetail.otherDb)} dB quieter`;
      notes.push(`Only the ${used} channel carries signal (the ${other} is ${quieter}), so the ${used} channel was analysed.`);
    }
    if (r.layout === 'sum') notes.push('The channels differ, so their mono sum was analysed. Clipping was checked on each channel.');
    if (truncated) notes.push(`Only the first ${fmtDuration(Analysis.MAX_SECONDS)} were analysed.`);
    if (resampled) {
      notes.push(info.sampleRate
        ? `The browser would not decode at the file’s ${info.sampleRate} Hz, so it was resampled to ${decodedAt} Hz. Levels are unaffected; the spectral values are approximate.`
        : `The sample rate could not be read from the file header, so it was decoded at ${decodedAt} Hz. If that is not its native rate, the spectral values are approximate.`);
    }
    return `<span class="file-name">${esc(name)}</span>`
      + facts.map((f) => `<span>${esc(f)}</span>`).join('')
      + notes.map((n) => `<span class="file-note">${esc(n)}</span>`).join('');
  }

  function valueMarkup(value) {
    const m = /^(\S+)\s(.+)$/.exec(value);
    return m ? `${esc(m[1])}<span class="unit">${esc(m[2])}</span>` : esc(value);
  }

  function tileMarkup(item) {
    return `<details class="tile status-${item.status}" id="item-${item.id}"><summary>`
      + `<span class="tile-label">${esc(item.label)}</span>`
      + `<span class="tile-value">${valueMarkup(item.value)}</span>`
      + `<span class="tile-status"><span class="dot"></span>${esc(item.note)}</span>`
      + `<span class="tile-target">${esc(item.target)}</span>`
      + `</summary>${bodyMarkup(item)}</details>`;
  }

  function itemMarkup(item) {
    const status = item.status === 'info' ? '' : Report.STATUS_LABEL[item.status];
    const note = [status, item.note].filter((s, i, all) => s && all.indexOf(s) === i).join(' · ');
    return `<details class="item status-${item.status}" id="item-${item.id}"><summary>`
      + `<span class="dot"></span><span class="item-label">${esc(item.label)}</span>`
      + `<span class="item-value">${esc(item.value)}</span><span class="chevron"></span>`
      + `<span class="item-meta"><span class="item-note">${esc(note)}</span><span class="item-target">${esc(item.target)}</span></span>`
      + `</summary>${bodyMarkup(item)}</details>`;
  }

  function bodyMarkup(item) {
    let html = '<div class="item-body">';
    html += item.explanation.map((p) => `<p><strong>${esc(p.lead)}</strong> ${esc(p.text)}</p>`).join('');
    if (item.events && item.events.length) {
      const more = item.eventsTotal > item.events.length ? ` (${item.events.length} of ${item.eventsTotal})` : '';
      html += `<div class="events"><div class="events-title">${esc(item.eventsTitle || 'Where')}${more} · click to listen</div><ul>`
        + item.events.map((e) => `<li><button type="button" class="stamp" data-t="${e.t}">${Report.fmtTime(e.t)}<span class="stamp-label">${esc(e.label)}</span></button></li>`).join('')
        + '</ul></div>';
    }
    if (item.chart && item.chart.type === 'bands') html += bandsMarkup(item.chart.bands);
    if (item.chart && item.chart.type === 'pitch') html += pitchChartMarkup(item.chart);
    return `${html}</div>`;
  }

  function summaryMarkup(summary) {
    return '<h2>What to do</h2>'
      + `<p class="summary-intro">${esc(summary.intro)}</p>`
      + (summary.actions.length
        ? `<ol class="actions">${summary.actions.map((a) => `<li><strong>${esc(a.title)}</strong>${esc(a.text)}</li>`).join('')}</ol>`
        : '')
      + `<p class="summary-note">${esc(summary.note)}</p>`;
  }

  const kHz = (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));

  function bandsMarkup(bands) {
    const max = Math.max(1, Math.max.apply(null, bands.map((b) => b.percent)));
    return `<div class="bands" role="img" aria-label="Share of energy per frequency band">${bands.map((b) => {
      const h = ((b.percent / max) * 100).toFixed(1);
      return `<div class="band" title="${kHz(b.lo)}–${kHz(b.hi)} Hz: ${b.percent.toFixed(1)} %, ${esc(Report.fmtDb(b.db))} RMS">`
        + `<div class="band-track"><span class="band-value" style="bottom:calc(${h}% + 4px)">${b.percent.toFixed(0)} %</span>`
        + `<div class="band-bar" style="height:${h}%"></div></div>`
        + `<div class="band-label">${kHz(b.lo)}–${kHz(b.hi)}</div></div>`;
    }).join('')}</div>`;
  }

  // f0 over time on a semitone axis; unvoiced frames leave gaps.
  function pitchChartMarkup(chart) {
    const W = 800;
    const H = 170;
    const left = 34;
    const bottom = 18;
    const top = 8;
    const { track, hopSeconds } = chart;
    const frames = track.length;
    const lowMidi = Math.floor(Pitch.freqToMidi(chart.lowHz, 440)) - 2;
    const highMidi = Math.ceil(Pitch.freqToMidi(chart.highHz, 440)) + 2;
    const span = Math.max(1, highMidi - lowMidi);
    const y = (midi) => top + ((highMidi - midi) / span) * (H - top - bottom);

    // Gridlines: every natural note for a narrow range, C and G for a wider one, only C beyond that.
    const NATURALS = [0, 2, 4, 5, 7, 9, 11];
    const onGrid = (m) => {
      const pc = ((m % 12) + 12) % 12;
      return span <= 14 ? NATURALS.includes(pc) : span <= 30 ? pc === 0 || pc === 7 : pc === 0;
    };
    let grid = '';
    for (let m = lowMidi; m <= highMidi; m++) {
      if (!onGrid(m)) continue;
      grid += `<line class="grid" x1="${left}" x2="${W}" y1="${y(m).toFixed(1)}" y2="${y(m).toFixed(1)}"/>`
        + `<text class="grid-label" x="${left - 6}" y="${(y(m) + 4).toFixed(1)}" text-anchor="end">${esc(noteLabel(m))}</text>`;
    }

    // At most ~1000 points: each bucket shows the median of its voiced frames.
    const bucket = Math.max(1, Math.ceil(frames / 1000));
    let path = '';
    let pen = false;
    for (let f = 0; f < frames; f += bucket) {
      const voiced = [];
      for (let k = f; k < Math.min(frames, f + bucket); k++) if (track[k] > 0) voiced.push(track[k]);
      if (!voiced.length) { pen = false; continue; }
      voiced.sort((a, b) => a - b);
      const hz = voiced[voiced.length >> 1];
      const midi = Pitch.freqToMidi(hz, 440);
      if (midi < lowMidi || midi > highMidi) { pen = false; continue; }
      const px = (left + ((f + bucket / 2) / frames) * (W - left)).toFixed(1);
      const py = y(midi).toFixed(1);
      path += `${pen ? 'L' : 'M'}${px} ${py}`;
      pen = true;
    }

    const total = frames * hopSeconds;
    return `<svg class="pitch-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pitch over time">${grid}`
      + `<path class="trace" d="${path}"/>`
      + `<text class="axis-label" x="${left}" y="${H - 2}">0:00</text>`
      + `<text class="axis-label" x="${W}" y="${H - 2}" text-anchor="end">${fmtDuration(total)}</text></svg>`;
  }

  // ------------------------------------------------------------------ player

  function stopPlayback() {
    if (player.source) {
      try { player.source.stop(); } catch { /* already ended */ }
      player.source.disconnect();
      player.source = null;
    }
    if (player.button) {
      player.button.classList.remove('playing');
      player.button = null;
    }
  }

  // Play a short excerpt starting just before a timestamp; clicking the same
  // stamp again stops it.
  function playAt(t, button) {
    const again = player.button === button;
    stopPlayback();
    if (again || !analysis.buffer) return;
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = analysis.buffer;
    source.connect(ctx.destination);
    const start = Math.max(0, t - PLAY_LEAD_S);
    const duration = Math.min(PLAY_LENGTH_S, analysis.buffer.duration - start);
    source.onended = () => { if (player.source === source) stopPlayback(); };
    source.start(0, start, duration);
    player.source = source;
    player.button = button;
    button.classList.add('playing');
  }

  // ------------------------------------------------------------------- setup

  function svgEl(name, attrs, text) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function centsToX(c) {
    return 500 + c * PX_PER_CENT;
  }

  function buildMeter() {
    const svg = ui.meter;
    svg.appendChild(svgEl('rect', {
      class: 'zone',
      x: centsToX(-IN_TUNE_CENTS),
      y: METER_BASE - 56,
      width: centsToX(IN_TUNE_CENTS) - centsToX(-IN_TUNE_CENTS),
      height: 60,
      rx: 4,
    }));

    for (let c = -50; c <= 50; c += 5) {
      const zero = c === 0;
      const major = c % 25 === 0;
      const h = zero ? 46 : major ? 32 : 18;
      const x = centsToX(c);
      svg.appendChild(svgEl('line', {
        class: `tick${zero ? ' tick-zero' : major ? ' tick-major' : ''}`,
        x1: x, y1: METER_BASE - h, x2: x, y2: METER_BASE,
      }));
      if (major) {
        svg.appendChild(svgEl('text', {
          class: 'tick-label', x, y: METER_BASE + 34, 'text-anchor': 'middle',
        }, zero ? '0' : (c > 0 ? '+' : '−') + Math.abs(c)));
      }
    }

    svg.appendChild(svgEl('text', { class: 'tick-symbol', x: 40, y: METER_BASE - 2, 'text-anchor': 'middle' }, '♭'));
    svg.appendChild(svgEl('text', { class: 'tick-symbol', x: 960, y: METER_BASE - 2, 'text-anchor': 'middle' }, '♯'));

    needle = svgEl('g', { class: 'needle' });
    needle.appendChild(svgEl('rect', { x: 497, y: 24, width: 6, height: METER_BASE - 24 + 4, rx: 3 }));
    svg.appendChild(needle);
  }

  function buildStrings() {
    const tuning = currentTuning();
    ui.strings.innerHTML = '';
    stringEls = tuning.notes.map((midi, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'string';
      button.innerHTML = `<span class="s-name">${noteMarkup(Pitch.noteName(midi))}</span><span class="s-oct">${Pitch.noteOctave(midi)}</span>`;
      button.title = `${Pitch.midiToFreq(midi, settings.a4).toFixed(2)} Hz — click to ${tone.on ? 'hear it and lock the tuner to it' : 'lock the tuner to this string'}`;
      button.addEventListener('click', () => {
        const release = lockedString === i;
        lockedString = release ? -1 : i;
        if (tone.on) {
          if (release) stopTone();
          else startTone(i);
        }
        updateLockMarks();
      });
      ui.strings.appendChild(button);
      return button;
    });
    updateLockMarks();
  }

  function updateLockMarks() {
    stringEls.forEach((el, i) => {
      el.classList.toggle('locked', i === lockedString);
      el.classList.toggle('sounding', i === tone.string);
    });
    lastRenderKey = '';
    if (!running) applyView(null);
  }

  function setA4(value) {
    settings.a4 = clamp(Math.round(value), 415, 466);
    ui.a4.textContent = String(settings.a4);
    saveSettings();
    buildStrings();
    retuneTone();
  }

  function fillTunings() {
    let group = null;
    TUNINGS.forEach((t) => {
      if (!group || group.label !== t.group) {
        group = document.createElement('optgroup');
        group.label = t.group;
        ui.tuning.appendChild(group);
      }
      group.appendChild(new Option(t.name, t.id));
    });
    ui.tuning.value = currentTuning().id;
  }

  function init() {
    fillTunings();
    ui.channel.value = settings.channel;
    ui.a4.textContent = String(settings.a4);
    const { beats, subdivision, countIn } = metro.clock.options;  // stored values, kept in range
    Object.assign(settings, { beats, subdivision, countIn });
    ui.beats.value = String(settings.beats);
    ui.subdivision.value = String(settings.subdivision);
    ui.countIn.value = String(settings.countIn);
    applyTheme();
    buildMeter();
    buildStrings();
    buildBeatDots();
    applyView(null);
    renderTempo();
    renderClickState();
    setMode(settings.mode);
    refreshDevices();

    ui.start.addEventListener('click', start);
    ui.listen.addEventListener('click', () => {
      ui.listen.blur();
      start();
    });
    ui.stop.addEventListener('click', stop);
    ui.tone.addEventListener('click', () => setToneMode(!tone.on));
    ui.theme.addEventListener('click', () => {
      settings.theme = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
      saveSettings();
      applyTheme();
    });

    ui.segs.forEach((b) => b.addEventListener('click', () => {
      setMode(b.dataset.mode);
      b.blur();
    }));

    // pointerdown rather than click: it fires the moment the button is touched.
    ui.tap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      onTap(performance.now());
    });
    ui.tempoReset.addEventListener('click', () => {
      resetTempo();
      ui.tempoReset.blur();
    });

    // Buttons in tempo mode give up focus after a click, so the space bar keeps tapping.
    ui.bpmDown.addEventListener('click', () => {
      setBpm(settings.bpm - 1);
      ui.bpmDown.blur();
    });
    ui.bpmUp.addEventListener('click', () => {
      setBpm(settings.bpm + 1);
      ui.bpmUp.blur();
    });
    ui.bpm.addEventListener('focus', () => ui.bpm.select());
    ui.bpm.addEventListener('input', fitBpm);
    ui.bpm.addEventListener('change', commitTypedBpm);
    ui.bpm.addEventListener('blur', showBpm);   // also tidies away anything unparseable
    ui.bpm.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        ui.bpm.blur();
      } else if (e.key === 'Escape') {
        showBpm();
        ui.bpm.blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        commitTypedBpm();
        setBpm(settings.bpm + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
        showBpm();
        ui.bpm.select();
      }
    });

    ui.click.addEventListener('click', () => {
      if (metro.clock.running) stopClick();
      else startClick();
      ui.click.blur();
    });
    const clickSetting = (el, key, after) => el.addEventListener('change', () => {
      settings[key] = Number(el.value);
      saveSettings();
      metro.clock.set(clickOptions());
      if (after) after();
    });
    clickSetting(ui.beats, 'beats', buildBeatDots);
    clickSetting(ui.subdivision, 'subdivision');
    clickSetting(ui.countIn, 'countIn');

    ui.units.forEach((b) => b.addEventListener('click', () => {
      settings.lengthUnit = b.dataset.unit;
      saveSettings();
      renderLengths();
      b.blur();
    }));

    ui.browse.addEventListener('click', () => ui.file.click());
    ui.dropzone.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      ui.file.click();
    });
    ui.file.addEventListener('change', () => {
      if (ui.file.files && ui.file.files[0]) analyseFile(ui.file.files[0]);
    });
    ui.analysisNew.addEventListener('click', () => {
      resetAnalysis();
      ui.analysisNew.blur();
    });
    ui.report.addEventListener('click', (e) => {
      const stamp = e.target.closest('.stamp');
      if (stamp) playAt(Number(stamp.dataset.t), stamp);
    });

    // Files can be dropped anywhere on the page while in analysis mode.
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
      if (settings.mode !== 'analysis' || !hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      ui.app.classList.add('dragging');
    });
    document.addEventListener('dragover', (e) => {
      if (settings.mode !== 'analysis' || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', () => {
      if (dragDepth > 0 && --dragDepth === 0) ui.app.classList.remove('dragging');
    });
    document.addEventListener('drop', (e) => {
      if (settings.mode !== 'analysis') return;
      e.preventDefault();
      dragDepth = 0;
      ui.app.classList.remove('dragging');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) analyseFile(file);
    });

    ui.device.addEventListener('change', async () => {
      settings.deviceId = ui.device.value;
      saveSettings();
      if (!running) return;
      try {
        await openStream(settings.deviceId);
      } catch (err) {
        showError(err);
        stop();
      }
    });

    ui.channel.addEventListener('change', () => {
      settings.channel = ui.channel.value;
      saveSettings();
      if (running && audio.stream) {
        resetReadings();
        buildGraph();
      }
    });

    ui.tuning.addEventListener('change', () => {
      settings.tuning = ui.tuning.value;
      saveSettings();
      lockedString = -1;
      stopTone();
      buildStrings();
    });

    ui.a4Down.addEventListener('click', () => setA4(settings.a4 - 1));
    ui.a4Up.addEventListener('click', () => setA4(settings.a4 + 1));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (lockedString >= 0 || tone.string >= 0)) {
        lockedString = -1;
        stopTone();
        updateLockMarks();
      }
      if (settings.mode !== 'tempo' || e.repeat) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        onTap(performance.now());
      }
    });

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        if (running) refreshDevices();
      });
    }

    // Offline support. Service workers need a secure context such as
    // localhost, and the app works fine without one.
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* not available here */ });
    }
  }

  init();
  requestAnimationFrame(frame);
})();
