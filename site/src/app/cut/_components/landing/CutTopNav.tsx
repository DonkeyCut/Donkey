"use client";

import { TopNav } from "@/app/_components/landing/TopNav";
import { authHrefFor } from "@/app/_components/landing/useAppEntryHref";

// The donkeycut.com site nav: Donkey Cut wordmark with session-aware auth
// entries. Shared by the Cut landing and the pass-through pages (e.g.
// /install).
export function CutTopNav() {
  return (
    <TopNav
      homeHref="/"
      wordmark="Donkey Cut"
      signedInPill={{ href: "/app", label: "Go to App" }}
      signedOutAuth={{
        logInHref: authHrefFor("/sign-in", "/app"),
        signUpHref: authHrefFor("/sign-up", "/app"),
      }}
    />
  );
}
