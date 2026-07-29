"use client";

import { Headline } from "@/app/_components/landing/LandingPrimitives";
import { PricingPlanCard } from "@/app/_components/landing/PricingPlanCard";
import { useAppEntryHref } from "@/app/_components/landing/useAppEntryHref";
import { useMediaQuery } from "@/app/_components/landing/useMediaQuery";
import { cutPricingPlans } from "@/app/cut/_components/landing/cutPricingPlans";

export function CutPricing() {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const appHref = useAppEntryHref();

  // Both plan CTAs enter the app, so gate them the same way as the hero: a
  // signed-out click lands on sign-in first, then returns to the app target.
  const plans = cutPricingPlans().map((plan) => ({
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
        Simple <span style={{ fontStyle: "italic" }}>pricing</span>
      </Headline>
      <p className="mt-6 max-w-[900px] text-[17px] leading-[1.55] text-[#454545]">
        The editor is free. Pay only for AI generated media.
      </p>
      <div
        style={{
          marginTop: 48,
          display: "grid",
          gridTemplateColumns: isDesktop ? "1fr 1fr" : "1fr",
          alignItems: "stretch",
          gap: 24,
        }}
      >
        {plans.map((plan) => (
          <PricingPlanCard key={plan.name} plan={plan} />
        ))}
      </div>
      <p className="mt-6 text-[15px] leading-[1.55] text-[#454545]">
        * Buy credits for AI generated content at any time.
      </p>
    </section>
  );
}
