import type Stripe from "stripe";

import {
  resolveSubscriptionUserId,
  stripeId,
  unixToDate,
} from "@/lib/billing/stripe";
import { creditMicrosPerCent, zeroCreditMicros } from "@/lib/credits/amounts";
import { grantCredits } from "@/lib/credits/inference";
import { prisma } from "@/lib/prisma";

// Donkey Pro: the Mac app subscription.
export const proPlanKey = "pro";

// Stripe subscription statuses that include the Pro allowance.
const activeStatuses = new Set(["active", "trialing"]);

export function isActiveProStatus(status: string): boolean {
  return activeStatuses.has(status);
}

export function proPriceId(): string | undefined {
  return process.env.STRIPE_PRO_PRICE_ID || undefined;
}

// The included monthly inference allowance equals the Pro plan price: a $20/mo
// plan includes $20 of app inference each period. Read straight from the
// recurring price's unit_amount (cents) — no separate metadata to configure.
export function allowanceMicrosFromPrice(
  price: Stripe.Price | null | undefined,
): bigint {
  const cents = price?.unit_amount;
  if (typeof cents === "number" && Number.isFinite(cents) && cents > 0) {
    return BigInt(Math.round(cents)) * creditMicrosPerCent;
  }
  return zeroCreditMicros;
}

export async function getActiveProSubscription(userId: string) {
  const subscription = await prisma.proSubscription.findUnique({
    where: { userId },
  });
  if (!subscription || !isActiveProStatus(subscription.status)) {
    return null;
  }
  return subscription;
}

// The subscription's Pro line item, if any. Matches across ALL items (not just
// the first), so a multi-item subscription is still recognized as Pro and its
// price/period are read from the right item rather than items.data[0].
function proItem(
  subscription: Stripe.Subscription,
): Stripe.SubscriptionItem | undefined {
  const id = proPriceId();
  return id
    ? subscription.items.data.find((item) => item.price?.id === id)
    : undefined;
}

// True when the subscription includes the Pro price. Used to route shared
// subscription webhook events to the right product sync.
export function subscriptionIsPro(subscription: Stripe.Subscription): boolean {
  return proItem(subscription) !== undefined;
}

// Source of truth for a Pro subscription's lifecycle. Maps the Stripe object
// onto our row and, for each active billing period, grants the included
// allowance into the credit balance as an expiring grant. The grant is
// idempotent per (subscription, period start), so repeated webhook deliveries
// and the create/update/invoice events for one period grant the allowance once.
export async function syncProSubscription(
  subscription: Stripe.Subscription,
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

  const item = proItem(subscription) ?? subscription.items.data[0];
  const price = item?.price;
  const periodStart = unixToDate(item?.current_period_start ?? null);
  const periodEnd = unixToDate(item?.current_period_end ?? null);
  const allowanceMicros = allowanceMicrosFromPrice(price);

  await prisma.proSubscription.upsert({
    create: {
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodEnd: periodEnd,
      currentPeriodStart: periodStart,
      monthlyAllowanceMicros: allowanceMicros,
      planKey: proPlanKey,
      status: subscription.status,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      userId,
    },
    update: {
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodEnd: periodEnd,
      currentPeriodStart: periodStart,
      monthlyAllowanceMicros: allowanceMicros,
      status: subscription.status,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
    },
    where: { userId },
  });

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
      description: "Donkey Pro monthly allowance",
      expiresAt: periodEnd,
      metadata: { plan: proPlanKey },
      periodEnd,
      periodStart,
      source: "pro_subscription",
      sourceId: `pro:${subscription.id}:${item?.current_period_start ?? 0}`,
      userId,
    });
  }
}
