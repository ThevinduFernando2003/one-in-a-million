/**
 * Small, pure 2-D physics helpers for the draggable number. Positions are CSS
 * pixel offsets from the element's resting (centred) position. Velocities are
 * px/second and time is in seconds. No DOM access happens here, which keeps
 * it unit-testable and cheap to run inside requestAnimationFrame.
 */

export type Vec = { x: number; y: number };
export type Body = { x: number; y: number; vx: number; vy: number };
export type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
export type Sample = { x: number; y: number; t: number }; // t in ms

export const PHYSICS = {
  /** Exponential velocity decay rate per second (higher = more friction). */
  friction: 1.4,
  /** Fraction of speed kept after bouncing off a wall. */
  restitution: 0.75,
  /** Speed cap (px/s) so a frantic flick can't tunnel through walls. */
  maxSpeed: 7000,
  /** Below this speed (px/s) inertia stops. */
  stopSpeed: 8,
  /** Longest frame step we integrate, so a backgrounded tab doesn't teleport the number. */
  maxDt: 1 / 30,
  /** Velocity sampling window for the fling (ms). */
  sampleWindowMs: 100,
} as const;

export const SPRING = { stiffness: 220, damping: 26, settleDistance: 0.5, settleSpeed: 5 } as const;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Movement limits for an element whose untransformed layout box is `rect`
 * inside a `viewportW` × `viewportH` viewport, so the box always stays fully
 * on screen. If the element is larger than the viewport on an axis, that axis
 * is pinned to its resting position.
 */
export function computeBounds(
  viewportW: number,
  viewportH: number,
  rect: { left: number; top: number; width: number; height: number },
): Bounds {
  let minX = -rect.left;
  let maxX = viewportW - (rect.left + rect.width);
  let minY = -rect.top;
  let maxY = viewportH - (rect.top + rect.height);
  if (maxX < minX) minX = maxX = 0;
  if (maxY < minY) minY = maxY = 0;
  return { minX, maxX, minY, maxY };
}

export function clampToBounds(p: Vec, b: Bounds): Vec {
  return { x: clamp(p.x, b.minX, b.maxX), y: clamp(p.y, b.minY, b.maxY) };
}

/** Cap a velocity's magnitude while keeping its direction. */
export function clampSpeed(vx: number, vy: number, max: number = PHYSICS.maxSpeed): Vec {
  const speed = Math.hypot(vx, vy);
  if (!Number.isFinite(speed) || speed === 0) return { x: 0, y: 0 };
  if (speed <= max) return { x: vx, y: vy };
  const k = max / speed;
  return { x: vx * k, y: vy * k };
}

/**
 * Release velocity from recent pointer samples: the displacement over the
 * last `windowMs`, divided by the elapsed time. Using a window instead of the
 * final two events filters out jittery last-frame deltas.
 */
export function velocityFromSamples(
  samples: readonly Sample[],
  windowMs: number = PHYSICS.sampleWindowMs,
): Vec {
  if (samples.length < 2) return { x: 0, y: 0 };
  const last = samples[samples.length - 1]!;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i]!;
    if (last.t - s.t > windowMs) break;
    first = s;
  }
  const dtMs = last.t - first.t;
  if (dtMs < 1) return { x: 0, y: 0 };
  return clampSpeed(((last.x - first.x) / dtMs) * 1000, ((last.y - first.y) / dtMs) * 1000);
}

export type StepResult = {
  body: Body;
  /** Wall hit this step: "x" for left/right walls, "y" for top/bottom. */
  hit: "x" | "y" | null;
  /** Speed perpendicular to the wall at impact (px/s), for squash intensity. */
  impactSpeed: number;
  /** True once the body has effectively stopped. */
  resting: boolean;
};

/**
 * One inertia step: friction, integration, then reflection off the bounds
 * with restitution. Pure: returns a new body.
 */
export function stepInertia(
  body: Body,
  dtRaw: number,
  bounds: Bounds,
  params: { friction?: number; restitution?: number; stopSpeed?: number } = {},
): StepResult {
  const friction = params.friction ?? PHYSICS.friction;
  const restitution = params.restitution ?? PHYSICS.restitution;
  const stopSpeed = params.stopSpeed ?? PHYSICS.stopSpeed;
  const dt = clamp(dtRaw, 0, PHYSICS.maxDt);

  const decay = Math.exp(-friction * dt);
  let vx = body.vx * decay;
  let vy = body.vy * decay;
  let x = body.x + vx * dt;
  let y = body.y + vy * dt;
  let hit: StepResult["hit"] = null;
  let impactSpeed = 0;

  if (x < bounds.minX) {
    x = bounds.minX + (bounds.minX - x) * restitution;
    impactSpeed = Math.abs(vx);
    vx = Math.abs(vx) * restitution;
    hit = "x";
  } else if (x > bounds.maxX) {
    x = bounds.maxX - (x - bounds.maxX) * restitution;
    impactSpeed = Math.abs(vx);
    vx = -Math.abs(vx) * restitution;
    hit = "x";
  }
  if (y < bounds.minY) {
    y = bounds.minY + (bounds.minY - y) * restitution;
    if (Math.abs(vy) > impactSpeed) {
      impactSpeed = Math.abs(vy);
      hit = "y";
    }
    vy = Math.abs(vy) * restitution;
  } else if (y > bounds.maxY) {
    y = bounds.maxY - (y - bounds.maxY) * restitution;
    if (Math.abs(vy) > impactSpeed) {
      impactSpeed = Math.abs(vy);
      hit = "y";
    }
    vy = -Math.abs(vy) * restitution;
  }
  // A reflection can never land outside the box. Clamp for degenerate bounds.
  x = clamp(x, bounds.minX, bounds.maxX);
  y = clamp(y, bounds.minY, bounds.maxY);

  const resting = Math.hypot(vx, vy) < stopSpeed;
  if (resting) {
    vx = 0;
    vy = 0;
  }
  return { body: { x, y, vx, vy }, hit, impactSpeed, resting };
}

/**
 * Damped spring toward `target`, integrated with semi-implicit Euler in
 * fixed sub-steps for stability at any frame rate. Returns the new body and
 * whether it has settled (in which case it snaps exactly onto the target).
 */
export function stepSpring(
  body: Body,
  target: Vec,
  dtRaw: number,
  params: { stiffness?: number; damping?: number } = {},
): { body: Body; settled: boolean } {
  const k = params.stiffness ?? SPRING.stiffness;
  const c = params.damping ?? SPRING.damping;
  let dt = clamp(dtRaw, 0, PHYSICS.maxDt);
  let { x, y, vx, vy } = body;
  const h = 1 / 240;
  while (dt > 0) {
    const s = Math.min(h, dt);
    vx += (-k * (x - target.x) - c * vx) * s;
    vy += (-k * (y - target.y) - c * vy) * s;
    x += vx * s;
    y += vy * s;
    dt -= s;
  }
  const settled =
    Math.hypot(x - target.x, y - target.y) < SPRING.settleDistance &&
    Math.hypot(vx, vy) < SPRING.settleSpeed;
  if (settled) return { body: { x: target.x, y: target.y, vx: 0, vy: 0 }, settled };
  return { body: { x, y, vx, vy }, settled };
}

/**
 * Squash-and-stretch from velocity: stretch along the motion direction and
 * thin across it, preserving area (sx · sy = 1). Capped at 22%.
 */
export function stretchFromVelocity(
  vx: number,
  vy: number,
): { angle: number; sx: number; sy: number } {
  const speed = Math.hypot(vx, vy);
  if (speed < 1) return { angle: 0, sx: 1, sy: 1 };
  const s = 1 + Math.min(0.22, speed / 9000);
  return { angle: Math.atan2(vy, vx), sx: s, sy: 1 / s };
}

/** Impact squash amount (0..0.3) from the perpendicular impact speed. */
export function impactSquash(impactSpeed: number): number {
  return clamp(impactSpeed / 6000, 0, 0.3);
}

/** Exponential decay of a squash amount toward 0. */
export function decay(value: number, dt: number, rate = 14): number {
  const v = value * Math.exp(-rate * clamp(dt, 0, PHYSICS.maxDt));
  return Math.abs(v) < 0.001 ? 0 : v;
}

/** Two taps count as a double tap if they are close in time and space. */
export function isDoubleTap(
  prev: Sample | null,
  cur: Sample,
  maxDelayMs = 320,
  maxDistancePx = 28,
): boolean {
  if (!prev) return false;
  const dt = cur.t - prev.t;
  return dt > 0 && dt <= maxDelayMs && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= maxDistancePx;
}

/** Keyboard nudge directions. */
export const NUDGE_KEYS: Record<string, Vec> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** New spring target after a keyboard nudge, kept inside the bounds. */
export function nudgeTarget(from: Vec, dir: Vec, step: number, bounds: Bounds): Vec {
  return clampToBounds({ x: from.x + dir.x * step, y: from.y + dir.y * step }, bounds);
}

/** CSS transform for a position plus a directional stretch. Transform only, so no layout. */
export function toTransform(x: number, y: number, angle: number, sx: number, sy: number): string {
  const r = (angle * 180) / Math.PI;
  if (sx === 1 && sy === 1) return `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
  return (
    `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${r.toFixed(2)}deg) ` +
    `scale(${sx.toFixed(4)}, ${sy.toFixed(4)}) rotate(${(-r).toFixed(2)}deg)`
  );
}
