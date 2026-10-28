import { useLocale, useTranslations } from "next-intl";

import type { PricingPlan } from "@/app/_components/landing/pricingPlans";
import type { CardColor } from "@/app/_components/landing/theme";
import { promotionCovers, type AllowancePromotion } from "@/lib/billing/allowance-promotion";
import { PAID_PLANS, PLAN_TERMS, RECOMMENDED_PLAN, type PaidPlan } from "@/lib/billing/plans";
import { formatCreditCount } from "@/lib/credits/format-credits";
import { formatUsdPlain } from "@/lib/credits/format-usd";

// The Free plan's cloud storage, as its card states it.
const FREE_STORAGE_MB = 250;

// A plan's bullet: its credits lead, the plan below it is folded into one
// line, and the rest are checks.
export type PlanFeature = { kind: "credits" | "inherits" | "check"; text: string };

export type PlanCopy = {
  plan: PaidPlan;
  name: string;
  body: string;
  // "$20/month"; `amount` and `cadence` split it for a large figure.
  price: string;
  amount: string;
  cadence: string;
  features: PlanFeature[];
};

/** Every paid plan in the reader's language, cheapest first: the landing
 * cards, the welcome sequence and the upgrade modal all read it, so a plan
 * can't say two different things in two parts of the product. */
export function useCutPlans(): PlanCopy[] {
  const t = useTranslations("common.plans");
  const locale = useLocale();
  return PAID_PLANS.map((plan, i) => {
    const terms = PLAN_TERMS[plan];
    const below = i > 0 ? PLAN_TERMS[PAID_PLANS[i - 1]] : null;
    const amount = formatUsdPlain(String(terms.monthlyDollars), locale);
    const features: PlanFeature[] = [
      { kind: "credits", text: t("credits", { credits: formatCreditCount(terms.monthlyCredits, locale) }) },
      ...(below ? [{ kind: "inherits" as const, text: t("everythingIn", { plan: below.name }) }] : []),
      { kind: "check", text: t("storage", { gb: terms.storageGb }) },
      ...(terms.unlimitedProjects && !below?.unlimitedProjects
        ? [{ kind: "check" as const, text: t("unlimitedProjects") }]
        : []),
      ...(below ? [{ kind: "check" as const, text: t("renders", { count: terms.rendersPerDay }) }] : []),
      ...(below ? [] : [{ kind: "check" as const, text: t("generation") }]),
    ];
    return {
      plan,
      name: terms.name,
      body: t("body", { plan }),
      price: t("price", { price: amount }),
      amount,
      cadence: t("perMonth"),
      features,
    };
  });
}

/** One plan's copy. */
export function useCutPlan(plan: PaidPlan): PlanCopy {
  return useCutPlans().find((copy) => copy.plan === plan)!;
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
    allowanceDollars: PLAN_TERMS.pro.monthlyDollars * promotion.multiplier,
    multiplier: promotion.multiplier,
    lastDay: promotion.lastDay,
  };
}

// Cut's tiers: the editor itself is free and local; each paid plan adds
// monthly AI generation credits and cloud storage.
const PLAN_COLORS: Record<PaidPlan, { color: CardColor; tapeColor: CardColor }> = {
  plus: { color: "cream", tapeColor: "mint" },
  pro: { color: "coral", tapeColor: "yellow" },
  max: { color: "cream", tapeColor: "pink" },
};

export function useCutPricingPlans(): PricingPlan[] {
  const t = useTranslations("landing.plans");
  const locale = useLocale();
  const plans = useCutPlans();
  return [
    {
      body: t("free.body"),
      color: "cream",
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
    ...plans.map((copy, i): PricingPlan => ({
      body: copy.body,
      ...PLAN_COLORS[copy.plan],
      // The first plan names what it adds to Free after its credits, the way
      // each higher plan names the one under it.
      features: [
        copy.features[0].text,
        ...(i === 0 ? [t("paid.everythingInFree")] : []),
        ...copy.features.slice(1).map((feature) => feature.text),
      ],
      name: copy.name,
      price: copy.price,
      ...(copy.plan === RECOMMENDED_PLAN ? { tapePosition: "right" as const } : {}),
    })),
  ];
}
