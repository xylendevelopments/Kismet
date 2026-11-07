import { STUCK_KEY_TIMEOUT } from "../constants";

/**
 * Safety guards.
 *
 * The single hard requirement this module exists to satisfy: **never leave the
 * tap key stuck down**, under any failure mode — tab hidden, window blurred,
 * play closed mid-slider, beatmap changed, chart data lost, an exception in the
 * input path, or the user closing the tab.
 *
 * Every guard here is independent and idempotent, and each routes to one of two
 * callbacks: `onInterrupt` (stop driving, release, but keep the session so the
 * user can resume) or `onPanic` (stop the session entirely).
 */

export interface GuardHooks {
  /** Release the tap key right now. Must be safe to call at any time. */
  releaseAll: () => void;
  /** Pause: release, stop driving, keep the prepared chart. */
  onInterrupt: (reason: string) => void;
  /** Full safe shutdown with a user-visible reason. */
  onPanic: (reason: string) => void;
  /** Cheap liveness probe: is the play we bound to still the live one? */
  isGameAlive: () => boolean;
  /** Current chart time, or null when unknown. */
  chartTime: () => number | null;
  /** Is the tap key currently held by us? */
  isDown: () => boolean;
  /** Chart time the current hold began, or null when nothing is held. */
  heldSince: () => number | null;
  log?: (message: string) => void;
}

export interface GuardOptions {
  /** How often the watchdog runs. Deliberately slow — it is a backstop. */
  watchdogInterval?: number;
  /** A hold longer than this with no release is considered stuck. */
  stuckKeyTimeout?: number;
  win?: Window;
}

export class Guards {
  private hooks: GuardHooks;
  private opts: Required<Omit<GuardOptions, "win">> & { win: Window };
  private watchdogHandle: number | null = null;
  private installed = false;
  private disposers: Array<() => void> = [];

  /** Consecutive failed liveness probes before we escalate. */
  private deadProbeCount = 0;
  private static readonly DEAD_PROBE_LIMIT = 3;

  constructor(hooks: GuardHooks, options: GuardOptions = {}) {
    this.hooks = hooks;
    const win = options.win ?? window;
    this.opts = {
      watchdogInterval: options.watchdogInterval ?? 500,
      stuckKeyTimeout: options.stuckKeyTimeout ?? STUCK_KEY_TIMEOUT,
      win,
    };
  }

  /** Install every guard. Idempotent. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    const win = this.opts.win;

    // The site pauses itself on `blur`, and background tabs get their timers
    // throttled, which would wreck scheduling. Release the button and pause.
    this.add(win.document, "visibilitychange", () => {
      if (win.document.hidden) {
        this.hooks.log?.("tab hidden — releasing the tap key");
        this.hooks.releaseAll();
        this.hooks.onInterrupt("Tab hidden");
      }
    }, { passive: true });

    this.add(win, "blur", () => {
      this.hooks.log?.("window blurred — releasing the tap key");
      this.hooks.releaseAll();
      this.hooks.onInterrupt("Window lost focus");
    });

    // Navigating away or closing the tab: browsers do not reliably fire keyup
    // for synthetic presses. Release on the way out.
    this.add(win, "pagehide", () => this.hooks.releaseAll());
    this.add(win, "beforeunload", () => this.hooks.releaseAll());

    // Any uncaught error anywhere in the tool: stop safely rather than keep
    // driving input from a possibly inconsistent state.
    const onError = (event: ErrorEvent) => {
      const message = event?.message ?? "Unknown error";
      this.hooks.log?.(`window error observed: ${message}`);
      if (!this.hooks.isGameAlive()) {
        this.hooks.releaseAll();
        this.hooks.onPanic(`Uncaught error: ${message}`);
      }
    };
    this.add(win, "error", onError as EventListener);

    this.startWatchdog();
  }

  startWatchdog(): void {
    if (this.watchdogHandle !== null) return;
    this.watchdogHandle = setInterval(() => this.tick(), this.opts.watchdogInterval) as unknown as number;
  }

  stopWatchdog(): void {
    if (this.watchdogHandle !== null) {
      clearInterval(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  /** One watchdog pass. Exposed for tests; normally driven by the interval. */
  tick(): void {
    if (!this.installed) return;

    // 1. Liveness: did the play go away (quit, retry, song change)?
    if (!this.hooks.isGameAlive()) {
      this.deadProbeCount++;
      if (this.deadProbeCount >= Guards.DEAD_PROBE_LIMIT) {
        this.deadProbeCount = 0;
        this.hooks.releaseAll();
        this.hooks.onPanic("Gameplay ended");
      }
      return;
    }
    this.deadProbeCount = 0;

    // 2. Stuck click: a hold far longer than any slider or spinner body.
    if (!this.hooks.isDown()) return;
    const chartTime = this.hooks.chartTime();
    const since = this.hooks.heldSince();
    if (chartTime === null || since === null) return;
    const heldFor = chartTime - since;
    if (heldFor <= this.opts.stuckKeyTimeout) return;

    this.hooks.log?.(`tap key held ${heldFor.toFixed(0)}ms with no release — forcing`);
    this.hooks.releaseAll();
    this.hooks.onPanic("Stuck key detected");
  }

  private add(
    target: EventTarget,
    type: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    try {
      target.addEventListener(type, handler, options);
      this.disposers.push(() => {
        try {
          target.removeEventListener(type, handler, options);
        } catch {
          /* already detached */
        }
      });
    } catch (err) {
      this.hooks.log?.(`could not install "${type}" guard: ${String(err)}`);
    }
  }

  /** Remove every listener this module added. No stale listeners remain. */
  dispose(): void {
    this.stopWatchdog();
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* already gone */
      }
    }
    this.installed = false;
  }
}

/**
 * Cross-check our held state against the site's own.
 *
 * `game.K1down` / `game.K2down` are the site's authoritative record of what it
 * believes is down. If we think the button is up but the site thinks it is down
 * for several consecutive checks, our input path has desynced — most likely
 * because the site's tap key was rebound mid-run — and continuing would produce
 * garbage.
 */
export function verifyInputState(
  game: { K1down?: boolean; K2down?: boolean; down?: boolean; K1keycode?: number; K2keycode?: number } | null,
  ourDown: boolean,
  ourKeyCode: number,
): { ok: boolean; siteDown: boolean } {
  if (!game) return { ok: true, siteDown: false };

  // The site sets `down` from all four sources; only the key we press is ours.
  // Mirror the site's own bookkeeping for the code we dispatch.
  const isPrimary = game.K1keycode === ourKeyCode;
  const isSecondary = game.K2keycode === ourKeyCode;
  let siteDown: boolean;
  if (isPrimary) siteDown = game.K1down === true;
  else if (isSecondary) siteDown = game.K2down === true;
  else return { ok: true, siteDown: false };

  return { ok: siteDown === ourDown, siteDown };
}
