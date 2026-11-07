import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countIsolated,
  DEFAULT_HUMANIZATION,
  Humanizer,
  sanitizeHumanization,
  type HumanizationConfig,
} from "../src/humanize/humanizer";
import type { ChartObject, ObjectKind } from "../src/types";

function objects(count: number, gap = 200): ChartObject[] {
  const out: ChartObject[] = [];
  for (let i = 0; i < count; i++) {
    const kind: ObjectKind = i % 4 === 3 ? "slider" : "circle";
    const time = 1000 + i * gap;
    out.push({
      index: i,
      kind,
      x: 100,
      y: 100,
      time,
      endTime: kind === "slider" ? time + 300 : time,
      sliderDuration: kind === "slider" ? 300 : 0,
      repeat: kind === "slider" ? 1 : 0,
      path: null,
    });
  }
  return out;
}

function humanizer(overrides: Partial<HumanizationConfig> = {}, clampMs?: number): Humanizer {
  return new Humanizer({
    config: { ...DEFAULT_HUMANIZATION, enabled: true, ...overrides },
    clampMs,
  });
}

function deltas(h: Humanizer, list: ChartObject[]): number[] {
  h.prepare(list);
  return list.map((_, i) => h.deltaAt(i));
}

describe("Humanizer", () => {
  it("returns zero for every object when disabled, and consumes no randomness", () => {
    const list = objects(20);
    const off = new Humanizer({ config: { ...DEFAULT_HUMANIZATION, enabled: false } });
    off.prepare(list);
    assert.ok(list.every((_, i) => off.deltaAt(i) === 0));
    assert.equal(off.stats.notes, 0);
  });

  it("is deterministic for a seed and chart", () => {
    const list = objects(50);
    const a = deltas(humanizer({ seed: 1234 }), list);
    const b = deltas(humanizer({ seed: 1234 }), list);
    assert.deepEqual(a, b);
  });

  it("produces different timing for a different seed", () => {
    const list = objects(50);
    const a = deltas(humanizer({ seed: 1 }), list);
    const b = deltas(humanizer({ seed: 2 }), list);
    assert.notDeepEqual(a, b);
  });

  it("scales variation with strength", () => {
    const list = objects(400);
    const low = deltas(humanizer({ seed: 7, strength: 0.1 }), list);
    const high = deltas(humanizer({ seed: 7, strength: 1 }), list);
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    assert.ok(spread(high) > spread(low));
  });

  it("clamps every delta inside the configured window", () => {
    const list = objects(300);
    const h = humanizer({ seed: 9, strength: 1 }, 6);
    const values = deltas(h, list);
    assert.ok(values.every((value) => Math.abs(value) <= 6));
    assert.ok(h.stats.clamped > 0, "expected some deltas to be clamped");
  });

  it("keeps the mean near zero over a long chart", () => {
    const h = humanizer({ seed: 42, strength: 0.5 });
    deltas(h, objects(2000));
    assert.ok(Math.abs(h.stats.meanMs) < 1.5, `mean was ${h.stats.meanMs}`);
  });

  it("never varies a circle's release", () => {
    const list = objects(10);
    const h = humanizer({ seed: 3, holdReleaseVariation: 1 });
    h.prepare(list);
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === "circle") assert.equal(h.releaseExtraAt(i, list[i]), 0);
    }
  });

  it("varies a slider release but keeps it ahead of the next press", () => {
    const list = objects(12, 150);
    const h = humanizer({ seed: 11, holdReleaseVariation: 1, strength: 1 });
    h.prepare(list);
    for (let i = 0; i < list.length - 1; i++) {
      const object = list[i];
      if (object.kind !== "slider") continue;
      const release = object.endTime + h.deltaAt(i) + h.releaseExtraAt(i, object);
      const nextPress = list[i + 1].time + h.deltaAt(i + 1);
      assert.ok(release < nextPress, `release ${release} passed next press ${nextPress}`);
    }
  });

  it("reports stats covering every object", () => {
    const list = objects(30);
    const h = humanizer({ seed: 5 });
    deltas(h, list);
    assert.equal(h.stats.notes, 30);
    assert.ok(h.stats.sdMs > 0);
    assert.ok(h.stats.meanAbsMs > 0);
  });

  it("tightens inside dense sections when pattern awareness is on", () => {
    const dense: ChartObject[] = [];
    for (let i = 0; i < 60; i++) {
      dense.push({
        index: i, kind: "circle", x: 100, y: 100,
        time: 1000 + i * 60, endTime: 1000 + i * 60,
        sliderDuration: 0, repeat: 0, path: null,
      });
    }
    const aware = humanizer({ seed: 21, patternAware: 1 });
    aware.prepare(dense);
    const unaware = humanizer({ seed: 21, patternAware: 0 });
    unaware.prepare(dense);
    const spread = (h: Humanizer) =>
      Math.max(...dense.map((_, i) => h.deltaAt(i))) - Math.min(...dense.map((_, i) => h.deltaAt(i)));
    assert.ok(spread(aware) < spread(unaware));
  });
});

describe("countIsolated", () => {
  it("counts objects with long silence on both sides", () => {
    const list = objects(3, 1500);
    assert.equal(countIsolated(list), 3);
  });
});

describe("sanitizeHumanization", () => {
  it("clamps weights and coerces the rest", () => {
    const config = sanitizeHumanization({ enabled: true, strength: 5, seed: -12, distribution: "weird" });
    assert.equal(config.enabled, true);
    assert.equal(config.strength, 1);
    assert.equal(config.seed, 12);
    assert.equal(config.distribution, "gaussian");
  });

  it("falls back to defaults for junk", () => {
    assert.deepEqual(sanitizeHumanization(null), DEFAULT_HUMANIZATION);
    assert.deepEqual(sanitizeHumanization("nope"), DEFAULT_HUMANIZATION);
  });

  it("never enables itself", () => {
    assert.equal(sanitizeHumanization({}).enabled, false);
    assert.equal(sanitizeHumanization({ enabled: "yes" }).enabled, false);
  });
});
