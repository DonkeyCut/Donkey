import type Stripe from "stripe";

import { stripeId } from "@/lib/billing/stripe";

// The subscription metadata key checkout stamps the intro coupon under.
export const INTRO_OFFER_METADATA_KEY = "introOffer";

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

// The intro discount sells Pro alone, so moving up drops it and keeps every
// other discount. Reads the subscription with its discounts expanded; an
// empty result leaves the discounts as they are.
export function dropIntroDiscount(
  subscription: Stripe.Subscription,
): Pick<Stripe.SubscriptionUpdateParams, "discounts"> {
  const intro = subscription.metadata?.[INTRO_OFFER_METADATA_KEY];
  if (!intro) {
    return {};
  }

  const discounts = subscription.discounts.map((d) => {
    if (typeof d === "string") {
      throw new Error("Read the subscription with expand: [\"discounts\"].");
    }
    return d;
  });
  const kept = discounts.filter((d) => stripeId(d.source.coupon) !== intro);
  if (kept.length === discounts.length) {
    return {};
  }
  return { discounts: kept.length ? kept.map((d) => ({ discount: d.id })) : "" };
}

// One upgrade per subscription state. Two clicks that read the same
// subscription send one update; Stripe answers the second with the first's
// result. The latest invoice moves with every upgrade, so a later move from
// the same plan gets a fresh key.
export function upgradeKey(subscription: Stripe.Subscription, fromPrice: string, toPrice: string): string {
  const invoice = stripeId(subscription.latest_invoice) ?? "none";
  return `plan-upgrade:${subscription.id}:${fromPrice}:${toPrice}:${invoice}`;
}
