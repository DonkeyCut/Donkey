import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";

import { declinedUpgrade, liftScheduledCancel, upgradeKey } from "@/lib/billing/plan-upgrade";

function subscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    cancel_at: null,
    cancel_at_period_end: false,
    latest_invoice: "in_1",
    metadata: {},
    ...overrides,
  } as unknown as Stripe.Subscription;
}

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
