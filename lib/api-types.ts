import { isMilestone, type Milestone } from "./milestones";
import type { Theme } from "./primes";

export type { Theme };

/** Success body of POST /api/token. */
export type TokenResponse = {
  /** The visitor's number, or null when sold out and the visitor holds none. */
  number: number | null;
  /** True only when this request issued a brand-new number. */
  isNew: boolean;
  theme: Theme;
  milestone: Milestone | null;
  soldOut: boolean;
};

/** Error body of POST /api/token (4xx / 5xx). */
export type TokenErrorResponse = {
  error: string;
  code:
    | "redis_unavailable"
    | "misconfigured"
    | "rate_limited"
    | "forbidden"
    | "bad_request"
    | "payload_too_large";
};

/** Runtime validation of the success body. The client never trusts shapes blindly. */
export function isTokenResponse(v: unknown): v is TokenResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const numberOk =
    r.number === null ||
    (typeof r.number === "number" &&
      Number.isSafeInteger(r.number) &&
      r.number >= 1 &&
      r.number <= 1_000_000);
  return (
    numberOk &&
    typeof r.isNew === "boolean" &&
    (r.theme === "dark" || r.theme === "light") &&
    (r.milestone === null || isMilestone(r.milestone)) &&
    typeof r.soldOut === "boolean" &&
    // A sold-out reply without a number must never claim to be new.
    !(r.number === null && (r.isNew || !r.soldOut))
  );
}
