import type Stripe from "stripe";

import { stripeId } from "@/lib/billing/stripe";

type CancelFields = Pick<Stripe.SubscriptionUpdateParams, "cancel_at" | "cancel_at_period_end">;

// Moving up keeps the plan, so a scheduled cancel is lifted. Stripe takes one
// of its two cancel fields per call: the period-end flag when that is how the
// cancel was set, the date otherwise.
export function liftScheduledCancel(subscription: Stripe.Subscription): CancelFields {
  if (subscription.cancel_at_period_end) {
    return { cancel_at_period_end: false };
  }
  if (subscription.cancel_at !== null) {
    return { cancel_at: "" };
  }
  return {};
}

// The subscription metadata key counting declined upgrades. Stripe keeps a
// declined request's answer under its idempotency key for a day, so each
// decline moves the count and the retry after a card fix gets a fresh key.
const UPGRADE_ATTEMPT_METADATA_KEY = "upgradeAttempt";

// One upgrade per subscription state. Two clicks that read the same
// subscription send one update; Stripe answers the second with the first's
// result. The latest invoice moves with every upgrade and the attempt count
// with every decline, so a later move from the same plan gets a fresh key.
export function upgradeKey(subscription: Stripe.Subscription, fromPrice: string, toPrice: string): string {
  const invoice = stripeId(subscription.latest_invoice) ?? "none";
  const attempt = subscription.metadata?.[UPGRADE_ATTEMPT_METADATA_KEY] ?? "0";
  return `plan-upgrade:${subscription.id}:${fromPrice}:${toPrice}:${invoice}:${attempt}`;
}

/** The metadata write that records a declined upgrade, so the next one
 * gets its own key. Stripe merges it into the metadata the subscription
 * holds. */
export function declinedUpgrade(subscription: Stripe.Subscription): { metadata: Record<string, string> } {
  const attempt = Number(subscription.metadata?.[UPGRADE_ATTEMPT_METADATA_KEY] ?? "0") + 1;
  return { metadata: { [UPGRADE_ATTEMPT_METADATA_KEY]: String(attempt) } };
}
