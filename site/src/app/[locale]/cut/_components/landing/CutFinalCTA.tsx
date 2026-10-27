"use client";

import { useTranslations } from "next-intl";

import { PillButton } from "@/app/_components/landing/LandingPrimitives";
import { useAppEntryHref } from "@/app/_components/landing/useAppEntryHref";

export function CutFinalCTA() {
  const appHref = useAppEntryHref();
  const t = useTranslations("landing");

  return (
    <section
      id="download"
      className="mx-auto w-full max-w-[1400px] px-6 pt-12 pb-20 md:px-12 md:pt-16 md:pb-[120px]"
    >
      <div className="relative">
        <div className="absolute inset-0 translate-x-2 translate-y-2 rounded-3xl bg-coral" />
        <div className="backlight relative rounded-3xl border-2 border-ink bg-ink px-6 py-10 text-center text-white md:px-12 md:py-20">
          <div className="absolute -top-[10px] left-1/2 h-[18px] w-20 -translate-x-1/2 -rotate-2 rounded-[3px] border-2 border-ink bg-coral" />
          <h2 className="mb-4 text-[clamp(36px,5.5vw,64px)] leading-[0.95] font-medium tracking-[-0.02em]">
            {t.rich("tagline", { italic: (chunks) => <span className="italic">{chunks}</span> })}
          </h2>
          <p className="text-[17px] leading-[1.55] text-white/70">
            {t("finalCta.body")}
          </p>
          <div className="mt-8 flex justify-center">
            <PillButton href={appHref("/app")} variant="primary" size="lg">
              {t("finalCta.cta")}
            </PillButton>
          </div>
        </div>
      </div>
    </section>
  );
}
