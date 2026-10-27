"use client";

import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useState, type ReactNode } from "react";

import { TopNav } from "@/app/_components/landing/TopNav";
import { EmailAuthForm } from "@/app/_components/landing/EmailAuthForm";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

type AuthMode = "sign-in" | "sign-up";

type Props = {
  mode: AuthMode;
  method?: "google" | "email";
  callbackURL?: string;
  // The `?error=` code a failed provider callback brought back here.
  authError?: string;
  // CutFooter reads the blog on the server, so the page hands it in.
  footer: ReactNode;
};

// Each mode's link, Google button art and catalog keys. The words live in the
// `auth.screen` catalog under `copyKey`.
const copy = {
  "sign-in": {
    alternateHref: "/sign-up",
    copyKey: "signIn",
    googleSrc: "/google/dark-sign-in-with-google.svg",
    googleWidth: 175,
  },
  "sign-up": {
    alternateHref: "/sign-in",
    copyKey: "signUp",
    googleSrc: "/google/dark-sign-up-with-google.svg",
    googleWidth: 179,
  },
} as const satisfies Record<
  AuthMode,
  {
    alternateHref: string;
    copyKey: "signIn" | "signUp";
    googleSrc: string;
    googleWidth: number;
  }
>;

const GOOGLE_BUTTON_HEIGHT = 56;

export function AuthScreen({ mode, method = "google", callbackURL, authError, footer }: Props) {
  const t = useTranslations("auth.screen");
  const [isPending, setIsPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(
    authError ? t("callbackFailed") : null,
  );
  const screenCopy = copy[mode];
  const words = {
    alternateLabel: t(`${screenCopy.copyKey}.alternateLabel`),
    alternateLead: t(`${screenCopy.copyKey}.alternateLead`),
    googleAlt: t(`${screenCopy.copyKey}.googleAlt`),
    heading: t(`${screenCopy.copyKey}.heading`),
  };
  const otherMode: AuthMode = mode === "sign-in" ? "sign-up" : "sign-in";
  const alternateParams = new URLSearchParams();
  if (method === "email") alternateParams.set("method", "email");
  if (callbackURL) alternateParams.set("callbackURL", callbackURL);
  const alternateHref = `${screenCopy.alternateHref}${alternateParams.size ? `?${alternateParams}` : ""}`;

  const googleFailed = t("googleFailed");
  const handleGoogleAuth = useCallback(async () => {
    setIsPending(true);
    setStatusMessage(null);

    try {
      await authClient.signIn.social({
        // The streamed shell has no prop yet; its URL still carries the callback.
        callbackURL: callbackURL ?? new URLSearchParams(window.location.search).get("callbackURL") ?? "/app",
        // A brand-new account lands on the welcome sequence's own address, so
        // its first paint is the sequence rather than the app home.
        newUserCallbackURL: "/app/onboarding",
        provider: "google",
      });
    } catch {
      setStatusMessage(googleFailed);
    } finally {
      setIsPending(false);
    }
  }, [callbackURL, googleFailed]);

  const googleButtonWidth = Math.round(
    (screenCopy.googleWidth * GOOGLE_BUTTON_HEIGHT) / 40,
  );

  const formContent = (
    <>
      {method === "email" ? <EmailAuthForm mode={mode} callbackURL={callbackURL} /> : <button
        type="button"
        aria-label={words.googleAlt}
        disabled={isPending}
        onClick={handleGoogleAuth}
        className={cn(
          "inline-flex border-none bg-transparent p-0",
          isPending ? "cursor-default opacity-60" : "cursor-pointer",
        )}
      >
        <Image
          src={screenCopy.googleSrc}
          alt={words.googleAlt}
          width={screenCopy.googleWidth}
          height={40}
          priority
          unoptimized
          className="block h-14"
          style={{ width: googleButtonWidth }}
        />
      </button>}
      <p className="mt-[18px] text-sm leading-normal text-foreground/70">
        {words.alternateLead}{" "}
        <Link
          href={alternateHref}
          className="font-semibold text-foreground underline underline-offset-[3px]"
        >
          {words.alternateLabel}
        </Link>
      </p>
      <p className="mt-[18px] text-xs leading-normal text-foreground/70">
        {t.rich("agreement", {
          terms: (chunks) => (
            <Link href="/terms" className="font-semibold text-foreground">
              {chunks}
            </Link>
          ),
          privacy: (chunks) => (
            <Link href="/privacy" className="font-semibold text-foreground">
              {chunks}
            </Link>
          ),
        })}
      </p>
      {statusMessage ? (
        <div
          role="status"
          className="mt-[14px] text-[13px] font-semibold leading-[1.4] text-foreground"
        >
          {statusMessage}
        </div>
      ) : null}
    </>
  );

  return (
    // Sign-in is a client tree the browser's translator rewrites out from
    // under hydration; the app it leads into is marked the same way.
    <main
      translate="no"
      className="min-h-screen w-full bg-background font-system text-foreground antialiased"
    >
      {/* Auth serves same-host on donkeycut.com, so the chrome is Cut's. */}
      <TopNav
        wordmark="Donkey Cut"
        authToggle={{
          href: alternateHref,
          label: t(`${copy[otherMode].copyKey}.title`),
        }}
      />
      <section className="mx-auto grid w-full max-w-[1400px] grid-cols-1 justify-items-center gap-16 px-6 pt-[44px] pb-[240px] text-center min-[900px]:gap-24 min-[900px]:px-12 min-[900px]:pt-[72px] min-[900px]:pb-[360px]">
        <div>
          <h1 className="max-w-[920px] text-[33px] leading-[0.9] font-semibold break-words min-[900px]:text-[69px]">
            {words.heading}
          </h1>
        </div>

        <div className="flex flex-col items-center justify-self-center text-center">
          {formContent}
        </div>
      </section>
      {footer}
    </main>
  );
}
