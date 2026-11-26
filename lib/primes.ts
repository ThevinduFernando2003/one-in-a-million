import { HARD_LIMIT } from "./config";

/**
 * Prime-counting table π(n) for 0 <= n <= limit, built with a Sieve of
 * Eratosthenes. The default build covers 1,000,000 and costs about 4 MB plus
 * ~10 ms, once per server instance. It is derived data, not allocation
 * state, so caching it in module scope is fine.
 */
export function buildPrimeCountTable(limit: number = HARD_LIMIT): Uint32Array {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("limit must be a non-negative integer");
  }
  // composite[i] === 1 means i is not prime.
  const composite = new Uint8Array(limit + 1);
  if (limit >= 0) composite[0] = 1;
  if (limit >= 1) composite[1] = 1;
  for (let i = 2; i * i <= limit; i++) {
    if (composite[i] === 0) {
      for (let j = i * i; j <= limit; j += i) composite[j] = 1;
    }
  }
  const pi = new Uint32Array(limit + 1);
  let count = 0;
  for (let i = 0; i <= limit; i++) {
    if (composite[i] === 0) count++;
    pi[i] = count;
  }
  return pi;
}

let table: Uint32Array | undefined;

function getTable(): Uint32Array {
  table ??= buildPrimeCountTable(HARD_LIMIT);
  return table;
}

/** π(n): the number of primes <= n. Valid for 0 <= n <= 1,000,000. */
export function primeCount(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > HARD_LIMIT) {
    throw new RangeError(`primeCount: n must be an integer in [0, ${HARD_LIMIT}]`);
  }
  return getTable()[n]!;
}

export function isPrime(n: number): boolean {
  if (!Number.isInteger(n) || n < 2 || n > HARD_LIMIT) return false;
  return primeCount(n) !== primeCount(n - 1);
}

export type Theme = "dark" | "light";

/**
 * The theme flips every time the number is prime:
 * dark when π(n) is even, light when it is odd.
 * 1 → dark, 2 → light, 3 → dark, 4 → dark, 5 → light, 6 → light, 7 → dark …
 */
export function themeFor(n: number): Theme {
  return primeCount(n) % 2 === 0 ? "dark" : "light";
}
