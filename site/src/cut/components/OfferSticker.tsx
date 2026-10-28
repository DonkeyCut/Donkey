"use client";

// The intro offer as a sticker: the time left ticking on top, the discount
// large under it. Onboarding pins the yellow one over the Pro card's corner;
// the plans modal sets the blue one beside the Pro column's heading.
import { useTranslations } from "next-intl";

import { countdownParts, useNow } from "@/cut/components/OfferDialog";
import { cn } from "@/lib/utils";
import type { IntroOffer } from "@/queries/billing";

export type StickerTone = "yellow" | "blue";

const TONE: Record<StickerTone, string> = {
  // The landing's ink and yellow, with its hard shadow.
  yellow: "size-[104px] border-2 border-ink bg-[#F5D875] text-ink shadow-[4px_4px_0_#0F0E0D]",
  // The modal's accent; white on it reads at 4.7:1 in either theme.
  blue: "size-[88px] bg-[#0071e3] text-white shadow-lg shadow-[#0071e3]/30",
};

export function OfferSticker({
  offer,
  tone,
  className,
}: {
  offer: IntroOffer;
  tone: StickerTone;
  // Where it sits and how it lands.
  className?: string;
}) {
  const t = useTranslations("billing.plans");
  const now = useNow();
  const { hours, minutes, seconds } = countdownParts(offer.endsAt, now);
  const large = tone === "yellow";

  return (
    <div
      className={cn(
        "flex rotate-6 flex-col items-center justify-center rounded-xl tabular-nums",
        TONE[tone],
        className,
      )}
    >
      <span className={cn("leading-none font-bold", large ? "text-[17px]" : "text-sm")}>
        {hours}:{minutes}:{seconds}
      </span>
      <span className={cn("mt-1.5 leading-none font-black tracking-tight", large ? "text-[34px]" : "text-[28px]")}>
        {t("stickerPercent", { percent: offer.percentOff })}
      </span>
      <span className={cn("mt-0.5 leading-none font-bold tracking-wide uppercase", large ? "text-[12px]" : "text-[11px]")}>
        {t("stickerOff")}
      </span>
    </div>
  );
}
