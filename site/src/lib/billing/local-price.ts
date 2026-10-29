import type Stripe from "stripe";

import { DEFAULT_CURRENCY, fromMinor, toMinor, type Currency } from "@/lib/billing/currencies";
import { getStripe } from "@/lib/billing/stripe";

// A plan sells in a local currency through its Stripe price's currency
// options. su adds them when it saves the terms; a checkout in a currency
// the price still lacks adds that one first, so a price the card showed
// from the terms' defaults always reaches Stripe.

/** The currency option a price needs to sell at `amount` in `currency`, or
 * null when it already does. Stripe never changes an option's amount, so a
 * price holding another one is refused. The price is read with
 * expand: ["currency_options"]. */
export function localPriceWrite(
  price: Stripe.Price,
  amount: number,
  currency: Currency,
): Pick<Stripe.PriceUpdateParams, "currency_options"> | null {
  if (currency === price.currency) {
    return null;
  }

  const minor = toMinor(amount, currency);
  const held = price.currency_options?.[currency]?.unit_amount;
  if (held === undefined || held === null) {
    return { currency_options: { [currency]: { unit_amount: minor } } };
  }
  if (held !== minor) {
    throw new Error(
      `Price ${price.id} charges ${fromMinor(held, currency)} ${currency.toUpperCase()}, the terms say ${amount}`,
    );
  }
  return null;
}

/** Make a plan's Stripe price sell at `amount` in `currency`. */
export async function ensureLocalPrice(priceId: string, amount: number, currency: Currency): Promise<void> {
  if (currency === DEFAULT_CURRENCY) {
    return;
  }
  const stripe = getStripe();
  const price = await stripe.prices.retrieve(priceId, { expand: ["currency_options"] });
  const write = localPriceWrite(price, amount, currency);
  if (write) {
    await stripe.prices.update(priceId, write);
  }
}
