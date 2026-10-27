import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { NoSessionReplay } from "@/app/_components/NoSessionReplay";
import { SharedLibraryView } from "@/cut/components/SharedLibraryView";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("share.meta");
  return {
    title: t("libraryTitle"),
    robots: { index: false, follow: false },
  };
}

export default function SharedLibraryPage() {
  return <><NoSessionReplay /><Suspense><SharedLibraryView /></Suspense></>;
}
