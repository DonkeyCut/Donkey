import type { Metadata } from "next";

import { AuthScreen } from "@/app/_components/landing/AuthScreen";

export const metadata: Metadata = {
  title: "Sign up | Donkey",
  description: "Create a Donkey account with Google.",
};

export const unstable_instant = { prefetch: "static" };

export default function Page() {
  return <AuthScreen mode="sign-up" />;
}
