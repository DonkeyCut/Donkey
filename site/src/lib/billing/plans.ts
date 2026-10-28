// The paid plans and what each one buys, in one place: checkout, the webhook
// grant, the storage and project limits, and every card that sells a plan
// read these, so a price can't say two things in two parts of the product.
// Client-safe: no server imports.

// Cheapest first; a plan's place in this list is its rank.
export const PAID_PLANS = ["plus", "pro", "max"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

export type PlanTerms = {
  // The display name, the same in every language.
  name: string;
  monthlyDollars: number;
  // The AI credits each billing period starts with.
  monthlyCredits: number;
  storageGb: number;
  // Whether the free project limit is lifted.
  unlimitedProjects: boolean;
  // Exports, URL imports and conversions a day (cut/server/cloud/limits.ts).
  rendersPerDay: number;
};

// Credits are charged at provider cost plus 30%, so a period's credits cost
// Donkey about 0.77 of their face value when spent in full. Max's 60,000
// credits come to ~$46 of provider cost against its $49 price.
export const PLAN_TERMS: Record<PaidPlan, PlanTerms> = {
  plus: { name: "Plus", monthlyDollars: 5, monthlyCredits: 5_000, storageGb: 10, unlimitedProjects: false, rendersPerDay: 10 },
  pro: { name: "Pro", monthlyDollars: 20, monthlyCredits: 20_000, storageGb: 100, unlimitedProjects: true, rendersPerDay: 200 },
  max: { name: "Max", monthlyDollars: 49, monthlyCredits: 60_000, storageGb: 500, unlimitedProjects: true, rendersPerDay: 500 },
};

// The plan every upsell marks as the best value.
export const RECOMMENDED_PLAN: PaidPlan = "pro";

export function isPaidPlan(value: unknown): value is PaidPlan {
  return typeof value === "string" && (PAID_PLANS as readonly string[]).includes(value);
}

/** Where a plan sits on the ladder: free is 0, Plus 1, Pro 2, Max 3. */
export function planRank(plan: PaidPlan | null): number {
  return plan === null ? 0 : PAID_PLANS.indexOf(plan) + 1;
}
