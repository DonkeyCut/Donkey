"use client";

// The cloud storage row for free and Plus accounts, pinned above the account row: how much
// of the quota this account has used, and the one thing that buys more. The
// quota belongs to the account, not to the backend the app happens to be
// running against, so this shows in local mode too — a local editor still has
// cloud projects, and the number is the same either way. Pro and Max see
// nothing here; their storage leaves the meter little to say.
import { Cloud } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCloudUsage } from "@/cut/lib/backend/hooks";
import { openUpgrade } from "@/cut/lib/upgrade";
import { cn } from "@/lib/utils";
import { useProSubscription } from "@/queries/billing";
import { formatBytes } from "@/lib/bytes";
import { usageLabel } from "./StoragePill";

export function NavStorage() {
  const t = useTranslations("home.navStorage");
  const locale = useLocale();
  const pro = useProSubscription();
  // The meter has to move as media lands, so this reader polls. Both faces wait
  // on billing, so a paying account never sees the block flash in front of it.
  // Free and Plus have quotas small enough to fill.
  const metered = pro.data !== undefined && (pro.data.plan === null || pro.data.plan === "plus");
  const usage = useCloudUsage(metered, { poll: true });

  if (!metered) return null;
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
                onClick={() => openUpgrade("plans")}
              />
            }
          >
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Cloud className="size-4" />
              <span className={cn("tabular-nums whitespace-nowrap", frac >= 1 && "text-destructive")}>
                {usageLabel(u.bytes, u.quotaBytes, locale)}
              </span>
            </span>
            <span className="whitespace-nowrap group-hover:underline">
              {t("upgrade")}
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("upgradeTip")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {u.grace && (
        <p className="px-2 pt-1 text-xs leading-snug text-muted-foreground">
          {t("grace", { size: formatBytes(u.grace.overBytes, locale) })}
        </p>
      )}
    </div>
  );
}
