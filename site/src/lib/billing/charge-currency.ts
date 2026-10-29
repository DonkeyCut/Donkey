import { isCurrency, marketCurrency, type Currency } from "@/lib/billing/currencies";
import { getStripe } from "@/lib/billing/stripe";
import { prisma } from "@/lib/prisma";

// The currency an account's plans price and check out in. Stripe bills a
// customer in one currency for good once it has subscribed, so an account
// Stripe already bills keeps that currency wherever it signs in from; any
// other account pays in its country's.

/** The currency for a customer Stripe bills in `billed` (null when it never
 * has), reached from `country`. */
export function currencyFor(billed: string | null, country: string | null): Currency {
  if (!billed) {
    return marketCurrency(country);
  }
  if (!isCurrency(billed)) {
    throw new Error(`Stripe bills this customer in ${billed.toUpperCase()}, which no plan sells in`);
  }
  return billed;
}

export async function chargeCurrency(userId: string, country: string | null): Promise<Currency> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
  if (!user?.stripeCustomerId) {
    return marketCurrency(country);
  }
  const customer = await getStripe().customers.retrieve(user.stripeCustomerId);
  return currencyFor(customer.deleted ? null : customer.currency ?? null, country);
}
