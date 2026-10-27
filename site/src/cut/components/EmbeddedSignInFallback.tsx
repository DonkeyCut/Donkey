"use client";

import { useTranslations } from "next-intl";

import { reconnectThroughHost, useHostReady } from "@/cut/lib/hostBridge";

export function EmbeddedSignInFallback() {
  const t = useTranslations("editor.embeddedSignIn");
  useHostReady(true);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-background p-6 text-center">
      <div className="max-w-sm space-y-3">
        <p className="text-sm text-muted-foreground">{t("message")}</p>
        <button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={reconnectThroughHost}>
          {t("reconnect")}
        </button>
      </div>
    </div>
  );
}
