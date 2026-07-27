import type { Metadata } from "next";
import type { ReactNode } from "react";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export const metadata: Metadata = {
  alternates: {
    canonical: `${DONKEYCUT_CANONICAL}/privacy`,
  },
  description: "Read the Donkey Cut privacy policy.",
  title: "Privacy Policy | Donkey Cut",
};

type Props = {
  children: ReactNode;
};

export default function PrivacyLayout({ children }: Props) {
  return children;
}
