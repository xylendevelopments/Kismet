import { DEFAULT_HUMANIZATION } from "./humanize/humanizer";
import type { Settings } from "./types";

export const NAME = "Kismet";
export const VERSION = "2.0.1";

/** The site this tool drives. */
export const SITE_NAME = "webosu!";

/** The panel is deliberately available only from the physical Right Shift key. */
export const UI_TOGGLE_CODE = "ShiftRight";

/** localStorage key for persisted settings. Versioned so we can migrate. */
export const STORAGE_KEY = "kismet:settings:v2";

/**
 * Hostnames Kismet treats as "webosu!".
 *
 * webosu! is a static site that has been deployed on several hosts over its
 * life. The check is an equality/suffix match against known deployments rather
 * than a single domain, so a mirror does not silently disable the tool.
 */
export const KNOWN_HOSTS = [
  "webosu-online.netlify.app",
  "webosu.online",
  "www.webosu.online",
];

/** Apex domains whose subdomains are also accepted (preview deployments). */
export const KNOWN_APEXES = ["webosu.online"];

/** Localhost dev servers for the site's own repo (`python -m http.server`). */
export const DEV_HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * The playfield the site judges in. Every coordinate the game stores for a hit
 * object — and every coordinate its input listeners read back — is in this
 * 512x384 "osu! pixel" space, not in CSS pixels. `window.gfx` holds the
 * letterboxed mapping between the two.
 */
export const PLAYFIELD = { width: 512, height: 384 } as const;

/** The global the site publishes its game state on (see its `initgame.js`). */
export const GAME_GLOBAL = "game";

/** The global the site publishes the active `Playback` scene on. */
export const PLAYBACK_GLOBAL = "playback";

/** The global the site publishes its letterboxed playfield geometry on. */
export const GFX_GLOBAL = "gfx";

/** The global the site publishes its Pixi application on, while playing. */
export const APP_GLOBAL = "app";

/** Upper bound on hit objects we are willing to mirror into a chart. */
export const MAX_CHART_OBJECTS = 40_000;

/** Timing offset slider bounds. */
export const OFFSET_MIN = -200;
export const OFFSET_MAX = 200;

/** Scheduling window bounds. */
export const LOOKAHEAD_MIN = 20;
export const LOOKAHEAD_MAX = 500;

/** How often the status readout is allowed to touch the DOM. */
export const UI_UPDATE_INTERVAL = 90; // ms

/** How often the debug log is flushed to the DOM. */
export const DEBUG_FLUSH_INTERVAL = 150; // ms

/**
 * Idle poll interval for *detection only*.
 *
 * Deliberately NOT used for note scheduling — the scheduler uses precise
 * timers instead. This single slow timer exists purely to notice
 * "a play started" / "a play ended".
 */
export const DETECT_POLL_INTERVAL = 500; // ms

/** Safety: if the tap key has been held this long with no release queued,
 *  force it up. Guards against a stuck click if the chart or the site
 *  misbehaves. */
export const STUCK_KEY_TIMEOUT = 20_000; // ms

/** Guard against runaway scheduling if the clock mapping goes non-monotonic. */
export const MAX_CATCHUP_ACTIONS_PER_FRAME = 256;

/**
 * How long a circle's tap holds the key down.
 *
 * The site judges a circle on `keydown` alone, so this value never affects
 * accuracy; it exists so the press looks like a press instead of a zero-length
 * event, and so a second object inside the same window cannot be missed.
 */
export const DEFAULT_TAP_HOLD_MS = 12;

/** Radius, in osu! pixels, the cursor orbits a spinner at. */
export const SPIN_RADIUS = 60;

/** Default spinner rotation, revolutions per second. */
export const DEFAULT_SPIN_RATE = 4;

/**
 * Default keybind layout. Only used by the demo stub and as documentation —
 * the real site always supplies its own tap keycodes
 * (`game.K1keycode` / `game.K2keycode`), and Kismet reads those.
 */
export const FALLBACK_TAP_KEYCODES = { primary: 90, secondary: 88 }; // Z / X

export const DEFAULT_SETTINGS: Settings = {
  general: {
    enabled: true,
    // Opt-in: an update must not start playing songs without user action.
    autoStart: false,
    // Legacy persisted flag; panel visibility is transient and keyboard-only.
    showOverlay: false,
    showKeyboard: true,
    debug: false,
  },
  timing: {
    offset: 0,
    lookahead: 120,
    inputDelayCompensation: 0,
    spinThreshold: 6,
  },
  input: {
    /** Which of the site's two tap keys Kismet presses. */
    tapKey: "primary",
    /** Circle/press hold length, in ms. Does not affect judgement. */
    tapHold: DEFAULT_TAP_HOLD_MS,
    /** Spinner rotation, revolutions per second. */
    spinRate: DEFAULT_SPIN_RATE,
    hotkeys: {
      // Right Shift toggles the panel. The action keys deliberately avoid the
      // site's own defaults (Z and X for taps, Esc for pause, Ctrl for skip):
      // a hotkey that doubles as a tap key would fire on every note.
      toggleUI: UI_TOGGLE_CODE,
      start: "KeyG",
      pause: "KeyB",
      stop: "KeyV",
      emergency: "KeyP",
    },
  },
  appearance: {
    uiScale: 1,
    opacity: 1,
    accent: "#ff6b9d",
    position: { x: 16, y: 16 },
    collapsed: false,
    size: { w: 427, h: 0 },
  },
  humanization: { ...DEFAULT_HUMANIZATION },
};
