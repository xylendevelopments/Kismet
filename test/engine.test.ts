import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SettingsManager } from "../src/core/settings";
import { Engine } from "../src/engine/engine";
import { installDom, type StubEnvironment } from "./helpers/domStub";
import { createSite, type FakeObject, type FakeSite } from "./helpers/siteStub";

let env: StubEnvironment;

beforeEach(() => {
  env = installDom({ start: 0 });
  env.globalsInstalled();
});

afterEach(() => {
  env.globalsRemoved();
});

interface Rig {
  engine: Engine;
  settings: SettingsManager;
  site: FakeSite;
}

function rig(objects: FakeObject[], options: { autoplay?: boolean } = {}): Rig {
  const site = createSite(env, { objects, autoplay: options.autoplay });
  const settings = new SettingsManager("kismet:test", env.window);
  const engine = new Engine({ settings, win: env.window });
  engine.init();
  return { engine, settings, site };
}

/** Advance the fake host clock and the site's audio clock together. */
function run(site: FakeSite, fromMs: number, toMs: number, step = 8): void {
  site.setAudio(fromMs);
  let now = fromMs;
  while (now < toMs) {
    env.advance(step);
    site.advanceAudio(step);
    now += step;
    // The scheduler and the pointer loop each own a frame callback.
    for (let i = 0; i < 4; i++) env.frame();
  }
}

describe("Engine: playing", () => {
  it("clicks a circle on time and only once", () => {
    const { engine, site } = rig([
      { type: "circle", x: 100, y: 100, time: 1000 },
      { type: "circle", x: 300, y: 200, time: 1400 },
    ]);

    engine.start();
    assert.equal(engine.currentPhase, "RUNNING");

    run(site, 900, 1600);

    assert.equal(site.judged.length, 2, "expected both circles to be judged by the site");
    for (const click of site.judged) {
      assert.ok(Math.abs(click.diff) <= 16, `click was ${click.diff}ms off`);
      assert.equal(click.points, 300);
    }
    assert.equal(site.keys.filter((key) => key.type === "keydown").length, 2);
    assert.equal(site.keys.filter((key) => key.type === "keyup").length, 2);
    assert.equal(engine.currentPhase, "READY", "the chart should be complete");

    engine.dispose();
  });

  it("moves the cursor onto the object before pressing", () => {
    const { engine, site } = rig([{ type: "circle", x: 400, y: 300, time: 1000 }]);
    engine.start();
    run(site, 900, 1300);

    const pressIndex = site.keys.findIndex((key) => key.type === "keydown");
    assert.ok(pressIndex >= 0);
    const pressTime = site.keys[pressIndex].time;
    const move = [...site.moves].reverse().find((entry) => entry.time <= pressTime);
    assert.ok(move, "expected a move before the press");
    assert.ok(Math.hypot(move!.x - 400, move!.y - 300) < 1, "cursor should be on the object when it presses");

    engine.dispose();
  });

  it("holds a slider down for its whole body and follows the ball", () => {
    const { engine, site } = rig([
      {
        type: "slider", x: 100, y: 100, time: 1000, endTime: 1600,
        sliderTime: 600, endX: 400, endY: 300,
      },
    ]);

    engine.start();
    run(site, 900, 1900);

    const down = site.keys.find((key) => key.type === "keydown");
    const up = site.keys.find((key) => key.type === "keyup");
    assert.ok(down && up);
    assert.ok(up!.time - down!.time > 500, `held for ${up!.time - down!.time}ms, expected the slider body`);
    assert.ok(site.sliderError < 12, `worst distance from the ball was ${site.sliderError}px`);
    assert.equal(site.isDown(), false);

    engine.dispose();
  });

  it("orbits a spinner so the site accumulates rotation", () => {
    const { engine, site } = rig([
      { type: "spinner", x: 256, y: 192, time: 1000, endTime: 2000 },
    ]);

    engine.start();
    run(site, 900, 2200);

    const during = site.moves.filter((move) => move.time > 1100 && move.time < 1900);
    assert.ok(during.length > 20, "expected continuous cursor movement during the spin");
    const radii = during.map((move) => Math.hypot(move.x - 256, move.y - 192));
    assert.ok(Math.min(...radii) > 40, "cursor should stay on the spin orbit");
    assert.ok(Math.max(...radii) < 80);

    // Sum the signed angle swept, which is what the site integrates.
    let swept = 0;
    for (let i = 1; i < during.length; i++) {
      const a = Math.atan2(during[i - 1].y - 192, during[i - 1].x - 256);
      const b = Math.atan2(during[i].y - 192, during[i].x - 256);
      let delta = b - a;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      swept += Math.abs(delta);
    }
    assert.ok(swept > Math.PI * 4, `only swept ${swept.toFixed(2)} rad`);

    engine.dispose();
  });

  it("plays a whole short chart without missing", () => {
    const objects: FakeObject[] = [];
    for (let i = 0; i < 20; i++) {
      const time = 1000 + i * 250;
      objects.push(
        i % 5 === 4
          ? { type: "slider", x: 80 + i * 10, y: 120, time, endTime: time + 180, sliderTime: 180, endX: 300, endY: 250 }
          : { type: "circle", x: 60 + ((i * 73) % 400), y: 60 + ((i * 137) % 260), time },
      );
    }
    const { engine, site } = rig(objects);
    site.setAudio(800);
    engine.start();
    run(site, 800, 1000 + 20 * 250 + 300);

    assert.equal(site.judged.length, 20, `${site.judged.length} of 20 objects were judged`);
    for (const click of site.judged) {
      assert.ok(Math.abs(click.diff) <= 20, `object ${click.objectIndex} was ${click.diff}ms off`);
    }
    engine.dispose();
  });
});

describe("Engine: safety", () => {
  it("refuses to run while the site's own Autoplay mod is on", () => {
    const { engine, site } = rig([{ type: "circle", x: 100, y: 100, time: 1000 }], { autoplay: true });
    assert.equal(engine.currentPhase, "ERROR");
    assert.match(String(engine.lastErrorMessage), /Autoplay/);

    engine.start();
    run(site, 900, 1400);
    assert.equal(site.keys.length, 0, "must not dispatch input while the site is autoplaying");
    assert.equal(engine.currentPhase, "ERROR");

    engine.dispose();
  });

  it("waits for the song instead of clicking into a loading play", () => {
    const { engine, site } = rig([{ type: "circle", x: 100, y: 100, time: 1000 }]);
    site.playback.audioReady = false;
    engine.start();
    assert.equal(engine.currentPhase, "READY");
    run(site, 900, 1400);
    assert.equal(site.keys.length, 0);

    engine.dispose();
  });

  it("pauses and releases when the site pauses", () => {
    const { engine, site } = rig([
      { type: "slider", x: 100, y: 100, time: 1000, endTime: 3000, sliderTime: 2000, endX: 200, endY: 200 },
    ]);
    engine.start();
    run(site, 900, 1200);
    assert.equal(site.isDown(), true, "expected the slider to be held");

    site.playback.osu.audio.playing = false;
    env.advance(150);
    assert.equal(site.isDown(), false, "the tap key must be released on pause");
    assert.equal(engine.currentPhase, "PAUSED");

    site.playback.osu.audio.playing = true;
    env.advance(150);
    assert.equal(engine.currentPhase, "RUNNING", "expected to resume with the site");

    engine.dispose();
  });

  it("releases on stop and on emergency stop", () => {
    const { engine, site } = rig([
      { type: "slider", x: 100, y: 100, time: 1000, endTime: 5000, sliderTime: 4000, endX: 200, endY: 200 },
    ]);
    engine.start();
    run(site, 900, 1200);
    assert.equal(site.isDown(), true);

    engine.stop();
    assert.equal(site.isDown(), false);
    assert.equal(engine.currentPhase, "READY");

    engine.start();
    run(site, 1200, 1400);
    engine.emergencyStop("test");
    assert.equal(site.isDown(), false);
    assert.equal(engine.currentPhase, "IDLE");

    engine.dispose();
  });

  it("stops cleanly when gameplay closes", () => {
    const { engine, site } = rig([
      { type: "slider", x: 100, y: 100, time: 1000, endTime: 5000, sliderTime: 4000, endX: 200, endY: 200 },
    ]);
    engine.start();
    run(site, 900, 1200);
    assert.equal(site.isDown(), true);

    site.playback.ended = true;
    env.advance(150);
    assert.equal(site.isDown(), false);
    assert.equal(engine.currentPhase, "READY");

    engine.dispose();
  });

  it("re-reads the site's tap key when it changes mid-play", () => {
    const { engine, site } = rig([
      { type: "circle", x: 100, y: 100, time: 1000 },
      { type: "circle", x: 300, y: 200, time: 3000 },
    ]);
    engine.start();
    run(site, 900, 1200);

    // The player rebinds their tap key during the play.
    site.game.K1keycode = 65;
    site.game.K1down = false;
    env.advance(200);
    run(site, 1200, 3400);

    assert.equal(site.keys.filter((key) => key.keyCode === 65).length, 2, "expected the new tap key to be used");
    assert.equal(site.judged.length, 2);

    engine.dispose();
  });
});

describe("Engine: detection", () => {
  it("mirrors the chart and exposes it for the panel", () => {
    const { engine } = rig([
      { type: "circle", x: 100, y: 100, time: 1000 },
      { type: "slider", x: 200, y: 200, time: 2000, endTime: 2400, sliderTime: 400, endX: 300, endY: 200 },
      { type: "spinner", x: 0, y: 0, time: 3000, endTime: 4000 },
    ]);

    const chart = engine.currentChart;
    assert.ok(chart);
    assert.equal(chart!.noteCount, 3);
    assert.equal(chart!.circles, 1);
    assert.equal(chart!.sliders, 1);
    assert.equal(chart!.spinners, 1);
    assert.equal(engine.currentTapKeys?.code, 90);
    assert.equal(engine.currentTapKeys?.source, "site");

    const diagnostics = engine.getDiagnostics() as any;
    assert.equal(diagnostics.chart.objects, 3);
    assert.equal(diagnostics.tapKeys.code, 90);

    engine.dispose();
  });

  it("forgets the chart when the play closes", () => {
    const { engine, site } = rig([{ type: "circle", x: 100, y: 100, time: 1000 }]);
    assert.ok(engine.currentChart);

    site.dispose();
    env.advance(1000);
    assert.equal(engine.currentChart, null);
    assert.equal(engine.currentPhase, "DETECTING");

    engine.dispose();
  });
});
