import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { IntlScope } from "@/i18n/IntlScope";
import { PUBLIC_NAMESPACES } from "@/i18n/namespaces";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.meta");
  return { title: t("title"), description: t("description") };
}

// Surface styling belongs to the children: the landing page at /cut renders on
// the cream marketing background, while the app subtree under /cut/app paints
// its own white product surface. The proxy serves this whole tree at "/…"
// ("/app/…" for the app) on every host. The landing and the blog read the
// marketing catalog; the app and the share pages scope their own.
export default function CutLayout({ children }: { children: ReactNode }) {
  return <IntlScope namespaces={PUBLIC_NAMESPACES}>{children}</IntlScope>;
}
