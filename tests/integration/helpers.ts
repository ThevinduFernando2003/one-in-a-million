import { Redis } from "@upstash/redis";
import type { AllocationKeys } from "@/lib/config";

/**
 * Real Redis for integration tests. Locally this is the docker-compose pair
 * (redis + SRH). Start it with `npm run redis:up`. Tests FAIL (they don't
 * skip) when Redis is unreachable, so a missing database can't pass silently.
 */
export const TEST_URL = process.env.UPSTASH_REDIS_REST_URL || "http://localhost:8079";
export const TEST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "oiam-local-dev-token";

export function testRedis(): Redis {
  return new Redis({ url: TEST_URL, token: TEST_TOKEN, enableTelemetry: false });
}

export async function waitForRedis(redis: Redis, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < until) {
    try {
      if ((await redis.ping()) === "PONG") return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Redis (SRH) not reachable at ${TEST_URL}. Run "npm run redis:up" first. Last error: ${String(lastErr)}`,
  );
}

/** A fresh, isolated key pair per test (same hash tag for both keys). */
export function isolatedKeys(): AllocationKeys {
  const tag = `oiam-test-${crypto.randomUUID()}`;
  return { counter: `{${tag}}:counter`, lastOwner: `{${tag}}:last_owner` };
}

export async function dropKeys(redis: Redis, keys: AllocationKeys) {
  await redis.del(keys.counter, keys.lastOwner);
}

export const visitor = () => crypto.randomUUID();
