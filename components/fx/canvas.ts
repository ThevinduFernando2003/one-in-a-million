/**
 * Tiny canvas helpers shared by the celebration effects. Everything is drawn
 * in CSS pixels, with the backing store scaled by devicePixelRatio (capped at
 * 2 to keep phones at 60fps).
 */

export type Surface = {
  ctx: CanvasRenderingContext2D;
  /** CSS pixel size. */
  w: number;
  h: number;
  dispose: () => void;
};

export function setupCanvas(canvas: HTMLCanvasElement): Surface | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const surface: Surface = { ctx, w: 0, h: 0, dispose: () => {} };
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    surface.w = window.innerWidth;
    surface.h = window.innerHeight;
    canvas.width = Math.round(surface.w * dpr);
    canvas.height = Math.round(surface.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);
  surface.dispose = () => window.removeEventListener("resize", resize);
  return surface;
}

/**
 * Run `step(dt, elapsed)` every animation frame until it returns false or
 * the returned cancel function is called. dt is capped so a background tab
 * doesn't produce one giant step.
 */
export function loop(step: (dt: number, elapsed: number) => boolean): () => void {
  let raf = 0;
  let start = 0;
  let last = 0;
  let stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    if (!start) start = last = now;
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    if (step(dt, (now - start) / 1000)) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}

/** A pre-rendered soft glow sprite. drawImage is far cheaper than shadowBlur. */
export function glowSprite(rgb: string, size = 32): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.25, `rgba(${rgb},0.8)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
