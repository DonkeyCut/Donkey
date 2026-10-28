"use client";

// The storage-quota wall's face: opens when an upload is rejected for space
// anywhere in the app, or when the top bar's pill is clicked, and lays out the
// plans with more room — or just explains, on the plan with the most.
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PlansDialog } from "./PlansDialog";
import {
  clearStorageQuotaWall,
  emitStorageQuota,
  onStorageQuota,
  type StorageQuotaDetail,
} from "@/cut/lib/storageQuota";
import { daysUntil } from "@/cut/lib/time";
import { track } from "@/lib/analytics";
import { PAID_PLANS } from "@/lib/billing/plans";
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
  const t = useTranslations("billing");
  const locale = useLocale();
  const subscription = useProSubscription();
  const onTopPlan = subscription.data?.plan === PAID_PLANS[PAID_PLANS.length - 1];
  // A wall raised by a queued render carries no numbers — it failed in the
  // worker, hours from the request. The account's own meter fills them in, so
  // every wall says how full the account is.
  const usage = useCloudUsage(true);
  const bytes = detail.bytes ?? usage.data?.bytes;
  const quotaBytes = detail.quotaBytes ?? usage.data?.quotaBytes ?? undefined;

  const meter =
    bytes !== undefined && quotaBytes !== undefined
      ? { used: formatBytes(bytes, locale), quota: formatBytes(quotaBytes, locale) }
      : null;
  const used = meter ? t("storage.used", meter) : null;
  const title = detail.source === "pill" ? t("storage.title") : t("storage.fullTitle");
  const graceDays = detail.grace ? daysUntil(detail.grace.deadline) : null;
  const grace =
    detail.grace && graceDays !== null
      ? graceDays === 0
        ? t("storage.graceToday", { bytes: formatBytes(detail.grace.overBytes, locale) })
        : t("storage.graceDays", { bytes: formatBytes(detail.grace.overBytes, locale), days: graceDays })
      : null;

  // An account on the plan with the most room is being told something, not
  // sold something, so the plain dialog carries this one.
  if (!subscription.data) return null;
  if (onTopPlan) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            {used && <p>{used}</p>}
            <p>{t("storage.proBody")}</p>
          </div>
          <DialogFooter className="mt-2">
            <Button className="w-full" onClick={onClose}>
              {t("ok")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <PlansDialog
      source="storage"
      title={detail.source === "pill" ? t("storage.moreTitle") : t("storage.fullTitle")}
      body={used}
      notice={grace}
      onClose={onClose}
    />
  );
}
