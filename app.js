/*
 * app.js — wires the audio input to the pitch detector and drives the UI.
 *
 * Signal path: audio interface → getUserMedia (all browser processing off)
 * → optional channel pick → high-pass (35 Hz, lower for bass) → low-pass 2.2 kHz
 * → AnalyserNode → Pitch.detect() every ~20 ms → short median → display. The
 * window and search range follow the lowest string of the tuning.
 *
 * With Tone switched on, clicking a string also plays its note (a periodic
 * wave with a few overtones) to tune by ear.
 *
 * Tempo mode needs no input: taps (pointer or keyboard) go to
 * Tempo.createTapTempo(), or a tempo is typed. The metronome takes its ticks
 * from Metronome.createClock() and schedules them on the Web Audio clock a
 * little ahead of time, so the click stays steady whatever the page is doing.
 *
 * Record mode shares the tuner's input: the unfiltered signal also goes to
 * recorder-worklet.js, which reports every block's peak and power for the
 * meter and, while recording, the raw samples. Takes stay in memory; they can
 * be played, saved as WAV (Recorder.encodeWav) or handed to the analysis.
 *
 * Analysis mode takes a dropped file: header sniffed for the native sample
 * rate → decodeAudioData in an offline context at that rate → channels handed
 * to analysis-worker.js → Report.build() → cards, timestamps and a summary.
 *
 * Sound lab plays up to eight tones at once: one oscillator and gain per tone
 * into a master gain, levels scaled so the sum never clips. Tones.js names
 * what they make (note, interval or chord) and draws the waveform; the
 * arpeggio schedules its notes on the audio clock like the metronome.
 */
(function () {
  'use strict';

  // The instruments come from tunings.js; custom tunings are added from the settings.
  const PRESET_TUNINGS = Tunings.PRESETS.map(Tunings.build);
  const NEW_TUNING = '__new__';   // the menu entry that opens the custom-tuning editor

  const IN_TUNE_CENTS = 3;        // |cents| at or below this counts as in tune
  const HOLD_MS = 900;            // keep the last reading on screen this long after the note dies
  const HISTORY_MS = 260;         // readings inside this window are median-filtered
  const ANALYSIS_INTERVAL_MS = 20;
  const RING_TIMEOUT_MS = 20000;  // stop pulsing the tempo ring this long after the last tap
  const MAX_FILE_BYTES = 300 * 1024 * 1024;  // decodeAudioData holds the whole file in memory
  const PLAY_LEAD_S = 0.5;        // an excerpt starts this long before its timestamp…
  const PLAY_LENGTH_S = 3;        // …and lasts this long
  const MODES = ['tuner', 'tempo', 'record', 'analysis', 'lab'];
  const INPUT_MODES = ['tuner', 'record'];   // the modes that listen to the interface
  const MAX_TAKE_S = 600;
  const MIN_TAKE_S = 0.2;
  const NOISE_CHECK_S = 5;
  const NOISE_SKIP_S = 0.5;   // the click that started the check, and anything still on its way in
  const METER_FLOOR_DB = -60;
  const METER_TICKS = [-60, -48, -36, -24, -18, -12, -6, 0];
  const THEMES = ['auto', 'light', 'dark'];
  const STORAGE_KEY = 'tuner.settings';

  // Reference tone: the soft sound (Tones.SOFT_HARMONICS), whose overtones
  // still carry on small speakers, where a low E's fundamental alone would be inaudible.
  const TONE_LEVEL = 0.25;
  const TONE_FADE_S = 0.03;

  // Sound lab: the tones' level. Every sound is trimmed to the same loudness
  // (Instruments' gain), and the tones' levels are scaled to add up to at most 1.
  const LAB_LEVEL = 1;
  const LAB_FADE_S = 0.03;
  const LAB_GLIDE_S = 0.008;      // time constant for frequency and level changes while playing
  const ARP_STEP_S = 0.45;        // the arpeggio plays each tone this long…
  const ARP_HOLD_S = 1.8;         // …then all of them together this long
  const LAB_MESSAGE_MS = 3500;
  const LAB_SAVE_MS = 400;
  const KEYS_OCTAVES = 3;         // the keyboard shows three octaves and the next C
  const SCOPE_W = 800;
  const SCOPE_H = 120;
  const SCOPE_COLUMNS = 400;
  const LAB_HINT = 'Click keys to add or remove notes · the space bar plays and stops';
  const LOOP_HINT = 'Drag chords into the loop or click them to add them · drag blocks to reorder them, click one to hear it';
  const EXPORT_RATE = 48000;
  const SOUND_IDS = Instruments.PRESETS.map((p) => p.id);

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
    tuningEdit: $('tuning-edit'),
    tuningDialog: $('tuning-dialog'),
    tuningDialogTitle: $('tuning-dialog-title'),
    tuningForm: $('tuning-form'),
    tuningName: $('tuning-name'),
    tuningStrings: $('tuning-strings'),
    tuningPreview: $('tuning-preview'),
    tuningSave: $('tuning-save'),
    tuningCancel: $('tuning-cancel'),
    tuningDelete: $('tuning-delete'),
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
    recDisplay: document.querySelector('.rec-display'),
    recPeak: $('rec-peak'),
    recStatus: $('rec-status'),
    meterRows: $('meter-rows'),
    meterScale: $('meter-scale'),
    peakReset: $('peak-reset'),
    record: $('record'),
    recordLabel: $('record-label'),
    recTime: $('rec-time'),
    noiseCheck: $('noise-check'),
    noiseResult: $('noise-result'),
    takes: $('takes'),
    takeList: $('take-list'),
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
    wave: $('wave'),
    volume: $('volume'),
    labClear: $('lab-clear'),
    labName: $('lab-name'),
    labDetail: $('lab-detail'),
    labSong: $('lab-song'),
    labPlay: $('lab-play'),
    labPlayLabel: $('lab-play-label'),
    labArp: $('lab-arp'),
    scope: $('scope'),
    scopeSpan: $('scope-span'),
    keys: $('keys'),
    keysDown: $('keys-down'),
    keysUp: $('keys-up'),
    labHint: $('lab-hint'),
    voiceCount: $('voice-count'),
    voiceList: $('voice-list'),
    voicesEmpty: $('voices-empty'),
    voiceAdd: $('voice-add'),
    semiDown: $('semi-down'),
    semiUp: $('semi-up'),
    octDown: $('oct-down'),
    octUp: $('oct-up'),
    roots: $('roots'),
    libOctave: $('lib-octave'),
    libOctaveDown: $('lib-octave-down'),
    libOctaveUp: $('lib-octave-up'),
    libGroups: $('lib-groups'),
    explain: $('explain'),
    explainTitle: $('explain-title'),
    explainText: $('explain-text'),
    explainSong: $('explain-song'),
    songList: $('song-list'),
    songSave: $('song-save'),
    songDialog: $('song-dialog'),
    songDialogTitle: $('song-dialog-title'),
    songForm: $('song-form'),
    songName: $('song-name'),
    songDelete: $('song-delete'),
    songCancel: $('song-cancel'),
    songSaveNew: $('song-save-new'),
    keyTonic: $('key-tonic'),
    keyMode: $('key-mode'),
    keySevenths: $('key-sevenths'),
    progStart: $('prog-start'),
    palette: $('palette'),
    timeline: $('timeline'),
    timelineHint: $('timeline-hint'),
    loopPlay: $('loop-play'),
    loopPlayLabel: $('loop-play-label'),
    loopBpm: $('loop-bpm'),
    loopBpmDown: $('loop-bpm-down'),
    loopBpmUp: $('loop-bpm-up'),
    loopLength: $('loop-length'),
    blockAdd: $('block-add'),
    loopUndo: $('loop-undo'),
    loopClear: $('loop-clear'),
    chordsSound: $('chords-sound'),
    chordsStyle: $('chords-style'),
    chordsVoicing: $('chords-voicing'),
    bassSound: $('bass-sound'),
    bassPattern: $('bass-pattern'),
    drumsPattern: $('drums-pattern'),
    partToggles: {
      chords: document.querySelector('.voice-on[data-part="chords"]'),
      bass: document.querySelector('.voice-on[data-part="bass"]'),
      drums: document.querySelector('.voice-on[data-part="drums"]'),
    },
    partVolumes: { chords: $('chords-volume'), bass: $('bass-volume'), drums: $('drums-volume') },
    exportRepeats: $('export-repeats'),
    exportWav: $('export-wav'),
    exportStems: $('export-stems'),
    exportMidi: $('export-midi'),
    exportStatus: $('export-status'),
  };

  const settings = loadSettings();
  let tunings = collectTunings();
  const audio = {
    ctx: null, stream: null, nodes: [], analyser: null, buffer: null, detector: null, channels: 1,
    capture: null, captureReady: false, workletLoad: null, softWave: null,
  };
  const tapTempo = Tempo.createTapTempo();
  const tone = { on: false, osc: null, gain: null, string: -1 };
  // queue: scheduled beats not yet heard; beat: the one heard last.
  const metro = { clock: Metronome.createClock(clickOptions()), timer: 0, out: null, queue: [], beat: null, countIn: 0 };
  const analysis = { worker: null, buffer: null, file: null, token: 0 };
  const player = { source: null, button: null };
  // capturing: 'take' or 'noise' while samples are being collected.
  const rec = {
    meter: Recorder.createMeter(), capturing: null, stopping: false, chunks: [], frames: 0, startedAt: 0,
    takes: [], nextTake: 1, rows: [], noiseTimer: 0, noisePeakDb: -Infinity,
  };
  // voices: settings.lab.voices with an id each. nodes: voice id → { osc, gain, freq } while playing.
  // preset: what was last loaded from the library; edited: the tones have been changed since.
  const lab = {
    voices: settings.lab.voices.map((v, i) => Object.assign({ id: i + 1 }, v)),
    nextId: settings.lab.voices.length + 1,
    playing: false, out: null, nodes: new Map(), arp: null,
    preset: null, edited: false, rows: new Map(), keyEls: [], chipEls: [], messageTimer: 0, saveTimer: 0,
    scopeAt: 0, scopeData: null,
  };
  // The chord loop while it plays: arrangement (Song.arrange), anchor (audio time of beat 0), until (scheduled
  // up to), cycle and next (the next event), block (the one being heard), keys (its notes, lit on the keyboard).
  const prog = {
    playing: false, timer: 0, buses: null, arrangement: null, anchor: 0, until: 0, cycle: 0, next: 0,
    block: -1, keys: null, blockEls: [], selected: -1, history: [], drag: null, justDragged: false,
    exporting: false, messageTimer: 0, saveTimer: 0,
  };

  let running = false;
  let lockedString = -1;          // index into the current tuning's targets, or -1 for automatic
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
      bpm: 120, beats: 4, subdivision: 1, countIn: 0, lengthUnit: 'ms', customTunings: [],
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
    const isText = (v) => typeof v === 'string';
    s.customTunings = Array.isArray(s.customTunings)
      ? s.customTunings.filter((t) => t && isText(t.id) && isText(t.name) && isText(t.strings))
      : [];
    s.lab = Tones.normaliseState(s.lab, SOUND_IDS);
    s.loop = Song.normaliseLoop(s.loop, SOUND_IDS);
    s.songs = Song.normaliseSongs(s.songs, SOUND_IDS);
    if (!s.songs.some((song) => song.id === s.songId)) s.songId = '';
    return s;
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* private mode etc. — settings just won't persist */
    }
  }

  function collectTunings() {
    const custom = settings.customTunings
      .map((t) => Tunings.build(Object.assign({}, t, { group: 'Custom', custom: true })))
      .filter(Boolean);
    return PRESET_TUNINGS.concat(custom);
  }

  function currentTuning() {
    return tunings.find((t) => t.id === settings.tuning) || tunings[0];
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
      audio.captureReady = await loadCaptureWorklet();
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

  // The start overlay belongs to the modes that listen, while they are not
  // listening. With Tone on the tuner's strings are usable without listening.
  function syncOverlay() {
    ui.overlay.hidden = running || !INPUT_MODES.includes(settings.mode) || (settings.mode === 'tuner' && tone.on);
  }

  // Record mode's capture runs in an AudioWorklet, loaded once per context.
  // Without it (an old browser) the tuner still works; recording does not.
  function loadCaptureWorklet() {
    if (!audio.workletLoad) {
      audio.workletLoad = audio.ctx.audioWorklet
        ? audio.ctx.audioWorklet.addModule('recorder-worklet.js').then(() => true, () => false)
        : Promise.resolve(false);
    }
    return audio.workletLoad;
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
    if (rec.capturing) finishCapture();   // keep what was captured so far
    audio.nodes.forEach((n) => {
      try { n.disconnect(); } catch { /* already disconnected */ }
    });
    audio.nodes = [];
    audio.analyser = null;
    if (audio.capture) audio.capture.port.onmessage = null;
    audio.capture = null;
    renderRecordState();
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

    const range = detectorRange(ctx.sampleRate);

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = range.highpass;
    highpass.Q.value = 0.7;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 2200;
    lowpass.Q.value = 0.7;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = range.window;
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

    // Record mode gets the unfiltered input, in as many channels as it has.
    if (audio.captureReady) {
      const capture = new AudioWorkletNode(ctx, 'capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCountMode: 'max', channelInterpretation: 'discrete',
      });
      capture.port.onmessage = (e) => onCaptureMessage(e.data);
      tap.connect(capture);
      capture.connect(sink);
      nodes.push(capture);
      audio.capture = capture;
    }
    renderRecordState();

    audio.nodes = nodes;
    audio.analyser = analyser;
    audio.buffer = new Float32Array(analyser.fftSize);
    audio.detector = Pitch.createDetector({
      sampleRate: ctx.sampleRate,
      bufferSize: analyser.fftSize,
      minFreq: range.minFreq,
      maxFreq: 1400,
    });
  }

  // What the detector needs for the current tuning. Low strings (bass, 8-string)
  // get a lower search range, a gentler high-pass, and a longer window: at
  // least four cycles of the lowest string, never less than ≈ 85 ms.
  function detectorRange(sampleRate) {
    const lowest = Pitch.midiToFreq(currentTuning().lowest, settings.a4);
    const seconds = Math.max(0.085, 4 / lowest);
    let window = 2048;
    while (window < seconds * sampleRate && window < 32768) window *= 2;
    return {
      minFreq: Math.min(55, 0.75 * lowest),
      highpass: Math.min(35, 0.6 * lowest),
      window,
    };
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
    } else if (settings.mode === 'record' && running) {
      renderRecord(now);
    } else if (settings.mode === 'lab') {
      if (prog.playing) renderPlayhead();
      drawLiveScope(now);
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

      // Every string counts, octave partners on a 12-string included.
      let nearest = 0;
      let best = Infinity;
      tuning.targets.forEach((t, i) => {
        const d = Math.abs(exact - t.midi);
        if (d < best) { best = d; nearest = i; }
      });
      const target = lockedString >= 0 ? lockedString : nearest;
      const targetMidi = tuning.targets[target].midi;
      const matched = note.midi === targetMidi;
      const cents = lockedString >= 0 ? (exact - targetMidi) * 100 : note.cents;
      const inTune = matched && Math.abs(cents) <= IN_TUNE_CENTS;
      view = { note, cents, target, targetMidi, matched, inTune, exact, freq: currentFreq, flats: tuning.flats };
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

    ui.noteName.innerHTML = noteMarkup(Tunings.noteName(view.note.midi, view.flats));
    ui.noteOctave.textContent = String(view.note.octave);

    // The readout is always relative to the nearest note; only the meter follows a locked string.
    const rounded = Math.round(view.note.cents);
    const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
    ui.freq.textContent = `${view.freq.toFixed(1)} Hz · ${sign}${Math.abs(rounded)} ¢`;

    let hint;
    if (view.inTune) hint = 'In tune';
    else if (view.matched) hint = view.cents < 0 ? 'Tune up ↑' : 'Tune down ↓';
    else hint = `${view.exact < view.targetMidi ? 'Tune up ↑' : 'Tune down ↓'} to ${noteLabel(view.targetMidi, view.flats)}`;
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
    const { targets, flats } = currentTuning();
    if (tone.string >= 0) return `Playing ${noteLabel(targets[tone.string].midi, flats)} · click it again to stop`;
    if (lockedString >= 0) return `Locked to ${noteLabel(targets[lockedString].midi, flats)}`;
    if (tone.on) return 'Click a string to hear it';
    return '';
  }

  function noteMarkup(name) {
    return name.length > 1 ? `${name[0]}<sup>${name.slice(1)}</sup>` : name;
  }

  function noteLabel(midi, flats) {
    return Tunings.noteLabel(midi, flats);
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

  const toneFrequency = (i) => Pitch.midiToFreq(currentTuning().targets[i].midi, settings.a4);

  function startTone(i) {
    stopTone();
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    osc.setPeriodicWave(softWave());
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

  // The soft sound, shared by the reference tone and Sound lab.
  function softWave() {
    if (!audio.softWave) {
      const h = Tones.SOFT_HARMONICS;
      audio.softWave = audioContext().createPeriodicWave(new Float32Array(h.length), Float32Array.from(h));
    }
    return audio.softWave;
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
    if (settings.mode !== 'record' && rec.capturing) stopCapture();
    if (settings.mode !== 'lab') {
      stopLab();
      stopArpeggio();
      stopLoop();
    }
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
    else if (info.format === 'recording') facts.push('recorded in Record mode');
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

  // ------------------------------------------------------------------ record

  const fmtDbfs = (db) => (Number.isFinite(db) ? `${db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}` : '−∞');
  const meterPct = (db) => clamp((db - METER_FLOOR_DB) / -METER_FLOOR_DB, 0, 1);
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

  // Which part of the scale a level is in; colours the bar.
  function meterZone(db) {
    const t = Recorder.TARGET;
    if (db > t.ceiling) return 'over';
    if (db > t.high) return 'hot';
    if (db >= t.low) return 'good';
    return 'low';
  }

  function onCaptureMessage(msg) {
    if (msg.type === 'meter') {
      rec.meter.update(msg, performance.now() / 1000);
    } else if (msg.type === 'chunk' && rec.capturing) {
      rec.chunks.push(msg.channels);
      rec.frames += msg.channels[0].length;
      if (rec.capturing === 'take' && rec.frames >= MAX_TAKE_S * audio.ctx.sampleRate) stopCapture();
    } else if (msg.type === 'stopped' && rec.capturing) {
      finishCapture();
    }
  }

  function startCapture(purpose) {
    if (!audio.capture || rec.capturing) return;
    stopPlayback();
    Object.assign(rec, { capturing: purpose, stopping: false, chunks: [], frames: 0, startedAt: performance.now() });
    audio.capture.port.postMessage({ type: 'record', on: true });
    renderRecordState();
  }

  // The worklet sends what it still holds, then 'stopped', which finishes the capture.
  function stopCapture() {
    if (!rec.capturing || rec.stopping) return;
    rec.stopping = true;
    clearTimeout(rec.noiseTimer);
    if (audio.capture) audio.capture.port.postMessage({ type: 'record', on: false });
    else finishCapture();
    renderRecordState();
  }

  function finishCapture() {
    const purpose = rec.capturing;
    const channels = joinChunks(rec.chunks);
    const sampleRate = audio.ctx.sampleRate;
    Object.assign(rec, { capturing: null, stopping: false, chunks: [], frames: 0 });
    clearTimeout(rec.noiseTimer);
    if (purpose === 'take') addTake(channels, sampleRate);
    else if (purpose === 'noise') showNoiseResult(channels, sampleRate);
    renderRecordState();
  }

  function joinChunks(chunks) {
    if (!chunks.length) return [];
    const count = Math.min.apply(null, chunks.map((c) => c.length));
    const total = chunks.reduce((n, c) => n + c[0].length, 0);
    return Array.from({ length: count }, (_, ch) => {
      const out = new Float32Array(total);
      let pos = 0;
      chunks.forEach((c) => {
        out.set(c[ch], pos);
        pos += c[ch].length;
      });
      return out;
    });
  }

  function renderRecordState() {
    const recording = rec.capturing === 'take';
    ui.app.classList.toggle('recording', recording);
    ui.record.setAttribute('aria-pressed', String(recording));
    ui.recordLabel.textContent = recording ? 'Stop' : 'Record';
    ui.record.disabled = !audio.capture || rec.capturing === 'noise' || rec.stopping;
    ui.noiseCheck.disabled = !audio.capture || !!rec.capturing;
    if (!recording) ui.recTime.textContent = '0:00';
  }

  function buildMeterRows(count) {
    const labels = count === 2 ? ['L', 'R'] : count === 1 ? [''] : Array.from({ length: count }, (_, i) => String(i + 1));
    const t = Recorder.TARGET;
    const zone = `left:${(meterPct(t.low) * 100).toFixed(2)}%;width:${((meterPct(t.high) - meterPct(t.low)) * 100).toFixed(2)}%`;
    ui.meterRows.innerHTML = labels.map((label) => '<div class="meter-row" data-zone="low">'
      + `<span class="meter-label">${label}</span>`
      + `<div class="meter-track"><div class="meter-zone" style="${zone}"></div><div class="meter-bar meter-peak"></div>`
      + '<div class="meter-bar meter-rms"></div><div class="meter-hold"></div></div>'
      + '<span class="meter-value">—</span>'
      + '<button type="button" class="clip" title="Shows when a sample reached full scale · click to reset">Clip</button></div>').join('');
    rec.rows = Array.from(ui.meterRows.children, (el) => ({
      el,
      peak: el.querySelector('.meter-peak'),
      rms: el.querySelector('.meter-rms'),
      hold: el.querySelector('.meter-hold'),
      value: el.querySelector('.meter-value'),
      clip: el.querySelector('.clip'),
    }));
  }

  function buildMeterScale() {
    ui.meterScale.innerHTML = '<span></span><div class="meter-ticks">'
      + METER_TICKS.map((db) => `<span style="left:${(meterPct(db) * 100).toFixed(2)}%">${db < 0 ? '−' : ''}${Math.abs(db)}</span>`).join('')
      + '</div><span></span><span></span>';
  }

  function renderRecord(now) {
    const m = rec.meter.read(now / 1000);
    if (m.channels.length && m.channels.length !== rec.rows.length) buildMeterRows(m.channels.length);
    m.channels.forEach((c, i) => {
      const row = rec.rows[i];
      row.peak.style.transform = `scaleX(${meterPct(c.peakDb).toFixed(4)})`;
      row.rms.style.transform = `scaleX(${meterPct(c.rmsDb).toFixed(4)})`;
      const holding = c.holdDb > METER_FLOOR_DB;
      row.hold.style.opacity = holding ? '1' : '0';
      row.hold.style.left = `${(meterPct(c.holdDb) * 100).toFixed(2)}%`;
      const zone = meterZone(c.peakDb);
      if (row.el.dataset.zone !== zone) row.el.dataset.zone = zone;
      setText(row.value, holding ? fmtDbfs(c.holdDb) : '—');
      row.clip.classList.toggle('on', c.clipped);
    });

    const status = audio.capture
      ? Recorder.levelStatus(m.maxDb, m.clipped)
      : { status: 'bad', text: 'This browser can’t capture audio here, so the meter and recording are unavailable' };
    setText(ui.recPeak, m.maxDb > METER_FLOOR_DB ? fmtDbfs(m.maxDb) : '—');
    setText(ui.recStatus, status.text);
    if (ui.recDisplay.dataset.status !== status.status) ui.recDisplay.dataset.status = status.status;
    if (rec.capturing === 'take') setText(ui.recTime, fmtDuration(Math.floor((now - rec.startedAt) / 1000)));
  }

  function toggleRecord() {
    if (rec.capturing === 'take') stopCapture();
    else startCapture('take');
    ui.record.blur();
  }

  // ---- takes

  function addTake(channels, sampleRate) {
    const frames = channels.length ? channels[0].length : 0;
    if (frames < MIN_TAKE_S * sampleRate) return;
    let peak = 0;
    channels.forEach((c) => {
      for (let i = 0; i < c.length; i++) {
        const a = Math.abs(c[i]);
        if (a > peak) peak = a;
      }
    });
    const id = rec.nextTake++;
    rec.takes.unshift({
      id, name: `Take ${id}`, channels, sampleRate, duration: frames / sampleRate,
      peakDb: Recorder.dbfs(peak), recordedAt: new Date(), buffer: null,
    });
    renderTakes();
  }

  function renderTakes() {
    ui.takes.hidden = !rec.takes.length;
    ui.takeList.innerHTML = rec.takes.map((t) => `<li class="take" data-id="${t.id}">`
      + `<button type="button" class="take-play" data-action="play" aria-label="Play ${t.name}"><span class="play-icon" aria-hidden="true"></span></button>`
      + `<span class="take-info"><span class="take-name">${t.name}</span>`
      + `<span class="take-meta">${fmtDuration(t.duration)} · ${t.channels.length === 1 ? 'mono' : 'stereo'} · peak ${fmtDbfs(t.peakDb)} dBFS</span></span>`
      + '<span class="take-actions">'
      + `<button type="button" class="ghost small" data-action="check" title="Run the recording check on this take">Check</button>`
      + `<button type="button" class="ghost small" data-action="download" title="Save as a 24-bit WAV file">WAV</button>`
      + `<button type="button" class="ghost small" data-action="delete" aria-label="Delete ${t.name}">Delete</button>`
      + '</span></li>').join('');
  }

  function takeBuffer(take) {
    if (!take.buffer) {
      const buffer = audioContext().createBuffer(take.channels.length, take.channels[0].length, take.sampleRate);
      take.channels.forEach((c, i) => buffer.copyToChannel(c, i));
      take.buffer = buffer;
    }
    return take.buffer;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function downloadTake(take) {
    const d = take.recordedAt;
    const wav = Recorder.encodeWav(take.channels, take.sampleRate, 24);
    download(wav, 'audio/wav', `${take.name} ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}-${pad2(d.getMinutes())}.wav`);
  }

  // Hands the take to Analysis mode, as if it had been dropped there.
  function checkTake(take) {
    stopPlayback();
    setMode('analysis');
    resetAnalysis();
    const token = analysis.token;
    const buffer = takeBuffer(take);
    analysis.buffer = buffer;
    analysis.file = {
      name: `${take.name}.wav`,
      info: { format: 'recording' },
      decodedAt: take.sampleRate,
      resampled: false,
      truncated: buffer.duration > Analysis.MAX_SECONDS,
    };
    showAnalysisStage('progress');
    setProgress(0, 'Analysing…');
    runWorker(buffer, token);
  }

  function deleteTake(take) {
    const row = ui.takeList.querySelector(`.take[data-id="${take.id}"]`);
    if (player.button && row && row.contains(player.button)) stopPlayback();
    rec.takes = rec.takes.filter((t) => t !== take);
    renderTakes();
  }

  // ---- room noise

  function startNoiseCheck() {
    if (rec.capturing || !audio.capture) return;
    // The loudest peak so far, for the signal-to-noise estimate: taken now, before the silence.
    rec.noisePeakDb = rec.meter.read(performance.now() / 1000).maxDb;
    startCapture('noise');
    const end = performance.now() + NOISE_CHECK_S * 1000;
    ui.noiseResult.hidden = false;
    ui.noiseResult.className = 'noise-result measuring';
    const tick = () => {
      if (rec.capturing !== 'noise') return;
      const left = Math.ceil((end - performance.now()) / 1000);
      if (left <= 0) {
        stopCapture();
        return;
      }
      ui.noiseResult.innerHTML = `<p class="noise-count">Stay quiet… ${left}</p>`
        + '<p class="noise-hint">Don’t play or touch anything. This measures the room, the cables and the interface at the current gain.</p>';
      rec.noiseTimer = setTimeout(tick, 200);
    };
    tick();
    ui.noiseCheck.blur();
  }

  function showNoiseResult(channels, sampleRate) {
    const skip = Math.round(NOISE_SKIP_S * sampleRate);
    if (!channels.length || channels[0].length < skip + sampleRate) {
      ui.noiseResult.hidden = true;   // cut short: nothing to say
      return;
    }
    const quiet = channels.map((c) => c.subarray(skip));
    const v = Recorder.noiseVerdict(Analysis.analyse(quiet, sampleRate, {}), rec.noisePeakDb);
    ui.noiseResult.className = `noise-result status-${v.status}`;
    ui.noiseResult.innerHTML = '<header><span class="dot"></span>'
      + `<h2>${esc(v.title)}</h2><button type="button" class="link" data-action="close">Close</button></header>`
      + `<p class="noise-text">${esc(v.text)}</p>`
      + (v.lines.length
        ? `<ul>${v.lines.map((l) => `<li class="status-${l.status}"><span class="dot"></span><span class="nr-label">${esc(l.label)}</span>`
          + `<span class="nr-value">${esc(l.value)}</span>${l.text ? `<span class="nr-text">${esc(l.text)}</span>` : ''}</li>`).join('')}</ul>`
        : '')
      + (v.warnings || []).map((w) => `<p class="nr-warning">${esc(w)}</p>`).join('');
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

  // Plays (part of) a buffer and marks the button; clicking the same button
  // again stops it.
  function playBuffer(buffer, button, offset, duration) {
    const again = player.button === button;
    stopPlayback();
    if (again || !buffer) return;
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => { if (player.source === source) stopPlayback(); };
    source.start(0, offset, duration);
    player.source = source;
    player.button = button;
    button.classList.add('playing');
  }

  // A short excerpt starting just before a timestamp of the report.
  function playAt(t, button) {
    const buffer = analysis.buffer;
    const start = Math.max(0, t - PLAY_LEAD_S);
    playBuffer(buffer, button, start, buffer ? Math.min(PLAY_LENGTH_S, buffer.duration - start) : 0);
  }

  function playTake(take, button) {
    playBuffer(takeBuffer(take), button, 0, take.duration);
  }

  // --------------------------------------------------------------- sound lab

  const BLACK_KEYS = [1, 3, 6, 8, 10];
  const pitchClass = (midi) => ((midi % 12) + 12) % 12;
  const exactMidi = (freq) => Pitch.freqToMidi(freq, settings.a4);
  const nearestMidi = (freq) => Math.round(exactMidi(freq));
  const fmtHz = (freq) => fmtNumber(freq, freq < 1000 ? 2 : 1);
  const soundingVoices = () => lab.voices.filter((v) => v.on).sort((a, b) => a.freq - b.freq);
  const voiceById = (id) => lab.voices.find((v) => v.id === id);
  const isWave = (id) => Instruments.byId(id).engine === 'wave';
  // Volume sliders are squared, so their middle sounds like the middle.
  const monitorLevel = () => settings.lab.volume * settings.lab.volume;
  const partLevel = (volume) => volume * volume;

  function centsText(cents) {
    const r = Math.round(cents);
    return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)} ¢`;
  }

  // From wherever a level is now down to silence, even halfway through a change.
  function fadeOut(param, t) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else param.cancelScheduledValues(t);
    param.setTargetAtTime(0, t, LAB_FADE_S / 3);
  }

  // Sound lab's mix on the page's context: the tones, the loop's parts and the
  // previews, each with a reverb send, into a limiter, then the Volume slider.
  // Exports render their own mix, so the slider never changes a file.
  function labMixer() {
    if (!audio.mixer) {
      const ctx = audioContext();
      audio.monitor = ctx.createGain();
      audio.monitor.gain.value = monitorLevel();
      audio.monitor.connect(ctx.destination);
      audio.mixer = Instruments.createMixer(ctx, audio.monitor);
      audio.mixer.part('drums').send.gain.value = 0.08;
      // The live waveform listens after the limiter; a muted sink keeps the analyser running in every browser.
      audio.scope = ctx.createAnalyser();
      audio.scope.fftSize = 4096;
      const sink = ctx.createGain();
      sink.gain.value = 0;
      audio.mixer.output.connect(audio.scope);
      audio.scope.connect(sink);
      sink.connect(ctx.destination);
      audio.mixer.setSound('tones', settings.lab.sound);
      applyPartLevels();
    }
    return audio.mixer;
  }

  function startLab() {
    if (lab.playing || !lab.voices.length) return;
    stopArpeggio();
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    lab.out = ctx.createGain();
    lab.out.gain.setValueAtTime(0, t);
    lab.out.gain.setTargetAtTime(LAB_LEVEL, t, LAB_FADE_S / 3);
    lab.out.connect(labMixer().part('tones').input);
    lab.playing = true;
    syncLab();
    renderLabPlaying();
  }

  function stopLab() {
    if (!lab.playing) return;
    const t = audio.ctx.currentTime;
    const out = lab.out;
    fadeOut(out.gain, t);
    lab.nodes.forEach((n) => n.voice.stop(t + LAB_FADE_S * 3));
    setTimeout(() => out.disconnect(), LAB_FADE_S * 3000 + 100);
    Object.assign(lab, { playing: false, out: null, nodes: new Map() });
    renderLabPlaying();
  }

  // A tone's note ends (its release plays out), so the next sync strikes it afresh.
  function dropVoiceNode(id, t) {
    const n = lab.nodes.get(id);
    if (!n) return;
    n.voice.stop(t);
    setTimeout(() => n.level.disconnect(), 5000);   // after the longest release
    lab.nodes.delete(id);
  }

  // Brings the notes in line with the tones: new ones are struck, removed ones
  // released, changed ones glide. Each tone has its own level, scaled so that
  // the tones together never go past full scale (Tones.mixSample, which draws
  // the plain waves, does the same).
  function syncLab() {
    if (!lab.playing) return;
    const ctx = audio.ctx;
    const t = ctx.currentTime;
    const scale = 1 / Math.max(1, lab.voices.reduce((s, v) => s + (v.on ? v.gain : 0), 0));
    const ids = new Set(lab.voices.map((v) => v.id));
    Array.from(lab.nodes.keys()).forEach((id) => { if (!ids.has(id)) dropVoiceNode(id, t); });
    lab.voices.forEach((v) => {
      let n = lab.nodes.get(v.id);
      if (!n) {
        const level = ctx.createGain();
        level.gain.value = 0;
        level.connect(lab.out);
        n = { level, voice: Instruments.playNote(ctx, level, settings.lab.sound, v.freq, t, Infinity, 1), freq: v.freq };
        lab.nodes.set(v.id, n);
      } else if (n.freq !== v.freq) {
        n.voice.setFreq(v.freq, t);
        n.freq = v.freq;
      }
      n.level.gain.setTargetAtTime(v.on ? v.gain * scale : 0, t, LAB_GLIDE_S);
    });
  }

  // Strikes every sounding tone again: after a change of sound, or to hear a
  // piano or guitar again once it has died away.
  function restrikeLab() {
    if (!lab.playing) return;
    const t = audio.ctx.currentTime;
    Array.from(lab.nodes.keys()).forEach((id) => dropVoiceNode(id, t));
    syncLab();
  }

  // Each sounding tone on its own, lowest first, then all of them together.
  // The notes are scheduled on the audio clock; timers only light the keys along.
  function playArpeggio() {
    const voices = soundingVoices();
    if (voices.length < 2) return;
    stopLab();
    stopArpeggio();
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const out = ctx.createGain();
    out.gain.value = LAB_LEVEL;
    out.connect(labMixer().part('tones').input);
    const t0 = ctx.currentTime + 0.05;
    const together = t0 + voices.length * ARP_STEP_S;
    const end = together + ARP_HOLD_S;
    const scale = 1 / Math.max(1, voices.reduce((s, v) => s + v.gain, 0));
    voices.forEach((v, i) => {
      Instruments.playNote(ctx, out, settings.lab.sound, v.freq, t0 + i * ARP_STEP_S, ARP_STEP_S * 0.9, v.gain);
      Instruments.playNote(ctx, out, settings.lab.sound, v.freq, together, ARP_HOLD_S - 0.4, v.gain * scale);
    });
    const arp = { out, ids: voices.map((v) => v.id), index: -1, timers: [] };
    const at = (time, fn) => arp.timers.push(setTimeout(fn, Math.max(0, (time - ctx.currentTime) * 1000)));
    voices.forEach((v, i) => at(t0 + i * ARP_STEP_S, () => { arp.index = i; renderLab(); }));
    at(together, () => { arp.index = voices.length; renderLab(); });
    at(end + 0.3, stopArpeggio);
    lab.arp = arp;
    renderLabPlaying();
  }

  function stopArpeggio() {
    const arp = lab.arp;
    if (!arp) return;
    arp.timers.forEach(clearTimeout);
    lab.arp = null;
    fadeOut(arp.out.gain, audio.ctx.currentTime);
    setTimeout(() => arp.out.disconnect(), LAB_FADE_S * 3000 + 100);
    renderLab();
  }

  // The voice ids the arpeggio is sounding right now.
  function arpSounding() {
    const arp = lab.arp;
    if (!arp || arp.index < 0) return [];
    return arp.index >= arp.ids.length ? arp.ids : [arp.ids[arp.index]];
  }

  // ---- what the tones make

  // The sounding tones as a note, an interval or a chord, with the spelling
  // their note names should follow (per pitch class; gaps take Tones.NAMES).
  function labAnalysis() {
    const voices = soundingVoices();
    const midis = voices.map((v) => nearestMidi(v.freq));
    const a = { voices, midis, interval: null, pair: null, chord: null, names: new Array(12) };
    if (voices.length > 2) {
      a.chord = Tones.identifyChord(midis);
      if (a.chord) a.names = a.chord.names;
    }
    // Two tones, or more on just two notes (a doubled interval): the interval between the lowest of each.
    const other = midis.findIndex((m) => pitchClass(m) !== pitchClass(midis[0]));
    const twoNotes = other > 0 && midis.every((m) => pitchClass(m) === pitchClass(midis[0]) || pitchClass(m) === pitchClass(midis[other]));
    if (!a.chord && (voices.length === 2 || twoNotes)) {
      a.pair = [0, voices.length === 2 ? 1 : other];
      a.interval = Tones.describeInterval(voices[0].freq, voices[a.pair[1]].freq);
      const [low, high] = Tones.spellInterval(midis[0], midis[a.pair[1]]);
      a.names[pitchClass(midis[0])] = low;
      a.names[pitchClass(midis[a.pair[1]])] = high;
    }
    return a;
  }

  const labNoteName = (midi, names) => names[pitchClass(midi)] || Tones.NAMES[pitchClass(midi)];
  const labOctave = (midi, names) => Tones.writtenOctave(labNoteName(midi, names), midi);
  const labNoteLabel = (midi, names) => labNoteName(midi, names) + labOctave(midi, names);
  // A note for the big readout or a row: accidental raised, octave smaller.
  const labNoteMarkup = (midi, names, octaveClass) => `${noteMarkup(labNoteName(midi, names))}<span class="${octaveClass}">${labOctave(midi, names)}</span>`;

  function renderLab() {
    const a = labAnalysis();
    renderLabDisplay(a);
    renderVoiceRows(a);
    renderKeys(a);
    renderLibraryState();
    renderLabPlaying();   // and the waveform
  }

  function renderLabDisplay(a) {
    const { voices, midis, names } = a;
    const pcs = Array.from(new Set(midis.map(pitchClass)));
    let big = '—';
    let words = false;
    let detail;
    let song = '';
    if (!voices.length) {
      detail = lab.voices.length ? 'Every tone is switched off' : 'Add a tone, click a key or pick a chord';
    } else if (voices.length === 1) {
      big = labNoteMarkup(midis[0], names, 'chord-oct');
      detail = `${fmtHz(voices[0].freq)} Hz · ${centsText((exactMidi(voices[0].freq) - midis[0]) * 100)}`;
    } else if (a.interval) {
      const iv = a.interval;
      big = esc(iv.name);
      words = true;
      const [i, j] = a.pair;
      const parts = [`${labNoteLabel(midis[i], names)} + ${labNoteLabel(midis[j], names)}`];
      if (iv.semitones === 0) parts.push(`${fmtHz(voices[j].freq - voices[i].freq)} Hz apart`);
      else parts.push(`${iv.semitones} semitone${iv.semitones === 1 ? '' : 's'}`);
      if (iv.ratio && iv.semitones > 0) {
        const off = Math.round(iv.offPure);
        parts.push(off === 0 ? `a pure ${iv.ratio}` : `${Math.abs(off)} ¢ ${off < 0 ? 'narrower' : 'wider'} than a pure ${iv.ratio}`);
      }
      detail = parts.join(' · ');
      if (iv.song) song = `Think of ${iv.song}`;
    } else if (a.chord) {
      const c = a.chord;
      big = noteMarkup(c.rootName)
        + (c.suffix ? `<span class="chord-suffix">${esc(c.suffix)}</span>` : '')
        + (c.bass ? `<span class="chord-bass">/${esc(c.bass)}</span>` : '');
      detail = `${c.name}${c.inversion ? `, ${c.inversion}` : ''} · ${c.notes.join(' ')}`;
    } else if (pcs.length === 1) {
      const same = midis.every((m) => m === midis[0]);
      big = same ? labNoteMarkup(midis[0], names, 'chord-oct') : noteMarkup(labNoteName(midis[0], names));
      detail = same ? `${voices.length} tones on ${labNoteLabel(midis[0], names)}` : `${labNoteName(midis[0], names)} in ${new Set(midis).size} octaves`;
    } else {
      big = esc(pcs.map((pc) => labNoteName(pc, names)).join(' '));
      words = true;
      detail = 'No common chord name';
    }
    const beat = fmtNumber(Tones.beatRate(voices.map((v) => v.freq)), 1);
    if (beat !== '0') detail += ` · beating ${beat === '1' ? 'once' : `${beat} times`} a second`;
    ui.labName.innerHTML = big;
    ui.labName.classList.toggle('words', words);
    ui.labName.classList.toggle('empty', !voices.length);
    setText(ui.labDetail, detail);
    setText(ui.labSong, song);
  }

  // What each tone is: its role in the chord, or its interval above the lowest tone.
  function voiceRole(v, midi, a) {
    if (!v.on) return 'Off';
    if (a.chord) return a.chord.roles[pitchClass(midi)] || '';
    if (a.voices.length < 2) return '';
    return v === a.voices[0] ? 'Lowest' : Tones.describeInterval(a.voices[0].freq, v.freq).name;
  }

  // The waveform shows what is playing, live, while an instrument or the loop
  // sounds; otherwise the plain waves' sum is drawn from their maths, which
  // also works in silence and shows beating as a swelling outline.
  const scopeLive = () => ((lab.playing || !!lab.arp) && !isWave(settings.lab.sound)) || prog.playing;

  // Four cycles of the lowest tone, or two beats when tones beat, so the swelling shows.
  function renderScope(voices) {
    const mid = SCOPE_H / 2;
    const amp = mid - 8;
    const y = (value) => (mid - value * amp).toFixed(1);
    let html = `<line class="axis" x1="0" x2="${SCOPE_W}" y1="${mid}" y2="${mid}"/>`;
    let span = '';
    if (voices.length && !isWave(settings.lab.sound)) {
      span = 'shown while playing';
    } else if (voices.length) {
      const freqs = voices.map((v) => v.freq);
      const beat = Tones.beatRate(freqs);
      const seconds = beat ? Math.min(2 / beat, 2) : clamp(4 / freqs[0], 0.002, 0.1);
      const wave = settings.lab.sound;
      const cycles = freqs[freqs.length - 1] * seconds;
      if (cycles * 12 <= 4000) {
        const points = Math.max(SCOPE_COLUMNS, Math.ceil(cycles * 12));
        let d = '';
        for (let i = 0; i <= points; i++) {
          d += `${i ? 'L' : 'M'}${((i / points) * SCOPE_W).toFixed(1)} ${y(Tones.mixSample(voices, wave, (i / points) * seconds))}`;
        }
        html += `<path class="trace" d="${d}"/>`;
      } else {
        // Too many cycles to draw one by one: each column's highs and lows, like a DAW's waveform.
        const SUB = 24;
        const top = [];
        const bottom = [];
        for (let c = 0; c < SCOPE_COLUMNS; c++) {
          let lo = Infinity;
          let hi = -Infinity;
          for (let s = 0; s <= SUB; s++) {
            const value = Tones.mixSample(voices, wave, ((c + s / SUB) / SCOPE_COLUMNS) * seconds);
            if (value < lo) lo = value;
            if (value > hi) hi = value;
          }
          const x = (((c + 0.5) / SCOPE_COLUMNS) * SCOPE_W).toFixed(1);
          top.push(`${x} ${y(hi)}`);
          bottom.unshift(`${x} ${y(lo)}`);
        }
        html += `<path class="envelope" d="M${top.join('L')}L${bottom.join('L')}Z"/>`;
      }
      span = seconds < 0.1 ? `${fmtNumber(seconds * 1000, 1)} ms` : `${fmtNumber(seconds, 2)} s`;
    }
    ui.scope.innerHTML = html;
    ui.scope.setAttribute('aria-label', span ? `Waveform of the tones together over ${span}` : 'Waveform: silence');
    setText(ui.scopeSpan, span);
  }

  // What comes out of the mix, from a rising zero crossing so the picture stands still. About 30 times a second.
  function drawLiveScope(now) {
    if (!scopeLive() || !audio.scope || now - lab.scopeAt < 33) return;
    lab.scopeAt = now;
    const data = lab.scopeData || (lab.scopeData = new Float32Array(audio.scope.fftSize));
    audio.scope.getFloatTimeDomainData(data);
    const span = data.length >> 1;
    let start = 0;
    for (let i = 1; i < span; i++) {
      if (data[i - 1] < 0 && data[i] >= 0) {
        start = i;
        break;
      }
    }
    const mid = SCOPE_H / 2;
    const amp = mid - 8;
    let d = '';
    for (let k = 0; k <= SCOPE_COLUMNS * 2; k++) {
      const v = clamp(data[start + Math.floor((k / (SCOPE_COLUMNS * 2)) * (span - 1))] * 1.6, -1, 1);
      d += `${k ? 'L' : 'M'}${((k / (SCOPE_COLUMNS * 2)) * SCOPE_W).toFixed(1)} ${(mid - v * amp).toFixed(1)}`;
    }
    ui.scope.innerHTML = `<line class="axis" x1="0" x2="${SCOPE_W}" y1="${mid}" y2="${mid}"/><path class="trace" d="${d}"/>`;
    setText(ui.scopeSpan, `live · ${fmtNumber((span / audio.ctx.sampleRate) * 1000, 1)} ms`);
  }

  function renderLabPlaying() {
    const arp = !!lab.arp;
    ui.app.classList.toggle('lab-playing', lab.playing);
    ui.app.classList.toggle('lab-arp', arp);
    ui.labPlay.setAttribute('aria-pressed', String(lab.playing));
    ui.labPlayLabel.textContent = lab.playing ? 'Stop' : 'Play';
    ui.labPlay.disabled = !lab.playing && !lab.voices.length;
    ui.labArp.setAttribute('aria-pressed', String(arp));
    ui.labArp.disabled = !arp && lab.voices.filter((v) => v.on).length < 2;
    if (!scopeLive()) renderScope(soundingVoices());
  }

  function showLabMessage(text) {
    ui.labHint.textContent = text;
    ui.labHint.classList.add('message');
    clearTimeout(lab.messageTimer);
    lab.messageTimer = setTimeout(() => {
      ui.labHint.textContent = LAB_HINT;
      ui.labHint.classList.remove('message');
    }, LAB_MESSAGE_MS);
  }

  // The stored copy follows every change; writing it out waits for a pause, so a slider drag is one write.
  function saveLabSoon() {
    settings.lab.voices = lab.voices.map((v) => ({ freq: v.freq, gain: v.gain, on: v.on }));
    clearTimeout(lab.saveTimer);
    lab.saveTimer = setTimeout(saveSettings, LAB_SAVE_MS);
  }

  // ---- tones

  // After tones are added, removed or replaced: lowest first, fresh rows.
  function voicesChanged() {
    lab.voices.sort((a, b) => a.freq - b.freq);
    if (!lab.voices.length) {
      stopLab();
      stopArpeggio();
    }
    buildVoiceRows();
    syncLab();
    renderLab();
    saveLabSoon();
  }

  // After a tone's frequency, level or on/off changed: the rows stay as they are.
  function voiceEdited() {
    syncLab();
    renderLab();
    saveLabSoon();
  }

  function newVoice(freq, gain, on) {
    return { id: lab.nextId++, freq, gain: gain === undefined ? 1 : gain, on: on !== false };
  }

  function setVoiceFreq(v, freq) {
    v.freq = clamp(freq, Tones.MIN_HZ, Tones.MAX_HZ);
    lab.edited = true;
    voiceEdited();
  }

  function stepVoice(v, dir) {
    const freq = Tones.stepNote(v.freq, dir, settings.a4);
    if (freq === null) showLabMessage('That would leave 20 Hz to 20 kHz, the range Sound lab plays');
    else setVoiceFreq(v, freq);
  }

  // A typed frequency or note takes effect on Enter or leaving the field, which then shows the Hz.
  function commitHz(v, input) {
    const parsed = Tones.parseTone(input.value, settings.a4);
    if (parsed.error) showLabMessage(parsed.error);
    else if (parsed.hz !== v.freq) setVoiceFreq(v, parsed.hz);
    input.value = fmtHz(v.freq);
  }

  // Arrow keys in a frequency: 1 Hz a press, 10 with Shift, from what is typed there.
  function nudgeHz(v, input, step) {
    const typed = Tones.parseTone(input.value, settings.a4);
    const freq = Math.round(((typed.hz || v.freq) + step) * 100) / 100;
    if (freq < Tones.MIN_HZ || freq > Tones.MAX_HZ) return;
    setVoiceFreq(v, freq);
    input.value = fmtHz(v.freq);
  }

  function removeVoice(v) {
    lab.voices = lab.voices.filter((x) => x !== v);
    lab.edited = true;
    if (!lab.voices.length) lab.preset = null;
    voicesChanged();
  }

  // A new tone a 5th above the highest, or A4 to start with.
  function addTone() {
    if (lab.voices.length >= Tones.MAX_VOICES) return;
    const top = Math.max(0, ...lab.voices.map((v) => v.freq));
    let freq = top ? top * Math.pow(2, 7 / 12) : Pitch.midiToFreq(69, settings.a4);
    if (freq > Tones.MAX_HZ) freq = top / Math.pow(2, 5 / 12);
    lab.voices.push(newVoice(freq));
    lab.edited = true;
    voicesChanged();
    startLab();
  }

  function transpose(semis) {
    const factor = Math.pow(2, semis / 12);
    if (lab.voices.some((v) => v.freq * factor < Tones.MIN_HZ || v.freq * factor > Tones.MAX_HZ)) {
      showLabMessage(`That would take a tone ${semis < 0 ? 'below 20 Hz' : 'above 20 kHz'}`);
      return;
    }
    lab.voices.forEach((v) => { v.freq = Math.round(v.freq * factor * 1e6) / 1e6; });
    lab.edited = true;
    voiceEdited();
  }

  function clearLab() {
    lab.voices = [];
    lab.preset = null;
    voicesChanged();
  }

  // A key adds its note, or takes it away again; a switched-off tone on that note is switched back on.
  function toggleKey(midi) {
    const here = lab.voices.filter((v) => nearestMidi(v.freq) === midi);
    let sounds = true;
    if (here.some((v) => v.on)) {
      lab.voices = lab.voices.filter((v) => !here.includes(v));
      sounds = false;
    } else if (here.length) {
      here.forEach((v) => { v.on = true; });
    } else if (lab.voices.length >= Tones.MAX_VOICES) {
      showLabMessage(`Up to ${Tones.MAX_VOICES} tones at once. Remove one first.`);
      return;
    } else {
      lab.voices.push(newVoice(Pitch.midiToFreq(midi, settings.a4)));
    }
    lab.edited = true;
    if (!lab.voices.length) lab.preset = null;
    voicesChanged();
    if (sounds) startLab();
  }

  function buildVoiceRows() {
    ui.voiceList.innerHTML = lab.voices.map((v, i) => voiceRowMarkup(v.id, i + 1)).join('');
    lab.rows = new Map(Array.from(ui.voiceList.children, (el) => [Number(el.dataset.id), {
      el,
      toggle: el.querySelector('.voice-on'),
      name: el.querySelector('.v-name'),
      cents: el.querySelector('.v-cents'),
      info: el.querySelector('.v-info'),
      freq: el.querySelector('.v-freq'),
      hz: el.querySelector('.hz-value'),
      level: el.querySelector('.v-level'),
    }]));
    const count = lab.voices.length;
    ui.voicesEmpty.hidden = count > 0;
    ui.voiceCount.textContent = count ? `${count} of ${Tones.MAX_VOICES}` : '';
    ui.voiceAdd.disabled = count >= Tones.MAX_VOICES;
    [ui.semiDown, ui.semiUp, ui.octDown, ui.octUp, ui.labClear].forEach((b) => { b.disabled = !count; });
  }

  function voiceRowMarkup(id, n) {
    return `<li class="voice" data-id="${id}">`
      + `<button type="button" class="voice-on" data-action="toggle" aria-label="Tone ${n} sounds" title="Switch this tone on or off"></button>`
      + '<div class="voice-note"><span class="v-name"></span><span class="v-cents"></span><span class="v-info"></span></div>'
      + `<input type="range" class="v-freq" min="0" max="${Tones.SLIDER_STEPS}" step="1" aria-label="Frequency of tone ${n}">`
      + '<div class="hz">'
      + '<button type="button" data-action="down" aria-label="Down to the next note" title="Down to the next note">−</button>'
      + `<input type="text" class="hz-value" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="Tone ${n} in Hz"`
      + ' title="Type a frequency, or a note such as A4 · arrow keys: 1 Hz, with Shift 10 Hz">'
      + '<span class="hz-unit">Hz</span>'
      + '<button type="button" data-action="up" aria-label="Up to the next note" title="Up to the next note">+</button>'
      + '</div>'
      + `<input type="range" class="v-level" min="0" max="100" step="1" aria-label="Level of tone ${n}" title="Level">`
      + `<button type="button" class="voice-remove" data-action="remove" aria-label="Remove tone ${n}" title="Remove this tone">`
      + '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
      + '</button></li>';
  }

  function renderVoiceRows(a) {
    const ping = arpSounding();
    lab.voices.forEach((v) => {
      const row = lab.rows.get(v.id);
      if (!row) return;
      const midi = nearestMidi(v.freq);
      row.el.classList.toggle('off', !v.on);
      row.el.classList.toggle('ping', ping.includes(v.id));
      row.toggle.setAttribute('aria-pressed', String(v.on));
      row.name.innerHTML = labNoteMarkup(midi, a.names, 'v-oct');
      setText(row.cents, centsText((exactMidi(v.freq) - midi) * 100));
      setText(row.info, voiceRole(v, midi, a));
      // What someone is typing or dragging stays theirs.
      if (document.activeElement !== row.hz) row.hz.value = fmtHz(v.freq);
      if (document.activeElement !== row.freq) row.freq.value = String(Tones.freqToSlider(v.freq));
      row.level.value = String(Math.round(v.gain * 100));
    });
  }

  // ---- keyboard

  function buildKeys() {
    const first = 12 * (settings.lab.keys + 1);
    let whites = 0;
    ui.keys.innerHTML = '';
    lab.keyEls = [];
    for (let k = 0; k <= 12 * KEYS_OCTAVES; k++) {
      const midi = first + k;
      const black = BLACK_KEYS.includes(k % 12);
      const key = document.createElement('button');
      key.type = 'button';
      key.className = black ? 'key black' : 'key white';
      key.dataset.midi = String(midi);
      key.dataset.oct = String(Math.floor(k / 12));
      key.setAttribute('aria-label', `${Tones.NAMES[k % 12]}${Tones.octaveOf(midi)}`);
      if (black) key.style.setProperty('--i', String(whites));
      else whites++;
      key.appendChild(document.createElement('span')).className = 'key-label';
      ui.keys.appendChild(key);
      lab.keyEls.push(key);
    }
    ui.keysDown.disabled = settings.lab.keys <= 1;
    ui.keysUp.disabled = settings.lab.keys >= 5;
  }

  function renderKeys(a) {
    const sounding = new Set(a.midis);
    const ping = new Set(arpSounding().map((id) => voiceById(id)).filter(Boolean).map((v) => nearestMidi(v.freq)));
    lab.keyEls.forEach((key) => {
      const midi = Number(key.dataset.midi);
      const on = sounding.has(midi);
      key.classList.toggle('on', on);
      key.classList.toggle('ping', ping.has(midi));
      key.classList.toggle('loop', !!(prog.keys && prog.keys.has(midi)));   // the chord the loop is playing
      key.setAttribute('aria-pressed', String(on));
      setText(key.firstChild, on ? labNoteName(midi, a.names) : pitchClass(midi) === 0 ? `C${Tones.octaveOf(midi)}` : '');
    });
  }

  function shiftKeys(dir) {
    settings.lab.keys = clamp(settings.lab.keys + dir, 1, 5);
    saveSettings();
    buildKeys();
    renderLab();
  }

  // After a preset is loaded, moves the keyboard to its notes if they are off it.
  function followKeys() {
    const midis = lab.voices.map((v) => nearestMidi(v.freq));
    const first = 12 * (settings.lab.keys + 1);
    if (!midis.length || midis.every((m) => m >= first && m <= first + 12 * KEYS_OCTAVES)) return;
    settings.lab.keys = clamp(Math.floor(Math.min(...midis) / 12) - 1, 1, 5);
    buildKeys();
  }

  // ---- library

  function buildLibrary() {
    ui.roots.innerHTML = Tones.NAMES.map((name, pc) => `<button type="button" class="root" data-root="${pc}" aria-pressed="false">${noteMarkup(name)}</button>`).join('');
    const chip = (kind, id, label) => `<button type="button" class="chip-btn" data-kind="${kind}" data-id="${esc(id)}" aria-pressed="false">${esc(label)}</button>`;
    const groups = [];
    Tones.CHORDS.forEach((c) => {
      let group = groups.find((g) => g.name === c.group);
      if (!group) groups.push(group = { name: c.group, chips: [], fixed: true });
      group.chips.push(chip('chord', c.id, ''));
    });
    groups.push({ name: 'Intervals', chips: Tones.INTERVALS.filter((i) => i.semis > 0).map((i) => chip('interval', i.id, i.name)) });
    groups.push({ name: 'Experiments', chips: Tones.EXPERIMENTS.map((e) => chip('experiment', e.id, e.name)) });
    // Chord chips are relabelled with the root, so they sit on fixed columns and never reflow.
    ui.libGroups.innerHTML = groups.map((g) => `<div class="lib-group"><h3>${esc(g.name)}</h3>`
      + `<div class="chips${g.fixed ? ' fixed' : ''}">${g.chips.join('')}</div></div>`).join('');
    lab.chipEls = Array.from(ui.libGroups.querySelectorAll('.chip-btn'));
    labelLibrary();
  }

  // Chord chips read as symbols on the chosen root: C, Cm, C7 …
  function labelLibrary() {
    const { root, octave } = settings.lab;
    lab.chipEls.forEach((b) => {
      const rootMidi = 12 * (octave + 1) + root;
      if (b.dataset.kind === 'chord') {
        const c = Tones.chordAt(b.dataset.id, root);
        b.textContent = c.symbol;
        b.title = `${c.name}: ${c.notes.join(' ')}`;
      } else if (b.dataset.kind === 'interval') {
        const [low, high] = Tones.spellInterval(rootMidi, rootMidi + Tones.intervalById(b.dataset.id).semis);
        b.title = `${low} up to ${high}`;
      }
    });
    Array.from(ui.roots.children).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.root) === root)));
    ui.libOctave.textContent = String(octave);
    ui.libOctaveDown.disabled = octave <= 1;
    ui.libOctaveUp.disabled = octave >= 6;
  }

  function renderLibraryState() {
    const p = lab.preset;
    lab.chipEls.forEach((b) => {
      b.setAttribute('aria-pressed', String(!!p && !lab.edited && b.dataset.kind === p.kind && b.dataset.id === p.id));
    });
    ui.explain.hidden = !p;
    if (!p) return;
    setText(ui.explainTitle, p.title);
    setText(ui.explainText, p.text);
    ui.explainSong.hidden = !p.song;
    setText(ui.explainSong, p.song ? `Think of ${p.song}` : '');
  }

  function loadPreset(kind, id) {
    const { root, octave } = settings.lab;
    const rootMidi = 12 * (octave + 1) + root;
    const fromMidi = (m) => ({ freq: Pitch.midiToFreq(m, settings.a4) });
    let voices;
    let preset;
    if (kind === 'chord') {
      const c = Tones.chordAt(id, root);
      voices = Tones.chordNotes(id, rootMidi).map(fromMidi);
      preset = { title: `${c.name} · ${c.notes.join(' ')}`, text: c.text };
    } else if (kind === 'interval') {
      const iv = Tones.intervalById(id);
      const [low, high] = Tones.spellInterval(rootMidi, rootMidi + iv.semis);
      voices = [rootMidi, rootMidi + iv.semis].map(fromMidi);
      preset = { title: `${iv.name} · ${low} up to ${high}`, text: iv.text, song: iv.song };
    } else {
      const e = Tones.experimentById(id);
      voices = Tones.experimentVoices(id, settings.a4);
      preset = { title: e.name, text: e.text };
      setSound(e.wave);
    }
    lab.preset = Object.assign(preset, { kind, id });
    lab.edited = false;
    lab.voices = voices.map((v) => newVoice(v.freq, v.gain, v.on));
    followKeys();
    voicesChanged();
    startLab();
  }

  // A new root or octave replays the chord or interval, unless the tones have been changed since.
  function libraryChanged() {
    saveSettings();
    labelLibrary();
    const p = lab.preset;
    if (p && !lab.edited && (p.kind === 'chord' || p.kind === 'interval')) loadPreset(p.kind, p.id);
  }

  // The tones' sound: a plain wave or an instrument. Sounding tones are struck again in it.
  function setSound(id) {
    settings.lab.sound = id;
    ui.wave.value = id;
    if (audio.mixer) audio.mixer.setSound('tones', id);
    restrikeLab();
    saveSettings();
    renderLabPlaying();
  }

  function setVolume(volume) {
    settings.lab.volume = clamp(volume, 0, 1);
    if (audio.monitor) audio.monitor.gain.setTargetAtTime(monitorLevel(), audio.ctx.currentTime, 0.02);
    saveLabSoon();
  }

  // Sound selects list the plain waves and the instruments, grouped.
  function fillSounds(select, firstGroup) {
    const groups = Instruments.GROUPS.slice().sort((a, b) => (b === firstGroup) - (a === firstGroup));
    select.innerHTML = groups.map((g) => `<optgroup label="${esc(g)}">`
      + Instruments.PRESETS.filter((p) => p.group === g).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
      + '</optgroup>').join('');
  }

  // --------------------------------------------------------------- progression

  const PARTS = ['chords', 'bass', 'drums'];
  const loopKey = () => settings.loop.key;
  const blockRootPc = (b) => pitchClass(loopKey().tonic + b.degree);
  const blockSymbol = (b) => Tones.chordAt(b.chord, blockRootPc(b)).symbol;
  const blockNumeral = (b) => Song.numeral(b.degree, b.chord, loopKey().mode);
  const loopOptions = () => ({
    secondsPerBeat: 60 / settings.bpm,
    sounds: { chords: settings.loop.chords.sound, bass: settings.loop.bass.sound },
    a4: settings.a4,
  });

  function showLoopMessage(text) {
    ui.timelineHint.textContent = text;
    ui.timelineHint.classList.add('message');
    clearTimeout(prog.messageTimer);
    prog.messageTimer = setTimeout(() => {
      ui.timelineHint.textContent = LOOP_HINT;
      ui.timelineHint.classList.remove('message');
    }, LAB_MESSAGE_MS);
  }

  // Undo keeps the loop (and tempo) as it was before each change.
  function remember() {
    prog.history.push(JSON.stringify({ loop: settings.loop, bpm: settings.bpm, songId: settings.songId }));
    if (prog.history.length > 80) prog.history.shift();
    ui.loopUndo.disabled = false;
  }

  function undo() {
    const snapshot = prog.history.pop();
    if (!snapshot) return;
    const s = JSON.parse(snapshot);
    settings.loop = Song.normaliseLoop(s.loop, SOUND_IDS);
    settings.songId = s.songId;
    if (s.bpm !== settings.bpm) setLoopBpm(s.bpm);
    prog.selected = -1;
    applyPartLevels();
    renderProgressionControls();
    loopChanged();
    showLoopMessage('Undone');
  }

  // After any change to the loop: stored, replayed from where it is, redrawn.
  function loopChanged() {
    clearTimeout(prog.saveTimer);
    prog.saveTimer = setTimeout(saveSettings, LAB_SAVE_MS);
    if (prog.playing) rearrange();
    renderTimeline();
    renderLoopInfo();
  }

  function applyPartLevels() {
    if (!audio.mixer) return;
    const t = audio.ctx.currentTime;
    const l = settings.loop;
    PARTS.forEach((p) => audio.mixer.part(p).input.gain.setTargetAtTime(l[p].on ? partLevel(l[p].volume) : 0, t, 0.02));
    audio.mixer.part('preview').input.gain.setTargetAtTime(partLevel(l.chords.volume), t, 0.02);
    audio.mixer.setSound('chords', l.chords.sound);
    audio.mixer.setSound('preview', l.chords.sound);
    audio.mixer.setSound('bass', l.bass.sound);
  }

  // ---- blocks

  function insertBlock(block, index) {
    const blocks = settings.loop.blocks;
    if (blocks.length >= Song.MAX_BLOCKS) {
      showLoopMessage(`Up to ${Song.MAX_BLOCKS} chords in a loop.`);
      return;
    }
    remember();
    const at = clamp(index, 0, blocks.length);
    blocks.splice(at, 0, { degree: pitchClass(block.degree), chord: block.chord, beats: block.beats || Song.BEATS_PER_BAR });
    prog.selected = at;
    loopChanged();
    previewBlock(at);
  }

  function moveBlock(from, to) {
    const blocks = settings.loop.blocks;
    const at = to > from ? to - 1 : to;
    if (at === from) return;
    remember();
    blocks.splice(at, 0, blocks.splice(from, 1)[0]);
    prog.selected = at;
    loopChanged();
  }

  function removeBlock(index) {
    remember();
    settings.loop.blocks.splice(index, 1);
    prog.selected = Math.min(prog.selected, settings.loop.blocks.length - 1);
    loopChanged();
  }

  function resizeBlock(index, delta) {
    const b = settings.loop.blocks[index];
    const beats = clamp(b.beats + delta, Song.MIN_BEATS, Song.MAX_BEATS);
    if (beats === b.beats) return;
    remember();
    b.beats = beats;
    loopChanged();
  }

  // A block's chord goes up top: named, explained and on the keyboard, and heard once in the loop's sound.
  function previewBlock(index) {
    const a = Song.arrange(settings.loop);
    const block = a.blocks[index];
    if (!block) return;
    prog.selected = index;
    renderTimelineSelection();
    const c = Tones.chordAt(block.chord, block.rootPc);
    lab.preset = { kind: 'progression', id: block.chord, title: `${c.name} · ${c.notes.join(' ')}`, text: c.text };
    lab.edited = false;
    lab.voices = block.voicing.map((m) => newVoice(Pitch.midiToFreq(m, settings.a4)));
    followKeys();
    voicesChanged();
    if (prog.playing || lab.playing) return;   // the loop, or the tones themselves, are already sounding
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const bus = labMixer().part('preview').input;
    const t = ctx.currentTime + 0.02;
    block.voicing.forEach((m, i) => Instruments.playNote(ctx, bus, settings.loop.chords.sound, Pitch.midiToFreq(m, settings.a4),
      t + i * 0.012, 1.5, 0.8 * Instruments.PART_LEVEL.chords));
  }

  // The chord the tones make goes into the loop, after the selected block.
  function addSoundingChord() {
    const c = labAnalysis().chord;
    if (!c) {
      showLoopMessage('Make a chord of three or more notes first: on the keyboard, or with the chord library below.');
      return;
    }
    const at = prog.selected >= 0 ? prog.selected + 1 : settings.loop.blocks.length;
    insertBlock({ degree: c.rootPc - loopKey().tonic, chord: c.id }, at);
  }

  // ---- playing the loop

  // Every note goes through a bus of its own for this run, so stopping silences what is already scheduled.
  function startLoop() {
    const a = Song.arrange(settings.loop);
    if (!a.beats) {
      showLoopMessage('Add some chords to the loop first.');
      return;
    }
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const mixer = labMixer();
    applyPartLevels();
    const buses = {};
    PARTS.forEach((p) => {
      buses[p] = ctx.createGain();
      buses[p].connect(mixer.part(p).input);
    });
    const start = ctx.currentTime + CLICK_START_DELAY_S;
    Object.assign(prog, { playing: true, arrangement: a, buses, anchor: start, until: start, cycle: 0, next: 0, block: -1 });
    pumpLoop();
    prog.timer = setInterval(pumpLoop, CLICK_TIMER_MS);
    renderLoopPlaying();
  }

  function stopLoop() {
    if (!prog.playing) return;
    clearInterval(prog.timer);
    const t = audio.ctx.currentTime;
    Object.values(prog.buses).forEach((bus) => {
      fadeOut(bus.gain, t);
      setTimeout(() => bus.disconnect(), LAB_FADE_S * 3000 + 100);
    });
    Object.assign(prog, { playing: false, buses: null, block: -1, keys: null });
    renderLoopPlaying();
    renderPlayhead();
    renderKeys(labAnalysis());
  }

  // Schedules the notes due in the next moment on the audio clock, round and round (like the metronome).
  function pumpLoop() {
    const ctx = audio.ctx;
    const a = prog.arrangement;
    const spb = 60 / settings.bpm;
    const until = ctx.currentTime + (document.hidden ? CLICK_LOOKAHEAD_HIDDEN_S : CLICK_LOOKAHEAD_S);
    const options = loopOptions();
    for (;;) {
      if (prog.next >= a.events.length) {
        prog.next = 0;
        prog.cycle++;
      }
      const e = a.events[prog.next];
      const time = prog.anchor + (prog.cycle * a.beats + e.t) * spb;
      if (time >= until) break;
      if (time > ctx.currentTime - 0.02) Instruments.playEvent(ctx, prog.buses, e, time, options);
      prog.next++;
    }
    prog.until = until;
  }

  // The loop changed while playing: carry on from the same beat in the new arrangement.
  function rearrange() {
    const a = Song.arrange(settings.loop);
    if (!a.beats) {
      stopLoop();
      return;
    }
    const beat = ((prog.until - prog.anchor) * settings.bpm) / 60;
    prog.arrangement = a;
    prog.cycle = Math.floor(beat / a.beats);
    const offset = beat - prog.cycle * a.beats;
    prog.next = a.events.findIndex((e) => e.t >= offset - 1e-9);
    if (prog.next < 0) {
      prog.next = 0;
      prog.cycle++;
    }
    prog.block = -1;
  }

  // A new tempo takes over from the notes not yet scheduled, with no jump in the beat.
  function setLoopBpm(value) {
    const old = settings.bpm;
    applyBpm(value);
    if (prog.playing) {
      const beat = ((prog.until - prog.anchor) * old) / 60;
      prog.anchor = prog.until - (beat * 60) / settings.bpm;
    }
    showLoopBpm();
    renderLoopInfo();
    renderTempo();
  }

  function showLoopBpm() {
    if (document.activeElement !== ui.loopBpm) ui.loopBpm.value = fmtNumber(settings.bpm, 1);
  }

  // Lights the block being heard, fills its progress bar, and shows its chord on the keyboard.
  function renderPlayhead() {
    let index = -1;
    let fraction = 0;
    if (prog.playing) {
      const a = prog.arrangement;
      const beat = ((heardTime() - prog.anchor) * settings.bpm) / 60;
      if (beat >= 0) {
        const pos = beat % a.beats;
        index = a.blocks.findIndex((b) => pos >= b.start && pos < b.start + b.beats);
        if (index >= 0) fraction = (pos - a.blocks[index].start) / a.blocks[index].beats;
      }
    }
    if (index !== prog.block) {
      prog.block = index;
      prog.blockEls.forEach((el, i) => {
        el.classList.toggle('now', i === index);
        if (i !== index) el.lastChild.style.transform = 'scaleX(0)';
      });
      prog.keys = index >= 0 ? new Set(prog.arrangement.blocks[index].voicing) : null;
      renderKeys(labAnalysis());
    }
    if (index >= 0 && prog.blockEls[index]) prog.blockEls[index].lastChild.style.transform = `scaleX(${fraction.toFixed(4)})`;
  }

  function renderLoopPlaying() {
    ui.app.classList.toggle('loop-playing', prog.playing);
    ui.loopPlay.setAttribute('aria-pressed', String(prog.playing));
    ui.loopPlayLabel.textContent = prog.playing ? 'Stop loop' : 'Play loop';
    renderLabPlaying();
  }

  // ---- drawing the progression

  function renderProgressionControls() {
    const l = settings.loop;
    ui.keyTonic.innerHTML = Tones.NAMES.map((_, pc) => `<option value="${pc}">${esc(Song.tonicName(pc, l.key.mode))}</option>`).join('');
    ui.keyTonic.value = String(l.key.tonic);
    ui.keyMode.value = l.key.mode;
    ui.keySevenths.checked = l.sevenths;
    ui.chordsSound.value = l.chords.sound;
    ui.chordsStyle.value = l.style;
    ui.chordsVoicing.value = l.voicing;
    ui.bassSound.value = l.bass.sound;
    ui.bassPattern.value = l.bass.pattern;
    ui.drumsPattern.value = l.drums.pattern;
    PARTS.forEach((p) => {
      ui.partToggles[p].setAttribute('aria-pressed', String(l[p].on));
      ui.partVolumes[p].value = String(Math.round(l[p].volume * 100));
    });
    ui.exportRepeats.value = String(l.repeats);
    renderPalette();
    renderSongList();
    showLoopBpm();
  }

  function renderPalette() {
    const l = settings.loop;
    ui.palette.innerHTML = Song.diatonic(l.key.mode, l.sevenths).map((c) => {
      const symbol = Tones.chordAt(c.chord, pitchClass(l.key.tonic + c.degree)).symbol;
      return `<button type="button" class="pal" data-degree="${c.degree}" data-chord="${esc(c.chord)}" title="Click to add ${esc(symbol)} to the loop, or drag it into place">`
        + `<span class="pal-num">${esc(c.numeral)}</span><span class="pal-sym">${esc(symbol)}</span></button>`;
    }).join('');
  }

  function renderTimeline() {
    const blocks = settings.loop.blocks;
    ui.timeline.innerHTML = blocks.length
      ? blocks.map((b, i) => {
        const symbol = blockSymbol(b);
        return `<li class="block" data-index="${i}" style="--beats:${b.beats}" tabindex="0" aria-label="${esc(symbol)}, ${b.beats} beats">`
          + `<span class="b-top"><span class="b-num">${esc(blockNumeral(b))}</span>`
          + `<button type="button" class="b-remove" data-action="remove" aria-label="Remove ${esc(symbol)}" title="Remove">`
          + '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></span>'
          + `<span class="b-sym">${esc(symbol)}</span>`
          + '<span class="b-len"><button type="button" data-action="shorter" aria-label="One beat shorter" title="One beat shorter">−</button>'
          + `<span class="b-beats">${b.beats}</span>`
          + '<button type="button" data-action="longer" aria-label="One beat longer" title="One beat longer">+</button></span>'
          + '<span class="b-progress"></span></li>';
      }).join('')
      : '<li class="timeline-empty">Drop chords here</li>';
    prog.blockEls = Array.from(ui.timeline.querySelectorAll('.block'));
    prog.block = -1;
    renderTimelineSelection();
  }

  function renderTimelineSelection() {
    prog.blockEls.forEach((el, i) => el.classList.toggle('selected', i === prog.selected));
  }

  function renderLoopInfo() {
    const beats = settings.loop.blocks.reduce((s, b) => s + b.beats, 0);
    const bars = beats / Song.BEATS_PER_BAR;
    const length = Number.isInteger(bars) ? `${bars} bar${bars === 1 ? '' : 's'}` : `${beats} beats`;
    setText(ui.loopLength, beats ? `${length} · ${fmtNumber((beats * 60) / settings.bpm, 1)} s` : 'Empty');
    ui.loopUndo.disabled = !prog.history.length;
    ui.loopClear.disabled = !settings.loop.blocks.length;
    ui.loopPlay.disabled = !prog.playing && !beats;
    [ui.exportWav, ui.exportStems, ui.exportMidi].forEach((b) => { b.disabled = !beats || prog.exporting; });
  }

  // ---- dragging chords into the loop

  // Pointer-based rather than HTML drag and drop, so blocks can also be moved on a touch screen.
  function beginDrag(e, item, el, label) {
    if (e.button !== 0) return;
    prog.drag = { item, el, label, x: e.clientX, y: e.clientY, id: e.pointerId, active: false, ghost: null };
  }

  function overTimeline(x, y) {
    const r = ui.timeline.getBoundingClientRect();
    return x >= r.left - 24 && x <= r.right + 24 && y >= r.top - 24 && y <= r.bottom + 24;
  }

  // Where a chord dropped at a point would go: before or after the nearest block.
  function dropIndex(x, y) {
    let best = null;
    let bestDistance = Infinity;
    prog.blockEls.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(x - clamp(x, r.left, r.right), y - clamp(y, r.top, r.bottom));
      if (d < bestDistance) {
        bestDistance = d;
        best = { i, r };
      }
    });
    if (!best) return 0;
    return x < best.r.left + best.r.width / 2 ? best.i : best.i + 1;
  }

  // The drop point shows as a bar beside a block; nothing moves until the drop.
  function markDrop(index) {
    prog.blockEls.forEach((el, i) => {
      el.classList.toggle('drop-before', i === index);
      el.classList.toggle('drop-after', index === prog.blockEls.length && i === index - 1);
    });
    ui.timeline.classList.toggle('drop-into', index >= 0 && !prog.blockEls.length);
  }

  function moveDrag(e) {
    const d = prog.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
      d.active = true;
      d.ghost = document.createElement('div');
      d.ghost.className = 'drag-ghost';
      d.ghost.textContent = d.label;
      document.body.appendChild(d.ghost);
      d.el.classList.add('lifted');
      try { d.el.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
    }
    e.preventDefault();
    d.ghost.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
    markDrop(overTimeline(e.clientX, e.clientY) ? dropIndex(e.clientX, e.clientY) : -1);
  }

  function endDrag(e, drop) {
    const d = prog.drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    prog.drag = null;
    if (!d.active) return;
    d.ghost.remove();
    d.el.classList.remove('lifted');
    markDrop(-1);
    // The click that follows a drag is not a click.
    prog.justDragged = true;
    setTimeout(() => { prog.justDragged = false; }, 0);
    if (!drop || !overTimeline(e.clientX, e.clientY)) return;
    const index = dropIndex(e.clientX, e.clientY);
    if (d.item.move !== undefined) moveBlock(d.item.move, index);
    else insertBlock(d.item, index);
  }

  // ---- saved progressions

  function renderSongList() {
    ui.songList.innerHTML = '<option value="">New progression</option>'
      + settings.songs.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    ui.songList.value = settings.songId;
  }

  function openSong(id) {
    remember();
    const song = settings.songs.find((s) => s.id === id);
    if (song) {
      settings.loop = Song.normaliseLoop(JSON.parse(JSON.stringify(song.loop)), SOUND_IDS);
      settings.songId = id;
      if (song.bpm !== settings.bpm) setLoopBpm(song.bpm);
    } else {
      settings.loop.blocks = [];   // a fresh start in the same key and sounds
      settings.songId = '';
    }
    prog.selected = -1;
    applyPartLevels();
    renderProgressionControls();
    loopChanged();
  }

  function openSongDialog() {
    const current = settings.songs.find((s) => s.id === settings.songId);
    ui.songDialogTitle.textContent = current ? 'Save progression' : 'Save new progression';
    ui.songName.value = current ? current.name : '';
    ui.songName.placeholder = `Song idea ${settings.songs.length + 1}`;
    ui.songDelete.hidden = !current;
    ui.songSaveNew.hidden = !current;
    if (ui.songDialog.showModal) ui.songDialog.showModal();
    else ui.songDialog.setAttribute('open', '');
    ui.songName.focus();
  }

  function closeSongDialog() {
    if (ui.songDialog.close) ui.songDialog.close();
    else ui.songDialog.removeAttribute('open');
  }

  function saveSong(asNew) {
    const name = ui.songName.value.trim() || ui.songName.placeholder;
    const entry = { name, bpm: settings.bpm, loop: JSON.parse(JSON.stringify(settings.loop)) };
    const current = !asNew && settings.songs.find((s) => s.id === settings.songId);
    if (current) {
      Object.assign(current, entry);
    } else {
      const id = `song-${Date.now().toString(36)}`;
      settings.songs.push(Object.assign({ id }, entry));
      settings.songId = id;
    }
    saveSettings();
    renderSongList();
    closeSongDialog();
    showLoopMessage(`Saved “${name}” in this browser`);
  }

  function deleteSong() {
    const current = settings.songs.find((s) => s.id === settings.songId);
    settings.songs = settings.songs.filter((s) => s !== current);
    settings.songId = '';
    saveSettings();
    renderSongList();
    closeSongDialog();
    if (current) showLoopMessage(`Deleted “${current.name}”. The loop itself is still here.`);
  }

  // ---- export

  // The parts that are switched on and have something to play.
  function exportParts() {
    const l = settings.loop;
    return PARTS.filter((p) => l[p].on && (p === 'chords' || l[p].pattern !== 'off'));
  }

  function exportName() {
    const song = settings.songs.find((s) => s.id === settings.songId);
    const l = settings.loop;
    const name = `${song ? song.name : 'Chord loop'} · ${Song.keyName(l.key.tonic, l.key.mode)} · ${fmtNumber(settings.bpm, 1)} bpm`;
    return name.replace(/[\\/:*?"<>|]/g, '-');
  }

  function download(data, type, name) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function renderOptions(parts) {
    const l = settings.loop;
    return {
      bpm: settings.bpm,
      repeats: l.repeats,
      sounds: { chords: l.chords.sound, bass: l.bass.sound },
      volumes: { chords: partLevel(l.chords.volume), bass: partLevel(l.bass.volume), drums: partLevel(l.drums.volume) },
      parts,
      a4: settings.a4,
      sampleRate: EXPORT_RATE,
    };
  }

  async function exportLoop(kind) {
    const a = Song.arrange(settings.loop);
    const parts = exportParts();
    if (!a.beats || !parts.length) {
      setText(ui.exportStatus, !a.beats ? 'Add some chords first' : 'Every part is switched off');
      return;
    }
    const base = exportName();
    const l = settings.loop;
    prog.exporting = true;
    renderLoopInfo();
    try {
      if (kind === 'midi') {
        const program = (id) => Instruments.byId(id).program;
        const bytes = Song.toMidi(a, {
          bpm: settings.bpm,
          repeats: l.repeats,
          name: base,
          parts: {
            chords: parts.includes('chords') ? program(l.chords.sound) : null,
            bass: parts.includes('bass') ? program(l.bass.sound) : null,
            drums: parts.includes('drums') ? true : null,
          },
        });
        download(bytes, 'audio/midi', `${base}.mid`);
        setText(ui.exportStatus, `Saved ${base}.mid`);
      } else if (kind === 'wav') {
        setText(ui.exportStatus, 'Rendering the mix…');
        const channels = await Instruments.render(a, renderOptions(parts));
        download(Recorder.encodeWav(channels, EXPORT_RATE, 24), 'audio/wav', `${base}.wav`);
        setText(ui.exportStatus, `Saved ${base}.wav`);
      } else {
        const files = [];
        for (const p of parts) {
          setText(ui.exportStatus, `Rendering ${p} (${files.length + 1} of ${parts.length})…`);
          const channels = await Instruments.render(a, renderOptions([p]));
          files.push({ name: `${base} · ${p[0].toUpperCase()}${p.slice(1)}.wav`, data: new Uint8Array(Recorder.encodeWav(channels, EXPORT_RATE, 24)) });
        }
        download(Song.zip(files), 'application/zip', `${base} · stems.zip`);
        setText(ui.exportStatus, `Saved ${base} · stems.zip`);
      }
    } catch (err) {
      setText(ui.exportStatus, `Export failed: ${err.message || err}`);
    } finally {
      prog.exporting = false;
      renderLoopInfo();
    }
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

  // One column per course; a course's other strings (a 12-string's octave
  // strings) sit smaller under the main one.
  function buildStrings() {
    const tuning = currentTuning();
    ui.strings.innerHTML = '';
    ui.strings.style.setProperty('--n', tuning.courses.length);
    const columns = tuning.courses.map(() => {
      const column = document.createElement('div');
      column.className = 'course';
      ui.strings.appendChild(column);
      return column;
    });
    stringEls = tuning.targets.map((t, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = t.main ? 'string' : 'string partner';
      button.innerHTML = `<span class="s-name">${noteMarkup(Tunings.noteName(t.midi, tuning.flats))}</span><span class="s-oct">${Tunings.noteOctave(t.midi)}</span>`;
      button.title = `${Pitch.midiToFreq(t.midi, settings.a4).toFixed(2)} Hz${t.main ? '' : ', the other string of this course'} — click to ${tone.on ? 'hear it and lock the tuner to it' : 'lock the tuner to this string'}`;
      button.addEventListener('click', () => {
        const release = lockedString === i;
        lockedString = release ? -1 : i;
        if (tone.on) {
          if (release) stopTone();
          else startTone(i);
        }
        updateLockMarks();
      });
      columns[t.course].appendChild(button);
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
    renderLab();   // Sound lab's tones keep their Hz; their note names and cents follow A4
  }

  function fillTunings() {
    ui.tuning.innerHTML = '';
    let group = null;
    const addGroup = (label) => {
      group = document.createElement('optgroup');
      group.label = label;
      ui.tuning.appendChild(group);
    };
    tunings.forEach((t) => {
      if (!group || group.label !== t.group) addGroup(t.group);
      group.appendChild(new Option(t.name, t.id));
    });
    if (group.label !== 'Custom') addGroup('Custom');
    group.appendChild(new Option('New custom tuning…', NEW_TUNING));
    ui.tuning.value = currentTuning().id;
    ui.tuningEdit.hidden = !currentTuning().custom;
  }

  function selectTuning(id) {
    settings.tuning = id;
    saveSettings();
    lockedString = -1;
    stopTone();
    ui.tuning.value = currentTuning().id;
    ui.tuningEdit.hidden = !currentTuning().custom;
    buildStrings();
    if (running && audio.stream) {
      resetReadings();
      buildGraph();   // the detection range follows the tuning
    }
  }

  // ------------------------------------------------------------ custom tunings

  let editing = null;   // the custom tuning in the editor, or null for a new one

  function openTuningEditor(tuning) {
    editing = tuning;
    ui.tuningDialogTitle.textContent = tuning ? 'Edit tuning' : 'New tuning';
    ui.tuningName.value = tuning ? tuning.name : '';
    ui.tuningName.placeholder = tuning ? tuning.name : `Custom ${settings.customTunings.length + 1}`;
    // A new tuning starts from the current one, usually the closest to what's wanted.
    ui.tuningStrings.value = tuning ? tuning.strings : currentTuning().strings;
    ui.tuningDelete.hidden = !tuning;
    previewTuning();
    if (ui.tuningDialog.showModal) ui.tuningDialog.showModal();
    else ui.tuningDialog.setAttribute('open', '');
    ui.tuningName.focus();
  }

  function closeTuningEditor() {
    if (ui.tuningDialog.close) ui.tuningDialog.close();
    else ui.tuningDialog.removeAttribute('open');
  }

  function previewTuning() {
    const parsed = Tunings.parseTuning(ui.tuningStrings.value);
    ui.tuningSave.disabled = !!parsed.error;
    ui.tuningPreview.innerHTML = parsed.error
      ? `<p class="dlg-error">${esc(parsed.error)}</p>`
      : parsed.courses.map((c) => `<span class="chip">${esc(Tunings.courseLabel(c, parsed.flats))}</span>`).join('');
  }

  function saveTuning() {
    const strings = ui.tuningStrings.value.trim().replace(/[\s,]+/g, ' ');
    if (Tunings.parseTuning(strings).error) return;
    const name = ui.tuningName.value.trim() || ui.tuningName.placeholder;
    let id;
    if (editing) {
      id = editing.id;
      Object.assign(settings.customTunings.find((t) => t.id === id), { name, strings });
    } else {
      id = `custom-${Date.now().toString(36)}`;
      settings.customTunings.push({ id, name, strings });
    }
    tunings = collectTunings();
    fillTunings();
    selectTuning(id);
    closeTuningEditor();
  }

  function deleteTuning() {
    if (!editing) return;
    const id = editing.id;
    settings.customTunings = settings.customTunings.filter((t) => t.id !== id);
    tunings = collectTunings();
    fillTunings();
    selectTuning(settings.tuning === id ? PRESET_TUNINGS[0].id : settings.tuning);
    closeTuningEditor();
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
    buildMeterScale();
    buildMeterRows(1);
    renderRecordState();
    applyView(null);
    renderTempo();
    renderClickState();
    fillSounds(ui.wave, 'Waves');
    ui.wave.value = settings.lab.sound;
    fillSounds(ui.chordsSound, 'Keys');
    fillSounds(ui.bassSound, 'Bass');
    const options = (list) => list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    ui.chordsStyle.innerHTML = options(Song.STYLES);
    ui.chordsVoicing.innerHTML = options(Song.VOICINGS);
    ui.bassPattern.innerHTML = options(Song.BASS_PATTERNS);
    ui.drumsPattern.innerHTML = options(Song.DRUM_PATTERNS);
    ui.progStart.innerHTML = '<option value="">Choose a progression…</option>' + options(Song.PROGRESSIONS);
    ui.exportRepeats.innerHTML = Song.REPEATS.map((n) => `<option value="${n}">${n === 1 ? 'Once round' : `${n} times round`}</option>`).join('');
    ui.timelineHint.textContent = LOOP_HINT;
    renderProgressionControls();
    renderTimeline();
    renderLoopInfo();
    ui.volume.value = String(Math.round(settings.lab.volume * 100));
    ui.labHint.textContent = LAB_HINT;
    buildKeys();
    buildLibrary();
    buildVoiceRows();
    renderLab();
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
      if (ui.tuning.value === NEW_TUNING) {
        ui.tuning.value = currentTuning().id;   // stays selected until the new one is saved
        openTuningEditor(null);
      } else {
        selectTuning(ui.tuning.value);
      }
    });
    ui.tuningEdit.addEventListener('click', () => openTuningEditor(currentTuning()));
    ui.tuningStrings.addEventListener('input', previewTuning);
    ui.tuningForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveTuning();
    });
    ui.tuningCancel.addEventListener('click', closeTuningEditor);
    ui.tuningDelete.addEventListener('click', deleteTuning);

    ui.record.addEventListener('click', toggleRecord);
    ui.noiseCheck.addEventListener('click', startNoiseCheck);
    ui.peakReset.addEventListener('click', () => rec.meter.reset());
    ui.meterRows.addEventListener('click', (e) => {
      if (e.target.closest('.clip')) rec.meter.reset();
    });
    ui.noiseResult.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="close"]')) ui.noiseResult.hidden = true;
    });
    ui.takeList.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-action]');
      const take = button && rec.takes.find((t) => t.id === Number(button.closest('.take').dataset.id));
      if (!take) return;
      const action = button.dataset.action;
      if (action === 'play') playTake(take, button);
      else if (action === 'download') downloadTake(take);
      else if (action === 'check') checkTake(take);
      else if (action === 'delete') deleteTake(take);
    });

    ui.a4Down.addEventListener('click', () => setA4(settings.a4 - 1));
    ui.a4Up.addEventListener('click', () => setA4(settings.a4 + 1));

    // Sound lab. Buttons clicked with the mouse give up focus, so the space bar keeps playing and stopping.
    const blurAfterClick = (e, el) => { if (e.detail) el.blur(); };
    ui.labPlay.addEventListener('click', () => {
      if (lab.playing) stopLab();
      else startLab();
      ui.labPlay.blur();
    });
    ui.labArp.addEventListener('click', () => {
      if (lab.arp) stopArpeggio();
      else playArpeggio();
      ui.labArp.blur();
    });
    ui.labClear.addEventListener('click', () => {
      clearLab();
      ui.labClear.blur();
    });
    ui.wave.addEventListener('change', () => setSound(ui.wave.value));
    ui.volume.addEventListener('input', () => setVolume(Number(ui.volume.value) / 100));
    ui.keysDown.addEventListener('click', () => shiftKeys(-1));
    ui.keysUp.addEventListener('click', () => shiftKeys(1));
    ui.keys.addEventListener('click', (e) => {
      const key = e.target.closest('.key');
      if (!key) return;
      toggleKey(Number(key.dataset.midi));
      blurAfterClick(e, key);
    });
    ui.voiceAdd.addEventListener('click', (e) => {
      addTone();
      blurAfterClick(e, ui.voiceAdd);
    });
    [[ui.semiDown, -1], [ui.semiUp, 1], [ui.octDown, -12], [ui.octUp, 12]].forEach(([button, semis]) => {
      button.addEventListener('click', (e) => {
        transpose(semis);
        blurAfterClick(e, button);
      });
    });
    ui.roots.addEventListener('click', (e) => {
      const button = e.target.closest('.root');
      if (!button) return;
      settings.lab.root = Number(button.dataset.root);
      libraryChanged();
      blurAfterClick(e, button);
    });
    [[ui.libOctaveDown, -1], [ui.libOctaveUp, 1]].forEach(([button, dir]) => {
      button.addEventListener('click', (e) => {
        settings.lab.octave = clamp(settings.lab.octave + dir, 1, 6);
        libraryChanged();
        blurAfterClick(e, button);
      });
    });
    ui.libGroups.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip-btn');
      if (!chip || prog.justDragged) return;
      loadPreset(chip.dataset.kind, chip.dataset.id);
      blurAfterClick(e, chip);
    });
    // Chord chips can also be dragged into the loop.
    ui.libGroups.addEventListener('pointerdown', (e) => {
      const chip = e.target.closest('.chip-btn[data-kind="chord"]');
      if (chip) beginDrag(e, { degree: settings.lab.root - loopKey().tonic, chord: chip.dataset.id }, chip, chip.textContent);
    });

    // Progression.
    ui.palette.addEventListener('pointerdown', (e) => {
      const chip = e.target.closest('.pal');
      if (chip) beginDrag(e, { degree: Number(chip.dataset.degree), chord: chip.dataset.chord }, chip, chip.lastChild.textContent);
    });
    ui.palette.addEventListener('click', (e) => {
      const chip = e.target.closest('.pal');
      if (!chip || prog.justDragged) return;
      insertBlock({ degree: Number(chip.dataset.degree), chord: chip.dataset.chord }, settings.loop.blocks.length);
      blurAfterClick(e, chip);
    });
    ui.timeline.addEventListener('pointerdown', (e) => {
      const block = e.target.closest('.block');
      if (block && !e.target.closest('button')) {
        const i = Number(block.dataset.index);
        beginDrag(e, { move: i }, block, blockSymbol(settings.loop.blocks[i]));
      }
    });
    ui.timeline.addEventListener('click', (e) => {
      const block = e.target.closest('.block');
      if (!block || prog.justDragged) return;
      const i = Number(block.dataset.index);
      const button = e.target.closest('button[data-action]');
      if (!button) previewBlock(i);
      else if (button.dataset.action === 'remove') removeBlock(i);
      else resizeBlock(i, button.dataset.action === 'longer' ? 1 : -1);
    });
    ui.timeline.addEventListener('keydown', (e) => {
      const block = e.target.closest('.block');
      if (!block || e.target !== block) return;
      const i = Number(block.dataset.index);
      const focus = (index) => { if (prog.blockEls[index]) prog.blockEls[index].focus(); };
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeBlock(i);
        focus(Math.min(i, settings.loop.blocks.length - 1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        previewBlock(i);
        focus(i);
      } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const to = e.key === 'ArrowLeft' ? i - 1 : i + 2;
        if (to >= 0 && to <= settings.loop.blocks.length) {
          moveBlock(i, to);
          focus(prog.selected);
        }
      }
    });
    document.addEventListener('pointermove', moveDrag);
    document.addEventListener('pointerup', (e) => endDrag(e, true));
    document.addEventListener('pointercancel', (e) => endDrag(e, false));

    ui.keyTonic.addEventListener('change', () => {
      remember();
      settings.loop.key.tonic = Number(ui.keyTonic.value);
      renderPalette();
      loopChanged();
    });
    ui.keyMode.addEventListener('change', () => {
      remember();
      settings.loop.key.mode = ui.keyMode.value;
      renderProgressionControls();
      loopChanged();
    });
    ui.keySevenths.addEventListener('change', () => {
      settings.loop.sevenths = ui.keySevenths.checked;
      renderPalette();
      saveSettings();
    });
    ui.progStart.addEventListener('change', () => {
      const p = Song.progressionById(ui.progStart.value);
      ui.progStart.value = '';
      if (!p) return;
      remember();
      settings.loop.blocks = Song.progressionBlocks(p.id);
      settings.loop.key.mode = p.mode;
      prog.selected = -1;
      renderProgressionControls();
      loopChanged();
      showLoopMessage(`${p.name} in ${Song.keyName(settings.loop.key.tonic, p.mode)}`);
    });

    ui.loopPlay.addEventListener('click', () => {
      if (prog.playing) stopLoop();
      else startLoop();
      ui.loopPlay.blur();
    });
    ui.loopBpmDown.addEventListener('click', () => setLoopBpm(settings.bpm - 1));
    ui.loopBpmUp.addEventListener('click', () => setLoopBpm(settings.bpm + 1));
    ui.loopBpm.addEventListener('focus', () => ui.loopBpm.select());
    ui.loopBpm.addEventListener('change', () => {
      const value = Tempo.parseBpm(ui.loopBpm.value);
      if (!Number.isNaN(value)) setLoopBpm(value);
      ui.loopBpm.value = fmtNumber(settings.bpm, 1);
    });
    ui.loopBpm.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ui.loopBpm.blur();
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setLoopBpm(settings.bpm + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
        ui.loopBpm.value = fmtNumber(settings.bpm, 1);
        ui.loopBpm.select();
      }
    });
    ui.blockAdd.addEventListener('click', (e) => {
      addSoundingChord();
      blurAfterClick(e, ui.blockAdd);
    });
    ui.loopUndo.addEventListener('click', undo);
    ui.loopClear.addEventListener('click', () => {
      remember();
      settings.loop.blocks = [];
      prog.selected = -1;
      loopChanged();
      showLoopMessage('Cleared. Undo brings the chords back.');
    });

    PARTS.forEach((p) => {
      ui.partToggles[p].addEventListener('click', (e) => {
        settings.loop[p].on = !settings.loop[p].on;
        ui.partToggles[p].setAttribute('aria-pressed', String(settings.loop[p].on));
        applyPartLevels();
        saveSettings();
        blurAfterClick(e, ui.partToggles[p]);
      });
      ui.partVolumes[p].addEventListener('input', () => {
        settings.loop[p].volume = Number(ui.partVolumes[p].value) / 100;
        applyPartLevels();
        clearTimeout(prog.saveTimer);
        prog.saveTimer = setTimeout(saveSettings, LAB_SAVE_MS);
      });
    });
    // Choices that change what the loop plays can be undone.
    [
      [ui.chordsSound, (v) => { settings.loop.chords.sound = v; }],
      [ui.chordsStyle, (v) => { settings.loop.style = v; }],
      [ui.chordsVoicing, (v) => { settings.loop.voicing = v; }],
      [ui.bassSound, (v) => { settings.loop.bass.sound = v; }],
      [ui.bassPattern, (v) => { settings.loop.bass.pattern = v; }],
      [ui.drumsPattern, (v) => { settings.loop.drums.pattern = v; }],
    ].forEach(([select, apply]) => select.addEventListener('change', () => {
      remember();
      apply(select.value);
      applyPartLevels();
      loopChanged();
    }));
    ui.exportRepeats.addEventListener('change', () => {
      settings.loop.repeats = Number(ui.exportRepeats.value);
      saveSettings();
    });
    ui.exportWav.addEventListener('click', () => exportLoop('wav'));
    ui.exportStems.addEventListener('click', () => exportLoop('stems'));
    ui.exportMidi.addEventListener('click', () => exportLoop('midi'));

    ui.songList.addEventListener('change', () => openSong(ui.songList.value));
    ui.songSave.addEventListener('click', openSongDialog);
    ui.songForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveSong(false);
    });
    ui.songSaveNew.addEventListener('click', () => saveSong(true));
    ui.songCancel.addEventListener('click', closeSongDialog);
    ui.songDelete.addEventListener('click', deleteSong);

    const rowVoice = (el) => {
      const row = el.closest('.voice');
      return row ? voiceById(Number(row.dataset.id)) : null;
    };
    const isHz = (el) => el.classList.contains('hz-value');
    ui.voiceList.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-action]');
      const v = button && rowVoice(button);
      if (!v) return;
      const action = button.dataset.action;
      if (action === 'toggle') {
        v.on = !v.on;
        if (v.on && lab.playing) dropVoiceNode(v.id, audio.ctx.currentTime);   // struck afresh, so a piano is heard again
        voiceEdited();
      } else if (action === 'down' || action === 'up') {
        stepVoice(v, action === 'up' ? 1 : -1);
      } else if (action === 'remove') {
        const index = lab.voices.indexOf(v);
        removeVoice(v);
        // From the keyboard, focus moves on to the next row's remove button (the rows were rebuilt).
        if (!e.detail) (ui.voiceList.querySelectorAll('.voice-remove')[Math.min(index, lab.voices.length - 1)] || ui.voiceAdd).focus();
        return;
      }
      blurAfterClick(e, button);
    });
    ui.voiceList.addEventListener('input', (e) => {
      const v = rowVoice(e.target);
      if (!v) return;
      if (e.target.classList.contains('v-freq')) {
        setVoiceFreq(v, Tones.tidyFreq(Tones.sliderToFreq(Number(e.target.value))));
      } else if (e.target.classList.contains('v-level')) {
        v.gain = Number(e.target.value) / 100;
        voiceEdited();
      }
    });
    ui.voiceList.addEventListener('change', (e) => {
      const v = isHz(e.target) && rowVoice(e.target);
      if (v) commitHz(v, e.target);
    });
    ui.voiceList.addEventListener('keydown', (e) => {
      const v = isHz(e.target) && rowVoice(e.target);
      if (!v) return;
      if (e.key === 'Enter') {
        e.target.blur();
      } else if (e.key === 'Escape') {
        e.target.value = fmtHz(v.freq);
        e.target.blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        nudgeHz(v, e.target, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (lockedString >= 0 || tone.string >= 0)) {
        lockedString = -1;
        stopTone();
        updateLockMarks();
      }
      if (settings.mode === 'lab') {
        const target = e.target instanceof Element ? e.target : document.body;
        if (target.closest('select, textarea, dialog, input:not([type="range"])')) return;   // typing
        if (e.key === 'Escape') {
          stopLab();
          stopArpeggio();
          stopLoop();
        } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          undo();
        } else if (e.key === ' ' && !e.repeat && !target.closest('button, .block')) {
          e.preventDefault();
          if (lab.playing) stopLab();
          else startLab();
        }
        return;
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
