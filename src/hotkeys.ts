import { UI_TOGGLE_CODE } from "./constants";
import type { HotkeyAction, Settings } from "./types";
import { listen } from "./ui/dom";

/**
 * Hotkey handling.
 *
 * Three rules make this safe to run inside someone else's page:
 *
 *  1. Only *trusted* events count. Kismet's own clicks are synthetic keydowns
 *     on `window`; without this check, a tap key that shares a code with an
 *     action would make the tool trigger itself.
 *
 *  2. Window capture, so the stop/emergency hotkeys stay reachable even if the
 *     page stops propagation on its own gameplay keys.
 *
 *  3. A key that shares a code with one of the site's tap keys is *not*
 *     swallowed: the action still fires (the tool must stay controllable) but
 *     the event continues to the site, so the tap is not lost. The collision is
 *     reported to the panel instead of silently double-binding.
 */

export interface HotkeyHooks {
  onAction: (action: HotkeyAction) => void;
  /** All keybind codes the site currently uses, for collision warnings. */
  getSiteCodes: () => string[];
  onCollision?: (collisions: Array<{ action: HotkeyAction; code: string }>) => void;
  /**
   * True while the overlay is capturing a keystroke for rebinding. The binding
   * keystroke must never fire the action it is about to replace (pressing the
   * old key of another action during a capture would trigger it).
   */
  isCapturing?: () => boolean;
}

export class HotkeyManager {
  private hooks: HotkeyHooks;
  private codes = new Map<string, HotkeyAction>();
  private disposer: (() => void) | null = null;
  private collisions: Array<{ action: HotkeyAction; code: string }> = [];

  constructor(hooks: HotkeyHooks) {
    this.hooks = hooks;
  }

  /** Rebuild the code -> action table from settings. */
  apply(settings: Settings): void {
    this.codes.clear();
    for (const [action, code] of Object.entries(settings.input.hotkeys) as Array<
      [HotkeyAction, string]
    >) {
      if (action !== "toggleUI" && code !== UI_TOGGLE_CODE && typeof code === "string" && code.length > 0) {
        this.codes.set(code, action);
      }
    }
    // Do not let a stale/custom store replace or steal the panel shortcut.
    this.codes.set(UI_TOGGLE_CODE, "toggleUI");
    this.detectCollisions();
  }

  install(): void {
    if (this.disposer) return;
    this.disposer = listen(
      window,
      "keydown",
      (event) => this.onKeyDown(event as KeyboardEvent),
      { capture: true },
    );
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Ignore our own synthetic events and key repeats.
    if (!event.isTrusted || event.repeat) return;

    // Never swallow modifier combos — those belong to the browser or the page.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const action = this.codes.get(event.code);
    if (!action) return;

    // Right Shift remains an escape hatch even while a rebind is listening or
    // a text field has focus. Every other action belongs to the capture/input.
    if (action !== "toggleUI") {
      if (this.hooks.isCapturing?.()) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
    }

    // A colliding key must keep reaching the site: swallowing it would eat a
    // tap, and the panel already warns that the binding is a bad idea.
    if (!this.hooks.getSiteCodes().includes(event.code)) {
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      else event.stopPropagation();
    }
    this.hooks.onAction(action);
  }

  private detectCollisions(): void {
    const siteCodes = new Set(this.hooks.getSiteCodes());
    const hadCollisions = this.collisions.length > 0;
    this.collisions = [];
    for (const [code, action] of this.codes) {
      if (siteCodes.has(code)) this.collisions.push({ action, code });
    }
    // Report resolution too, so an old warning disappears after rebinding.
    if (this.collisions.length > 0 || hadCollisions) this.hooks.onCollision?.(this.collisions);
  }

  get currentCollisions(): Array<{ action: HotkeyAction; code: string }> {
    return this.collisions;
  }

  dispose(): void {
    this.disposer?.();
    this.disposer = null;
    this.codes.clear();
  }
}
