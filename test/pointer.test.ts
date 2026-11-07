import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Pointer } from "../src/input/Pointer";
import { installDom, type StubEnvironment } from "./helpers/domStub";

let env: StubEnvironment;

beforeEach(() => {
  env = installDom();
  env.globalsInstalled();
});

afterEach(() => {
  env.globalsRemoved();
});

const gfx = { width: 800, height: 600, xoffset: 100, yoffset: 50 };

function makePointer(overrides: Partial<ConstructorParameters<typeof Pointer>[0]> = {}) {
  const moves: Array<{ x: number; y: number }> = [];
  const keys: Array<{ type: string; keyCode: number }> = [];
  env.window.addEventListener("mousemove", (event: any) => {
    moves.push({ x: event.clientX, y: event.clientY });
    // The site's own inverse mapping, mirroring its playerActions.js.
    env.window.__lastMove = {
      x: ((event.clientX - gfx.xoffset) / gfx.width) * 512,
      y: ((event.clientY - gfx.yoffset) / gfx.height) * 384,
    };
  });
  env.window.addEventListener("keydown", (event: any) => {
    keys.push({ type: "keydown", keyCode: event.keyCode });
  });
  env.window.addEventListener("keyup", (event: any) => {
    keys.push({ type: "keyup", keyCode: event.keyCode });
  });

  const pointer = new Pointer({
    win: env.window,
    keyCode: 90,
    geometry: () => gfx,
    ...overrides,
  });
  return { pointer, moves, keys };
}

describe("Pointer", () => {
  it("converts osu! pixels into the site's letterboxed client space", () => {
    const { pointer, moves } = makePointer();
    pointer.moveTo(0, 0);
    pointer.moveTo(512, 384);
    assert.deepEqual(moves, [
      { x: 100, y: 50 },
      { x: 900, y: 650 },
    ]);
    pointer.dispose();
  });

  it("round-trips through the site's own inverse mapping", () => {
    const { pointer } = makePointer();
    pointer.moveTo(256, 192);
    assert.ok(Math.abs(env.window.__lastMove.x - 256) < 1e-6);
    pointer.dispose();
  });

  it("presses and releases the configured key code", () => {
    const { pointer, keys } = makePointer();
    assert.equal(pointer.press(), true);
    assert.equal(pointer.isDown, true);
    assert.equal(pointer.release(), true);
    assert.equal(pointer.isDown, false);
    assert.deepEqual(keys, [
      { type: "keydown", keyCode: 90 },
      { type: "keyup", keyCode: 90 },
    ]);
    pointer.dispose();
  });

  it("ignores a duplicate press, like the site's own handler", () => {
    const { pointer, keys } = makePointer();
    pointer.press();
    assert.equal(pointer.press(), false);
    assert.equal(pointer.suppressed, 1);
    assert.equal(keys.filter((key) => key.type === "keydown").length, 1);
    pointer.dispose();
  });

  it("always dispatches a release, even when it believes the key is up", () => {
    const { pointer, keys } = makePointer();
    pointer.release();
    assert.deepEqual(keys, [{ type: "keyup", keyCode: 90 }]);
    pointer.dispose();
  });

  it("releaseAll is idempotent", () => {
    const { pointer, keys } = makePointer();
    pointer.press();
    assert.equal(pointer.releaseAll(), 1);
    assert.equal(pointer.releaseAll(), 0);
    assert.equal(keys.filter((key) => key.type === "keyup").length, 1);
    pointer.dispose();
  });

  it("tracks a rebind of the site's tap key without restarting", () => {
    const { pointer, keys } = makePointer();
    pointer.setKeyCode(88);
    pointer.press();
    pointer.release();
    assert.deepEqual(keys, [
      { type: "keydown", keyCode: 88 },
      { type: "keyup", keyCode: 88 },
    ]);
    pointer.dispose();
  });

  it("measures how far the game's cursor ended up from the target", () => {
    const game = { get mouseX() { return env.window.__lastMove?.x ?? 0; }, get mouseY() { return env.window.__lastMove?.y ?? 0; } };
    const { pointer } = makePointer({ game: () => game as any });
    pointer.moveTo(200, 120);
    assert.ok(pointer.maxMoveError < 1e-6);
    pointer.dispose();
  });

  it("releases on dispose", () => {
    const { pointer, keys } = makePointer();
    pointer.press();
    pointer.dispose();
    assert.equal(pointer.isDown, false);
    assert.deepEqual(keys.map((key) => key.type), ["keydown", "keyup"]);
  });
});
