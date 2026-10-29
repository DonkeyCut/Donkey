import { describe, expect, test } from "bun:test";

import { heldPro, introCouponId, introOfferAt, introOfferPreview, introPriceMinor, offersIntro } from "./intro-offer";

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
  expect(introPriceMinor(2000, 50)).toBe(1000);
  expect(introPriceMinor(1999, 33)).toBe(1339);
});

describe("introOfferPreview", () => {
  const setting = { percentOff: 50, months: 1, windowHours: 73 };
  const now = new Date("2026-10-29T00:00:00Z");

  test("an account that has not seen it gets the terms with the window unstarted", () => {
    expect(introOfferPreview(setting, { seenAt: null, heldPro: false }, now)).toEqual({
      percentOff: 50,
      months: 1,
      windowHours: 73,
      endsAt: null,
    });
  });

  test("an account inside its window gets the window's end", () => {
    const seenAt = new Date("2026-10-28T00:00:00Z");
    expect(introOfferPreview(setting, { seenAt, heldPro: false }, now)?.endsAt).toEqual(
      new Date("2026-10-31T01:00:00Z"),
    );
  });

  test("a closed window, a past subscriber, or no offer is null", () => {
    expect(introOfferPreview(setting, { seenAt: new Date("2026-10-01T00:00:00Z"), heldPro: false }, now)).toBeNull();
    expect(introOfferPreview(setting, { seenAt: null, heldPro: true }, now)).toBeNull();
    expect(introOfferPreview({ ...setting, percentOff: 0 }, { seenAt: null, heldPro: false }, now)).toBeNull();
  });
});
