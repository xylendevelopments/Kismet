import { DEFAULT_TAP_HOLD_MS } from "../constants";
import type { Chart, ChartObject, InputAction } from "../types";
import { analyseChart, type ChartAnalysis } from "./chart";

/**
 * Chart -> ordered cursor timeline.
 *
 * std has exactly one input at a time: the cursor is either idle, pressing a
 * circle, or holding a slider/spinner. So a chart becomes two actions per
 * object — a `down` at its hit time and an `up` when it stops needing the
 * button — plus the cursor path the driver walks between them.
 *
 * Ordering rules, both of which are load-bearing:
 *
 *   1. A press happens before its own release when timestamps tie (a circle's
 *      release is deferred, but a same-instant tie must still read press-first).
 *   2. A release is never allowed to land at or after the next press. The site
 *      judges a circle on `keydown` and ignores it while the button is already
 *      down (`if (playback.game.K1down) return;`), so an overlapping release
 *      would silently swallow the following note.
 */

export interface TimelineOptions {
  /**
   * Extra lead/lag in ms applied when the timeline is built. Kept at 0 by the
   * engine: the timing offset is applied at *schedule* time so that changing it
   * mid-run takes effect immediately.
   */
  offset?: number;
  /** How long a circle's press is held, ms. */
  tapHoldMs?: number;
  /**
   * Optional per-object timing perturbation. Applied here rather than in the
   * scheduler because it is a property of the *chart interpretation*: it has to
   * be baked in before the ordering sort so the release clamp sees final
   * values. A disabled humanizer returns 0 for every object.
   */
  humanizer?: HumanizerLike | null;
  /** Pre-computed analysis, to avoid a second pass. */
  analysis?: ChartAnalysis | null;
}

/** The slice of the humanizer the timeline needs. */
export interface HumanizerLike {
  prepare(objects: readonly ChartObject[]): void;
  deltaAt(index: number): number;
  releaseExtraAt(index: number, object: ChartObject): number;
}

export interface Timeline {
  actions: InputAction[];
  /** Press time of each object, ascending. Drives the "objects left" readout. */
  notePressTimes: number[];
  noteCount: number;
  firstActionTime: number;
  lastActionTime: number;
  analysis: ChartAnalysis;
}

export function buildTimeline(chart: Chart, options: TimelineOptions = {}): Timeline {
  const {
    offset = 0,
    tapHoldMs = DEFAULT_TAP_HOLD_MS,
    humanizer = null,
    analysis = null,
  } = options;

  const objects = chart.objects;
  const hold = Math.max(1, tapHoldMs);
  const actions: InputAction[] = [];
  const notePressTimes: number[] = new Array(objects.length);

  // The humanizer needs every object's delta before the first action is
  // emitted: the release clamp looks at the *next* press, whose shifted time is
  // not known until all deltas exist.
  if (humanizer) humanizer.prepare(objects);

  for (let i = 0; i < objects.length; i++) {
    const object = objects[i];
    const delta = humanizer ? humanizer.deltaAt(i) : 0;
    const pressTime = object.time + offset + delta;
    notePressTimes[i] = pressTime;

    actions.push({
      seq: 0,
      time: pressTime,
      type: "down",
      objectIndex: object.index,
      x: object.x,
      y: object.y,
      simultaneous: false,
    });

    let releaseTime: number;
    if (object.kind === "circle") {
      releaseTime = pressTime + hold;
    } else {
      // Sliders and spinners are held for their whole body. The release keeps
      // the object's own delta so a humanised hold still ends where its head
      // landed, plus an independent release wobble.
      const releaseExtra = humanizer ? humanizer.releaseExtraAt(i, object) : 0;
      releaseTime = object.endTime + offset + delta + releaseExtra;
    }

    // Never let a release reach or pass the next object's press.
    const next = objects[i + 1];
    if (next) {
      const nextDelta = humanizer ? humanizer.deltaAt(i + 1) : 0;
      const nextPress = next.time + offset + nextDelta;
      const ceiling = nextPress - 1;
      if (releaseTime > ceiling) releaseTime = Math.max(pressTime + 1, ceiling);
    }

    actions.push({
      seq: 0,
      time: Math.max(releaseTime, pressTime + 1),
      type: "up",
      objectIndex: object.index,
      x: object.x,
      y: object.y,
      simultaneous: false,
    });
  }

  // Stable sort by time only. Insertion order (press before release) breaks
  // ties, which is what keeps a same-instant pair readable to the scheduler.
  const decorated = actions.map((action, index) => ({ action, index }));
  decorated.sort((a, b) => a.action.time - b.action.time || a.index - b.index);

  const sorted: InputAction[] = new Array(decorated.length);
  for (let i = 0; i < decorated.length; i++) {
    const action = decorated[i].action;
    action.seq = i;
    const prev = i > 0 ? sorted[i - 1] : null;
    const next = decorated[i + 1]?.action ?? null;
    action.simultaneous =
      (prev !== null && Math.abs(prev.time - action.time) < 1e-6) ||
      (next !== null && Math.abs(next.time - action.time) < 1e-6);
    sorted[i] = action;
  }

  notePressTimes.sort((a, b) => a - b);

  return {
    actions: sorted,
    notePressTimes,
    noteCount: objects.length,
    firstActionTime: sorted.length > 0 ? sorted[0].time : 0,
    lastActionTime: sorted.length > 0 ? sorted[sorted.length - 1].time : 0,
    analysis: analysis ?? analyseChart(chart),
  };
}

/**
 * The object the cursor should be working on at a chart time, if any.
 *
 * A slider or spinner keeps the cursor busy for its whole body, so the lookup
 * cannot be a simple "next object after now": it has to notice that we are
 * still inside one.
 */
export function activeObjectAt(objects: ChartObject[], chartTime: number, from = 0): ChartObject | null {
  for (let i = from; i < objects.length; i++) {
    const object = objects[i];
    if (object.time > chartTime) return null;
    if (object.endTime >= chartTime) return object;
  }
  return null;
}
