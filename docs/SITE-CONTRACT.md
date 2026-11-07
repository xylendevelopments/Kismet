# The webosu! contract

Everything Kismet depends on is a small set of observable facts about
[webosu!](https://webosu-online.netlify.app/). They are written down here so
that when the site changes, the fix is a targeted edit rather than an
archaeological dig.

Verified against the public source
([`BSkyT/webosu-online`](https://github.com/BSkyT/webosu-online), MIT, "webosu!
3.3") and against the deployed site as of 2026-11.

Stack: static HTML plus plain `js/` modules. Pixi for rendering, Howler for
audio, no framework, no bundler. All gameplay state hangs off `window`.

`test/helpers/siteStub.ts` implements this document. If the stub and the site
disagree, one of them is wrong — and this file says which.

---

## 1. The globals

While a play is running the site keeps three globals up to date. They are
replaced (not mutated) when a play starts, and deleted or replaced when it ends.

```js
window.game = {
  scene,                  // the Playback object (same as window.playback)
  window,                 // the site's own window reference
  mouseX, mouseY,         // cursor position in osu! pixels (512x384 space)
  down,                   // K1down || K2down
  K1keycode, K2keycode,   // key codes the site compares against, live values
  K1down, K2down,         // the site's belief about each tap key
  allowMouseButton,       // false unless the player enabled click-to-tap
  autoplay,               // the site's own Autoplay mod
};

window.playback = {
  hits,                   // the beatmap's hit objects, see below
  track: { metadata, difficulty },
  osu: { audio },          // Howler-ish: audio.getPosition() returns seconds
  scoreOverlay,            // Pixi sprites; score, combo, judgecnt, judgeTotal, maxJudgeTotal
  audioReady,              // false while the beatmap is still loading
  ended,                   // true once the song has finished
  GreatTime, GoodTime, MehTime,  // judgement windows in ms, derived from OD
  offset,                  // beatmap offset in ms
};

window.gfx = { width, height, xoffset, yoffset };
```

`window.app.view` (the Pixi application) existing is a cheap liveness check:
the site tears it down when it leaves the play scene.

Kismet only ever *reads* these. `game.mouseX/mouseY` are written by the site's
own `mousemove` handler, not by Kismet — Kismet dispatches the event and lets
the site do the maths.

### Song time

```js
const songTimeMs = playback.osu.audio.getPosition() * 1000 + playback.offset;
```

That is the clock the site judges against. It is not `performance.now()`: the
audio can pause, seek, stall or resync independently of the page.

---

## 2. Hit objects

```js
{ type: "circle",  x, y, time, endTime }
{ type: "slider",  x, y, time, endTime, sliderTime, sliderTimeTotal, repeat, curve }
{ type: "spinner", x, y, time, endTime }
```

- `time` and `endTime` are song time in ms. For circles they are equal.
- `sliderTime` is the duration of **one** span; `sliderTimeTotal` is
  `sliderTime * repeat`; `endTime = time + sliderTimeTotal`.
- `curve.pointAt(t)` takes `t ∈ [0, 1]` along **one** span and returns
  `{ x, y }` in osu! pixels. Repeats reverse direction, so a full body is
  `span 0 forward, span 1 backward, ...`.
- Coordinates are playfield pixels, not CSS pixels. The playfield is 512×384.
- Spinner `x`/`y` are not meaningful; the site spins around the playfield
  centre, which is what Kismet mirrors.

`hits[]` is the whole beatmap, in order. It is not trimmed to the visible
window, so it can be copied once at detection time.

### Map metadata

```js
playback.track.metadata
// { Title, Artist, Creator, Version, ... }   (Version is the difficulty name)

playback.track.difficulty
// { OverallDifficulty, ApproachRate, CircleSize, HPDrainRate }
```

Judgement windows are read from `playback.GreatTime / GoodTime / MehTime` when
present (they are the site's own numbers); otherwise Kismet derives them from OD
with the standard osu! formulas.

---

## 3. Input

The site installs exactly three listeners, all on `window`, all in the bubble
phase:

```js
window.addEventListener("mousemove", ...);
window.addEventListener("keydown", ...);
window.addEventListener("keyup", ...);
```

### Cursor

```js
game.mouseX = (event.clientX - gfx.xoffset) / gfx.width  * 512;
game.mouseY = (event.clientY - gfx.yoffset) / gfx.height * 384;
```

So the inverse, which Kismet uses, is:

```js
clientX = gfx.xoffset + (x / 512) * gfx.width;
clientY = gfx.yoffset + (y / 384) * gfx.height;
```

`gfx` is the letterboxed playfield rectangle. It changes on resize and on
resolution changes, so it is read fresh on every move.

### Tapping

```js
window.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  if (event.keyCode === game.K1keycode) { if (game.K1down) return; game.K1down = true; }
  else if (event.keyCode === game.K2keycode) { if (game.K2down) return; game.K2down = true; }
  else return;
  game.down = true;
  checkClickdown();
});
```

Two consequences matter:

- `keyCode` is compared, not `code` or `key`. `90` is Z, `88` is X — but the
  player can rebind, so the numbers are read from `game.K1keycode` every time
  and re-read during play.
- `isTrusted` is never checked, which is why synthetic events work. `repeat` is
  checked, so Kismet never sends a repeat.

The site's `Pause` is `Escape` (27) and `Skip` is `Ctrl` by default; Kismet's
own hotkeys avoid those, and report a collision if the player rebinds a tap key
onto one of them.

### Judgement

`checkClickdown()` walks the unjudged hits and accepts a click when:

- `|songTime - hit.time| < MehTime`, and
- the cursor is within the circle radius of `hit.x`/`hit.y`.

Perfect/good/meh are `GreatTime`/`GoodTime`/`MehTime`. Score and accuracy come
from `scoreOverlay`:

```js
accuracy = scoreOverlay.judgeTotal / scoreOverlay.maxJudgeTotal;
```

Sliders are followed while the key is down and the cursor is near the ball;
spinners accumulate cursor rotation around the centre.

---

## 4. Autoplay

`game.autoplay` is the site's own mod. When it is on, the site plays every
object itself and ignores input.

Kismet refuses to run while it is on: two independent sources of clicks would
fight over the same objects, and the result is neither "our own autoplay" nor a
faithful measurement of it. The detection layer reports it as an error, the
panel says why, and `start()` will not proceed until it is off.

---

## 5. What Kismet must never do

- Call any function on `game`/`playback` that changes state.
- Set `game.autoplay = true`.
- Write `game.mouseX/mouseY` directly instead of dispatching `mousemove`.
- Mutate `playback.hits[]`, `scoreOverlay` or `track`.
- `preventDefault()` or `stopPropagation()` a gameplay event.
- Depend on Pixi internals, element class names, or the site's CSS.

Each of these is checked by `test/engine.test.ts` or `scripts/smoke.mjs`.
