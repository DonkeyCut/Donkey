"use client";

import { useState } from "react";

import {
  AudienceFields,
  audienceDraftFrom,
  audienceInputFrom,
  blankAudienceDraft,
  type AudienceDraft,
} from "@/app/su/experiments/AudienceFields";
import { Field } from "@/app/su/Field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PROMOTION_PLACEHOLDERS } from "@/lib/marketing/placeholders";
import { BUTTON_MARK } from "@/lib/marketing/promotionCopy";
import {
  promotionInputSchema,
  type PromotionInput,
  type PromotionSender,
  type SegmentCount,
} from "@/lib/marketing/promotionInput";
import {
  useCountSegment,
  useSavePromotion,
  useSendPromotion,
  useTestPromotion,
  type PromotionSummary,
} from "@/queries/promotions";

// One form writes a promotion and sends it: the words, the button, which
// address it comes from, who gets it, and which earlier promotions' readers
// are left out. A sent promotion opens read-only.

type Draft = {
  name: string;
  subject: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  sender: PromotionSender;
  audience: AudienceDraft;
  excludePromotionIds: string[];
};

const blank = (): Draft => ({
  name: "",
  subject: "",
  body: "",
  ctaLabel: "",
  ctaUrl: "",
  sender: "bulk",
  audience: blankAudienceDraft(),
  excludePromotionIds: [],
});

const fromSummary = (p: PromotionSummary): Draft => ({
  name: p.name,
  subject: p.subject,
  body: p.body,
  ctaLabel: p.ctaLabel ?? "",
  ctaUrl: p.ctaUrl ?? "",
  sender: p.sender,
  audience: audienceDraftFrom(p.audience),
  excludePromotionIds: p.excludePromotionIds,
});

function toInput(draft: Draft): unknown {
  return {
    name: draft.name.trim(),
    subject: draft.subject.trim(),
    body: draft.body.trim(),
    ctaLabel: draft.ctaLabel.trim() || null,
    ctaUrl: draft.ctaUrl.trim() || null,
    sender: draft.sender,
    audience: audienceInputFrom(draft.audience),
    excludePromotionIds: draft.excludePromotionIds,
  };
}

const placeholders = PROMOTION_PLACEHOLDERS.map((k) => `{{${k}}}`).join(", ");

export function PromotionDialog({
  existing,
  seed,
  promotions,
  senders,
  open,
  onOpenChange,
}: {
  existing: PromotionSummary | null;
  // A copy to start from, when the promotion is new.
  seed: PromotionSummary | null;
  promotions: PromotionSummary[];
  senders: Record<PromotionSender, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    existing ? fromSummary(existing) : seed ? { ...fromSummary(seed), name: `${seed.name} (copy)` } : blank(),
  );
  const [savedId, setSavedId] = useState<string | null>(existing?.id ?? null);
  const [issues, setIssues] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; count: SegmentCount } | null>(null);
  const save = useSavePromotion();
  const send = useSendPromotion();
  const test = useTestPromotion();
  const count = useCountSegment();

  const readOnly = existing !== null && existing.status !== "draft";
  const busy = save.isPending || send.isPending || test.isPending || count.isPending;
  // Earlier promotions that reached anyone; the one being edited is not a
  // choice against itself.
  const earlier = promotions.filter((p) => p.id !== existing?.id && p.status !== "draft");

  const setAudience = (patch: Partial<AudienceDraft>) =>
    setDraft((d) => ({ ...d, audience: { ...d.audience, ...patch } }));
  const toggleExclude = (id: string, on: boolean) =>
    setDraft((d) => ({
      ...d,
      excludePromotionIds: on
        ? Array.from(new Set([...d.excludePromotionIds, id]))
        : d.excludePromotionIds.filter((x) => x !== id),
    }));

  const parse = (): PromotionInput | null => {
    const parsed = promotionInputSchema.safeParse(toInput(draft));
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`));
      return null;
    }
    setIssues([]);
    return parsed.data;
  };

  const fail = (e: Error) => setIssues([e.message]);

  // Every action past a plain save goes through the saved row, so the test
  // and the send read exactly what is stored.
  const ensureSaved = async (): Promise<string | null> => {
    const input = parse();
    if (!input) return null;
    try {
      const result = await save.mutateAsync({ id: savedId, ...input });
      setSavedId(result.id);
      return result.id;
    } catch (e) {
      fail(e as Error);
      return null;
    }
  };

  const onSave = async () => {
    const id = await ensureSaved();
    if (id) onOpenChange(false);
  };

  const onTest = async () => {
    setNotice(null);
    const id = readOnly ? existing.id : await ensureSaved();
    if (!id) return;
    test.mutate(id, {
      onSuccess: (r) => setNotice(`Test sent to ${r.sentTo}.`),
      onError: fail,
    });
  };

  const onSend = async () => {
    setNotice(null);
    const id = await ensureSaved();
    if (!id) return;
    const input = parse();
    if (!input) return;
    count.mutate(
      { audience: input.audience, excludePromotionIds: input.excludePromotionIds },
      { onSuccess: (c) => setConfirm({ id, count: c }), onError: fail },
    );
  };

  const onConfirmSend = () => {
    if (!confirm) return;
    send.mutate(confirm.id, {
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setConfirm(null);
        fail(e);
      },
    });
  };

  const senderLabel = (s: PromotionSender) =>
    `${s === "bulk" ? "Bulk" : "Personal"} · ${senders[s] || "not configured"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{readOnly ? draft.name : existing ? "Edit promotion" : "New promotion"}</DialogTitle>
          <DialogDescription>
            {readOnly
              ? "Sent as it reads here."
              : "One email to everyone in the segment. Unsubscribed accounts are always left out."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" htmlFor="promo-name">
              <Input
                id="promo-name"
                placeholder="Founding Pro, October"
                disabled={readOnly}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="From" htmlFor="promo-sender">
              <Select
                disabled={readOnly}
                value={draft.sender}
                onValueChange={(v) => setDraft({ ...draft, sender: v as PromotionSender })}
              >
                <SelectTrigger id="promo-sender">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bulk">{senderLabel("bulk")}</SelectItem>
                  <SelectItem value="personal">{senderLabel("personal")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Subject" htmlFor="promo-subject">
            <Input
              id="promo-subject"
              disabled={readOnly}
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </Field>
          <Field label="Body" htmlFor="promo-body">
            <Textarea
              id="promo-body"
              rows={12}
              disabled={readOnly}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              A blank line starts a new paragraph. {placeholders} fill in per person. A line that is only{" "}
              {BUTTON_MARK} places the button; without it the button comes last.
            </p>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Button label (optional)" htmlFor="promo-cta-label">
              <Input
                id="promo-cta-label"
                placeholder="Get Pro"
                disabled={readOnly}
                value={draft.ctaLabel}
                onChange={(e) => setDraft({ ...draft, ctaLabel: e.target.value })}
              />
            </Field>
            <Field label="Button link" htmlFor="promo-cta-url">
              <Input
                id="promo-cta-url"
                placeholder="https://donkeycut.com/app/settings"
                disabled={readOnly}
                value={draft.ctaUrl}
                onChange={(e) => setDraft({ ...draft, ctaUrl: e.target.value })}
              />
            </Field>
          </div>

          <AudienceFields value={draft.audience} onChange={setAudience} countries={false} disabled={readOnly} />

          <div className="space-y-3">
            <Label>Skip anyone who received</Label>
            {earlier.length === 0 ? (
              <p className="text-sm text-muted-foreground">No earlier promotions.</p>
            ) : (
              <div className="grid gap-2">
                {earlier.map((p) => (
                  <label key={p.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">
                      {p.name}
                      <span className="text-muted-foreground"> · {p.counts.sent} sent</span>
                    </span>
                    <Switch
                      disabled={readOnly}
                      checked={draft.excludePromotionIds.includes(p.id)}
                      onCheckedChange={(on) => toggleExclude(p.id, on)}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>

          {issues.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" disabled={busy} onClick={onTest}>
            {test.isPending ? "Sending test…" : "Send test to me"}
          </Button>
          <div className="flex gap-2">
            {readOnly ? (
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            ) : (
              <>
                <Button type="button" variant="secondary" disabled={busy} onClick={onSave}>
                  {save.isPending ? "Saving…" : "Save draft"}
                </Button>
                <Button type="button" disabled={busy} onClick={onSend}>
                  {count.isPending ? "Counting…" : "Send…"}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>

        {confirm ? (
          <Dialog open onOpenChange={(isOpen) => !isOpen && setConfirm(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Send to {confirm.count.recipients} people?</DialogTitle>
                <DialogDescription>
                  From {senders[draft.sender]}. Left out: {confirm.count.unsubscribed} unsubscribed,{" "}
                  {confirm.count.alreadyReceived} already received an excluded promotion,{" "}
                  {confirm.count.outsideAudience} outside the audience.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="secondary" disabled={send.isPending} onClick={() => setConfirm(null)}>
                  Not yet
                </Button>
                <Button
                  type="button"
                  disabled={send.isPending || confirm.count.recipients === 0}
                  onClick={onConfirmSend}
                >
                  {send.isPending ? "Starting…" : "Send now"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
