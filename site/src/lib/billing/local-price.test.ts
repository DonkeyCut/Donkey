import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";

import { localPriceWrite } from "@/lib/billing/local-price";

const price = (options: Record<string, number> = {}) =>
  ({
    currency: "usd",
    currency_options: Object.fromEntries(Object.entries(options).map(([c, unit_amount]) => [c, { unit_amount }])),
    id: "price_pro",
  }) as unknown as Stripe.Price;

describe("localPriceWrite", () => {
  test("a price without the currency gets it at the terms' amount", () => {
    expect(localPriceWrite(price(), 2_800, "jpy")).toEqual({ currency_options: { jpy: { unit_amount: 2_800 } } });
    expect(localPriceWrite(price(), 59, "brl")).toEqual({ currency_options: { brl: { unit_amount: 5_900 } } });
  });

  test("a price already selling the amount needs nothing", () => {
    expect(localPriceWrite(price({ brl: 5_900 }), 59, "brl")).toBeNull();
  });

  test("USD sells at the price's own amount", () => {
    expect(localPriceWrite(price(), 20, "usd")).toBeNull();
  });

  test("a price holding another amount is refused", () => {
    expect(() => localPriceWrite(price({ brl: 4_900 }), 59, "brl")).toThrow();
  });
});
