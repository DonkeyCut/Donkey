import type { Locale } from "@/i18n/locales";
import { fromMinor, type Currency } from "@/lib/billing/currencies";

// A plan price in a sentence, in its own currency and the reader's way of
// writing it: whole amounts carry no decimals ("R$59", "¥2,800", "19 €"),
// anything else the currency's own ("R$29.50").
export function formatPrice(amount: number, currency: Currency, locale: Locale): string {
  const whole = Number.isInteger(amount);
  return amount.toLocaleString(locale, {
    currency: currency.toUpperCase(),
    style: "currency",
    ...(whole ? { maximumFractionDigits: 0, minimumFractionDigits: 0 } : {}),
  });
}

/** A Stripe minor-unit amount as a price reads: 2950 BRL → "R$29.50". */
export function formatMinorPrice(minor: number, currency: Currency, locale: Locale): string {
  return formatPrice(fromMinor(minor, currency), currency, locale);
}
