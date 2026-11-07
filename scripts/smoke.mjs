#!/usr/bin/env node
/**
 * Smoke test for the SHIPPED BUNDLE.
 *
 * The unit and integration tests exercise the TypeScript sources. This loads
 * `dist/kismet.js` — the exact bytes a user injects — into a stubbed browser
 * with a miniature webosu! installed, lets it bootstrap itself, and verifies
 * that its own chart, clock, scheduler and synthetic input actually play the
 * chart through the site's own listeners.
 *
 * Run: npm run smoke   (builds first)
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { installDom } = await import(pathToFileURL(resolve(root, "test/helpers/domStub.ts")).href);
const { createSite } = await import(pathToFileURL(resolve(root, "test/helpers/siteStub.ts")).href);

const env = installDom({ start: 0 });

/* ------------------------- browser API surface ------------------------- */

Object.assign(env.window, {
  MessageChannel: globalThis.MessageChannel,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
});

env.globalsInstalled();
globalThis.MessageChannel ??= globalThis.MessageChannel;

/* ------------------------------ fake site ------------------------------ */

const OBJECTS = [
  { type: "circle", x: 120, y: 120, time: 1000 },
  { type: "circle", x: 380, y: 260, time: 1400 },
  {
    type: "slider", x: 100, y: 300, time: 1800, endTime: 2400,
    sliderTime: 600, endX: 400, endY: 300,
  },
  { type: "circle", x: 256, y: 192, time: 2800 },
  { type: "spinner", x: 256, y: 192, time: 3200, endTime: 4400 },
  { type: "circle", x: 200, y: 200, time: 4800 },
];

const site = createSite(env, { objects: OBJECTS });

/* -------------------------------- run ---------------------------------- */

const results = [];
const check = (name, condition, detail = "") => {
  results.push({ name, ok: !!condition, detail });
};

const bundlePath = resolve(root, "dist/kismet.js");
const userscriptPath = resolve(root, "dist/kismet.user.js");
let code;
let userscriptCode = "";
try {
  code = await readFile(bundlePath, "utf8");
} catch {
  console.error(`\n  ✗ ${bundlePath} not found — run "npm run build" first.\n`);
  process.exit(1);
}
try {
  userscriptCode = await readFile(userscriptPath, "utf8");
} catch {
  // Reported as a failed check below so the rest of the smoke test still runs.
}

/* ---------------------------- artifact checks -------------------------- */

check("userscript artifact exists", userscriptCode.length > 0);
check("userscript is named Kismet", /@name\s+Kismet/.test(userscriptCode));
check(
  "userscript matches webosu-online.netlify.app",
  userscriptCode.includes("@match        https://webosu-online.netlify.app/*"),
);
check("userscript no longer matches the old mania hosts", !/webosumania|ashtonk/i.test(userscriptCode));
check(
  "userscript disclaims the site's built-in Autoplay",
  /never uses the site's built-in Autoplay mod/i.test(userscriptCode),
);
check("no legacy Keyfall branding ships", !/keyfall/i.test(userscriptCode) && !/keyfall/i.test(code));
check(
  "the UI prefers Torus over its rounded fallback",
  userscriptCode.includes('"Torus", "Torus Regular", "Torus-Regular", "Kismet Rounded"'),
);
check("trainer motion respects reduced-motion preferences", userscriptCode.includes("prefers-reduced-motion"));
check(
  "the fallback font is embedded with its license",
  userscriptCode.includes("data:font/woff2;base64,") && userscriptCode.includes("@license      MIT AND OFL-1.1"),
);

/* ------------------------------ bootstrap ------------------------------ */

env.window.localStorage.setItem(
  "kismet:settings:v2",
  JSON.stringify({ general: { showOverlay: true }, input: { hotkeys: { toggleUI: "KeyM" } } }),
);

try {
  // eslint-disable-next-line no-new-func
  new Function(code)();
  check("bundle evaluates without throwing", true);
} catch (err) {
  check("bundle evaluates without throwing", false, err?.message ?? String(err));
}

const api = env.window.Kismet;
check("exposes window.Kismet", !!api);

const keydown = (codeName, { trusted = true, repeat = false, ctrlKey = false } = {}) =>
  env.window.dispatchEvent({
    type: "keydown", code: codeName, isTrusted: trusted, repeat, ctrlKey,
    metaKey: false, altKey: false, bubbles: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.__propagationStopped = true; },
  });

if (api) {
  check("version is reported", typeof api.version === "string" && api.version.length > 0, api.version);

  const diag = api.diagnostics();
  check("site confirmed", diag.site?.verdict === "confirmed", JSON.stringify(diag.site));
  check("chart found through window.playback", diag.via === "window.playback", String(diag.via));
  check("chart mirrored", diag.chart?.objects === OBJECTS.length, JSON.stringify(diag.chart));
  check(
    "chart counts the object kinds",
    diag.chart?.circles === 4 && diag.chart?.sliders === 1 && diag.chart?.spinners === 1,
    JSON.stringify(diag.chart),
  );
  check("tap key read from the site", diag.tapKeys?.code === 90 && diag.tapKeys?.source === "site",
    JSON.stringify(diag.tapKeys));
  check("a timeline was scheduled", diag.chart?.actions > 0, String(diag.chart?.actions));

  const rootEl = api.overlayElement;
  check("overlay mounted", !!rootEl);
  check("panel starts hidden and inert despite a stored visible flag",
    api.uiVisible === false && rootEl?.dataset.open === "0" && rootEl?.inert === true);
  check("the panel shortcut is fixed to Right Shift",
    api.settings.all.input.hotkeys.toggleUI === "ShiftRight",
    String(api.settings.all.input.hotkeys.toggleUI));
  check("automatic starts are opt-in", api.settings.all.general.autoStart === false);

  keydown("KeyM");
  keydown("ShiftRight", { trusted: false });
  keydown("ShiftRight", { repeat: true });
  keydown("ShiftRight", { ctrlKey: true });
  check("only a trusted, unmodified Right Shift opens the panel", api.uiVisible === false);
  keydown("ShiftRight");
  check("trusted Right Shift opens the panel", api.uiVisible === true && rootEl?.dataset.open === "1");
  keydown("ShiftRight");
  check("trusted Right Shift closes it again", api.uiVisible === false);

  /* ------------------------------ playback ------------------------------ */

  site.playback.audioReady = false;
  api.start();
  check("start waits for the song", api.diagnostics().pendingStart === "manual" && api.phase === "READY",
    `${api.diagnostics().pendingStart} / ${api.phase}`);
  site.playback.audioReady = true;
  env.advance(200);
  check("the armed start runs once the song is ready", api.phase === "RUNNING", String(api.phase));

  const seen = [];
  env.window.addEventListener("keydown", (event) => seen.push({ type: "keydown", trusted: event.isTrusted }));
  env.window.addEventListener("keyup", (event) => seen.push({ type: "keyup", trusted: event.isTrusted }));

  site.setAudio(600);
  for (let now = 600; now <= 6400; now += 8) {
    env.advance(8);
    site.advanceAudio(8);
    for (let i = 0; i < 4; i++) env.frame();
  }

  check("the site's own Autoplay was never enabled", site.game.autoplay === false);
  check("every object was played", site.judged.length === OBJECTS.length,
    `${site.judged.length} of ${OBJECTS.length}`);
  const worst = site.judged.reduce((max, click) => Math.max(max, Math.abs(click.diff)), 0);
  check("clicks landed inside the 300 window", worst < 80, `worst ${worst}ms`);
  check("the slider was followed", site.sliderError < 12, `${site.sliderError.toFixed(2)}px`);
  check("nothing was left held", site.isDown() === false);
  check("all dispatched events were synthetic", seen.every((event) => event.trusted === false),
    `${seen.length} events`);
  check("presses and releases balance", seen.filter((e) => e.type === "keydown").length ===
    seen.filter((e) => e.type === "keyup").length, `${seen.length} events`);

  const after = api.diagnostics();
  check("scheduler fired its actions", after.scheduler?.fired > 0, String(after.scheduler?.fired));
  check("no actions were dropped", after.scheduler?.dropped === 0, String(after.scheduler?.dropped));
  check("the clock model converged", after.clock?.samples > 5, `${after.clock?.samples} samples`);
  check("no input failures", after.input?.failures === 0, String(after.input?.failures));
  check("humanization is off by default",
    after.humanization === null || after.humanization?.enabled === false,
    JSON.stringify(after.humanization));

  /* ------------------------- safety behaviours -------------------------- */

  api.emergencyStop();
  check("emergency stop returns to IDLE", api.phase === "IDLE", String(api.phase));
  check("emergency stop leaves nothing held", site.isDown() === false);

  site.game.autoplay = true;
  env.advance(1600);
  check("refuses to run while the site autoplays", api.phase === "ERROR", String(api.phase));
  api.start();
  check("start is refused under the site's autoplay", api.phase === "ERROR");
  site.game.autoplay = false;
  env.advance(1600);
  check("recovers once the site's autoplay is off", api.phase === "READY", String(api.phase));

  api.uninstall();
  check("uninstall removes the global", !env.window.Kismet);
  check("uninstall removes the overlay", !rootEl || !rootEl.isConnected);
}

/* ------------------------------- report -------------------------------- */

const failed = results.filter((r) => !r.ok);
console.log("");
console.log("  Bundle smoke test — dist/kismet.js");
console.log("  " + "─".repeat(62));
for (const r of results) {
  const mark = r.ok ? "✓" : "✗";
  const detail = r.detail ? `  (${r.detail})` : "";
  console.log(`  ${mark} ${r.name}${detail}`);
}
console.log("  " + "─".repeat(62));
console.log(`  ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.log("");
  console.log("  FAILED:");
  for (const f of failed) console.log(`    · ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
}
console.log("");

site.dispose();
env.globalsRemoved();
process.exit(failed.length > 0 ? 1 : 0);
