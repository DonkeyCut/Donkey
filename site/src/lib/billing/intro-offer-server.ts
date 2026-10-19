import Stripe from "stripe";

import { proPriceId } from "@/lib/billing/pro-subscription";
import { getStripe } from "@/lib/billing/stripe";
import { getSetting, type ConfigContext } from "@/lib/config/effective";
import { prisma } from "@/lib/prisma";

import { heldPro, introCouponId, introOfferAt, type IntroOffer } from "./intro-offer";

/** The intro offer open to this account right now, or null. */
export async function readIntroOffer(ctx: ConfigContext, now = new Date()): Promise<IntroOffer | null> {
  if (!ctx.hasAccount) {
    return null;
  }

  const [setting, subscription] = await Promise.all([
    getSetting("introOffer", ctx),
    prisma.proSubscription.findUnique({ where: { userId: ctx.userId }, select: { status: true } }),
  ]);
  return introOfferAt(setting, { createdAt: ctx.createdAt, heldPro: heldPro(subscription?.status ?? null) }, now);
}

const stripeCode = (e: unknown) => (e instanceof Stripe.errors.StripeError ? e.code : undefined);

/** The coupon for an offer's terms, created the first time a checkout needs
 * it. Two checkouts racing to create it both end on the same coupon. */
export async function introCoupon(offer: IntroOffer): Promise<string> {
  const stripe = getStripe();
  const id = introCouponId(offer);

  try {
    await stripe.coupons.retrieve(id);
    return id;
  } catch (e) {
    if (stripeCode(e) !== "resource_missing") {
      throw e;
    }
  }

  try {
    await stripe.coupons.create({
      duration: "repeating",
      duration_in_months: offer.months,
      id,
      name: `Intro ${offer.percentOff}% off`,
      percent_off: offer.percentOff,
    });
  } catch (e) {
    if (stripeCode(e) !== "resource_already_exists") {
      throw e;
    }
  }
  return id;
}

// The Pro price's amount never changes under a price id, so one read per
// process serves every offer.
let proPriceCents: Promise<number> | null = null;

/** The Pro price in cents, as Stripe holds it. */
export function readProPriceCents(): Promise<number> {
  const priceId = proPriceId();
  if (!priceId) {
    throw new Error("STRIPE_PRO_PRICE_ID is not set");
  }

  proPriceCents ??= getStripe()
    .prices.retrieve(priceId)
    .then((price) => {
      if (typeof price.unit_amount !== "number") {
        throw new Error(`Pro price ${priceId} has no unit amount`);
      }
      return price.unit_amount;
    })
    .catch((e: unknown) => {
      proPriceCents = null;
      throw e;
    });
  return proPriceCents;
}
