/**
 * Milestone tiers. Exactly one tier applies to a number: the highest one.
 * Pure and dependency-free, so client and server can both import it.
 */

export type Milestone = "hundred" | "thousand" | "tenThousand" | "hundredThousand" | "million";

export const MILESTONES: readonly Milestone[] = [
  "hundred",
  "thousand",
  "tenThousand",
  "hundredThousand",
  "million",
] as const;

export function milestoneFor(n: number | null | undefined): Milestone | null {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) return null;
  if (n === 1_000_000) return "million";
  if (n % 100_000 === 0) return "hundredThousand";
  if (n % 10_000 === 0) return "tenThousand";
  if (n % 1_000 === 0) return "thousand";
  if (n % 100 === 0) return "hundred";
  return null;
}

/** Human labels, used for screen-reader text and the calm reduced-motion banner. */
export const MILESTONE_LABEL: Record<Milestone, string> = {
  hundred: "A hundreds milestone!",
  thousand: "A thousands milestone!",
  tenThousand: "A ten-thousands milestone!",
  hundredThousand: "Legendary: a hundred-thousands milestone!",
  million: "You are one in a million",
};

export function isMilestone(value: unknown): value is Milestone {
  return typeof value === "string" && (MILESTONES as readonly string[]).includes(value);
}
