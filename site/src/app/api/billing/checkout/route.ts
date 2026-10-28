import { NextResponse } from "next/server";
import Stripe from "stripe";
import { z } from "zod";

import { requestLocale } from "@/i18n/requestLocale";
import { auth } from "@/lib/auth";
import { introCouponId } from "@/lib/billing/intro-offer";
import { introCoupon, readIntroOffer } from "@/lib/billing/intro-offer-server";
import { metaCheckoutMetadata, trackCheckoutStarted } from "@/lib/billing/meta-checkout";
import { PAID_PLANS, PLAN_TERMS, planRank, type PaidPlan } from "@/lib/billing/plans";
import { getActiveSubscription, readPlanPrices, subscriptionPlan, type PlanPrices } from "@/lib/billing/pro-subscription";
import { STRIPE_LOCALE } from "@/lib/billing/stripe-locale";
import { ensureStripeCustomer, getStripe } from "@/lib/billing/stripe";
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
    return upgradeInPlace(current, plan, prices, request.nextUrl.origin);
  }

  const customerId = await ensureStripeCustomer({
    email: session.user.email,
    name: session.user.name,
    userId: session.user.id,
  });
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
    metadata: { ...metaCheckoutMetadata(request.headers), plan: PLAN_TERMS[plan].name },
    mode: "subscription",
    subscription_data: {
      metadata: {
        userId: session.user.id,
        ...(offer ? { [SUBSCRIBE_BONUS_METADATA_KEY]: offer.id } : {}),
        ...(intro ? { introOffer: introCouponId(intro) } : {}),
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

  trackCheckoutStarted(checkout.id, PLAN_TERMS[plan].name, request.headers, session.user);
  return NextResponse.json({ url: checkout.url });
});

// Swap the subscription's plan line to a higher plan. The period restarts
// now, so the new plan's credits land at once, and Stripe charges the
// difference on the spot; a card that fails leaves the old plan in place.
async function upgradeInPlace(
  current: { planKey: string; stripeSubscriptionId: string | null; cancelAt: Date | null },
  plan: PaidPlan,
  prices: PlanPrices,
  origin: string,
): Promise<Response> {
  const currentRank = planRank(PAID_PLANS.find((p) => p === current.planKey) ?? "pro");
  if (planRank(plan) <= currentRank || !current.stripeSubscriptionId) {
    return NextResponse.json(
      { error: "plan_not_an_upgrade", message: "This account is already on this plan or a higher one." },
      { status: HTTP_CONFLICT },
    );
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(current.stripeSubscriptionId);
  const line = subscriptionPlan(subscription, prices);
  if (!line) {
    return NextResponse.json(
      { error: "plan_not_an_upgrade", message: "This account is already on this plan or a higher one." },
      { status: HTTP_CONFLICT },
    );
  }

  try {
    await stripe.subscriptions.update(subscription.id, {
      billing_cycle_anchor: "now",
      // Moving up keeps the plan: a scheduled cancel is lifted.
      ...(current.cancelAt ? { cancel_at: "" as const } : {}),
      cancel_at_period_end: false,
      items: [{ id: line.item.id, price: prices[plan]! }],
      payment_behavior: "error_if_incomplete",
      proration_behavior: "always_invoice",
    });
  } catch (e) {
    if (e instanceof Stripe.errors.StripeCardError) {
      return NextResponse.json(
        { error: "upgrade_payment_failed", message: e.message },
        { status: HTTP_PAYMENT_REQUIRED },
      );
    }
    throw e;
  }
  return NextResponse.json({ url: `${origin}/app/settings?checkout=success` });
}
