"use client";

import { BG, BLACK } from "@/app/_components/landing/theme";
import { CutFinalCTA } from "@/app/cut/_components/landing/CutFinalCTA";
import { CutFooter } from "@/app/cut/_components/landing/CutFooter";
import { CutHero } from "@/app/cut/_components/landing/CutHero";
import { CutLocal } from "@/app/cut/_components/landing/CutLocal";
import { CutOpenSource } from "@/app/cut/_components/landing/CutOpenSource";
import { CutPricing } from "@/app/cut/_components/landing/CutPricing";
import { CutTopNav } from "@/app/cut/_components/landing/CutTopNav";
import { CutWorksWith } from "@/app/cut/_components/landing/CutWorksWith";

// The donkeycut.com marketing page: the Donkey landing's cream visual system
// with Cut-only content. `root` is "" on donkeycut.com and "/cut" in dev, so
// links into the app resolve on either host. Every CTA into the app is gated on
// session (useAppEntryHref): signed-out clicks route to sign-in first. The nav
// mirrors this — a "Log in" link with a "Sign up" pill when signed out,
// "Go to App" when signed in.
export function CutLanding({ root }: { root: string }) {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: BG,
        color: BLACK,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <CutTopNav root={root} />
      <CutHero root={root} />
      <CutWorksWith />
      <CutPricing root={root} />
      <CutLocal root={root} />
      <CutOpenSource />
      <CutFinalCTA root={root} />
      <CutFooter />
    </main>
  );
}
