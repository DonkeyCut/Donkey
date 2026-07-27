"use client";

// The free tier's cloud storage meter, pinned above the account row: how much
// of the quota this account has used, and the one thing that buys more. The
// quota belongs to the account, not to the backend the app happens to be
// running against, so this shows in local mode too — a local editor still has
// cloud projects, and the number is the same either way. Pro accounts see
// nothing here — 50 GB is enough that a meter would only take up room.
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/ui/meter";
import { useCloudUsage } from "@/cut/lib/backend/hooks";
import { useUpgradeToPro } from "@/cut/lib/proUpgrade";
import { cn } from "@/lib/utils";
import { useProSubscription } from "@/queries/billing";
import { formatBytes } from "./desktopFolders";
import { usageLabel } from "./StoragePill";

export function NavStorage() {
  const upgrade = useUpgradeToPro();
  const pro = useProSubscription();
  // The meter has to move as media lands, so this reader polls. Both faces wait
  // on billing, so a Pro account never sees the block flash in front of it.
  const free = pro.data?.isActive === false;
  const usage = useCloudUsage(free, { poll: true });

  if (!free) return null;
  const u = usage.data;
  if (!u || u.quotaBytes === null) return null;

  const frac = u.bytes / u.quotaBytes;
  return (
    <div className="flex flex-col gap-2 px-2 py-3">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">Cloud storage</span>
        <span
          className={cn(
            "tabular-nums",
            frac >= 1
              ? "text-destructive"
              : frac >= 0.8
                ? "text-amber-600 dark:text-amber-500"
                : "text-muted-foreground"
          )}
        >
          {usageLabel(u.bytes, u.quotaBytes)}
        </span>
      </div>
      <Meter
        value={Math.min(u.bytes, u.quotaBytes)}
        max={u.quotaBytes}
        aria-label="Cloud storage used"
        indicatorClassName={
          frac >= 1 ? "bg-destructive" : frac >= 0.8 ? "bg-amber-500" : undefined
        }
      />
      <p className="text-xs leading-snug text-muted-foreground">
        {u.grace
          ? `Your Pro plan ended. Upgrade or free ${formatBytes(u.grace.overBytes)} before your oldest projects are deleted.`
          : "Pro gives you 50 GB of cloud storage."}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        disabled={upgrade.isPending}
        onClick={upgrade.start}
      >
        {upgrade.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
        Upgrade to Pro
      </Button>
    </div>
  );
}
