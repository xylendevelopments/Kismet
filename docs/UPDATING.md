# Updating when the site changes

Kismet depends on a small, deliberate surface of webosu!. When the site changes,
the work should be a handful of edits in known places. This file is the map.

## First: check whether it is really broken

```js
Kismet.diagnostics()
```

| What you see | Where to look |
| --- | --- |
| `site.verdict: "unknown"` | `detect/siteDetection.ts` — the hostname changed, or the site is served from a new domain |
| `site.verdict: "probable"`, `chart: null` | `detect/playbackSource.ts` — the globals moved |
| `chart.objects` smaller than expected | `chart/chart.ts` — the `hits[]` shape changed |
| `blocker` non-null | `playbackSource.ts`'s `playbackBlocker`, or the site really is autoplaying |
| Chart fine, clicks miss | `input/Pointer.ts` (client mapping) or `timing/clock.ts` (song time) |
| Clicks land, nothing scores | The site no longer judges from `game.mouseX/mouseY` + `K1down`, or it now checks `isTrusted` |
| `input.maxMoveError` large | `window.gfx` semantics changed (`xoffset`/`yoffset`/`width`/`height`) |
| `clock.errorMs` large | `playback.osu.audio.getPosition()` changed units or the offset is applied twice |

## The four files that encode the contract

1. **`src/constants.ts`** — hosts, globals, playfield size. A new deployment is
   one array entry.
2. **`src/detect/playbackSource.ts`** — how to find the play and read the tap
   keys.
3. **`src/chart/chart.ts`** — how a hit object becomes a `ChartObject`.
4. **`src/input/Pointer.ts`** — how a playfield coordinate becomes a
   `mousemove`, and how a press becomes a `keydown`.

Each has a single exported entry point, and `test/helpers/siteStub.ts` implements
the same contract. **Update the stub first**: if you can make the new behaviour
work in the stub, the test suite tells you whether the engine still plays.

## Procedure

1. Reproduce in the demo, not on the live site:
   ```bash
   npm run build && npm run demo
   ```
   Change `demo/stub-game.js` to mimic the new site behaviour.
2. Write the failing test in `test/engine.test.ts` (or a new file) that
   describes the new reality.
3. Change the smallest module that makes it pass. If you find yourself touching
   `engine.ts`, ask whether the change belongs in the module that owns that
   knowledge instead.
4. Run `npm run verify`:
   ```bash
   npm run typecheck && npm test && npm run smoke
   ```
5. Update `docs/SITE-CONTRACT.md` with whatever you learned. It is the document
   the next person will trust.

## If the site starts checking `isTrusted`

There is no sanctioned workaround, and Kismet will not pretend otherwise. The
honest options are: run the site from source where you control the code, or stop
using the tool on that deployment. Do not add `isTrusted` spoofing attempts —
they do not work and they change what this project is.

## If the site's tap keys change

Nothing to do. `game.K1keycode`/`K2keycode` are read live, and the panel's
**Input → Re-read from site** button re-resolves them mid-session. If the player
rebinds a tap key onto one of Kismet's hotkeys, the panel shows a collision
warning and the binding can be changed in **More! → Hotkeys**.

## If a new host appears

Add it to `KNOWN_HOSTS` (or `KNOWN_APEXES` for a wildcard) in
`src/constants.ts`, and to the `@match` list in `scripts/build.mjs`. Then check
`test/helpers/domStub.ts`'s default hostname, which the overlay tests rely on.

## Versioning

`src/constants.ts` `VERSION`, `package.json` `version` and the userscript header
must agree; `scripts/build.mjs` reads the first and writes the other two. Bump
the major when the contract changes in a way a user would notice, and record why
in the commit message.
