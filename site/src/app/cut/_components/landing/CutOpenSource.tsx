"use client";

import {
  Headline,
  PillButton,
} from "@/app/_components/landing/LandingPrimitives";
import { GITHUB_REPO_URL } from "@/app/_components/landing/data";

export function CutOpenSource() {
  return (
    <section className="mx-auto max-w-[1400px] px-6 py-20 md:px-12 md:py-24">
      <Headline size="lg">
        Donkey Cut is <span className="italic">open source.</span>
      </Headline>
      <p className="mt-6 max-w-[900px] text-[17px] leading-[1.55] text-[#454545]">
        The editor and its render engine are built in the open. Read the
        source, run it yourself, contribute and make it better.
      </p>

      <div className="mt-8">
        <div className="max-w-[780px] overflow-x-auto rounded-xl bg-ink px-[18px] pt-5 pb-10 font-code text-[13px] text-white md:px-6 md:pt-6 md:pb-12 md:text-[15px]">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-[10px] w-[10px] rounded-full bg-[#FF5F57]" />
            <span className="h-[10px] w-[10px] rounded-full bg-[#FEBC2E]" />
            <span className="h-[10px] w-[10px] rounded-full bg-[#28C840]" />
          </div>
          <div className="whitespace-nowrap text-[#b7b7b7]">
            <span className="text-[#5FFFB9]">$</span> cd ~/DonkeyUseCorp
          </div>
          <div className="mt-3 whitespace-nowrap text-[#b7b7b7]">
            <span className="text-[#5FFFB9]">$</span> git clone {GITHUB_REPO_URL}
          </div>
          <div className="mt-3 text-[#b7b7b7]">Run the editor locally</div>
          <div className="mt-3 whitespace-nowrap text-[#b7b7b7]">
            <span className="text-[#5FFFB9]">$</span> cd Donkey/site && npm
            install && npm run dev
          </div>
          <div className="mt-3 text-[#5FFFB9]">
            Editor running - http://localhost:3000/cut
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <PillButton href={GITHUB_REPO_URL} variant="secondary" size="md">
            Star on GitHub
          </PillButton>
        </div>
      </div>
    </section>
  );
}
