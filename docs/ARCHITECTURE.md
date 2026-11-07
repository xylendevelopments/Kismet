# Architecture

Kismet is one engine in nine small pieces. Each piece has a single
responsibility, a plain data contract, and tests that can be read on their own.

```
                   ┌──────────────────────────────────────────────┐
                   │                  engine.ts                   │
                   │  state machine, polling, stats, public API   │
                   └──┬───────┬────────┬────────┬────────┬────────┘
                      │       │        │        │        │
       siteDetection  │  chart.ts  timeline.ts  clock.ts  scheduler.ts
       playbackSource │       │        │        │        │
                      │       │        │        │        │
                   Pointer.ts  humanizer.ts  guards.ts  stats.ts
                      │
                  the page's window listeners
```

Everything is plain TypeScript with no runtime dependencies. The bundle is a
single IIFE; there is no framework, no reactivity, no virtual DOM.

---

## Constants and types

`src/constants.ts` holds the site's identity (hosts, globals), the playfield
geometry (512×384), the storage key, and every tunable default and clamp.
`src/types.ts` holds the shared interfaces: `Chart`, `ChartObject`,
`TimelineAction`, `Settings`, `TapKeys`, and read-only descriptions of the
site's own objects.

Both are dependency-free so any module can import them.

---

## Detection

### `detect/siteDetection.ts`

Answers one question: *is this webosu!?*

- **confirmed** — the hostname is a known deployment
  (`webosu-online.netlify.app`, `webosu.online` and subdomains).
- **probable** — a localhost dev server, or a page that exposes
  `window.game` + `window.playback`, or a page whose DOM mentions webosu!/osu!.
- **unknown** — none of the above; Kismet stays idle and keeps a slow poll.

It deliberately does not look at CSS class names or element ids: the site has
been restyled before, and a re-skin must never disable the tool.

### `detect/playbackSource.ts`

Finds the live play and returns `{ playback, game, gfx, via, tapKeys }`:

1. `window.playback` / `window.game` — the documented path, and the only one
   that matters for the deployed site.
2. `window.game.scene` as a fallback if the `playback` global has not been
   refreshed yet.
3. The tap keys are read from `game.K1keycode` / `K2keycode`, validated as
   plausible key codes, and classified as `source: "site"`; if they are missing
   or nonsense, Kismet falls back to Z/X and says so in the panel.

`playbackBlocker()` is the fair-play gate: if `game.autoplay` is on, the play is
reported as blocked with a human-readable reason, and the engine will not start.

---

## Chart

### `chart/chart.ts`

`buildChart(playback)` mirrors `hits[]` into Kismet's own `Chart`:

- one `ChartObject` per hit, in song order, with `index` fixed at creation;
- `circles`, `sliders`, `spinners` counts and `noteCount`;
- slider paths sampled from `curve.pointAt` **once**, then unrolled for every
  repeat (forward, backward, forward…) into a flat point list, so following a
  slider is a table lookup rather than a call into the site's renderer;
- judgement windows taken from `GreatTime/GoodTime/MehTime`, or derived from OD;
- a `signature` (a short hash of the object list and metadata) so the engine can
  tell "same chart" from "different chart" without comparing thousands of rows.

`sliderPointAt(object, elapsed)` interpolates the unrolled path, clamping at the
tail. `analyseChart(chart)` produces the summary the panel shows and the
humanizer uses: circles, sliders, spinners, longest stream, peak/average NPS,
minimum gap, longest slider, largest jump.

### `chart/timeline.ts`

`buildTimeline(chart, options)` turns chart objects into a flat, ordered list of
`{ type: "down" | "up", time, objectIndex, x, y }` actions:

- circles: `down` at `time`, `up` at `time + tapHold` (default ~12 ms);
- sliders: `down` at the head, `up` at `endTime`;
- spinners: `down` at the start, `up` at the end;
- a humanizer can shift each press and stretch each hold;
- **every release is clamped to stay strictly before the next press**, so a
  humanized hold can never swallow the following note;
- an offset is applied once, at build time.

`activeObjectAt(objects, chartTime)` answers "what is under the cursor right
now?" for the slider/spinner follower.

---

## Humanization

`src/humanize/humanizer.ts` is optional and **off by default**.

It produces a deterministic, seeded delta per object from a mixture of a smooth
random field (so timing drifts like a player, not like noise) and per-object
jitter, scaled by strength and clamped to a window derived from the judgement
windows. `patternAware` tightens the variation inside streams and around
chords, and `holdReleaseVariation` extends or shortens slider releases — always
within the gap to the next object.

`stats` reports mean, standard deviation, mean absolute deviation, clamped
count and isolation count, which is what the panel and `diagnostics()` show.

Because it is seeded and chart-derived, the same chart with the same seed plays
back identically — useful when comparing settings.

---

## Timing

### `timing/clock.ts`

`ClockMapper` fits `songTime = slope * hostTime + intercept` from samples of
`(performance.now(), playback.osu.audio.getPosition() * 1000 + offset)`.

- Samples are added at most every few milliseconds and the fit uses a robust
  average, so a stalled audio element does not poison it.
- `error` is the current residual: how far the fit is from the live audio
  position. Large residuals mean the audio seeked or stalled.
- `hardReset()` throws the fit away after a pause, a seek or an emergency stop.
- The mapper also converts in both directions: `toSong(hostMs)` and
  `toHost(songMs)`.

### `timing/scheduler.ts`

The scheduler owns the action cursor:

- `load(actions, songNow)` positions the cursor and keeps the list sorted;
- each frame it fires everything due, up to a catch-up cap;
- it arms a `FastTask` (a `MessageChannel` message — the fastest cross-task
  scheduling available in a page) for the next deadline, so a press does not
  have to wait for the next animation frame;
- inside the last `spinThreshold` milliseconds it spins with `performance.now()`
  until the deadline is reached, then dispatches — this is what turns
  frame-quantised timing (±8 ms) into sub-millisecond timing;
- jitter, fired, dropped and armed counts are exposed for diagnostics.

The scheduler never decides *what* to do — `Pointer` executes actions — so it is
testable with a fake clock and a recording sink.

---

## Input

`src/input/Pointer.ts` is the only module that touches the page's input path.

- `moveTo(x, y)` converts playfield pixels to client coordinates using **the
  site's live `gfx`** and dispatches `mousemove` on `window`.
- `press()` dispatches `keydown` with the configured key code; `release()`
  dispatches `keyup`. Both are non-repeating and carry the fields the site
  reads.
- `press()` refuses to double-press (`suppressed`), `release()` always sends a
  `keyup` if Kismet believes the key is down, and `releaseAll()` is idempotent.
- After each move it reads back `game.mouseX/mouseY` to measure `maxMoveError`,
  which catches a wrong `gfx` mapping immediately instead of as mystery misses.
- `setKeyCode()` follows a mid-play rebind of the site's tap key.

There is no `InputManager` and no per-note key mapping: osu!standard has two tap
keys, and the site owns both.

---

## Safety

`src/engine/guards.ts` installs `blur`, `visibilitychange`, `pagehide` and
`beforeunload` listeners plus a watchdog interval:

- blur / hide → release, interrupt the run;
- pagehide / unload → release, no state change;
- a hold longer than `STUCK_KEY_TIMEOUT` (20 s) → release + panic;
- three consecutive failed liveness probes (`window.app.view`, `game`,
  `playback`) → release + panic.

`verifyInputState()` compares the site's `K1down/K2down` against Kismet's belief
and reports a disagreement, which is how a swallowed `keyup` is caught early.

---

## The engine

`src/engine/engine.ts` is the state machine:

```
IDLE ──▶ DETECTING ──▶ READY ⇄ RUNNING ⇄ PAUSED ──▶ STOPPING ──▶ READY
                            └──────────▶ ERROR (blocked / failed)
```

- `init()` checks the site, installs guards and starts a 500 ms detection poll.
- `tryDetect()` re-reads the play, rebuilds the chart when the signature
  changes, and is cheap when nothing changed.
- `start()` builds the timeline, loads the scheduler and primes the clock; if
  the song has not started it arms a pending start instead.
- While running it drives a `requestAnimationFrame` loop that samples the clock,
  fires due actions, keeps the cursor on sliders and spinners, and updates
  stats.
- The site's own pause/exit is mirrored: paused → release and `PAUSED`; ended or
  scene gone → `READY` with the chart forgotten.
- `stop()` and `emergencyStop()` both release everything; the latter also clears
  the queue and the clock fit.

Events (`phase`, `site`, `detected`, `timeline`, `lost`, `stats`, `cursorState`,
`pendingStart`, `log`) are how `main.ts` drives the panel without the engine
knowing it exists.

`engine/stats.ts` reads the site's own score overlay (`judgecnt`, `combo`,
`judgeTotal`, `maxJudgeTotal`) and combines it with the timeline to report
objects played, remaining, taps, accuracy and elapsed time.

---

## UI

The panel is unchanged from earlier versions and is deliberately isolated:

- `ui/overlay.ts` — the panel, tabs, sliders, notice bar, debug log; it receives
  charts, analysis, tap keys, stats and holding state through setters.
- `ui/dom.ts` — a tiny `el()`/`listen()` helper, so the panel needs no
  framework.
- `ui/styles.ts` — the CSS, the inlined font faces and the accent variables.
- `ui/keyboard.ts` — the tap-key visualiser (two large keys, pressed state).
- `ui/motion.ts` — the spring/exit/press curves and reduced-motion fallbacks.
- `ui/debug.ts` — the structured `[DEBUG]` snapshot.

`hotkeys.ts` owns action hotkeys (defaults G/B/V/P plus Right Shift for the
panel). It listens in the capture phase so it still sees keys whose propagation
the site stops, filters `isTrusted`, `repeat`, modifiers and typing targets, and
reports collisions with the site's tap keys rather than silently double-binding
them.

---

## Entry point

`src/main.ts` wires it together: settings → engine → overlay → hotkeys, mirrors
engine events into the panel, exposes `window.Kismet`
(`start`, `pause`, `resume`, `stop`, `emergencyStop`, `diagnostics`, `stats`,
`settings`, `phase`, `chart`, `tapKeys`, `overlayElement`, `uiVisible`,
`uninstall`), and guards against double injection with `__kismetInstalled__`.

Nothing in `main.ts` is required by the tests: the engine and every module below
it can be driven headlessly under a fake DOM, which is how `test/engine.test.ts`
and `scripts/smoke.mjs` work.

---

## Build

`scripts/build.mjs` uses esbuild to produce:

| File | What it is |
| --- | --- |
| `dist/kismet.js` | the IIFE bundle, for the console or a bookmarklet |
| `dist/kismet.user.js` | the same code plus a userscript header and `@match` list |
| `dist/bookmarklet.txt` | the bundle as a `javascript:` URL |
| `dist/bookmarklet-loader.txt` | a tiny loader for a hosted `kismet.js` |

CSS, the fallback font (Comfortaa, OFL) and the artwork are inlined at build
time, so a distributed script is self-contained.
