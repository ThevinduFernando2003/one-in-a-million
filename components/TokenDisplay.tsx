"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TokenResponse } from "@/lib/api-types";
import { MILESTONE_LABEL, type Milestone } from "@/lib/milestones";
import { MAX_ATTEMPTS, requestToken, takePreloaded, TokenRequestError } from "@/lib/token-client";
import DraggableNumber from "./DraggableNumber";
import { useReducedMotion } from "./useReducedMotion";

// Celebration code (canvas-confetti, fireworks, aurora) loads only when a
// milestone actually occurs, so it never weighs down the initial bundle.
const Celebrations = dynamic(() => import("./Celebrations"), { ssr: false });

type State =
  | { kind: "loading"; attempt: number }
  | { kind: "ready"; data: TokenResponse & { number: number } }
  | { kind: "soldOut" }
  | { kind: "error"; message: string; retryable: boolean };

const THEME_COLOR = { dark: "#0b0c10", light: "#f6f4ef", neutral: "#9a9ea6" } as const;

function applyTheme(theme: keyof typeof THEME_COLOR) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLOR[theme];
}

/*
 * One allocation request per page load, shared across React Strict Mode's
 * double-mounted effects in development. (This is client-side request
 * de-duplication, not allocation state: the number always comes from Redis.)
 */
let inflight: Promise<TokenResponse> | null = null;

function takeNumber(onAttempt: (n: number) => void): Promise<TokenResponse> {
  inflight ??= requestToken({ onAttempt, preloaded: takePreloaded() }).finally(() => {
    // Allow a fresh request on an explicit "Try again" or a later remount.
    setTimeout(() => (inflight = null), 0);
  });
  return inflight;
}

export default function TokenDisplay() {
  const [state, setState] = useState<State>({ kind: "loading", attempt: 1 });
  const [playId, setPlayId] = useState(0);
  const [touched, setTouched] = useState(false);
  // True while a celebration is on screen (hides the duplicate finale caption).
  const [celebrating, setCelebrating] = useState(false);
  const play = useCallback(() => {
    setCelebrating(true);
    setPlayId((n) => n + 1);
  }, []);
  const celebrationDone = useCallback(() => setCelebrating(false), []);
  const reducedMotion = useReducedMotion();
  const mounted = useRef(true);

  /** Start (or join) the allocation request and route its outcome into state. */
  const start = useCallback(() => {
    takeNumber((attempt) => {
      // Attempt 1 is the initial "loading" state already; only retries change it.
      if (mounted.current && attempt > 1) setState({ kind: "loading", attempt });
    })
      .then((data) => {
        if (!mounted.current) return;
        applyTheme(data.theme);
        if (data.number === null) {
          setState({ kind: "soldOut" });
          return;
        }
        setState({ kind: "ready", data: { ...data, number: data.number } });
        // Celebrate only a freshly issued milestone number. Re-confirmations
        // (refreshes) stay quiet, but the replay button is still offered.
        if (data.isNew && data.milestone) play();
      })
      .catch((err: unknown) => {
        if (!mounted.current) return;
        const e = err instanceof TokenRequestError ? err : null;
        setState({
          kind: "error",
          message: e?.message ?? "Something went wrong.",
          retryable: e ? e.retryable : true,
        });
      });
  }, [play]);

  /** "Try again" after an error: back to the neutral loading state, then retry. */
  const retry = useCallback(() => {
    setState({ kind: "loading", attempt: 1 });
    applyTheme("neutral");
    start();
  }, [start]);

  useEffect(() => {
    mounted.current = true;
    start();
    return () => {
      mounted.current = false;
    };
  }, [start]);

  const milestone: Milestone | null = state.kind === "ready" ? state.data.milestone : null;
  const legendary = milestone === "hundredThousand" || milestone === "million";

  // Text for screen readers (polite live region).
  let announcement = "";
  if (state.kind === "loading") announcement = "Taking a number…";
  else if (state.kind === "ready") {
    announcement = `Your number is ${state.data.number}`;
    if (milestone) announcement += `. ${MILESTONE_LABEL[milestone]}`;
  } else if (state.kind === "soldOut")
    announcement = "Sold out: all one million numbers are taken.";
  else announcement = `Error: ${state.message}`;

  return (
    <>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>

      {/* The stage: exactly the viewport, so the number's bounds are the screen edges. */}
      <div className="absolute inset-0 z-10 grid place-items-center">
        {state.kind === "loading" && (
          <div className="flex flex-col items-center gap-5 px-6 text-center" aria-hidden="true">
            <span className="token-number pulse text-fg select-none">···</span>
            <span className="text-fg text-base font-medium">
              Taking a number…
              {state.attempt > 1 && (
                <span className="text-muted">
                  {" "}
                  (retry {state.attempt - 1} of {MAX_ATTEMPTS - 1})
                </span>
              )}
            </span>
          </div>
        )}

        {state.kind === "ready" && (
          <DraggableNumber
            value={state.data.number}
            glow={legendary}
            reducedMotion={reducedMotion}
            onFirstInteraction={() => setTouched(true)}
          />
        )}

        {state.kind === "soldOut" && (
          <div className="fade-in max-w-xl px-6 text-center">
            <p className="text-[clamp(2rem,8vw,4.5rem)] leading-tight font-extrabold tracking-tight">
              Sold out
            </p>
            <p className="text-muted mt-3 text-lg sm:text-xl">All one million numbers are taken.</p>
          </div>
        )}

        {state.kind === "error" && (
          <div className="fade-in max-w-md px-6 text-center" role="alert">
            <p className="text-2xl font-bold sm:text-3xl">No number yet</p>
            <p className="text-muted mt-3 text-base">{state.message}</p>
            {state.retryable && (
              <button
                type="button"
                onClick={retry}
                className="bg-fg text-bg mt-6 rounded-full px-6 py-3 text-base font-semibold transition-transform hover:scale-[1.03] active:scale-95"
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>

      {/* Footer: drag hint and the persistent million message. */}
      {state.kind === "ready" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-20 flex flex-col items-center gap-2 px-4 text-center">
          {milestone === "million" && !celebrating && (
            <p className="gold-text fade-in text-xl font-extrabold tracking-tight sm:text-2xl">
              You are one in a million
            </p>
          )}
          {!touched && (
            <p className="fade-in text-muted text-sm">
              Take it for a ride: drag and fling it. Double-tap or press Esc to bring it home.
            </p>
          )}
        </div>
      )}

      {milestone && (
        <button
          type="button"
          onClick={play}
          className="border-fg/25 bg-surface text-fg absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-40 rounded-full border px-4 py-2 text-sm font-medium backdrop-blur transition-transform hover:scale-[1.04] active:scale-95 sm:top-5 sm:right-6"
          aria-label="Replay celebration"
        >
          ↻ Replay
        </button>
      )}

      {milestone && playId > 0 && (
        <Celebrations
          key={playId}
          tier={milestone}
          reducedMotion={reducedMotion}
          onDone={celebrationDone}
        />
      )}
    </>
  );
}
