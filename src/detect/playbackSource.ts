import {
  APP_GLOBAL,
  FALLBACK_TAP_KEYCODES,
  GAME_GLOBAL,
  GFX_GLOBAL,
  PLAYBACK_GLOBAL,
  PLAYFIELD,
} from "../constants";
import type { SiteGame, SiteGfx, SitePlayback, TapKeys } from "../types";

/**
 * The seam between webosu! and this tool.
 *
 * Everything site-specific lives here: which globals exist, what a "live play"
 * looks like, how the site exposes its clock and its letterboxed playfield, and
 * which key codes its input listeners compare against. Nothing above this file
 * imports a site type — the engine only ever sees `Chart`, `InputAction` and a
 * `TapKeys` snapshot.
 *
 * Contract (see docs/SITE-CONTRACT.md, derived from the site's own source):
 *
 *   window.game      initgame.js    mouseX/mouseY (osu! px), down, K1keycode,
 *                                   K2keycode, autoplay, scene
 *   window.playback  playback.js    hits[], track.metadata, osu.audio, ended,
 *                                   GreatTime/GoodTime/MehTime, scoreOverlay
 *   window.gfx       playback.js    { width, height, xoffset, yoffset }
 *   window.app       launchgame.js  the Pixi application (liveness marker)
 *
 * All of it is read-only. Kismet never writes to the site's state except
 * through the site's own DOM input listeners.
 */

export interface AcquiredPlayback {
  playback: SitePlayback;
  game: SiteGame;
  gfx: SiteGfx;
  via: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function readGame(win: Window): SiteGame | null {
  const game = asObject((win as unknown as Record<string, unknown>)[GAME_GLOBAL]);
  if (!game) return null;
  return game as unknown as SiteGame;
}

/**
 * Find the live `Playback` scene.
 *
 * The constructor stamps `window.playback`, and the same object is reachable as
 * `game.scene`. Both are checked because the site nulls `window.playback` on
 * some teardown paths but keeps `game.scene` until the next launch — and a
 * scene whose `ended` flag is set is a finished play, not a live one.
 */
export function readPlayback(win: Window, game: SiteGame | null): SitePlayback | null {
  const anyWin = win as unknown as Record<string, unknown>;
  const candidates = [anyWin[PLAYBACK_GLOBAL], game?.scene];
  for (const candidate of candidates) {
    const playback = asObject(candidate) as unknown as SitePlayback | null;
    if (!playback) continue;
    if (!Array.isArray(playback.hits) || playback.hits.length === 0) continue;
    if (!playback.osu || typeof playback.osu.audio?.getPosition !== "function") continue;
    return playback;
  }
  return null;
}

/** Acquire everything the engine needs, or null when no play is loaded. */
export function acquirePlayback(win: Window): AcquiredPlayback | null {
  const game = readGame(win);
  if (!game) return null;

  const playback = readPlayback(win, game);
  if (!playback) return null;

  const anyWin = win as unknown as Record<string, unknown>;
  const via = playback === anyWin[PLAYBACK_GLOBAL] ? "window.playback" : "game.scene";

  return { playback, game, gfx: readGfx(win), via };
}

/**
 * The letterboxed playfield mapping. `window.gfx` is written by the site's
 * `Playback.calcSize()` on launch and on every resize.
 */
export function readGfx(win: Window): SiteGfx {
  const gfx = asObject((win as unknown as Record<string, unknown>)[GFX_GLOBAL]);
  const width = Number(gfx?.width);
  const height = Number(gfx?.height);
  const xoffset = Number(gfx?.xoffset);
  const yoffset = Number(gfx?.yoffset);

  if (
    Number.isFinite(width) && width > 0 &&
    Number.isFinite(height) && height > 0
  ) {
    return {
      width,
      height,
      xoffset: Number.isFinite(xoffset) ? xoffset : 0,
      yoffset: Number.isFinite(yoffset) ? yoffset : 0,
    };
  }

  // Fall back to the full window. The site only diverges from this when the
  // window's aspect ratio is wider than 4:3, and a slightly wrong scale still
  // lands inside the hit circle on a circle whose radius is ~55 osu px.
  const w = Math.max(1, win.innerWidth || PLAYFIELD.width);
  const h = Math.max(1, win.innerHeight || PLAYFIELD.height);
  const scale = Math.min(w / PLAYFIELD.width, h / PLAYFIELD.height);
  const width2 = PLAYFIELD.width * scale;
  const height2 = PLAYFIELD.height * scale;
  return {
    width: width2,
    height: height2,
    xoffset: (w - width2) / 2,
    yoffset: (h - height2) / 2,
  };
}

/** Read the site's two tap keys, preferring the requested one. */
export function readTapKeys(game: SiteGame | null, preferred: "primary" | "secondary"): TapKeys {
  const rawPrimary = Number(game?.K1keycode);
  const rawSecondary = Number(game?.K2keycode);

  const primary = Number.isFinite(rawPrimary) && rawPrimary > 0 ? rawPrimary : null;
  const secondary = Number.isFinite(rawSecondary) && rawSecondary > 0 ? rawSecondary : null;

  let active: "primary" | "secondary" = preferred === "secondary" ? "secondary" : "primary";
  if (active === "secondary" && secondary === null) active = "primary";
  if (active === "primary" && primary === null) active = "secondary";

  const siteCode = active === "primary" ? primary : secondary;
  const source: TapKeys["source"] = siteCode === null ? "fallback" : "site";
  const code = siteCode ?? (active === "primary" ? FALLBACK_TAP_KEYCODES.primary : FALLBACK_TAP_KEYCODES.secondary);

  return { primary, secondary, active, code, source };
}

/** Chart time, in ms, as the site will judge an input fired right now. */
export function siteTime(playback: SitePlayback): number | null {
  try {
    const position = playback.osu.audio.getPosition();
    if (typeof position !== "number" || !Number.isFinite(position)) return null;
    const offset = Number(playback.offset);
    return position * 1000 + (Number.isFinite(offset) ? offset : 0);
  } catch {
    return null;
  }
}

/** True while the site is actually running its clock (not paused/loading). */
export function sitePlaying(playback: SitePlayback): boolean {
  if (playback.audioReady === false) return false;
  if (playback.ended === true) return false;
  const audio = playback.osu.audio as { playing?: boolean };
  if (typeof audio.playing === "boolean") return audio.playing;
  // Older builds do not expose `playing`; treat a live, non-ended scene as
  // playing and let the guards (clock moving / not moving) handle the rest.
  return true;
}

/**
 * Cheap liveness probe: is this still the scene the engine bound to?
 *
 * The site destroys the scene on quit, retry and song change, and it nulls
 * `window.app` when the play closes. A detached canvas or a swapped `game.scene`
 * means the chart we mirrored no longer describes what is on screen.
 */
export function playbackAlive(win: Window, playback: SitePlayback | null, game: SiteGame | null): boolean {
  if (!playback || !game) return false;
  if (playback.ended === true) return false;
  if (game.scene && game.scene !== playback) return false;
  if (!Array.isArray(playback.hits) || playback.hits.length === 0) return false;

  const app = (win as unknown as Record<string, unknown>)[APP_GLOBAL] as
    | { view?: unknown; canvas?: unknown; renderer?: { view?: unknown } }
    | null;
  const canvas = (app?.view ?? app?.canvas ?? app?.renderer?.view) as unknown;
  const ElementCtor = (win as unknown as { Element?: typeof Element }).Element;
  if (ElementCtor && canvas instanceof ElementCtor && !(canvas as Element).isConnected) return false;

  return true;
}

/**
 * Why the current play cannot be driven, or null when it can.
 *
 * The site's own Autoplay mod is the interesting case: when it is on the site
 * does not even register the gameplay listeners, and moves the cursor itself.
 * Running both is impossible, and silently doing nothing while the user thinks
 * Kismet is playing would be worse than saying so.
 */
export function playbackBlocker(game: SiteGame | null, playback: SitePlayback | null): string | null {
  if (!game) return "webosu!'s game state is not available yet.";
  if (!playback) return "No play is loaded. Pick a beatmap and difficulty to start.";

  if (game.autoplay) {
    return "webosu!'s built-in Autoplay mod is on. Turn it off — Kismet drives its own input and cannot run alongside it.";
  }

  if (!Array.isArray(playback.hits) || playback.hits.length === 0) {
    return "The play reports an empty chart.";
  }

  if (playback.ended) return "The play has finished.";

  if (typeof game.K1keycode !== "number" && typeof game.K2keycode !== "number") {
    return "The site's tap keys could not be read from its settings.";
  }

  return null;
}
