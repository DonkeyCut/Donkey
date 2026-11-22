// The paid plans: their order, their names and the shape of what each one
// sells. Checkout, the webhook grant, the storage and project limits, and
// every card that sells a plan read the terms from one setting, so a price
// can't say two things in two parts of the product. Client-safe: no server
// imports.

import { LOCAL_CURRENCIES, type Currency, type LocalCurrency } from "@/lib/billing/currencies";

// Cheapest first; a plan's place in this list is its rank.
export const PAID_PLANS = ["plus", "pro", "max"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

// The display name of each plan, the same in every language.
export const PLAN_NAMES: Record<PaidPlan, string> = { plus: "Plus", pro: "Pro", max: "Max" };

// What a plan sells. su runs these through the planTerms setting, which
// holds one per plan; the server reads it fresh, the pages read it baked into
// their HTML (plan-terms-server.ts).
export type PlanTerms = {
  // The monthly price in USD; su checks it against the plan's Stripe price.
  monthlyDollars: number;
  // The monthly price in each other currency su prices it in, in whole units
  // (59 is R$59). su adds them to the plan's Stripe price.
  localPrices: Partial<Record<LocalCurrency, number>>;
  // The AI credits each billing period starts with.
  monthlyCredits: number;
  storageGb: number;
  // Whether the free project limit is lifted.
  unlimitedProjects: boolean;
  // Exports, URL imports and conversions a day (cut/server/cloud/limits.ts).
  rendersPerDay: number;
};

// Units of each local currency per US dollar, as su sets them. A local plan's
// credits follow its price at this rate, so a credit costs the same in every
// currency.
export type UsdRates = Partial<Record<LocalCurrency, number>>;

export type PlanTermsTable = Record<PaidPlan, PlanTerms> & { usdRates: UsdRates };

// The plan every upsell marks as the best value.
export const RECOMMENDED_PLAN: PaidPlan = "pro";

export function isPaidPlan(value: unknown): value is PaidPlan {
  return typeof value === "string" && (PAID_PLANS as readonly string[]).includes(value);
}

/** Where a plan sits on the ladder: free is 0, Plus 1, Pro 2, Max 3. */
export function planRank(plan: PaidPlan | null): number {
  return plan === null ? 0 : PAID_PLANS.indexOf(plan) + 1;
}

/** Whether the plans sell in a currency: USD always, any other once su has
 * set its rate and every plan's price in it. */
export function sellsIn(table: PlanTermsTable, currency: Currency): boolean {
  if (currency === "usd") {
    return true;
  }
  return table.usdRates[currency] !== undefined && PAID_PLANS.every((plan) => table[plan].localPrices[currency] !== undefined);
}

/** The currencies the plans sell in besides USD. */
export function soldLocalCurrencies(table: PlanTermsTable): LocalCurrency[] {
  return LOCAL_CURRENCIES.filter((currency) => sellsIn(table, currency));
}

/** The currency a visitor from `market` pays in: that one when the plans
 * sell in it, USD otherwise. */
export function sellingCurrency(table: PlanTermsTable, market: Currency): Currency {
  return sellsIn(table, market) ? market : "usd";
}

/** What a plan costs a month in a currency, in whole units of it. */
export function planPrice(terms: PlanTerms, currency: Currency): number {
  if (currency === "usd") {
    return terms.monthlyDollars;
  }
  const price = terms.localPrices[currency];
  if (price === undefined) {
    throw new Error(`No plan price is set in ${currency.toUpperCase()}`);
  }
  return price;
}

// Local credits round down to a whole hundred, so no currency buys a credit
// for less than USD does.
const CREDIT_STEP = 100;

/** The credits a plan's period starts with when paid in `currency`: the USD
 * plan's credits per dollar times the local price in dollars, at su's rate.
 * Storage and the other limits are the plan's in every currency. */
export function planCredits(table: PlanTermsTable, plan: PaidPlan, currency: Currency): number {
  const terms = table[plan];
  if (currency === "usd") {
    return terms.monthlyCredits;
  }

  const rate = table.usdRates[currency];
  if (rate === undefined) {
    throw new Error(`No USD rate is set for ${currency.toUpperCase()}`);
  }
  const credits = (terms.monthlyCredits * planPrice(terms, currency)) / rate / terms.monthlyDollars;
  return Math.floor(credits / CREDIT_STEP) * CREDIT_STEP;
}
