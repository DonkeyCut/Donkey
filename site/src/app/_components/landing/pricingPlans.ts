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
  action: PricingPlanAction;
  body: string;
  color: CardColor;
  detail: string;
  features: string[];
  name: string;
  price: string;
  tapeColor: CardColor;
  tapePosition?: "left" | "right" | "center";
};
