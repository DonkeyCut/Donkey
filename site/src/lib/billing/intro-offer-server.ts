import Stripe from "stripe";

import { getStripe } from "@/lib/billing/stripe";
import { getSetting, type ConfigContext } from "@/lib/config/effective";
import { prisma } from "@/lib/prisma";

import { heldPro, introCouponId, introOfferAt, introOfferPreview, offersIntro, type IntroOffer } from "./intro-offer";

// The setting and what the account has done, for the reads below.
async function introFacts(ctx: ConfigContext) {
  const [setting, subscription, view] = await Promise.all([
    getSetting("introOffer", ctx),
    prisma.proSubscription.findUnique({ where: { userId: ctx.userId }, select: { status: true } }),
    prisma.introOfferView.findUnique({ where: { userId: ctx.userId }, select: { seenAt: true } }),
  ]);
  return { setting, facts: { seenAt: view?.seenAt ?? null, heldPro: heldPro(subscription?.status ?? null) } };
}

/** The intro offer open to this account right now, or null. Reading never
 * starts the window; checkout reads it this way. */
export async function readIntroOffer(ctx: ConfigContext, now = new Date()): Promise<IntroOffer | null> {
  if (!ctx.hasAccount) {
    return null;
  }
  const { setting, facts } = await introFacts(ctx);
  return introOfferAt(setting, facts, now);
}

/** The offer as the app loads it ahead of any surface, which never starts
 * the window; see introOfferPreview. */
export async function previewIntroOffer(ctx: ConfigContext, now = new Date()) {
  if (!ctx.hasAccount) {
    return null;
  }
  const { setting, facts } = await introFacts(ctx);
  return introOfferPreview(setting, facts, now);
}

/** The offer for a surface about to show it. The first time an account the
 * offer is for gets here, its window starts; every later view reads the same
 * window, so it runs once and is gone. */
export async function openIntroOffer(ctx: ConfigContext, now = new Date()): Promise<IntroOffer | null> {
  if (!ctx.hasAccount) {
    return null;
  }

  const [setting, subscription] = await Promise.all([
    getSetting("introOffer", ctx),
    prisma.proSubscription.findUnique({ where: { userId: ctx.userId }, select: { status: true } }),
  ]);
  const facts = { heldPro: heldPro(subscription?.status ?? null) };
  if (!offersIntro(setting, facts)) {
    return null;
  }

  // Two surfaces opening at once both land on the first view's time.
  await prisma.introOfferView.createMany({ data: [{ userId: ctx.userId, seenAt: now }], skipDuplicates: true });
  const view = await prisma.introOfferView.findUniqueOrThrow({ where: { userId: ctx.userId }, select: { seenAt: true } });
  return introOfferAt(setting, { ...facts, seenAt: view.seenAt }, now);
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
