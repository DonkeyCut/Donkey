"use client";

import { useState } from "react";

import { CUT_APP_BASE } from "@/cut/lib/appBase";
import { authClient } from "@/lib/auth-client";
import { formatCreditExpiry } from "@/lib/credits/top-up";

type Props = {
  claimed: boolean;
  credits: string;
  lifetime: string | null;
  token: string;
};

// One button between the email link and the credit. Claiming needs the
// offered account's session; without one the button goes to sign-in and
// comes back here.
export function ClaimCredits({ claimed, credits, lifetime, token }: Props) {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "pending" }
    | { kind: "done"; expiresAt: string | null }
    | { kind: "error"; message: string }
  >(claimed ? { kind: "done", expiresAt: null } : { kind: "idle" });

  const claim = async () => {
    setState({ kind: "pending" });
    const response = await fetch("/api/credits/offers/claim", {
      body: JSON.stringify({ token }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (response.status === 403) {
      setState({
        kind: "error",
        message: "This offer belongs to a different account. Sign in with the address the email was sent to.",
      });
      return;
    }
    if (!response.ok) {
      setState({ kind: "error", message: "That didn't go through. Try again." });
      return;
    }
    const body = (await response.json()) as { expiresAt: string | null };
    setState({ kind: "done", expiresAt: body.expiresAt });
  };

  if (state.kind === "done") {
    return (
      <>
        <p>
          {credits} in AI credits is on your account.
          {state.expiresAt ? ` It expires ${formatCreditExpiry(new Date(state.expiresAt))}.` : ""}
        </p>
        <a
          href={CUT_APP_BASE}
          className="inline-block rounded-lg bg-[#0F0E0D] px-6 py-3 text-sm font-semibold text-[#F5EFE0] no-underline"
        >
          Open the editor
        </a>
      </>
    );
  }

  const here = `/claim?token=${encodeURIComponent(token)}`;
  return (
    <>
      <p>
        {credits} in AI credits is waiting for you.
        {lifetime ? ` Once claimed, it is good for ${lifetime}.` : ""}
      </p>
      {session ? (
        <button
          type="button"
          onClick={claim}
          disabled={state.kind === "pending"}
          className="cursor-pointer rounded-lg bg-[#0F0E0D] px-6 py-3 text-sm font-semibold text-[#F5EFE0] disabled:opacity-60"
        >
          Claim {credits}
        </button>
      ) : (
        <a
          href={`/sign-in?callbackURL=${encodeURIComponent(here)}`}
          aria-disabled={sessionPending}
          className="inline-block rounded-lg bg-[#0F0E0D] px-6 py-3 text-sm font-semibold text-[#F5EFE0] no-underline"
        >
          Sign in to claim
        </a>
      )}
      {state.kind === "error" && <p className="text-red-600">{state.message}</p>}
    </>
  );
}
