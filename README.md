<div align="center">

<img src="assets/logo.svg" alt="Kismet logo" width="112" height="112" />

# Kismet

**Its own autoplay engine for [webosu!](https://webosu-online.netlify.app/) — osu!standard in the browser**

Kismet mirrors the live beatmap, models the site's audio clock, schedules every
click with its own timer, and delivers it as synthetic `KeyboardEvent`s and
`MouseEvent`s to the site's own listeners. It never turns on the site's built-in
Autoplay mod, never calls into the game's internals, and never edits the site.

[![Code license: MIT](https://img.shields.io/badge/code_license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0-ff6b9d)](#installation)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=fff)](#development)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen)](#development)

</div>

---

## What it is

[webosu!](https://webosu-online.netlify.app/) is a browser port of osu!standard:
circles, sliders, spinners, a 512×384 playfield, and a Pixi renderer. The site
ships an Autoplay *mod* that makes the game play itself. Kismet does not use it.

Kismet is a separate engine that:

1. **Detects the play.** Reads `window.playback` and `window.game` to learn the
   beatmap's hit objects, difficulty settings and judgement windows.
2. **Mirrors the chart.** Converts the site's `hits[]` — including slider
   curves, repeat counts, spinner spans and the site's slider sampling — into
   its own `Chart` with `512×384` coordinates.
3. **Models the clock.** Samples `(performance.now(), audio position)` pairs and
   fits a line, so it knows *song* time precisely even while the site's audio
   element drifts, resyncs or stalls.
4. **Schedules every press and release** against that clock, with a
   deadline-driven timer and a short frame-accurate "spin" window.
5. **Drives input through the DOM.** Cursor movement is a `mousemove` in the
   site's letterboxed client space; presses are `keydown`/`keyup` with the
   site's own `K1keycode`/`K2keycode`.
6. **Watches itself.** Guards release the button on blur, on tab hide, on a
   stuck hold, on site pause, and whenever the game stops responding.

The site judges the result exactly as if a human had clicked.

---

## Install

### Userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey.
2. Copy `dist/kismet.user.js` into a new userscript.
3. Open <https://webosu-online.netlify.app/>, start a beatmap, press
   **Right Shift**, and hit **Start** in the panel.

### Bookmarklet

`dist/bookmarklet.txt` is the whole engine in one `javascript:` URL.
`dist/bookmarklet-loader.txt` is a small loader for a hosted `dist/kismet.js`
(replace `RAW_URL_HERE` with the raw URL).

### Console

Paste the contents of `dist/kismet.js` into DevTools on the site, then:

```js
Kismet.start();          // begin on the current play
Kismet.diagnostics();    // everything the engine knows
Kismet.emergencyStop();  // release and stop immediately
```

---

## The panel

The GUI is unchanged from earlier versions: the same dark, rounded panel with
**Play**, **Timing**, **Input**, **More!** and **Cursor** tabs, the same spring
animation and the same draggable layout. What the tabs *contain* now reflects
osu!standard instead of osu!mania:

| Tab | What it controls |
| --- | --- |
| **Play** | start / pause / stop, live status, chart summary (circles · sliders · spinners · NPS), score readout |
| **Timing** | offset in ms, lookahead, dispatch compensation, auto-start |
| **Input** | which of the site's tap keys Kismet presses, tap hold length, **Re-read from site** |
| **More!** | humanization (off by default), appearance, hotkeys, debug log |
| **Cursor** | spin rate, spin threshold, cursor visualisation |

The panel starts hidden and inert, and only a **trusted Right Shift** press
opens it — a page script cannot spoof its way in.

---

## How the engine works

```
src/detect/siteDetection.ts   is this webosu!?
src/detect/playbackSource.ts  find window.playback / window.game, read the tap keys
src/chart/chart.ts            mirror hits[] -> Chart (objects, paths, windows, signature)
src/chart/timeline.ts         Chart -> ordered press/release actions
src/humanize/humanizer.ts     optional, seeded timing variation
src/timing/clock.ts           (host time, song time) line fit
src/timing/scheduler.ts       deadline-driven dispatch with a frame-accurate spin
src/input/Pointer.ts          mousemove into the playfield, keydown/keyup for clicks
src/engine/guards.ts          blur / hide / stuck / liveness safety
src/engine/engine.ts          the state machine that ties it together
```

### Detection

No fiber-tree walking, no PIXI internals, no network interception. The site
publishes everything Kismet needs as globals while a play is running:

```js
window.game      // mouseX, mouseY, down, K1keycode, K2keycode, K1down, K2down, autoplay, scene
window.playback  // hits[], track, osu.audio, scoreOverlay, GreatTime/GoodTime/MehTime, audioReady, ended
window.gfx       // width, height, xoffset, yoffset
```

Liveness is `window.app.view` plus those globals: if the play scene goes away,
Kismet forgets the chart and waits.

### Timing

The site judges against `osu.audio.getPosition() * 1000`. Kismet samples that
alongside `performance.now()`, fits a slope/intercept, and uses the fit to
convert "song time" into "when should this fire". The scheduler keeps a cursor
into the action list, arms a timer for the next deadline, and in the last frame
before it spins until the deadline is inside tolerance — so clicks land within
a millisecond of the target instead of on the next frame.

Judgement windows are read from the site (`GreatTime`, `GoodTime`, `MehTime`),
not assumed.

### Input

- **Cursor**: `mousemove` at the client coordinates the site's own inverse
  mapping expects, so `game.mouseX/mouseY` end up exactly on the object.
- **Clicks**: `keydown`/`keyup` with `keyCode = game.K1keycode` (or the
  secondary key if you pick it), dispatched on `window` in the same phase the
  site listens in.
- **Sliders**: the key is held for the whole body and the cursor follows the
  ball through every repeat.
- **Spinners**: the cursor orbits the centre at a configurable rate; the site's
  own rotation accumulation does the rest.

Events are synthetic (`isTrusted === false`), non-repeating, and only ever
dispatched while Kismet believes it owns the button — so a release is always
sent, even if a press was swallowed.

---

## Safety

- **It will not run next to the site's Autoplay.** If `game.autoplay` is on,
  Kismet reports the conflict and refuses.
- **It releases.** Window blur, `visibilitychange`, `pagehide`, `beforeunload`,
  site pause, gameplay exit, engine disposal, `Kismet.stop()` and
  `Kismet.emergencyStop()` all end with a `keyup` if the key is down.
- **It stops on a stall.** A hold longer than 20 s, or three failed liveness
  probes, forces a release and a panic.
- **It never blocks the site.** Listeners are capture-phase but passive with
  respect to the site's own handling: Kismet never calls `preventDefault()` on
  gameplay input and never `stopPropagation()`s a tap key.
- **It does not persist anything about you.** Settings live under
  `kismet:settings:v2` in `localStorage`; the site's storage is untouched.

More detail: [`docs/SAFETY.md`](docs/SAFETY.md).

---

## Try it without the site

```bash
npm install
npm run build
npm run demo        # http://localhost:5173
```

`demo/stub-game.js` is a miniature webosu! that implements the documented
contract — same globals, same listeners, same judgement — so the **real,
unmodified bundle** can play a chart in a sandbox. `npm test` runs the engine
against the same stub, so a change that breaks the demo breaks the tests first.

---

## Development

```bash
npm install          # esbuild + typescript only
npm run typecheck    # tsc --noEmit
npm test             # node:test, TypeScript sources, fake DOM
npm run build        # dist/kismet.js, dist/kismet.user.js, bookmarklets
npm run smoke        # loads dist/kismet.js against the stub site
npm run verify       # all of the above
```

There are no runtime dependencies: the bundle is a single IIFE with the UI, the
fonts and the artwork inlined.

Docs:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — every module and its contract
- [`docs/SITE-CONTRACT.md`](docs/SITE-CONTRACT.md) — what the site must keep doing
- [`docs/SAFETY.md`](docs/SAFETY.md) — the guarantees, and how they are tested
- [`docs/UPDATING.md`](docs/UPDATING.md) — what to change when the site changes

---

## Disclaimer

Kismet automates *your own browser*, in *your own session*, on a game that has
no leaderboards of consequence. It is a timing and pattern-practice tool. Using
an autoplay in a competitive context is cheating; don't do that, and don't
pretend this tool makes it acceptable. The authors are not responsible for how
you use it.

## License

MIT — see [`LICENSE`](LICENSE). The bundled fallback font (Comfortaa) is OFL-1.1;
its license ships inside both distributed scripts.
