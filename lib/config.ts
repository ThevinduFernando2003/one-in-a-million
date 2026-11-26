/**
 * Shared, side-effect-free configuration. Safe to import from the server,
 * CLI scripts and tests. Nothing here is mutable allocation state.
 */

/** The absolute ceiling. No configuration can raise it. */
export const HARD_LIMIT = 1_000_000;

/**
 * Redis keys. The `{oiam}` hash tag forces both keys into the same cluster
 * slot, which a multi-key Lua script requires on clustered Redis.
 */
export const KEYS = {
  counter: "{oiam}:counter",
  lastOwner: "{oiam}:last_owner",
} as const;

export type AllocationKeys = { counter: string; lastOwner: string };

/**
 * Parse MAX_TOKENS. Missing or invalid values fall back to the hard limit.
 * Values above the hard limit are clamped, so 1,000,001 can never be issued
 * even if the environment is misconfigured.
 */
export function parseMaxTokens(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return HARD_LIMIT;
  if (!/^\d+$/.test(raw.trim())) return HARD_LIMIT;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 1) return HARD_LIMIT;
  return Math.min(n, HARD_LIMIT);
}

/** Parse a positive integer env var with a default. */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
