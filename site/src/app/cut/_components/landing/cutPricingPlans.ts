import type { PricingPlan } from "@/app/_components/landing/pricingPlans";

// What Pro costs and what it gets you, in one place: the landing card below
// and the welcome sequence's last slide both read it, so the price can't say
// two different things in two parts of the product.
export const CUT_PRO = {
  body: "Generate rich media with AI.",
  // What Pro adds. The landing card sits beside the Free card and opens with a
  // line pointing at it; nothing else does, so that line isn't in here.
  features: [
    "100 GB of cloud storage",
    "Generous AI credits every month",
    "Image, video, voiceover, and music generation",
  ],
  price: "$20/month",
};

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
