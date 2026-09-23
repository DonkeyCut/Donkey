import type { Metadata } from "next";

import { AuthPage, type AuthSearchParams } from "@/app/_components/landing/AuthPage";

export const metadata: Metadata = {
  title: "Log in | Donkey",
  description: "Log in to Donkey Cut.",
};

export const instant = true;

export default function Page({ searchParams }: { searchParams: AuthSearchParams }) {
  return <AuthPage mode="sign-in" searchParams={searchParams} />;
}
