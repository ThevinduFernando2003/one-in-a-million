import { existsSync } from "node:fs";
import type { Redis } from "@upstash/redis";
import { HARD_LIMIT, KEYS } from "@/lib/config";

/** Load .env.local (then .env) for CLI scripts, without overriding real env vars. */
export function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    const before = { ...process.env };
    process.loadEnvFile(file);
    // loadEnvFile overrides. Restore anything that was explicitly set.
    for (const [k, v] of Object.entries(before)) process.env[k] = v;
  }
}

/**
 * Atomically set the counter to `to` and clear the last owner, in one
 * MULTI/EXEC transaction. No allocation can interleave between the two writes.
 */
export async function setCounter(redis: Redis, to: number): Promise<void> {
  if (!Number.isSafeInteger(to) || to < 0 || to > HARD_LIMIT) {
    throw new RangeError(`Counter value must be an integer in [0, ${HARD_LIMIT}]`);
  }
  const tx = redis.multi();
  tx.set(KEYS.counter, to);
  tx.del(KEYS.lastOwner);
  await tx.exec();
}

export async function readCounter(redis: Redis): Promise<number> {
  const v = await redis.get<number | string | null>(KEYS.counter);
  return v === null ? 0 : Number(v);
}

/** True only for loopback Redis URLs. Used to refuse destructive local-only helpers elsewhere. */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}
