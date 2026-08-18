import type { Metadata } from "next";

import { AuthScreen } from "@/app/_components/landing/AuthScreen";

export const metadata: Metadata = {
  title: "Log in | Donkey",
  description: "Log in to Donkey with Google.",
};

export const unstable_instant = { prefetch: "static" };

export default function Page() {
  return <AuthScreen mode="sign-in" />;
}
