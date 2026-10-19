import { describe, expect, test } from "bun:test";

import { heldPro, introCouponId, introOfferAt, introPriceCents } from "./intro-offer";

const HOUR_MS = 3_600_000;
const signup = new Date("2026-10-16T12:00:00Z");
const setting = { percentOff: 50, months: 1, windowHours: 24 };
const fresh = { createdAt: signup, heldPro: false };

describe("introOfferAt", () => {
  test("opens inside the window and closes at its end", () => {
    const offer = introOfferAt(setting, fresh, new Date(signup.getTime() + HOUR_MS));
    expect(offer).toEqual({ percentOff: 50, months: 1, endsAt: new Date(signup.getTime() + 24 * HOUR_MS) });
    expect(introOfferAt(setting, fresh, new Date(signup.getTime() + 24 * HOUR_MS))).toBeNull();
  });

  test("makes no offer at 0 percent, the default", () => {
    expect(introOfferAt({ ...setting, percentOff: 0 }, fresh, signup)).toBeNull();
  });

  test("makes no offer to an account that held Pro", () => {
    expect(introOfferAt(setting, { ...fresh, heldPro: true }, signup)).toBeNull();
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
