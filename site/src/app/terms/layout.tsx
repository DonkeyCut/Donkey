import type { Metadata } from "next";
import type { ReactNode } from "react";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export const metadata: Metadata = {
  alternates: {
    canonical: `${DONKEYCUT_CANONICAL}/terms`,
  },
  description: "Read the Donkey Cut terms of use.",
  title: "Terms of Use | Donkey Cut",
};

type Props = {
  children: ReactNode;
};

export default function TermsLayout({ children }: Props) {
  return children;
}
