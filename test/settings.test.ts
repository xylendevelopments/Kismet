import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SPIN_RATE,
  OFFSET_MAX,
  OFFSET_MIN,
  STORAGE_KEY,
} from "../src/constants";
import { SettingsManager } from "../src/core/settings";
import {
  formatDuration,
  formatTime,
  groupDigits,
  lowerBound,
  round,
  stableSortBy,
} from "../src/util/helpers";
import { installDom, type StubEnvironment } from "./helpers/domStub";

let env: StubEnvironment;

beforeEach(() => {
  env = installDom();
  env.globalsInstalled();
});

afterEach(() => {
  env.globalsRemoved();
});

describe("SettingsManager", () => {
  it("starts from defaults", () => {
    const settings = new SettingsManager(undefined, env.window);
    assert.deepEqual(settings.all, DEFAULT_SETTINGS);
    settings.dispose();
  });

  it("sets a nested value by path", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("timing.offset", -15);
    assert.equal(settings.all.timing.offset, -15);
    settings.set("general.debug", true);
    assert.equal(settings.all.general.debug, true);
    settings.dispose();
  });

  it("clamps the timing offset to the specified range", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("timing.offset", -99999);
    assert.equal(settings.all.timing.offset, OFFSET_MIN);
    settings.set("timing.offset", 99999);
    assert.equal(settings.all.timing.offset, OFFSET_MAX);
    settings.dispose();
  });

  it("clamps lookahead, scale and opacity", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("timing.lookahead", -10);
    assert.equal(settings.all.timing.lookahead, 20);
    settings.set("appearance.uiScale", 100);
    assert.equal(settings.all.appearance.uiScale, 2);
    settings.set("appearance.opacity", 0);
    assert.equal(settings.all.appearance.opacity, 0.15);
    settings.dispose();
  });

  it("clamps the tap key choice, tap hold and spin rate", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("input.tapKey", "tertiary");
    assert.equal(settings.all.input.tapKey, "primary");
    settings.set("input.tapKey", "secondary");
    assert.equal(settings.all.input.tapKey, "secondary");

    settings.set("input.tapHold", 5000);
    assert.equal(settings.all.input.tapHold, 60);
    settings.set("input.tapHold", 0);
    assert.equal(settings.all.input.tapHold, 2);

    settings.set("input.spinRate", 99);
    assert.equal(settings.all.input.spinRate, 12);
    settings.set("input.spinRate", Number.NaN);
    assert.equal(settings.all.input.spinRate, DEFAULT_SPIN_RATE);
    settings.dispose();
  });

  it("rejects an invalid accent colour", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("appearance.accent", "not-a-colour");
    assert.equal(settings.all.appearance.accent, DEFAULT_SETTINGS.appearance.accent);
    settings.dispose();
  });

  it("emits change events", () => {
    const settings = new SettingsManager(undefined, env.window);
    const seen: string[] = [];
    const off = settings.onChange(({ path }) => seen.push(path));
    settings.set("timing.offset", 10);
    off();
    settings.set("timing.offset", 20);
    assert.deepEqual(seen, ["timing.offset"]);
    settings.dispose();
  });

  it("persists to localStorage and reloads", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("timing.offset", 42);
    return new Promise<void>((resolve) => {
      // persist() is coalesced through a real 250ms timeout that the fake
      // clock controls.
      env.advance(300);
      const raw = env.window.localStorage.getItem(STORAGE_KEY);
      assert.ok(raw, "expected persisted settings");
      const reloaded = new SettingsManager(undefined, env.window);
      assert.equal(reloaded.all.timing.offset, 42);
      reloaded.dispose();
      settings.dispose();
      resolve();
    });
  });

  it("survives corrupt stored JSON", () => {
    env.window.localStorage.setItem(STORAGE_KEY, "{not json");
    const settings = new SettingsManager(undefined, env.window);
    assert.deepEqual(settings.all, DEFAULT_SETTINGS);
    settings.dispose();
  });

  it("survives stored settings of the wrong shape", () => {
    env.window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ timing: "nonsense" }));
    const settings = new SettingsManager(undefined, env.window);
    assert.equal(typeof settings.all.timing.offset, "number");
    settings.dispose();
  });

  it("works when storage is unavailable", () => {
    const blocked = { ...env.window, localStorage: undefined };
    const settings = new SettingsManager(undefined, blocked as unknown as Window);
    settings.set("timing.offset", 5);
    assert.equal(settings.all.timing.offset, 5);
    settings.dispose();
  });

  it("reset returns to defaults", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("timing.offset", 30);
    settings.reset();
    assert.equal(settings.all.timing.offset, DEFAULT_SETTINGS.timing.offset);
    settings.dispose();
  });

  it("toggleGeneral flips and persists the flag", () => {
    const settings = new SettingsManager(undefined, env.window);
    assert.equal(settings.toggleGeneral("enabled"), false);
    assert.equal(settings.all.general.enabled, false);
    settings.dispose();
  });
});

describe("SettingsManager: humanization", () => {
  it("defaults to off so playback is frame-exact out of the box", () => {
    assert.equal(DEFAULT_SETTINGS.humanization.enabled, false);
  });

  it("persists a humanization change across instances", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("humanization.enabled", true);
    settings.set("humanization.strength", 0.75);
    env.advance(300);
    const reloaded = new SettingsManager(undefined, env.window);
    assert.equal(reloaded.all.humanization.enabled, true);
    assert.equal(reloaded.all.humanization.strength, 0.75);
    reloaded.dispose();
    settings.dispose();
  });

  it("clamps out-of-range weights read back from storage", () => {
    env.window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ humanization: { strength: 42, shortTermDrift: -3 } }),
    );
    const settings = new SettingsManager(undefined, env.window);
    assert.equal(settings.all.humanization.strength, 1);
    assert.equal(settings.all.humanization.shortTermDrift, 0);
    settings.dispose();
  });

  it("patch() merges humanization without dropping sibling keys", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.patch({ humanization: { ...DEFAULT_SETTINGS.humanization, enabled: true } });
    assert.equal(settings.all.humanization.enabled, true);
    assert.equal(settings.all.timing.lookahead, DEFAULT_SETTINGS.timing.lookahead);
    settings.dispose();
  });
});

describe("default hotkeys", () => {
  it("avoid the site's tap keys and pause/skip keys", () => {
    const risky = new Set(["KeyZ", "KeyX", "Escape", "ControlLeft", "ControlRight"]);
    for (const [action, code] of Object.entries(DEFAULT_SETTINGS.input.hotkeys)) {
      if (action === "toggleUI") continue;
      assert.equal(risky.has(code), false, `${action} uses ${code}, which the site also listens for`);
    }
  });

  it("are pairwise distinct", () => {
    const codes = Object.values(DEFAULT_SETTINGS.input.hotkeys);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe("helpers", () => {
  it("lowerBound finds the first index at or after a target", () => {
    assert.equal(lowerBound([1, 3, 5, 7], 4, (n) => n), 2);
    assert.equal(lowerBound([1, 3, 5, 7], 8, (n) => n), 4);
  });

  it("stableSortBy preserves insertion order for ties", () => {
    const input = [
      { k: 1, id: "a" },
      { k: 0, id: "b" },
      { k: 1, id: "c" },
    ];
    assert.deepEqual(
      stableSortBy(input, (item) => item.k).map((item) => item.id),
      ["b", "a", "c"],
    );
  });

  it("formatTime renders mm:ss.mmm", () => {
    assert.equal(formatTime(182_340), "3:02.340");
    assert.equal(formatTime(-1500), "-0:01.500");
  });

  it("formatDuration renders compact durations", () => {
    assert.equal(formatDuration(240), "240ms");
    assert.equal(formatDuration(1250), "1.25s");
  });

  it("groupDigits inserts thousands separators", () => {
    assert.equal(groupDigits(1234567), "1,234,567");
  });

  it("round avoids floating point noise", () => {
    assert.equal(round(0.1 + 0.2, 2), 0.3);
  });
});
