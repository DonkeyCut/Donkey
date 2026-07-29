"use client";

import Image from "next/image";

import {
  Headline,
  PillButton,
} from "@/app/_components/landing/LandingPrimitives";
import { cutInstallHref } from "@/cut/lib/install";

export function CutLocal() {
  return (
    <section
      id="local"
      className="mx-auto max-w-[1400px] px-6 py-20 md:px-12 md:py-24"
    >
      <div className="grid grid-cols-1 items-center gap-10 md:grid-cols-2 md:gap-16">
        <div>
          <Headline size="lg">
            Run Donkey Cut <span className="italic">on your Mac.</span>
          </Headline>
          <p className="mt-6 max-w-[560px] text-[17px] leading-[1.55] text-[#454545]">
            Edit videos locally on your Mac. The app uses your own storage and
            transcribes audio on device.
          </p>
          <div className="mt-8">
            <PillButton href={cutInstallHref()} variant="primary" size="md">
              Download for Mac
            </PillButton>
          </div>
        </div>
        <Image
          alt="Donkey app icon being dragged into the Applications folder."
          className="h-auto w-full rounded-2xl"
          height={413}
          src="/install/install-drag.png"
          unoptimized
          width={617}
        />
      </div>
    </section>
  );
}
