import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { isTokenResponse } from "@/lib/api-types";
import { TEST_TOKEN, TEST_URL, testRedis, waitForRedis } from "./helpers";

/**
 * Exercises the real route handler (guards, validation, cookie, headers)
 * against real Redis. It uses the app's real keys in the local test
 * database, so assertions are relative (never absolute numbers).
 */

const ORIGIN = "http://localhost:3000";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

type RouteModule = typeof import("@/app/api/token/route");
let route: RouteModule;

async function loadRoute(env: Record<string, string | undefined>): Promise<RouteModule> {
  vi.resetModules();
  // Every load starts from a high rate limit unless the test overrides it.
  for (const [k, v] of Object.entries({ RATE_LIMIT_PER_10S: "100000", ...env })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("@/app/api/token/route");
}

function req(
  opts: { headers?: Record<string, string | null>; body?: string; cookie?: string } = {},
) {
  const headers: Record<string, string> = {};
  const base: Record<string, string | null> = {
    host: "localhost:3000",
    origin: ORIGIN,
    "user-agent": UA,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    "x-forwarded-for": "203.0.113.10",
    ...opts.headers,
  };
  for (const [k, v] of Object.entries(base)) if (v !== null) headers[k] = v;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new NextRequest(`${ORIGIN}/api/token`, {
    method: "POST",
    headers,
    body: opts.body ?? "{}",
  });
}

function visitorCookie(res: Response): string | undefined {
  const sc = res.headers.get("set-cookie") ?? "";
  return /oiam_vid=([^;]+)/.exec(sc)?.[1];
}

beforeAll(async () => {
  await waitForRedis(testRedis());
  route = await loadRoute({
    UPSTASH_REDIS_REST_URL: TEST_URL,
    UPSTASH_REDIS_REST_TOKEN: TEST_TOKEN,
    MAX_TOKENS: "1000000",
    RATE_LIMIT_PER_10S: "100000",
  });
});

describe("POST /api/token", () => {
  it("is force-dynamic", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("issues a number, sets a secure-by-default httpOnly cookie, and is never cached", async () => {
    const res = await route.POST(req());
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(isTokenResponse(body)).toBe(true);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/oiam_vid=[0-9a-f-]{36}/);
    expect(sc.toLowerCase()).toContain("httponly");
    expect(sc.toLowerCase()).toContain("samesite=lax");
    expect(sc.toLowerCase()).toContain("max-age=31536000");
  });

  it("returns the same number for the same cookie, a new one after someone else", async () => {
    const r1 = await route.POST(req());
    const id = visitorCookie(r1)!;
    const n1 = ((await r1.json()) as { number: number }).number;

    const r2 = await route.POST(req({ cookie: `oiam_vid=${id}` }));
    const b2 = (await r2.json()) as { number: number; isNew: boolean };
    expect(b2.number).toBe(n1);
    expect(b2.isNew).toBe(false);

    await route.POST(req()); // someone else
    const r3 = await route.POST(req({ cookie: `oiam_vid=${id}` }));
    const b3 = (await r3.json()) as { number: number; isNew: boolean };
    expect(b3.number).toBeGreaterThan(n1);
    expect(b3.isNew).toBe(true);
  });

  it("treats a malformed cookie as a new visitor (and replaces it)", async () => {
    const res = await route.POST(req({ cookie: "oiam_vid=../../etc/passwd" }));
    expect(res.status).toBe(200);
    expect(visitorCookie(res)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("theme and milestone are consistent with the number", async () => {
    const { themeFor } = await import("@/lib/primes");
    const { milestoneFor } = await import("@/lib/milestones");
    const body = (await (await route.POST(req())).json()) as {
      number: number;
      theme: string;
      milestone: string | null;
    };
    expect(body.theme).toBe(themeFor(body.number));
    expect(body.milestone).toBe(milestoneFor(body.number));
  });

  it.each([
    [
      "bot UA",
      { "user-agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" },
    ],
    ["link previewer", { "user-agent": "WhatsApp/2.23.20.0 A" }],
    ["missing UA", { "user-agent": null }],
    ["missing Origin", { origin: null }],
    ["foreign Origin", { origin: "https://evil.example" }],
    ["cross-site fetch", { "sec-fetch-site": "cross-site" }],
  ])("rejects %s with 403 and allocates nothing", async (_label, headers) => {
    const res = await route.POST(req({ headers }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.number).toBeUndefined();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("validates input: content type, JSON, empty object only, size", async () => {
    expect((await route.POST(req({ headers: { "content-type": "text/plain" } }))).status).toBe(400);
    expect((await route.POST(req({ body: "{not json" }))).status).toBe(400);
    expect((await route.POST(req({ body: '{"number":1}' }))).status).toBe(400);
    expect((await route.POST(req({ body: "[]" }))).status).toBe(400);
    expect((await route.POST(req({ body: JSON.stringify({ pad: "x".repeat(400) }) }))).status).toBe(
      413,
    );
    expect((await route.POST(req({ body: "" }))).status).toBe(200);
  });
});

describe("per-IP rate limit (@upstash/ratelimit against real Redis)", () => {
  it("returns 429 with Retry-After once an IP exceeds the window, without allocating", async () => {
    const limited = await loadRoute({
      UPSTASH_REDIS_REST_URL: TEST_URL,
      UPSTASH_REDIS_REST_TOKEN: TEST_TOKEN,
      RATE_LIMIT_PER_10S: "3",
    });
    const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}-${crypto.randomUUID()}`;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await limited.POST(req({ headers: { "x-forwarded-for": ip } }));
      statuses.push(res.status);
      if (res.status === 429) {
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        expect(((await res.json()) as Record<string, unknown>).number).toBeUndefined();
      }
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("a different IP is unaffected", async () => {
    const limited = await loadRoute({
      UPSTASH_REDIS_REST_URL: TEST_URL,
      UPSTASH_REDIS_REST_TOKEN: TEST_TOKEN,
      RATE_LIMIT_PER_10S: "3",
    });
    const res = await limited.POST(req({ headers: { "x-forwarded-for": crypto.randomUUID() } }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/token when Redis is down", () => {
  it("returns 503 with a clear error and never a number", async () => {
    const down = await loadRoute({
      UPSTASH_REDIS_REST_URL: "http://127.0.0.1:1",
      UPSTASH_REDIS_REST_TOKEN: "x",
    });
    const res = await down.POST(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("redis_unavailable");
    expect(typeof body.error).toBe("string");
    expect(body.number).toBeUndefined();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("returns 503 'misconfigured' when no credentials are set", async () => {
    const none = await loadRoute({
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    });
    const res = await none.POST(req());
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("misconfigured");
  });

  it("accepts the Vercel Marketplace KV_REST_API_* names", async () => {
    const kv = await loadRoute({
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: TEST_URL,
      KV_REST_API_TOKEN: TEST_TOKEN,
    });
    const res = await kv.POST(req());
    expect(res.status).toBe(200);
  });
});
