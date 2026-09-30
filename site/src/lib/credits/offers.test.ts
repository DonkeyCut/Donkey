import { describe, expect, test } from "bun:test";

import { creditOfferOpen } from "./offers";

describe("a credit offer", () => {
  test("stays open until its claim window closes", () => {
    const closesAt = new Date("2026-09-10T10:00:00Z");
    expect(creditOfferOpen({ claimedAt: null, closesAt }, new Date("2026-09-10T09:59:59Z"))).toBe(true);
    expect(creditOfferOpen({ claimedAt: null, closesAt }, new Date("2026-09-10T10:00:01Z"))).toBe(false);
  });
});
