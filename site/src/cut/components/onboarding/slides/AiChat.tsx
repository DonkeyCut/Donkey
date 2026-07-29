"use client";

import { EditorMock } from "@/cut/components/editor-mock/EditorMock";

export function AiChatSlide() {
  return (
    <div className="mx-auto grid w-full max-w-[900px] items-center gap-10 md:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <h2 className="text-[clamp(26px,3.4vw,36px)] leading-[1.1] font-semibold tracking-[-0.02em]">
          Tell it what to change
        </h2>
        <p className="mt-4 text-[16.5px] leading-[1.55] text-[#454545]">
          The chat sits inside the editor with full access to your project. It
          can cut clips, generate the shot you&apos;re missing, write and read
          subtitles, add voiceover, and render the export — and you can ask it
          about your footage instead.
        </p>
        <p className="mt-4 text-[16.5px] leading-[1.55] text-[#454545]">
          It runs on Gemini Flash out of the box, or on your own Claude or Codex
          subscription if you already pay for one.
        </p>
      </div>
      <div className="h-[min(52vh,420px)]">
        <EditorMock view="ai" fit="height" showSwitcher={false} />
      </div>
    </div>
  );
}
