import { describe, expect, test } from "bun:test";

import { creditOfferOpen, manualOfferClosesAt } from "./offers";

describe("a manual credit offer", () => {
  test("closes the claim window a set number of days after the send", () => {
    const sent = new Date("2026-09-07T10:00:00Z");
    const closesAt = manualOfferClosesAt(3, sent);
    expect(closesAt.toISOString()).toBe("2026-09-10T10:00:00.000Z");
    expect(creditOfferOpen({ claimedAt: null, closesAt }, new Date("2026-09-10T09:59:59Z"))).toBe(true);
    expect(creditOfferOpen({ claimedAt: null, closesAt }, new Date("2026-09-10T10:00:01Z"))).toBe(false);
  });
});
