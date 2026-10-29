import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";

import { planAllowanceMicros, scheduledProEnd, subscriptionCancelAt, subscriptionPlan } from "@/lib/billing/pro-subscription";
import { SETTINGS } from "@/lib/config/registry";

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

describe("subscriptionPlan", () => {
  const prices = { plus: "price_plus", pro: "price_pro", max: "price_max" };
  const withPrice = (id: string) =>
    subscription({
      items: { data: [{ current_period_end: PERIOD_END, current_period_start: PERIOD_START, price: { id } }] },
    } as unknown as Partial<Stripe.Subscription>);

  test("names the plan its price sells", () => {
    expect(subscriptionPlan(withPrice("price_plus"), prices)?.plan).toBe("plus");
    expect(subscriptionPlan(withPrice("price_pro"), prices)?.plan).toBe("pro");
    expect(subscriptionPlan(withPrice("price_max"), prices)?.plan).toBe("max");
  });

  test("a price no plan sells is no plan", () => {
    expect(subscriptionPlan(withPrice("price_other"), prices)).toBeNull();
    expect(subscriptionPlan(withPrice("price_pro"), { ...prices, pro: null })).toBeNull();
  });

  test("a recorded subscription on an unlisted price keeps its row's plan", () => {
    expect(subscriptionPlan(withPrice("price_legacy_pro"), prices, "pro")?.plan).toBe("pro");
    expect(subscriptionPlan(withPrice("price_pro"), { plus: null, pro: null, max: null }, "pro")?.plan).toBe("pro");
  });

  test("a listed price wins over the recorded plan", () => {
    expect(subscriptionPlan(withPrice("price_max"), prices, "plus")?.plan).toBe("max");
  });
});

describe("planAllowanceMicros", () => {
  // 1,000 credits a dollar; a dollar is a million micros.
  test("grants each plan's credits", () => {
    const terms = SETTINGS.planTerms.default;
    expect(planAllowanceMicros(terms.plus)).toBe(BigInt(5_000_000));
    expect(planAllowanceMicros(terms.pro)).toBe(BigInt(20_000_000));
    expect(planAllowanceMicros(terms.max)).toBe(BigInt(60_000_000));
  });
});
