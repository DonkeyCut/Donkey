import type { ReactNode } from "react";

import { Footer } from "@/app/_components/landing/Footer";
import { TopNav } from "@/app/_components/landing/TopNav";

type Props = {
  children: ReactNode;
};

export function LegalPageShell({ children }: Props) {
  return (
    <main className="min-h-screen bg-[#F5EFE0] text-[#0F0E0D] antialiased [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <TopNav wordmark="Donkey Cut" />
      <section className="mx-auto box-border w-full max-w-5xl px-6 py-12 md:px-10 md:py-20">
        <article className="prose prose-neutral max-w-none prose-headings:font-semibold prose-headings:tracking-normal prose-h1:text-5xl prose-h1:leading-none prose-h2:mt-12 prose-h2:border-t prose-h2:border-black/15 prose-h2:pt-8 prose-a:font-semibold prose-a:text-black prose-strong:text-black md:prose-h1:text-7xl">
          {children}
        </article>
      </section>
      <Footer />
    </main>
  );
}
