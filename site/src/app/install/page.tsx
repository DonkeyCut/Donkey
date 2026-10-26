import type { Metadata } from "next";

import { CutFooter } from "@/app/cut/_components/landing/CutFooter";
import { CutTopNav } from "@/app/cut/_components/landing/CutTopNav";
import { InstallInstructions } from "@/app/install/_components/InstallInstructions";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export const metadata: Metadata = {
  title: "Install Donkey",
  description: "Download Donkey for macOS and install it with the standard drag-to-Applications flow.",
  alternates: { canonical: `${DONKEYCUT_CANONICAL}/install` },
};

export const instant = true;

// The install page is passed through by src/proxy.ts and wears the Cut site's
// header and footer.
export default function InstallPage() {
  return (
    <main className="min-h-screen bg-background font-system text-foreground antialiased">
      <CutTopNav />
      <InstallInstructions />
      <CutFooter />
    </main>
  );
}
