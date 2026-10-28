import type Stripe from "stripe";

import {
  resolveSubscriptionUserId,
  stripeId,
  unixToDate,
} from "@/lib/billing/stripe";
import { promotedAllowanceMicros } from "@/lib/billing/allowance-promotion";
import { getGlobalSetting } from "@/lib/config/effective";
import { PAID_PLANS, PLAN_TERMS, type PaidPlan } from "@/lib/billing/plans";
import { creditStringToMicros, zeroCreditMicros } from "@/lib/credits/amounts";
import { creditsPerDollar } from "@/lib/credits/format-credits";
import { grantCredits } from "@/lib/credits/inference";
import { claimOfferBySubscribing, SUBSCRIBE_BONUS_METADATA_KEY } from "@/lib/credits/subscribe-bonus-claim";
import { prisma } from "@/lib/prisma";

// Stripe subscription statuses that include a plan's allowance, as a list so
// a database filter can reuse it.
export const ACTIVE_PRO_STATUSES = ["active", "trialing"] as const;

const activeStatuses = new Set<string>(ACTIVE_PRO_STATUSES);

export function isActiveProStatus(status: string): boolean {
  return activeStatuses.has(status);
}

// A subscription that will end on its own: the portal schedules the end as
// cancel_at (with cancel_at_period_end left false), the API's period-end flag
// is the other spelling of the same decision.
export function subscriptionCancelScheduled(subscription: Stripe.Subscription): boolean {
  return subscription.cancel_at_period_end || subscription.cancel_at !== null;
}

// The date a scheduled cancel ends the subscription. Stripe fills cancel_at
// for a period-end cancel too, and a portal-scheduled cancel_at can sit months
// past the current period (a comped run of Pro), so this is the one field.
export function subscriptionCancelAt(subscription: Stripe.Subscription): Date | null {
  return unixToDate(subscription.cancel_at);
}

type ProEndAnchor = {
  cancelAt: Date | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
};

// When Pro ends for a row with a cancel scheduled, or null when it renews.
// Rows synced before cancelAt was stored still carry only the flag; those read
// as the period end until the next webhook writes the date.
export function scheduledProEnd(subscription: ProEndAnchor): Date | null {
  if (subscription.cancelAt) return subscription.cancelAt;
  return subscription.cancelAtPeriodEnd ? subscription.currentPeriodEnd : null;
}

// Each plan's recurring Stripe price, from the planPrices setting.
export type PlanPrices = Record<PaidPlan, string | null>;

export function readPlanPrices(): Promise<PlanPrices> {
  return getGlobalSetting("planPrices");
}

export async function planPriceId(plan: PaidPlan): Promise<string | null> {
  return (await readPlanPrices())[plan];
}

// The credits a plan's billing period starts with, as ledger micros.
export function planAllowanceMicros(plan: PaidPlan): bigint {
  return creditStringToMicros(String(PLAN_TERMS[plan].monthlyCredits / creditsPerDollar));
}

// The account's running subscription, whichever plan it is on; null for a
// free account.
export async function getActiveSubscription(userId: string) {
  const subscription = await prisma.proSubscription.findUnique({
    where: { userId },
  });
  if (!subscription || !isActiveProStatus(subscription.status)) {
    return null;
  }
  return subscription;
}

// The subscription's plan line item and the plan its price sells, or null
// for a subscription to no plan. Matches across ALL items (not just the
// first), so a multi-item subscription is still recognized and its period is
// read from the right item.
export function subscriptionPlan(
  subscription: Stripe.Subscription,
  prices: PlanPrices,
): { plan: PaidPlan; item: Stripe.SubscriptionItem } | null {
  for (const plan of PAID_PLANS) {
    const id = prices[plan];
    const item = id ? subscription.items.data.find((i) => i.price?.id === id) : undefined;
    if (item) {
      return { plan, item };
    }
  }
  return null;
}

// Source of truth for a Pro subscription's lifecycle. Maps the Stripe object
// onto our row and, for each active billing period, grants the included
// allowance into the credit balance as an expiring grant. The grant is
// idempotent per (subscription, period start), so repeated webhook deliveries
// and the create/update/invoice events for one period grant the allowance once.
export async function syncProSubscription(
  subscription: Stripe.Subscription,
  { plan, item }: { plan: PaidPlan; item: Stripe.SubscriptionItem },
): Promise<void> {
  const userId = await resolveSubscriptionUserId(subscription);
  const customerId = stripeId(subscription.customer);
  if (!userId) {
    console.error("[billing] could not resolve user for Pro subscription", {
      customer: customerId,
      subscription: subscription.id,
    });
    return;
  }

  const periodStart = unixToDate(item.current_period_start);
  const periodEnd = unixToDate(item.current_period_end);
  const cancelAt = subscriptionCancelAt(subscription);
  const endedAt = unixToDate(subscription.ended_at);
  const allowanceMicros = periodStart
    ? promotedAllowanceMicros(
        planAllowanceMicros(plan),
        await getGlobalSetting("proAllowancePromotion"),
        periodStart,
      )
    : planAllowanceMicros(plan);

  await prisma.proSubscription.upsert({
    create: {
      cancelAt,
      cancelAtPeriodEnd: subscriptionCancelScheduled(subscription),
      currentPeriodEnd: periodEnd,
      currentPeriodStart: periodStart,
      endedAt,
      monthlyAllowanceMicros: allowanceMicros,
      planKey: plan,
      status: subscription.status,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      userId,
    },
    update: {
      cancelAt,
      cancelAtPeriodEnd: subscriptionCancelScheduled(subscription),
      currentPeriodEnd: periodEnd,
      currentPeriodStart: periodStart,
      endedAt,
      monthlyAllowanceMicros: allowanceMicros,
      planKey: plan,
      status: subscription.status,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
    },
    where: { userId },
  });

  // A subscription whose checkout was taken up from a credit offer names the
  // offer; the claim dedupes, so every later event is a no-op.
  const offerId = subscription.metadata?.[SUBSCRIBE_BONUS_METADATA_KEY];
  if (isActiveProStatus(subscription.status) && offerId) {
    await claimOfferBySubscribing(userId, offerId);
  }

  // Grant the period's included allowance once it is active and the period is
  // known. expiresAt = period end means it is spent before never-expiring
  // purchased credits (see compareGrantConsumptionOrder) and does not roll over.
  if (
    isActiveProStatus(subscription.status) &&
    periodStart &&
    periodEnd &&
    allowanceMicros > zeroCreditMicros
  ) {
    await grantCredits({
      amountMicros: allowanceMicros,
      description: `Donkey ${PLAN_TERMS[plan].name} monthly allowance`,
      expiresAt: periodEnd,
      metadata: { plan },
      periodEnd,
      periodStart,
      source: "pro_subscription",
      sourceId: `pro:${subscription.id}:${item.current_period_start}`,
      userId,
    });
  }
}
