import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AuthPage, type AuthSearchParams } from "@/app/_components/landing/AuthPage";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return {
    title: t("signUpTitle"),
    description: t("signUpDescription"),
    // Crawlers can follow the public links while keeping signup out of search.
    robots: { index: false, follow: true },
  };
}

export const instant = true;

export default function Page({ searchParams }: { searchParams: AuthSearchParams }) {
  return <AuthPage mode="sign-up" searchParams={searchParams} />;
}
