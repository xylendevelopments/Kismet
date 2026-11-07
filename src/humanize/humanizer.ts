import { SeededRandom } from "../util/rng";
import type { ChartObject } from "../types";

/**
 * Humanization: deliberate, reproducible timing variation.
 *
 * PURPOSE
 * -------
 * A machine clicks every circle at exactly the right millisecond, every time.
 * That is useful for verifying a chart or watching it played, but it is not
 * useful for studying *timing*: you cannot see how much slack a jump tolerates,
 * or how a rhythm feels when it is slightly early or slightly late, from a run
 * that never varies.
 *
 * This module adds controlled variation so a run behaves more like a player:
 * clicks land a few milliseconds either side of perfect, with a fast wobble, a
 * slow drift across the play, tightening inside dense sections where a player
 * locks into a rhythm, and a slight loosening as the map goes on.
 *
 * WHAT IT IS NOT
 * --------------
 * This is not detection evasion and cannot be. Every event this tool dispatches
 * is `isTrusted === false`, which any page can check in one line. Nothing here
 * changes that: the timing becomes less machine-like, the events stay exactly as
 * synthetic as they were. It exists for practice and timing experimentation.
 * See docs/SAFETY.md.
 *
 * WHY PREPARE() RUNS FIRST
 * ------------------------
 * A slider's release is clamped against the *next* object's press, and that
 * press's shifted time is not known until every delta exists. So `prepare()`
 * computes all deltas up front, and `releaseExtraAt()` reads a ceiling that is
 * guaranteed final. Both are called once per chart, before any action is emitted.
 */

export interface HumanizationConfig {
  /** Master switch. Off by default: perfect timing is the honest baseline. */
  enabled: boolean;
  /** Seed for the PRNG. Same seed + same chart = identical timing. */
  seed: number;
  /** 0..1. Scales every variation component. */
  strength: number;
  /** Shape of the per-object random component. */
  distribution: "gaussian" | "uniform";
  /** 0..1. Weight of the fast mean-reverting wobble. */
  shortTermDrift: number;
  /** 0..1. Weight of the slow random walk across the whole chart. */
  longTermDrift: number;
  /** 0..1. How much dense sections tighten up. */
  patternAware: number;
  /** 0..1. Extra variation on a slider/spinner release. */
  holdReleaseVariation: number;
  /** 0..1. How much a player "tires" over the length of the chart. */
  fatigue: number;
}

export const DEFAULT_HUMANIZATION: HumanizationConfig = {
  enabled: false,
  seed: 0,
  strength: 0.35,
  distribution: "gaussian",
  shortTermDrift: 0.4,
  longTermDrift: 0.25,
  patternAware: 0.6,
  holdReleaseVariation: 0.5,
  fatigue: 0.2,
};

export interface HumanizationStats {
  notes: number;
  meanMs: number;
  sdMs: number;
  minMs: number;
  maxMs: number;
  meanAbsMs: number;
  clamped: number;
  releaseClamped: number;
  patterns: {
    /** Objects in a dense run (< 160ms apart). */
    dense: number;
    /** Objects with >= 900ms of silence on both sides. */
    isolated: number;
    sliders: number;
    spinners: number;
  };
}

/**
 * Per-object random standard deviation at `strength = 1`, in ms.
 *
 * Sized against osu!standard's judgement windows: the tightest is 300s at
 * roughly ±(80 - 6·OD)/2 ms, i.e. ~±16ms at OD 8. At the default strength of
 * 0.35 this gives an sd of ~4ms, so the large majority of clicks still land in
 * the best window while the run no longer looks machine-perfect. Pushing
 * strength to 1 makes timing genuinely sloppy, which is the point.
 */
const BASE_SD_MS = 12;

/** Gap below which a run of objects counts as a dense section. */
const DENSE_GAP_MS = 160;
/** Silence on both sides that makes an object "isolated". */
const ISOLATED_GAP_MS = 900;

/** Never move an object further than this, whatever the config says. */
const MAX_DELTA_MS = 26;
/** Slack kept between a release and the next press. */
const ORDER_MARGIN_MS = 1;

export interface HumanizerOptions {
  config: HumanizationConfig;
  /**
   * Extra safety margin applied to the per-object clamp, so a large humanised
   * delta cannot push a press outside the site's judgement window.
   */
  clampMs?: number;
}

export class Humanizer {
  private readonly config: HumanizationConfig;
  private readonly rng: SeededRandom;
  private readonly clampMs: number;

  private deltas: number[] = [];
  private releaseExtras: number[] = [];
  private prepared = false;
  private clampedCount = 0;
  private releaseClampedCount = 0;
  private statsCache: HumanizationStats | null = null;

  constructor(options: HumanizerOptions) {
    this.config = options.config;
    this.rng = new SeededRandom(options.config.seed >>> 0);
    this.clampMs = Math.max(1, Math.min(MAX_DELTA_MS, options.clampMs ?? MAX_DELTA_MS));
  }

  get isEnabled(): boolean {
    return this.config.enabled === true;
  }

  get stats(): HumanizationStats {
    return this.statsCache ?? emptyStats();
  }

  /** Compute every delta for a chart. Idempotent; always re-derives from seed. */
  prepare(objects: readonly ChartObject[]): void {
    this.deltas = new Array(objects.length).fill(0);
    this.releaseExtras = new Array(objects.length).fill(0);
    this.clampedCount = 0;
    this.releaseClampedCount = 0;
    this.prepared = true;

    if (!this.isEnabled || objects.length === 0) {
      this.statsCache = emptyStats();
      return;
    }

    const cfg = this.config;
    // Re-seeding makes a rebuild (settings change, retry) reproduce the same
    // timing instead of continuing the previous sequence.
    this.rng.reseed(cfg.seed >>> 0);

    const span = Math.max(1, objects[objects.length - 1].time - objects[0].time);
    const dense = classifyDensity(objects);
    let shortTerm = 0;
    let walk = 0;

    for (let i = 0; i < objects.length; i++) {
      const object = objects[i];
      const progress = (object.time - objects[0].time) / span;

      // Fatigue widens the distribution over the length of the play.
      const fatigueFactor = 1 + cfg.fatigue * progress;
      // Dense sections tighten: a player locks into the rhythm rather than
      // free-floating, so a stream should wobble less than a spaced jump.
      const densityFactor = dense[i] ? 1 - 0.7 * cfg.patternAware : 1;

      const random = this.sample(cfg.distribution) * BASE_SD_MS * cfg.strength * fatigueFactor * densityFactor;

      // Fast, mean-reverting wobble.
      shortTerm = 0.65 * shortTerm + this.sample(cfg.distribution) * BASE_SD_MS * 0.35;
      const wobble = shortTerm * cfg.shortTermDrift * cfg.strength;

      // Slow random walk across the map.
      walk += this.sample(cfg.distribution) * BASE_SD_MS * 0.12 * cfg.strength;
      walk *= 1 - 0.02 * cfg.strength;
      const drift = walk * cfg.longTermDrift;

      const raw = random + wobble + drift;
      let value = Math.max(-this.clampMs, Math.min(this.clampMs, raw));
      if (value !== raw) this.clampedCount++;
      this.deltas[i] = value;
    }

    // Release wobble for sliders and spinners, clamped against the next press.
    for (let i = 0; i < objects.length; i++) {
      const object = objects[i];
      if (object.kind === "circle" || cfg.holdReleaseVariation <= 0) continue;

      const sd = BASE_SD_MS * cfg.strength * cfg.holdReleaseVariation;
      // Release error is biased late: a player holds until they are sure.
      const raw = this.sample(cfg.distribution) * sd * 0.6;
      const shiftedEnd = object.endTime + this.deltas[i] + raw;
      const next = objects[i + 1];
      let value = raw;
      if (next) {
        const ceiling = next.time + this.deltas[i + 1] - ORDER_MARGIN_MS;
        if (shiftedEnd > ceiling) {
          value = raw - (shiftedEnd - ceiling);
          this.releaseClampedCount++;
        }
      }
      this.releaseExtras[i] = value;
    }

    this.statsCache = this.computeStats(dense);
  }

  /** The delta for the object at index `i`. Must be called after `prepare()`. */
  deltaAt(index: number): number {
    if (!this.prepared || !this.isEnabled) return 0;
    return this.deltas[index] ?? 0;
  }

  /**
   * Extra variation for a slider or spinner release.
   *
   * Sliders and spinners are held for their body; letting go is a separate
   * decision that varies independently of the head. Zero for circles, whose
   * release is a fixed short hold.
   */
  releaseExtraAt(index: number, object: ChartObject): number {
    if (!this.prepared || !this.isEnabled) return 0;
    if (object.kind === "circle") return 0;
    return this.releaseExtras[index] ?? 0;
  }

  private sample(distribution: "gaussian" | "uniform"): number {
    if (distribution === "uniform") return this.rng.range(-1.732, 1.732) / 1.732;
    return this.rng.gaussian();
  }

  private computeStats(dense: boolean[]): HumanizationStats {
    const values = this.deltas;
    if (values.length === 0) return emptyStats();

    let sum = 0;
    let absSum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
      sum += value;
      absSum += Math.abs(value);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const mean = sum / values.length;
    let sq = 0;
    for (const value of values) sq += (value - mean) * (value - mean);

    let denseCount = 0;
    for (const flag of dense) if (flag) denseCount++;

    return {
      notes: values.length,
      meanMs: mean,
      sdMs: Math.sqrt(sq / values.length),
      minMs: min,
      maxMs: max,
      meanAbsMs: absSum / values.length,
      clamped: this.clampedCount,
      releaseClamped: this.releaseClampedCount,
      patterns: {
        dense: denseCount,
        isolated: 0,
        sliders: 0,
        spinners: 0,
      },
    };
  }
}

/** Flag objects that sit inside a run of closely spaced objects. */
function classifyDensity(objects: readonly ChartObject[]): boolean[] {
  const dense = new Array(objects.length).fill(false);
  let runStart = 0;
  for (let i = 1; i <= objects.length; i++) {
    const gap = i < objects.length ? objects[i].time - objects[i - 1].time : Infinity;
    if (gap > DENSE_GAP_MS) {
      if (i - runStart >= 3) {
        for (let j = runStart; j < i; j++) dense[j] = true;
      }
      runStart = i;
    }
  }
  return dense;
}

/** Count isolated objects (silence on both sides), for diagnostics. */
export function countIsolated(objects: readonly ChartObject[]): number {
  let count = 0;
  for (let i = 0; i < objects.length; i++) {
    const prevGap = i > 0 ? objects[i].time - objects[i - 1].endTime : Infinity;
    const nextGap = i < objects.length - 1 ? objects[i + 1].time - objects[i].endTime : Infinity;
    if (prevGap >= ISOLATED_GAP_MS && nextGap >= ISOLATED_GAP_MS) count++;
  }
  return count;
}

function emptyStats(): HumanizationStats {
  return {
    notes: 0,
    meanMs: 0,
    sdMs: 0,
    minMs: 0,
    maxMs: 0,
    meanAbsMs: 0,
    clamped: 0,
    releaseClamped: 0,
    patterns: { dense: 0, isolated: 0, sliders: 0, spinners: 0 },
  };
}

/** Clamp and validate a stored humanization config. */
export function sanitizeHumanization(raw: unknown): HumanizationConfig {
  const out: HumanizationConfig = { ...DEFAULT_HUMANIZATION };
  if (!raw || typeof raw !== "object") return out;
  const value = raw as Partial<HumanizationConfig>;

  const unit = (candidate: unknown, fallback: number): number => {
    const n = Number(candidate);
    if (Number.isNaN(n)) return fallback;
    // Infinities clamp rather than fall back: `Infinity` clearly means
    // "maximum" and `-Infinity` clearly means "minimum", whereas NaN carries no
    // intent.
    return Math.min(1, Math.max(0, n));
  };

  out.enabled = value.enabled === true;
  out.strength = unit(value.strength, DEFAULT_HUMANIZATION.strength);

  const seed = Number(value.seed);
  out.seed = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) >>> 0 : 0;

  out.distribution = value.distribution === "uniform" ? "uniform" : "gaussian";
  out.shortTermDrift = unit(value.shortTermDrift, DEFAULT_HUMANIZATION.shortTermDrift);
  out.longTermDrift = unit(value.longTermDrift, DEFAULT_HUMANIZATION.longTermDrift);
  out.patternAware = unit(value.patternAware, DEFAULT_HUMANIZATION.patternAware);
  out.holdReleaseVariation = unit(value.holdReleaseVariation, DEFAULT_HUMANIZATION.holdReleaseVariation);
  out.fatigue = unit(value.fatigue, DEFAULT_HUMANIZATION.fatigue);

  return out;
}
