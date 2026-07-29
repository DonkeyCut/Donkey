"use client";

import { EditorMock } from "@/cut/components/editor-mock/EditorMock";

export function WelcomeSlide() {
  return (
    <div className="flex flex-col items-center gap-9 text-center">
      <div className="max-w-[700px]">
        <h2 className="text-[clamp(30px,4.4vw,46px)] leading-[1.02] font-semibold tracking-[-0.02em]">
          Welcome to Donkey Cut
        </h2>
        <p className="mt-4 text-[17px] leading-[1.55] text-[#454545]">
          A video editor that runs in your browser, generates the shots you
          don&apos;t have, and does the heavy lifting on your own Mac.
        </p>
      </div>
      <div className="w-full max-w-[840px]">
        <EditorMock showSwitcher={false} />
      </div>
    </div>
  );
}
