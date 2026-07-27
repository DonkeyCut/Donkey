import type { PricingPlan } from "@/app/_components/landing/pricingPlans";

// Cut's two tiers: the editor itself is free and local; Pro adds monthly AI
// generation credits. `root` prefixes in-app links ("" on donkeycut.com,
// "/cut" in dev) so the cards work on either host.
export function cutPricingPlans(root: string): PricingPlan[] {
  return [
    {
      action: {
        href: `${root}/app`,
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
        href: `${root}/app/settings`,
        kind: "link",
        label: "Get Pro",
      },
      body: "Generate rich media with AI.",
      color: "coral",
      detail: "For individuals",
      features: [
        "Everything in Free",
        "50 GB of cloud storage",
        "Generous AI credits every month",
        "Image, video, voiceover, and music generation",
      ],
      name: "Pro",
      price: "$20/month",
      tapeColor: "yellow",
      tapePosition: "right",
    },
  ];
}
