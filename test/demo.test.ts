import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsManager } from "../src/core/settings";
import { Engine } from "../src/engine/engine";
import { installDom, StubElement, type StubEnvironment } from "./helpers/domStub";

const here = dirname(fileURLToPath(import.meta.url));
const stubPath = resolve(here, "..", "demo", "stub-game.js");

let env: StubEnvironment;
let code: string;

beforeEach(async () => {
  code = await readFile(stubPath, "utf8");
  env = installDom({ start: 0 });
  env.globalsInstalled();
});

afterEach(() => {
  env.globalsRemoved();
});

/** A no-op 2d context: the demo only needs the calls not to throw. */
function fakeContext() {
  const gradient = { addColorStop() {} };
  return new Proxy(
    {
      createLinearGradient: () => gradient,
      measureText: () => ({ width: 10 }),
      setTransform() {},
      save() {},
      restore() {},
    },
    {
      get(target: Record<string, unknown>, key: string) {
        if (key in target) return target[key as keyof typeof target];
        return () => {};
      },
      set() {
        return true;
      },
    },
  );
}

function loadDemo(): any {
  // eslint-disable-next-line no-new-func
  new Function(code)();
  return env.window;
}

function mount(win: any, chart: string) {
  const canvas = new StubElement("canvas") as any;
  canvas.width = 1920;
  canvas.height = 1080;
  canvas.style = {};
  canvas.getContext = () => fakeContext();
  win.document.body.appendChild(canvas);
  const game = new win.StubGame(chart);
  game.mount(canvas);
  return game;
}

function run(ms: number, game: any, step = 8) {
  const target = env.now() + ms;
  while (env.now() < target) {
    env.advance(step);
    for (let i = 0; i < 4; i++) env.frame();
  }
  game.render();
}

describe("demo stub", () => {
  it("installs the site contract on window", () => {
    const win = loadDemo();
    assert.deepEqual(win.STUB_CHARTS, ["Warm Up [Easy]", "Stream [Hard]", "Jump Practice [Insane]"]);

    const game = mount(win, "Warm Up [Easy]");
    assert.ok(win.game && win.playback && win.gfx);
    assert.equal(win.game.scene, win.playback);
    assert.equal(win.playback.osu.audio, game.audio);
    assert.equal(typeof win.playback.osu.audio.getPosition(), "number");
    assert.equal(win.game.K1keycode, 90);
    assert.equal(win.game.K2keycode, 88);
    assert.equal(win.playback.hits.length, win.STUB_CHART_INFO["Warm Up [Easy]"].objects.length);
    assert.ok(win.gfx.width > 0 && win.gfx.height > 0);

    game.dispose();
    assert.equal(win.game, undefined);
    assert.equal(win.playback, undefined);
  });

  it("judges a trusted-looking click like the site", () => {
    const win = loadDemo();
    const game = mount(win, "Warm Up [Easy]");
    game.start();

    const first = win.playback.hits[0];
    // Move the cursor onto the first circle.
    env.window.dispatchEvent({
      type: "mousemove",
      clientX: win.gfx.xoffset + (first.x / 512) * win.gfx.width,
      clientY: win.gfx.yoffset + (first.y / 384) * win.gfx.height,
    });
    env.advance(first.time);
    env.window.dispatchEvent({ type: "keydown", keyCode: 90, repeat: false });
    env.window.dispatchEvent({ type: "keyup", keyCode: 90 });

    assert.equal(first.score, 300);
    assert.equal(win.game.scoreOverlay.judgecnt.great, 1);
    assert.equal(win.game.down, false);

    game.dispose();
  });

  it("awards a spinner only after enough rotation", () => {
    const win = loadDemo();
    const game = mount(win, "Warm Up [Easy]");
    game.start();

    const spinner = win.playback.hits.find((hit: any) => hit.type === "spinner");
    assert.ok(spinner);

    env.advance(spinner.time + 10);
    env.window.dispatchEvent({ type: "keydown", keyCode: 90, repeat: false });
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 3.2;
      env.window.dispatchEvent({
        type: "mousemove",
        clientX: win.gfx.xoffset + ((spinner.x + Math.cos(angle) * 45) / 512) * win.gfx.width,
        clientY: win.gfx.yoffset + ((spinner.y + Math.sin(angle) * 45) / 384) * win.gfx.height,
      });
      env.advance(16);
      game.updateSpinner();
      game.render();
    }
    env.window.dispatchEvent({ type: "keyup", keyCode: 90 });

    assert.equal(spinner.score, 300, "the spinner should score once the cursor has circled it");
    game.dispose();
  });

  it("plays the demo chart with the real engine", () => {
    const win = loadDemo();
    const game = mount(win, "Warm Up [Easy]");

    const settings = new SettingsManager("kismet:demo-test", env.window);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    assert.ok(engine.currentChart, "expected the engine to mirror the demo chart");

    game.start();
    env.advance(500);
    engine.start();
    assert.equal(engine.currentPhase, "RUNNING");

    run(9500, game);

    const counts = win.game.scoreOverlay.judgecnt;
    const played = countJudged(win.playback.hits);
    assert.equal(played, win.playback.hits.length, "every object should be judged by the end");
    assert.ok(counts.great >= 6, `greats: ${counts.great} (${win.playback.hits.map((h: any) => h.score)})`);
    assert.equal(counts.miss, 0, `misses: ${counts.miss} (${win.playback.hits.map((h: any) => h.score)})`);
    assert.equal(win.game.down, false);

    engine.dispose();
    game.dispose();
  });
});

function countJudged(hits: any[]): number {
  return hits.filter((hit) => hit.score >= 0).length;
}
