"use client";

// The top bar's subscription surface for cloud projects, one slot with two
// mutually exclusive faces: free accounts see their storage usage (click →
// upgrade dialog); a Pro set to cancel sees the days it has left (click →
// Stripe portal, where Resume lives).
import { Loader2 } from "lucide-react";
import { useCloudUsage, useCutMode } from "@/cut/lib/backend/hooks";
import { openStorageUpgrade } from "@/cut/lib/storageQuota";
import { daysUntil } from "@/cut/lib/time";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useOpenBillingPortal, useProSubscription } from "@/queries/billing";
import { formatBytes } from "./desktopFolders";

const PILL =
  "flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium shadow-xs transition-colors";

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
      <button
        className={cn(PILL, "text-muted-foreground hover:text-foreground")}
        title="Resume your subscription"
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
      </button>
    );
  }

  const u = usage.data;
  if (!u || u.quotaBytes === null) return null;
  const frac = u.bytes / u.quotaBytes;
  return (
    <button
      className={cn(
        PILL,
        frac >= 1
          ? "text-destructive"
          : frac >= 0.8
            ? "text-amber-600 dark:text-amber-500"
            : "text-muted-foreground hover:text-foreground"
      )}
      title="Cloud storage"
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
      {formatBytes(u.bytes)} of {formatBytes(u.quotaBytes)}
    </button>
  );
}
