import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal.privacyMeta");
  return {
    alternates: {
      canonical: `${DONKEYCUT_CANONICAL}/privacy`,
    },
    description: t("description"),
    title: t("title"),
  };
}

type Props = {
  children: ReactNode;
};

export default function PrivacyLayout({ children }: Props) {
  return children;
}
