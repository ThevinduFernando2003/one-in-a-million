import { Redis } from "@upstash/redis";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { allocate, AllocationError } from "@/lib/allocate";
import type { AllocationKeys } from "@/lib/config";
import { dropKeys, isolatedKeys, testRedis, visitor, waitForRedis } from "./helpers";

const redis = testRedis();
let keys: AllocationKeys;
const used: AllocationKeys[] = [];

function fresh() {
  keys = isolatedKeys();
  used.push(keys);
  return keys;
}

beforeAll(async () => {
  await waitForRedis(redis);
});

afterEach(async () => {
  while (used.length) await dropKeys(redis, used.pop()!);
});

describe("allocation rules against real Redis", () => {
  it("first visitor ever gets 1", async () => {
    fresh();
    const r = await allocate(redis, visitor(), { keys });
    expect(r).toEqual({ status: "issued", number: 1, isNew: true });
  });

  it("A/B scenario: A→3, A refresh→3, B→4, A refresh→5", async () => {
    fresh();
    await redis.set(keys.counter, 2); // two numbers already issued
    const A = visitor();
    const B = visitor();

    expect(await allocate(redis, A, { keys })).toEqual({
      status: "issued",
      number: 3,
      isNew: true,
    });
    expect(await allocate(redis, A, { keys })).toEqual({ status: "same", number: 3, isNew: false });
    expect(await allocate(redis, A, { keys })).toEqual({ status: "same", number: 3, isNew: false });
    expect(await allocate(redis, B, { keys })).toEqual({
      status: "issued",
      number: 4,
      isNew: true,
    });
    expect(await allocate(redis, A, { keys })).toEqual({
      status: "issued",
      number: 5,
      isNew: true,
    });
    // B is no longer the latest holder either.
    expect(await allocate(redis, B, { keys })).toEqual({
      status: "issued",
      number: 6,
      isNew: true,
    });
    expect(await redis.get(keys.counter)).toBe(6);
  });

  it("sold-out boundary: 999,998 → 999,999 → 1,000,000 → sold out", async () => {
    fresh();
    await redis.set(keys.counter, 999_998);
    const [v1, v2, v3, v4] = [visitor(), visitor(), visitor(), visitor()];

    expect(await allocate(redis, v1, { keys })).toEqual({
      status: "issued",
      number: 999_999,
      isNew: true,
    });
    expect(await allocate(redis, v2, { keys })).toEqual({
      status: "issued",
      number: 1_000_000,
      isNew: true,
    });
    expect(await allocate(redis, v3, { keys })).toEqual({
      status: "soldOut",
      number: null,
      isNew: false,
    });
    expect(await allocate(redis, v4, { keys })).toEqual({
      status: "soldOut",
      number: null,
      isNew: false,
    });
    // The holder of 1,000,000 keeps it on refresh.
    expect(await allocate(redis, v2, { keys })).toEqual({
      status: "same",
      number: 1_000_000,
      isNew: false,
    });
    // The earlier holder doesn't get a new one: there are none left.
    expect(await allocate(redis, v1, { keys })).toEqual({
      status: "soldOut",
      number: null,
      isNew: false,
    });
    // The counter never moved past the limit.
    expect(await redis.get(keys.counter)).toBe(1_000_000);
  });

  it("a misconfigured MAX_TOKENS above the hard limit still stops at 1,000,000", async () => {
    fresh();
    await redis.set(keys.counter, 999_999);
    expect((await allocate(redis, visitor(), { keys, maxTokens: 5_000_000 })).number).toBe(
      1_000_000,
    );
    expect((await allocate(redis, visitor(), { keys, maxTokens: 5_000_000 })).status).toBe(
      "soldOut",
    );
    expect(await redis.get(keys.counter)).toBe(1_000_000);
  });

  it("respects a lower configured MAX_TOKENS", async () => {
    fresh();
    const got = [];
    for (let i = 0; i < 5; i++)
      got.push((await allocate(redis, visitor(), { keys, maxTokens: 3 })).number);
    expect(got).toEqual([1, 2, 3, null, null]);
  });
});

describe("concurrency against real Redis", () => {
  it("500 simultaneous distinct visitors get unique, contiguous numbers 1..500", async () => {
    fresh();
    const N = 500;
    const results = await Promise.all(
      Array.from({ length: N }, () => allocate(redis, visitor(), { keys })),
    );
    const nums = results.map((r) => r.number!).sort((a, b) => a - b);
    expect(results.every((r) => r.isNew)).toBe(true);
    expect(new Set(nums).size).toBe(N);
    expect(nums[0]).toBe(1);
    expect(nums[N - 1]).toBe(N);
    expect(await redis.get(keys.counter)).toBe(N);
  });

  it("20 simultaneous requests from the SAME visitor yield exactly one number", async () => {
    fresh();
    await redis.set(keys.counter, 41);
    const A = visitor();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => allocate(redis, A, { keys })),
    );
    const distinct = new Set(results.map((r) => r.number));
    expect([...distinct]).toEqual([42]);
    expect(results.filter((r) => r.isNew)).toHaveLength(1);
    expect(await redis.get(keys.counter)).toBe(42);
  });

  it("racing at the ceiling: 50 visitors for the last 10 numbers", async () => {
    fresh();
    await redis.set(keys.counter, 999_990);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => allocate(redis, visitor(), { keys })),
    );
    const issued = results.filter((r) => r.status === "issued").map((r) => r.number!);
    const soldOut = results.filter((r) => r.status === "soldOut");
    expect(issued.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => 999_991 + i));
    expect(soldOut).toHaveLength(40);
    expect(await redis.get(keys.counter)).toBe(1_000_000);
  });

  it("idempotent retry: re-sending after a 'lost' response returns the same number", async () => {
    fresh();
    const A = visitor();
    const first = await allocate(redis, A, { keys }); // pretend this response was lost
    const retry = await allocate(redis, A, { keys });
    expect(retry.number).toBe(first.number);
    expect(retry.isNew).toBe(false);
  });
});

describe("resilience", () => {
  it("recovers from a flushed script cache (EVALSHA → NOSCRIPT → EVAL)", async () => {
    fresh();
    expect((await allocate(redis, visitor(), { keys })).number).toBe(1);
    await redis.scriptFlush();
    expect((await allocate(redis, visitor(), { keys })).number).toBe(2);
  });

  it("fails loudly (no local fallback) when Redis is unreachable", async () => {
    const dead = new Redis({
      url: "http://127.0.0.1:1",
      token: "x",
      retry: false,
      enableTelemetry: false,
    });
    await expect(allocate(dead, visitor(), { keys: isolatedKeys() })).rejects.toBeInstanceOf(
      AllocationError,
    );
  });

  it("fails loudly when the counter key holds garbage", async () => {
    fresh();
    await redis.set(keys.counter, "not-a-number");
    await expect(allocate(redis, visitor(), { keys })).rejects.toBeInstanceOf(AllocationError);
  });

  it("rejects an invalid visitor id before touching Redis", async () => {
    await expect(allocate(redis, "", { keys: isolatedKeys() })).rejects.toBeInstanceOf(
      AllocationError,
    );
  });
});
