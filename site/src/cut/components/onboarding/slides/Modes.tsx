"use client";

import { Cloud, Laptop } from "lucide-react";
import { useTranslations } from "next-intl";

import { TapedCard } from "@/app/_components/landing/LandingPrimitives";
import { CheckBullet } from "@/cut/components/onboarding/CheckBullet";

export function ModesSlide() {
  const t = useTranslations("onboarding.modes");
  return (
    <div className="mx-auto w-full max-w-[760px]">
      <h2 className="text-center text-[clamp(24px,3vw,32px)] leading-[1.1] font-semibold tracking-[-0.02em] text-balance">
        {t("title")}
      </h2>
      <p className="mx-auto mt-3 max-w-[560px] text-center text-[16px] leading-[1.5] text-foreground/70 italic">
        {t("subtitle")}
      </p>

      {/* The landing's taped cards, so the two places to work are framed the
          same way the site frames everything else. */}
      <div className="mt-7 grid gap-4 md:mt-10 md:grid-cols-2 md:gap-5">
        <Mode
          icon={<Cloud className="size-5" />}
          title={t("cloudTitle")}
          tape="blue"
          points={[t("cloudNoInstall"), t("cloudAnyBrowser"), t("cloudRendering")]}
        />
        <Mode
          icon={<Laptop className="size-5" />}
          title={t("macTitle")}
          tape="yellow"
          points={[t("macLocalFiles"), t("macHardware"), t("macFaster")]}
        />
      </div>

      <p className="mt-7 text-center text-[15px] leading-[1.5] text-foreground/70 md:mt-9">
        {t("switching")}
      </p>
    </div>
  );
}

function Mode({
  icon,
  points,
  tape,
  title,
}: {
  icon: React.ReactNode;
  points: string[];
  tape: "blue" | "yellow";
  title: string;
}) {
  return (
    <TapedCard color="cream" fill tapeColor={tape} tapePosition="left">
      {/* Deep top and bottom padding on a narrower card, so the pair reads as
          squares rather than banners. Stacked on mobile, that depth is what
          pushes the slide into a scroll, so it flattens out. */}
      <div className="px-7 py-7 md:py-14">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg border-2 border-ink bg-white">
            {icon}
          </span>
          <h3 className="text-[18px] font-semibold">{title}</h3>
        </div>
        <ul className="mt-5 flex flex-col gap-2.5">
          {points.map((point) => (
            <li
              key={point}
              className="flex items-center gap-2.5 text-[14px] font-semibold"
            >
              <CheckBullet />
              {point}
            </li>
          ))}
        </ul>
      </div>
    </TapedCard>
  );
}
