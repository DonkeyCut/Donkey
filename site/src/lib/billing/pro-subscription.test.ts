import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";

import { scheduledProEnd, subscriptionCancelAt } from "@/lib/billing/pro-subscription";

const PERIOD_START = 1_767_225_600; // 2026-01-01T00:00:00Z
const PERIOD_END = 1_769_904_000; // 2026-02-01T00:00:00Z
const CANCEL_AT = 1_780_012_800; // 2026-05-29T00:00:00Z

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    cancel_at: null,
    cancel_at_period_end: false,
    customer: "cus_1",
    items: {
      data: [
        {
          current_period_end: PERIOD_END,
          current_period_start: PERIOD_START,
          price: { id: "price_pro", unit_amount: 2000 },
        },
      ],
    },
    metadata: { userId: "user_1" },
    status: "active",
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe("subscriptionCancelAt", () => {
  test("a cancel_at date is the end, however far past the period", () => {
    expect(subscriptionCancelAt(subscription({ cancel_at: CANCEL_AT }))).toEqual(new Date(CANCEL_AT * 1000));
  });

  test("a period-end cancel carries Stripe's cancel_at for the period end", () => {
    expect(subscriptionCancelAt(subscription({ cancel_at: PERIOD_END, cancel_at_period_end: true }))).toEqual(
      new Date(PERIOD_END * 1000),
    );
  });

  test("nothing scheduled is null", () => {
    expect(subscriptionCancelAt(subscription())).toBeNull();
  });
});

describe("scheduledProEnd", () => {
  const currentPeriodEnd = new Date(PERIOD_END * 1000);
  const cancelAt = new Date(CANCEL_AT * 1000);

  test("reads the stored end date", () => {
    expect(scheduledProEnd({ cancelAt, cancelAtPeriodEnd: true, currentPeriodEnd })).toBe(cancelAt);
  });

  test("a row synced before the end date was stored reads as the period end", () => {
    expect(scheduledProEnd({ cancelAt: null, cancelAtPeriodEnd: true, currentPeriodEnd })).toBe(
      currentPeriodEnd,
    );
  });

  test("a renewing plan has no end", () => {
    expect(scheduledProEnd({ cancelAt: null, cancelAtPeriodEnd: false, currentPeriodEnd })).toBeNull();
  });
});
