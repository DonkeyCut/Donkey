"use client";

import { useState } from "react";

// One button between the email link and the unsubscribe, posting to the same
// endpoint mail providers use for one-click.
export function UnsubscribeConfirm({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">(
    "idle",
  );

  const unsubscribe = async () => {
    setState("pending");
    const response = await fetch(
      `/api/email/unsubscribe?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    setState(response.ok ? "done" : "error");
  };

  if (state === "done") {
    return (
      <p>
        You&apos;re unsubscribed from product emails. You can turn them back on
        any time from Settings in the app.
      </p>
    );
  }

  return (
    <>
      <p>
        Stop receiving product news and announcements from Donkey Cut? Emails
        about your account, like billing and security, keep arriving either way.
      </p>
      <button
        type="button"
        onClick={unsubscribe}
        disabled={state === "pending"}
        className="cursor-pointer rounded-lg bg-[#0F0E0D] px-6 py-3 text-sm font-semibold text-[#F5EFE0] disabled:opacity-60"
      >
        Unsubscribe
      </button>
      {state === "error" && (
        <p className="text-red-600">That didn&apos;t go through — try again.</p>
      )}
    </>
  );
}
