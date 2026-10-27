"use client";

import { useTranslations } from "next-intl";

import { PillButton } from "@/app/_components/landing/LandingPrimitives";
import { useAppEntryHref } from "@/app/_components/landing/useAppEntryHref";
import { EditorMock } from "@/cut/components/editor-mock/EditorMock";

export function CutHero() {
  const appHref = useAppEntryHref();
  const t = useTranslations("landing");

  return (
    <section
      id="top"
      className="mx-auto max-w-[1400px] px-6 pt-10 pb-20 md:px-12 md:pt-16 md:pb-[120px]"
    >
      <div>
        <h1 className="text-[clamp(36px,5.5vw,64px)] leading-[0.95] font-semibold tracking-[-0.02em]">
          {t.rich("tagline", { italic: (chunks) => <span className="italic">{chunks}</span> })}
        </h1>
        <p className="mt-6 max-w-[720px] text-[17px] leading-[1.55] text-foreground/70">
          {t("hero.body")}
        </p>
        <div className="mt-12">
          <PillButton href={appHref("/app")} variant="primary" size="md">
            {t("hero.cta")}
          </PillButton>
        </div>
      </div>
      <div className="-mx-6 mt-12 md:mx-0 md:mt-16">
        <EditorMock />
      </div>
    </section>
  );
}
