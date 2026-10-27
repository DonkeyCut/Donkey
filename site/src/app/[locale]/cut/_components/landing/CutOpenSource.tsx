"use client";

import { useTranslations } from "next-intl";

import {
  Headline,
  PillButton,
} from "@/app/_components/landing/LandingPrimitives";
import { GITHUB_REPO_URL } from "@/app/_components/landing/data";

// The local dev server's address, as the terminal mock prints it.
const LOCAL_EDITOR_URL = "http://localhost:3000/cut";

export function CutOpenSource() {
  const t = useTranslations("landing.openSource");

  return (
    <section className="mx-auto max-w-[1400px] px-6 py-20 md:px-12 md:py-24">
      <Headline size="lg">
        {t.rich("title", { italic: (chunks) => <span className="italic">{chunks}</span> })}
      </Headline>
      <p className="mt-6 max-w-[900px] text-[17px] leading-[1.55] text-foreground/70">
        {t("body")}
      </p>

      <div className="mt-8">
        <div className="backlight max-w-[780px] overflow-x-auto rounded-xl bg-ink px-[18px] pt-5 pb-10 font-code text-[13px] text-white md:px-6 md:pt-6 md:pb-12 md:text-[15px]">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-[10px] w-[10px] rounded-full bg-[#FF5F57]" />
            <span className="h-[10px] w-[10px] rounded-full bg-[#FEBC2E]" />
            <span className="h-[10px] w-[10px] rounded-full bg-[#28C840]" />
          </div>
          <div className="whitespace-nowrap text-[#b7b7b7]">
            <span className="text-[#5FFFB9]">$</span> {"cd ~/DonkeyCut"}
          </div>
          <div className="mt-3 whitespace-nowrap text-[#b7b7b7]">
            <span className="text-[#5FFFB9]">$</span> {`git clone ${GITHUB_REPO_URL}`}
          </div>
          <div className="mt-3 text-[#b7b7b7]">{t("runLocally")}</div>
          <div className="mt-3 whitespace-nowrap text-[#b7b7b7]">
            <span className="text-[#5FFFB9]">$</span> {"cd Donkey/site && npm install && npm run dev"}
          </div>
          <div className="mt-3 text-[#5FFFB9]">
            {t("running", { url: LOCAL_EDITOR_URL })}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <PillButton href={GITHUB_REPO_URL} variant="secondary" size="md">
            {t("star")}
          </PillButton>
        </div>
      </div>
    </section>
  );
}
