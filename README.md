# DAW Helper

A small, clean toolbox for home recording that runs in your browser and talks
directly to your audio interface. No dependencies, no build step, no account.

Today it does two things well:

| Tuner | Tempo |
| --- | --- |
| ![Guitar tuner showing E2 in tune](docs/tuner.png) | ![Tap tempo showing 120 BPM](docs/tempo.png) |
| Chromatic guitar tuner with string indicators, accurate to well under a cent | Tap-tempo counter that follows you as you tap |

## Getting started

You need [Node.js](https://nodejs.org) 18 or newer and a Chromium-based browser
(Chrome, Edge) or Firefox.

```
git clone https://github.com/SaschaLurz/daw-helper.git
cd daw-helper
npm start
```

`npm start` serves the app on <http://localhost:4321> and opens it in your
browser. (Browsers only allow audio-input access from a secure context; a
local server on `localhost` counts as one, which is why there is one.)

## Tuner

1. Click **Start listening** and allow microphone access.
2. Pick your audio interface in the **Input** menu — the choice is remembered.
3. Play a string.

The big note tells you what it hears, the meter shows how far off you are in
cents, and everything turns green when you are within ±3 ¢. The string you are
playing lights up in the row at the bottom; if a string is far off (say it reads
D2 while you're aiming for E2) the hint says *Tune up ↑ to E2*.

- **Channel** appears when the interface opens in stereo. Choose input 1 or 2
  if only one of them has the guitar plugged in, so noise on the other input
  can't interfere.
- **Tuning** switches the string set: Standard, Drop D, E♭ Standard,
  D Standard, Drop C, DADGAD, Open G.
- **A4** sets the reference pitch (415–466 Hz).
- **Click a string** to lock the tuner to it, which helps when a string is a
  long way off or you're fitting new strings. Click again or press Escape to
  go back to automatic.
- The thin bar at the very bottom is the input level, so you can see the
  signal arriving and set the gain on your interface sensibly.

Under the hood the browser's own audio processing (echo cancellation, noise
suppression, automatic gain) is switched off, since it wrecks pitch tracking.
The signal passes a 35 Hz high-pass and a 2.2 kHz low-pass and is analysed
every 20 ms with the [McLeod Pitch Method](https://www.cs.otago.ac.nz/tartini/papers/A_Smarter_Way_to_Find_Pitch.pdf),
which copes well with the strong harmonics of a guitar without octave errors.
A short median filter keeps the reading from jittering.

## Tempo

Switch to **Tempo** in the top bar and tap along to the beat: click the button,
tap it on a touch screen, or press the space bar. The BPM updates on every tap
and turns green once your taps are steady. A ring keeps pulsing at the detected
tempo after you stop, so you can check it against the music.

Pause for a couple of seconds (or press **Reset**) to start a fresh
measurement. Stray taps well off the beat are ignored, and if you drift to a
different tempo without pausing the reading follows within a few taps.
Tempo mode does not need microphone access.

## Project layout

```
index.html   page structure
style.css    all styling (dark, single accent colour)
app.js       audio setup, device handling, smoothing, rendering, tempo UI
pitch.js     pitch detection (McLeod Pitch Method) and note maths
tempo.js     tap-tempo estimation
serve.js     dependency-free static server for local use
test/        unit tests for pitch.js and tempo.js
docs/        screenshots
```

`pitch.js` and `tempo.js` are plain scripts that also work under `require()`,
which is how the tests load them.

## Tests

```
npm test
```

The pitch tests run the detector against synthetic guitar tones (open strings,
detuned strings, dominant second harmonics, noise, DC offset) and check it stays
within half a cent. The tempo tests feed simulated tap sequences: steady beats,
human jitter, mis-taps, pauses, tempo changes and bounced double events.

## Ideas for what to build next

The aim is a toolbox for the small jobs around a home recording session — the
things you'd otherwise open a phone app or a calculator for. Some candidates,
roughly in the order they'd be useful:

**Tempo and timing**

- **Metronome** — an audible click at the tapped (or typed) tempo, with accents,
  subdivisions and a count-in. The tap tempo already knows the beat; it should
  be able to play it.
- **Delay and LFO calculator** — turn a BPM into milliseconds for 1/4, 1/8,
  1/16, dotted and triplet notes, plus Hz for LFO sync. Handy for setting
  delays, reverb pre-delay, compressor release and modulation rates.
- **Tempo from audio** — detect the tempo of a loop or a recording via onset
  detection, instead of tapping.

**Tuning and pitch**

- **More instruments** — bass (4/5/6-string), 7- and 8-string guitar, ukulele,
  mandolin, and a custom tuning editor.
- **Reference tone** — play any note through the interface for tuning by ear
  or checking that the monitors are wired correctly.
- **Intonation helper** — compare the open string with the 12th-fret reading
  per string and say which way to move the saddle.

**Levels and signal**

- **Gain-staging meter** — peak and RMS with hold and a clip indicator, plus a
  target range so it's obvious when the interface gain is set well.
- **Noise floor check** — measure the hum and hiss on an input and flag 50/60 Hz
  mains hum.
- **Round-trip latency test** — send a click out of the interface, capture it
  on the input, and report the latency in milliseconds and samples for setting
  the DAW's compensation.
- **Spectrum analyser** — a real-time view of what is coming in.

**Studio utilities**

- **Test signal generator** — sine, pink and white noise, sweeps — for
  checking headphones, monitors and the room.
- **Frequency cheat sheet** — instrument ranges, EQ trouble spots and a
  note ↔ Hz ↔ MIDI converter.
- **Quick recorder** — capture a short idea from the interface and download it
  as a WAV file before it's forgotten.
- **Session notes** — BPM, key, tuning and capo per song, saved locally.

**The app itself**

- Installable as a PWA that works offline.
- A light theme.

Ideas, bug reports and pull requests are welcome via
[issues](https://github.com/SaschaLurz/daw-helper/issues).
