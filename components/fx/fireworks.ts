import { loop, rand, setupCanvas } from "./canvas";

type Rocket = { x: number; y: number; vx: number; vy: number; hue: number; kind: Burst };
type Spark = {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  hue: number;
  light: number;
  glitter: boolean;
};
type Burst = "peony" | "ring" | "willow" | "double";

const GRAVITY = 760; // rocket gravity, px/s²
const SPARK_GRAVITY = 170;

/**
 * A fireworks show: rockets climb with a trail and burst at their apex into
 * peony, ring, willow or double-ring patterns, leaving fading trails.
 *
 * `dark` picks additive blending (glowing light on a dark page). On light
 * pages we draw opaque, deeper colours instead, which stay visible on cream.
 */
export function startFireworks(
  canvas: HTMLCanvasElement,
  opts: { duration: number; rockets: number; dark: boolean; finale?: boolean },
): () => void {
  const surface = setupCanvas(canvas);
  if (!surface) return () => {};
  const { ctx } = surface;
  const rockets: Rocket[] = [];
  const sparks: Spark[] = [];
  const kinds: Burst[] = ["peony", "ring", "willow", "double"];

  // Launch schedule: spread across the show, with a dense finale volley.
  const launches: number[] = [];
  const main = opts.finale ? Math.round(opts.rockets * 0.65) : opts.rockets;
  for (let i = 0; i < main; i++) launches.push((i / main) * (opts.duration - 2.2) + rand(0, 0.3));
  if (opts.finale) {
    for (let i = main; i < opts.rockets; i++) launches.push(opts.duration - 2.4 + rand(0, 0.5));
  }
  launches.sort((a, b) => a - b);
  let next = 0;

  const launch = () => {
    const { w, h } = surface;
    const x = rand(w * 0.12, w * 0.88);
    const apex = rand(h * 0.12, h * 0.42);
    const vy = -Math.sqrt(2 * GRAVITY * (h + 10 - apex));
    rockets.push({
      x,
      y: h + 10,
      vx: rand(-40, 40),
      vy,
      hue: Math.floor(rand(0, 360)),
      kind: kinds[Math.floor(rand(0, kinds.length))]!,
    });
  };

  const explode = (r: Rocket) => {
    const scale = Math.min(surface.w, surface.h) / 800 + 0.6;
    const count = r.kind === "willow" ? 70 : 90;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand(-0.05, 0.05);
      let speed: number;
      if (r.kind === "ring") speed = 260;
      else if (r.kind === "double") speed = i % 2 ? 300 : 160;
      else speed = rand(60, 320);
      speed *= scale;
      const max = r.kind === "willow" ? rand(1.8, 2.6) : rand(1.0, 1.8);
      sparks.push({
        x: r.x,
        y: r.y,
        px: r.x,
        py: r.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: max,
        max,
        hue: r.kind === "double" && i % 2 ? (r.hue + 180) % 360 : r.hue + rand(-12, 12),
        light: opts.dark ? rand(60, 75) : rand(38, 48),
        glitter: Math.random() < 0.25,
      });
    }
  };

  const stop = loop((dt, t) => {
    const { w, h } = surface;
    while (next < launches.length && launches[next]! <= t) {
      launch();
      next++;
    }

    // Fade the previous frame toward transparent to leave trails (canvas
    // stays transparent, so the page shows through).
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = opts.dark ? "lighter" : "source-over";

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i]!;
      const px = r.x;
      const py = r.y;
      r.vy += GRAVITY * dt;
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      ctx.strokeStyle = `hsla(${r.hue},90%,${opts.dark ? 75 : 45}%,0.9)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(r.x, r.y);
      ctx.stroke();
      if (r.vy >= 0) {
        explode(r);
        rockets.splice(i, 1);
      }
    }

    const drag = Math.exp(-1.7 * dt);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i]!;
      p.px = p.x;
      p.py = p.y;
      p.vx *= drag;
      p.vy = p.vy * drag + SPARK_GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      let alpha = Math.min(1, (p.life / p.max) * 1.6);
      if (p.glitter && Math.random() < 0.35) alpha *= 0.2;
      ctx.strokeStyle = `hsla(${p.hue},95%,${p.light}%,${alpha.toFixed(3)})`;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    const running = t < opts.duration || rockets.length > 0 || sparks.length > 0;
    if (!running) ctx.clearRect(0, 0, w, h);
    return running;
  });

  return () => {
    stop();
    surface.dispose();
  };
}
