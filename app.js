/*
 * app.js — wires the audio input to the pitch detector and drives the UI.
 *
 * Signal path: audio interface → getUserMedia (all browser processing off)
 * → optional channel pick → high-pass 35 Hz → low-pass 2.2 kHz → AnalyserNode
 * → Pitch.detect() every ~20 ms → short median → display.
 *
 * Tempo mode needs no audio: taps (pointer or keyboard) go to Tempo.createTapTempo().
 */
(function () {
  'use strict';

  const TUNINGS = [
    { id: 'standard', name: 'Standard', notes: [40, 45, 50, 55, 59, 64] },
    { id: 'drop-d', name: 'Drop D', notes: [38, 45, 50, 55, 59, 64] },
    { id: 'eb', name: 'E♭ Standard', notes: [39, 44, 49, 54, 58, 63] },
    { id: 'd', name: 'D Standard', notes: [38, 43, 48, 53, 57, 62] },
    { id: 'drop-c', name: 'Drop C', notes: [36, 43, 48, 53, 57, 62] },
    { id: 'dadgad', name: 'DADGAD', notes: [38, 45, 50, 55, 57, 62] },
    { id: 'open-g', name: 'Open G', notes: [38, 43, 50, 55, 59, 62] },
  ];

  const IN_TUNE_CENTS = 3;        // |cents| at or below this counts as in tune
  const HOLD_MS = 900;            // keep the last reading on screen this long after the note dies
  const HISTORY_MS = 260;         // readings inside this window are median-filtered
  const ANALYSIS_INTERVAL_MS = 20;
  const RING_TIMEOUT_MS = 20000;  // stop pulsing the tempo ring this long after the last tap
  const STORAGE_KEY = 'tuner.settings';

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
    stop: $('stop'),
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
    segs: Array.from(document.querySelectorAll('.seg')),
    tempoReset: $('tempo-reset'),
    bpm: $('bpm'),
    tempoDetail: $('tempo-detail'),
    tap: $('tap'),
    tapRing: $('tap-ring'),
  };

  const settings = loadSettings();
  const audio = { ctx: null, stream: null, nodes: [], analyser: null, buffer: null, detector: null, channels: 1 };
  const tapTempo = Tempo.createTapTempo();

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
    const defaults = { deviceId: '', channel: 'mix', tuning: 'standard', a4: 440, mode: 'tuner' };
    try {
      return Object.assign(defaults, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch {
      return defaults;
    }
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
      if (!audio.ctx) {
        audio.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      }
      if (audio.ctx.state === 'suspended') await audio.ctx.resume();
      await openStream(settings.deviceId);
      await refreshDevices();
      running = true;
      ui.app.classList.add('running');
      lastFrame = performance.now();
      syncOverlay();
    } catch (err) {
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
    ui.level.style.width = '0%';
    syncOverlay();
  }

  // The start overlay only belongs to the tuner, and only while it is not listening.
  function syncOverlay() {
    ui.overlay.hidden = running || settings.mode !== 'tuner';
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
    } else {
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
      : `idle|${lockedString}`;
    if (key === lastRenderKey) return;
    lastRenderKey = key;

    ui.app.classList.toggle('idle', !view);
    ui.app.classList.toggle('in-tune', !!(view && view.inTune));

    if (!view) {
      ui.noteName.textContent = '—';
      ui.noteOctave.textContent = '';
      ui.freq.textContent = 'Play a string';
      ui.hint.textContent = lockedString >= 0 ? `Locked to ${noteLabel(currentTuning().notes[lockedString])}` : '';
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
    renderTempo(state);
  }

  function resetTempo() {
    renderTempo(tapTempo.reset());
  }

  function renderTempo(state) {
    ui.app.classList.toggle('tempo-idle', !state.bpm);
    ui.app.classList.toggle('tempo-steady', state.steady);
    ui.bpm.textContent = state.bpm ? String(Math.round(state.bpm)) : '—';
    if (state.count === 0) ui.tempoDetail.textContent = 'Tap along to the beat';
    else if (state.count === 1) ui.tempoDetail.textContent = 'Keep tapping…';
    else ui.tempoDetail.textContent = `${state.count} taps · ${Math.round(state.interval)} ms per beat`;
  }

  // A ring ripples out of the tap button on every beat of the detected tempo.
  function renderRing(now) {
    const state = tapTempo.state;
    const since = now - state.lastTap;
    if (!state.bpm || since > RING_TIMEOUT_MS) {
      ui.tapRing.style.opacity = '0';
      return;
    }
    const phase = (since % state.interval) / state.interval;
    ui.tapRing.style.transform = `scale(${(1 + 0.5 * phase).toFixed(3)})`;
    ui.tapRing.style.opacity = (0.6 * Math.pow(1 - phase, 1.6)).toFixed(3);
  }

  function setMode(mode) {
    settings.mode = mode === 'tempo' ? 'tempo' : 'tuner';
    saveSettings();
    ui.app.classList.toggle('mode-tuner', settings.mode === 'tuner');
    ui.app.classList.toggle('mode-tempo', settings.mode === 'tempo');
    ui.segs.forEach((b) => {
      const active = b.dataset.mode === settings.mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    syncOverlay();
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
      button.title = `${Pitch.midiToFreq(midi, settings.a4).toFixed(2)} Hz — click to lock the tuner to this string`;
      button.addEventListener('click', () => {
        lockedString = lockedString === i ? -1 : i;
        updateLockMarks();
      });
      ui.strings.appendChild(button);
      return button;
    });
    updateLockMarks();
  }

  function updateLockMarks() {
    stringEls.forEach((el, i) => el.classList.toggle('locked', i === lockedString));
    lastRenderKey = '';
    if (!running) applyView(null);
  }

  function setA4(value) {
    settings.a4 = clamp(Math.round(value), 415, 466);
    ui.a4.textContent = String(settings.a4);
    saveSettings();
    buildStrings();
  }

  function init() {
    TUNINGS.forEach((t) => ui.tuning.appendChild(new Option(t.name, t.id)));
    ui.tuning.value = currentTuning().id;
    ui.channel.value = settings.channel;
    ui.a4.textContent = String(settings.a4);
    buildMeter();
    buildStrings();
    applyView(null);
    renderTempo(tapTempo.state);
    setMode(settings.mode);
    refreshDevices();

    ui.start.addEventListener('click', start);
    ui.stop.addEventListener('click', stop);

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
      buildStrings();
    });

    ui.a4Down.addEventListener('click', () => setA4(settings.a4 - 1));
    ui.a4Up.addEventListener('click', () => setA4(settings.a4 + 1));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lockedString >= 0) {
        lockedString = -1;
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
  }

  init();
  requestAnimationFrame(frame);
})();
