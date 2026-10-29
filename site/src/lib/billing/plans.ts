// The paid plans: their order, their names and the shape of what each one
// sells. Checkout, the webhook grant, the storage and project limits, and
// every card that sells a plan read the terms from one setting, so a price
// can't say two things in two parts of the product. Client-safe: no server
// imports.

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
  // The AI credits each billing period starts with.
  monthlyCredits: number;
  storageGb: number;
  // Whether the free project limit is lifted.
  unlimitedProjects: boolean;
  // Exports, URL imports and conversions a day (cut/server/cloud/limits.ts).
  rendersPerDay: number;
};

export type PlanTermsTable = Record<PaidPlan, PlanTerms>;

// The plan every upsell marks as the best value.
export const RECOMMENDED_PLAN: PaidPlan = "pro";

export function isPaidPlan(value: unknown): value is PaidPlan {
  return typeof value === "string" && (PAID_PLANS as readonly string[]).includes(value);
}

/** Where a plan sits on the ladder: free is 0, Plus 1, Pro 2, Max 3. */
export function planRank(plan: PaidPlan | null): number {
  return plan === null ? 0 : PAID_PLANS.indexOf(plan) + 1;
}
