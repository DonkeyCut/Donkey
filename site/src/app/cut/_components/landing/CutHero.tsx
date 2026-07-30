"use client";

import { PillButton } from "@/app/_components/landing/LandingPrimitives";
import { useAppEntryHref } from "@/app/_components/landing/useAppEntryHref";
import { EditorMock } from "@/cut/components/editor-mock/EditorMock";

export function CutHero() {
  const appHref = useAppEntryHref();

  return (
    <section
      id="top"
      className="mx-auto max-w-[1400px] px-6 pt-10 pb-20 md:px-12 md:pt-16 md:pb-[120px]"
    >
      <div>
        <h1 className="text-[clamp(36px,5.5vw,64px)] leading-[0.95] font-semibold tracking-[-0.02em]">
          Finally, a video editor{" "}
          <span className="italic">that&apos;s easy.</span>
        </h1>
        <p className="mt-6 max-w-[720px] text-[17px] leading-[1.55] text-[#454545]">
          Edit with chat, generate images and video, and keep your files on
          your own computer. Use your existing Claude or Codex subscription if
          you already have one.
        </p>
        <div className="mt-12">
          <PillButton href={appHref("/app")} variant="primary" size="md">
            Start a new project
          </PillButton>
        </div>
      </div>
      <div className="-mx-6 mt-12 md:mx-0 md:mt-16">
        <EditorMock />
      </div>
    </section>
  );
}
