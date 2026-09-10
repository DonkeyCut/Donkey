"use client";

import { useState } from "react";
import { describeAudience } from "@donkeycut/abexp";

import { PromotionDialog } from "@/app/su/promotions/PromotionDialog";
import { SuStandIn } from "@/app/su/SuStandIn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PromotionSender, PromotionStatus } from "@/lib/marketing/promotionInput";
import {
  useCancelPromotion,
  useDeletePromotion,
  usePromotions,
  useSendPromotion,
  type PromotionSummary,
} from "@/queries/promotions";
import type { Settings } from "@/lib/config/registry";
import { useSettings } from "@/queries/settings";

type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

const STATUS_VARIANT: Record<PromotionStatus, BadgeVariant> = {
  draft: "outline",
  sending: "default",
  paused: "outline",
  sent: "secondary",
};

const when = (iso: string) => new Date(iso).toLocaleString();

// A dialog opens on a row to edit it, or on a copy of one (its exclusions
// pre-set to the original) to write the next promotion to everyone else.
type Opened = { key: number; existing: PromotionSummary | null; seed: PromotionSummary | null };

export default function SuPromotionsPage() {
  const promotions = usePromotions();
  const [opened, setOpened] = useState<Opened | null>(null);
  // New drafts start from the Promotion credit offer setting.
  const settings = useSettings();
  const offerDefaults = settings.data?.settings.find((row) => row.key === "promotionCreditOffer")?.value as
    | Settings["promotionCreditOffer"]
    | undefined;
  const [counter, setCounter] = useState(0);
  const open = (existing: PromotionSummary | null, seed: PromotionSummary | null) => {
    setCounter((k) => k + 1);
    setOpened({ key: counter + 1, existing, seed });
  };

  const loadError = promotions.isError ? (
    <div role="alert" className="space-y-3 rounded-lg border border-destructive/30 p-4">
      <p className="text-sm text-destructive">Couldn’t load promotions. {promotions.error.message}</p>
      <Button variant="outline" disabled={promotions.isFetching} onClick={() => void promotions.refetch()}>
        {promotions.isFetching ? "Retrying…" : "Retry"}
      </Button>
    </div>
  ) : null;

  if (!promotions.data) return promotions.isPending ? <SuStandIn /> : loadError;
  const { promotions: rows, senders } = promotions.data;

  return (
    <div className="space-y-6 pb-9">
      {loadError}
      <div className="flex justify-end">
        <Button onClick={() => open(null, null)}>New promotion</Button>
      </div>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">No promotions yet.</p> : null}
      {rows.map((p) => (
        <PromotionRow
          key={p.id}
          promotion={p}
          all={rows}
          senders={senders}
          onOpen={() => open(p, null)}
          onDuplicate={() =>
            open(null, {
              ...p,
              excludePromotionIds: Array.from(new Set([p.id, ...p.excludePromotionIds])),
            })
          }
        />
      ))}
      {opened && offerDefaults ? (
        <PromotionDialog
          key={opened.key}
          existing={opened.existing}
          seed={opened.seed}
          offerDefaults={offerDefaults}
          promotions={rows}
          senders={senders}
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) setOpened(null);
          }}
        />
      ) : null}
    </div>
  );
}

function PromotionRow({
  promotion: p,
  all,
  senders,
  onOpen,
  onDuplicate,
}: {
  promotion: PromotionSummary;
  all: PromotionSummary[];
  senders: Record<PromotionSender, string>;
  onOpen: () => void;
  onDuplicate: () => void;
}) {
  const remove = useDeletePromotion();
  const cancel = useCancelPromotion();
  const resume = useSendPromotion();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const skipped = p.excludePromotionIds
    .map((id) => all.find((other) => other.id === id)?.name ?? "a deleted promotion")
    .join(", ");
  const { recipients, sent, failed } = p.counts;

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{p.name}</span>
            <Badge variant={STATUS_VARIANT[p.status]}>{p.status}</Badge>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">{p.subject}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            From {senders[p.sender] || `${p.sender} (not configured)`} · {describeAudience(p.audience)}
            {skipped ? ` · skips recipients of ${skipped}` : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {p.status === "draft"
              ? `Draft · saved ${when(p.updatedAt)}`
              : `${sent} of ${recipients} sent${failed ? ` · ${failed} failed` : ""}${
                  p.startedAt ? ` · started ${when(p.startedAt)}` : ""
                }${p.finishedAt ? ` · finished ${when(p.finishedAt)}` : ""}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant={p.status === "draft" ? "default" : "outline"} onClick={onOpen}>
            {p.status === "draft" ? "Edit" : "View"}
          </Button>
          <Button size="sm" variant="outline" onClick={onDuplicate}>
            Duplicate
          </Button>
          {p.status === "sending" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(p.id)}
            >
              {cancel.isPending ? "Pausing…" : "Pause"}
            </Button>
          ) : p.status === "paused" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={resume.isPending}
              onClick={() => resume.mutate(p.id)}
            >
              {resume.isPending ? "Resuming…" : "Resume"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => {
                remove.reset();
                setConfirmDelete(true);
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={(isOpen) => {
        if (!remove.isPending) setConfirmDelete(isOpen);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{p.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {p.status === "sent"
                ? "Its recipient list goes with it, so a later promotion can no longer skip the people it reached."
                : "The draft is removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {remove.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t delete promotion. {remove.error.message}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() => remove.mutate(p.id, { onSuccess: () => setConfirmDelete(false) })}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
