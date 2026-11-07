import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTimeline, activeObjectAt } from "../src/chart/timeline";
import type { Chart, ChartObject, ObjectKind } from "../src/types";

function object(
  index: number,
  kind: ObjectKind,
  time: number,
  endTime = time,
): ChartObject {
  return {
    index,
    kind,
    x: 100 + index * 10,
    y: 100,
    time,
    endTime,
    sliderDuration: kind === "slider" ? endTime - time : 0,
    repeat: kind === "slider" ? 1 : 0,
    path: kind === "slider" ? [{ x: 100, y: 100 }, { x: 200, y: 100 }] : null,
  };
}

function chart(objects: ChartObject[]): Chart {
  return {
    objects,
    noteCount: objects.length,
    circles: objects.filter((o) => o.kind === "circle").length,
    sliders: objects.filter((o) => o.kind === "slider").length,
    spinners: objects.filter((o) => o.kind === "spinner").length,
    startTime: objects[0]?.time ?? 0,
    endTime: objects[objects.length - 1]?.endTime ?? 0,
    signature: "test",
    difficulty: { od: 8, ar: 9, cs: 4, hp: 5 },
    windows: { great: 32, good: 76, meh: 120 },
  };
}

describe("buildTimeline", () => {
  it("emits a press and a release per object", () => {
    const timeline = buildTimeline(chart([object(0, "circle", 1000)]), { tapHoldMs: 12 });
    assert.equal(timeline.actions.length, 2);
    assert.deepEqual(
      timeline.actions.map((action) => `${action.type}@${action.time}`),
      ["down@1000", "up@1012"],
    );
  });

  it("holds a slider for its whole body and a spinner to its end", () => {
    const timeline = buildTimeline(
      chart([object(0, "slider", 1000, 1600), object(1, "spinner", 2000, 3500)]),
      { tapHoldMs: 12 },
    );
    const ups = timeline.actions.filter((action) => action.type === "up");
    assert.deepEqual(ups.map((action) => action.time), [1600, 3500]);
  });

  it("never lets a release reach the next press", () => {
    // A circle with a 50ms tap hold followed by an object 20ms later: the
    // release must be clamped inside the gap or the next press is swallowed.
    const timeline = buildTimeline(
      chart([object(0, "circle", 1000), object(1, "circle", 1020)]),
      { tapHoldMs: 50 },
    );
    const sequence = timeline.actions.map((action) => `${action.type}@${action.time}`);
    assert.deepEqual(sequence, ["down@1000", "up@1019", "down@1020", "up@1070"]);
  });

  it("keeps press-before-release order for equal timestamps", () => {
    const timeline = buildTimeline(chart([object(0, "circle", 1000)]), { tapHoldMs: 1 });
    assert.deepEqual(timeline.actions.map((action) => action.type), ["down", "up"]);
  });

  it("sorts objects and exposes press times", () => {
    const timeline = buildTimeline(
      chart([object(0, "circle", 1000), object(1, "circle", 1300), object(2, "circle", 1600)]),
      { tapHoldMs: 12 },
    );
    assert.deepEqual(timeline.notePressTimes, [1000, 1300, 1600]);
    assert.equal(timeline.noteCount, 3);
    assert.equal(timeline.firstActionTime, 1000);
    assert.equal(timeline.lastActionTime, 1612);
  });

  it("applies a constant offset to every action", () => {
    const timeline = buildTimeline(chart([object(0, "circle", 1000)]), { offset: -25, tapHoldMs: 10 });
    assert.equal(timeline.actions[0].time, 975);
    assert.equal(timeline.actions[1].time, 985);
  });

  it("carries the humanizer's deltas into press and release", () => {
    const deltas = new Map<number, number>([[0, 7], [1, -4]]);
    const humanizer = {
      prepare() { /* nothing to do */ },
      deltaAt: (index: number) => deltas.get(index) ?? 0,
      releaseExtraAt: () => 3,
    };
    const timeline = buildTimeline(
      chart([object(0, "circle", 1000), object(1, "slider", 2000, 2600)]),
      { tapHoldMs: 10, humanizer },
    );
    assert.deepEqual(
      timeline.actions.map((action) => `${action.type}@${action.time}`),
      ["down@1007", "up@1017", "down@1996", "up@2599"],
    );
  });

  it("clamps a humanised release against the following press", () => {
    const humanizer = {
      prepare() { /* no-op */ },
      deltaAt: () => 0,
      releaseExtraAt: () => 40,
    };
    const timeline = buildTimeline(
      chart([object(0, "slider", 1000, 1600), object(1, "circle", 1800)]),
      { humanizer },
    );
    const ups = timeline.actions.filter((action) => action.type === "up");
    assert.ok(ups[0].time < 1800, "release must stay ahead of the next press");
  });
});

describe("activeObjectAt", () => {
  it("finds the slider body the cursor is inside", () => {
    const objects = [object(0, "circle", 1000), object(1, "slider", 2000, 2600), object(2, "circle", 3000)];
    assert.equal(activeObjectAt(objects, 1500), null);
    assert.equal(activeObjectAt(objects, 2300)?.index, 1);
    assert.equal(activeObjectAt(objects, 2700), null);
    assert.equal(activeObjectAt(objects, 2999), null);
    assert.equal(activeObjectAt(objects, 3000)?.index, 2);
  });
});
