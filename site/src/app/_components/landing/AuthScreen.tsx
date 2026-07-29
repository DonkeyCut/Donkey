"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useState } from "react";

import { TopNav } from "@/app/_components/landing/TopNav";
import { CutFooter } from "@/app/cut/_components/landing/CutFooter";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

type AuthMode = "sign-in" | "sign-up";

type Props = {
  mode: AuthMode;
};

const copy = {
  "sign-in": {
    alternateHref: "/sign-up",
    alternateLabel: "Create account",
    alternateLead: "New to Donkey?",
    googleAlt: "Sign in with Google",
    googleSrc: "/google/dark-sign-in-with-google.svg",
    googleWidth: 175,
    heading: "Send Donkey back to work.",
    title: "Log in",
  },
  "sign-up": {
    alternateHref: "/sign-in",
    alternateLabel: "Log in",
    alternateLead: "Already have an account?",
    googleAlt: "Sign up with Google",
    googleSrc: "/google/dark-sign-up-with-google.svg",
    googleWidth: 179,
    heading: "Put Donkey to Work",
    title: "Sign up",
  },
} satisfies Record<
  AuthMode,
  {
    alternateHref: string;
    alternateLabel: string;
    alternateLead: string;
    googleAlt: string;
    googleSrc: string;
    googleWidth: number;
    heading: string;
    title: string;
  }
>;

const GOOGLE_BUTTON_HEIGHT = 56;

export function AuthScreen({ mode }: Props) {
  const [isPending, setIsPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const screenCopy = copy[mode];
  const otherMode: AuthMode = mode === "sign-in" ? "sign-up" : "sign-in";

  const handleGoogleAuth = useCallback(async () => {
    const searchParams = new URLSearchParams(window.location.search);
    const callbackURL = searchParams.get("callbackURL") ?? "/app";

    setIsPending(true);
    setStatusMessage(null);

    try {
      await authClient.signIn.social({
        callbackURL,
        // A brand-new account lands on the welcome sequence's own address, so
        // its first paint is the sequence rather than the app home.
        newUserCallbackURL: "/app/onboarding",
        provider: "google",
      });
    } catch {
      setStatusMessage("Google sign-in could not start. Please try again.");
    } finally {
      setIsPending(false);
    }
  }, []);

  const googleButtonWidth = Math.round(
    (screenCopy.googleWidth * GOOGLE_BUTTON_HEIGHT) / 40,
  );

  const formContent = (
    <>
      <button
        type="button"
        aria-label={screenCopy.googleAlt}
        disabled={isPending}
        onClick={handleGoogleAuth}
        className={cn(
          "inline-flex border-none bg-transparent p-0",
          isPending ? "cursor-default opacity-60" : "cursor-pointer",
        )}
      >
        <Image
          src={screenCopy.googleSrc}
          alt={screenCopy.googleAlt}
          width={screenCopy.googleWidth}
          height={40}
          priority
          unoptimized
          className="block h-14"
          style={{ width: googleButtonWidth }}
        />
      </button>
      <p className="mt-[18px] text-sm leading-normal text-[#555]">
        {screenCopy.alternateLead}{" "}
        <Link
          href={screenCopy.alternateHref}
          className="font-semibold text-ink underline underline-offset-[3px]"
        >
          {screenCopy.alternateLabel}
        </Link>
      </p>
      <p className="mt-[18px] text-xs leading-normal text-[#555]">
        By continuing, you agree to the{" "}
        <Link href="/terms" className="font-semibold text-ink">
          Terms of Use
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="font-semibold text-ink">
          Privacy Policy
        </Link>
        .
      </p>
      {statusMessage ? (
        <div
          role="status"
          className="mt-[14px] text-[13px] font-semibold leading-[1.4] text-[#4a403d]"
        >
          {statusMessage}
        </div>
      ) : null}
    </>
  );

  return (
    <main className="min-h-screen w-full bg-background font-system text-ink antialiased">
      {/* Auth serves same-host on donkeycut.com, so the chrome is Cut's. */}
      <TopNav
        wordmark="Donkey Cut"
        authToggle={{
          href: screenCopy.alternateHref,
          label: copy[otherMode].title,
        }}
      />
      <section className="mx-auto grid w-full max-w-[1400px] grid-cols-1 justify-items-center gap-16 px-6 pt-[44px] pb-[240px] text-center min-[900px]:gap-24 min-[900px]:px-12 min-[900px]:pt-[72px] min-[900px]:pb-[360px]">
        <div>
          <h1 className="max-w-[920px] text-[33px] leading-[0.9] font-semibold break-words min-[900px]:text-[69px]">
            {screenCopy.heading}
          </h1>
        </div>

        <div className="flex flex-col items-center justify-self-center text-center">
          {formContent}
        </div>
      </section>
      <CutFooter />
    </main>
  );
}
