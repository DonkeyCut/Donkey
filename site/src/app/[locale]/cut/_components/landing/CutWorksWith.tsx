"use client";

import { useTranslations } from "next-intl";

import { Headline } from "@/app/_components/landing/LandingPrimitives";

// The assistant rides the Claude and Codex logins already on the user's Mac,
// so a subscription is all it takes — this section says exactly that.
const PROVIDERS = [
  { name: "Claude", logo: "/cut/landing/claude-logo.svg" },
  { name: "Codex", logo: "/cut/landing/openai-logo.svg" },
];

export function CutWorksWith() {
  const t = useTranslations("landing.worksWith");

  return (
    <section className="mx-auto max-w-[1400px] px-6 py-20 text-center md:px-12 md:py-24">
      <Headline size="lg">
        {t.rich("title", { italic: (chunks) => <span className="italic">{chunks}</span> })}
      </Headline>
      <div className="mt-12 flex items-center justify-center gap-x-6 md:gap-x-24">
        {PROVIDERS.map((provider) => (
          <div key={provider.name} className="flex items-center gap-2 md:gap-4">
            <img src={provider.logo} alt="" className="size-9 dark:rounded-md dark:bg-cream md:size-12" />
            <span className="text-[clamp(20px,6vw,44px)] font-semibold tracking-tight">
              {provider.name}
            </span>
          </div>
        ))}
      </div>
      <p className="mx-auto mt-12 max-w-[720px] text-[17px] leading-[1.55] text-foreground/70">
        {t("body")}
      </p>
    </section>
  );
}
