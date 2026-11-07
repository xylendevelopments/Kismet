# Safety, scope and honest limitations

## What Kismet is

Browser-side gameplay automation for [webosu!](https://webosu-online.netlify.app/)
running in your own tab. It reads the chart the page has already loaded, models
the site's audio clock, and dispatches ordinary DOM `MouseEvent`s and
`KeyboardEvent`s on `window` — the same events a player's hands produce.

It is built from standard browser APIs only: `addEventListener`, `dispatchEvent`,
`performance.now`, `requestAnimationFrame`, `MessageChannel`, `setTimeout`,
`localStorage` and DOM inspection.

## What Kismet is not

- **Not the site's Autoplay.** The built-in mod is never enabled, called or
  relied upon. Kismet produces its own chart, its own clock and its own input.
- **No `isTrusted` spoofing.** Synthetic events are dispatched honestly and stay
  `isTrusted === false`. There is no attempt to forge trusted input, and in a
  browser there is no legitimate way to.
- **No anti-cheat bypass, no sandbox escape, no CSP circumvention.**
- **No credential, cookie or site-storage access.** Kismet never reads
  `document.cookie` and never writes the site's `localStorage`; its own settings
  live under the single key `kismet:settings:v2`.
- **No network activity.** The bundle makes no requests: no fetches, no
  `XMLHttpRequest`, no remote script or font loading. The font, CSS and artwork
  are inlined at build time.
- **No remote code execution.** Nothing is `eval`'d from the network.
- **No modification of the site's objects.** Kismet reads `game`, `playback` and
  `gfx`; it never assigns to them and never calls their methods.

## The honest limitation

Every event Kismet produces is `isTrusted === false`. If the site ever adds
`if (!event.isTrusted) return;` to its `keydown` handler, this approach stops
working — and that is the site's prerogative. Kismet is a client-side
convenience, not an adversarial capability.

It also depends on the site's globals (`window.playback`, `window.game`,
`window.gfx`). A refactor that renames them disables the tool until
`src/detect/playbackSource.ts` is updated. That is by design: reading
documented state is more honest and more stable than reaching into a renderer's
internals, and when it breaks it breaks loudly, in one file.

## Guarantees, and where they are tested

| Guarantee | Enforced by | Test |
| --- | --- | --- |
| Never runs while the site's Autoplay is on | `playbackBlocker()` in `detect/playbackSource.ts` | `test/engine.test.ts` "refuses to run…" |
| Never presses without a matching release | `Pointer.releaseAll()` | `test/pointer.test.ts`, `test/engine.test.ts` |
| Releases on window blur | `Guards` | `test/guards.test.ts` |
| Releases on tab hide | `Guards` | `test/guards.test.ts` |
| Releases on pagehide/unload | `Guards` | `test/guards.test.ts` |
| Releases when the site pauses | engine pause mirroring | `test/engine.test.ts` "pauses and releases…" |
| Releases when gameplay exits | `tryDetect()` teardown | `test/engine.test.ts` "stops cleanly…" |
| Releases on a 20 s stuck hold | watchdog | `test/guards.test.ts` |
| Releases after three dead liveness probes | watchdog | `test/guards.test.ts` |
| Releases on `stop()` and `emergencyStop()` | engine | `test/engine.test.ts` |
| No `preventDefault`/`stopPropagation` on gameplay input | `Pointer`, `HotkeyManager` | `test/pointer.test.ts`, `test/overlay.test.ts` |
| Every dispatched event is synthetic | `Pointer` | `scripts/smoke.mjs` |
| No dropped or doubled taps in a full chart | scheduler + stats | `test/engine.test.ts`, `scripts/smoke.mjs` |
| The panel cannot be opened by a page script | `isTrusted` filter | `test/overlay.test.ts`, `scripts/smoke.mjs` |

The smoke test asserts these against the *shipped bundle*, not the sources, so a
bundling mistake cannot hide a broken guarantee.

## Hotkey collisions

The site's defaults are Z and X for taps, Escape for pause, Ctrl for skip. A
Kismet action hotkey that shares a code with a tap key would fire on every note,
so `HotkeyManager` compares its bindings against `game.K1keycode/K2keycode` and:

- still works (the tool must be controllable), but
- shows a warning in the panel, and
- names the binding so the player can change either side.

The panel shortcut (Right Shift) is fixed rather than configurable, and cannot
be captured by the rebinding UI.

## Fair play

webosu! has no meaningful leaderboards, which is why the site ships an Autoplay
mod at all. Even so: do not submit or claim an automated play as your own on any
site that ranks them, and do not use humanization to make an automated score
look legitimate. Humanization exists to study how timing variation affects
judgement, not to disguise automation.

## Scope

Supported: `https://webosu-online.netlify.app/` and its mirrors
(`webosu.online`), plus localhost dev servers running the same site. Nothing
else — the previous osu!mania adapters have been removed.
