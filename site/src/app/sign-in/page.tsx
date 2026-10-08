import type { Metadata } from "next";

import { AuthPage, type AuthSearchParams } from "@/app/_components/landing/AuthPage";

export const metadata: Metadata = {
  title: "Log in | Donkey",
  description: "Log in to Donkey Cut.",
  // Crawlers can follow the public links while keeping login out of search.
  robots: { index: false, follow: true },
};

export const instant = true;

export default function Page({ searchParams }: { searchParams: AuthSearchParams }) {
  return <AuthPage mode="sign-in" searchParams={searchParams} />;
}
