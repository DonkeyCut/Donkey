import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";

import { Footer } from "@/app/_components/landing/Footer";
import { TopNav } from "@/app/_components/landing/TopNav";
import { DEFAULT_LOCALE } from "@/i18n/locales";

type Props = {
  // A policy is published in English only, so its body is marked English and
  // every other language says first that the English text governs. A page is
  // copy in the reader's language, such as the unsubscribe page.
  content: "policy" | "page";
  children: ReactNode;
};

export async function LegalPageShell({ content, children }: Props) {
  const [locale, t] = await Promise.all([getLocale(), getTranslations("legal")]);
  const policy = content === "policy";

  return (
    <main className="min-h-screen bg-background text-foreground font-system antialiased">
      <TopNav wordmark="Donkey Cut" />
      <section className="mx-auto box-border w-full max-w-5xl px-6 py-12 md:px-10 md:py-20">
        {policy && locale !== DEFAULT_LOCALE ? (
          <p className="mb-8 text-sm text-foreground/70">{t("englishGoverns")}</p>
        ) : null}
        <article className="prose prose-neutral dark:prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-normal prose-h1:text-5xl prose-h1:leading-none prose-h2:mt-12 prose-h2:border-t prose-h2:border-foreground/15 prose-h2:pt-8 prose-a:font-semibold prose-a:text-foreground prose-strong:text-foreground md:prose-h1:text-7xl">
          {policy ? <div lang="en">{children}</div> : children}
        </article>
      </section>
      <Footer />
    </main>
  );
}
