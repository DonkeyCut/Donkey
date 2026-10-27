"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

// One button between the email link and the unsubscribe, posting to the same
// endpoint mail providers use for one-click.
export function UnsubscribeConfirm({ token }: { token: string }) {
  const t = useTranslations("legal.unsubscribe");
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
      <p>{t("done")}</p>
    );
  }

  return (
    <>
      <p>{t("prompt")}</p>
      <button
        type="button"
        onClick={unsubscribe}
        disabled={state === "pending"}
        className="cursor-pointer rounded-lg bg-[#0F0E0D] px-6 py-3 text-sm font-semibold text-[#F5EFE0] disabled:opacity-60"
      >
        {t("button")}
      </button>
      {state === "error" && (
        <p className="text-red-600">{t("failed")}</p>
      )}
    </>
  );
}
