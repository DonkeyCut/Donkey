import { CutFinalCTA } from "@/app/[locale]/cut/_components/landing/CutFinalCTA";
import { CutFooter } from "@/app/[locale]/cut/_components/landing/CutFooter";
import { CutHero } from "@/app/[locale]/cut/_components/landing/CutHero";
import { CutLocal } from "@/app/[locale]/cut/_components/landing/CutLocal";
import { CutOpenSource } from "@/app/[locale]/cut/_components/landing/CutOpenSource";
import { CutPricing } from "@/app/[locale]/cut/_components/landing/CutPricing";
import { CutTopNav } from "@/app/[locale]/cut/_components/landing/CutTopNav";
import { CutWorksWith } from "@/app/[locale]/cut/_components/landing/CutWorksWith";

// The donkeycut.com marketing page, on the cream visual system. Every CTA into
// the app is gated on session (useAppEntryHref): signed-out clicks route to
// sign-in first. The nav mirrors this — a "Log in" link with a "Sign up" pill
// when signed out, "Go to App" when signed in.
export function CutLanding() {
  return (
    <main className="min-h-screen bg-background font-system text-foreground antialiased">
      <CutTopNav />
      <CutHero />
      <CutWorksWith />
      <CutPricing />
      <CutLocal />
      <CutOpenSource />
      <CutFinalCTA />
      <CutFooter />
    </main>
  );
}
