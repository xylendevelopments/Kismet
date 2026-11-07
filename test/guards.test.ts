import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Guards, verifyInputState } from "../src/engine/guards";
import { installDom, type StubEnvironment } from "./helpers/domStub";

let env: StubEnvironment;

beforeEach(() => {
  env = installDom();
  env.globalsInstalled();
});

afterEach(() => {
  env.globalsRemoved();
});

function harness(overrides: Partial<Parameters<typeof Guards.prototype.constructor>[0]> = {}) {
  const events: string[] = [];
  let down = false;
  let since: number | null = null;
  let alive = true;
  let chart = 0;

  const guards = new Guards(
    {
      releaseAll: () => {
        events.push("release");
        down = false;
        since = null;
      },
      onInterrupt: (reason) => events.push(`interrupt:${reason}`),
      onPanic: (reason) => events.push(`panic:${reason}`),
      isGameAlive: () => alive,
      chartTime: () => chart,
      isDown: () => down,
      heldSince: () => since,
      ...overrides,
    },
    { win: env.window, watchdogInterval: 500, stuckKeyTimeout: 20_000 },
  );
  guards.install();
  return {
    guards,
    events,
    hold(at: number) { down = true; since = at; },
    setChart(ms: number) { chart = ms; },
    die() { alive = false; },
    tick: () => guards.tick(),
  };
}

describe("Guards", () => {
  it("releases and interrupts when the tab is hidden", () => {
    const h = harness();
    h.hold(1000);
    env.document.hidden = true;
    env.document.dispatchEvent({ type: "visibilitychange", bubbles: false });
    assert.ok(h.events.includes("release"));
    assert.ok(h.events.some((event) => event.startsWith("interrupt:")));
    h.guards.dispose();
  });

  it("releases and interrupts when the window loses focus", () => {
    const h = harness();
    h.hold(1000);
    env.window.dispatchEvent({ type: "blur", bubbles: false });
    assert.equal(h.events.filter((event) => event === "release").length, 1);
    assert.equal(h.events.filter((event) => event.startsWith("interrupt:")).length, 1);
    h.guards.dispose();
  });

  it("releases on pagehide and beforeunload without pausing", () => {
    const h = harness();
    env.window.dispatchEvent({ type: "pagehide", bubbles: false });
    env.window.dispatchEvent({ type: "beforeunload", bubbles: false });
    assert.equal(h.events.filter((event) => event === "release").length, 2);
    assert.equal(h.events.filter((event) => event.startsWith("interrupt:")).length, 0);
    h.guards.dispose();
  });

  it("forces a release and panics on a stuck hold", () => {
    const h = harness();
    h.hold(1000);
    h.setChart(1000 + 60_000);
    h.tick();
    assert.ok(h.events.some((event) => event.startsWith("panic:Stuck")));
    h.guards.dispose();
  });

  it("allows a long but legitimate slider hold", () => {
    const h = harness();
    h.hold(1000);
    h.setChart(1000 + 15_000);
    h.tick();
    assert.deepEqual(h.events, []);
    h.guards.dispose();
  });

  it("panics after three consecutive failed liveness probes", () => {
    const h = harness();
    h.die();
    h.tick();
    h.tick();
    assert.equal(h.events.filter((event) => event.startsWith("panic:")).length, 0);
    h.tick();
    assert.ok(h.events.some((event) => event === "release"));
    assert.ok(h.events.some((event) => event.startsWith("panic:")));
    h.guards.dispose();
  });

  it("removes every listener on dispose", () => {
    const h = harness();
    h.guards.dispose();
    h.hold(1000);
    env.window.dispatchEvent({ type: "blur", bubbles: false });
    env.document.hidden = true;
    env.document.dispatchEvent({ type: "visibilitychange", bubbles: false });
    assert.deepEqual(h.events, []);
  });
});

describe("verifyInputState", () => {
  it("agrees when the site and we share a view of the tap key", () => {
    assert.deepEqual(verifyInputState({ K1keycode: 90, K1down: true }, true, 90), { ok: true, siteDown: true });
    assert.deepEqual(verifyInputState({ K1keycode: 90, K1down: false }, false, 90), { ok: true, siteDown: false });
  });

  it("reports a disagreement", () => {
    assert.equal(verifyInputState({ K1keycode: 90, K1down: false }, true, 90).ok, false);
  });

  it("ignores keys the site does not listen for", () => {
    assert.equal(verifyInputState({ K1keycode: 90, K2keycode: 88, K1down: true }, false, 65).ok, true);
  });

  it("checks the secondary key when that is the one we press", () => {
    assert.deepEqual(verifyInputState({ K1keycode: 90, K2keycode: 88, K2down: true }, true, 88), {
      ok: true,
      siteDown: true,
    });
  });
});
