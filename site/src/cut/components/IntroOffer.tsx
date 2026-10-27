"use client";

// The intro discount as every Pro surface states it: the terms in one line,
// and a wall's banner that becomes the offer's picture while it is open.
import type { LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import type { OfferBanner } from "@/cut/components/OfferDialog";
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

/** A wall's banner: a quiet bar with the wall's icon, half the height of an
 * offer's picture. With an offer open the wall is a promotion, so it takes
 * the offer's picture and the countdown over it. */
export function wallBanner(Icon: LucideIcon, offer: IntroOffer | null | undefined): OfferBanner | React.ReactNode {
  if (offer) {
    return "subscribe";
  }
  return (
    <div className="flex aspect-[16/3] w-full items-center bg-neutral-800 px-6 dark:bg-neutral-700">
      <Icon className="size-7 text-white" strokeWidth={1.5} />
    </div>
  );
}
