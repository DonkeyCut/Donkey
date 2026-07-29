"use client";

import { Check } from "lucide-react";

import {
  PillButton,
  TapedCard,
} from "@/app/_components/landing/LandingPrimitives";
import type { PricingPlan } from "@/app/_components/landing/pricingPlans";
import { useMediaQuery } from "@/app/_components/landing/useMediaQuery";

type Props = {
  plan: PricingPlan;
};

export function PricingPlanCard({ plan }: Props) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const action = plan.action;

  const button = (
    <PillButton href={action.href} variant="dark">
      {action.label}
    </PillButton>
  );

  return (
    <TapedCard
      color={plan.color}
      fill
      tapeColor={plan.tapeColor}
      tapePosition={plan.tapePosition}
    >
      <div
        style={{
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          padding: isDesktop ? 36 : 28,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 22, marginBottom: 18 }}>
          {plan.name}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: isDesktop ? 54 : 42,
              lineHeight: 0.95,
            }}
          >
            {plan.price}
          </span>
        </div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: plan.color === "coral" ? "#201715" : "#444",
            marginBottom: 24,
            marginTop: 10,
          }}
        >
          {plan.detail}
        </div>
        <p
          style={{
            color: plan.color === "coral" ? "#1a1a1a" : "#222",
            fontSize: 15,
            lineHeight: 1.55,
            margin: "0 0 24px",
          }}
        >
          {plan.body}
        </p>
        <div
          style={{
            display: "grid",
            gap: 10,
            marginBottom: 28,
          }}
        >
          {plan.features.map((feature) => (
            <div
              key={feature}
              style={{
                alignItems: "center",
                display: "flex",
                gap: 10,
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  alignItems: "center",
                  background: "#fff",
                  border: "2px solid #0F0E0D",
                  borderRadius: 999,
                  display: "inline-flex",
                  height: 24,
                  justifyContent: "center",
                  width: 24,
                }}
              >
                <Check size={14} />
              </span>
              <span>{feature}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: "auto" }}>{button}</div>
      </div>
    </TapedCard>
  );
}
