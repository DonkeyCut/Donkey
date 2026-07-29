"use client";

import { Check } from "lucide-react";

import { REFERRAL_SOURCES, type ReferralSource } from "@/lib/onboarding/sequence";
import { cn } from "@/lib/utils";

type Props = {
  selected: ReferralSource | null;
  onSelect: (source: ReferralSource) => void;
};

export function ReferralSlide({ selected, onSelect }: Props) {
  return (
    <div className="mx-auto w-full max-w-[440px]">
      <h2 className="text-center text-[clamp(26px,3.4vw,36px)] leading-[1.1] font-semibold tracking-[-0.02em]">
        How did you hear about us?
      </h2>
      <p className="mt-3 text-center text-[16px] text-[#454545]">
        It tells us where to show up next.
      </p>
      <div className="mt-8 flex flex-col gap-2">
        {REFERRAL_SOURCES.map((source) => {
          const active = selected === source.id;
          return (
            <button
              key={source.id}
              type="button"
              onClick={() => onSelect(source.id)}
              aria-pressed={active}
              className={cn(
                "flex items-center justify-between rounded-xl border px-4 py-3.5 text-left text-[15px] font-medium transition-colors",
                active
                  ? "border-ink bg-ink text-white"
                  : "border-ink/15 bg-white hover:border-ink/40",
              )}
            >
              {source.label}
              <Check className={cn("size-4", active ? "opacity-100" : "opacity-0")} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
