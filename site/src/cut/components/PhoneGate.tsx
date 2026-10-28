"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";

import { DonkeyMark } from "@/components/DonkeyMark";
import { useEnvironment, useFormFactor } from "@/cut/lib/environment";
import { useCutBase } from "@/cut/lib/nav";
import { track } from "@/lib/analytics";

// The editor needs a computer. A phone that reaches the app past the welcome
// sequence gets this page in its place, and the app underneath never mounts,
// so the phone decodes and draws nothing it can't use. Settings stays open:
// the trip back from a plan's checkout lands there. The ChatGPT card is its own
// surface and keeps the editor wherever it runs.
export function PhoneGate({ children }: { children: ReactNode }) {
  const phone = useFormFactor() === "phone";
  const { chatgpt } = useEnvironment();
  const base = useCutBase();
  const pathname = usePathname();
  const gated = phone && !chatgpt && !pathname.includes(`${base}/settings`);

  useEffect(() => {
    if (!gated) {
      return;
    }
    track("phone_gate_shown");
  }, [gated]);

  if (!gated) {
    return children;
  }
  return <PhonePage />;
}

function PhonePage() {
  const t = useTranslations("onboarding.phoneGate");
  return (
    <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-6 bg-cream px-6 text-center font-system text-foreground antialiased dark:bg-background">
      <span className="flex size-[59px] items-center justify-center overflow-hidden rounded-[10px]">
        <DonkeyMark alt="" />
      </span>
      <div className="max-w-[360px]">
        <h1 className="text-[26px] leading-[1.15] font-semibold tracking-[-0.02em] text-balance">
          {t("title")}
        </h1>
        <p className="mt-3 text-[16px] leading-[1.55] text-foreground/70">
          {t("body")}
        </p>
      </div>
    </div>
  );
}
