/**
 * A miniature webosu! for the sandbox demo.
 *
 * It is NOT the real game. It implements just enough of the contract
 * (docs/SITE-CONTRACT.md) for the real, unmodified Kismet bundle to detect a
 * chart and play it with its own synthetic input:
 *
 *   window.game      mouseX/mouseY (osu! pixels), down, K1keycode/K2keycode,
 *                    K1down/K2down, autoplay, scene
 *   window.playback  hits[], track.metadata/difficulty, osu.audio.getPosition(),
 *                    scoreOverlay, GreatTime/GoodTime/MehTime, audioReady, ended
 *   window.gfx       { width, height, xoffset, yoffset }
 *
 * and the same listeners the site installs: `mousemove`, `keydown`, `keyup` on
 * `window`, comparing `keyCode` and never looking at `isTrusted`.
 *
 * Judging mirrors the site: a click scores if the cursor is within the circle
 * radius and the audio clock is inside the Meh window; sliders are followed for
 * their whole body; spinners accumulate rotation.
 */
(function () {
  "use strict";

  const PLAYFIELD = { width: 512, height: 384 };
  const CIRCLE_RADIUS = (109 - 9 * 4) / 2;

  /* ------------------------------- charts -------------------------------- */

  /** @param {string} text "x,y,time[,endX,endY,repeat]" per line */
  function readChart(text) {
    const objects = [];
    for (const raw of text.trim().split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(/\s+/);
      const kind = parts[0];
      const n = parts.slice(1).map(Number);
      if (kind === "c") {
        objects.push({ type: "circle", x: n[0], y: n[1], time: n[2] });
      } else if (kind === "s") {
        const [x, y, time, endX, endY, repeat = 1] = n;
        objects.push({
          type: "slider", x, y, time, endX, endY, repeat,
          sliderTime: 480, sliderTimeTotal: 480 * repeat, endTime: time + 480 * repeat,
        });
      } else if (kind === "p") {
        objects.push({ type: "spinner", x: PLAYFIELD.width / 2, y: PLAYFIELD.height / 2, time: n[0], endTime: n[1] });
      }
    }
    objects.sort((a, b) => a.time - b.time);
    for (const object of objects) {
      if (object.type === "slider") object.endTime ??= object.time + object.sliderTimeTotal;
      if (object.type !== "slider") object.endTime ??= object.time;
    }
    return objects;
  }

  const CHARTS = {
    "Warm Up [Easy]": {
      artist: "Kismet",
      title: "Warm Up",
      version: "Easy",
      od: 6,
      objects: readChart(`
        c 120 120 1000
        c 380 260 1600
        s 100 300 2200 400 300 1
        c 256 192 3100
        c 200 120 3500
        c 320 260 3900
        p 4600 5600
        c 256 192 6300
      `),
    },
    "Stream [Hard]": {
      artist: "Kismet",
      title: "Stream",
      version: "Hard",
      od: 8,
      objects: readChart(`
        c 80 80 1000
        c 160 120 1200
        c 240 160 1400
        c 320 200 1600
        c 400 240 1800
        s 420 120 2000 120 320 2
        c 300 300 2900
        c 200 260 3050
        c 120 220 3200
        c 200 260 3350
        c 300 300 3500
        s 100 120 3800 420 120 1
        p 4700 5800
        c 256 192 6300
        c 180 150 6500
        c 340 240 6700
        c 256 300 6900
      `),
    },
    "Jump Practice [Insane]": {
      artist: "Kismet",
      title: "Jump Practice",
      version: "Insane",
      od: 9,
      objects: readChart(`
        c 60 60 1000
        c 450 320 1200
        c 60 320 1400
        c 450 60 1600
        s 60 60 1800 450 320 1
        c 256 192 2500
        c 60 320 2700
        c 450 60 2900
        s 450 60 3100 60 320 2
        c 300 200 3900
        c 200 200 4050
        c 300 200 4200
        c 200 200 4350
        p 4700 5900
        c 100 100 6400
        c 412 284 6600
        c 100 284 6800
        c 412 100 7000
      `),
    },
  };

  /* -------------------------------- helpers ------------------------------ */

  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
  const unwrap = (delta) => {
    let d = delta;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  };

  /** A straight-line slider curve with `pointAt`, like the site's SliderMesh. */
  function straightCurve(from, to) {
    return {
      pointAt(t) {
        const k = clamp(t, 0, 1);
        return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      },
    };
  }

  /* --------------------------------- game -------------------------------- */

  class StubGame {
    constructor(name) {
      const def = CHARTS[name];
      if (!def) throw new Error(`unknown chart: ${name}`);
      this.name = name;
      this.def = def;

      this.gfx = { width: PLAYFIELD.width, height: PLAYFIELD.height, xoffset: 0, yoffset: 0 };
      this.dpr = 1;

      this.hits = def.objects.map((object, index) => {
        const hit = { ...object, index, score: -1, ticks: 0, rotation: 0, lastAngle: null };
        if (hit.type === "slider") {
          hit.curve = straightCurve({ x: hit.x, y: hit.y }, { x: hit.endX, y: hit.endY });
          hit.sliderTime = hit.sliderTime ?? 480;
          hit.repeat = hit.repeat ?? 1;
          hit.sliderTimeTotal = hit.sliderTime * hit.repeat;
        }
        return hit;
      });

      const od = def.od ?? 8;
      this.great = 80 - 6 * od;
      this.good = 140 - 8 * od;
      this.meh = 200 - 10 * od;

      this.scoreOverlay = {
        score: 0,
        combo: 0,
        maxCombo: 0,
        accuracy: 1,
        judgeTotal: 0,
        maxJudgeTotal: 0,
        judgecnt: { great: 0, good: 0, meh: 0, miss: 0 },
      };

      this.audio = {
        position: 0,
        _p0: 0,
        _t0: 0,
        playing: false,
        getPosition() {
          return this.playing ? this._p0 + (performance.now() - this._t0) / 1000 : this.position;
        },
        play(at) {
          this._p0 = at ?? this.position;
          this._t0 = performance.now();
          this.playing = true;
        },
        pause() {
          this.position = this.getPosition();
          this.playing = false;
        },
      };

      this.playback = {
        hits: this.hits,
        track: {
          metadata: { Title: def.title, Artist: def.artist, Creator: "Kismet", Version: def.version },
          difficulty: {
            OverallDifficulty: od,
            ApproachRate: od + 1,
            CircleSize: 4,
            HPDrainRate: 5,
          },
        },
        osu: {
          audio: this.audio,
          // The demo has no beatmap audio; the HUD and judgement only need time.
          getOrDefaultAudio: () => this.audio,
        },
        scoreOverlay: this.scoreOverlay,
        audioReady: true,
        ended: false,
        GreatTime: this.great,
        GoodTime: this.good,
        MehTime: this.meh,
        offset: 0,
        exit: (reason) => this.exit(reason),
      };

      this.game = {
        scene: this.playback,
        window,
        mouseX: 256,
        mouseY: 192,
        down: false,
        K1keycode: 90,
        K2keycode: 88,
        K1down: false,
        K2down: false,
        allowMouseButton: false,
        autoplay: false,
        scoreOverlay: this.scoreOverlay,
      };

      this.onResults = null;
      this.onFrame = null;
      this.canvas = null;
      this.ctx = null;
      this.raf = 0;
      this.disposed = false;
      this.startedAt = 0;

      this._onMove = (event) => this.handleMove(event);
      this._onDown = (event) => this.handleKeyDown(event);
      this._onUp = (event) => this.handleKeyUp(event);
    }

    /* ------------------------------ lifecycle ---------------------------- */

    mount(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      window.gfx = this.gfx;
      window.playback = this.playback;
      window.game = this.game;

      window.addEventListener("mousemove", this._onMove);
      window.addEventListener("keydown", this._onDown);
      window.addEventListener("keyup", this._onUp);

      this.resize();
      this.loop = () => {
        if (this.disposed) return;
        this.update();
        this.render();
        this.raf = requestAnimationFrame(this.loop);
      };
      this.raf = requestAnimationFrame(this.loop);
    }

    start() {
      this.audio.position = 0;
      this.startedAt = performance.now();
      this.audio.play(0);
    }

    pause() {
      this.audio.pause();
    }

    resume() {
      this.audio.play(this.audio.position);
    }

    /** The song ran out: wait a beat, then hand the results back. */
    update() {
      this.updateSpinner();
      const now = this.audio.getPosition() * 1000;
      if (!this.playback.ended && now > this.endTime() + 1200) {
        this.playback.ended = true;
        this.audio.pause();
        this.onResults?.(this.summary());
      }
    }

    endTime() {
      return this.hits.reduce((max, hit) => Math.max(max, hit.endTime ?? hit.time), 0);
    }

    summary() {
      const counts = this.scoreOverlay.judgecnt;
      const total = counts.great + counts.good + counts.meh + counts.miss;
      return {
        score: this.scoreOverlay.score,
        accuracy: this.scoreOverlay.maxJudgeTotal > 0
          ? this.scoreOverlay.judgeTotal / this.scoreOverlay.maxJudgeTotal
          : 1,
        maxCombo: this.scoreOverlay.maxCombo,
        counts,
        total,
      };
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      cancelAnimationFrame(this.raf);
      window.removeEventListener("mousemove", this._onMove);
      window.removeEventListener("keydown", this._onDown);
      window.removeEventListener("keyup", this._onUp);
      this.audio.pause();
      this.releaseKeys();
      delete window.game;
      delete window.playback;
      delete window.gfx;
    }

    /** Called by the demo's Quit button; the site closes the play scene. */
    exit() {
      this.dispose();
    }

    /* -------------------------------- input ------------------------------ */

    resize() {
      if (!this.canvas) return;
      const width = window.innerWidth;
      const height = window.innerHeight;
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.floor(width * this.dpr);
      this.canvas.height = Math.floor(height * this.dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;

      // Letterbox a 4:3 playfield, exactly like the site does.
      const scale = Math.min(width / PLAYFIELD.width, height / PLAYFIELD.height);
      this.gfx.width = Math.round(PLAYFIELD.width * scale);
      this.gfx.height = Math.round(PLAYFIELD.height * scale);
      this.gfx.xoffset = Math.round((width - this.gfx.width) / 2);
      this.gfx.yoffset = Math.round((height - this.gfx.height) / 2);
      this.gfx.scale = scale;
    }

    handleMove(event) {
      const gfx = this.gfx;
      this.game.mouseX = ((event.clientX - gfx.xoffset) / gfx.width) * PLAYFIELD.width;
      this.game.mouseY = ((event.clientY - gfx.yoffset) / gfx.height) * PLAYFIELD.height;

      // The site's `updateSlider`: while the button is down and a slider is
      // active, a cursor near the ball keeps it following.
      if (this.game.down) this.followSlider();
    }

    handleKeyDown(event) {
      if (event.repeat) return;
      const keyCode = event.keyCode;
      if (keyCode !== this.game.K1keycode && keyCode !== this.game.K2keycode) return;

      if (keyCode === this.game.K1keycode) {
        if (this.game.K1down) return;
        this.game.K1down = true;
      } else {
        if (this.game.K2down) return;
        this.game.K2down = true;
      }
      this.game.down = true;
      this.checkClickdown();
    }

    handleKeyUp(event) {
      const keyCode = event.keyCode;
      if (keyCode === this.game.K1keycode) this.game.K1down = false;
      else if (keyCode === this.game.K2keycode) this.game.K2down = false;
      else return;
      this.game.down = this.game.K1down || this.game.K2down;
      if (!this.game.down) {
        // Releasing completes any slider that was being followed.
        for (const hit of this.hits) {
          if (hit.type === "slider" && hit.following) hit.following = false;
        }
      }
    }

    releaseKeys() {
      this.game.K1down = false;
      this.game.K2down = false;
      this.game.down = false;
    }

    /* ------------------------------ judgement ---------------------------- */

    now() {
      return this.audio.getPosition() * 1000;
    }

    judge(points, hit) {
      const overlay = this.scoreOverlay;
      hit.score = points;
      if (points > 0) {
        overlay.judgecnt.great += points === 300 ? 1 : 0;
        overlay.judgecnt.good += points === 100 ? 1 : 0;
        overlay.judgecnt.meh += points === 50 ? 1 : 0;
        overlay.combo += 1;
        overlay.maxCombo = Math.max(overlay.maxCombo, overlay.combo);
        overlay.score += points;
        overlay.judgeTotal += points;
      } else {
        overlay.judgecnt.miss += 1;
        overlay.combo = 0;
      }
      overlay.maxJudgeTotal += 300;
      overlay.accuracy = overlay.maxJudgeTotal > 0 ? overlay.judgeTotal / overlay.maxJudgeTotal : 1;
    }

    checkClickdown() {
      const now = this.now();
      for (const hit of this.hits) {
        if (hit.score >= 0) continue;
        if (hit.time > now + this.meh || hit.time < now - this.meh) continue;

        const dx = this.game.mouseX - hit.x;
        const dy = this.game.mouseY - hit.y;
        if (dx * dx + dy * dy > CIRCLE_RADIUS * CIRCLE_RADIUS) continue;

        if (hit.type === "spinner") continue;
        const diff = now - hit.time;
        if (Math.abs(diff) >= this.meh) continue;

        const points = Math.abs(diff) < this.great ? 300 : Math.abs(diff) < this.good ? 100 : 50;
        this.judge(points, hit);
        if (hit.type === "slider") hit.following = true;
        return;
      }
    }

    sliderPoint(hit, at) {
      const total = Math.max(1, hit.sliderTimeTotal);
      const t = clamp((at - hit.time) / total, 0, 1);
      const span = clamp(Math.floor(t * hit.repeat), 0, hit.repeat - 1);
      const within = clamp(t * hit.repeat - span, 0, 1);
      return hit.curve.pointAt(span % 2 === 0 ? within : 1 - within);
    }

    followSlider() {
      const now = this.now();
      for (const hit of this.hits) {
        if (hit.type !== "slider" || !hit.following) continue;
        if (now < hit.time || now > hit.endTime + 40) {
          hit.following = false;
          continue;
        }
        const point = this.sliderPoint(hit, now);
        const distance = Math.hypot(this.game.mouseX - point.x, this.game.mouseY - point.y);
        if (distance <= 60) {
          hit.ticks += 1; // the site's tick counter, for the HUD only
        }
      }
    }

    updateSpinner() {
      const now = this.now();
      for (const hit of this.hits) {
        if (hit.type !== "spinner") continue;
        if (now < hit.time || now > hit.endTime) continue;
        if (hit.score >= 0) continue;
        if (!this.game.down) continue;
        const angle = Math.atan2(this.game.mouseY - hit.y, this.game.mouseX - hit.x);
        if (hit.lastAngle !== null) {
          hit.rotation += Math.abs(unwrap(angle - hit.lastAngle));
        }
        hit.lastAngle = angle;
        if (hit.rotation >= Math.PI * 2.6) this.judge(300, hit);
      }

      // Anything that never got clicked misses once its window closes.
      for (const hit of this.hits) {
        if (hit.score >= 0) continue;
        if (hit.type === "spinner") {
          if (now > hit.endTime + 200) this.judge(0, hit);
        } else if (now > hit.time + this.meh) {
          this.judge(0, hit);
        }
      }
    }

    /* ------------------------------- drawing ----------------------------- */

    toScreen(x, y) {
      const gfx = this.gfx;
      return { x: gfx.xoffset + (x / PLAYFIELD.width) * gfx.width, y: gfx.yoffset + (y / PLAYFIELD.height) * gfx.height };
    }

    render() {
      const ctx = this.ctx;
      if (!ctx) return;
      const { width, height } = this.canvas;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      ctx.fillStyle = "#0b0c10";
      ctx.fillRect(0, 0, width, height);

      const gfx = this.gfx;
      ctx.save();
      ctx.translate(gfx.xoffset, gfx.yoffset);
      const k = gfx.width / PLAYFIELD.width;
      ctx.scale(k, k);

      // Backdrop.
      const bg = ctx.createLinearGradient(0, 0, PLAYFIELD.width, PLAYFIELD.height);
      bg.addColorStop(0, "#1a1526");
      bg.addColorStop(1, "#241a35");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, PLAYFIELD.width, PLAYFIELD.height);
      ctx.strokeStyle = "rgba(255,255,255,.06)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, PLAYFIELD.width - 1, PLAYFIELD.height - 1);

      const now = this.now();
      const approach = 600;

      for (const hit of this.hits) {
        if (now > (hit.endTime ?? hit.time) + 500) continue;
        if (now < hit.time - approach - 400) continue;

        if (hit.type === "slider") this.drawSlider(ctx, hit, now);
        else if (hit.type === "spinner") this.drawSpinner(ctx, hit, now);
        else this.drawCircle(ctx, hit, now, approach);
      }

      this.drawCursor(ctx);
      ctx.restore();

      this.drawHud(ctx, width / this.dpr, height / this.dpr);
    }

    drawCircle(ctx, hit, now) {
      const done = hit.score >= 0;
      const alpha = done ? 0.25 : 1;
      ctx.globalAlpha = alpha;

      ctx.beginPath();
      ctx.arc(hit.x, hit.y, CIRCLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,107,157,.18)";
      ctx.fill();
      ctx.strokeStyle = "#ff6b9d";
      ctx.lineWidth = 3;
      ctx.stroke();

      // Approach circle.
      if (!done) {
        const t = clamp((hit.time - now) / 600, 0, 1);
        ctx.beginPath();
        ctx.arc(hit.x, hit.y, CIRCLE_RADIUS * (1 + t * 1.6), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(245,240,251,${0.15 + (1 - t) * 0.65})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    drawSlider(ctx, hit, now) {
      const done = hit.score >= 0;
      ctx.globalAlpha = done ? 0.28 : 1;

      // Path, unrolled so repeats are visible.
      ctx.beginPath();
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const point = this.sliderPoint(hit, hit.time + (hit.sliderTimeTotal * i) / steps);
        if (i === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.strokeStyle = "rgba(120,180,255,.35)";
      ctx.lineWidth = CIRCLE_RADIUS * 2;
      ctx.lineCap = "round";
      ctx.stroke();

      ctx.strokeStyle = "rgba(160,210,255,.75)";
      ctx.lineWidth = 3;
      ctx.stroke();

      // Head circle.
      ctx.beginPath();
      ctx.arc(hit.x, hit.y, CIRCLE_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = "#7fb2ff";
      ctx.lineWidth = 3;
      ctx.stroke();

      // Ball.
      if (!done && now >= hit.time && now <= hit.endTime) {
        const ball = this.sliderPoint(hit, now);
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, CIRCLE_RADIUS * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = "#d9ecff";
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    drawSpinner(ctx, hit, now) {
      const done = hit.score >= 0;
      const active = now >= hit.time && now <= hit.endTime;
      ctx.globalAlpha = done ? 0.25 : 1;

      ctx.beginPath();
      ctx.arc(hit.x, hit.y, 60, 0, Math.PI * 2);
      ctx.strokeStyle = active ? "#ffd479" : "rgba(255,212,121,.4)";
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(hit.x, hit.y, 34, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,212,121,.5)";
      ctx.stroke();

      ctx.fillStyle = "rgba(255,212,121,.85)";
      ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("SPIN", hit.x, hit.y + 4);
      ctx.globalAlpha = 1;
    }

    drawCursor(ctx) {
      const { mouseX, mouseY } = this.game;
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, this.game.down ? 13 : 11, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,.12)";
      ctx.fill();
      ctx.strokeStyle = this.game.down ? "#ffd479" : "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    drawHud(ctx, width, height) {
      const overlay = this.scoreOverlay;
      const accuracy = overlay.maxJudgeTotal > 0 ? overlay.judgeTotal / overlay.maxJudgeTotal : 1;

      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(232,233,239,.92)";
      ctx.font = "700 20px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(overlay.score.toLocaleString(), 22, 40);

      ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(154,156,171,.95)";
      ctx.fillText(`${(accuracy * 100).toFixed(2)}%`, 22, 60);

      ctx.textAlign = "center";
      ctx.font = "700 26px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.fillText(overlay.combo > 0 ? `${overlay.combo}x` : "", width / 2, height - 84);

      ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = "rgba(107,109,123,.95)";
      const counts = overlay.judgecnt;
      ctx.fillText(
        `300 ${counts.great}   100 ${counts.good}   50 ${counts.meh}   miss ${counts.miss}`,
        width / 2,
        height - 62,
      );
      ctx.fillText(`tap keys: ${String.fromCharCode(this.game.K1keycode)} / ${String.fromCharCode(this.game.K2keycode)}`, width / 2, height - 46);
    }
  }

  window.STUB_CHARTS = Object.keys(CHARTS);
  window.STUB_CHART_INFO = CHARTS;
  window.StubGame = StubGame;
  window.STUB_PLAYFIELD = PLAYFIELD;
})();
