import type { Metadata } from "next";

import { AuthPage, type AuthSearchParams } from "@/app/_components/landing/AuthPage";

export const metadata: Metadata = {
  title: "Sign up | Donkey",
  description: "Create a Donkey Cut account.",
};

export const instant = true;

export default function Page({ searchParams }: { searchParams: AuthSearchParams }) {
  return <AuthPage mode="sign-up" searchParams={searchParams} />;
}
