"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Check, PenLine, Search, Users } from "lucide-react";

import {
  REFERRAL_OTHER_MAX_LENGTH,
  REFERRAL_SOURCES,
  type ReferralSource,
} from "@/lib/onboarding/sequence";
import { cn } from "@/lib/utils";

// The brand marks are files (public/cut/onboarding), the generic answers are
// icons; both render in the same box so every row lines up.
const MARKS: Record<ReferralSource, ReactNode> = {
  discord: <BrandMark src="/cut/onboarding/discord.svg" />,
  tiktok: <BrandMark src="/cut/onboarding/tiktok.svg" />,
  instagram: <BrandMark src="/cut/onboarding/instagram.svg" />,
  youtube: <BrandMark src="/cut/onboarding/youtube.svg" />,
  reddit: <BrandMark src="/cut/onboarding/reddit.svg" />,
  search: <Search className="size-[18px]" />,
  friend: <Users className="size-[18px]" />,
  other: <PenLine className="size-[18px]" />,
};

type Props = {
  selected: ReferralSource[];
  onToggle: (source: ReferralSource) => void;
  otherText: string;
  onOtherTextChange: (text: string) => void;
};

export function ReferralSlide({
  selected,
  onToggle,
  otherText,
  onOtherTextChange,
}: Props) {
  const otherActive = selected.includes("other");
  // The field stays mounted so it can unfurl, which rules out autoFocus.
  const otherInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (otherActive) otherInput.current?.focus();
  }, [otherActive]);

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
            <div key={source.id} className="relative">
              <button
                type="button"
                onClick={() => onToggle(source.id)}
                aria-pressed={active}
                className={cn(
                  // Selection is a border and a check, not a filled row: the
                  // brand marks keep their own colors and stay legible.
                  "relative z-[1] flex w-full items-center gap-3 rounded-xl border bg-white px-4 py-3.5 text-left text-[15px] font-medium transition-colors",
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
              {/* The tray hangs off the row absolutely so opening it moves
                  nothing else, and it unfurls (the 0fr→1fr grid trick) from
                  behind the row: its top 12px start under the button, so its
                  borders emerge right where the row's corner curves end. */}
              {source.id === "other" && (
                <div
                  className={cn(
                    "absolute inset-x-0 top-[calc(100%-12px)] grid transition-[grid-template-rows] duration-300 ease-in-out",
                    active ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                  )}
                >
                  {/* Bottom-aligned in the shrinking row, so closing slides the
                      field up behind the button instead of squashing it. */}
                  <div className="flex flex-col justify-end overflow-hidden pl-4">
                    <input
                      ref={otherInput}
                      type="text"
                      value={otherText}
                      onChange={(event) => onOtherTextChange(event.target.value)}
                      placeholder="Tell us where"
                      maxLength={REFERRAL_OTHER_MAX_LENGTH}
                      tabIndex={active ? 0 : -1}
                      className="w-full rounded-b-xl border border-t-0 border-ink bg-white px-4 pt-6 pb-3 text-[15px] outline-none placeholder:text-ink/40"
                    />
                  </div>
                </div>
              )}
            </div>
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
