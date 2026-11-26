import { describe, expect, it } from "vitest";
import { buildPrimeCountTable, isPrime, primeCount, themeFor } from "@/lib/primes";

describe("Sieve of Eratosthenes / π(n)", () => {
  it("builds a Uint32Array covering 0..limit", () => {
    const t = buildPrimeCountTable(30);
    expect(t).toBeInstanceOf(Uint32Array);
    expect(t.length).toBe(31);
    // π for 0..30
    expect(Array.from(t)).toEqual([
      0, 0, 1, 2, 2, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6, 6, 6, 7, 7, 8, 8, 8, 8, 9, 9, 9, 9, 9, 9, 10, 10,
    ]);
  });

  it("handles tiny limits", () => {
    expect(Array.from(buildPrimeCountTable(0))).toEqual([0]);
    expect(Array.from(buildPrimeCountTable(1))).toEqual([0, 0]);
    expect(Array.from(buildPrimeCountTable(2))).toEqual([0, 0, 1]);
  });

  it("matches known values of π(n) up to one million", () => {
    expect(primeCount(0)).toBe(0);
    expect(primeCount(1)).toBe(0);
    expect(primeCount(10)).toBe(4);
    expect(primeCount(100)).toBe(25);
    expect(primeCount(1_000)).toBe(168);
    expect(primeCount(10_000)).toBe(1_229);
    expect(primeCount(100_000)).toBe(9_592);
    expect(primeCount(1_000_000)).toBe(78_498);
  });

  it("agrees with trial division for the first 5,000 numbers", () => {
    const naive = (n: number) => {
      if (n < 2) return false;
      for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
      return true;
    };
    let count = 0;
    for (let n = 0; n <= 5_000; n++) {
      if (naive(n)) count++;
      expect(primeCount(n)).toBe(count);
      expect(isPrime(n)).toBe(naive(n));
    }
  });

  it("knows the largest prime below one million", () => {
    expect(isPrime(999_983)).toBe(true);
    expect(primeCount(999_983)).toBe(78_498);
    expect(primeCount(999_982)).toBe(78_497);
    for (let n = 999_984; n <= 1_000_000; n++) expect(isPrime(n)).toBe(false);
  });

  it("rejects out-of-range input", () => {
    expect(() => primeCount(-1)).toThrow(RangeError);
    expect(() => primeCount(1_000_001)).toThrow(RangeError);
    expect(() => primeCount(1.5)).toThrow(RangeError);
    expect(() => buildPrimeCountTable(-1)).toThrow(RangeError);
  });
});

describe("theme rule: dark when π(n) is even, light when odd", () => {
  it("matches the examples from the spec", () => {
    const expected: Record<number, "dark" | "light"> = {
      1: "dark",
      2: "light",
      3: "dark",
      4: "dark",
      5: "light",
      6: "light",
      7: "dark",
    };
    for (const [n, theme] of Object.entries(expected)) {
      expect(themeFor(Number(n)), `n=${n}`).toBe(theme);
    }
  });

  it("flips exactly at primes and nowhere else", () => {
    for (let n = 2; n <= 20_000; n++) {
      const flipped = themeFor(n) !== themeFor(n - 1);
      expect(flipped, `n=${n}`).toBe(isPrime(n));
    }
  });

  it("covers the ends of the range", () => {
    expect(themeFor(1_000_000)).toBe("dark"); // π = 78498 (even)
    expect(themeFor(999_983)).toBe("dark"); // π = 78498
    expect(themeFor(999_982)).toBe("light"); // π = 78497
  });
});
