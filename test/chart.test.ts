import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyseChart, buildChart, sliderPointAt } from "../src/chart/chart";
import { PLAYFIELD } from "../src/constants";
import type { SitePlayback } from "../src/types";

/** A straight-line curve, like the site's SliderMesh exposes. */
function curve(from: { x: number; y: number }, to: { x: number; y: number }) {
  return {
    pointAt(t: number) {
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    },
  };
}

function playback(hits: unknown[], metadata: Record<string, string> = {}): SitePlayback {
  return {
    hits: hits as SitePlayback["hits"],
    track: {
      metadata: { Title: "Song", Artist: "Artist", Version: "Hard", ...metadata },
      difficulty: { OverallDifficulty: 8, ApproachRate: 9, CircleSize: 4, HPDrainRate: 5 },
    },
    osu: { audio: { getPosition: () => 0 } },
    GreatTime: 32,
    GoodTime: 76,
    MehTime: 120,
  };
}

describe("buildChart", () => {
  it("mirrors circles, sliders and spinners, counting each once", () => {
    const chart = buildChart(
      playback([
        { type: "circle", x: 100, y: 100, time: 1000, endTime: 1000, score: -1 },
        {
          type: "slider", x: 200, y: 200, time: 2000, endTime: 2600,
          sliderTime: 600, repeat: 1, curve: curve({ x: 200, y: 200 }, { x: 300, y: 200 }),
        },
        { type: "spinner", x: 0, y: 0, time: 3000, endTime: 4000 },
      ]),
    );

    assert.ok(chart);
    assert.equal(chart.noteCount, 3);
    assert.equal(chart.circles, 1);
    assert.equal(chart.sliders, 1);
    assert.equal(chart.spinners, 1);
    assert.equal(chart.startTime, 1000);
    assert.equal(chart.endTime, 4000);
    assert.equal(chart.label, "Artist — Song [Hard]");
    assert.deepEqual(chart.windows, { great: 32, good: 76, meh: 120 });
  });

  it("places spinners at the centre of the playfield", () => {
    const chart = buildChart(playback([{ type: "spinner", x: 20, y: 40, time: 0, endTime: 1000 }]));
    assert.ok(chart);
    assert.equal(chart.objects[0].x, PLAYFIELD.width / 2);
    assert.equal(chart.objects[0].y, PLAYFIELD.height / 2);
  });

  it("samples a slider path and unrolls repeats", () => {
    const chart = buildChart(
      playback([
        {
          type: "slider", x: 100, y: 100, time: 0, endTime: 1200,
          sliderTime: 400, repeat: 3, curve: curve({ x: 100, y: 100 }, { x: 200, y: 100 }),
        },
      ]),
    );
    assert.ok(chart);
    const slider = chart.objects[0];
    assert.ok(slider.path);
    assert.ok(slider.path!.length > 3 * 24, "expected one sample per span slice, three spans");
    // First span runs left→right, second right→left: the unrolled path must
    // reverse at the repeat boundary.
    const span = slider.path!.length / 3;
    assert.ok(Math.abs(slider.path![0].x - 100) < 0.001);
    assert.ok(Math.abs(slider.path![span].x - 200) < 0.001);
    assert.ok(Math.abs(slider.path![span * 2].x - 100) < 0.001);
  });

  it("interpolates along the slider by elapsed time", () => {
    const chart = buildChart(
      playback([
        {
          type: "slider", x: 100, y: 100, time: 0, endTime: 400,
          sliderTime: 400, repeat: 1, curve: curve({ x: 100, y: 100 }, { x: 300, y: 100 }),
        },
      ]),
    );
    assert.ok(chart);
    const slider = chart.objects[0];
    assert.ok(Math.abs(sliderPointAt(slider, 0).x - 100) < 0.01);
    assert.ok(Math.abs(sliderPointAt(slider, 200).x - 200) < 0.01);
    assert.ok(Math.abs(sliderPointAt(slider, 400).x - 300) < 0.01);
    // Past the end the cursor rests at the tail rather than running off.
    assert.ok(Math.abs(sliderPointAt(slider, 900).x - 300) < 0.01);
  });

  it("keeps a slider usable when the site has not built its curve", () => {
    const chart = buildChart(
      playback([{ type: "slider", x: 100, y: 100, time: 0, endTime: 400, sliderTime: 400, repeat: 1 }]),
    );
    assert.ok(chart);
    assert.equal(chart.objects[0].path, null);
    const point = sliderPointAt(chart.objects[0], 200);
    assert.deepEqual(point, { x: 100, y: 100 });
  });

  it("rejects an empty chart", () => {
    assert.equal(buildChart(playback([])), null);
  });

  it("uses a stable signature for the same play and a different one otherwise", () => {
    const hits = [{ type: "circle", x: 1, y: 1, time: 100, endTime: 100 }];
    const a = buildChart(playback(hits));
    const b = buildChart(playback(hits));
    const c = buildChart(playback(hits, { Version: "Insane" }));
    assert.ok(a && b && c);
    assert.equal(a.signature, b.signature);
    assert.notEqual(a.signature, c.signature);
  });
});

describe("analyseChart", () => {
  it("counts density, streams and jumps", () => {
    const chart = buildChart(
      playback([
        { type: "circle", x: 10, y: 10, time: 0, endTime: 0 },
        { type: "circle", x: 20, y: 10, time: 50, endTime: 50 },
        { type: "circle", x: 30, y: 10, time: 100, endTime: 100 },
        { type: "circle", x: 400, y: 300, time: 2000, endTime: 2000 },
        {
          type: "slider", x: 100, y: 100, time: 3000, endTime: 4200,
          sliderTime: 1200, repeat: 1, curve: curve({ x: 100, y: 100 }, { x: 200, y: 100 }),
        },
      ]),
    );
    assert.ok(chart);
    const analysis = analyseChart(chart);
    assert.equal(analysis.circles, 4);
    assert.equal(analysis.sliders, 1);
    assert.equal(analysis.longestStream, 3);
    assert.equal(analysis.minGap, 50);
    assert.equal(analysis.longestSlider, 1200);
    assert.ok(analysis.peakNps >= 3);
    assert.ok(analysis.maxJump > 300);
  });
});
