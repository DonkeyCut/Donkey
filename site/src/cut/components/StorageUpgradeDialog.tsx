"use client";

// The storage-quota wall's face: opens when an upload is rejected for space
// anywhere in the app, or when the top bar's pill is clicked, and sells the
// Pro storage tier — or just explains, when the account already has it.
import { useEffect, useState } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OfferButton, OfferDialog, OfferDismiss } from "./OfferDialog";
import { useUpgradeToPro } from "@/cut/lib/proUpgrade";
import {
  clearStorageQuotaWall,
  emitStorageQuota,
  onStorageQuota,
  type StorageQuotaDetail,
} from "@/cut/lib/storageQuota";
import { daysUntil } from "@/cut/lib/time";
import { track } from "@/lib/analytics";
import { useProSubscription } from "@/queries/billing";
import { useCloudUsage } from "@/cut/lib/backend/hooks";
import { onOperationFailure } from "@/cut/lib/operationFailure";
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

  useEffect(() => onOperationFailure((failure) => {
    if (failure.code === "storage_quota_exceeded")
      emitStorageQuota({ ...failure, source: "quota-413" });
  }), []);

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
  // A wall raised by a queued render carries no numbers — it failed in the
  // worker, hours from the request. The account's own meter fills them in, so
  // every wall says how full the account is.
  const usage = useCloudUsage(true);
  const bytes = detail.bytes ?? usage.data?.bytes;
  const quotaBytes = detail.quotaBytes ?? usage.data?.quotaBytes ?? undefined;

  const used =
    bytes !== undefined && quotaBytes !== undefined
      ? `You've used ${formatBytes(bytes)} of ${formatBytes(quotaBytes)}.`
      : null;
  const title = detail.source === "pill" ? "Cloud storage" : "Cloud storage is full";
  const graceDays = detail.grace ? daysUntil(detail.grace.deadline) : null;
  const grace =
    detail.grace && graceDays !== null
      ? `Your Pro plan ended. Your oldest cloud projects will be deleted ${
          graceDays === 0 ? "today" : `in ${graceDays} day${graceDays === 1 ? "" : "s"}`
        } unless you upgrade or free ${formatBytes(detail.grace.overBytes)}.`
      : null;

  // An account that already has Pro is being told something, not sold
  // something: the offer card's picture and its full-width buy button belong
  // to the upgrade, so the plain dialog carries this one.
  if (isPro) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            {used && <p>{used}</p>}
            <p>Free up space by deleting projects or media you no longer need.</p>
          </div>
          <DialogFooter className="mt-2">
            <Button className="w-full" onClick={onClose}>
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <OfferDialog
      open
      onOpenChange={(open) => !open && onClose()}
      // Neutral, and half the height of a credit offer's picture: this card is
      // a wall, not a promotion.
      banner={
        <div className="flex aspect-[16/3] w-full items-center bg-neutral-800 px-6 dark:bg-neutral-700">
          <HardDrive className="size-7 text-white" strokeWidth={1.5} />
        </div>
      }
      title={title}
      body={`${used ? `${used} ` : ""}Pro includes 100 GB of cloud storage.`}
      terms="Or free up space by deleting projects and media you no longer need."
      error={grace}
      cta={
        <OfferButton disabled={upgrade.isPending} onClick={upgrade.start}>
          {upgrade.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
          Upgrade to Pro
        </OfferButton>
      }
      secondary={<OfferDismiss onClick={onClose}>Not now</OfferDismiss>}
    />
  );
}
