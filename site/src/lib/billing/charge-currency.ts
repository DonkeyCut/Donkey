import { isCurrency, marketCurrency, type Currency } from "@/lib/billing/currencies";
import { sellingCurrency } from "@/lib/billing/plans";
import { getStripe } from "@/lib/billing/stripe";
import { getGlobalSetting } from "@/lib/config/effective";
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

// Each customer's billed currency, once Stripe has one. Stripe never changes
// it after that, so the read is kept for the life of the server and only a
// customer not yet billed asks Stripe again. Bounded in entries; the oldest
// goes first.
const BILLED_CACHE_MAX = 10_000;
const billedCurrency = new Map<string, string>();

async function customerCurrency(customerId: string): Promise<string | null> {
  const known = billedCurrency.get(customerId);
  if (known) {
    return known;
  }

  const customer = await getStripe().customers.retrieve(customerId);
  const billed = customer.deleted ? null : customer.currency ?? null;
  if (!billed) {
    return null;
  }
  if (billedCurrency.size >= BILLED_CACHE_MAX) {
    billedCurrency.delete(billedCurrency.keys().next().value!);
  }
  billedCurrency.set(customerId, billed);
  return billed;
}

// An account Stripe has not billed pays in its country's currency when su
// has priced it, in USD otherwise.
export async function chargeCurrency(userId: string, country: string | null): Promise<Currency> {
  const [user, terms] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } }),
    getGlobalSetting("planTerms"),
  ]);
  const market = sellingCurrency(terms, marketCurrency(country));
  const billed = user?.stripeCustomerId ? await customerCurrency(user.stripeCustomerId) : null;
  return billed ? currencyFor(billed, country) : market;
}
