import type { CardColor } from "@/app/_components/landing/theme";

// The shape pricing cards render from. Donkey Use no longer sells through the
// site, so plans exist only where a product still lists them (Cut's landing —
// see cutPricingPlans.ts); every action is a plain link.
export type PricingPlanAction = {
  href: string;
  kind: "contact" | "link";
  label: string;
};

export type PricingPlan = {
  id: string;
  action: PricingPlanAction;
  body: string;
  color: CardColor;
  features: string[];
  name: string;
  // The price line under the name ("$20/month").
  price: string;
  tapeColor: CardColor;
  tapePosition?: "left" | "right" | "center";
};
