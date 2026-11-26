import { describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  isRetryableStatus,
  requestToken,
  TokenRequestError,
} from "@/lib/token-client";

const good = { number: 42, isNew: true, theme: "light", milestone: null, soldOut: false };

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("backoffDelay (exponential with equal jitter)", () => {
  it("grows exponentially and stays within [exp/2, exp]", () => {
    expect(backoffDelay(1, () => 0)).toBe(200);
    expect(backoffDelay(1, () => 1)).toBe(400);
    expect(backoffDelay(2, () => 0)).toBe(400);
    expect(backoffDelay(3, () => 1)).toBe(1600);
    expect(backoffDelay(4, () => 0.5)).toBe(2400);
  });
  it("is capped", () => {
    expect(backoffDelay(20, () => 1)).toBe(5000);
  });
});

describe("isRetryableStatus", () => {
  it("retries 429 and 5xx only", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(413)).toBe(false);
  });
});

describe("requestToken", () => {
  const sleep = vi.fn(async () => {});

  it("returns the number on success, POSTing an empty JSON body", async () => {
    const fetchImpl = vi.fn(async () => respond(200, good));
    await expect(requestToken({ fetchImpl, sleep })).resolves.toEqual(good);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/token");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });

  it("retries 503s and network errors, then succeeds", async () => {
    const attempts: number[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(respond(503, { error: "down", code: "redis_unavailable" }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(respond(200, good));
    const res = await requestToken({
      fetchImpl,
      sleep,
      random: () => 0,
      onAttempt: (n) => attempts.push(n),
    });
    expect(res.number).toBe(42);
    expect(attempts).toEqual([1, 2, 3]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up after 5 attempts with the last error", async () => {
    const fetchImpl = vi.fn(async () =>
      respond(503, { error: "still down", code: "redis_unavailable" }),
    );
    const err = await requestToken({ fetchImpl, sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRequestError);
    expect((err as TokenRequestError).message).toBe("still down");
    expect((err as TokenRequestError).retryable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("does not retry non-retryable errors (403)", async () => {
    const fetchImpl = vi.fn(async () => respond(403, { error: "nope", code: "forbidden" }));
    const err = await requestToken({ fetchImpl, sleep }).catch((e: unknown) => e);
    expect((err as TokenRequestError).status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honours Retry-After on 429", async () => {
    const waits: number[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        respond(429, { error: "slow down", code: "rate_limited" }, { "Retry-After": "3" }),
      )
      .mockResolvedValueOnce(respond(200, good));
    await requestToken({ fetchImpl, sleep: async (ms) => void waits.push(ms), random: () => 0 });
    expect(waits).toEqual([3000]);
  });

  it("never accepts a malformed success body as a number", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { number: "9999999" }));
    const err = await requestToken({ fetchImpl, sleep, maxAttempts: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("times out a hung attempt and retries", async () => {
    let call = 0;
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      call++;
      if (call === 1) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve(respond(200, good));
    }) as unknown as typeof fetch;
    const res = await requestToken({ fetchImpl, sleep, attemptTimeoutMs: 20 });
    expect(res.number).toBe(42);
  });
  it("uses the preloaded (inline-script) request as attempt #1", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { ...good, number: 99 }));
    const res = await requestToken({
      fetchImpl,
      sleep,
      preloaded: Promise.resolve(respond(200, good)),
    });
    expect(res.number).toBe(42);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to fetch when the preloaded request failed", async () => {
    const fetchImpl = vi.fn(async () => respond(200, good));
    const res = await requestToken({
      fetchImpl,
      sleep,
      preloaded: Promise.reject(new TypeError("Failed to fetch")),
    });
    expect(res.number).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a hung preloaded request after the attempt timeout", async () => {
    const fetchImpl = vi.fn(async () => respond(200, good));
    const res = await requestToken({
      fetchImpl,
      sleep,
      attemptTimeoutMs: 20,
      preloaded: new Promise<Response>(() => {}),
    });
    expect(res.number).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
