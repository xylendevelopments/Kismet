import type { HumanizationConfig } from "./humanize/humanizer";

/**
 * Shared type vocabulary for the whole tool.
 *
 * These types deliberately mirror the *observable* shape of webosu!'s
 * internals rather than importing them: the tool runs as an injected script
 * with no build-time access to the site's modules. Everything here is
 * structurally typed so that minor site refactors keep working.
 *
 * The site's own vocabulary (`Playback`, `hitObjects`, `circle`/`slider`/
 * `spinner`, `mouseX`/`mouseY`, `K1keycode`) is preserved on purpose: it makes
 * `docs/SITE-CONTRACT.md` checkable against the site's source line by line.
 */

export interface Point {
  x: number;
  y: number;
}

/** The three object types osu!standard (and webosu!) uses. */
export type ObjectKind = "circle" | "slider" | "spinner";

/**
 * One object mirrored out of the site's live chart.
 *
 * Only the fields Kismet needs are copied; the site's object also carries Pixi
 * sprites, judgements and Howl references, and holding those alive across a
 * retry is how a helper like this leaks memory.
 */
export interface ChartObject {
  /** Position in the chart, ascending by `time`. */
  index: number;
  kind: ObjectKind;
  /** Hit position in osu! pixels. For a spinner this is the playfield centre. */
  x: number;
  y: number;
  /** Chart time of the object's hit moment, ms. */
  time: number;
  /**
   * Chart time the object stops needing the cursor/button, ms.
   * Equal to `time` for a circle, the last slider tick for a slider, and the
   * end of the spin for a spinner.
   */
  endTime: number;
  /** Slider duration of one repeat, ms. `0` for circles and spinners. */
  sliderDuration: number;
  /** Number of slider repeats, `>= 1`. `0` for circles and spinners. */
  repeat: number;
  /**
   * Pre-sampled slider path in osu! pixels, already unrolled across repeats so
   * a plain interpolation over `[0, 1]` walks the whole slider once. `null` for
   * circles and spinners.
   */
  path: Point[] | null;
}

/** A normalised, engine-owned view of the chart. */
export interface Chart {
  objects: ChartObject[];
  /** Circles + sliders + spinners. */
  noteCount: number;
  circles: number;
  sliders: number;
  spinners: number;
  /** Chart time of the first and last object, ms. */
  startTime: number;
  endTime: number;
  /** Stable identity used to detect "the user switched beatmaps". */
  signature: string;
  /** Human-readable label for the UI, best effort. */
  label?: string;
  /** Difficulty values the site derived from the beatmap, for the readout. */
  difficulty: { od: number; ar: number; cs: number; hp: number };
  /** Judgement windows the site will use, ms. */
  windows: { great: number; good: number; meh: number };
}

/** A single scheduled cursor action. */
export interface InputAction {
  /** Monotonic index; preserves ordering for same-timestamp batches. */
  seq: number;
  /** Absolute chart time in ms at which this action should land. */
  time: number;
  type: "down" | "up";
  /** The object this action belongs to. */
  objectIndex: number;
  /** Where the cursor must be, in osu! pixels, when a `down` fires. */
  x: number;
  y: number;
  /** True when another action shares the exact same timestamp. */
  simultaneous: boolean;
}

export type EnginePhase =
  | "IDLE"
  | "DETECTING"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "STOPPING"
  | "ERROR";

export interface EngineStats {
  objectsTotal: number;
  objectsRemaining: number;
  taps: number;
  /** Chart time of the playhead, ms. */
  timeElapsed: number;
  /** Objects the site has judged (all judgements, misses included). */
  hits: number;
  /** Hits that were not misses. */
  judgedGood: number;
  combo: number;
  accuracy: number | null;
  score: number | null;
  /** Wall-clock scheduling error of the last fired action, ms. Signed. */
  lastJitter: number;
  /** Rolling average absolute scheduling error, ms. */
  avgJitter: number;
  /** Whether the cursor button is currently held. */
  holding: boolean;
}

/**
 * The site's two tap keys, read live from `game.K1keycode` / `game.K2keycode`.
 *
 * webosu! binds gameplay clicks to two key codes (Z and X by default, but the
 * site's Input settings can rebind them), plus optionally the mouse buttons.
 * Kismet presses one of these through the page's own listeners.
 */
export interface TapKeys {
  /** Virtual key code of the site's primary tap key. */
  primary: number | null;
  secondary: number | null;
  /** Which one Kismet presses. */
  active: "primary" | "secondary";
  /** The key code that will actually be dispatched. */
  code: number | null;
  /** Where the code came from, for diagnostics. */
  source: "site" | "fallback";
}

export type HotkeyAction =
  | "toggleUI"
  | "start"
  | "pause"
  | "stop"
  | "emergency";

export interface Settings {
  general: {
    enabled: boolean;
    /** Opt in to starting on each newly detected playable chart. */
    autoStart: boolean;
    /** Legacy stored value; visibility is controlled only by Right Shift. */
    showOverlay: boolean;
    showKeyboard: boolean;
    debug: boolean;
  };
  timing: {
    /** Applied to every scheduled action. Negative = earlier. ms. */
    offset: number;
    /** Maximum interval between deadline rechecks over long gaps, in ms. */
    lookahead: number;
    /** Extra lead applied to compensate for dispatch latency. ms. */
    inputDelayCompensation: number;
    /** Upper bound on the busy-wait used for sub-ms precision. ms. */
    spinThreshold: number;
  };
  input: {
    /** Which of the site's tap keys to press. */
    tapKey: "primary" | "secondary";
    /** Circle/press hold length in ms. */
    tapHold: number;
    /** Spinner rotation speed, revolutions per second. */
    spinRate: number;
    hotkeys: Record<HotkeyAction, string>;
  };
  appearance: {
    uiScale: number;
    opacity: number;
    accent: string;
    position: { x: number; y: number };
    /** Legacy stored value; the panel no longer has a mini-bar. */
    collapsed: boolean;
    size: { w: number; h: number };
  };
  /**
   * Deliberate timing variation. Off by default: frame-exact playback is the
   * honest baseline, and enabling this makes a run intentionally imperfect.
   * See src/humanize/humanizer.ts for what each control does.
   */
  humanization: HumanizationConfig;
}

/** Outcome of a detection attempt. */
export interface DetectionResult {
  ok: boolean;
  /** Which strategy produced the result. */
  via?: string;
  chart?: Chart;
  tapKeys?: TapKeys;
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* The site's own shapes, as observed. Read-only by contract.          */
/* ------------------------------------------------------------------ */

/** A slider curve, as exposed by the site's `SliderMesh`/curve classes. */
export interface SiteSliderCurve {
  pointAt(t: number): Point;
  curve?: Point[];
}

/** One entry of `playback.hits` (a shallow copy of a parsed hit object). */
export interface SiteHitObject {
  type?: string;
  x: number;
  y: number;
  time: number;
  endTime?: number;
  repeat?: number;
  sliderTime?: number;
  sliderTimeTotal?: number;
  score?: number;
  curve?: SiteSliderCurve;
  ball?: { x: number; y: number };
  [key: string]: unknown;
}

export interface SiteTrackMetadata {
  Title?: string;
  Artist?: string;
  Version?: string;
  Creator?: string;
  [key: string]: unknown;
}

export interface SiteTrack {
  metadata?: SiteTrackMetadata;
  difficulty?: Record<string, number>;
  hitObjects?: SiteHitObject[];
  [key: string]: unknown;
}

/** The site's `Audio` wrapper (see its `osu-audio.js`). */
export interface SiteAudio {
  getPosition(): number;
  playing?: boolean;
  currentTime?: number;
  playbackRate?: number;
}

/** The site's `ScoreOverlay` (see its `overlay/score.js`). */
export interface SiteScoreOverlay {
  score?: number;
  combo?: number;
  maxcombo?: number;
  judgecnt?: { great?: number; good?: number; meh?: number; miss?: number };
  judgeTotal?: number;
  maxJudgeTotal?: number;
  [key: string]: unknown;
}

/**
 * The site's live `Playback` scene.
 *
 * Published as `window.playback` by the constructor and also reachable as
 * `window.game.scene`.
 */
export interface SitePlayback {
  hits: SiteHitObject[];
  track: SiteTrack;
  osu: { audio: SiteAudio } & Record<string, unknown>;
  game: SiteGame;
  scoreOverlay?: SiteScoreOverlay;
  audioReady?: boolean;
  ended?: boolean;
  /** Judgement windows, ms, derived from the beatmap's OD. */
  GreatTime?: number;
  GoodTime?: number;
  MehTime?: number;
  circleRadius?: number;
  approachTime?: number;
  /** Playhead correction the site applies on top of the audio position. */
  offset?: number;
  /** Set by the site when the scene is disposed. */
  destroy?: () => void;
}

/** The site's global `game` state object (see its `initgame.js`). */
export interface SiteGame {
  scene?: SitePlayback | null;
  window?: Window;
  mouseX: number;
  mouseY: number;
  down: boolean;
  K1keycode?: number;
  K2keycode?: number;
  K1down?: boolean;
  K2down?: boolean;
  M1down?: boolean;
  M2down?: boolean;
  allowMouseButton?: boolean;
  autoplay?: boolean;
  hardrock?: boolean;
  easy?: boolean;
  nightcore?: boolean;
  daycore?: boolean;
  finished?: boolean;
  /** The site's cursor position predictor. */
  mouse?: ((t: number) => { x: number; y: number; r: number }) | null;
  stage?: unknown;
  [key: string]: unknown;
}

/** `window.gfx`: the letterboxed mapping between osu! pixels and CSS pixels. */
export interface SiteGfx {
  width: number;
  height: number;
  xoffset: number;
  yoffset: number;
}
