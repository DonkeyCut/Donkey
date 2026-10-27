"use client";

import { useTranslations } from "next-intl";

import { TopNav } from "@/app/_components/landing/TopNav";
import { authHrefFor } from "@/app/_components/landing/useAppEntryHref";

// The donkeycut.com site nav: Donkey Cut wordmark with session-aware auth
// entries. Shared by the Cut landing and the pass-through pages (e.g.
// /install).
export function CutTopNav() {
  const t = useTranslations("landing.nav");

  return (
    <TopNav
      homeHref="/"
      wordmark="Donkey Cut"
      signedInPill={{ href: "/app", label: t("goToApp") }}
      signedOutAuth={{
        logInHref: authHrefFor("/sign-in", "/app"),
        signUpHref: authHrefFor("/sign-up", "/app"),
      }}
    />
  );
}
