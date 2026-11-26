import type { Redis } from "@upstash/redis";
import { HARD_LIMIT, KEYS, type AllocationKeys } from "./config";

/**
 * Lock-free, atomic token allocation.
 *
 * Redis runs each Lua script to completion on its single command thread, and
 * no other command can interleave. All script runs are therefore totally
 * ordered, with no mutexes, SETNX loops or row locks (and so no deadlocks).
 * Inside one run, "read counter → compare owner → INCR → record owner" is
 * indivisible, which gives us:
 *
 *  - Uniqueness: INCR is the only way a number is produced, and each INCR
 *    yields a value no previous INCR yielded.
 *  - Ceiling: the `cur >= max` check and the INCR happen in the same atomic
 *    step, so no interleaving can push the counter past `max`.
 *  - Arrival order: numbers follow the order in which scripts reach Redis.
 *  - Idempotency: if the caller already holds the latest number (a refresh,
 *    a retry after a timeout, a second tab, a double click), the script
 *    returns it again instead of incrementing.
 *
 * KEYS[1] = counter, KEYS[2] = last_owner
 * ARGV[1] = visitorId, ARGV[2] = maxTokens
 * Returns {number, isNew} where number = -1 means sold out.
 */
export const ALLOCATE_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local owner = redis.call('GET', KEYS[2])
if cur > 0 and owner == ARGV[1] then
  return {cur, 0}
end
if cur >= tonumber(ARGV[2]) then
  return {-1, 0}
end
local n = redis.call('INCR', KEYS[1])
redis.call('SET', KEYS[2], ARGV[1])
return {n, 1}
`.trim();

export type AllocationResult =
  | { status: "issued"; number: number; isNew: true }
  | { status: "same"; number: number; isNew: false }
  | { status: "soldOut"; number: null; isNew: false };

export class AllocationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AllocationError";
  }
}

export type AllocateOptions = {
  /** Upper bound (inclusive). Clamped to HARD_LIMIT. */
  maxTokens?: number;
  /** Override keys (tests use an isolated pair). */
  keys?: AllocationKeys;
};

type ScriptRunner = { exec(keys: string[], args: string[]): Promise<unknown> };

// One Script wrapper per client. It caches the SHA1 and uses EVALSHA,
// falling back to EVAL when Redis answers NOSCRIPT (e.g. after a restart).
const scripts = new WeakMap<Redis, ScriptRunner>();

function scriptFor(redis: Redis): ScriptRunner {
  let s = scripts.get(redis);
  if (!s) {
    s = redis.createScript<unknown>(ALLOCATE_LUA);
    scripts.set(redis, s);
  }
  return s;
}

/**
 * Allocate (or re-confirm) a number for `visitorId`.
 *
 * Throws AllocationError on any Redis failure or unexpected reply. Callers
 * must surface that as an error and never invent a number locally.
 */
export async function allocate(
  redis: Redis,
  visitorId: string,
  opts: AllocateOptions = {},
): Promise<AllocationResult> {
  if (typeof visitorId !== "string" || visitorId.length === 0 || visitorId.length > 64) {
    throw new AllocationError("Invalid visitor id.");
  }
  const max = Math.min(opts.maxTokens ?? HARD_LIMIT, HARD_LIMIT);
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new AllocationError("Invalid maxTokens.");
  }
  const keys = opts.keys ?? KEYS;

  let reply: unknown;
  try {
    reply = await scriptFor(redis).exec([keys.counter, keys.lastOwner], [visitorId, String(max)]);
  } catch (err) {
    throw new AllocationError("Redis allocation script failed.", { cause: err });
  }
  return parseReply(reply, max);
}

/** Strictly validate the script's reply. Anything unexpected is an error, never a guess. */
export function parseReply(reply: unknown, max: number): AllocationResult {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new AllocationError("Unexpected reply shape from allocation script.");
  }
  const n = Number(reply[0]);
  const flag = Number(reply[1]);
  if (!Number.isSafeInteger(n) || (flag !== 0 && flag !== 1)) {
    throw new AllocationError("Unexpected reply values from allocation script.");
  }
  if (n === -1 && flag === 0) return { status: "soldOut", number: null, isNew: false };
  // Defence in depth: refuse to display anything out of range. A freshly
  // issued number must be <= max. A re-confirmed one only has to be within the
  // hard limit, because it may have been issued before MAX_TOKENS was lowered.
  if (n < 1 || n > HARD_LIMIT || (flag === 1 && n > max)) {
    throw new AllocationError("Allocation script returned an out-of-range number.");
  }
  return flag === 1
    ? { status: "issued", number: n, isNew: true }
    : { status: "same", number: n, isNew: false };
}
