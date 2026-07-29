"use client";

import type { ReactNode } from "react";
import { Check, Search, Users } from "lucide-react";

import { REFERRAL_SOURCES, type ReferralSource } from "@/lib/onboarding/sequence";
import { cn } from "@/lib/utils";

// The brand marks are files (public/cut/onboarding), the generic answers are
// icons; both render in the same box so every row lines up.
const MARKS: Record<ReferralSource, ReactNode> = {
  discord: <BrandMark src="/cut/onboarding/discord.svg" />,
  tiktok: <BrandMark src="/cut/onboarding/tiktok.svg" />,
  instagram: <BrandMark src="/cut/onboarding/instagram.svg" />,
  youtube: <BrandMark src="/cut/onboarding/youtube.svg" />,
  search: <Search className="size-[18px]" />,
  friend: <Users className="size-[18px]" />,
};

type Props = {
  selected: ReferralSource[];
  onToggle: (source: ReferralSource) => void;
};

export function ReferralSlide({ selected, onToggle }: Props) {
  return (
    <div className="mx-auto w-full max-w-[440px]">
      <h2 className="text-center text-[clamp(24px,3vw,32px)] leading-[1.1] font-semibold tracking-[-0.02em]">
        How did you hear about us?
      </h2>
      <p className="mt-3 text-center text-[16px] text-[#454545]">
        Pick as many as apply — it tells us where to show up next.
      </p>
      <div className="mt-8 flex flex-col gap-2">
        {REFERRAL_SOURCES.map((source) => {
          const active = selected.includes(source.id);
          return (
            <button
              key={source.id}
              type="button"
              onClick={() => onToggle(source.id)}
              aria-pressed={active}
              className={cn(
                // Selection is a border and a check, not a filled row: the
                // brand marks keep their own colors and stay legible.
                "flex items-center gap-3 rounded-xl border bg-white px-4 py-3.5 text-left text-[15px] font-medium transition-colors",
                active
                  ? "border-ink ring-1 ring-ink"
                  : "border-ink/15 hover:border-ink/40",
              )}
            >
              <span className="grid size-5 shrink-0 place-items-center">
                {MARKS[source.id]}
              </span>
              <span className="flex-1">{source.label}</span>
              <Check className={cn("size-4", active ? "opacity-100" : "opacity-0")} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BrandMark({ src }: { src: string }) {
  return (
    <img src={src} alt="" width={18} height={18} className="block size-[18px]" />
  );
}
