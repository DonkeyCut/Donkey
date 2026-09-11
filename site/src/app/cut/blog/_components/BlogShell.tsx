import type { ReactNode } from "react";

import { CutFooter } from "@/app/cut/_components/landing/CutFooter";
import { CutTopNav } from "@/app/cut/_components/landing/CutTopNav";

// The blog's frame: the site nav and footer on the marketing sand, with the
// landing's column between them so every page on the host lines up.
export function BlogShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background font-system text-ink antialiased">
      <CutTopNav />
      <div className="mx-auto max-w-[1400px] px-6 pt-4 pb-20 md:px-12 md:pt-10 md:pb-28">{children}</div>
      <CutFooter />
    </main>
  );
}
