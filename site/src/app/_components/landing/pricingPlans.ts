import type { CardColor } from "@/app/_components/landing/theme";

// The shape pricing cards render from. Donkey Use no longer sells through the
// site, so plans exist only where a product still lists them (Cut's landing —
// see cutPricingPlans.ts).
export type PricingPlan = {
  body: string;
  color: CardColor;
  features: string[];
  name: string;
  // The price line under the name ("$20/month").
  price: string;
  tapeColor: CardColor;
  tapePosition?: "left" | "right" | "center";
};
