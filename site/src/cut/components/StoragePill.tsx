"use client";

// The top bar's subscription surface for cloud projects, one slot with two
// mutually exclusive faces: free accounts see their storage usage (click →
// upgrade dialog); a Pro set to cancel sees the days it has left (click →
// Stripe portal, where Resume lives).
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { useOpenBillingPortal, useProSubscription } from "@/queries/billing";
import { formatBytes } from "./desktopFolders";

const PILL =
  "flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium shadow-xs transition-colors";

/** "278 / 250 MB" — the pill sits in a crowded top bar, so a unit is spelled
 * out only where it carries information: repeat it just when the two numbers
 * land on different ones ("1.2 GB / 250 MB"). */
function usageLabel(bytes: number, quotaBytes: number): string {
  const used = formatBytes(bytes);
  const cap = formatBytes(quotaBytes);
  const unit = cap.slice(cap.lastIndexOf(" ") + 1);
  const short = used.endsWith(` ${unit}`) ? used.slice(0, -(unit.length + 1)) : used;
  return `${short} / ${cap}`;
}

export function StoragePill() {
  const cloud = useCutMode() === "cloud";
  if (!cloud) return null;
  return <CloudStoragePill />;
}

function CloudStoragePill() {
  const pro = useProSubscription();
  // The meter has to move as media lands, so this reader is the polling one.
  const usage = useCloudUsage(pro.data?.isActive === false, { poll: true });
  const portal = useOpenBillingPortal();

  if (!pro.data) return null;

  if (pro.data.isActive) {
    const end = pro.data.cancelAtPeriodEnd ? pro.data.currentPeriodEnd : null;
    if (!end) return null;
    const days = daysUntil(end);
    return (
      <PillTooltip message="Your Pro plan is set to cancel. Resume it to keep your cloud storage.">
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
          Pro · {days === 0 ? "ends today" : `ends in ${days} day${days === 1 ? "" : "s"}`}
        </TooltipTrigger>
      </PillTooltip>
    );
  }

  const u = usage.data;
  if (!u || u.quotaBytes === null) return null;
  const frac = u.bytes / u.quotaBytes;
  // The pill only has room for the numbers, so hovering says what they mean —
  // an over-quota account has to learn that uploads are being turned away, and
  // that it is fixable, without clicking first.
  const message = u.grace
    ? "Your Pro plan ended and you're over the free limit. Upgrade or free up space before your oldest projects are deleted."
    : frac >= 1
      ? "You've run out of cloud storage. Upgrade or free up space to keep uploading."
      : frac >= 0.8
        ? "Cloud storage is almost full. Upgrade or free up space."
        : `${formatBytes(u.bytes)} of ${formatBytes(u.quotaBytes)} of cloud storage used.`;
  return (
    <PillTooltip message={message}>
      <TooltipTrigger
        className={cn(
          PILL,
          frac >= 1
            ? "text-destructive hover:bg-destructive/10"
            : frac >= 0.8
              ? "text-amber-600 hover:bg-amber-500/10 dark:text-amber-500"
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
        {usageLabel(u.bytes, u.quotaBytes)}
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
