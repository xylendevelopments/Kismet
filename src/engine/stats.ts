import type { EngineStats, SitePlayback, SiteScoreOverlay } from "../types";

/**
 * Statistics.
 *
 * The site already computes everything worth showing: score, combo and the
 * per-judgement counts live on `playback.scoreOverlay` (see its
 * `js/overlay/score.js`). Reading them is a handful of property accesses and is
 * exact, so we prefer that over re-deriving accuracy or scraping the HUD.
 *
 * What we add on top is automation-side telemetry the site does not have: how
 * many objects remain, how many presses we dispatched, and how accurate our
 * *scheduling* was (jitter) — the number that tells you whether the timing model
 * is healthy.
 */

export interface JudgementCounts {
  great: number;
  good: number;
  meh: number;
  miss: number;
  /** Objects the site has judged, misses included. */
  total: number;
}

export function readJudgements(playback: SitePlayback | null): JudgementCounts {
  const counts: JudgementCounts = { great: 0, good: 0, meh: 0, miss: 0, total: 0 };
  const overlay = playback?.scoreOverlay;
  if (!overlay) return counts;

  const judge = overlay.judgecnt ?? {};
  counts.great = num(judge.great);
  counts.good = num(judge.good);
  counts.meh = num(judge.meh);
  counts.miss = num(judge.miss);
  counts.total = counts.great + counts.good + counts.meh + counts.miss;
  return counts;
}

/** Objects the site has judged, any judgement including miss. */
export function judgedCount(playback: SitePlayback | null): number {
  return readJudgements(playback).total;
}

/**
 * Accuracy as a 0..1 fraction, or null before anything has been judged.
 *
 * Uses the site's own running totals (`judgeTotal / maxJudgeTotal`) because
 * that is the number its results screen will show — slider tick and end
 * weighting included. Falls back to a plain weighted mean when an older build
 * does not expose the totals.
 */
export function readAccuracy(playback: SitePlayback | null): number | null {
  const overlay: SiteScoreOverlay | undefined = playback?.scoreOverlay;
  if (!overlay) return null;

  const judgeTotal = Number(overlay.judgeTotal);
  const maxJudgeTotal = Number(overlay.maxJudgeTotal);
  if (Number.isFinite(judgeTotal) && Number.isFinite(maxJudgeTotal) && maxJudgeTotal > 0) {
    return Math.min(1, Math.max(0, judgeTotal / maxJudgeTotal));
  }

  const counts = readJudgements(playback);
  if (counts.total === 0) return null;
  const weighted = counts.great * 300 + counts.good * 100 + counts.meh * 50;
  return weighted / (counts.total * 300);
}

export function readCombo(playback: SitePlayback | null): number {
  const value = Number(playback?.scoreOverlay?.combo);
  return Number.isFinite(value) ? value : 0;
}

export function readScore(playback: SitePlayback | null): number | null {
  const value = Number(playback?.scoreOverlay?.score);
  return Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * Assemble the full stats snapshot shown in the overlay.
 *
 * Called on the UI refresh interval, not per frame, and allocates exactly one
 * object.
 */
export function collectStats(input: {
  playback: SitePlayback | null;
  objectsTotal: number;
  objectsRemaining: number;
  taps: number;
  timeElapsed: number;
  lastJitter: number;
  avgJitter: number;
  holding: boolean;
}): EngineStats {
  const counts = readJudgements(input.playback);
  return {
    objectsTotal: input.objectsTotal,
    objectsRemaining: input.objectsRemaining,
    taps: input.taps,
    timeElapsed: input.timeElapsed,
    hits: counts.total,
    judgedGood: counts.total - counts.miss,
    combo: readCombo(input.playback),
    accuracy: readAccuracy(input.playback),
    score: readScore(input.playback),
    lastJitter: input.lastJitter,
    avgJitter: input.avgJitter,
    holding: input.holding,
  };
}

/**
 * Objects remaining, counted in objects rather than actions.
 * `notePressTimes` is sorted, so this is a binary search.
 */
export function notesRemainingAt(notePressTimes: number[], chartTime: number): number {
  let lo = 0;
  let hi = notePressTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notePressTimes[mid] < chartTime) lo = mid + 1;
    else hi = mid;
  }
  return notePressTimes.length - lo;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
