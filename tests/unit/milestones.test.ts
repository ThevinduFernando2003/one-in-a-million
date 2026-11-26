import { describe, expect, it } from "vitest";
import { isMilestone, milestoneFor } from "@/lib/milestones";

describe("milestoneFor: exactly one (the highest) tier", () => {
  it("maps the canonical tiers", () => {
    expect(milestoneFor(100)).toBe("hundred");
    expect(milestoneFor(1_000)).toBe("thousand");
    expect(milestoneFor(10_000)).toBe("tenThousand");
    expect(milestoneFor(100_000)).toBe("hundredThousand");
    expect(milestoneFor(1_000_000)).toBe("million");
  });

  it("picks the highest applicable tier", () => {
    expect(milestoneFor(200)).toBe("hundred");
    expect(milestoneFor(2_000)).toBe("thousand"); // also a multiple of 100
    expect(milestoneFor(30_000)).toBe("tenThousand"); // also of 1,000 and 100
    expect(milestoneFor(500_000)).toBe("hundredThousand");
    expect(milestoneFor(900_000)).toBe("hundredThousand");
    expect(milestoneFor(990_000)).toBe("tenThousand");
    expect(milestoneFor(999_000)).toBe("thousand");
    expect(milestoneFor(999_900)).toBe("hundred");
  });

  it("returns null for edge cases and non-milestones", () => {
    expect(milestoneFor(0)).toBeNull();
    expect(milestoneFor(-100)).toBeNull();
    expect(milestoneFor(1)).toBeNull();
    expect(milestoneFor(99)).toBeNull();
    expect(milestoneFor(101)).toBeNull();
    expect(milestoneFor(99_999)).toBeNull();
    expect(milestoneFor(999_999)).toBeNull();
    expect(milestoneFor(100.5)).toBeNull();
    expect(milestoneFor(Number.NaN)).toBeNull();
    expect(milestoneFor(Number.POSITIVE_INFINITY)).toBeNull();
    expect(milestoneFor(null)).toBeNull();
    expect(milestoneFor(undefined)).toBeNull();
  });

  it("only 1,000,000 itself is 'million'", () => {
    expect(milestoneFor(2_000_000)).toBe("hundredThousand");
  });

  it("isMilestone validates tier names", () => {
    expect(isMilestone("million")).toBe(true);
    expect(isMilestone("hundred")).toBe(true);
    expect(isMilestone("billion")).toBe(false);
    expect(isMilestone(100)).toBe(false);
    expect(isMilestone(null)).toBe(false);
  });
});
