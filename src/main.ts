import { NAME, VERSION } from "./constants";
import { SettingsManager } from "./core/settings";
import { Engine, SAFE_STOP_MESSAGE } from "./engine/engine";
import { NOT_DETECTED_MESSAGE } from "./detect/siteDetection";
import { HotkeyManager } from "./hotkeys";
import { Overlay } from "./ui/overlay";
import { ensureStyle } from "./ui/styles";
import { formatTime, humanizeCode } from "./util/helpers";
import type { EngineStats, HotkeyAction } from "./types";

/**
 * Entry point.
 *
 * Wires detection, engine, overlay and hotkeys together, and exposes a small
 * console API for manual control and diagnostics:
 *
 *   window.Kismet.start()
 *   window.Kismet.stop()
 *   window.Kismet.diagnostics()
 *   window.Kismet.uninstall()
 */

const GLOBAL_NAME = "Kismet";
const INSTANCE_FLAG = "__kismetInstalled__";

interface Bootstrapped {
  engine: Engine;
  overlay: Overlay | null;
  settings: SettingsManager;
  hotkeys: HotkeyManager;
  uninstall: () => void;
}

function boot(win: Window): Bootstrapped | null {
  // Guard against double injection (bookmarklet pressed twice, userscript
  // re-run after navigation, etc.).
  if ((win as any)[INSTANCE_FLAG]) {
    console.warn(`[${NAME}] already running — use ${GLOBAL_NAME}.uninstall() first`);
    return (win as any)[INSTANCE_FLAG] as Bootstrapped;
  }

  const settings = new SettingsManager(undefined, win);
  const engine = new Engine({ settings, win });

  ensureStyle(win.document, settings.all.appearance.accent);

  let overlay: Overlay | null = null;
  let lastStats: EngineStats | null = null;

  /* ------------------------------ overlay ------------------------------ */

  function mountOverlay(): void {
    if (overlay) return;
    overlay = new Overlay(
      {
        onStart: () => engine.start(),
        onPause: () => (engine.currentPhase === "PAUSED" ? engine.resume() : engine.pause()),
        onStop: () => engine.stop(),
        onEmergency: () => engine.emergencyStop("EMERGENCY STOP (button)"),
        onSettingChange: (next) => engine.applySettings(next),
        onRebindMapping: () => engine.refreshMapping(),
        getDiagnostics: () => engine.getDiagnostics(),
        getHumanizationStats: () => engine.humanizationStats,
      },
      settings,
    );
    win.document.documentElement.appendChild(overlay.root);
  }

  function unmountOverlay(): void {
    overlay?.dispose();
    overlay = null;
  }

  /* ------------------------------ hotkeys ------------------------------ */

  let reportedCollision = "";
  const hotkeys = new HotkeyManager({
    onAction: (action: HotkeyAction) => {
      switch (action) {
        case "toggleUI": {
          // Visibility is transient: the panel always starts hidden, and only
          // a trusted Right Shift press reaches this action.
          if (overlay) overlay.setVisible(!overlay.isVisible);
          break;
        }
        case "start":
          engine.start();
          break;
        case "pause":
          if (engine.currentPhase === "PAUSED") engine.resume();
          else engine.pause();
          break;
        case "stop":
          engine.stop();
          break;
        case "emergency":
          engine.emergencyStop("EMERGENCY STOP");
          break;
      }
    },
    getSiteCodes: () => {
      // The site's tap keys are real keyboard input from its point of view, so
      // an action hotkey that shares one would fire on every click. Report the
      // collision rather than silently double-binding the key.
      const taps = engine.currentTapKeys;
      const codes = [taps?.primary, taps?.secondary]
        .filter((code): code is number => typeof code === "number" && Number.isFinite(code))
        .map((code) => `Key${String.fromCharCode(code).toUpperCase()}`);
      return codes;
    },
    isCapturing: () => overlay?.isCapturing ?? false,
    onCollision: (collisions) => {
      const list = collisions.map((c) => `${c.action}=${humanizeCode(c.code)}`).join(", ");
      if (!list) {
        reportedCollision = "";
        overlay?.clearNotice("hotkey-collision");
        return;
      }
      const tip = collisions.some((collision) => collision.action === "toggleUI")
        ? "Right Shift is fixed; change that binding in the site."
        : "Change the action keys in More! → Input.";
      if (list !== reportedCollision) console.warn(`[${NAME}] hotkey collision with the site's tap keys: ${list}. ${tip}`);
      reportedCollision = list;
      overlay?.setNotice("warn", `Hotkey collision with the site's tap keys: ${list}. ${tip}`, "hotkey-collision");
    },
  });

  hotkeys.apply(settings.all);
  hotkeys.install();

  /* ------------------------------ wiring ------------------------------- */

  const offs: Array<() => void> = [];

  offs.push(
    engine.on("phase", ({ phase, reason }) => {
      overlay?.setPhase(phase, reason);
      if (settings.all.general.debug) {
        overlay?.logDebug(phase === "ERROR" ? "error" : "info", `phase -> ${phase}${reason ? ` (${reason})` : ""}`);
      }
      if (phase === "ERROR") {
        console.warn(`[${NAME}] ${reason ?? ""} ${SAFE_STOP_MESSAGE}`.trim());
      }
    }),
  );

  offs.push(
    engine.on("pendingStart", ({ pending }) => overlay?.setPendingStart(pending !== null)),
  );

  offs.push(
    engine.on("site", (check) => {
      if (check.verdict === "unknown") {
        // Keep the notice ready in the hidden panel without opening it.
        overlay?.setPhase("IDLE");
        overlay?.setChart(null, null, null);
        overlay?.setNotice("error", NOT_DETECTED_MESSAGE);
        console.info(`[${NAME}] ${NOT_DETECTED_MESSAGE}`);
      } else if (check.verdict === "probable") {
        overlay?.setNotice("warn", check.message);
      } else {
        overlay?.clearNotice();
      }
    }),
  );

  offs.push(
    engine.on("detected", ({ chart, tapKeys, analysis, via }) => {
      overlay?.setChart(chart, analysis, tapKeys);
      overlay?.clearNotice();
      if (tapKeys.source === "fallback") {
        overlay?.setNotice("warn", "Using a fallback tap key. Check the site's Input settings and re-read the key.");
      }
      if (settings.all.general.debug) {
        overlay?.logDebug("info", `chart detected via ${via}`);
        overlay?.logDebug(
          "info",
          `${chart.noteCount} objects · ${chart.circles} circles · ${chart.sliders} sliders · ${chart.spinners} spinners`,
        );
        overlay?.logDebug(
          "info",
          `tap key ${tapKeys.code ?? "?"} (${tapKeys.active}, ${tapKeys.source}) · windows ${chart.windows.great.toFixed(0)}/${chart.windows.good.toFixed(0)}/${chart.windows.meh.toFixed(0)}ms`,
        );
      }
      hotkeys.apply(settings.all); // re-check collisions now that codes are known
    }),
  );

  offs.push(
    engine.on("timeline", ({ analysis, humanization }) => {
      overlay?.setAnalysis(analysis);
      overlay?.refreshHumanization();
      if (overlay && settings.all.general.debug) {
        overlay.logDebug(
          "info",
          humanization
            ? `timeline rebuilt with humanization: mean ${humanization.meanMs.toFixed(2)}ms, ` +
                `sd ${humanization.sdMs.toFixed(2)}ms, ${humanization.clamped} clamped`
            : "timeline rebuilt: humanization off, timing frame-exact",
        );
        overlay.logDebug("info", `patterns: ${analysis.longestStream} longest stream, peak ${analysis.peakNps} NPS`);
      }
    }),
  );

  offs.push(
    engine.on("lost", ({ reason }) => {
      overlay?.setChart(null, null, null);
      overlay?.setNotice("warn", reason);
      if (settings.all.general.debug) overlay?.logDebug("warn", reason);
    }),
  );

  offs.push(
    engine.on("stats", (stats) => {
      lastStats = stats;
      overlay?.setStats(stats);
      if (settings.all.general.debug) updateDebugSnapshot();
    }),
  );

  offs.push(
    engine.on("cursorState", ({ holding, keyCode }) => {
      overlay?.setHolding(holding, keyCode);
    }),
  );

  offs.push(
    engine.on("log", ({ level, message }) => {
      if (settings.all.general.debug) overlay?.logDebug(level, message);
    }),
  );

  offs.push(settings.onChange(() => hotkeys.apply(settings.all)));

  /** Refresh the structured `[DEBUG]` snapshot, throttled by the stats loop. */
  let debugThrottle = 0;
  function updateDebugSnapshot(): void {
    const now = performance.now();
    if (now - debugThrottle < 200) return;
    debugThrottle = now;

    if (!overlay) return;
    const diagnostics = engine.getDiagnostics() as Record<string, any>;
    const next = engine.getNextAction();
    diagnostics.stats = {
      ...(lastStats ?? {}),
      timeElapsed: lastStats?.timeElapsed ?? diagnostics.stats?.timeElapsed,
      nextObject: next ? formatTime(next.time) : "—",
      nextAction: next ? `${next.type.toUpperCase()} @ ${next.x.toFixed(0)},${next.y.toFixed(0)}` : "—",
    };
    overlay.setDebugSnapshot(overlay.buildDebugSnapshot(diagnostics));
  }

  /* ------------------------------- boot -------------------------------- */

  // The panel is mounted hidden so it can keep receiving chart/status updates
  // before the first Right Shift press, and never flashes on a fresh page.
  mountOverlay();
  engine.init();

  const uninstall = (): void => {
    try {
      engine.emergencyStop("uninstall");
    } catch {
      /* best effort */
    }
    for (const off of offs.splice(0)) {
      try {
        off();
      } catch {
        /* already gone */
      }
    }
    hotkeys.dispose();
    unmountOverlay();
    engine.dispose();
    delete (win as any)[INSTANCE_FLAG];
    delete (win as any)[GLOBAL_NAME];
    console.info(`[${NAME}] uninstalled`);
  };

  const api = {
    engine,
    overlay: null as Overlay | null,
    settings,
    hotkeys,
    uninstall,
    /* convenience surface for the console */
    version: VERSION,
    start: () => engine.start(),
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    stop: () => engine.stop(),
    emergencyStop: () => engine.emergencyStop("EMERGENCY STOP (console)"),
    diagnostics: () => engine.getDiagnostics(),
    /**
     * Everything needed to explain a run that is not working, in a shape that
     * survives a copy-paste out of DevTools. `Kismet.report()` in the console.
     */
    report: () => {
      const diagnostics = engine.getDiagnostics() as Record<string, any>;
      const win = window as unknown as Record<string, unknown>;
      return {
        tool: `${NAME} v${VERSION}`,
        url: location.href,
        frame: window.top === window.self ? "top" : "child",
        globals: {
          game: !!win.game,
          playback: !!win.playback,
          gfx: !!win.gfx,
          app: !!win.app,
          scene: !!(win.game as { scene?: unknown } | undefined)?.scene,
        },
        phase: diagnostics.phase,
        pendingStart: diagnostics.pendingStart,
        site: diagnostics.site,
        via: diagnostics.via,
        blocker: diagnostics.blocker,
        chart: diagnostics.chart,
        tapKeys: diagnostics.tapKeys,
        siteState: diagnostics.siteState,
        lastError: diagnostics.lastError,
        overlay: { mounted: !!overlay?.root?.isConnected, visible: overlay?.isVisible ?? false },
      };
    },
    stats: () => engine.getStats(),
    get phase() {
      return engine.currentPhase;
    },
    get chart() {
      return engine.currentChart;
    },
    get tapKeys() {
      return engine.currentTapKeys;
    },
    get overlayElement() {
      return overlay?.root ?? null;
    },
    get uiVisible() {
      return overlay?.isVisible ?? false;
    },
    setDebug: (on: boolean) => settings.set("general.debug", !!on),
    setOffset: (ms: number) => settings.set("timing.offset", ms),
    resetSettings: () => settings.reset(),
  };

  // Keep `api.overlay` live for console users.
  Object.defineProperty(api, "overlay", { get: () => overlay, enumerable: true });

  (win as any)[GLOBAL_NAME] = api;
  (win as any)[INSTANCE_FLAG] = api;

  console.info(
    `%c${NAME}%c v${VERSION} ready — ${settings.all.input.hotkeys.toggleUI} toggles the UI, ` +
      `${settings.all.input.hotkeys.emergency} emergency-stops. Console API: ${GLOBAL_NAME}`,
    "color:#ff6b9d;font-weight:700",
    "color:inherit",
  );

  return api as unknown as Bootstrapped;
}

/* ------------------------------- bootstrap ------------------------------ */

function main(): void {
  try {
    // Unconditional, first line: if this never appears, the script is not
    // running on this page at all (not installed, or not matched).
    let where = "unknown page";
    try {
      where = window.location?.href ?? where;
      if (window.top !== window.self) where += " (inside a frame)";
    } catch {
      /* cross-origin frame: the URL is not readable, which is fine */
    }
    console.info(`[${NAME}] v${VERSION} booting on ${where}`);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => boot(window), { once: true });
    } else {
      boot(window);
    }
  } catch (err) {
    // Never let the tool take the page down with it.
    console.error(`[${NAME}] failed to start`, err);
    try {
      const note = document.createElement("div");
      note.textContent = `${NAME} failed to start. ${SAFE_STOP_MESSAGE}`;
      note.style.cssText =
        "position:fixed;top:12px;left:12px;z-index:2147483000;background:#101117;color:#ffd7de;" +
        "border:1px solid rgba(255,84,112,.5);border-radius:10px;padding:10px 12px;font:12px system-ui,sans-serif";
      document.documentElement.appendChild(note);
      setTimeout(() => note.remove(), 12000);
    } catch {
      /* nothing else we can do */
    }
  }
}

main();
