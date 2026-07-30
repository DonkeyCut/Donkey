"use client";

// The free tier's cloud storage row, pinned above the account row: how much
// of the quota this account has used, and the one thing that buys more. The
// quota belongs to the account, not to the backend the app happens to be
// running against, so this shows in local mode too — a local editor still has
// cloud projects, and the number is the same either way. Pro accounts see
// nothing here — 100 GB is enough that a meter would only take up room.
import { Cloud, Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
    <div className="mb-2 flex flex-col border-b pb-2">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="group flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-2 text-xs transition-colors hover:bg-muted disabled:opacity-50"
                disabled={upgrade.isPending}
                onClick={upgrade.start}
              />
            }
          >
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Cloud className="size-4" />
              <span className={cn("tabular-nums", frac >= 1 && "text-destructive")}>
                {usageLabel(u.bytes, u.quotaBytes)}
              </span>
            </span>
            <span className="flex items-center gap-1.5 group-hover:underline">
              {upgrade.isPending && <Loader2 className="size-3 animate-spin" />}
              Get 100 GB
            </span>
          </TooltipTrigger>
          <TooltipContent>Upgrade for 100 GB + AI credits</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {u.grace && (
        <p className="px-2 pt-1 text-xs leading-snug text-muted-foreground">
          {`Your Pro plan ended. Upgrade or free ${formatBytes(u.grace.overBytes)} before your oldest projects are deleted.`}
        </p>
      )}
    </div>
  );
}
