import { describe, expect, it } from "vitest";
import { ALLOCATE_LUA, AllocationError, parseReply } from "@/lib/allocate";
import { isTokenResponse } from "@/lib/api-types";
import { HARD_LIMIT, KEYS, parseMaxTokens, parsePositiveInt } from "@/lib/config";
import { RedisConfigError, resolveRedisCredentials } from "@/lib/redis";

describe("config", () => {
  it("defaults and clamps MAX_TOKENS to the hard limit", () => {
    expect(HARD_LIMIT).toBe(1_000_000);
    expect(parseMaxTokens(undefined)).toBe(1_000_000);
    expect(parseMaxTokens("")).toBe(1_000_000);
    expect(parseMaxTokens("1000000")).toBe(1_000_000);
    expect(parseMaxTokens("1000001")).toBe(1_000_000);
    expect(parseMaxTokens("99999999999")).toBe(1_000_000);
    expect(parseMaxTokens("500")).toBe(500);
    expect(parseMaxTokens(" 42 ")).toBe(42);
    expect(parseMaxTokens("0")).toBe(1_000_000);
    expect(parseMaxTokens("-5")).toBe(1_000_000);
    expect(parseMaxTokens("1e6")).toBe(1_000_000);
    expect(parseMaxTokens("abc")).toBe(1_000_000);
  });

  it("parses positive ints with fallback", () => {
    expect(parsePositiveInt("300", 1)).toBe(300);
    expect(parsePositiveInt(undefined, 7)).toBe(7);
    expect(parsePositiveInt("0", 7)).toBe(7);
    expect(parsePositiveInt("x", 7)).toBe(7);
  });

  it("uses hash-tagged keys that share one cluster slot", () => {
    const tag = (k: string) => /\{([^}]+)\}/.exec(k)?.[1];
    expect(tag(KEYS.counter)).toBe("oiam");
    expect(tag(KEYS.lastOwner)).toBe("oiam");
  });
});

describe("Redis credentials", () => {
  it("prefers UPSTASH_* and falls back to KV_REST_API_*", () => {
    expect(
      resolveRedisCredentials({
        UPSTASH_REDIS_REST_URL: "https://a.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "t1",
        KV_REST_API_URL: "https://b.upstash.io",
        KV_REST_API_TOKEN: "t2",
      }),
    ).toEqual({ url: "https://a.upstash.io", token: "t1" });
    expect(
      resolveRedisCredentials({ KV_REST_API_URL: "https://b.upstash.io", KV_REST_API_TOKEN: "t2" }),
    ).toEqual({ url: "https://b.upstash.io", token: "t2" });
  });
  it("throws a config error when missing or malformed", () => {
    expect(() => resolveRedisCredentials({})).toThrow(RedisConfigError);
    expect(() => resolveRedisCredentials({ UPSTASH_REDIS_REST_URL: "https://a.io" })).toThrow(
      RedisConfigError,
    );
    expect(() =>
      resolveRedisCredentials({
        UPSTASH_REDIS_REST_URL: "not a url",
        UPSTASH_REDIS_REST_TOKEN: "t",
      }),
    ).toThrow(RedisConfigError);
  });
});

describe("allocation script reply parsing", () => {
  it("maps issued / same / sold out", () => {
    expect(parseReply([7, 1], 1_000_000)).toEqual({ status: "issued", number: 7, isNew: true });
    expect(parseReply([7, 0], 1_000_000)).toEqual({ status: "same", number: 7, isNew: false });
    expect(parseReply([-1, 0], 1_000_000)).toEqual({
      status: "soldOut",
      number: null,
      isNew: false,
    });
    expect(parseReply(["12", "1"], 1_000_000)).toEqual({
      status: "issued",
      number: 12,
      isNew: true,
    });
  });

  it("rejects anything unexpected instead of guessing", () => {
    for (const bad of [
      null,
      [],
      [1],
      [1, 2],
      [1, 1, 1],
      ["x", 1],
      [1.5, 1],
      [0, 1],
      [-1, 1],
      "3",
      { 0: 1, 1: 1 },
    ]) {
      expect(() => parseReply(bad, 1_000_000), JSON.stringify(bad)).toThrow(AllocationError);
    }
  });

  it("never accepts a newly issued number above max or the hard limit", () => {
    expect(() => parseReply([1_000_001, 1], 1_000_000)).toThrow(AllocationError);
    expect(() => parseReply([1_000_001, 0], 1_000_000)).toThrow(AllocationError);
    expect(() => parseReply([11, 1], 10)).toThrow(AllocationError);
    // A number issued before MAX_TOKENS was lowered is still shown to its holder.
    expect(parseReply([11, 0], 10)).toEqual({ status: "same", number: 11, isNew: false });
  });

  it("the Lua script is the specified one (owner check before the ceiling check)", () => {
    const ownerIdx = ALLOCATE_LUA.indexOf("owner == ARGV[1]");
    const ceilIdx = ALLOCATE_LUA.indexOf("cur >= tonumber(ARGV[2])");
    const incrIdx = ALLOCATE_LUA.indexOf("INCR");
    expect(ownerIdx).toBeGreaterThan(0);
    expect(ownerIdx).toBeLessThan(ceilIdx);
    expect(ceilIdx).toBeLessThan(incrIdx);
  });
});

describe("isTokenResponse", () => {
  const ok = { number: 5, isNew: true, theme: "light", milestone: null, soldOut: false };
  it("accepts valid bodies", () => {
    expect(isTokenResponse(ok)).toBe(true);
    expect(isTokenResponse({ ...ok, number: 100, milestone: "hundred" })).toBe(true);
    expect(
      isTokenResponse({
        number: null,
        isNew: false,
        theme: "dark",
        milestone: null,
        soldOut: true,
      }),
    ).toBe(true);
  });
  it("rejects malformed bodies", () => {
    expect(isTokenResponse(null)).toBe(false);
    expect(isTokenResponse({ ...ok, number: 0 })).toBe(false);
    expect(isTokenResponse({ ...ok, number: 1_000_001 })).toBe(false);
    expect(isTokenResponse({ ...ok, number: "5" })).toBe(false);
    expect(isTokenResponse({ ...ok, theme: "blue" })).toBe(false);
    expect(isTokenResponse({ ...ok, milestone: "billion" })).toBe(false);
    expect(isTokenResponse({ ...ok, isNew: "yes" })).toBe(false);
    expect(
      isTokenResponse({ number: null, isNew: true, theme: "dark", milestone: null, soldOut: true }),
    ).toBe(false);
    expect(
      isTokenResponse({
        number: null,
        isNew: false,
        theme: "dark",
        milestone: null,
        soldOut: false,
      }),
    ).toBe(false);
  });
});
