import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { CutFooter } from "@/app/[locale]/cut/_components/landing/CutFooter";
import { CutTopNav } from "@/app/[locale]/cut/_components/landing/CutTopNav";
import { InstallInstructions } from "@/app/[locale]/(public)/install/_components/InstallInstructions";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("install.meta");
  return {
    title: t("title"),
    description: t("description"),
    alternates: { canonical: `${DONKEYCUT_CANONICAL}/install` },
  };
}

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
