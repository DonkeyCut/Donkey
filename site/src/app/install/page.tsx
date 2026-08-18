import type { Metadata } from "next";

import { BG, BLACK } from "@/app/_components/landing/theme";
import { CutFooter } from "@/app/cut/_components/landing/CutFooter";
import { CutTopNav } from "@/app/cut/_components/landing/CutTopNav";
import { InstallInstructions } from "@/app/install/_components/InstallInstructions";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export const metadata: Metadata = {
  title: "Install Donkey",
  description: "Download Donkey for macOS and install it with the standard drag-to-Applications flow.",
  alternates: { canonical: `${DONKEYCUT_CANONICAL}/install` },
};

export const unstable_instant = { prefetch: "static" };

// The install page is passed through by src/proxy.ts and wears the Cut site's
// header and footer.
export default function InstallPage() {
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
      <CutTopNav />
      <InstallInstructions />
      <CutFooter />
    </main>
  );
}
