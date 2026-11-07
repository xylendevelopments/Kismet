import { PLAYFIELD } from "../constants";
import type { SiteGame, SiteGfx } from "../types";

/**
 * Cursor and click input, driven through webosu!'s own listeners.
 *
 * How input reaches the game
 * --------------------------
 * webosu! registers plain DOM listeners on `window` (see its
 * `js/playerActions.js`):
 *
 *     window.addEventListener("mousemove", ...)   // cursor position
 *     window.addEventListener("keydown",   ...)   // K1keycode / K2keycode
 *     window.addEventListener("keyup",     ...)
 *     window.addEventListener("mousedown", ...)   // only if allowMouseButton
 *
 * The key handlers compare `event.keyCode` against `game.K1keycode` /
 * `game.K2keycode` and never look at `event.isTrusted`, so a synthetic
 * `KeyboardEvent` takes exactly the same path a real keypress does: the site's
 * own `checkClickdown()` measures the distance between the cursor and the next
 * object, compares the audio clock against the object's time, and hands the
 * result to its own scoring. Nothing here calls into scoring.
 *
 * Cursor position is set with a synthetic `mousemove` rather than by writing
 * `game.mouseX` directly. The site's handler converts `clientX`/`clientY` back
 * into osu! pixels through the same letterboxed geometry it draws with, so the
 * value the engine intends and the value the game judges against stay identical
 * — including across window resizes, which move the letterbox.
 *
 * Two details from the site's source that shape this file:
 *
 *   - A click is judged by `checkClickdown()` on *keydown*. While the key is
 *     already down the handler returns early, so a second press without an
 *     intervening release would be swallowed. `press()` is therefore a no-op
 *     while held, and the engine's timeline never overlaps a release with the
 *     next press.
 *   - `allowMouseButton` defaults to false, so mouse buttons are not a safe
 *     input path. The keyboard path is always registered.
 */

export interface PointerOptions {
  win: Window;
  /** Which virtual key code the site's listeners compare against. */
  keyCode: number;
  /** Reads the live letterboxed playfield geometry. */
  geometry: () => SiteGfx;
  /** Reads the site's game object, for post-dispatch verification. */
  game?: () => SiteGame | null;
  /** MouseEvent constructor override, for tests. */
  mouseCtor?: typeof MouseEvent;
  keyboardCtor?: typeof KeyboardEvent;
  onError?: (err: unknown) => void;
}

export class Pointer {
  private win: Window;
  private keyCode: number;
  private geometry: () => SiteGfx;
  private game?: () => SiteGame | null;
  private MouseCtor: typeof MouseEvent;
  private KeyCtor: typeof KeyboardEvent;
  private onError?: (err: unknown) => void;

  private down = false;
  private disposed = false;

  /** Counters, for the panel's diagnostics. */
  public moves = 0;
  public presses = 0;
  public releases = 0;
  public suppressed = 0;
  public failures = 0;
  /** Largest observed |intended - actual| cursor error, osu! px. */
  public maxMoveError = 0;
  /** Cursor position we last asked for, osu! pixels. */
  public cursor = { x: PLAYFIELD.width / 2, y: PLAYFIELD.height / 2 };

  constructor(options: PointerOptions) {
    this.win = options.win;
    this.keyCode = options.keyCode;
    this.geometry = options.geometry;
    this.game = options.game;
    const winCtors = options.win as unknown as {
      MouseEvent?: typeof MouseEvent;
      KeyboardEvent?: typeof KeyboardEvent;
    };
    this.MouseCtor = options.mouseCtor ?? winCtors.MouseEvent ?? MouseEvent;
    this.KeyCtor = options.keyboardCtor ?? winCtors.KeyboardEvent ?? KeyboardEvent;
    this.onError = options.onError;
  }

  get isDown(): boolean {
    return this.down;
  }

  get code(): number {
    return this.keyCode;
  }

  /** Track a rebinding of the site's tap key without restarting the run. */
  setKeyCode(code: number): void {
    if (Number.isFinite(code) && code > 0) this.keyCode = code;
  }

  /** Convert osu! pixels to CSS pixels using the live letterbox. */
  toClient(x: number, y: number): { clientX: number; clientY: number } {
    const gfx = this.geometry();
    const width = gfx.width > 0 ? gfx.width : PLAYFIELD.width;
    const height = gfx.height > 0 ? gfx.height : PLAYFIELD.height;
    return {
      clientX: gfx.xoffset + (x / PLAYFIELD.width) * width,
      clientY: gfx.yoffset + (y / PLAYFIELD.height) * height,
    };
  }

  /** Move the game's cursor. Coordinates are osu! pixels (512x384). */
  moveTo(x: number, y: number): boolean {
    if (this.disposed) return false;
    const clampedX = Math.max(-64, Math.min(PLAYFIELD.width + 64, x));
    const clampedY = Math.max(-64, Math.min(PLAYFIELD.height + 64, y));
    this.cursor = { x: clampedX, y: clampedY };

    const { clientX, clientY } = this.toClient(clampedX, clampedY);
    try {
      const event = new this.MouseCtor("mousemove", {
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: this.win,
      });
      this.win.dispatchEvent(event);
      this.moves++;
      this.verifyCursor(clampedX, clampedY);
      return true;
    } catch (err) {
      this.failures++;
      this.onError?.(err);
      return false;
    }
  }

  /** Press the tap key. No-op while already pressed (the site ignores repeats). */
  press(): boolean {
    if (this.disposed) return false;
    if (this.down) {
      this.suppressed++;
      return false;
    }
    if (!this.dispatchKey("keydown")) {
      this.failures++;
      return false;
    }
    this.down = true;
    this.presses++;
    return true;
  }

  /** Release the tap key. Safe to call when not pressed. */
  release(): boolean {
    if (this.disposed) return false;
    if (!this.down) {
      // Still dispatch: the game may believe the key is down because an earlier
      // release failed. A spurious keyup is harmless; a missing one sticks.
      this.dispatchKey("keyup");
      this.releases++;
      return false;
    }
    const ok = this.dispatchKey("keyup");
    this.down = false;
    this.releases++;
    if (!ok) this.failures++;
    return ok;
  }

  /** Release everything. Idempotent; safe at any time. */
  releaseAll(): number {
    if (!this.down) return 0;
    this.down = false;
    const ok = this.dispatchKey("keyup");
    this.releases++;
    if (!ok) this.failures++;
    return 1;
  }

  dispose(): void {
    if (this.disposed) return;
    try {
      this.releaseAll();
    } catch {
      /* best effort */
    }
    this.disposed = true;
  }

  /* ------------------------- event plumbing ------------------------- */

  private dispatchKey(type: "keydown" | "keyup"): boolean {
    const keyCode = this.keyCode;
    try {
      const event = new this.KeyCtor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        // Must be false: the site's handler early-returns on `repeat`.
        repeat: false,
        key: String.fromCharCode(keyCode).toLowerCase(),
        code: "",
      } as KeyboardEventInit);

      // `keyCode` is a legacy accessor. Chromium honours it in the init
      // dictionary; Firefox and Safari do not, so define it on the instance
      // when the constructor did not take it. The site only reads `keyCode`.
      if (event.keyCode !== keyCode) {
        Object.defineProperty(event, "keyCode", { get: () => keyCode, configurable: true });
        Object.defineProperty(event, "which", { get: () => keyCode, configurable: true });
      }
      this.win.dispatchEvent(event);
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }

  /**
   * Compare the game's own cursor position against the one we asked for.
   *
   * The site stores the value it converted from `clientX`/`clientY`, so a
   * mismatch means the letterbox geometry we read is stale (a resize landed
   * between frames) or the page's listener was never installed. Either way it
   * is worth surfacing: every judgement depends on this number.
   */
  private verifyCursor(x: number, y: number): void {
    if (!this.game) return;
    try {
      const game = this.game();
      if (!game) return;
      const dx = Number(game.mouseX) - x;
      const dy = Number(game.mouseY) - y;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const error = Math.hypot(dx, dy);
      if (error > this.maxMoveError) this.maxMoveError = error;
    } catch {
      /* verification is best effort */
    }
  }
}
