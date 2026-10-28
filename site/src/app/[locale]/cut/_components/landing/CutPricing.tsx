"use client";

import { useTranslations } from "next-intl";

import { Headline } from "@/app/_components/landing/LandingPrimitives";
import { PricingPlanCard } from "@/app/_components/landing/PricingPlanCard";
import { useMediaQuery } from "@/app/_components/landing/useMediaQuery";
import { useCutPricingPlans } from "@/app/[locale]/cut/_components/landing/cutPricingPlans";

export function CutPricing() {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const t = useTranslations("landing.pricing");
  const plans = useCutPricingPlans();

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
          {plans.map((plan) => (
            <PricingPlanCard key={plan.name} plan={plan} />
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
            <div key={plan.name} style={{ flex: "0 0 80%", scrollSnapAlign: "start" }}>
              <PricingPlanCard plan={plan} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
