import { describe, expect, it } from "vitest";
import {
  clampSpeed,
  clampToBounds,
  computeBounds,
  decay,
  impactSquash,
  isDoubleTap,
  nudgeTarget,
  PHYSICS,
  stepInertia,
  stepSpring,
  stretchFromVelocity,
  toTransform,
  velocityFromSamples,
  type Body,
  type Bounds,
} from "@/lib/physics";

const box: Bounds = { minX: -100, maxX: 100, minY: -50, maxY: 50 };

describe("computeBounds", () => {
  it("keeps the element fully inside the viewport", () => {
    // 200x100 element centred in a 1000x600 viewport.
    const b = computeBounds(1000, 600, { left: 400, top: 250, width: 200, height: 100 });
    expect(b).toEqual({ minX: -400, maxX: 400, minY: -250, maxY: 250 });
  });

  it("pins an axis when the element is larger than the viewport", () => {
    const b = computeBounds(300, 600, { left: -50, top: 250, width: 400, height: 100 });
    expect(b.minX).toBe(0);
    expect(b.maxX).toBe(0);
    expect(b.minY).toBe(-250);
  });
});

describe("velocityFromSamples", () => {
  it("returns zero with fewer than two samples", () => {
    expect(velocityFromSamples([])).toEqual({ x: 0, y: 0 });
    expect(velocityFromSamples([{ x: 1, y: 1, t: 0 }])).toEqual({ x: 0, y: 0 });
  });

  it("measures px/s over the recent window only", () => {
    const v = velocityFromSamples([
      { x: 0, y: 0, t: 0 }, // older than the 100 ms window, ignored
      { x: 100, y: 0, t: 200 },
      { x: 150, y: 25, t: 250 },
      { x: 200, y: 50, t: 300 },
    ]);
    expect(v.x).toBeCloseTo(1000, 6); // 100 px over 100 ms
    expect(v.y).toBeCloseTo(500, 6);
  });

  it("ignores zero time deltas", () => {
    expect(
      velocityFromSamples([
        { x: 0, y: 0, t: 10 },
        { x: 50, y: 0, t: 10 },
      ]),
    ).toEqual({ x: 0, y: 0 });
  });

  it("caps the fling speed", () => {
    const v = velocityFromSamples([
      { x: 0, y: 0, t: 0 },
      { x: 10_000, y: 0, t: 10 },
    ]);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(PHYSICS.maxSpeed, 6);
  });
});

describe("clampSpeed / clampToBounds", () => {
  it("keeps direction while capping magnitude", () => {
    const v = clampSpeed(3000, 4000, 1000);
    expect(v.x).toBeCloseTo(600);
    expect(v.y).toBeCloseTo(800);
    expect(clampSpeed(3, 4, 1000)).toEqual({ x: 3, y: 4 });
    expect(clampSpeed(Number.NaN, 0)).toEqual({ x: 0, y: 0 });
  });

  it("clamps points into bounds", () => {
    expect(clampToBounds({ x: 500, y: -500 }, box)).toEqual({ x: 100, y: -50 });
    expect(clampToBounds({ x: 10, y: 10 }, box)).toEqual({ x: 10, y: 10 });
  });
});

describe("stepInertia", () => {
  it("applies friction: speed decays exponentially", () => {
    const r = stepInertia({ x: 0, y: 0, vx: 100, vy: 0 }, 1 / 60, box);
    expect(r.body.vx).toBeCloseTo(100 * Math.exp(-PHYSICS.friction / 60), 6);
    expect(r.body.x).toBeGreaterThan(0);
    expect(r.hit).toBeNull();
  });

  it("bounces off the right wall with restitution and stays in bounds", () => {
    const r = stepInertia({ x: 99, y: 0, vx: 1200, vy: 0 }, 1 / 60, box);
    expect(r.hit).toBe("x");
    expect(r.body.vx).toBeLessThan(0);
    expect(r.body.x).toBeLessThanOrEqual(box.maxX);
    expect(r.impactSpeed).toBeGreaterThan(1000);
    expect(Math.abs(r.body.vx)).toBeLessThan(r.impactSpeed);
  });

  it("bounces off the top wall", () => {
    const r = stepInertia({ x: 0, y: -49, vx: 0, vy: -900 }, 1 / 60, box);
    expect(r.hit).toBe("y");
    expect(r.body.vy).toBeGreaterThan(0);
    expect(r.body.y).toBeGreaterThanOrEqual(box.minY);
  });

  it("never leaves the bounds over a long, fast simulation", () => {
    let body: Body = { x: 0, y: 0, vx: 6800, vy: -5300 };
    let bounces = 0;
    for (let i = 0; i < 600; i++) {
      const r = stepInertia(body, 1 / 60, box);
      body = r.body;
      if (r.hit) bounces++;
      expect(body.x).toBeGreaterThanOrEqual(box.minX);
      expect(body.x).toBeLessThanOrEqual(box.maxX);
      expect(body.y).toBeGreaterThanOrEqual(box.minY);
      expect(body.y).toBeLessThanOrEqual(box.maxY);
    }
    expect(bounces).toBeGreaterThan(3);
    // 10 s of friction brings it to rest.
    expect(body.vx).toBe(0);
    expect(body.vy).toBe(0);
  });

  it("clamps huge dt (backgrounded tab) to maxDt", () => {
    const a = stepInertia({ x: 0, y: 0, vx: 100, vy: 0 }, 5, {
      minX: -1e6,
      maxX: 1e6,
      minY: -1e6,
      maxY: 1e6,
    });
    expect(a.body.x).toBeLessThan(100 * PHYSICS.maxDt + 1e-9);
  });

  it("reports rest below the stop speed", () => {
    const r = stepInertia({ x: 0, y: 0, vx: 1, vy: 1 }, 1 / 60, box);
    expect(r.resting).toBe(true);
    expect(r.body.vx).toBe(0);
  });
});

describe("stepSpring", () => {
  it("converges to the target and snaps when settled", () => {
    let body: Body = { x: 300, y: -200, vx: 0, vy: 0 };
    let settled = false;
    let frames = 0;
    while (!settled && frames < 600) {
      const r = stepSpring(body, { x: 0, y: 0 }, 1 / 60);
      body = r.body;
      settled = r.settled;
      frames++;
    }
    expect(settled).toBe(true);
    expect(body).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });
    expect(frames).toBeLessThan(120); // under 2 s
  });

  it("is stable with large frame steps", () => {
    let body: Body = { x: 1000, y: 0, vx: 0, vy: 0 };
    for (let i = 0; i < 100; i++) body = stepSpring(body, { x: 0, y: 0 }, 0.25).body;
    expect(Math.abs(body.x)).toBeLessThan(1);
  });
});

describe("squash and stretch", () => {
  it("is neutral at rest", () => {
    expect(stretchFromVelocity(0, 0)).toEqual({ angle: 0, sx: 1, sy: 1 });
  });

  it("preserves area and caps the stretch", () => {
    const { sx, sy, angle } = stretchFromVelocity(0, 50_000);
    expect(sx * sy).toBeCloseTo(1, 10);
    expect(sx).toBeCloseTo(1.22, 10);
    expect(angle).toBeCloseTo(Math.PI / 2, 10);
  });

  it("maps impact speed to a bounded squash", () => {
    expect(impactSquash(0)).toBe(0);
    expect(impactSquash(600)).toBeCloseTo(0.1, 10);
    expect(impactSquash(1e9)).toBe(0.3);
  });

  it("decays to exactly zero", () => {
    let v = 0.3;
    for (let i = 0; i < 120; i++) v = decay(v, 1 / 60);
    expect(v).toBe(0);
  });

  it("builds transform-only CSS", () => {
    expect(toTransform(1, 2, 0, 1, 1)).toBe("translate3d(1.00px, 2.00px, 0)");
    const t = toTransform(10, -5, Math.PI / 4, 1.1, 1 / 1.1);
    expect(t).toContain("rotate(45.00deg)");
    expect(t).toContain("rotate(-45.00deg)");
    expect(t).toMatch(/^translate3d\(/);
  });
});

describe("gestures", () => {
  it("detects a double tap by time and distance", () => {
    expect(isDoubleTap(null, { x: 0, y: 0, t: 0 })).toBe(false);
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 5, y: 5, t: 200 })).toBe(true);
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 5, y: 5, t: 500 })).toBe(false);
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 80, y: 0, t: 100 })).toBe(false);
    expect(isDoubleTap({ x: 0, y: 0, t: 100 }, { x: 0, y: 0, t: 100 })).toBe(false);
  });

  it("nudges within bounds", () => {
    expect(nudgeTarget({ x: 0, y: 0 }, { x: 1, y: 0 }, 24, box)).toEqual({ x: 24, y: 0 });
    expect(nudgeTarget({ x: 90, y: 0 }, { x: 1, y: 0 }, 24, box)).toEqual({ x: 100, y: 0 });
    expect(nudgeTarget({ x: 0, y: -40 }, { x: 0, y: -1 }, 96, box)).toEqual({ x: 0, y: -50 });
  });
});
