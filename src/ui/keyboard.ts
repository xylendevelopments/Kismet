import { el, setText } from "./dom";

/**
 * Tap-key visualiser.
 *
 * webosu! binds gameplay clicks to two key codes (Z and X by default, but its
 * Input settings can rebind them) and judges a click on `keydown`. This strip
 * shows those two keys, marks the one Kismet is driving, and lights it while the
 * button is actually held.
 *
 * It reflects the *automation's* state — what we dispatched — which is the
 * useful thing to watch: a lit key with nothing happening in the game means the
 * site is not accepting input (its Autoplay mod is on, or the key was rebound).
 *
 * Cells are created once per key change and then only their `dataset` flags are
 * toggled, so a spinning map costs a handful of attribute writes per second and
 * no layout thrash.
 */

export interface TapKeyCell {
  /** Virtual key code, or null when unknown. */
  code: number | null;
  /** Which of the site's two taps this is. */
  role: "primary" | "secondary";
}

export class KeyboardView {
  public readonly root: HTMLElement;
  private cells: HTMLElement[] = [];
  private labels: HTMLElement[] = [];
  private signature = "";

  constructor() {
    this.root = el("div", { className: "wom-keys", dataset: { part: "keyboard" } });
  }

  /** Rebuild cells when the site's tap keys change. */
  setKeys(keys: TapKeyCell[], active: "primary" | "secondary"): void {
    const signature = keys.map((key) => `${key.role}:${key.code ?? "?"}`).join("|") + `#${active}`;
    if (signature === this.signature) return;
    this.signature = signature;

    this.root.replaceChildren();
    this.cells = [];
    this.labels = [];

    for (const key of keys) {
      const name = keyLabel(key.code);
      const label = el("span", { text: name });
      const cell = el("div", {
        className: "wom-key",
        dataset: {
          down: "0",
          active: key.role === active ? "1" : "0",
          role: key.role,
        },
        attrs: {
          title: `${key.role === "primary" ? "Primary" : "Secondary"} tap key → ${name}` +
            (key.role === active ? " (driven by Kismet)" : ""),
        },
      }, [label]);
      this.cells.push(cell);
      this.labels.push(label);
      this.root.appendChild(cell);
    }
  }

  /** Light the key while it is held. */
  setHeld(down: boolean): void {
    for (const cell of this.cells) {
      const want = down && cell.dataset.active === "1" ? "1" : "0";
      if (cell.dataset.down !== want) cell.dataset.down = want;
    }
  }

  clear(): void {
    for (const cell of this.cells) {
      if (cell.dataset.down !== "0") cell.dataset.down = "0";
    }
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle("wom-hidden", !visible);
  }

  dispose(): void {
    this.root.replaceChildren();
    this.cells = [];
    this.labels = [];
    this.signature = "";
  }
}

/** `90` -> `"Z"`, `32` -> `"Space"`, `0`/null -> `"?"`. */
export function keyLabel(code: number | null): string {
  if (typeof code !== "number" || !Number.isFinite(code) || code <= 0) return "?";
  if (code === 32) return "Space";
  if (code === 27) return "Esc";
  if (code === 13) return "Enter";
  if (code === 9) return "Tab";
  if (code === 16) return "Shift";
  if (code === 17) return "Ctrl";
  if (code === 18) return "Alt";
  if (code >= 48 && code <= 57) return String.fromCharCode(code);
  if (code >= 65 && code <= 90) return String.fromCharCode(code);
  if (code >= 96 && code <= 105) return `Num${code - 96}`;
  if (code >= 112 && code <= 123) return `F${code - 111}`;
  const specials: Record<number, string> = {
    186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`",
    219: "[", 220: "\\", 221: "]", 222: "'", 37: "←", 38: "↑", 39: "→", 40: "↓",
  };
  return specials[code] ?? `#${code}`;
}

/** Render `setText` in a label, kept for parity with the old view's API. */
export function setKeyLabel(label: HTMLElement, code: number | null): void {
  setText(label, keyLabel(code));
}
