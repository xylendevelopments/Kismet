/**
 * A miniature webosu! for tests.
 *
 * Mirrors exactly the contract documented in docs/SITE-CONTRACT.md:
 *
 *   window.game      mouseX/mouseY in osu! pixels, down, K1keycode/K2keycode,
 *                    K1down/K2down, autoplay, scene
 *   window.playback  hits[], track.metadata, osu.audio.getPosition(), scoreOverlay,
 *                    GreatTime/GoodTime/MehTime, audioReady, ended
 *   window.gfx       { width, height, xoffset, yoffset }
 *
 * and installs the same listeners the real site installs (`mousemove`,
 * `keydown`, `keyup` on `window`), judging a click the way its
 * `checkClickdown()` does: cursor within the circle radius, and the audio clock
 * within the Meh window.
 *
 * This is deliberately NOT a port of the game. It exists so the engine can be
 * driven end to end under a fake clock, with assertions on what the site would
 * have judged.
 */

import type { StubEnvironment } from "./domStub";

export interface FakeObject {
  type: "circle" | "slider" | "spinner";
  x: number;
  y: number;
  time: number;
  endTime?: number;
  /** Slider only: duration of one span, ms. */
  sliderTime?: number;
  repeat?: number;
  /** Slider only: end point of the first span (a straight line is assumed). */
  endX?: number;
  endY?: number;
}

export interface JudgedClick {
  time: number;
  x: number;
  y: number;
  diff: number;
  objectIndex: number;
  points: number;
}

export interface FakeSite {
  window: any;
  game: any;
  playback: any;
  /** Advance the site's audio clock by `ms` (song time). */
  advanceAudio(ms: number): void;
  /** Set the audio clock to an absolute song time, ms. */
  setAudio(ms: number): void;
  audioMs(): number;
  judged: JudgedClick[];
  /** Cursor positions the site saw, in osu! pixels, with their audio time. */
  moves: Array<{ time: number; x: number; y: number }>;
  /** Keys the site saw, by keyCode. */
  keys: Array<{ type: "keydown" | "keyup"; keyCode: number; time: number }>;
  /** Set while the site believes a gameplay key is down. */
  isDown(): boolean;
  /** Worst distance from a slider's expected ball position while it was held. */
  sliderError: number;
  dispose(): void;
}

/** A straight-line slider curve with `pointAt`, like the site's SliderMesh. */
function straightCurve(from: { x: number; y: number }, to: { x: number; y: number }) {
  return {
    pointAt(t: number): { x: number; y: number } {
      return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      };
    },
  };
}

export function createSite(
  env: StubEnvironment,
  options: {
    objects: FakeObject[];
    k1?: number;
    k2?: number;
    od?: number;
    autoplay?: boolean;
    /** Playfield geometry; defaults to a letterboxed 4:3 area. */
    gfx?: { width: number; height: number; xoffset: number; yoffset: number };
    title?: string;
  },
): FakeSite {
  const win = env.window;
  const k1 = options.k1 ?? 90;
  const k2 = options.k2 ?? 88;
  const od = options.od ?? 8;
  const gfx = options.gfx ?? { width: 800, height: 600, xoffset: 100, yoffset: 50 };

  const great = 80 - 6 * od;
  const good = 140 - 8 * od;
  const meh = 200 - 10 * od;
  const circleRadius = (109 - 9 * 4) / 2;

  const audio = {
    position: 0,
    playing: true,
    getPosition(): number {
      return this.position;
    },
  };

  const hits = options.objects.map((object) => {
    const time = object.time;
    const endTime = object.endTime ?? time;
    const hit: Record<string, unknown> = {
      type: object.type,
      x: object.x,
      y: object.y,
      time,
      endTime,
      score: -1,
    };
    if (object.type === "slider") {
      hit.sliderTime = object.sliderTime ?? 300;
      hit.repeat = object.repeat ?? 1;
      hit.sliderTimeTotal = (hit.sliderTime as number) * (hit.repeat as number);
      hit.curve = straightCurve(
        { x: object.x, y: object.y },
        { x: object.endX ?? object.x, y: object.endY ?? object.y },
      );
    }
    return hit;
  });

  const scoreOverlay = {
    score: 0,
    combo: 0,
    judgecnt: { great: 0, good: 0, meh: 0, miss: 0 },
    judgeTotal: 0,
    maxJudgeTotal: 0,
  };

  const playback: any = {
    hits,
    track: {
      metadata: { Title: options.title ?? "Test Song", Artist: "Test Artist", Version: "Insane" },
      difficulty: { OverallDifficulty: od, ApproachRate: od, CircleSize: 4, HPDrainRate: 5 },
      hitObjects: hits,
    },
    osu: { audio },
    scoreOverlay,
    audioReady: true,
    ended: false,
    GreatTime: great,
    GoodTime: good,
    MehTime: meh,
    circleRadius,
    offset: 0,
  };

  const game: any = {
    scene: playback,
    window: win,
    mouseX: 256,
    mouseY: 192,
    down: false,
    K1keycode: k1,
    K2keycode: k2,
    K1down: false,
    K2down: false,
    allowMouseButton: false,
    autoplay: options.autoplay === true,
  };

  win.gfx = gfx;
  win.game = game;
  win.playback = playback;

  const judged: JudgedClick[] = [];
  const moves: Array<{ time: number; x: number; y: number }> = [];
  const keys: Array<{ type: "keydown" | "keyup"; keyCode: number; time: number }> = [];
  const state = { sliderError: 0 };

  function refreshDown(): void {
    game.down = game.K1down || game.K2down;
  }

  function checkClickdown(): void {
    const now = audio.position * 1000;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i] as any;
      if (hit.time > now + meh || hit.time < now - meh) continue;
      if (hit.score >= 0) continue;
      const dx = game.mouseX - hit.x;
      const dy = game.mouseY - hit.y;
      if (dx * dx + dy * dy > circleRadius * circleRadius) continue;
      const diff = now - hit.time;
      if (Math.abs(diff) >= meh) continue;
      const points = Math.abs(diff) < great ? 300 : Math.abs(diff) < good ? 100 : 50;
      hit.score = points;
      judged.push({ time: now, x: game.mouseX, y: game.mouseY, diff, objectIndex: i, points });
      scoreOverlay.judgecnt.great += points === 300 ? 1 : 0;
      scoreOverlay.judgecnt.good += points === 100 ? 1 : 0;
      scoreOverlay.judgecnt.meh += points === 50 ? 1 : 0;
      scoreOverlay.combo += 1;
      scoreOverlay.score += points;
      scoreOverlay.judgeTotal += points;
      scoreOverlay.maxJudgeTotal += 300;
      return;
    }
  }

  const onMove = (event: any): void => {
    game.mouseX = ((event.clientX - gfx.xoffset) / gfx.width) * 512;
    game.mouseY = ((event.clientY - gfx.yoffset) / gfx.height) * 384;
    const now = audio.position * 1000;
    moves.push({ time: now, x: game.mouseX, y: game.mouseY });
    // Track how well we follow an active slider, the way the site's
    // `updateSlider` does when it decides `isfollowing`.
    for (const hit of hits as any[]) {
      if (hit.type !== "slider") continue;
      if (now < hit.time || now > hit.endTime) continue;
      if (!game.down) continue;
      const total = hit.sliderTimeTotal as number;
      const t = Math.min(1, Math.max(0, (now - hit.time) / total));
      const point = hit.curve.pointAt(t);
      const error = Math.hypot(game.mouseX - point.x, game.mouseY - point.y);
      if (error > state.sliderError) state.sliderError = error;
    }
  };

  const onKeyDown = (event: any): void => {
    const keyCode = Number(event.keyCode);
    // The site reads the live globals on every event, so a mid-play rebind
    // takes effect immediately.
    const k1 = game.K1keycode;
    const k2 = game.K2keycode;
    keys.push({ type: "keydown", keyCode, time: audio.position * 1000 });
    if (keyCode === k1) {
      if (game.K1down) return;
      game.K1down = true;
    } else if (keyCode === k2) {
      if (game.K2down) return;
      game.K2down = true;
    } else return;
    refreshDown();
    checkClickdown();
  };

  const onKeyUp = (event: any): void => {
    const keyCode = Number(event.keyCode);
    const k1 = game.K1keycode;
    const k2 = game.K2keycode;
    keys.push({ type: "keyup", keyCode, time: audio.position * 1000 });
    if (keyCode === k1) game.K1down = false;
    else if (keyCode === k2) game.K2down = false;
    else return;
    refreshDown();
  };

  win.addEventListener("mousemove", onMove);
  win.addEventListener("keydown", onKeyDown);
  win.addEventListener("keyup", onKeyUp);

  return {
    window: win,
    game,
    playback,
    advanceAudio(ms: number): void {
      audio.position += ms / 1000;
    },
    setAudio(ms: number): void {
      audio.position = ms / 1000;
    },
    audioMs(): number {
      return audio.position * 1000;
    },
    judged,
    moves,
    keys,
    isDown(): boolean {
      return game.K1down === true || game.K2down === true;
    },
    get sliderError(): number {
      return state.sliderError;
    },
    dispose(): void {
      win.removeEventListener("mousemove", onMove);
      win.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("keyup", onKeyUp);
      delete win.game;
      delete win.playback;
      delete win.gfx;
    },
  };
}
