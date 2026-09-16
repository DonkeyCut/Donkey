"use client";

import { Headline } from "@/app/_components/landing/LandingPrimitives";

// The assistant rides the Claude and Codex logins already on the user's Mac,
// so a subscription is all it takes — this section says exactly that.
const PROVIDERS = [
  { name: "Claude", logo: "/cut/landing/claude-logo.svg" },
  { name: "Codex", logo: "/cut/landing/openai-logo.svg" },
];

export function CutWorksWith() {
  return (
    <section className="mx-auto max-w-[1400px] px-6 py-20 text-center md:px-12 md:py-24">
      <Headline size="lg">
        Works <span className="italic">with</span>
      </Headline>
      <div className="mt-12 flex items-center justify-center gap-x-6 md:gap-x-24">
        {PROVIDERS.map((provider) => (
          <div key={provider.name} className="flex items-center gap-2 md:gap-4">
            <img src={provider.logo} alt="" className="size-9 md:size-12" />
            <span className="text-[clamp(20px,6vw,44px)] font-semibold tracking-tight">
              {provider.name}
            </span>
          </div>
        ))}
      </div>
      <p className="mx-auto mt-12 max-w-[720px] text-[17px] leading-[1.55] text-[#454545]">
        The assistant uses the Claude and Codex apps already signed in on your
        Mac. If you have a subscription, you’re done — no setup, no API keys.
      </p>
    </section>
  );
}
