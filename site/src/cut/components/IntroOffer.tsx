"use client";

// The intro discount as every Pro surface states it: the terms in one line.
import { useLocale, useTranslations } from "next-intl";

import { formatMinorPrice } from "@/lib/billing/format-price";
import type { IntroOffer } from "@/queries/billing";

/** The intro terms in the page's language: "50% off: $10 for your first
 * month, then $20/month." */
export function useIntroTerms(): (offer: IntroOffer) => string {
  const t = useTranslations("billing.intro");
  const locale = useLocale();
  return (offer) =>
    t("terms", {
      full: formatMinorPrice(offer.priceMinor, offer.currency, locale),
      months: offer.months,
      percent: offer.percentOff,
      price: formatMinorPrice(offer.introMinor, offer.currency, locale),
    });
}
