"use client";

import { PillButton } from "@/app/_components/landing/LandingPrimitives";
import { useAppEntryHref } from "@/app/_components/landing/useAppEntryHref";
import { EditorMock } from "@/cut/components/editor-mock/EditorMock";

export function CutHero({ root }: { root: string }) {
  const appHref = useAppEntryHref();

  return (
    <section
      id="top"
      className="mx-auto max-w-[1400px] px-6 pt-10 pb-20 md:px-12 md:pt-16 md:pb-[120px]"
    >
      <div>
        <h1 className="text-[clamp(36px,5.5vw,64px)] leading-[0.95] font-semibold tracking-[-0.02em]">
          The video editor iMovie{" "}
          <span className="italic">should have been.</span>
        </h1>
        <p className="mt-6 max-w-[720px] text-[17px] leading-[1.55] text-[#454545]">
          A browser editor with AI generation when needed. The companion Mac
          app transcribes, stores, and exports using your own hardware. No
          uploads, no cloud storage fees and works with your Claude or Codex
          subscriptions.
        </p>
        <div className="mt-12">
          <PillButton href={appHref(`${root}/app`)} variant="primary" size="md">
            Start a new project
          </PillButton>
        </div>
      </div>
      <div className="mt-12 md:mt-16">
        <EditorMock />
      </div>
    </section>
  );
}
