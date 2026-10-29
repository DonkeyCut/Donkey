import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";

import { declinedUpgrade, dropIntroDiscount, liftScheduledCancel, upgradeKey } from "@/lib/billing/plan-upgrade";

const INTRO = "donkey-intro-50-3m";

function subscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    cancel_at: null,
    cancel_at_period_end: false,
    discounts: [],
    latest_invoice: "in_1",
    metadata: {},
    ...overrides,
  } as unknown as Stripe.Subscription;
}

const discount = (id: string, coupon: string) => ({ id, source: { coupon, type: "coupon" } });

describe("liftScheduledCancel", () => {
  test("a period-end cancel is lifted by its flag alone", () => {
    expect(liftScheduledCancel(subscription({ cancel_at: 1_800_000_000, cancel_at_period_end: true }))).toEqual({
      cancel_at_period_end: false,
    });
  });

  test("a dated cancel is lifted by clearing the date alone", () => {
    expect(liftScheduledCancel(subscription({ cancel_at: 1_800_000_000 }))).toEqual({ cancel_at: "" });
  });

  test("a renewing subscription sends neither field", () => {
    expect(liftScheduledCancel(subscription())).toEqual({});
  });
});

describe("dropIntroDiscount", () => {
  test("drops the intro coupon and keeps the rest", () => {
    const sub = subscription({
      discounts: [discount("di_intro", INTRO), discount("di_promo", "promo")],
      metadata: { introOffer: INTRO },
    });
    expect(dropIntroDiscount(sub)).toEqual({ discounts: [{ discount: "di_promo" }] });
  });

  test("clears the discounts when the intro was the only one", () => {
    const sub = subscription({ discounts: [discount("di_intro", INTRO)], metadata: { introOffer: INTRO } });
    expect(dropIntroDiscount(sub)).toEqual({ discounts: "" });
  });

  test("leaves the discounts alone without the intro", () => {
    expect(dropIntroDiscount(subscription({ discounts: [discount("di_promo", "promo")] }))).toEqual({});
    expect(dropIntroDiscount(subscription({ metadata: { introOffer: INTRO } }))).toEqual({});
  });

  test("refuses unexpanded discounts", () => {
    expect(() => dropIntroDiscount(subscription({ discounts: ["di_1"], metadata: { introOffer: INTRO } }))).toThrow();
  });
});

describe("upgradeKey", () => {
  test("the same state gives the same key", () => {
    expect(upgradeKey(subscription(), "price_plus", "price_max")).toBe(upgradeKey(subscription(), "price_plus", "price_max"));
  });

  test("a new invoice gives a new key", () => {
    expect(upgradeKey(subscription({ latest_invoice: "in_2" }), "price_plus", "price_max")).not.toBe(
      upgradeKey(subscription(), "price_plus", "price_max"),
    );
  });

  test("a declined attempt gives the retry a new key", () => {
    const declined = subscription(declinedUpgrade(subscription()));
    expect(upgradeKey(declined, "price_plus", "price_max")).not.toBe(
      upgradeKey(subscription(), "price_plus", "price_max"),
    );
    const again = subscription(declinedUpgrade(declined));
    expect(upgradeKey(again, "price_plus", "price_max")).not.toBe(upgradeKey(declined, "price_plus", "price_max"));
  });
});
