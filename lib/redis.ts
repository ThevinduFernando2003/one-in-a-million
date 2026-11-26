import { Redis } from "@upstash/redis";

/**
 * Upstash Redis client factory.
 *
 * The client is a stateless HTTP wrapper (every command is a separate REST
 * call), so caching one per server instance is fine. No allocation state ever
 * lives in this process: the counter exists only in Redis.
 */

export class RedisConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisConfigError";
  }
}

export type RedisCredentials = { url: string; token: string };

/**
 * Resolve credentials. Prefer the Upstash names and fall back to the names
 * the Vercel Marketplace integration injects (KV_REST_API_*).
 */
export function resolveRedisCredentials(
  env: Record<string, string | undefined> = process.env,
): RedisCredentials {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new RedisConfigError(
      "Redis is not configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN " +
        "(or KV_REST_API_URL and KV_REST_API_TOKEN).",
    );
  }
  try {
    new URL(url);
  } catch {
    throw new RedisConfigError("Redis REST URL is not a valid URL.");
  }
  return { url, token };
}

/**
 * Per-command timeout. Deliberately generous ("slow is fine, wrong is not").
 * If we stopped waiting while Redis was still queueing our script, the
 * script could still run and issue a number whose response nobody receives.
 * That number would be burned (a gap). A truly dead Redis fails fast anyway
 * (connection refused), so this only bounds a pathologically slow one. It
 * stays below the route's maxDuration (30 s).
 */
const COMMAND_TIMEOUT_MS = 20_000;

export function createRedis(creds: RedisCredentials = resolveRedisCredentials()): Redis {
  return new Redis({
    url: creds.url,
    token: creds.token,
    // Retry transport-level failures a couple of times. Re-running the
    // allocation script is safe: the owner check makes it idempotent for the
    // same visitor (see lib/allocate.ts).
    retry: { retries: 2, backoff: (n) => Math.min(1000, 50 * 2 ** n) },
    // A fresh signal per request, so each command gets its own timeout.
    signal: () => AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    enableTelemetry: false,
  });
}

let cached: Redis | undefined;

/** Lazily create one client per server instance. Throws RedisConfigError if env is missing. */
export function getRedis(): Redis {
  cached ??= createRedis();
  return cached;
}
