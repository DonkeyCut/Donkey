import type { ReactNode } from "react";

import { CutFooter } from "@/app/cut/_components/landing/CutFooter";
import { CutTopNav } from "@/app/cut/_components/landing/CutTopNav";

// The blog's frame: the site nav and footer on the marketing sand, with one
// measured column between them.
export function BlogShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background font-system text-ink antialiased">
      <CutTopNav />
      <div className="px-[clamp(1rem,4vw,4rem)] pt-4 pb-20 md:pt-10 md:pb-28">
        <div className="mx-auto max-w-[1080px]">{children}</div>
      </div>
      <CutFooter />
    </main>
  );
}
