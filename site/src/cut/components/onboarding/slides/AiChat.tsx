"use client";

import { EditorMock } from "@/cut/components/editor-mock/EditorMock";

// The one slide that uses the whole window rather than the sequence's reading
// column. The editor is the layout — the slide is exactly as tall as the mock,
// so there's no dead band above or below it — and the copy is laid over its
// left side. Two things keep that legible, and both are needed: the mock's own
// left half dissolves into the cream, and a cream scrim under the copy holds
// the contrast wherever the mock's edge lands at a given window size.
export function AiChatSlide() {
  return (
    <div className="relative left-1/2 w-screen -translate-x-1/2 px-6 md:px-10">
      {/* Capped and centered, so a very wide window doesn't leave the copy
          stranded on one edge and the editor on the other. */}
      <div className="mx-auto hidden max-w-[1680px] md:block">
        {/* Copy and scrim are positioned against the mock, not the slide, so
            the composition holds the same proportions however wide the window
            gets — the editor can't drift away from the words. */}
        {/* Centered, and capped by height as well as width: the mock is 1.24×
            as wide as it is tall, so a short window has to bound it or it runs
            past the bottom of the slide. */}
        <div className="relative mx-auto w-[min(100%,86vh)]">
          <div className="pointer-events-none [mask-image:linear-gradient(to_right,transparent_10%,black_70%)] [-webkit-mask-image:linear-gradient(to_right,transparent_10%,black_70%)]">
            <EditorMock view="ai" showSwitcher={false} shadow={false} />
          </div>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-[64%] bg-gradient-to-r from-cream via-cream/85 to-transparent" />
          <div className="absolute top-[15%] left-0 z-10 w-[48%] min-w-[320px]">
            <Copy />
          </div>
        </div>
      </div>

      {/* Narrow windows stack instead: the copy, then the editor at its own
          size, with nothing overlapping it. */}
      <div className="md:hidden">
        <div className="mx-auto max-w-[560px]">
          <Copy />
        </div>
        {/* Edge to edge: the slide's own padding is cancelled so the editor
            uses the whole width it has down here. */}
        <div className="-mx-6 mt-8">
          <EditorMock view="ai" showSwitcher={false} shadow={false} />
        </div>
      </div>
    </div>
  );
}

function Copy() {
  return (
    <div className="max-w-[620px]">
      <h2 className="text-[clamp(26px,3.2vw,38px)] leading-[1.05] font-semibold tracking-[-0.02em]">
        Chat with your editor.
      </h2>
      <p className="mt-5 text-[16.5px] leading-[1.55] text-[#454545]">
        The AI has access to your entire project. Ask it to trim clips, generate
        missing shots, write subtitles, add voiceovers, rearrange your timeline,
        or answer questions about your footage.
      </p>
      <p className="mt-4 text-[16.5px] leading-[1.55] text-[#454545]">
        Works out of the box with Gemini, or use your own Claude or Codex
        subscription.
      </p>
    </div>
  );
}
