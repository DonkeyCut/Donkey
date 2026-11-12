"use client";

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useCloudUsage } from "@/cut/lib/backend/hooks";
import { useCutBase } from "@/cut/lib/nav";
import { checkoutErrorCode } from "@/cut/lib/proUpgrade";
import { daysUntil } from "@/cut/lib/time";
import { track } from "@/lib/analytics";
import { formatBytes } from "@/lib/bytes";
import { useStartCheckout } from "@/queries/billing";

/** After a Pro plan ends, an over-cap account has a countdown before the daily
 * sweep reclaims its oldest projects. Say so where the projects are. */
export function GraceBanner({ enabled }: { enabled: boolean }) {
  const t = useTranslations("home.projects");
  const locale = useLocale();
  // A deletion deadline moves once a day; one read per visit is plenty.
  const usage = useCloudUsage(enabled, { poll: false });
  const checkout = useStartCheckout();
  const base = useCutBase();
  const grace = usage.data?.grace;
  const shown = useRef(false);
  useEffect(() => {
    if (grace && !shown.current) {
      shown.current = true;
      track("cut_grace_banner_shown");
    }
  }, [grace]);
  if (!grace) return null;
  const days = daysUntil(grace.deadline);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="text-destructive">
        {t("grace", { days, size: formatBytes(grace.overBytes, locale) })}
      </span>
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0"
        disabled={checkout.isPending}
        onClick={async () => {
          track("pro_checkout_started", { plan: "pro", surface: "grace_banner" });
          try {
            const { url } = await checkout.mutateAsync();
            window.location.assign(url);
          } catch (error) {
            track("pro_checkout_failed", { plan: "pro", error: checkoutErrorCode(error), surface: "grace_banner" });
            window.location.assign(`${base}/settings`);
          }
        }}
      >
        {t("upgradeToPro")}
      </Button>
    </div>
  );
}
