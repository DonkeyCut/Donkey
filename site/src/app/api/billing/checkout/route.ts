import { NextResponse } from "next/server";
import Stripe from "stripe";
import { z } from "zod";

import { requestLocale } from "@/i18n/requestLocale";
import { auth } from "@/lib/auth";
import { introCouponId } from "@/lib/billing/intro-offer";
import { introCoupon, readIntroOffer } from "@/lib/billing/intro-offer-server";
import { metaCheckoutMetadata, trackCheckoutStarted } from "@/lib/billing/meta-checkout";
import { PAID_PLANS, PLAN_NAMES, planRank, type PaidPlan } from "@/lib/billing/plans";
import { dropIntroDiscount, INTRO_OFFER_METADATA_KEY, liftScheduledCancel, upgradeKey } from "@/lib/billing/plan-upgrade";
import {
  getActiveSubscription,
  isActiveProStatus,
  livePlan,
  readPlanPrices,
  syncPlanSubscription,
  type PlanPrices,
} from "@/lib/billing/pro-subscription";
import { STRIPE_LOCALE } from "@/lib/billing/stripe-locale";
import { drainStripe, ensureStripeCustomer, getStripe } from "@/lib/billing/stripe";
import { contextFromRequest } from "@/lib/config/effective";
import { verifyCreditOfferToken } from "@/lib/credits/offers";
import { openOfferForSubscribing, SUBSCRIBE_BONUS_METADATA_KEY } from "@/lib/credits/subscribe-bonus-claim";
import {
  notFoundResponse,
  unauthorizedResponse,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";

// The plan to buy, Pro when unnamed. A checkout opened from an offer's claim
// link names the offer by its token, so the credit that lands is the one the
// dialog described.
const bodySchema = z
  .object({ offerToken: z.string().min(1).optional(), plan: z.enum(PAID_PLANS).optional() })
  .strict();

const HTTP_CONFLICT = 409;
const HTTP_PAYMENT_REQUIRED = 402;

// Start a Stripe Checkout session for a plan, or move a running subscription
// up to it. This route keeps its getSession call because it needs the user's
// email/name.
export const POST = withDonkeyAuth(async (request) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return unauthorizedResponse();
  }
  const text = await request.text();
  const parsed = bodySchema.safeParse(text ? JSON.parse(text) : {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const namedOfferId = parsed.data.offerToken ? verifyCreditOfferToken(parsed.data.offerToken) : null;
  const plan = parsed.data.plan ?? "pro";

  // A not-yet-configured price stays a 404 (not 401) so the landing card does
  // not treat it as a sign-in prompt.
  const prices = await readPlanPrices();
  const priceId = prices[plan];
  if (!priceId) {
    return notFoundResponse();
  }

  // An account already on a plan moves up in place: a second subscription
  // would double-bill it.
  const current = await getActiveSubscription(session.user.id);
  if (current) {
    return upgradeInPlace(current.stripeSubscriptionId, plan, prices, request.nextUrl.origin);
  }

  const customerId = await ensureStripeCustomer({
    email: session.user.email,
    name: session.user.name,
    userId: session.user.id,
  });

  // Stripe can hold a plan the row does not show yet: a checkout paid moments
  // ago whose webhook is still on its way. That account moves up in place too.
  const live = await adoptLiveSubscription(customerId);
  if (live) {
    return upgradeInPlace(live, plan, prices, request.nextUrl.origin);
  }
  await expireOpenCheckouts(customerId);
  // A Pro checkout started while an offer for subscribing is open carries the
  // offer, so the webhook lands the credit on the subscription it creates.
  const offer = plan === "pro" ? await openOfferForSubscribing(session.user.id, namedOfferId) : null;
  // An account inside its intro window checks out of Pro with the discount
  // already on. Stripe takes either a discount or a promotion code field,
  // never both.
  const intro = plan === "pro" ? await readIntroOffer(await contextFromRequest(request)) : null;
  const pricing = intro
    ? { discounts: [{ coupon: await introCoupon(intro) }] }
    : { allow_promotion_codes: true };
  const stripe = getStripe();
  const origin = request.nextUrl.origin;
  const checkout = await stripe.checkout.sessions.create({
    ...pricing,
    cancel_url: `${origin}/app/settings?checkout=cancelled`,
    client_reference_id: session.user.id,
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    locale: STRIPE_LOCALE[requestLocale(request)],
    metadata: { ...metaCheckoutMetadata(request.headers), plan: PLAN_NAMES[plan] },
    mode: "subscription",
    subscription_data: {
      metadata: {
        userId: session.user.id,
        ...(offer ? { [SUBSCRIBE_BONUS_METADATA_KEY]: offer.id } : {}),
        ...(intro ? { [INTRO_OFFER_METADATA_KEY]: introCouponId(intro) } : {}),
      },
    },
    success_url: `${origin}/app/settings?checkout=success`,
  });

  if (!checkout.url) {
    return NextResponse.json(
      { error: "checkout_no_url", message: "Stripe did not return a URL." },
      { status: 502 },
    );
  }

  trackCheckoutStarted(checkout.id, PLAN_NAMES[plan], request.headers, session.user);
  return NextResponse.json({ url: checkout.url });
});

// A plan subscription Stripe holds for the customer, synced to the account
// so every surface reads it; null when the customer has none.
async function adoptLiveSubscription(customerId: string): Promise<string | null> {
  const subscriptions = await drainStripe(getStripe().subscriptions.list({ customer: customerId, status: "all" }));
  for (const subscription of subscriptions) {
    if (!isActiveProStatus(subscription.status)) {
      continue;
    }
    if (await syncPlanSubscription(subscription)) {
      return subscription.id;
    }
  }
  return null;
}

// One open plan checkout per customer. Two tabs' checkouts, both paid, would
// make two subscriptions; opening a new one closes the last.
async function expireOpenCheckouts(customerId: string): Promise<void> {
  const stripe = getStripe();
  const open = await drainStripe(stripe.checkout.sessions.list({ customer: customerId, status: "open" }));
  await Promise.all(
    open.filter((s) => s.mode === "subscription").map((s) => stripe.checkout.sessions.expire(s.id)),
  );
}

const notAnUpgrade = () =>
  NextResponse.json(
    { error: "plan_not_an_upgrade", message: "This account is already on this plan or a higher one." },
    { status: HTTP_CONFLICT },
  );

// Swap the subscription's plan line to a higher plan. The period restarts
// now, so the new plan's credits land at once, and Stripe charges the
// difference on the spot; a card that fails leaves the old plan in place.
// The plan held is read from Stripe, since the row trails it until the
// webhook lands, and the result is synced before answering.
async function upgradeInPlace(
  subscriptionId: string | null,
  plan: PaidPlan,
  prices: PlanPrices,
  origin: string,
): Promise<Response> {
  if (!subscriptionId) {
    return notAnUpgrade();
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["discounts"] });
  const line = await livePlan(subscription);
  const toPrice = prices[plan]!;
  if (!line || planRank(plan) <= planRank(line.plan)) {
    return notAnUpgrade();
  }

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(
      subscription.id,
      {
        ...liftScheduledCancel(subscription),
        ...dropIntroDiscount(subscription),
        billing_cycle_anchor: "now",
        items: [{ id: line.item.id, price: toPrice }],
        payment_behavior: "error_if_incomplete",
        proration_behavior: "always_invoice",
      },
      { idempotencyKey: upgradeKey(subscription, line.item.price.id, toPrice) },
    );
  } catch (e) {
    if (e instanceof Stripe.errors.StripeCardError) {
      return NextResponse.json(
        { error: "upgrade_payment_failed", message: e.message },
        { status: HTTP_PAYMENT_REQUIRED },
      );
    }
    // The same upgrade is already on its way from another click.
    if (e instanceof Stripe.errors.StripeIdempotencyError) {
      return NextResponse.json(
        { error: "upgrade_in_progress", message: "This upgrade is already in progress." },
        { status: HTTP_CONFLICT },
      );
    }
    throw e;
  }

  await syncPlanSubscription(updated);
  return NextResponse.json({ url: `${origin}/app/settings?checkout=success` });
}
