"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  clampToBounds,
  computeBounds,
  decay,
  impactSquash,
  isDoubleTap,
  NUDGE_KEYS,
  nudgeTarget,
  stepInertia,
  stepSpring,
  stretchFromVelocity,
  toTransform,
  velocityFromSamples,
  type Body,
  type Bounds,
  type Sample,
  type Vec,
} from "@/lib/physics";

type Mode = "idle" | "drag" | "inertia" | "spring";

type Props = {
  value: number;
  glow?: boolean;
  reducedMotion?: boolean;
  onFirstInteraction?: () => void;
};

/** Pointer movement (px) below which a press counts as a tap, not a drag. */
const TAP_SLOP = 6;
/** A drag that paused this long (ms) before release is dropped, not flung. */
const RELEASE_STALE_MS = 80;

/**
 * "Take it for a ride": the number can be grabbed with mouse, touch or pen
 * (Pointer Events), flung with inertia and friction, and it bounces off the
 * viewport edges with squash-and-stretch. Double-click, double-tap, Esc or
 * Home spring it back to the centre. Arrow keys nudge it (Shift = bigger steps).
 *
 * Performance: all motion state lives in a ref, never in React state, so
 * there are no re-renders. Each frame writes exactly one `transform`. Layout
 * is measured only on grab and on resize.
 */
export default function DraggableNumber({ value, glow, reducedMotion, onFirstInteraction }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const s = useRef({
    mode: "idle" as Mode,
    body: { x: 0, y: 0, vx: 0, vy: 0 } as Body,
    target: { x: 0, y: 0 } as Vec,
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 } as Bounds,
    samples: [] as Sample[],
    pointerId: -1,
    grab: { x: 0, y: 0 } as Vec,
    down: null as Sample | null,
    moved: false,
    lastTap: null as Sample | null,
    squash: 0,
    squashAxis: "x" as "x" | "y",
    raf: 0,
    lastFrame: 0,
    interacted: false,
  });
  // Latest props for use inside event handlers and the rAF loop.
  const reduced = useRef(!!reducedMotion);
  const firstInteraction = useRef(onFirstInteraction);
  useEffect(() => {
    reduced.current = !!reducedMotion;
    firstInteraction.current = onFirstInteraction;
  }, [reducedMotion, onFirstInteraction]);
  // The frame callback re-schedules itself through this ref.
  const frameRef = useRef<(now: number) => void>(() => {});

  const measure = useCallback(() => {
    const node = el.current;
    const stage = node?.offsetParent as HTMLElement | null;
    if (!node || !stage) return;
    // offset* ignore transforms, so this is the untransformed resting box.
    s.current.bounds = computeBounds(stage.clientWidth, stage.clientHeight, {
      left: node.offsetLeft,
      top: node.offsetTop,
      width: node.offsetWidth,
      height: node.offsetHeight,
    });
  }, []);

  const render = useCallback(() => {
    const node = el.current;
    if (!node) return;
    const st = s.current;
    const { x, y, vx, vy } = st.body;
    let angle = 0;
    let sx = 1;
    let sy = 1;
    if (st.squash > 0) {
      // Flatten against the wall we hit, bulge along it.
      const q = st.squash;
      if (st.squashAxis === "x") {
        sx = 1 - q;
        sy = 1 + q * 0.6;
      } else {
        sx = 1 + q * 0.6;
        sy = 1 - q;
      }
    } else if (st.mode !== "idle" && !reduced.current) {
      ({ angle, sx, sy } = stretchFromVelocity(vx, vy));
    }
    node.style.transform = toTransform(x, y, angle, sx, sy);
  }, []);

  const frame = useCallback(
    (now: number) => {
      const st = s.current;
      const dt = st.lastFrame ? (now - st.lastFrame) / 1000 : 1 / 60;
      st.lastFrame = now;

      if (st.mode === "drag") {
        // Live velocity for the stretch effect. It is zero if the pointer is resting.
        const last = st.samples[st.samples.length - 1];
        if (last && performance.now() - last.t < 60) {
          const v = velocityFromSamples(st.samples, 60);
          st.body.vx = v.x;
          st.body.vy = v.y;
        } else {
          st.body.vx = 0;
          st.body.vy = 0;
        }
      } else if (st.mode === "inertia") {
        const r = stepInertia(st.body, dt, st.bounds);
        st.body = r.body;
        if (r.hit && r.impactSpeed > 150 && !reduced.current) {
          st.squash = Math.max(st.squash, impactSquash(r.impactSpeed));
          st.squashAxis = r.hit;
        }
        if (r.resting) st.mode = "idle";
      } else if (st.mode === "spring") {
        const r = stepSpring(st.body, st.target, dt);
        st.body = r.body;
        if (r.settled) st.mode = "idle";
      }
      st.squash = decay(st.squash, dt);
      render();

      if (st.mode !== "idle" || st.squash > 0) {
        st.raf = requestAnimationFrame(frameRef.current);
      } else {
        st.raf = 0;
        st.lastFrame = 0;
        if (el.current) el.current.style.willChange = "auto";
      }
    },
    [render],
  );
  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  const kick = useCallback(() => {
    const st = s.current;
    if (el.current) el.current.style.willChange = "transform";
    if (!st.raf) {
      st.lastFrame = 0;
      st.raf = requestAnimationFrame(frameRef.current);
    }
  }, []);

  const markInteracted = () => {
    if (!s.current.interacted) {
      s.current.interacted = true;
      firstInteraction.current?.();
    }
  };

  const springTo = useCallback(
    (target: Vec) => {
      const st = s.current;
      st.target = target;
      if (reduced.current) {
        // Calm alternative: jump without animating.
        st.body = { x: target.x, y: target.y, vx: 0, vy: 0 };
        st.mode = "idle";
        render();
        return;
      }
      st.mode = "spring";
      kick();
    },
    [kick, render],
  );

  const goHome = useCallback(() => springTo({ x: 0, y: 0 }), [springTo]);

  // ----- Pointer handling -----

  const endDrag = (node: HTMLDivElement) => {
    document.documentElement.classList.remove("is-dragging");
    if (node.hasPointerCapture(s.current.pointerId)) {
      node.releasePointerCapture(s.current.pointerId);
    }
    s.current.pointerId = -1;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const st = s.current;
    if (st.pointerId !== -1) return; // Ignore a second finger.
    const node = e.currentTarget;
    e.preventDefault(); // No text selection, no native image drag.
    node.setPointerCapture(e.pointerId);
    measure();
    st.pointerId = e.pointerId;
    st.mode = "drag";
    st.body.vx = st.body.vy = 0;
    st.grab = { x: e.clientX - st.body.x, y: e.clientY - st.body.y };
    st.down = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    st.moved = false;
    st.samples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    document.documentElement.classList.add("is-dragging");
    kick();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = s.current;
    if (e.pointerId !== st.pointerId || st.mode !== "drag") return;
    e.preventDefault();
    if (
      !st.moved &&
      st.down &&
      Math.hypot(e.clientX - st.down.x, e.clientY - st.down.y) > TAP_SLOP
    ) {
      st.moved = true;
      markInteracted();
    }
    const p = clampToBounds({ x: e.clientX - st.grab.x, y: e.clientY - st.grab.y }, st.bounds);
    st.body.x = p.x;
    st.body.y = p.y;
    st.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (st.samples.length > 12) st.samples.splice(0, st.samples.length - 12);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = s.current;
    if (e.pointerId !== st.pointerId) return;
    const node = e.currentTarget;
    endDrag(node);

    if (!st.moved) {
      // A tap. Two taps in quick succession send it home.
      const tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (isDoubleTap(st.lastTap, tap)) {
        st.lastTap = null;
        markInteracted();
        goHome();
        return;
      }
      st.lastTap = tap;
      st.mode = "idle";
      kick();
      return;
    }
    st.lastTap = null;

    const last = st.samples[st.samples.length - 1];
    const stale = !last || performance.now() - last.t > RELEASE_STALE_MS;
    const v = stale ? { x: 0, y: 0 } : velocityFromSamples(st.samples);
    if (reduced.current) {
      st.mode = "idle";
    } else {
      st.body.vx = v.x;
      st.body.vy = v.y;
      st.mode = "inertia";
    }
    kick();
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = s.current;
    if (e.pointerId !== st.pointerId) return;
    endDrag(e.currentTarget);
    st.mode = "idle";
    kick();
  };

  // ----- Keyboard -----

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const st = s.current;
    if (e.key === "Escape" || e.key === "Home") {
      e.preventDefault();
      markInteracted();
      goHome();
      return;
    }
    const dir = NUDGE_KEYS[e.key];
    if (dir) {
      e.preventDefault(); // Arrow keys must not scroll the page.
      markInteracted();
      measure();
      const from = st.mode === "spring" ? st.target : { x: st.body.x, y: st.body.y };
      springTo(nudgeTarget(from, dir, e.shiftKey ? 96 : 24, st.bounds));
    }
  };

  // Esc works even when the number isn't focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) goHome();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goHome]);

  // Keep the number on screen when the viewport changes (rotation, resize).
  useEffect(() => {
    const onResize = () => {
      measure();
      const st = s.current;
      const p = clampToBounds(st.body, st.bounds);
      st.body.x = p.x;
      st.body.y = p.y;
      if (st.mode === "spring") st.target = clampToBounds(st.target, st.bounds);
      render();
    };
    measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure, render]);

  // Stop any animation and drag state on unmount.
  useEffect(() => {
    const st = s.current;
    return () => {
      if (st.raf) cancelAnimationFrame(st.raf);
      document.documentElement.classList.remove("is-dragging");
    };
  }, []);

  return (
    <div
      ref={el}
      role="group"
      aria-roledescription="draggable number"
      aria-label={`Your number ${value}. Drag to move it, use the arrow keys to nudge it, and press Escape to bring it back to the centre.`}
      tabIndex={0}
      className="draggable relative rounded-2xl px-[0.06em]"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onDoubleClick={goHome}
      onKeyDown={onKeyDown}
      onDragStart={(e) => e.preventDefault()}
    >
      <span
        aria-hidden="true"
        className={`token-number pop-in block ${glow ? "token-glow" : ""}`}
        style={{ "--digits": String(value).length } as React.CSSProperties}
      >
        {String(value)}
      </span>
    </div>
  );
}
