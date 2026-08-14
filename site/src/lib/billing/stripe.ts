import Stripe from "stripe";

import { prisma } from "@/lib/prisma";

let cachedStripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (cachedStripe) {
    return cachedStripe;
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new StripeNotConfiguredError();
  }

  cachedStripe = new Stripe(secretKey);
  return cachedStripe;
}

export class StripeNotConfiguredError extends Error {
  public constructor() {
    super("Stripe is not configured.");
    this.name = "StripeNotConfiguredError";
  }
}

// Optional: a specific billing portal configuration (bpc_...). When unset,
// Stripe uses the account's default portal configuration.
export function portalConfigurationId(): string | undefined {
  return process.env.STRIPE_PORTAL_CONFIGURATION_ID || undefined;
}

// Reuse one Stripe customer per user, stored on User.stripeCustomerId so every
// billing product (Pro, top-ups) shares it and a customer is never duplicated.
export async function ensureStripeCustomer(input: {
  userId: string;
  email: string;
  name?: string | null;
}): Promise<string> {
  const user = await prisma.user.findUnique({
    select: { stripeCustomerId: true },
    where: { id: input.userId },
  });
  if (user?.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: input.email,
    metadata: { userId: input.userId },
    name: input.name ?? undefined,
  });
  await prisma.user.update({
    data: { stripeCustomerId: customer.id },
    where: { id: input.userId },
  });
  return customer.id;
}

// Resolve which user a Stripe subscription belongs to: the userId stamped into
// subscription metadata at checkout, falling back to the per-user Stripe
// customer id.
export async function resolveSubscriptionUserId(
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const metadataUserId = subscription.metadata?.userId;
  if (metadataUserId) {
    return metadataUserId;
  }
  const customerId = stripeId(subscription.customer);
  if (customerId) {
    const user = await prisma.user.findUnique({
      select: { id: true },
      where: { stripeCustomerId: customerId },
    });
    if (user) {
      return user.id;
    }
  }
  return null;
}

// Normalize a Stripe field that may be an id string or an expanded object (or
// absent) to its id. Shared by the webhook handlers.
export function stripeId(
  value: string | { id: string } | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  return typeof value === "string" ? value : value.id;
}

// Epoch seconds (Stripe's unit) to Date, or null when absent.
export function unixToDate(seconds: number | null | undefined): Date | null {
  if (!seconds) {
    return null;
  }

  return new Date(seconds * 1000);
}
