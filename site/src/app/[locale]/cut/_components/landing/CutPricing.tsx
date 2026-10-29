"use client";

import { useTranslations } from "next-intl";

import { ChargeCurrencyProvider } from "@/app/_components/ChargeCurrencyProvider";
import { Headline } from "@/app/_components/landing/LandingPrimitives";
import { PricingPlanCard } from "@/app/_components/landing/PricingPlanCard";
import { useAppEntryHref } from "@/app/_components/landing/useAppEntryHref";
import { useMediaQuery } from "@/app/_components/landing/useMediaQuery";
import {
  NOTE_PLAN,
  useCutPlan,
  useCutPricingPlans,
} from "@/app/[locale]/cut/_components/landing/cutPricingPlans";
import type { Currency } from "@/lib/billing/currencies";

// The plans price in the currency the landing was rendered for.
export function CutPricing({ currency }: { currency: Currency }) {
  return (
    <ChargeCurrencyProvider currency={currency}>
      <Plans />
    </ChargeCurrencyProvider>
  );
}

function Plans() {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const appHref = useAppEntryHref();
  const t = useTranslations("landing.pricing");

  // Every plan CTA enters the app, so gate them the same way as the hero: a
  // signed-out click lands on sign-in first, then returns to the app target.
  const plans = useCutPricingPlans().map((plan) => ({
    ...plan,
    action: { ...plan.action, href: appHref(plan.action.href) },
  }));

  return (
    <section
      id="pricing"
      style={{
        boxSizing: "border-box",
        padding: isDesktop ? "96px 48px" : "80px 24px",
        maxWidth: 1400,
        margin: "0 auto",
        width: "100%",
      }}
    >
      <Headline size="lg">
        {t.rich("title", { italic: (chunks) => <span style={{ fontStyle: "italic" }}>{chunks}</span> })}
      </Headline>
      <p className="mt-6 max-w-[900px] text-[17px] leading-[1.55] text-foreground/70">
        {t("body")}
      </p>
      {isDesktop ? (
        <div
          style={{
            marginTop: 48,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            alignItems: "stretch",
            gap: 24,
          }}
        >
          {plans
            .filter((plan) => plan.id !== NOTE_PLAN)
            .map((plan) => (
              <PricingPlanCard key={plan.id} plan={plan} />
            ))}
        </div>
      ) : (
        // Phones scroll the cards sideways. The row bleeds past the section
        // gutter to the screen edge, so the next card peeks in on the right;
        // the top padding keeps each card's tape and the bottom its shadow.
        <div
          className="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{
            marginTop: 36,
            marginInline: -24,
            display: "flex",
            gap: 16,
            overflowX: "auto",
            padding: "12px 24px 12px",
            scrollPaddingInline: 24,
            scrollSnapType: "x mandatory",
          }}
        >
          {plans.map((plan) => (
            <div key={plan.id} style={{ flex: "0 0 80%", scrollSnapAlign: "start" }}>
              <PricingPlanCard plan={plan} />
            </div>
          ))}
        </div>
      )}
      {isDesktop ? <NotePlan /> : null}
    </section>
  );
}

// The plan without a card on a wide window, as one line under the row.
function NotePlan() {
  const t = useTranslations("landing.pricing");
  const copy = useCutPlan(NOTE_PLAN);

  return (
    <p className="mt-6 text-[17px] font-semibold text-foreground md:mt-10">
      {t("notePlan", { plan: copy.name, price: copy.price })}
    </p>
  );
}
