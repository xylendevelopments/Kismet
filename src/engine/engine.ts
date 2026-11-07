import { analyseChart, buildChart, sliderPointAt, type ChartAnalysis } from "../chart/chart";
import { buildTimeline, type Timeline } from "../chart/timeline";
import {
  DETECT_POLL_INTERVAL,
  PLAYFIELD,
  SPIN_RADIUS,
} from "../constants";
import {
  acquirePlayback,
  playbackAlive,
  playbackBlocker,
  readGfx,
  readTapKeys,
  sitePlaying,
  siteTime,
} from "../detect/playbackSource";
import { detectSite, NOT_DETECTED_MESSAGE, type SiteCheck } from "../detect/siteDetection";
import { Guards, verifyInputState } from "./guards";
import { collectStats, notesRemainingAt } from "./stats";
import { ClockMapper } from "../timing/clock";
import { Scheduler } from "../timing/scheduler";
import { Pointer } from "../input/Pointer";
import { Humanizer, type HumanizationStats } from "../humanize/humanizer";
import type { SettingsManager } from "../core/settings";
import type {
  Chart,
  ChartObject,
  DetectionResult,
  EnginePhase,
  EngineStats,
  InputAction,
  Point,
  Settings,
  SiteGame,
  SitePlayback,
  TapKeys,
} from "../types";
import { Emitter } from "../util/emitter";
import { lowerBound } from "../util/helpers";

/**
 * The autoplay engine.
 *
 * Lifecycle:
 *
 *   IDLE -> DETECTING -> READY -> RUNNING <-> PAUSED -> STOPPING -> READY
 *                        |                                    |
 *                        +--------------------------------> ERROR
 *
 * Two loops, and only two:
 *
 *   - The **scheduler** fires keydown/keyup at exact chart times. It is
 *     timer-driven (see src/timing/scheduler.ts) and never polls per object.
 *   - The **pointer loop** runs once per animation frame while playing and only
 *     moves the cursor: along a slider's path, around a spinner, or gliding
 *     toward the next circle. Cursor motion is inherently continuous, so a
 *     frame loop is the right shape for it and it costs one `mousemove` per
 *     frame.
 *
 * Detection keeps polling on a slow timer. That single poll exists purely to
 * notice "a play started/ended"; nothing about note playback depends on it.
 */

type PendingStart = "manual" | "automatic" | null;

export interface EngineEvents {
  phase: { phase: EnginePhase; reason?: string };
  pendingStart: { pending: PendingStart };
  detected: { chart: Chart; tapKeys: TapKeys; analysis: ChartAnalysis; via: string };
  timeline: { analysis: ChartAnalysis; humanization: HumanizationStats | null };
  lost: { reason: string };
  stats: EngineStats;
  /** Button state, for the panel's tap-key indicator. */
  cursorState: { holding: boolean; keyCode: number | null };
  log: { level: "info" | "warn" | "error"; message: string; data?: unknown };
  site: SiteCheck;
}

export interface EngineOptions {
  settings: SettingsManager;
  win?: Window;
}

export const SAFE_STOP_MESSAGE = "Autoplay stopped safely.";

/** Longest time the cursor spends travelling between two objects. */
const MAX_GLIDE_MS = 420;
/** Minimum travel time, so two adjacent objects still show movement. */
const MIN_GLIDE_MS = 40;

function humanizationSignature(settings: Settings): string {
  const h = settings.humanization;
  if (!h.enabled) return "off";
  return [
    "on",
    h.seed >>> 0,
    h.strength,
    h.distribution,
    h.shortTermDrift,
    h.longTermDrift,
    h.patternAware,
    h.holdReleaseVariation,
    h.fatigue,
  ].join("|");
}

export class Engine {
  private settingsManager: SettingsManager;
  private win: Window;

  private emitter = new Emitter<EngineEvents>();

  private phase: EnginePhase = "IDLE";
  private siteCheck: SiteCheck | null = null;

  private playback: SitePlayback | null = null;
  private game: SiteGame | null = null;
  private detectedVia = "";
  private chart: Chart | null = null;
  private tapKeys: TapKeys | null = null;
  private timeline: Timeline | null = null;
  private blocker: string | null = null;

  private clock = new ClockMapper();
  private scheduler: Scheduler;
  private pointer: Pointer;
  private guards: Guards;

  private detectHandle: number | null = null;
  private statsHandle: number | null = null;
  private monitorHandle: number | null = null;
  private pointerHandle: number | null = null;

  private humanizer: Humanizer | null = null;
  private lastTimelineHumanization = "";
  private disposed = false;

  private desyncCount = 0;
  private pausedBySite = false;
  private pendingStart: PendingStart = null;
  private lastAutoStart: boolean;
  private static readonly DESYNC_LIMIT = 6;

  private lastError = "";
  private lastChartSignature = "";
  private lastQuickSignature = "";

  /** Chart time at which the current hold began, for the stuck-key watchdog. */
  private heldSince: number | null = null;

  constructor(options: EngineOptions) {
    this.settingsManager = options.settings;
    this.win = options.win ?? window;

    const settings = this.settingsManager.all;
    this.lastAutoStart = settings.general.autoStart;

    this.pointer = new Pointer({
      win: this.win,
      keyCode: 90,
      geometry: () => readGfx(this.win),
      game: () => this.game,
      onError: (err) => this.log("error", `input failure: ${String(err)}`),
    });

    this.scheduler = new Scheduler(
      {
        nowChart: () => this.chartTime(),
        hostTimeFor: (chartTime) => this.hostTimeForChart(chartTime),
        fire: (actions, hostNow, targetChart) => this.onFire(actions, hostNow, targetChart),
        sample: (host, chart) => this.onClockSample(host, chart),
        log: (message) => this.log("info", message),
        onOverrun: (dropped, at, skipped) => this.onOverrun(dropped, at, skipped),
        onComplete: () => this.onChartComplete(),
      },
      {
        lookahead: settings.timing.lookahead,
        spinThreshold: settings.timing.spinThreshold,
        now: () => performance.now(),
        requestFrame: (cb) => this.win.requestAnimationFrame(cb),
        cancelFrame: (h) => this.win.cancelAnimationFrame(h),
      },
    );

    this.guards = new Guards(
      {
        releaseAll: () => {
          this.pointer.releaseAll();
          this.heldSince = null;
        },
        onInterrupt: (reason) => this.interrupt(reason),
        onPanic: (reason) => this.safeStop(reason),
        isGameAlive: () =>
          (this.phase !== "RUNNING" && this.phase !== "PAUSED") ||
          playbackAlive(this.win, this.playback, this.game),
        chartTime: () => (Number.isFinite(this.chartTime()) ? this.chartTime() : null),
        isDown: () => this.pointer.isDown,
        heldSince: () => this.heldSince,
        log: (message) => this.log("info", message),
      },
      { win: this.win },
    );
  }

  /* ------------------------------ public ------------------------------ */

  on<K extends keyof EngineEvents>(
    type: K,
    handler: (payload: EngineEvents[K]) => void,
  ): () => void {
    return this.emitter.on(type, handler);
  }

  get currentPhase(): EnginePhase {
    return this.phase;
  }

  get currentChart(): Chart | null {
    return this.chart;
  }

  get currentTapKeys(): TapKeys | null {
    return this.tapKeys;
  }

  get currentAnalysis(): ChartAnalysis | null {
    return this.timeline?.analysis ?? null;
  }

  get currentPlayback(): SitePlayback | null {
    return this.playback;
  }

  get currentGame(): SiteGame | null {
    return this.game;
  }

  get currentSiteCheck(): SiteCheck | null {
    return this.siteCheck;
  }

  get lastErrorMessage(): string {
    return this.lastError;
  }

  /** Boot: check the site, install guards, start detection. */
  init(): void {
    if (this.disposed) return;

    this.siteCheck = detectSite(this.win);
    this.emitter.emit("site", this.siteCheck);

    if (this.siteCheck.verdict === "unknown") {
      this.log("warn", NOT_DETECTED_MESSAGE);
      this.setPhase("IDLE");
      // Keep a very slow poll so navigating to the site in the same tab works.
      this.startDetectionLoop(DETECT_POLL_INTERVAL * 4);
      return;
    }

    this.guards.install();
    this.startDetectionLoop(DETECT_POLL_INTERVAL);
    this.tryDetect();
    this.setPhase(this.phase === "IDLE" ? "DETECTING" : this.phase);
    this.log("info", `${this.siteCheck.message} — detection active`);
  }

  /** Start autoplay on the detected chart. */
  start(): void {
    if (this.disposed) return;
    if (!this.settingsManager.all.general.enabled) {
      this.log("warn", "Autoplay is disabled. Enable it in the Kismet panel first.");
      return;
    }

    if (this.phase === "RUNNING") return;
    if (this.phase === "PAUSED") {
      this.resume();
      return;
    }

    const detection = this.ensureDetected();
    if (!detection?.ok) {
      if (this.phase !== "ERROR") {
        this.setPendingStart("manual");
        this.setPhase("DETECTING");
        this.log("info", "Autoplay armed — waiting for a playable chart");
      } else {
        this.log("warn", detection?.reason ?? this.lastError);
      }
      return;
    }

    if (this.scheduler.isRunning) return;
    if (!this.isPlaying()) {
      this.setPhase("READY");
      this.setPendingStart("manual");
      this.log("info", "Autoplay armed — waiting for the song to start");
      return;
    }
    this.setPendingStart(null);

    try {
      this.buildTimeline();
    } catch (err) {
      this.fail(`Could not build the input timeline: ${(err as Error).message}`);
      return;
    }

    if (!this.timeline || this.timeline.actions.length === 0) {
      this.fail("The chart contains no playable objects.");
      return;
    }

    const settings = this.settingsManager.all;
    if (this.tapKeys?.code) this.pointer.setKeyCode(this.tapKeys.code);
    this.clock.hardReset();

    // Begin from wherever the playhead already is, so starting mid-song does
    // not fire every object that has already scrolled past.
    const now = this.chartTime();
    this.scheduler.setOptions(settings.timing.lookahead, settings.timing.spinThreshold);
    this.scheduler.setActionOffset(this.effectiveOffset(settings));
    this.scheduler.load(this.timeline.actions, now);
    this.scheduler.start();

    this.startPointerLoop();
    this.startStatsLoop();
    this.startStateMonitor();
    this.setPhase("RUNNING");
    this.emitCursorState();
    this.log(
      "info",
      `started — ${this.timeline.noteCount} objects, ${this.timeline.actions.length} actions, ` +
        `tap key ${this.tapKeys?.code ?? "?"}`,
    );
  }

  /** Pause: stop scheduling and moving, release the button, keep the position. */
  pause(): void {
    if (this.disposed || this.phase !== "RUNNING") return;
    this.pausedBySite = false;
    this.scheduler.pause();
    this.stopPointerLoop();
    const released = this.pointer.releaseAll();
    this.heldSince = null;
    this.setPhase("PAUSED");
    this.emitCursorState();
    this.log("info", `paused (released ${released ? "the tap key" : "nothing"}; position preserved)`);
  }

  /** Resume from the correct timing position. */
  resume(): void {
    if (this.disposed || this.phase !== "PAUSED" || !this.settingsManager.all.general.enabled) return;

    if (!this.isAlive()) {
      this.safeStop("Gameplay ended while paused");
      return;
    }
    if (this.chartChanged()) {
      // Rebind before honoring a resume if the site loaded a different play.
      this.pausedBySite = true;
      this.tryDetect();
      return;
    }
    if (!this.isPlaying()) {
      // The site is still paused or loading; resume once its clock runs again.
      this.pausedBySite = true;
      this.log("info", "waiting for the play to resume");
      return;
    }
    this.pausedBySite = false;

    this.clock.reset();
    const now = this.chartTime();
    this.scheduler.rebase(now);
    this.scheduler.resume();
    this.startPointerLoop();
    this.startStatsLoop();
    this.setPhase("RUNNING");
    this.log("info", `resumed at ${now.toFixed(1)}ms`);
  }

  /** Normal stop: release everything, clear the queue, stay detected. */
  stop(): void {
    if (this.disposed) return;
    this.setPendingStart(null);
    this.teardownRun("stopped");
    this.setPhase(this.chart ? "READY" : "DETECTING");
    this.log("info", "stopped");
  }

  /**
   * Emergency stop. Immediate, unconditional, and total: stop scheduling,
   * release the button, clear the queue, reset engine state.
   */
  emergencyStop(reason = "EMERGENCY STOP"): void {
    if (this.disposed) return;
    this.setPendingStart(null);
    this.teardownRun(reason);
    this.clock.hardReset();
    this.desyncCount = 0;
    this.pausedBySite = false;
    this.setPhase("IDLE");
    this.lastError = "";
    this.emitter.emit("phase", { phase: "IDLE", reason });
    this.log("warn", `${reason} — ${SAFE_STOP_MESSAGE}`);
    // Re-arm detection so the tool is usable again without a reload.
    this.startDetectionLoop(DETECT_POLL_INTERVAL);
  }

  /**
   * Combined timing shift, in ms.
   *
   * `offset` is the user's musical correction (negative = fire earlier).
   * `inputDelayCompensation` is subtracted for the same reason: a positive
   * compensation means "my input arrives late", so the action must be
   * scheduled earlier.
   */
  private effectiveOffset(settings: Settings): number {
    return settings.timing.offset - settings.timing.inputDelayCompensation;
  }

  /** Apply a settings change to the live engine. */
  applySettings(settings: Settings): void {
    const autoStartChanged = settings.general.autoStart !== this.lastAutoStart;
    this.lastAutoStart = settings.general.autoStart;
    if (!settings.general.enabled || (autoStartChanged && !settings.general.autoStart && this.pendingStart === "automatic")) {
      this.setPendingStart(null);
    }

    // The master switch is a real safety control, not a cosmetic toggle.
    if (!settings.general.enabled && (this.phase === "RUNNING" || this.phase === "PAUSED")) {
      this.stop();
      this.log("info", "autoplay disabled — tap key released");
    }

    this.scheduler.setOptions(settings.timing.lookahead, settings.timing.spinThreshold);
    const offset = this.effectiveOffset(settings);
    this.scheduler.setActionOffset(offset);

    if (this.tapKeys) {
      this.tapKeys = readTapKeys(this.game, settings.input.tapKey);
      if (this.tapKeys.code) this.pointer.setKeyCode(this.tapKeys.code);
    }

    const needsRebuild =
      (settings.input.tapHold !== undefined && this.lastTapHold !== settings.input.tapHold) ||
      humanizationSignature(settings) !== this.lastTimelineHumanization;

    if (needsRebuild && this.chart) {
      this.lastTimelineHumanization = humanizationSignature(settings);
      try {
        this.buildTimeline();
        if ((this.phase === "RUNNING" || this.phase === "PAUSED") && this.timeline) {
          // Reload from the current playhead so upcoming objects pick up the
          // new timing, including changes made while paused.
          this.scheduler.load(this.timeline.actions, this.chartTime());
          this.pointer.releaseAll();
          this.heldSince = null;
        }
        const rebuilt = this.timeline!;
        this.emitter.emit("timeline", {
          analysis: rebuilt.analysis,
          humanization: this.humanizationStats,
        });
      } catch (err) {
        this.log("error", `timeline rebuild failed: ${(err as Error).message}`);
      }
    }
  }

  /** Re-read the site's tap keybindings without restarting the run. */
  refreshMapping(): void {
    if (this.disposed) return;
    if (!this.game) {
      this.tryDetect();
      return;
    }
    this.tapKeys = readTapKeys(this.game, this.settingsManager.all.input.tapKey);
    if (this.tapKeys.code) this.pointer.setKeyCode(this.tapKeys.code);
    if (this.chart) {
      this.emitter.emit("detected", {
        chart: this.chart,
        tapKeys: this.tapKeys,
        analysis: this.timeline?.analysis ?? analyseChart(this.chart),
        via: this.detectedVia,
      });
    }
  }

  /** Full teardown: every listener, timer and held key. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownRun("disposed");
    this.guards.dispose();
    this.stopDetectionLoop();
    this.pointer.dispose();
    this.scheduler.dispose();
    this.emitter.dispose();
    this.settingsManager.dispose();
  }

  /* ----------------------------- detection ---------------------------- */

  private startDetectionLoop(interval: number): void {
    this.stopDetectionLoop();
    this.detectHandle = setInterval(() => this.tryDetect(), interval) as unknown as number;
  }

  private stopDetectionLoop(): void {
    if (this.detectHandle !== null) {
      clearInterval(this.detectHandle);
      this.detectHandle = null;
    }
  }

  /** Number of live timers, for diagnostics and teardown verification. */
  get activeTimerCount(): number {
    return (
      (this.detectHandle !== null ? 1 : 0) +
      (this.statsHandle !== null ? 1 : 0) +
      (this.monitorHandle !== null ? 1 : 0) +
      (this.pointerHandle !== null ? 1 : 0)
    );
  }

  private tryDetect(): void {
    if (this.disposed) return;

    // Re-check the site occasionally: navigation can change the verdict.
    if (!this.siteCheck || this.siteCheck.verdict === "unknown") {
      this.siteCheck = detectSite(this.win);
      this.emitter.emit("site", this.siteCheck);
      if (this.siteCheck.verdict === "unknown") return;
      this.guards.install();
    }

    const acquired = acquirePlayback(this.win);

    if (!acquired) {
      if (this.playback) {
        const reason = "Gameplay closed";
        this.setPendingStart(null);
        this.teardownRun(reason);
        this.playback = null;
        this.game = null;
        this.chart = null;
        this.timeline = null;
        this.tapKeys = null;
        this.lastChartSignature = "";
        this.lastQuickSignature = "";
        this.blocker = null;
        this.setPhase("DETECTING");
        this.emitter.emit("lost", { reason });
        this.log("info", reason);
      }
      return;
    }

    this.game = acquired.game;
    this.playback = acquired.playback;
    this.detectedVia = acquired.via;

    const settings = this.settingsManager.all;

    // Cheap path: same play, nothing to rebuild. This runs on every poll, so it
    // must not mirror the chart again.
    const quick = this.quickSignature(acquired.playback);
    if (this.chart && this.timeline && quick === this.lastQuickSignature && this.phase !== "DETECTING") {
      const blocker = playbackBlocker(this.game, this.playback);
      if (blocker !== this.blocker) this.setBlocker(blocker);
      if (this.phase === "ERROR" && !blocker) this.setPhase("READY");
      return;
    }

    const blocker = playbackBlocker(this.game, this.playback);
    const chart = buildChart(acquired.playback);

    if (blocker || !chart) {
      this.setPendingStart(null);
      if (this.phase === "RUNNING" || this.phase === "PAUSED") {
        this.safeStop(blocker ?? "Chart data missing");
      }
      this.chart = null;
      this.timeline = null;
      this.lastChartSignature = "";
      this.lastQuickSignature = "";
      this.blocker = blocker ?? "The play reports an empty chart.";
      this.lastError = this.blocker;
      this.setPhase("ERROR", this.blocker);
      this.log("warn", this.blocker);
      return;
    }

    const signatureChanged = chart.signature !== this.lastChartSignature;
    if (this.chart && signatureChanged && (this.phase === "RUNNING" || this.phase === "PAUSED")) {
      this.log("info", "A different beatmap was loaded — rebuilding the session");
      this.teardownRun("beatmap changed");
    }

    this.blocker = null;
    this.chart = chart;
    this.tapKeys = readTapKeys(this.game, settings.input.tapKey);
    if (this.tapKeys.code) this.pointer.setKeyCode(this.tapKeys.code);
    this.tapKeys = { ...this.tapKeys };
    this.lastChartSignature = chart.signature;
    this.lastQuickSignature = quick;
    this.lastError = "";
    this.clock.hardReset();

    try {
      this.buildTimeline();
    } catch (err) {
      this.fail(`Timeline build failed: ${(err as Error).message}`);
      return;
    }

    this.startStateMonitor();
    this.setPhase("READY");
    this.emitter.emit("detected", {
      chart,
      tapKeys: this.tapKeys,
      analysis: this.timeline!.analysis,
      via: acquired.via,
    });
    this.log(
      "info",
      `chart detected via ${acquired.via}: ${chart.noteCount} objects ` +
        `(${chart.circles}C/${chart.sliders}S/${chart.spinners}Sp), ${this.timeline!.actions.length} actions`,
    );

    if (this.pendingStart === "manual") this.maybeStartPending();
    else if (settings.general.enabled && settings.general.autoStart && !this.pendingStart) {
      this.setPendingStart("automatic");
      this.maybeStartPending();
    }
  }

  /** Signature cheap enough to compute on every poll. */
  private quickSignature(playback: SitePlayback): string {
    const hits = playback.hits;
    const first = hits[0];
    const last = hits[hits.length - 1];
    const meta = playback.track?.metadata;
    return [
      hits.length,
      Math.round(Number(first?.time) || 0),
      Math.round(Number(last?.endTime ?? last?.time) || 0),
      meta?.Title ?? "",
      meta?.Version ?? "",
    ].join("|");
  }

  private setBlocker(blocker: string | null): void {
    this.blocker = blocker;
    if (!blocker) return;
    this.lastError = blocker;
    this.setPhase("ERROR", blocker);
    this.log("warn", blocker);
  }

  private maybeStartPending(): void {
    if (!this.pendingStart || !this.settingsManager.all.general.enabled) return;
    if (this.phase !== "READY" || !this.blocker) {
      if (this.phase === "READY" && this.isPlaying()) this.start();
    }
  }

  private ensureDetected(): DetectionResult | null {
    if (this.chart && this.tapKeys && this.isAlive()) {
      return { ok: true, via: this.detectedVia, chart: this.chart, tapKeys: this.tapKeys };
    }
    this.tryDetect();
    if (!this.chart || !this.tapKeys || !this.isAlive() || this.phase === "ERROR") {
      return null;
    }
    return { ok: true, via: this.detectedVia, chart: this.chart, tapKeys: this.tapKeys };
  }

  private lastTapHold = -1;

  private buildTimeline(): void {
    if (!this.chart) throw new Error("no chart available");
    const settings = this.settingsManager.all;

    // Humanization is baked into the timeline rather than applied at fire time,
    // because it has to survive the ordering sort. A change to any of its
    // settings therefore requires a rebuild — see `applySettings`.
    this.humanizer = settings.humanization.enabled
      ? new Humanizer({
          config: settings.humanization,
          // Keep every humanised press inside the site's widest judgement
          // window, so variation can never turn into a miss.
          clampMs: Math.max(4, this.chart.windows.meh * 0.45),
        })
      : null;

    this.timeline = buildTimeline(this.chart, {
      humanizer: this.humanizer,
      tapHoldMs: settings.input.tapHold,
      // Offset is applied at *schedule* time rather than baked into the
      // timeline, so changing it mid-run takes effect immediately.
      offset: 0,
    });

    this.lastTimelineHumanization = humanizationSignature(settings);
    this.lastTapHold = settings.input.tapHold;

    if (this.humanizer) {
      const stats = this.humanizer.stats;
      this.log(
        "info",
        `humanization on · seed ${settings.humanization.seed} · strength ${settings.humanization.strength} · ` +
          `mean ${stats.meanMs.toFixed(2)}ms · sd ${stats.sdMs.toFixed(2)}ms · clamped ${stats.clamped}`,
      );
    }
  }

  /** Humanization statistics for the current timeline, or null when off. */
  get humanizationStats(): HumanizationStats | null {
    return this.humanizer?.stats ?? null;
  }

  /* ------------------------------- clock ------------------------------ */

  /** Current chart time in ms, straight from the site's own clock. */
  private chartTime(): number {
    if (this.playback) {
      const direct = siteTime(this.playback);
      if (direct !== null) return direct;
    }
    return this.clock.chartAt(performance.now());
  }

  /**
   * Predict the host time at which a chart time occurs.
   *
   * The timing offset is deliberately NOT applied here: the scheduler applies
   * it to the action's effective due time instead, so the armed-timer path and
   * the catch-up path agree.
   */
  private hostTimeForChart(chartTime: number): number {
    const now = performance.now();
    const predicted = this.clock.hostAt(chartTime);
    const state = this.clock.getState();
    if (!state.confident) {
      const lookahead = this.settingsManager.all.timing.lookahead;
      return Math.min(Math.max(predicted, now), now + lookahead * 2);
    }
    return predicted;
  }

  private onClockSample(host: number, chart: number): number | void {
    const discontinuity = this.clock.sample(host, chart);
    if (!discontinuity) return;

    this.log("info", `clock discontinuity at ${chart.toFixed(1)}ms — resyncing`);
    if (this.phase === "RUNNING") {
      // A seek can jump past the tail of a held slider. Releasing now is always
      // safe: the scheduler re-presses on the next object edge it reaches.
      if (this.pointer.isDown) {
        this.pointer.releaseAll();
        this.heldSince = null;
        this.emitCursorState();
      }
    }
    return chart;
  }

  /* ------------------------------- firing ----------------------------- */

  private onFire(actions: InputAction[], _hostNow: number, targetChartTime: number): void {
    if (this.phase !== "RUNNING") return;
    if (!this.settingsManager.all.general.enabled) {
      this.stop();
      return;
    }
    if (!this.isAlive()) {
      this.safeStop(this.blocker ?? "Gameplay ended");
      return;
    }
    if (this.chartChanged()) {
      this.pauseForSite();
      return;
    }
    if (!this.isPlaying()) {
      this.pauseForSite();
      return;
    }

    try {
      for (const action of actions) {
        if (action.type === "down") {
          // Position first: the site judges a click by the distance between its
          // cursor and the object at the instant the key event runs.
          this.pointer.moveTo(action.x, action.y);
          this.pointer.press();
          this.heldSince = action.time;
        } else {
          this.pointer.release();
          this.heldSince = null;
        }
      }
    } catch (err) {
      this.pointer.releaseAll();
      this.fail(`Input failure: ${(err as Error).message}`);
      return;
    }

    this.verifyAgainstSite();
    this.maybeEmitStats();
    this.emitCursorState();
    void targetChartTime;
  }

  /** Cross-check our held state against the site's own key flags. */
  private verifyAgainstSite(): void {
    const result = verifyInputState(this.game, this.pointer.isDown, this.pointer.code);
    if (result.ok) {
      this.desyncCount = 0;
      return;
    }
    this.desyncCount++;
    if (this.desyncCount >= Engine.DESYNC_LIMIT) {
      this.desyncCount = 0;
      this.pointer.releaseAll();
      this.fail(
        "Input state desynced from the game (the site disagrees about the tap key). " +
          "Its keybind may have changed — re-read the tap key and start again.",
      );
    }
  }

  private onOverrun(dropped: number, atChartTime: number, skipped: readonly InputAction[]): void {
    // A skipped batch may contain the release for a hold we already started.
    const hasRelease = skipped.some((action) => action.type === "up");
    if (hasRelease) {
      this.pointer.releaseAll();
      this.heldSince = null;
      this.emitCursorState();
    }
    this.log(
      "warn",
      `skipped ${dropped} overdue action(s) after a stall at ${atChartTime.toFixed(0)}ms; ` +
        `continued with the remaining chart`,
    );
    this.maybeEmitStats();
  }

  private onChartComplete(): void {
    this.pointer.releaseAll();
    this.heldSince = null;
    this.stopPointerLoop();
    this.stopStatsLoop();
    // The state monitor deliberately keeps running: the play can still fail or
    // be closed after the last object.
    this.emitStats(true);
    this.setPhase("READY");
    this.emitCursorState();
    this.log("info", "chart complete — every object played");
  }

  /* --------------------------- pointer loop --------------------------- */

  private startPointerLoop(): void {
    if (this.pointerHandle !== null || this.disposed) return;
    const step = (): void => {
      this.pointerHandle = null;
      if (this.disposed || this.phase !== "RUNNING") return;
      try {
        this.updateCursor();
      } catch (err) {
        this.log("error", `cursor update failed: ${String(err)}`);
      }
      this.pointerHandle = this.win.requestAnimationFrame(step);
    };
    this.pointerHandle = this.win.requestAnimationFrame(step);
  }

  private stopPointerLoop(): void {
    if (this.pointerHandle !== null) {
      this.win.cancelAnimationFrame(this.pointerHandle);
      this.pointerHandle = null;
    }
  }

  /**
   * One frame of cursor motion.
   *
   * Three cases, in priority order:
   *   1. Inside a slider  -> ride the slider ball's path.
   *   2. Inside a spinner -> orbit the centre so the site accumulates rotation.
   *   3. Otherwise        -> glide from the last object to the next one.
   */
  private updateCursor(): void {
    const chart = this.chart;
    if (!chart) return;
    const now = this.chartTime();
    const objects = chart.objects;

    const active = this.activeObject(objects, now);
    if (active) {
      if (active.kind === "slider") {
        const point = sliderPointAt(active, now - active.time);
        this.pointer.moveTo(point.x, point.y);
      } else if (active.kind === "spinner") {
        const rate = Math.max(0.5, this.settingsManager.all.input.spinRate);
        const elapsed = Math.max(0, now - active.time);
        const angle = (elapsed / 1000) * rate * Math.PI * 2;
        this.pointer.moveTo(
          active.x + SPIN_RADIUS * Math.cos(angle),
          active.y + SPIN_RADIUS * Math.sin(angle),
        );
      } else {
        this.pointer.moveTo(active.x, active.y);
      }
      return;
    }

    const nextIndex = lowerBound(objects, now, (object) => object.time);
    const next = objects[nextIndex];
    if (!next) return;

    const previous = nextIndex > 0 ? objects[nextIndex - 1] : null;
    const from = previous ? endPosition(previous) : { x: PLAYFIELD.width / 2, y: PLAYFIELD.height / 2 };
    const fromTime = previous
      ? Math.max(previous.endTime, next.time - MAX_GLIDE_MS)
      : next.time - MAX_GLIDE_MS;
    const span = Math.max(MIN_GLIDE_MS, next.time - fromTime);
    const raw = Math.min(1, Math.max(0, (now - fromTime) / span));
    // Ease in and out: a linear sweep reads as a machine, and a real player
    // arrives at the object with the cursor already settling.
    const t = 0.5 - Math.cos(Math.PI * raw) / 2;
    this.pointer.moveTo(
      from.x + (next.x - from.x) * t,
      from.y + (next.y - from.y) * t,
    );
  }

  /** The slider/spinner whose body contains `now`, if any. */
  private activeObject(objects: ChartObject[], now: number): ChartObject | null {
    const index = lowerBound(objects, now, (object) => object.time);
    for (let i = Math.min(index, objects.length - 1); i >= 0 && i >= index - 3; i--) {
      const object = objects[i];
      if (object.time > now) continue;
      if (object.endTime >= now) return object;
      // Objects are sequential in std: once one has ended, an earlier one
      // cannot still be active.
      break;
    }
    return null;
  }

  /* --------------------------- state monitor --------------------------- */

  private startStateMonitor(): void {
    this.stopStateMonitor();
    this.monitorHandle = setInterval(() => this.checkSiteState(), 100) as unknown as number;
  }

  private stopStateMonitor(): void {
    if (this.monitorHandle !== null) {
      clearInterval(this.monitorHandle);
      this.monitorHandle = null;
    }
  }

  private checkSiteState(): void {
    if (this.disposed) return;
    if (this.phase !== "RUNNING" && this.phase !== "PAUSED" && this.phase !== "READY") return;

    if (!this.isAlive()) {
      this.setPendingStart(null);
      if (this.phase === "READY") {
        // Not an error: the user finished the map or backed out. Drop the
        // stale play so the next one is detected fresh.
        this.pointer.releaseAll();
        this.heldSince = null;
        this.chart = null;
        this.timeline = null;
        this.tapKeys = null;
        this.playback = null;
        this.game = null;
        this.lastChartSignature = "";
        this.lastQuickSignature = "";
        this.setPhase("DETECTING");
        this.emitter.emit("lost", { reason: "Gameplay closed" });
      } else {
        this.safeStop(this.blocker ?? "Gameplay ended");
      }
      return;
    }

    const blocker = playbackBlocker(this.game, this.playback);
    if (blocker) {
      if (this.phase === "RUNNING" || this.phase === "PAUSED") this.safeStop(blocker);
      else this.setBlocker(blocker);
      return;
    }
    if (this.blocker) {
      this.blocker = null;
      this.lastError = "";
      this.setPhase("READY");
    }

    if (this.chartChanged()) {
      this.tryDetect();
      return;
    }

    // Keep the tap key in step with the site's own bindings.
    if (this.tapKeys && this.game) {
      const live = readTapKeys(this.game, this.settingsManager.all.input.tapKey);
      if (live.code !== this.tapKeys.code) {
        this.tapKeys = live;
        if (live.code) this.pointer.setKeyCode(live.code);
        this.emitCursorState();
        this.log("info", `tap key changed to ${live.code}`);
      }
    }

    const playing = this.isPlaying();
    if (this.phase === "RUNNING" && !playing) {
      this.pauseForSite();
    } else if (this.phase === "PAUSED" && this.pausedBySite && playing) {
      this.resume();
    } else if (this.phase === "READY" && this.pendingStart && playing) {
      this.maybeStartPending();
    }
  }

  /* ------------------------------- stats ------------------------------ */

  private startStatsLoop(): void {
    this.stopStatsLoop();
    this.statsHandle = setInterval(() => this.emitStats(false), 100) as unknown as number;
  }

  private stopStatsLoop(): void {
    if (this.statsHandle !== null) {
      clearInterval(this.statsHandle);
      this.statsHandle = null;
    }
  }

  private maybeEmitStats(): void {
    // The 100ms loop owns the readout; the firing path only nudges the panel.
    this.emitCursorState();
  }

  private emitStats(_force: boolean): void {
    if (!this.chart || !this.timeline) return;

    const chartTime = this.chartTime();
    const jitter = this.scheduler.getJitter();
    const remaining = notesRemainingAt(this.timeline.notePressTimes, chartTime);

    const stats = collectStats({
      playback: this.playback,
      objectsTotal: this.timeline.noteCount,
      objectsRemaining: remaining,
      taps: this.pointer.presses,
      timeElapsed: chartTime,
      lastJitter: jitter.last,
      avgJitter: jitter.avg,
      holding: this.pointer.isDown,
    });

    this.emitter.emit("stats", stats);
  }

  getStats(): EngineStats | null {
    if (!this.chart || !this.timeline) return null;
    const chartTime = this.chartTime();
    const jitter = this.scheduler.getJitter();
    return collectStats({
      playback: this.playback,
      objectsTotal: this.timeline.noteCount,
      objectsRemaining: notesRemainingAt(this.timeline.notePressTimes, chartTime),
      taps: this.pointer.presses,
      timeElapsed: chartTime,
      lastJitter: jitter.last,
      avgJitter: jitter.avg,
      holding: this.pointer.isDown,
    });
  }

  /** The next action that has not fired yet, for the debug readout. */
  getNextAction(): InputAction | null {
    if (!this.timeline) return null;
    const index = this.scheduler.cursorIndex;
    return this.timeline.actions[index] ?? null;
  }

  /** Index of the action at/after a chart time (binary search). */
  actionIndexAt(chartTime: number): number {
    if (!this.timeline) return 0;
    return lowerBound(this.timeline.actions, chartTime, (a) => a.time);
  }

  /* ------------------------------ teardown ---------------------------- */

  private isAlive(): boolean {
    if (!this.playback) return false;
    return playbackAlive(this.win, this.playback, this.game);
  }

  private isPlaying(): boolean {
    if (!this.playback) return false;
    if (!this.isAlive()) return false;
    return sitePlaying(this.playback);
  }

  private chartChanged(): boolean {
    if (!this.playback || !this.chart) return false;
    return this.quickSignature(this.playback) !== this.lastQuickSignature;
  }

  private pauseForSite(): void {
    if (this.phase !== "RUNNING") return;
    this.pausedBySite = true;
    this.scheduler.pause();
    this.stopPointerLoop();
    this.pointer.releaseAll();
    this.heldSince = null;
    this.setPhase("PAUSED");
    this.emitCursorState();
    this.log("info", "play paused by the site — input released");
  }

  /** Release input and pause, but keep the prepared chart. */
  private interrupt(reason: string): void {
    if (this.phase !== "RUNNING") return;
    this.pausedBySite = true;
    this.scheduler.pause();
    this.stopPointerLoop();
    this.pointer.releaseAll();
    this.heldSince = null;
    this.setPhase("PAUSED");
    this.emitCursorState();
    this.log("info", `${reason} — paused`);
  }

  private teardownRun(reason: string): void {
    this.stopPointerLoop();
    this.scheduler.stop();
    this.stopStatsLoop();
    this.pointer.releaseAll();
    this.heldSince = null;
    this.timeline = null;
    this.humanizer = null;
    this.desyncCount = 0;
    this.emitCursorState();
    void reason;
  }

  private setPhase(phase: EnginePhase, reason?: string): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emitter.emit("phase", { phase, reason });
  }

  private setPendingStart(pending: PendingStart): void {
    if (this.pendingStart === pending) return;
    this.pendingStart = pending;
    this.emitter.emit("pendingStart", { pending });
  }

  private fail(message: string): void {
    this.lastError = message;
    this.pointer.releaseAll();
    this.heldSince = null;
    this.scheduler.stop();
    this.stopPointerLoop();
    this.stopStatsLoop();
    this.setPhase("ERROR", message);
    this.log("warn", message);
  }

  private safeStop(reason: string): void {
    this.lastError = reason;
    this.teardownRun(reason);
    this.setPendingStart(null);
    this.setPhase("READY");
    this.log("warn", `${reason} — ${SAFE_STOP_MESSAGE}`);
    this.startStatsLoop();
  }

  private emitCursorState(): void {
    this.emitter.emit("cursorState", {
      holding: this.pointer.isDown,
      keyCode: this.tapKeys?.code ?? null,
    });
  }

  private log(level: "info" | "warn" | "error", message: string, data?: unknown): void {
    this.emitter.emit("log", { level, message, data });
  }

  getDiagnostics(): Record<string, unknown> {
    const clock = this.clock.getState();
    const jitter = this.scheduler.getJitter();
    const stats = this.getStats();
    return {
      phase: this.phase,
      pendingStart: this.pendingStart,
      via: this.detectedVia || null,
      site: this.siteCheck,
      blocker: this.blocker,
      chart: this.chart
        ? {
            label: this.chart.label ?? null,
            objects: this.chart.noteCount,
            circles: this.chart.circles,
            sliders: this.chart.sliders,
            spinners: this.chart.spinners,
            windows: this.chart.windows,
            difficulty: this.chart.difficulty,
            actions: this.timeline?.actions.length ?? 0,
            signature: this.chart.signature,
          }
        : null,
      tapKeys: this.tapKeys,
      clock: {
        slope: Number(clock.slope.toFixed(4)),
        errorMs: Number.isFinite(clock.error) ? Number(clock.error.toFixed(2)) : null,
        samples: clock.samples,
        confident: clock.confident,
      },
      scheduler: {
        cursor: this.scheduler.cursorIndex,
        total: this.scheduler.total,
        armed: this.scheduler.armedCount,
        fired: this.scheduler.firedCount,
        dropped: this.scheduler.droppedCount,
        jitter: { last: jitter.last, avg: jitter.avg },
      },
      input: {
        holding: this.pointer.isDown,
        moves: this.pointer.moves,
        presses: this.pointer.presses,
        releases: this.pointer.releases,
        suppressed: this.pointer.suppressed,
        failures: this.pointer.failures,
        maxMoveError: Number(this.pointer.maxMoveError.toFixed(2)),
        cursor: this.pointer.cursor,
      },
      humanization: this.humanizer?.stats ?? null,
      stats,
      siteState: this.describeSiteState(),
      lastError: this.lastError || null,
      timers: this.activeTimerCount,
    };
  }

  private describeSiteState(): string {
    if (!this.playback) return "no play";
    const parts: string[] = [];
    parts.push(this.isPlaying() ? "playing" : "not playing");
    if (this.playback.audioReady === false) parts.push("loading");
    if (this.playback.ended) parts.push("ended");
    if (this.game?.autoplay) parts.push("site autoplay on");
    return parts.join(" · ");
  }
}

/** Where a cursor leaves an object: the slider's tail, or the object itself. */
function endPosition(object: ChartObject): Point {
  if (object.kind === "slider" && object.path && object.path.length > 0) {
    return object.path[object.path.length - 1];
  }
  return { x: object.x, y: object.y };
}
