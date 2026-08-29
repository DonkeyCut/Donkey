"use client";

// The storage-quota wall's face: opens when an upload is rejected for space
// anywhere in the app, or when the top bar's pill is clicked, and sells the
// Pro storage tier — or just explains, when the account already has it.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpgradeToPro } from "@/cut/lib/proUpgrade";
import {
  clearStorageQuotaWall,
  onStorageQuota,
  type StorageQuotaDetail,
} from "@/cut/lib/storageQuota";
import { daysUntil } from "@/cut/lib/time";
import { track } from "@/lib/analytics";
import { useProSubscription } from "@/queries/billing";
import { formatBytes } from "@/lib/bytes";

export function StorageUpgradeDialog() {
  const [detail, setDetail] = useState<StorageQuotaDetail | null>(null);

  useEffect(
    () =>
      onStorageQuota((d) => {
        setDetail(d);
        track("cut_storage_upgrade_shown", { source: d.source });
      }),
    []
  );

  const close = () => {
    setDetail(null);
    clearStorageQuotaWall();
  };

  if (!detail) return null;
  return <OpenDialog detail={detail} onClose={close} />;
}

// Split so the billing query only runs while the dialog is up.
function OpenDialog({ detail, onClose }: { detail: StorageQuotaDetail; onClose: () => void }) {
  const pro = useProSubscription();
  const upgrade = useUpgradeToPro();
  const isPro = pro.data?.isActive === true;

  const used =
    detail.bytes !== undefined && detail.quotaBytes !== undefined
      ? `You've used ${formatBytes(detail.bytes)} of ${formatBytes(detail.quotaBytes)}.`
      : null;
  const graceDays = detail.grace ? daysUntil(detail.grace.deadline) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {detail.source === "quota-413" ? "Cloud storage is full" : "Cloud storage"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          {used && <p>{used}</p>}
          {detail.grace && graceDays !== null && (
            <p className="text-destructive">
              Your Pro plan ended. Your oldest cloud projects will be deleted{" "}
              {graceDays === 0 ? "today" : `in ${graceDays} day${graceDays === 1 ? "" : "s"}`}{" "}
              unless you upgrade or free {formatBytes(detail.grace.overBytes)}.
            </p>
          )}
          <p>
            {isPro
              ? "Free up space by deleting projects or media you no longer need."
              : "Pro includes 100 GB of cloud storage, or free up space by deleting media."}
          </p>
        </div>
        <DialogFooter className="mt-2">
          {isPro ? (
            <Button className="w-full" onClick={onClose}>
              OK
            </Button>
          ) : (
            <div className="flex w-full flex-col gap-2">
              <Button className="w-full" disabled={upgrade.isPending} onClick={upgrade.start}>
                {upgrade.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
                Upgrade to Pro
              </Button>
              <Button variant="ghost" className="w-full" onClick={onClose}>
                Not now
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
