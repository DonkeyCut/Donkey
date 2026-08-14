"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

import { PillButton } from "@/app/_components/landing/LandingPrimitives";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

const NAV_ICON_SIZE = 59;

type Props = {
  homeHref?: string;
  // Wordmark next to the logo.
  wordmark?: string;
  // Sign-in/up pages show a single toggle to the other mode. Auth otherwise
  // lives on donkeycut.com, so the marketing nav carries no auth entry points.
  authToggle?: { href: string; label: string };
  // Signed-in pill into the product. The Cut landing points it at the Cut
  // projects home, which lives under a different base per host.
  signedInPill?: { href: string; label: string };
  // Signed-out auth cluster: a quiet "Log in" link next to a dominant
  // "Sign up" pill. The Cut landing wires both into the auth screens.
  signedOutAuth?: { logInHref: string; signUpHref: string };
};

export function TopNav({
  homeHref = "/",
  wordmark = "Donkey",
  authToggle,
  signedInPill = { href: "/app", label: "Dashboard" },
  signedOutAuth,
}: Props) {
  // Signed-in visitors don't need the auth links or the download CTA; the whole
  // right cluster collapses to a single white button into the product. During the
  // initial (pending) client render `session` is null, which matches the static
  // server HTML, so the signed-out cluster shows first and swaps in on resolve.
  const { data: session } = authClient.useSession();
  const isSignedIn = Boolean(session);

  // The header is sticky and transparent over the hero; once the page scrolls a
  // little it fades in a translucent backdrop and a hairline divider so the nav
  // stays legible over the content scrolling underneath.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="sticky top-0 z-50 w-full py-3 md:py-4">
      <div
        className={cn(
          "mx-auto flex w-full max-w-[1400px] items-center justify-between rounded-[24px] px-4 py-2 transition-all duration-300 md:px-12 md:py-2.5",
          scrolled
            ? "border border-ink/10 bg-cream/95 shadow-[0_18px_50px_rgba(15,14,13,0.10)] backdrop-blur-md"
            : "border border-transparent bg-transparent shadow-none",
        )}
      >
        <Link
          href={homeHref}
          className="flex items-center gap-1 text-ink no-underline md:gap-3"
        >
          <div className="flex h-[44px] w-[44px] items-center justify-center overflow-hidden rounded-[10px] md:h-[59px] md:w-[59px]">
            <Image
              src="/donkey-logo.svg"
              alt=""
              width={NAV_ICON_SIZE}
              height={NAV_ICON_SIZE}
              sizes={`${NAV_ICON_SIZE}px`}
              className="block h-full w-full object-contain"
              unoptimized
            />
          </div>
          <span className="whitespace-nowrap text-lg font-semibold md:text-2xl">
            {wordmark}
          </span>
        </Link>
        <div className="flex items-center gap-[10px] md:gap-4">
          {isSignedIn ? (
            <PillButton href={signedInPill.href} variant="secondary" size="sm">
              {signedInPill.label}
            </PillButton>
          ) : signedOutAuth ? (
            <>
              {/* Auth pages sit outside the "/" → "/cut" landing rewrite, which
                  App Router soft-navigation can't cross; a plain anchor does the
                  full-page navigation the sign-in route needs. */}
              <a
                href={signedOutAuth.logInHref}
                className="hidden whitespace-nowrap text-sm font-semibold text-ink no-underline sm:inline"
              >
                Log in
              </a>
              <PillButton
                href={signedOutAuth.signUpHref}
                variant="primary"
                size="sm"
              >
                Sign up
              </PillButton>
            </>
          ) : authToggle ? (
            <Link
              href={authToggle.href}
              className="whitespace-nowrap text-sm font-semibold text-ink no-underline"
            >
              {authToggle.label}
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}
