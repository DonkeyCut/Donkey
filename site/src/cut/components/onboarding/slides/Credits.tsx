"use client";

import { useEffect, useRef } from "react";

import { burstConfetti } from "@/cut/components/onboarding/confetti";
import { signupAppCredits } from "@/lib/onboarding/sequence";

// The signup grant already landed when the account was created, so this slide
// never grants anything — it says what's there. That's as true on a replay as
// on a first run, so the words don't change between them; the burst fires every
// time the slide is reached. An account whose address already received the
// grant on an earlier, deleted account has none, and the slide says that.
export function CreditsSlide({ granted }: { granted: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!granted) return;
    return burstConfetti(canvas);
  }, [granted]);

  if (!granted) {
    return (
      <div className="relative flex flex-col items-center text-center">
        <div className="relative max-w-[900px]">
          <h2 className="text-[clamp(26px,4.4vw,52px)] font-light leading-[1.02] tracking-[-0.03em]">
            Welcome back
          </h2>
          <p className="mx-auto mt-4 max-w-[460px] text-left text-[16px] leading-[1.55] text-[#454545]">
            Signup credits came with your first account. Top up or go Pro to
            generate video, audio and images.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center text-center">
      {/* Fixed to the window: the burst covers the whole overlay and, being out
          of flow, can't stretch the slide's scroll area. The explicit size is
          load-bearing — a canvas left to `auto` takes its 300×150 intrinsic
          size rather than the inset box. */}
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none fixed inset-0 h-full w-full"
      />
      <div className="relative max-w-[900px]">
        {/* One line, two sizes: the amount at display size in coral, the words
            a couple of steps down and thin beside it. Cents belong on a
            balance, not on the offer. */}
        <h2 className="flex flex-wrap items-baseline justify-center gap-x-4 leading-[1.02] tracking-[-0.03em]">
          <span className="text-[clamp(40px,7.4vw,84px)] font-semibold text-coral tabular-nums">
            ${signupAppCredits}
          </span>
          <span className="text-[clamp(26px,4.4vw,52px)] font-light">
            in AI credits is on us
          </span>
        </h2>
        {/* Ragged right on a narrow measure: the line breaks stay put instead
            of the last line floating in the middle of the slide. */}
        <p className="mx-auto mt-4 max-w-[460px] text-left text-[16px] leading-[1.55] text-[#454545]">
          Already in your account — nothing to claim. Spend it on generated
          video, audio and images.
        </p>
      </div>
    </div>
  );
}
