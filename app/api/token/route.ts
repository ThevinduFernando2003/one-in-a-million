import { NextResponse, type NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import { allocate, AllocationError } from "@/lib/allocate";
import type { TokenErrorResponse, TokenResponse } from "@/lib/api-types";
import { parseMaxTokens, parsePositiveInt } from "@/lib/config";
import {
  clientIp,
  isAllowedFetchSite,
  isAllowedOrigin,
  isBotUserAgent,
  parseAllowList,
} from "@/lib/guards";
import {
  isValidVisitorId,
  newVisitorId,
  VISITOR_COOKIE,
  visitorCookieOptions,
} from "@/lib/identity";
import { errorSummary, logEvent } from "@/lib/log";
import { milestoneFor } from "@/lib/milestones";
import { themeFor } from "@/lib/primes";
import { getRedis, RedisConfigError } from "@/lib/redis";

// Never cache, never prerender: every call must reach the Redis script.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = "no-store, max-age=0";
const MAX_BODY_BYTES = 256;

const maxTokens = parseMaxTokens(process.env.MAX_TOKENS);
const allowList = parseAllowList(process.env.ALLOWED_ORIGINS);
const rateLimitPer10s = parsePositiveInt(process.env.RATE_LIMIT_PER_10S, 300);

// The rate limiter is created lazily, together with the Redis client.
let limiter: Ratelimit | undefined;
function getLimiter(redis: Redis): Ratelimit {
  limiter ??= new Ratelimit({
    redis,
    // Generous on purpose: 50 friends on one Wi-Fi network (one public IP)
    // all refreshing a few times will never come close.
    limiter: Ratelimit.slidingWindow(rateLimitPer10s, "10 s"),
    prefix: "oiam:rl",
    analytics: false,
    // If the limiter itself is slow, let the request through. Allocation
    // correctness never depends on the limiter.
    timeout: 2_000,
  });
  return limiter;
}

function json(body: TokenResponse | TokenErrorResponse, status: number, extra?: HeadersInit) {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", NO_STORE);
  res.headers.set("Vary", "Cookie");
  if (extra) new Headers(extra).forEach((v, k) => res.headers.set(k, v));
  return res;
}

function fail(
  status: number,
  code: TokenErrorResponse["code"],
  error: string,
  extra?: HeadersInit,
) {
  return json({ error, code }, status, extra);
}

export async function POST(request: NextRequest) {
  const started = performance.now();
  const h = request.headers;

  // 1) Cheap filters first. These run before any Redis call.
  if (isBotUserAgent(h.get("user-agent"))) {
    logEvent("token.rejected", { reason: "bot_ua" }, "warn");
    return fail(403, "automated_client", "Automated clients cannot take a number.");
  }
  if (
    !isAllowedOrigin({
      origin: h.get("origin"),
      host: h.get("host"),
      forwardedHost: h.get("x-forwarded-host"),
      forwardedProto: h.get("x-forwarded-proto"),
      allowList,
    }) ||
    !isAllowedFetchSite(h.get("sec-fetch-site"))
  ) {
    logEvent("token.rejected", { reason: "origin" }, "warn");
    return fail(403, "forbidden", "Cross-origin requests are not allowed.");
  }

  // 2) Input validation. The client sends nothing meaningful. We accept an
  //    empty body or an empty JSON object, and nothing else.
  const contentType = h.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return fail(400, "bad_request", "Expected Content-Type: application/json.");
  }
  const declaredLength = Number(h.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return fail(413, "payload_too_large", "Request body too large.");
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return fail(400, "bad_request", "Could not read request body.");
  }
  if (raw.length > MAX_BODY_BYTES) return fail(413, "payload_too_large", "Request body too large.");
  if (raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail(400, "bad_request", "Body must be valid JSON.");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length > 0
    ) {
      // In particular a client can never propose a number.
      return fail(400, "bad_request", "Body must be an empty JSON object.");
    }
  }

  // 3) Redis client. Missing configuration is a 503, never a local fallback.
  let redis: Redis;
  try {
    redis = getRedis();
  } catch (err) {
    logEvent("token.error", { reason: "misconfigured", error: errorSummary(err) }, "error");
    return fail(
      503,
      err instanceof RedisConfigError ? "misconfigured" : "redis_unavailable",
      "The number service is not available right now. Please try again shortly.",
      { "Retry-After": "5" },
    );
  }

  // 4) Light per-IP rate limit.
  try {
    const rl = await getLimiter(redis).limit(clientIp(h));
    if (!rl.success) {
      const retryAfter = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000));
      logEvent("token.rejected", { reason: "rate_limited" }, "warn");
      return fail(429, "rate_limited", "Too many requests. Please wait a moment.", {
        "Retry-After": String(retryAfter),
      });
    }
  } catch (err) {
    // Fail open. If Redis is down, the allocation below fails and returns 503.
    logEvent("token.ratelimit_error", { error: errorSummary(err) }, "warn");
  }

  // 5) Identity. proxy.ts normally sets the cookie on page load. Mint here as
  //    a fallback (e.g. cookies cleared between page load and this call).
  const cookieId = request.cookies.get(VISITOR_COOKIE)?.value;
  const visitorId = isValidVisitorId(cookieId) ? cookieId : newVisitorId();

  // 6) The atomic allocation.
  let result;
  try {
    result = await allocate(redis, visitorId, { maxTokens });
  } catch (err) {
    logEvent(
      "token.error",
      {
        reason: err instanceof AllocationError ? "allocation_failed" : "unexpected",
        error: errorSummary(err),
        latencyMs: Math.round(performance.now() - started),
      },
      "error",
    );
    return fail(
      503,
      "redis_unavailable",
      "We couldn't reach the number service. No number was shown, so please try again.",
      { "Retry-After": "2" },
    );
  }

  const soldOut = result.status === "soldOut";
  // When sold out, π(1,000,000) decides the backdrop (always the same, no information leak).
  const displayFor = result.number ?? 1_000_000;
  const body: TokenResponse = {
    number: result.number,
    isNew: result.isNew,
    theme: themeFor(displayFor),
    milestone: milestoneFor(result.number),
    soldOut,
  };

  logEvent("token.allocate", {
    number: result.number,
    isNew: result.isNew,
    soldOut,
    latencyMs: Math.round(performance.now() - started),
  });

  const res = json(body, 200);
  // Refresh the cookie on every response so the 1-year lifetime rolls forward.
  res.cookies.set(VISITOR_COOKIE, visitorId, visitorCookieOptions(request.url));
  return res;
}
