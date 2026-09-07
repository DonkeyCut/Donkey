import type { PricingPlan } from "@/app/_components/landing/pricingPlans";
import { promotionCovers, type AllowancePromotion } from "@/lib/billing/allowance-promotion";

// What Pro costs and what it gets you, in one place: the landing card below
// and the welcome sequence's last slide both read it, so the price can't say
// two different things in two parts of the product.
export const CUT_PRO = {
  body: "Generate rich media with AI.",
  // The plan price in USD a month. The included AI allowance equals it.
  monthlyDollars: 20,
  // What Pro adds. The landing card sits beside the Free card and opens with a
  // line pointing at it; nothing else does, so that line isn't in here.
  features: [
    "100 GB of cloud storage",
    "Generous AI credits every month",
    "Image, video, voiceover, and music generation",
  ],
  price: "$20/month",
};

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
export function cutPricingPlans(): PricingPlan[] {
  return [
    {
      action: {
        href: "/app",
        kind: "link",
        label: "Start a new project",
      },
      body: "The whole editor, in the cloud or on your own Mac.",
      color: "cream",
      detail: "For everyone",
      features: [
        "Full access to the video editor",
        "250 MB of cloud storage",
        "Import, export, and local transcription",
        "Connect your Claude or Codex subscription",
      ],
      name: "Free",
      price: "$0",
      tapeColor: "coral",
    },
    {
      action: {
        href: "/app/settings",
        kind: "link",
        label: "Get Pro",
      },
      body: CUT_PRO.body,
      color: "coral",
      detail: "For individuals",
      features: ["Everything in Free", ...CUT_PRO.features],
      name: "Pro",
      price: CUT_PRO.price,
      tapeColor: "yellow",
      tapePosition: "right",
    },
  ];
}
