import { MAX_CHART_OBJECTS, PLAYFIELD } from "../constants";
import type { Chart, ChartObject, ObjectKind, Point, SiteHitObject, SitePlayback } from "../types";
import { hashString } from "../util/helpers";

/**
 * Chart mirroring.
 *
 * webosu! keeps the whole play in `playback.hits`: a shallow copy of every
 * object the `.osu` parser produced, decorated by the site's own `Playback`
 * constructor with the geometry it needs to draw (`curve`, `sliderTime`,
 * `sliderTimeTotal`, `endTime`). That is the chart, and reading it is both
 * cheaper and more accurate than re-parsing the beatmap.
 *
 * What we copy:
 *
 *   - the object kind, hit position and hit time
 *   - the time the object stops needing the cursor (`endTime`)
 *   - a **pre-sampled** slider path, unrolled across repeats
 *
 * What we do NOT keep: the site's objects themselves. They carry Pixi sprites,
 * judgements, Howl refs and closures; holding those alive across a retry is how
 * a helper like this leaks a beatmap's worth of textures. Sampling the path at
 * detection time also means the hot loop never calls into site code.
 */

/** How many points a single slider span is sampled at. */
const PATH_SAMPLES = 32;

/** Density / shape analysis, computed once per chart (never per frame). */
export interface ChartAnalysis {
  circles: number;
  sliders: number;
  spinners: number;
  /** Object density, objects per second, over a 1s sliding window. */
  peakNps: number;
  averageNps: number;
  /** Longest run of objects with less than `STREAM_GAP_MS` between them. */
  longestStream: number;
  /** Shortest gap between consecutive object hit times, ms. */
  minGap: number;
  /** Longest slider hold, ms. */
  longestSlider: number;
  /** Largest jump between consecutive objects, osu! pixels. */
  maxJump: number;
}

const STREAM_GAP_MS = 110;

/** Build the engine's chart from a live `Playback`. */
export function buildChart(playback: SitePlayback): Chart | null {
  const hits = playback.hits;
  if (!Array.isArray(hits) || hits.length === 0) return null;

  const limit = Math.min(hits.length, MAX_CHART_OBJECTS);
  const objects: ChartObject[] = [];
  let circles = 0;
  let sliders = 0;
  let spinners = 0;
  let minTime = Infinity;
  let maxEnd = -Infinity;

  for (let i = 0; i < limit; i++) {
    const hit = hits[i];
    if (!hit || typeof hit !== "object") continue;

    const time = Number(hit.time);
    if (!Number.isFinite(time)) continue;

    const kind = readKind(hit);
    const x = Number(hit.x);
    const y = Number(hit.y);

    let objectX = Number.isFinite(x) ? x : PLAYFIELD.width / 2;
    let objectY = Number.isFinite(y) ? y : PLAYFIELD.height / 2;

    if (kind === "spinner") {
      // The site draws spinners at the playfield centre and judges rotation
      // around it; the raw `.osu` position is meaningless for them.
      objectX = PLAYFIELD.width / 2;
      objectY = PLAYFIELD.height / 2;
    }

    const rawEnd = Number(hit.endTime);
    const endTime = kind === "circle"
      ? time
      : Number.isFinite(rawEnd) && rawEnd > time
        ? rawEnd
        : time;

    const sliderDuration = Number(hit.sliderTime);
    const repeat = Number(hit.repeat);

    const object: ChartObject = {
      index: objects.length,
      kind,
      x: objectX,
      y: objectY,
      time,
      endTime,
      sliderDuration: kind === "slider" && Number.isFinite(sliderDuration) ? Math.max(0, sliderDuration) : 0,
      repeat: kind === "slider" && Number.isFinite(repeat) ? Math.max(1, Math.trunc(repeat)) : 0,
      path: null,
    };

    if (kind === "slider") {
      object.path = sampleSliderPath(hit, object);
      sliders++;
    } else if (kind === "spinner") {
      spinners++;
    } else {
      circles++;
    }

    if (time < minTime) minTime = time;
    const end = Math.max(endTime, time);
    if (end > maxEnd) maxEnd = end;

    objects.push(object);
  }

  if (objects.length === 0) return null;

  // The site keeps `hits` in file order, which is time order, but a chart that
  // reaches us out of order would break every binary search downstream.
  objects.sort((a, b) => a.time - b.time || a.index - b.index);
  for (let i = 0; i < objects.length; i++) objects[i].index = i;

  const difficulty = readDifficulty(playback, objects);

  return {
    objects,
    noteCount: objects.length,
    circles,
    sliders,
    spinners,
    startTime: minTime,
    endTime: maxEnd,
    signature: chartSignature(playback, objects, minTime, maxEnd),
    label: describeTrack(playback),
    difficulty: difficulty.values,
    windows: difficulty.windows,
  };
}

function readKind(hit: SiteHitObject): ObjectKind {
  const type = typeof hit.type === "string" ? hit.type : "";
  if (type === "slider") return "slider";
  if (type === "spinner") return "spinner";
  return "circle";
}

/**
 * Sample a slider into an unrolled polyline.
 *
 * The site's `curve.pointAt(t)` takes a position along the *first* span
 * (0..1); repeats are handled by reflecting the coordinate, exactly as the
 * site does with its own `repeatclamp`. We unroll those reflections here so the
 * driver can interpolate a single flat array with no per-frame reflection and no
 * calls into site code.
 */
function sampleSliderPath(hit: SiteHitObject, object: ChartObject): Point[] | null {
  const curve = hit.curve;
  if (!curve || typeof curve.pointAt !== "function") return null;

  const span: Point[] = [];
  for (let i = 0; i <= PATH_SAMPLES; i++) {
    const u = i / PATH_SAMPLES;
    let point: Point | null = null;
    try {
      point = curve.pointAt(u);
    } catch {
      point = null;
    }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    span.push({ x: point.x, y: point.y });
  }

  const repeats = Math.max(1, object.repeat);
  if (repeats === 1) return span;

  const path: Point[] = [];
  for (let r = 0; r < repeats; r++) {
    if (r % 2 === 0) {
      for (let i = 0; i < span.length; i++) path.push(span[i]);
    } else {
      for (let i = span.length - 1; i >= 0; i--) path.push(span[i]);
    }
  }
  return path;
}

/** Position along a slider at `elapsed` ms after its head, in osu! pixels. */
export function sliderPointAt(object: ChartObject, elapsed: number): Point {
  const path = object.path;
  if (!path || path.length === 0) return { x: object.x, y: object.y };

  const total = object.sliderDuration * Math.max(1, object.repeat);
  if (!(total > 0)) return path[path.length - 1];

  const progress = Math.min(1, Math.max(0, elapsed / total));
  const position = progress * (path.length - 1);
  const index = Math.floor(position);
  const next = Math.min(path.length - 1, index + 1);
  const t = position - index;

  const a = path[index];
  const b = path[next];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function readDifficulty(
  playback: SitePlayback,
  objects: ChartObject[],
): { values: Chart["difficulty"]; windows: Chart["windows"] } {
  const track = playback.track?.difficulty ?? {};
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  const od = num(track.OverallDifficulty, 5);
  const ar = num(track.ApproachRate, od);
  const cs = num(track.CircleSize, 4);
  const hp = num(track.HPDrainRate, 5);

  // The playback's own windows already include the mods the user has on
  // (HardRock tightens, Easy loosens). Falling back to the pure formula keeps
  // the readout meaningful for a chart mirrored before the scene was ready.
  const great = num(playback.GreatTime, 80 - 6 * od);
  const good = num(playback.GoodTime, 140 - 8 * od);
  const meh = num(playback.MehTime, 200 - 10 * od);

  void objects;
  return {
    values: { od, ar, cs, hp },
    windows: { great, good, meh },
  };
}

function describeTrack(playback: SitePlayback): string | undefined {
  const meta = playback.track?.metadata;
  if (!meta) return undefined;
  const artist = typeof meta.Artist === "string" ? meta.Artist.trim() : "";
  const title = typeof meta.Title === "string" ? meta.Title.trim() : "";
  const version = typeof meta.Version === "string" ? meta.Version.trim() : "";
  if (!title) return undefined;
  const head = artist ? `${artist} — ${title}` : title;
  return version ? `${head} [${version}]` : head;
}

/**
 * Structural identity of a play.
 *
 * Must depend only on facts that change when the beatmap (or its mods) change:
 * a retry, a restart or a re-open of the same difficulty has to look identical
 * so the engine does not tear down a perfectly good session. The playhead is
 * deliberately not part of it.
 */
function chartSignature(
  playback: SitePlayback,
  objects: ChartObject[],
  startTime: number,
  endTime: number,
): string {
  const meta = playback.track?.metadata;
  return hashString(
    [
      objects.length,
      Math.round(startTime),
      Math.round(endTime),
      objects[0]?.time ?? 0,
      objects[objects.length - 1]?.endTime ?? 0,
      meta?.Title ?? "",
      meta?.Version ?? "",
    ].join("|"),
  );
}

/** Density and shape analysis, for the panel's pattern readout. */
export function analyseChart(chart: Chart): ChartAnalysis {
  const objects = chart.objects;
  const n = objects.length;
  let longestStream = 0;
  let stream = 0;
  let minGap = Infinity;
  let longestSlider = 0;
  let maxJump = 0;

  for (let i = 0; i < n; i++) {
    const object = objects[i];
    if (object.kind === "slider") {
      const hold = object.endTime - object.time;
      if (hold > longestSlider) longestSlider = hold;
    }
    if (i === 0) {
      stream = 1;
      continue;
    }
    const prev = objects[i - 1];
    const gap = object.time - prev.time;
    if (gap < minGap) minGap = gap;
    if (gap < STREAM_GAP_MS) stream++;
    else stream = 1;
    if (stream > longestStream) longestStream = stream;

    const jump = Math.hypot(object.x - prev.x, object.y - prev.y);
    if (jump > maxJump) maxJump = jump;
  }
  if (n > 0 && stream > longestStream) longestStream = stream;

  // Peak density over a sliding 1s window of hit times.
  let peakNps = 0;
  let left = 0;
  for (let right = 0; right < n; right++) {
    while (objects[right].time - objects[left].time > 1000) left++;
    const window = right - left + 1;
    if (window > peakNps) peakNps = window;
  }

  const spanSeconds = n > 1 ? Math.max((objects[n - 1].time - objects[0].time) / 1000, 1e-6) : 1;

  return {
    circles: chart.circles,
    sliders: chart.sliders,
    spinners: chart.spinners,
    peakNps,
    averageNps: n / spanSeconds,
    longestStream,
    minGap: Number.isFinite(minGap) ? minGap : 0,
    longestSlider,
    maxJump,
  };
}
