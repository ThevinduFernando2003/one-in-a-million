import { glowSprite, loop, rand, setupCanvas } from "./canvas";

type Star = { x: number; y: number; r: number; phase: number; speed: number };
type Mote = {
  x: number;
  y: number;
  vy: number;
  sway: number;
  phase: number;
  size: number;
  life: number;
  max: number;
};

/**
 * The "legendary" layer: a twinkling starfield (the galaxy) plus warm gold
 * motes that drift upward and sway. Drawn with pre-rendered glow sprites,
 * so there is no per-particle shadowBlur.
 */
export function startLegendary(
  canvas: HTMLCanvasElement,
  opts: { duration: number; dark: boolean; intensity?: number },
): () => void {
  const surface = setupCanvas(canvas);
  if (!surface) return () => {};
  const { ctx } = surface;
  const intensity = opts.intensity ?? 1;
  const goldSprite = glowSprite(opts.dark ? "245,197,66" : "183,121,31", 48);
  const starSprite = glowSprite(opts.dark ? "255,255,255" : "146,94,14", 16);

  const area = surface.w * surface.h;
  const stars: Star[] = Array.from({ length: Math.min(220, Math.round(area / 7000)) }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: rand(3, 9),
    phase: rand(0, Math.PI * 2),
    speed: rand(1.2, 3.2),
  }));
  const motes: Mote[] = [];
  const spawnRate = Math.min(90, area / 14000) * intensity; // motes per second
  let spawnAcc = 0;

  const stop = loop((dt, t) => {
    const { w, h } = surface;
    ctx.clearRect(0, 0, w, h);
    // Fade the whole layer in and out.
    const env = Math.min(1, t / 0.8) * Math.min(1, Math.max(0, (opts.duration - t) / 1.2));
    ctx.globalCompositeOperation = opts.dark ? "lighter" : "source-over";

    for (const s of stars) {
      const a = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(s.phase + t * s.speed))) * env;
      ctx.globalAlpha = a;
      ctx.drawImage(starSprite, s.x * w - s.r / 2, s.y * h - s.r / 2, s.r, s.r);
    }

    if (t < opts.duration - 1) {
      spawnAcc += spawnRate * dt;
      while (spawnAcc >= 1) {
        spawnAcc--;
        const max = rand(2.5, 5);
        motes.push({
          x: rand(0, w),
          y: h + 10,
          vy: -rand(50, 140),
          sway: rand(10, 40),
          phase: rand(0, Math.PI * 2),
          size: rand(8, 22),
          life: max,
          max,
        });
      }
    }
    for (let i = motes.length - 1; i >= 0; i--) {
      const m = motes[i]!;
      m.life -= dt;
      m.y += m.vy * dt;
      if (m.life <= 0 || m.y < -20) {
        motes.splice(i, 1);
        continue;
      }
      const x = m.x + Math.sin(m.phase + t * 1.6) * m.sway;
      const fade = Math.min(1, m.life / 0.8, (m.max - m.life) / 0.4);
      ctx.globalAlpha = fade * env * (0.6 + 0.4 * Math.sin(m.phase + t * 5));
      ctx.drawImage(goldSprite, x - m.size / 2, m.y - m.size / 2, m.size, m.size);
    }
    ctx.globalAlpha = 1;
    return t < opts.duration;
  });

  return () => {
    stop();
    surface.dispose();
  };
}
