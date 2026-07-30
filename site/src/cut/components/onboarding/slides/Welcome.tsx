"use client";

import { EditorMock } from "@/cut/components/editor-mock/EditorMock";
import { ONBOARDING_PROJECT } from "@/cut/components/editor-mock/mockData";

export function WelcomeSlide() {
  return (
    <div className="flex flex-col items-center gap-9 text-center">
      {/* Sized to hold the headline on one line: the clamp's vw term shrinks it
          with the window rather than letting it wrap. */}
      <div className="max-w-[860px]">
        <h2 className="text-[clamp(22px,3.1vw,34px)] leading-[1.1] font-semibold tracking-[-0.02em]">
          The AI video editor that works anywhere.
        </h2>
        <p className="mt-4 text-[17px] leading-[1.55] text-[#454545]">
          Chat to edit videos. Generate the shots you don&apos;t have.
        </p>
      </div>
      {/* Contained rather than width-driven: on a short window the mock gives
          up size instead of pushing the slide into a scroll. */}
      <div className="h-[min(56vh,640px)] w-full max-w-[1060px]">
        <EditorMock
          project={ONBOARDING_PROJECT}
          fit="contain"
          showSwitcher={false}
          frame="card"
        />
      </div>
    </div>
  );
}
