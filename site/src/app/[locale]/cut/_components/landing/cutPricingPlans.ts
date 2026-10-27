import { useLocale, useTranslations } from "next-intl";

import type { PricingPlan } from "@/app/_components/landing/pricingPlans";
import { promotionCovers, type AllowancePromotion } from "@/lib/billing/allowance-promotion";
import { creditsPerDollar, formatCreditCount } from "@/lib/credits/format-credits";
import { formatUsdPlain } from "@/lib/credits/format-usd";

// What Pro costs and what it gets you, in one place: the landing card below
// and the welcome sequence's last slide both read it, so the price can't say
// two different things in two parts of the product.
export const CUT_PRO = {
  // The plan price in USD a month. The included AI allowance equals it.
  monthlyDollars: 20,
  storageGb: 100,
};

// The Free plan's cloud storage, as its card states it.
const FREE_STORAGE_MB = 250;

/** Pro in the reader's language: the line under its name, the price, and
 * what it adds. The landing card sits beside the Free card and opens with a
 * line pointing at it; nothing else does, so that line isn't in here. */
export function useCutPro(): { body: string; price: string; features: string[] } {
  const t = useTranslations("common.proPlan");
  const locale = useLocale();
  const credits = formatCreditCount(CUT_PRO.monthlyDollars * creditsPerDollar, locale);
  return {
    body: t("body"),
    price: t("price", { price: formatUsdPlain(String(CUT_PRO.monthlyDollars), locale) }),
    features: [
      t("storage", { gb: CUT_PRO.storageGb }),
      t("credits", { credits }),
      t("generation"),
    ],
  };
}

// The allowance promotion as the Pro card states it, while a period starting
// now would get it: the multiplied allowance in USD and the last day. Null
// when the plain plan applies.
export function activeProPromotion(
  promotion: AllowancePromotion,
  now = new Date(),
): { allowanceDollars: number; multiplier: number; lastDay: string | null } | null {
  if (!promotionCovers(promotion, now)) return null;
  return {
    allowanceDollars: CUT_PRO.monthlyDollars * promotion.multiplier,
    multiplier: promotion.multiplier,
    lastDay: promotion.lastDay,
  };
}

// Cut's two tiers: the editor itself is free and local; Pro adds monthly AI
// generation credits.
export function useCutPricingPlans(): PricingPlan[] {
  const t = useTranslations("landing.plans");
  const locale = useLocale();
  const pro = useCutPro();
  return [
    {
      action: {
        href: "/app",
        kind: "link",
        label: t("free.cta"),
      },
      body: t("free.body"),
      color: "cream",
      detail: t("free.detail"),
      features: [
        t("free.editor"),
        t("free.storage", { mb: FREE_STORAGE_MB }),
        t("free.tools"),
        t("free.subscriptions"),
      ],
      name: t("free.name"),
      price: formatUsdPlain("0", locale),
      tapeColor: "coral",
    },
    {
      action: {
        href: "/app/settings",
        kind: "link",
        label: t("pro.cta"),
      },
      body: pro.body,
      color: "coral",
      detail: t("pro.detail"),
      features: [t("pro.everythingInFree"), ...pro.features],
      name: "Pro",
      price: pro.price,
      tapeColor: "yellow",
      tapePosition: "right",
    },
  ];
}
