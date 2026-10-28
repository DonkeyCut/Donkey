"use client";

// The intro discount as every Pro surface states it: the terms in one line.
import { useLocale, useTranslations } from "next-intl";

import type { Locale } from "@/i18n/locales";
import { formatUsdPlain } from "@/lib/credits/format-usd";
import type { IntroOffer } from "@/queries/billing";

/** Cents as a price reads: 1000 → "$10", 999 → "$9.99". */
export function priceLabel(cents: number, locale: Locale): string {
  return formatUsdPlain((cents / 100).toFixed(2), locale);
}

/** The intro terms in the page's language: "50% off: $10 for your first
 * month, then $20/month." */
export function useIntroTerms(): (offer: IntroOffer) => string {
  const t = useTranslations("billing.intro");
  const locale = useLocale();
  return (offer) =>
    t("terms", {
      full: priceLabel(offer.priceCents, locale),
      months: offer.months,
      percent: offer.percentOff,
      price: priceLabel(offer.introCents, locale),
    });
}
