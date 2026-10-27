"use client";

import { useTranslations } from "next-intl";

import { EditorMock } from "@/cut/components/editor-mock/EditorMock";

export function WelcomeSlide() {
  const t = useTranslations("onboarding.welcome");
  return (
    <div className="flex flex-col items-center gap-9 text-center">
      {/* Sized to hold the headline on one line: the clamp's vw term shrinks it
          with the window rather than letting it wrap. */}
      <div className="max-w-[860px]">
        <h2 className="text-[clamp(22px,3.1vw,34px)] leading-[1.1] font-semibold tracking-[-0.02em]">
          {t("title")}
        </h2>
        <p className="mt-4 text-[17px] leading-[1.55] text-foreground/70">
          {t("body")}
        </p>
      </div>
      {/* Contained rather than width-driven: on a short window the mock gives
          up size instead of pushing the slide into a scroll. On mobile it
          cancels the slide's padding and runs edge to edge. */}
      <div className="-mx-6 h-[min(56vh,640px)] w-[calc(100%+3rem)] max-w-[1060px] md:mx-0 md:w-full">
        <EditorMock
          project="onboarding"
          fit="contain"
          showSwitcher={false}
          frame="card"
        />
      </div>
    </div>
  );
}
