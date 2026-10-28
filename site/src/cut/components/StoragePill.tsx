"use client";

// The top bar's subscription surface for cloud projects, one slot with two
// mutually exclusive faces: free accounts see their storage usage (click →
// upgrade dialog); a Pro set to cancel sees the days it has left once fewer
// than the `proEndingNotice` days remain (click → Stripe portal, where Resume
// lives).
import { type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCloudUsage, useCutMode } from "@/cut/lib/backend/hooks";
import { openStorageUpgrade } from "@/cut/lib/storageQuota";
import { daysUntil } from "@/cut/lib/time";
import { track } from "@/lib/analytics";
import { SETTINGS } from "@/lib/config/registry";
import { cn } from "@/lib/utils";
import { useAccountConfig } from "@/queries/accountConfig";
import { useOpenBillingPortal, useProSubscription } from "@/queries/billing";
import { formatBytes } from "@/lib/bytes";
import type { Locale } from "@/i18n/locales";

const PILL =
  "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium shadow-xs transition-colors";

/** "278 / 250 MB" — the pill sits in a crowded top bar, so a unit is spelled
 * out only where it carries information: repeat it just when the two numbers
 * land on different ones ("1.2 GB / 250 MB"). */
export function usageLabel(bytes: number, quotaBytes: number, locale: Locale): string {
  const used = formatBytes(bytes, locale);
  const cap = formatBytes(quotaBytes, locale);
  const unit = cap.slice(cap.lastIndexOf(" ") + 1);
  const short = used.endsWith(` ${unit}`) ? used.slice(0, -(unit.length + 1)) : used;
  return `${short} / ${cap}`;
}

export function StoragePill() {
  const mode = useCutMode();
  if (mode !== "cloud") return null;
  return <CloudStoragePill />;
}

function CloudStoragePill() {
  const t = useTranslations("billing.storagePill");
  const locale = useLocale();
  const pro = useProSubscription();
  // Free and Plus have quotas small enough to fill, so they carry the meter.
  const metered = pro.data !== undefined && (pro.data.plan === null || pro.data.plan === "plus");
  // The meter has to move as media lands, so this reader is the polling one.
  const usage = useCloudUsage(metered, { poll: true });
  const portal = useOpenBillingPortal();
  const config = useAccountConfig({ enabled: true });

  if (!pro.data) return null;

  // A plan set to cancel counts down its last days in place of the meter.
  const end = pro.data.isActive ? pro.data.endsAt : null;
  const days = end ? daysUntil(end) : null;
  // The config read can fail without taking the pill with it: the registry
  // default stands in until an override arrives.
  const daysBefore =
    config.data?.settings.proEndingNotice.daysBefore ?? SETTINGS.proEndingNotice.default.daysBefore;
  if (days !== null && days < daysBefore) {
    return (
      <PillTooltip message={t("cancelTooltip")}>
        <TooltipTrigger
          className={cn(PILL, "text-muted-foreground hover:bg-muted hover:text-foreground")}
          disabled={portal.isPending}
          onClick={async () => {
            track("billing_portal_opened");
            try {
              const { url } = await portal.mutateAsync();
              window.location.assign(url);
            } catch {
              // Portal unavailable — leave the pill as-is.
            }
          }}
        >
          {portal.isPending && <Loader2 className="size-3 animate-spin" />}
          {t("ends", { days })}
        </TooltipTrigger>
      </PillTooltip>
    );
  }

  if (!metered) return null;
  const u = usage.data;
  if (!u || u.quotaBytes === null) return null;
  const frac = u.bytes / u.quotaBytes;
  // The pill only has room for the numbers, so hovering says what they mean —
  // an over-quota account has to learn that uploads are being turned away, and
  // that it is fixable, without clicking first.
  const message = u.grace
    ? t("graceTooltip")
    : frac >= 1
      ? t("fullTooltip")
      : t("usedTooltip", { used: formatBytes(u.bytes, locale), quota: formatBytes(u.quotaBytes, locale) });
  return (
    <PillTooltip message={message}>
      <TooltipTrigger
        className={cn(
          PILL,
          frac >= 1
            ? "text-destructive hover:bg-destructive/10"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
        onClick={() => {
          track("cut_storage_pill_clicked");
          openStorageUpgrade({
            bytes: u.bytes,
            quotaBytes: u.quotaBytes ?? undefined,
            source: "pill",
            grace: u.grace,
          });
        }}
      >
        {usageLabel(u.bytes, u.quotaBytes, locale)}
      </TooltipTrigger>
    </PillTooltip>
  );
}

// The top bar has no provider of its own, so each pill brings one.
function PillTooltip({ message, children }: { message: string; children: ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        {children}
        <TooltipContent className="max-w-56 text-center">{message}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
