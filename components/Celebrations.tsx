"use client";

import { useEffect, useRef, useState } from "react";
import { MILESTONE_LABEL, type Milestone } from "@/lib/milestones";
import { startFireworks } from "./fx/fireworks";
import { startLegendary } from "./fx/legendary";

/**
 * Milestone celebrations. This module (and canvas-confetti, which it imports
 * dynamically) is lazy-loaded by TokenDisplay only when a milestone number
 * is shown. Exactly one tier plays, and each tier looks different:
 *
 *   hundred          star burst from the centre (gold and white stars)
 *   thousand         full-screen confetti: big blast plus side cannons
 *   tenThousand      fireworks show: rockets, trails, varied bursts
 *   hundredThousand  legendary: aurora over a galaxy, rising gold motes,
 *                    gold glow on the number, "Legendary" title
 *   million          the finale: everything above at once plus a
 *                    "You are one in a million" message
 *
 * With prefers-reduced-motion, a calm, static banner shows instead.
 */

const DURATION: Record<Milestone, number> = {
  hundred: 2.6,
  thousand: 4.5,
  tenThousand: 7.5,
  hundredThousand: 8.5,
  million: 13,
};

type Props = {
  tier: Milestone;
  reducedMotion: boolean;
  /** Called once the celebration has finished (must be a stable callback). */
  onDone?: () => void;
};

type ConfettiFn = (opts?: Record<string, unknown>) => Promise<null> | null;

function isDarkTheme() {
  return document.documentElement.dataset.theme !== "light";
}

export default function Celebrations({ tier, reducedMotion, onDone }: Props) {
  const [done, setDone] = useState(false);
  const confettiCanvas = useRef<HTMLCanvasElement>(null);
  const fireworksCanvas = useRef<HTMLCanvasElement>(null);
  const legendaryCanvas = useRef<HTMLCanvasElement>(null);
  const duration = reducedMotion ? 6 : DURATION[tier];

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        setDone(true);
        onDone?.();
      },
      duration * 1000 + 300,
    );
    if (reducedMotion) return () => window.clearTimeout(timer);

    const cleanups: Array<() => void> = [];
    const timeouts: number[] = [];
    const later = (ms: number, fn: () => void) => timeouts.push(window.setTimeout(fn, ms));
    const dark = isDarkTheme();
    let cancelled = false;

    // Canvas effects
    if ((tier === "tenThousand" || tier === "million") && fireworksCanvas.current) {
      cleanups.push(
        startFireworks(fireworksCanvas.current, {
          duration: tier === "million" ? 11 : 6.5,
          rockets: tier === "million" ? 26 : 14,
          dark,
          finale: true,
        }),
      );
    }
    if ((tier === "hundredThousand" || tier === "million") && legendaryCanvas.current) {
      cleanups.push(
        startLegendary(legendaryCanvas.current, {
          duration: DURATION[tier],
          dark,
          intensity: tier === "million" ? 1.4 : 1,
        }),
      );
    }

    // canvas-confetti effects, loaded on demand
    const needsConfetti = tier === "hundred" || tier === "thousand" || tier === "million";
    if (needsConfetti && confettiCanvas.current) {
      const canvas = confettiCanvas.current;
      void import("canvas-confetti").then(({ default: confetti }) => {
        if (cancelled) return;
        // Our own canvas without a Worker: it respects our z-index/pointer-events
        // and needs no blob: worker allowance in the CSP.
        const fire = confetti.create(canvas, {
          resize: true,
          useWorker: false,
        }) as unknown as ConfettiFn & {
          reset: () => void;
        };
        cleanups.push(() => fire.reset());

        const starBurst = (scale = 1) => {
          const base = {
            spread: 360,
            ticks: 90,
            gravity: 0.35,
            decay: 0.93,
            startVelocity: 26 * scale,
            shapes: ["star"],
            colors: dark
              ? ["#fde68a", "#fbbf24", "#ffffff", "#fcd34d"]
              : ["#b7791f", "#d97706", "#92400e", "#f59e0b"],
            origin: { x: 0.5, y: 0.5 },
            disableForReducedMotion: true,
          };
          void fire({ ...base, particleCount: Math.round(36 * scale), scalar: 1.25 * scale });
          void fire({
            ...base,
            particleCount: Math.round(14 * scale),
            scalar: 0.8,
            shapes: ["circle"],
          });
        };

        const confettiShow = (seconds: number) => {
          void fire({
            particleCount: 160,
            spread: 100,
            startVelocity: 55,
            origin: { x: 0.5, y: 0.65 },
          });
          const end = Date.now() + seconds * 1000;
          const cannon = () => {
            if (cancelled || Date.now() > end) return;
            void fire({
              particleCount: 5,
              angle: 60,
              spread: 60,
              startVelocity: 60,
              origin: { x: 0, y: 0.75 },
            });
            void fire({
              particleCount: 5,
              angle: 120,
              spread: 60,
              startVelocity: 60,
              origin: { x: 1, y: 0.75 },
            });
            const id = requestAnimationFrame(cannon);
            cleanups.push(() => cancelAnimationFrame(id));
          };
          cannon();
          later(
            seconds * 400,
            () =>
              void fire({
                particleCount: 120,
                spread: 160,
                startVelocity: 45,
                origin: { x: 0.5, y: 0.3 },
              }),
          );
        };

        if (tier === "hundred") {
          starBurst(1);
          later(220, () => starBurst(0.7));
        } else if (tier === "thousand") {
          confettiShow(3.2);
        } else if (tier === "million") {
          starBurst(1.4);
          later(400, () => confettiShow(4));
          later(6000, () => starBurst(1.6));
          later(9500, () => confettiShow(2.5));
        }
      });
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      timeouts.forEach((t) => window.clearTimeout(t));
      cleanups.forEach((fn) => fn());
    };
  }, [tier, reducedMotion, duration, onDone]);

  if (done) return null;

  // ----- Calm alternative (reduced motion) -----
  if (reducedMotion) {
    return (
      <div className="pointer-events-none fixed inset-x-0 top-16 z-30 flex justify-center px-4">
        <p className="reduced-fade border-fg/20 bg-surface text-fg rounded-full border px-5 py-2 text-base font-semibold backdrop-blur">
          ✦ {MILESTONE_LABEL[tier]}
        </p>
      </div>
    );
  }

  const legendary = tier === "hundredThousand" || tier === "million";
  const fxStyle = { "--fx-duration": `${DURATION[tier]}s` } as React.CSSProperties;

  return (
    <div aria-hidden="true">
      {/* Back layer (behind the number): galaxy and aurora. */}
      {legendary && (
        <div
          className="fx-layer pointer-events-none fixed inset-0 z-0 overflow-hidden"
          style={fxStyle}
        >
          <div className="fx-galaxy absolute inset-0" />
          <div className="aurora">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
      {legendary && (
        <canvas
          ref={legendaryCanvas}
          className="pointer-events-none fixed inset-0 z-[5] h-full w-full"
        />
      )}

      {/* Front layer (over the number): fireworks and confetti. */}
      {(tier === "tenThousand" || tier === "million") && (
        <canvas
          ref={fireworksCanvas}
          className="pointer-events-none fixed inset-0 z-30 h-full w-full"
        />
      )}
      {(tier === "hundred" || tier === "thousand" || tier === "million") && (
        <canvas
          ref={confettiCanvas}
          className="pointer-events-none fixed inset-0 z-30 h-full w-full"
        />
      )}

      {/* Titles */}
      {tier === "hundredThousand" && (
        <div
          className="fx-layer pointer-events-none fixed inset-x-0 top-[16%] z-30 text-center"
          style={fxStyle}
        >
          <p className="gold-text text-[clamp(1.6rem,6vw,3.25rem)] font-black tracking-[0.18em] uppercase">
            Legendary
          </p>
        </div>
      )}
      {tier === "million" && (
        <div
          className="fx-layer pointer-events-none fixed inset-x-0 top-[12%] z-30 px-4 text-center"
          style={fxStyle}
        >
          <p className="gold-text text-[clamp(2rem,7.5vw,4.5rem)] leading-tight font-black tracking-tight">
            You are one in a million
          </p>
        </div>
      )}
    </div>
  );
}
