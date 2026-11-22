import { expect, test } from "bun:test";

import { PAID_PLANS, planCredits, planPrice, sellingCurrency, type PlanTermsTable } from "@/lib/billing/plans";
import { SETTINGS } from "@/lib/config/registry";

// Made-up local prices and rate: the real ones live in the planTerms setting.
const base = SETTINGS.planTerms.default;
const table: PlanTermsTable = {
  plus: { ...base.plus, localPrices: { brl: 20 } },
  pro: { ...base.pro, localPrices: { brl: 80 } },
  max: { ...base.max, localPrices: { brl: 200 } },
  usdRates: { brl: 8 },
};

test("a USD plan starts with its own credits", () => {
  expect(planCredits(table, "pro", "usd")).toBe(base.pro.monthlyCredits);
});

test("a local plan's credits follow its price in dollars, rounded down", () => {
  // 20 at 8 a dollar is $2.50: 2,500 credits at Plus's 1,000 a dollar.
  expect(planCredits(table, "plus", "brl")).toBe(2_500);
});

test("no currency buys a credit for less than USD does", () => {
  for (const plan of PAID_PLANS) {
    const usdRate = base[plan].monthlyCredits / base[plan].monthlyDollars;
    const dollars = planPrice(table[plan], "brl") / table.usdRates.brl!;
    expect(planCredits(table, plan, "brl")).toBeLessThanOrEqual(usdRate * dollars);
  }
});

test("a currency sells only once it has a rate and every plan's price", () => {
  expect(sellingCurrency(table, "brl")).toBe("brl");
  expect(sellingCurrency(table, "jpy")).toBe("usd");
  expect(sellingCurrency({ ...table, usdRates: {} }, "brl")).toBe("usd");
  expect(sellingCurrency(base, "eur")).toBe("usd");
});
