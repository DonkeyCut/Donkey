"use client";

import { Cloud, Laptop } from "lucide-react";

import { TapedCard } from "@/app/_components/landing/LandingPrimitives";
import { CheckBullet } from "@/cut/components/onboarding/CheckBullet";

export function ModesSlide() {
  return (
    <div className="mx-auto w-full max-w-[760px]">
      <h2 className="text-center text-[clamp(24px,3vw,32px)] leading-[1.1] font-semibold tracking-[-0.02em] text-balance">
        Works in the cloud or on your Mac
      </h2>
      <p className="mx-auto mt-3 max-w-[560px] text-center text-[16px] leading-[1.5] text-[#454545] italic">
        Same editor. Choose what works for you.
      </p>

      {/* The landing's taped cards, so the two places to work are framed the
          same way the site frames everything else. */}
      <div className="mt-7 grid gap-4 md:mt-10 md:grid-cols-2 md:gap-5">
        <Mode
          icon={<Cloud className="size-5" />}
          title="In the cloud"
          tape="coral"
          points={["No install", "Works in any browser", "We handle rendering"]}
        />
        <Mode
          icon={<Laptop className="size-5" />}
          title="On your Mac"
          tape="yellow"
          points={[
            "Your files stay local",
            "Uses your Mac's hardware",
            "Faster exports & AI features",
          ]}
        />
      </div>

      <p className="mt-7 text-center text-[15px] leading-[1.5] text-[#454545] md:mt-9">
        Automatically switches between cloud and local when available.
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
  tape: "coral" | "yellow";
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
