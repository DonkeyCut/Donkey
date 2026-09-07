import { describe, expect, test } from "bun:test";

import { promotedAllowanceMicros, promotionCovers } from "./allowance-promotion";

const base = BigInt(20_000_000);
const five = BigInt(100_000_000);

describe("promotedAllowanceMicros", () => {
  test("a multiplier of one is the plain allowance", () => {
    expect(promotedAllowanceMicros(base, { multiplier: 1, lastDay: null }, new Date())).toBe(base);
    expect(promotedAllowanceMicros(base, { multiplier: 1, lastDay: "2026-10-29" }, new Date("2026-09-01T00:00:00Z"))).toBe(base);
  });

  test("a period starting on or before the last day is multiplied", () => {
    const promo = { multiplier: 5, lastDay: "2026-10-29" };
    expect(promotedAllowanceMicros(base, promo, new Date("2026-09-10T12:00:00Z"))).toBe(five);
    expect(promotedAllowanceMicros(base, promo, new Date("2026-10-29T23:59:59Z"))).toBe(five);
  });

  test("a period starting after the last day reads the plain plan", () => {
    const promo = { multiplier: 5, lastDay: "2026-10-29" };
    expect(promotedAllowanceMicros(base, promo, new Date("2026-10-30T00:00:00Z"))).toBe(base);
    expect(promotedAllowanceMicros(base, promo, new Date("2026-11-10T00:00:00Z"))).toBe(base);
  });

  test("no last day keeps the multiplier on", () => {
    expect(promotionCovers({ multiplier: 3, lastDay: null }, new Date("2030-01-01T00:00:00Z"))).toBe(true);
  });

  test("a malformed day closes the promotion", () => {
    expect(promotionCovers({ multiplier: 3, lastDay: "not-a-day" }, new Date())).toBe(false);
  });
});
