import { describe, expect, test } from "bun:test";

import { cutLimitsForTier, FREE_STORAGE_BYTES } from "./limits";

const GB = 1024 ** 3;

describe("cutLimitsForTier", () => {
  test("each plan holds its own storage", () => {
    expect(cutLimitsForTier({ superUser: false, plan: null }).storageBytes).toBe(FREE_STORAGE_BYTES);
    expect(cutLimitsForTier({ superUser: false, plan: "plus" }).storageBytes).toBe(10 * GB);
    expect(cutLimitsForTier({ superUser: false, plan: "pro" }).storageBytes).toBe(100 * GB);
    expect(cutLimitsForTier({ superUser: false, plan: "max" }).storageBytes).toBe(500 * GB);
  });

  test("Plus keeps the free render cap; Max raises Pro's", () => {
    const free = cutLimitsForTier({ superUser: false, plan: null });
    expect(cutLimitsForTier({ superUser: false, plan: "plus" }).renderJobsPerDay).toBe(free.renderJobsPerDay);
    expect(cutLimitsForTier({ superUser: false, plan: "max" }).renderJobsPerDay).toBeGreaterThan(
      cutLimitsForTier({ superUser: false, plan: "pro" }).renderJobsPerDay ?? 0,
    );
  });

  test("an unknown plan key reads as Pro", () => {
    expect(cutLimitsForTier({ superUser: false, plan: "legacy" })).toEqual(
      cutLimitsForTier({ superUser: false, plan: "pro" }),
    );
  });

  test("super users are unlimited", () => {
    expect(cutLimitsForTier({ superUser: true, plan: null }).storageBytes).toBeNull();
  });
});
