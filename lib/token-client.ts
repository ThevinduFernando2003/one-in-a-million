import { isTokenResponse, type TokenResponse } from "./api-types";

/**
 * Browser-side caller for POST /api/token, with retries.
 *
 * Retrying is safe because the server's owner check is idempotent: when a
 * request timed out after Redis had already issued our number, the retry
 * gets that same number back, provided nobody else took one in between.
 * The visitor cookie is set by proxy.ts on the page load itself, so even the
 * very first allocation request already carries an identity.
 */

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 5_000;
/**
 * Longer than the server can take (route maxDuration = 30 s). Under heavy
 * load we would rather wait than abandon a request that may already have
 * been given a number.
 */
const ATTEMPT_TIMEOUT_MS = 35_000;

export class TokenRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TokenRequestError";
  }
}

/**
 * Exponential backoff with "equal jitter": half the exponential delay is
 * fixed and half is random. Clients that failed together then spread out
 * instead of retrying in lockstep, but no retry fires instantly.
 * `attempt` is 1-based: the delay after the first failure is backoffDelay(1).
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  return undefined;
}

type Deps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  /** Called before each attempt (1-based), so the UI can show "retrying". */
  onAttempt?: (attempt: number) => void;
  signal?: AbortSignal;
  /**
   * A request that is already in flight (started by the inline script in
   * <head> while the HTML was still parsing, see PRELOAD_SCRIPT). It is used
   * as attempt #1, and retries go through fetch as usual.
   */
  preloaded?: Promise<Response>;
};

/** Global slot the inline preload script writes to. */
declare global {
  interface Window {
    __oiamToken?: Promise<Response>;
  }
}

/**
 * Inline <head> script: start the allocation POST the moment the HTML is
 * parsed, in parallel with downloading and hydrating the JS bundle, instead
 * of after it. It never runs during SSR or for link previewers (they don't
 * execute JS), and the API still rejects bots. `.catch` marks the promise
 * as handled. Errors are dealt with by requestToken.
 */
export const PRELOAD_SCRIPT = `(function(){try{if(!window.fetch||!window.Promise)return;var p=fetch("/api/token",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:"{}",credentials:"same-origin",cache:"no-store"});p.catch(function(){});window.__oiamToken=p}catch(e){}})();`;

/** Take the preloaded request, if any (only once). */
export function takePreloaded(): Promise<Response> | undefined {
  if (typeof window === "undefined") return undefined;
  const p = window.__oiamToken;
  window.__oiamToken = undefined;
  return p;
}

function fetchToken(fetchImpl: typeof fetch, signal: AbortSignal) {
  return fetchImpl("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function attemptOnce(
  start: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
  outer?: AbortSignal,
) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    let res: Response;
    try {
      // Race against our own timeout too: a preloaded request can't be
      // aborted, but we can stop waiting for it.
      res = await Promise.race([
        start(ctrl.signal),
        new Promise<never>((_, reject) => {
          if (ctrl.signal.aborted) reject(new Error("aborted"));
          ctrl.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);
    } catch {
      if (outer?.aborted) throw new TokenRequestError("Aborted.", false);
      throw new TokenRequestError("Network error or timeout.", true);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok) {
      if (!isTokenResponse(body)) {
        // A malformed success is never shown as a number. Retry instead.
        throw new TokenRequestError("Malformed response from server.", true, res.status);
      }
      return body;
    }
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed (${res.status}).`;
    throw new TokenRequestError(
      message,
      isRetryableStatus(res.status),
      res.status,
      parseRetryAfter(res.headers.get("Retry-After")),
    );
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/** Request a token, retrying retryable failures up to `maxAttempts` times in total. */
export async function requestToken(deps: Deps = {}): Promise<TokenResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  const timeout = deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;

  let lastError: TokenRequestError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    deps.onAttempt?.(attempt);
    try {
      const preloaded = attempt === 1 ? deps.preloaded : undefined;
      const start = preloaded
        ? () => preloaded
        : (signal: AbortSignal) => fetchToken(fetchImpl, signal);
      return await attemptOnce(start, timeout, deps.signal);
    } catch (err) {
      lastError =
        err instanceof TokenRequestError ? err : new TokenRequestError(String(err), false);
      if (!lastError.retryable || attempt === maxAttempts || deps.signal?.aborted) break;
      const wait = Math.max(backoffDelay(attempt, random), lastError.retryAfterMs ?? 0);
      await sleep(wait);
    }
  }
  throw lastError ?? new TokenRequestError("Unknown error.", false);
}
