import { describe, expect, test } from "bun:test";

import { heldPro, introCouponId, introOfferAt, introPriceCents, offersIntro } from "./intro-offer";

const HOUR_MS = 3_600_000;
const seen = new Date("2026-10-16T12:00:00Z");
const setting = { percentOff: 50, months: 1, windowHours: 24 };
const fresh = { seenAt: seen, heldPro: false };

describe("introOfferAt", () => {
  test("opens inside the window and closes at its end", () => {
    const offer = introOfferAt(setting, fresh, new Date(seen.getTime() + HOUR_MS));
    expect(offer).toEqual({ percentOff: 50, months: 1, endsAt: new Date(seen.getTime() + 24 * HOUR_MS) });
    expect(introOfferAt(setting, fresh, new Date(seen.getTime() + 24 * HOUR_MS))).toBeNull();
  });

  test("makes no offer at 0 percent, the default", () => {
    expect(introOfferAt({ ...setting, percentOff: 0 }, fresh, seen)).toBeNull();
  });

  test("makes no offer to an account that held Pro", () => {
    expect(introOfferAt(setting, { ...fresh, heldPro: true }, seen)).toBeNull();
  });

  test("has nothing open before the account first sees it", () => {
    expect(introOfferAt(setting, { ...fresh, seenAt: null }, seen)).toBeNull();
  });
});

describe("offersIntro", () => {
  test("is for an account that never held a plan, while the offer is on", () => {
    expect(offersIntro(setting, { heldPro: false })).toBe(true);
    expect(offersIntro(setting, { heldPro: true })).toBe(false);
    expect(offersIntro({ ...setting, percentOff: 0 }, { heldPro: false })).toBe(false);
  });
});

describe("heldPro", () => {
  test("a checkout that never paid held nothing", () => {
    expect(heldPro(null)).toBe(false);
    expect(heldPro("incomplete")).toBe(false);
    expect(heldPro("incomplete_expired")).toBe(false);
    expect(heldPro("canceled")).toBe(true);
    expect(heldPro("active")).toBe(true);
  });
});

test("one coupon per pair of terms", () => {
  expect(introCouponId({ percentOff: 50, months: 1 })).toBe("donkey-intro-50-1m");
  expect(introCouponId({ percentOff: 25, months: 3 })).toBe("donkey-intro-25-3m");
});

test("the intro price rounds to the cent", () => {
  expect(introPriceCents(2000, 50)).toBe(1000);
  expect(introPriceCents(1999, 33)).toBe(1339);
});
