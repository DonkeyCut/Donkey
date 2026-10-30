"use client";

// The storage-quota wall's face: opens when an upload is rejected for space
// anywhere in the app, when a drop won't fit, or when the top bar's pill is
// clicked, and lays out the plans with more room — or just explains, on the
// plan with the most. In the editor on a cloud project it also offers to move
// the project to this computer, where cloud storage doesn't limit it.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
import type { UpgradeEntry } from "@/cut/lib/upgrade";
import { track } from "@/lib/analytics";
import { PAID_PLANS } from "@/lib/billing/plans";
import { useProSubscription } from "@/queries/billing";
import { supportsBrowserStore } from "@/cut/lib/backend/browser/opfs";
import { useCloudUsage, useCutMode, useLocalCompute } from "@/cut/lib/backend/hooks";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { onOperationFailure } from "@/cut/lib/operationFailure";
import { moveOpenProject } from "@/cut/lib/projectMove";
import type { Residency } from "@/cut/lib/residency";
import { useEditor } from "@/cut/lib/store";
import { useDescribeError } from "@/i18n/describeError";
import { formatBytes } from "@/lib/bytes";

// What raised the storage wall, as the plans name where they were met.
const STORAGE_ENTRY: Record<StorageQuotaDetail["source"], UpgradeEntry> = {
  "quota-413": "storage_refused",
  import: "storage_import",
  render: "render_refused",
  pill: "storage_pill",
};

// Where the wall is mounted: the editor, which can move its open project off
// the cloud, or the projects home, which has no project open.
type WallSurface = "editor" | "home";

export function StorageUpgradeDialog({ surface = "home" }: { surface?: WallSurface }) {
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
  return <OpenDialog detail={detail} surface={surface} onClose={close} />;
}

// Split so the billing query only runs while the dialog is up.
function OpenDialog({
  detail,
  surface,
  onClose,
}: {
  detail: StorageQuotaDetail;
  surface: WallSurface;
  onClose: () => void;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const subscription = useProSubscription();
  const move = useMoveOffCloud(surface);
  // A move under way finishes on the project it lands; the wall stays up
  // until then.
  const leave = () => {
    if (!move?.moving) onClose();
  };
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
  // A drop checked before its upload says what it needs and what is free.
  const need =
    detail.needBytes !== undefined && bytes !== undefined && quotaBytes !== undefined
      ? t("storage.importNeed", {
          need: formatBytes(detail.needBytes, locale),
          free: formatBytes(Math.max(0, quotaBytes - bytes), locale),
          quota: formatBytes(quotaBytes, locale),
        })
      : null;
  const used = need ?? (meter ? t("storage.used", meter) : null);
  const title =
    detail.source === "pill"
      ? t("storage.title")
      : detail.source === "import"
        ? t("storage.importTitle")
        : t("storage.fullTitle");
  const fullTitle = detail.source === "import" ? t("storage.importTitle") : t("storage.fullTitle");
  const keepLocal = move ? <KeepLocal move={move} /> : null;
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
      <Dialog open onOpenChange={(open) => !open && leave()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            {used && <p>{used}</p>}
            <p>{t("storage.proBody")}</p>
          </div>
          {keepLocal}
          <DialogFooter className="mt-2">
            <Button className="w-full" disabled={move?.moving} onClick={leave}>
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
      entry={STORAGE_ENTRY[detail.source]}
      title={detail.source === "pill" ? t("storage.moreTitle") : fullTitle}
      body={used}
      notice={grace}
      aside={keepLocal}
      onClose={leave}
    />
  );
}

type MoveOffCloud = {
  to: Residency;
  moving: boolean;
  progress: { done: number; total: number } | null;
  error: string | null;
  start: () => void;
};

/** The move off the cloud the wall offers: the open cloud project to this
 * Mac's engine when it answers, else to this browser's own storage. Null
 * where there is no project to move or nowhere on this computer to put it. */
function useMoveOffCloud(surface: WallSurface): MoveOffCloud | null {
  const t = useTranslations("billing");
  const describeError = useDescribeError();
  const base = useCutBase();
  const mode = useCutMode();
  const engineUp = useLocalCompute();
  const projectId = useEditor((s) => s.projectId);
  const [moving, setMoving] = useState(false);
  const [progress, setProgress] = useState<MoveOffCloud["progress"]>(null);
  const [error, setError] = useState<string | null>(null);
  const to: Residency | null = engineUp ? "local" : supportsBrowserStore() ? "browser" : null;
  if (surface !== "editor" || mode !== "cloud" || !projectId || !to) return null;

  // The copy opens in place of the original once it has landed.
  const start = () => {
    setMoving(true);
    setError(null);
    track("cut_storage_move_started", { to });
    moveOpenProject("cloud", to, (done, total) => setProgress({ done, total }))
      .then((newId) => {
        track("cut_storage_move_done", { to });
        window.location.href = projectHref(base, newId, "projects", null);
      })
      .catch((e: unknown) => {
        setError(describeError(e, t("storage.moveFailed")));
        setMoving(false);
        setProgress(null);
      });
  };
  return { to, moving, progress, error, start };
}

/** The wall's free way forward: move the project to this computer and keep
 * editing it there. */
function KeepLocal({ move }: { move: MoveOffCloud }) {
  const t = useTranslations("billing");
  const label = !move.moving
    ? t("storage.keepLocal")
    : move.progress
      ? t("storage.moving", move.progress)
      : t("storage.moveStarting");
  return (
    <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1 text-sm">
        <p className="text-muted-foreground">{t("storage.keepLocalBody", { to: move.to })}</p>
        {move.error ? <p className="text-destructive">{move.error}</p> : null}
      </div>
      <Button variant="outline" className="shrink-0" disabled={move.moving} onClick={move.start}>
        {move.moving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
        {label}
      </Button>
    </div>
  );
}
