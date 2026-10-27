import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AuthPage, type AuthSearchParams } from "@/app/_components/landing/AuthPage";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return {
    title: t("signInTitle"),
    description: t("signInDescription"),
    // Crawlers can follow the public links while keeping login out of search.
    robots: { index: false, follow: true },
  };
}

export const instant = true;

export default function Page({ searchParams }: { searchParams: AuthSearchParams }) {
  return <AuthPage mode="sign-in" searchParams={searchParams} />;
}
