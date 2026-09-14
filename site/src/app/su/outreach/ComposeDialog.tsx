"use client";

import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  CreditOfferFields,
  useCreditOfferDefaults,
} from "@/app/su/CreditOfferFields";
import {
  useLastOutreachStart,
  useOutreachDrafts,
} from "@/app/su/outreach/drafts";
import { UserHistoryPanel } from "@/app/su/outreach/UserHistory";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  creditOfferTermsIfValid,
  OFFER_CLAIM_NAMES,
  type CreditOfferTerms,
} from "@/lib/credits/offerTerms";
import {
  isOfferPlaceholder,
  OUTREACH_PLACEHOLDERS,
} from "@/lib/marketing/placeholders";
import { cn } from "@/lib/utils";
import { ApiError } from "@/queries/apiClient";
import {
  useBusyOutreachIds,
  useOutreachAction,
  type OutreachRow,
} from "@/queries/outreach";
import {
  useDeleteOutreachTemplate,
  useOutreachTemplates,
  useSaveOutreachTemplate,
} from "@/queries/outreachTemplates";
import { usePromotions, type PromotionSummary } from "@/queries/promotions";

// The note to one person on the outreach list: the words, the send toggles
// and the credit offer, started from a template, a recent send or a
// promotion. The Outreach tab opens it from its rows and Analytics from a
// user's row; both hand it the row to write to and hear when it is done.

const BLANK = "blank";

// A place a note can start from: a saved template, something this browser
// already sent, or a promotion. The first two are starting points; whatever
// ends up in the dialog — words, send toggles and the credit offer alike —
// is what goes out. A promotion goes out as it is saved, the same email its
// segment send mails, so it is read here and not edited.
type StartPoint = {
  id: string;
  title: string;
  meta: string;
  subject: string;
  body: string;
  unsubscribeLink: boolean;
  trackReplies: boolean;
  creditOffer: CreditOfferTerms | null;
  at: number;
  remove?: () => void;
  busy?: boolean;
  promotion?: PromotionSummary;
};

const promotionStartId = (id: string) => `promo:${id}`;

export function ago(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

export function OutreachComposeDialog({
  target,
  opening = null,
  onClose,
}: {
  /** The row the note goes to; null keeps the dialog closed. */
  target: OutreachRow | null;
  /** Who the note is for while their row is still being fetched: the dialog
   * opens on them at once and fills in when the row lands. */
  opening?: { name: string; email: string } | null;
  onClose: () => void;
}) {
  const [source, setSource] = useState(BLANK);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [naming, setNaming] = useState(false);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  const act = useOutreachAction();
  const busy = useBusyOutreachIds();
  const templates = useOutreachTemplates();
  const promotions = usePromotions();
  const saveTemplate = useSaveOutreachTemplate();
  const deleteTemplate = useDeleteOutreachTemplate();
  const { drafts, forget, remember } = useOutreachDrafts();
  const [lastStart, setLastStart] = useLastOutreachStart();
  const [unsubscribeLink, setUnsubscribeLink] = useState(true);
  const [trackReplies, setTrackReplies] = useState(true);
  const [creditOffer, setCreditOffer] = useState<CreditOfferTerms | null>(null);
  const [testNotice, setTestNotice] = useState<string | null>(null);
  const offerDefaults = useCreditOfferDefaults();
  // The row on screen, read at the end of a send that may have outlived it.
  const shown = useRef(target);
  useEffect(() => {
    shown.current = target;
  }, [target]);

  const saved = templates.data?.templates ?? [];

  const dropSource = (id: string) => {
    if (source === id) setSource(BLANK);
  };

  // Templates are shared and outlive the browser; recent sends are this
  // browser's own. One list, newest first, each entry saying which it is.
  const starts: StartPoint[] = [
    ...saved.map((template) => ({
      at: new Date(template.updatedAt).getTime(),
      body: template.body,
      busy: deleteTemplate.isPending,
      id: `tpl:${template.id}`,
      meta: "Template",
      remove: () =>
        deleteTemplate.mutate(template.id, {
          onSuccess: () => dropSource(`tpl:${template.id}`),
        }),
      subject: template.subject,
      title: template.name,
      trackReplies: template.trackReplies,
      unsubscribeLink: template.unsubscribeLink,
      creditOffer: creditOfferTermsIfValid(template.promotion),
    })),
    ...drafts.map((draft) => ({
      at: new Date(draft.savedAt).getTime(),
      body: draft.body,
      creditOffer: draft.creditOffer,
      id: `draft:${draft.id}`,
      meta: `Sent ${ago(draft.savedAt)}`,
      remove: () => {
        forget(draft.id);
        dropSource(`draft:${draft.id}`);
      },
      subject: draft.subject,
      title: draft.subject,
      trackReplies: draft.trackReplies,
      unsubscribeLink: draft.unsubscribeLink,
    })),
    ...(promotions.data?.promotions ?? []).map((promotion) => ({
      at: new Date(promotion.updatedAt).getTime(),
      body: promotion.body,
      creditOffer: promotion.creditOffer,
      id: promotionStartId(promotion.id),
      meta: `Promotion · ${promotion.counts.sent} sent`,
      promotion,
      subject: promotion.subject,
      title: promotion.name || "Untitled",
      trackReplies: false,
      unsubscribeLink: true,
    })),
  ].sort((a, b) => b.at - a.at);

  const sources: StartPoint[] = [
    {
      at: 0,
      body: "",
      id: BLANK,
      meta: "",
      subject: "",
      title: "Blank",
      trackReplies: true,
      unsubscribeLink: true,
      creditOffer: null,
    },
    ...starts,
  ];

  const pickSource = (id: string) => {
    const picked = sources.find((s) => s.id === id);
    if (!picked) return;
    setSource(id);
    setSubject(picked.subject);
    setBody(picked.body);
    setUnsubscribeLink(picked.unsubscribeLink);
    setTrackReplies(picked.trackReplies);
    setCreditOffer(picked.creditOffer);
    setNaming(false);
  };

  // Each opening starts from whatever the last note went out from, so a run
  // through a list is one click from ready; with nothing sent yet, the newest
  // starting point, and with nothing saved at all, a blank note. The seed
  // lands in the render that first sees the person, whose row may still be
  // on its way, and clears with them, so the same person opened again starts
  // fresh.
  const person = target?.email ?? opening?.email ?? null;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (person && seededFor !== person) {
    setSeededFor(person);
    const start =
      sources.find((option) => option.id === lastStart) ??
      starts[0] ??
      sources[0];
    setSource(start.id);
    setSubject(start.subject);
    setBody(start.body);
    setUnsubscribeLink(start.unsubscribeLink);
    setTrackReplies(start.trackReplies);
    setCreditOffer(start.creditOffer);
    setNaming(false);
    setTestNotice(null);
  } else if (!person && seededFor !== null) {
    setSeededFor(null);
  }

  // A promotion is checked whole by the server when it is sent, so the
  // button is live and a blank field comes back as the reason.
  const selectedPromotion = sources.find((s) => s.id === source)?.promotion;
  const sendable =
    selectedPromotion !== undefined ||
    (subject.trim() !== "" && body.trim() !== "");
  const selectedTemplate = source.startsWith("tpl:")
    ? saved.find((template) => `tpl:${template.id}` === source)
    : undefined;

  const submitTemplate = () => {
    const name = templateName.trim();
    if (name === "" || !sendable) return;
    saveTemplate.mutate(
      {
        body,
        name,
        subject,
        trackReplies,
        unsubscribeLink,
        promotion: creditOffer,
      },
      {
        onSuccess: (result) => {
          // The note now lives in a template, so the sent copy of the same
          // words stops being a second entry saying the same thing.
          const same = drafts.find(
            (draft) => draft.subject === subject && draft.body === body,
          );
          if (same) {
            forget(same.id);
            if (lastStart === `draft:${same.id}`) {
              setLastStart(`tpl:${result.template.id}`);
            }
          }
          setSource(`tpl:${result.template.id}`);
          setNaming(false);
        },
      },
    );
  };

  // A placeholder is easier to click than to spell, and it lands where the
  // cursor already is.
  const insertPlaceholder = (name: string) => {
    const token = `{{${name}}}`;
    const field = bodyField.current;
    const start = field?.selectionStart ?? body.length;
    const end = field?.selectionEnd ?? start;
    setBody(`${body.slice(0, start)}${token}${body.slice(end)}`);
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  // The note as it stands goes to the operator's own inbox, filled with the
  // row's values, so the words can be read as mail before they are sent.
  const submitTest = () => {
    if (!target || !sendable || selectedPromotion) return;
    setTestNotice(null);
    act.mutate(
      {
        action: "test",
        body,
        creditOffer,
        outreachId: target.id,
        subject,
        unsubscribeLink,
      },
      {
        onSuccess: (result) => setTestNotice(`Test sent to ${result.sentTo}.`),
      },
    );
  };

  // A send in flight leaves the dialog free for the next row, so it closes
  // only if that row is still the one on screen.
  const closeIfShown = (id: string) => {
    if (shown.current?.id === id) onClose();
  };

  const submitSend = () => {
    if (!target || !sendable) return;
    const id = target.id;
    setTestNotice(null);
    if (selectedPromotion) {
      act.mutate(
        {
          action: "promote",
          outreachId: id,
          promotionId: selectedPromotion.id,
        },
        {
          onSuccess: () => {
            setLastStart(source);
            closeIfShown(id);
          },
        },
      );
      return;
    }
    // Sending a start point exactly as it is stays that start point; a change
    // to its words or its toggles becomes an entry of its own.
    const from = sources.find((option) => option.id === source);
    const edited =
      from?.subject !== subject ||
      from.body !== body ||
      from.unsubscribeLink !== unsubscribeLink ||
      from.trackReplies !== trackReplies ||
      JSON.stringify(from.creditOffer) !== JSON.stringify(creditOffer);
    act.mutate(
      {
        action: "send",
        body,
        creditOffer,
        outreachId: id,
        subject,
        trackReplies,
        unsubscribeLink,
      },
      {
        onSuccess: () => {
          setLastStart(
            edited
              ? `draft:${remember({ body, creditOffer, subject, trackReplies, unsubscribeLink })}`
              : source,
          );
          closeIfShown(id);
        },
      },
    );
  };

  const sending = target !== null && busy.has(target.id);
  // A failed send keeps its dialog open, so the reason belongs in there with
  // the words that still need fixing; the server names a bad placeholder.
  const sendFailed =
    act.isError &&
    (act.variables?.action === "send" ||
      act.variables?.action === "test" ||
      act.variables?.action === "promote");
  const sendIssue =
    sendFailed && act.error instanceof ApiError
      ? act.error.issues[0]?.message
      : undefined;
  // The offer's placeholders are offered only while the note carries one.
  const placeholders = OUTREACH_PLACEHOLDERS.filter(
    (name) => creditOffer !== null || !isOfferPlaceholder(name),
  );

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={person !== null}
    >
      <DialogContent className="grid h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Email {target?.name ?? opening?.name}</DialogTitle>
          <DialogDescription>{target?.email ?? opening?.email}</DialogDescription>
        </DialogHeader>

        {/* The note and the person's past share the dialog; the tabs reset
            with each person so a new one opens on the note. */}
        <Tabs className="min-h-0 gap-3" defaultValue="note" key={person ?? "none"}>
          <TabsList variant="line">
            <TabsTrigger value="note">Note</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent className="min-h-0" value="history">
            {target ? (
              <UserHistoryPanel target={target} />
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
          </TabsContent>
          <TabsContent
            className="grid min-h-0 min-w-0 gap-4 md:grid-cols-[18rem_minmax(0,1fr)]"
            value="note"
          >
            <div className="flex min-h-0 flex-col gap-2 md:border-r md:pr-4">
              <span className="text-xs font-medium text-muted-foreground">
                Start from
              </span>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto max-md:max-h-40">
                {sources.map((option) => (
                  <div className="group/start relative" key={option.id}>
                    <button
                      className={cn(
                        "w-full rounded-lg px-2 py-1.5 pr-8 text-left transition-colors",
                        source === option.id
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50",
                      )}
                      onClick={() => pickSource(option.id)}
                      type="button"
                    >
                      <span className="block truncate text-sm">
                        {option.title}
                      </span>
                      {option.meta ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {option.meta}
                        </span>
                      ) : null}
                    </button>
                    {option.remove ? (
                      <Button
                        aria-label={`Delete ${option.title}`}
                        className="absolute top-1.5 right-1 opacity-0 group-hover/start:opacity-100 focus-visible:opacity-100"
                        disabled={option.busy}
                        onClick={option.remove}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <XIcon />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
              {naming ? (
                <div className="space-y-2">
                  <Input
                    aria-label="Template name"
                    autoFocus
                    maxLength={80}
                    onChange={(event) => setTemplateName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitTemplate();
                    }}
                    placeholder="Template name"
                    value={templateName}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      className="flex-1"
                      disabled={
                        saveTemplate.isPending || templateName.trim() === ""
                      }
                      onClick={submitTemplate}
                      size="sm"
                    >
                      {saveTemplate.isPending ? "Saving…" : "Save"}
                    </Button>
                    <Button
                      onClick={() => setNaming(false)}
                      size="sm"
                      variant="ghost"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  disabled={!sendable || selectedPromotion !== undefined}
                  onClick={() => {
                    setTemplateName(selectedTemplate?.name ?? "");
                    setNaming(true);
                  }}
                  size="sm"
                  variant="outline"
                >
                  Save as template
                </Button>
              )}
              {saveTemplate.isError ? (
                <p className="text-xs text-destructive">
                  Couldn&apos;t save that template. Try a different name.
                </p>
              ) : null}
              {deleteTemplate.isError ? (
                <p className="text-xs text-destructive">
                  Couldn&apos;t delete that template.
                </p>
              ) : null}
            </div>

            {selectedPromotion ? (
              <PromotionPreview
                promotion={selectedPromotion}
                issue={sendFailed ? sendIssue : undefined}
              />
            ) : (
              <div className="flex min-h-0 min-w-0 flex-col gap-2">
                <Label htmlFor="outreach-subject">Subject</Label>
                <Input
                  id="outreach-subject"
                  maxLength={200}
                  onChange={(event) => setSubject(event.target.value)}
                  value={subject}
                />
                <Label className="mt-1" htmlFor="outreach-body">
                  Message
                </Label>
                <Textarea
                  className="min-h-40 flex-1 resize-none field-sizing-fixed"
                  id="outreach-body"
                  maxLength={5000}
                  onChange={(event) => setBody(event.target.value)}
                  ref={bodyField}
                  value={body}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Blank line starts a paragraph. Insert:
                  </span>
                  {placeholders.map((name) => (
                    <Button
                      key={name}
                      onClick={() => insertPlaceholder(name)}
                      size="xs"
                      variant="outline"
                    >
                      {`{{${name}}}`}
                    </Button>
                  ))}
                </div>
                <CreditOfferFields
                  idPrefix="outreach-offer"
                  value={creditOffer}
                  defaults={offerDefaults}
                  onChange={setCreditOffer}
                  hint="The note carries a link for AI credits; {{claimUrl}} is the link and {{claimBy}} the last day to claim."
                />
                {sendFailed ? (
                  <p className="text-sm text-destructive">
                    {sendIssue ??
                      "That didn’t go through. The account may have unsubscribed since the last scan, or the text may name a placeholder that doesn’t exist."}
                  </p>
                ) : testNotice ? (
                  <p className="text-sm text-muted-foreground">{testNotice}</p>
                ) : null}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          {/* The footer column is reversed below sm, so ordering the toggles
              last keeps them painted above the send buttons there. */}
          {selectedPromotion ? null : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:order-last sm:mr-auto">
              <Button
                disabled={target === null || sending || !sendable}
                onClick={submitTest}
                variant="outline"
              >
                Send test to me
              </Button>
              <Label className="gap-2 font-normal text-muted-foreground">
                <Switch
                  checked={unsubscribeLink}
                  onCheckedChange={setUnsubscribeLink}
                />
                Add unsubscribe link
              </Label>
              <Label className="gap-2 font-normal text-muted-foreground">
                <Switch
                  checked={trackReplies}
                  onCheckedChange={setTrackReplies}
                />
                Track replies
              </Label>
            </div>
          )}
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button disabled={target === null || sending || !sendable} onClick={submitSend}>
            {sending
              ? "Sending…"
              : selectedPromotion
                ? "Send promotion"
                : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// A promotion as it will go: the subject, the words, the button and the
// offer, read from the saved row. Its words change on the Promotions tab.
function PromotionPreview({
  promotion,
  issue,
}: {
  promotion: PromotionSummary;
  issue: string | undefined;
}) {
  const offer = promotion.creditOffer;
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">Subject</span>
      <p className="text-sm">
        {promotion.subject || (
          <span className="text-muted-foreground">No subject yet</span>
        )}
      </p>
      <span className="mt-1 text-xs font-medium text-muted-foreground">
        Message
      </span>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap">
        {promotion.body || (
          <span className="text-muted-foreground">No message yet</span>
        )}
      </div>
      {promotion.ctaLabel ? (
        <p className="text-xs text-muted-foreground">
          Button: {promotion.ctaLabel} → {promotion.ctaUrl}
        </p>
      ) : null}
      {offer ? (
        <p className="text-xs text-muted-foreground">
          Credit offer: ${offer.dollars}, landed by{" "}
          {OFFER_CLAIM_NAMES[offer.claim].toLowerCase()},{" "}
          {offer.claimWindowDays} days to claim, lives {offer.expiresAfterDays}{" "}
          days.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Edit the words on the Promotions tab.
      </p>
      {issue ? <p className="text-sm text-destructive">{issue}</p> : null}
    </div>
  );
}
