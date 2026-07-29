"use client";

import { useEffect, useRef } from "react";

import { burstConfetti } from "@/cut/components/onboarding/confetti";
import { formatUsd } from "@/lib/credits/format-usd";
import { signupAppCredits, type OnboardingRun } from "@/lib/onboarding/sequence";
import { useCreditBalance } from "@/queries/credits";

// The signup grant already landed when the account was created, so this slide
// never grants anything — it shows what is there. A first run celebrates it; a
// replay is a balance check, without the confetti or the news framing.
export function CreditsSlide({ run }: { run: OnboardingRun }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { data: balance } = useCreditBalance();
  const firstRun = run === "first_run";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !firstRun) return;
    return burstConfetti(canvas);
  }, [firstRun]);

  return (
    <div className="relative flex flex-col items-center text-center">
      {/* Fixed to the window: the burst covers the whole overlay and, being out
          of flow, can't stretch the slide's scroll area. */}
      {firstRun && (
        <canvas ref={canvasRef} aria-hidden className="pointer-events-none fixed inset-0" />
      )}
      <div className="relative max-w-[560px]">
        <div className="text-[clamp(56px,9vw,96px)] leading-none font-semibold tracking-[-0.03em] text-coral tabular-nums">
          {formatUsd(signupAppCredits)}
        </div>
        <h2 className="mt-5 text-[clamp(24px,3.2vw,34px)] leading-[1.1] font-semibold tracking-[-0.02em]">
          {firstRun ? "In AI credits, on the house" : "Your AI credits"}
        </h2>
        <p className="mt-4 text-[16px] leading-[1.55] text-[#454545]">
          {firstRun
            ? "Already in your account — nothing to claim. Spend it on generated images, video, voiceover, and music, right inside the timeline."
            : "Credits pay for generated images, video, voiceover, and music. Top up any time from Settings → Billing."}
        </p>
        {balance?.balance && (
          <p className="mt-6 text-[14px] text-[#454545]">
            Balance today:{" "}
            <span className="font-medium text-ink tabular-nums">
              {formatUsd(balance.balance)}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
