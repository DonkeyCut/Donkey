"use client";

import { Check } from "lucide-react";

import { TapedCard } from "@/app/_components/landing/LandingPrimitives";
import { CUT_PRO } from "@/app/cut/_components/landing/cutPricingPlans";
import { Button } from "@/components/ui/button";
import { useUpgradeToPro } from "@/cut/lib/proUpgrade";

// The sequence's last word: Pro is the offer, free is the default, and the
// benefits sit in the card so nobody has to take the price on faith. It's the
// landing's own Pro card — same taped coral frame, same ringed check bullets —
// so the offer looks the same wherever it's met. Checkout is the one the
// storage wall and the billing page start.
export function PlansSlide({ onSkipPro }: { onSkipPro: () => void }) {
  const pro = useUpgradeToPro();

  return (
    <div className="mx-auto w-full max-w-[520px]">
      <h2 className="text-center text-[clamp(24px,3vw,32px)] leading-[1.1] font-semibold tracking-[-0.02em]">
        Simple pricing
      </h2>
      <p className="mt-3 text-center text-[16px] text-[#454545]">
        The editor is free. Pay only for AI generated media.
      </p>

      <div className="mt-8">
        <TapedCard color="coral" tapeColor="yellow" tapePosition="right">
          <div className="p-7 md:p-9">
            <div className="text-[22px] font-semibold">Pro</div>
            <div className="mt-4 text-[clamp(34px,4.4vw,48px)] leading-[0.95] font-semibold">
              {CUT_PRO.price}
            </div>
            <div className="mt-2.5 text-[13px] font-semibold text-[#201715]">
              For individuals
            </div>
            <p className="mt-5 text-[15px] leading-[1.55] text-[#1a1a1a]">
              {CUT_PRO.body}
            </p>

            <div className="mt-6 grid gap-2.5">
              {CUT_PRO.features.map((feature) => (
                <div
                  key={feature}
                  className="flex items-center gap-2.5 text-[14px] font-semibold"
                >
                  <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-white">
                    <Check size={14} />
                  </span>
                  {feature}
                </div>
              ))}
            </div>

            <Button
              onClick={pro.start}
              disabled={pro.isPending}
              className="mt-7 h-11 rounded-full bg-ink px-6 text-[15px] text-white hover:bg-ink/90"
            >
              Get Pro
            </Button>
          </div>
        </TapedCard>
      </div>

      <div className="mt-5 text-right">
        <button
          type="button"
          onClick={onSkipPro}
          className="text-[15px] text-[#454545] underline-offset-4 transition-colors hover:text-ink hover:underline"
        >
          Continue free
        </button>
      </div>
    </div>
  );
}
