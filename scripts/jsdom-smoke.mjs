#!/usr/bin/env node
/**
 * Boot the SHIPPED bundle in a real DOM implementation (jsdom).
 *
 * `npm test` runs the TypeScript sources against a hand-written DOM stub, and
 * `npm run smoke` loads the bundle against the same stub. Both are fast but
 * fake: they cannot catch something that only breaks with a real `MouseEvent`,
 * a real `document`, real `localStorage` or a real propagation path.
 *
 * This does. It builds a page shaped like webosu! (same globals, same listeners
 * as js/playerActions.js), injects dist/kismet.js the way a userscript would,
 * and requires that a chart is detected and played.
 *
 * Run: npm run smoke:jsdom   (after npm run build)
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import("jsdom"));
} catch {
  console.error("\n  jsdom is not installed — run `npm install` first.\n");
  process.exit(1);
}

const code = await readFile(resolve(root, "dist", "kismet.js"), "utf8");
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

const virtualConsole = new VirtualConsole();
const logs = [];
virtualConsole.on("jsdomError", (error) => logs.push(`[jsdomError] ${error.message}`));
for (const level of ["info", "warn", "error"]) {
  virtualConsole.on(level, (...args) => logs.push(`[${level}] ${args.map(String).join(" ")}`));
}

const dom = new JSDOM(
  `<!doctype html><html><head><title>webosu!</title></head><body><canvas id="canvas"></canvas></body></html>`,
  {
    url: "https://webosu-online.netlify.app/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
    virtualConsole,
  },
);
const { window } = dom;

/* ----------------------------- the fake site ----------------------------- */

window.gfx = { width: 800, height: 600, xoffset: 100, yoffset: 50 };
window.app = { view: window.document.getElementById("canvas") };

const audio = { position: 0, getPosition() { return this.position; } };
const hits = [
  { type: "circle", x: 100, y: 100, time: 1000, endTime: 1000, score: -1 },
  { type: "circle", x: 300, y: 200, time: 1400, endTime: 1400, score: -1 },
  {
    type: "slider", x: 150, y: 300, time: 1800, endTime: 2400, score: -1,
    sliderTime: 600, sliderTimeTotal: 600, repeat: 1,
    curve: { pointAt: (t) => ({ x: 150 + 250 * t, y: 300 }) },
  },
];
const judged = [];
const playback = {
  hits,
  track: {
    metadata: { Title: "Song", Artist: "Artist", Version: "Hard" },
    difficulty: { OverallDifficulty: 8, ApproachRate: 9, CircleSize: 4, HPDrainRate: 5 },
  },
  osu: { audio },
  GreatTime: 32, GoodTime: 76, MehTime: 120,
  audioReady: true, ended: false, offset: 0,
  scoreOverlay: { judgecnt: { great: 0, good: 0, meh: 0, miss: 0 }, judgeTotal: 0, maxJudgeTotal: 0, combo: 0, score: 0 },
};
const game = {
  scene: playback, window, mouseX: 256, mouseY: 192, down: false,
  K1keycode: 90, K2keycode: 88, K1down: false, K2down: false,
  allowMouseButton: false, autoplay: false,
};
playback.game = game;
window.playback = playback;
window.game = game;

// js/playerActions.js: mousemove updates the game cursor from client space.
window.addEventListener("mousemove", (event) => {
  game.mouseX = ((event.clientX - window.gfx.xoffset) / window.gfx.width) * 512;
  game.mouseY = ((event.clientY - window.gfx.yoffset) / window.gfx.height) * 384;
});

function judgeClick() {
  const now = audio.position * 1000;
  for (const hit of hits) {
    if (hit.score >= 0 || hit.type === "slider") continue;
    const diff = now - hit.time;
    if (Math.abs(diff) >= 120) continue;
    if (Math.hypot(game.mouseX - hit.x, game.mouseY - hit.y) > 20) continue;
    hit.score = Math.abs(diff) < 32 ? 300 : 100;
    judged.push({ index: hits.indexOf(hit), diff, points: hit.score });
    return;
  }
}

window.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  if (event.keyCode === game.K1keycode) { if (game.K1down) return; game.K1down = true; }
  else if (event.keyCode === game.K2keycode) { if (game.K2down) return; game.K2down = true; }
  else return;
  game.down = true;
  judgeClick();
});
window.addEventListener("keyup", (event) => {
  if (event.keyCode === game.K1keycode) game.K1down = false;
  else if (event.keyCode === game.K2keycode) game.K2down = false;
  else return;
  game.down = game.K1down || game.K2down;
});

/* ------------------------------ inject ---------------------------------- */

try {
  window.eval(code);
  check("the bundle evaluates in a real DOM", true);
} catch (error) {
  check("the bundle evaluates in a real DOM", false, error?.message ?? String(error));
}

/** Wait for a condition instead of assuming a fixed delay. */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

const booted = await waitFor(() => !!window.Kismet);

const api = window.Kismet;
check("exposes window.Kismet", booted && !!api, booted ? "" : "boot did not happen within 5s");
check("logs where it booted", logs.some((line) => line.includes("[Kismet] v") && line.includes("webosu-online.netlify.app")));

if (api) {
  const report = api.report();
  check("report() describes the page", report.globals.game && report.globals.playback && report.globals.gfx);
  check("site confirmed", report.site?.verdict === "confirmed", JSON.stringify(report.site));
  check("chart detected", report.chart?.objects === hits.length, JSON.stringify(report.chart?.objects));
  check("overlay mounted and hidden", report.overlay.mounted && report.overlay.visible === false);

  // jsdom events are always `isTrusted: false`, and the panel deliberately
  // refuses untrusted input, so the Right Shift path cannot be exercised here.
  // `test/overlay.test.ts` covers it with a stub that can fake trust.
  check("the panel refuses untrusted input", (() => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { code: "ShiftRight", bubbles: true }));
    return api.uiVisible === false;
  })());

  api.start();
  check("starts", api.phase === "RUNNING", String(api.phase));

  for (let i = 0; i < 210; i++) {
    await new Promise((resolve) => setTimeout(resolve, 16));
    audio.position += 0.016;
  }

  check("clicks reached the site's own handler", judged.length === 2, JSON.stringify(judged));
  check("clicks were on time", judged.every((click) => Math.abs(click.diff) < 60), JSON.stringify(judged));
  check("nothing left held", game.down === false);
  check("the site's autoplay stayed off", game.autoplay === false);
}

/* ------------------------------- report --------------------------------- */

const failed = results.filter((result) => !result.ok);
console.log("");
console.log("  jsdom smoke test — dist/kismet.js in a real DOM");
console.log("  " + "─".repeat(62));
for (const result of results) {
  console.log(`  ${result.ok ? "✓" : "✗"} ${result.name}${result.detail ? `  (${result.detail})` : ""}`);
}
console.log("  " + "─".repeat(62));
console.log(`  ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.log("\n  console output:");
  for (const line of logs.slice(0, 30)) console.log(`    ${line}`);
}
console.log("");

window.close();
process.exit(failed.length > 0 ? 1 : 0);
