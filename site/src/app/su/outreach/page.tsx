"use client";

import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  useLastOutreachStart,
  useOutreachDrafts,
} from "@/app/su/outreach/drafts";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/utils";
import type { OutreachStatus } from "@/lib/marketing/campaigns";
import { OUTREACH_PLACEHOLDERS } from "@/lib/marketing/placeholders";
import {
  useBusyOutreachIds,
  useOutreach,
  useOutreachAction,
  useOutreachCounts,
  useOutreachSearch,
  type OutreachRow,
} from "@/queries/outreach";
import {
  useDeleteOutreachTemplate,
  useOutreachTemplates,
  useSaveOutreachTemplate,
} from "@/queries/outreachTemplates";

const FILTERS: { status: OutreachStatus; label: string }[] = [
  { status: "todo", label: "To email" },
  { status: "sent", label: "Sent" },
  { status: "replied", label: "Replied" },
  { status: "ignored", label: "Ignored" },
];

const BLANK = "blank";

// A place a note can start from: a saved template, or something this browser
// already sent. Both are starting points; whatever ends up in the dialog —
// words and send toggles alike — is what goes out.
type StartPoint = {
  id: string;
  title: string;
  meta: string;
  subject: string;
  body: string;
  unsubscribeLink: boolean;
  trackReplies: boolean;
  at: number;
  remove?: () => void;
  busy?: boolean;
};

function ago(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

// The numbers the scan wrote plus the cloud bytes read live; the badges say
// what they mean without a second read. Storage shows only when there is any,
// so a row with the badge is someone with media parked in the cloud.
function RowBadges({ row, group }: { row: OutreachRow; group?: string }) {
  const broke = Number(row.balance) <= 0;
  const stored = Number(row.storageBytes);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {group ? <Badge>{group}</Badge> : null}
      <Badge variant="secondary">${row.spent} spent</Badge>
      <Badge variant={broke ? "destructive" : "outline"}>
        {broke ? `$0 left · ${ago(row.ranOutAt)}` : `$${row.balance} left`}
      </Badge>
      {stored > 0 ? (
        <Badge variant="secondary">{formatBytes(stored)} stored</Badge>
      ) : null}
      <Badge variant="outline">active {ago(row.lastActiveAt)}</Badge>
      <Badge variant="outline">joined {ago(row.signedUpAt)}</Badge>
      {row.sentCount > 0 ? (
        <Badge variant="outline">
          emailed {ago(row.lastSentAt)}
          {row.sentCount > 1 ? ` · ${row.sentCount}×` : ""}
        </Badge>
      ) : null}
    </div>
  );
}

export default function SuOutreachPage() {
  const [status, setStatus] = useState<OutreachStatus>("todo");
  const [query, setQuery] = useState("");
  // A search starts wide — matches from every tab in one list — and clicking
  // a tab pins it to that group until the next search begins.
  const [scoped, setScoped] = useState(false);
  const [sendTarget, setSendTarget] = useState<OutreachRow | null>(null);
  const [source, setSource] = useState(BLANK);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [naming, setNaming] = useState(false);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  // The needle trails the field by a beat, so a search fires once per pause
  // in typing; clearing the field (handled in the input's onChange) brings
  // the plain list back at once.
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") return;
    const timer = setTimeout(() => setNeedle(trimmed), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const list = useOutreach(status);
  // Search matches in the database across every tab, so a hit past the page
  // cap is still found and every tab reports its true match count.
  const search = useOutreachSearch(needle, scoped ? status : undefined);
  const counts = useOutreachCounts().data?.counts;
  const act = useOutreachAction();
  const busy = useBusyOutreachIds();
  const templates = useOutreachTemplates();
  const saveTemplate = useSaveOutreachTemplate();
  const deleteTemplate = useDeleteOutreachTemplate();
  const { drafts, forget, remember } = useOutreachDrafts();
  const [lastStart, setLastStart] = useLastOutreachStart();
  const [unsubscribeLink, setUnsubscribeLink] = useState(true);
  const [trackReplies, setTrackReplies] = useState(true);

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
    })),
    ...drafts.map((draft) => ({
      at: new Date(draft.savedAt).getTime(),
      body: draft.body,
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
    },
    ...starts,
  ];

  const sendable = subject.trim() !== "" && body.trim() !== "";
  const selectedTemplate = source.startsWith("tpl:")
    ? saved.find((template) => `tpl:${template.id}` === source)
    : undefined;

  const pickSource = (id: string) => {
    const picked = sources.find((s) => s.id === id);
    if (!picked) return;
    setSource(id);
    setSubject(picked.subject);
    setBody(picked.body);
    setUnsubscribeLink(picked.unsubscribeLink);
    setTrackReplies(picked.trackReplies);
    setNaming(false);
  };

  const openSend = (row: OutreachRow) => {
    // Open on whatever the last note went out from, so a run through the list
    // is one click from ready; with nothing sent yet, the newest starting
    // point, and with nothing saved at all, a blank note.
    const start =
      sources.find((option) => option.id === lastStart) ?? starts[0] ?? sources[0];
    setSource(start.id);
    setSubject(start.subject);
    setBody(start.body);
    setUnsubscribeLink(start.unsubscribeLink);
    setTrackReplies(start.trackReplies);
    setNaming(false);
    setSendTarget(row);
  };

  const submitTemplate = () => {
    const name = templateName.trim();
    if (name === "" || !sendable) return;
    saveTemplate.mutate(
      { body, name, subject, trackReplies, unsubscribeLink },
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

  const submitSend = () => {
    const target = sendTarget;
    if (!target || subject.trim() === "" || body.trim() === "") return;
    // Sending a start point exactly as it is stays that start point; a change
    // to its words or its toggles becomes an entry of its own.
    const from = sources.find((option) => option.id === source);
    const edited =
      from?.subject !== subject ||
      from.body !== body ||
      from.unsubscribeLink !== unsubscribeLink ||
      from.trackReplies !== trackReplies;
    act.mutate(
      {
        action: "send",
        body,
        outreachId: target.id,
        subject,
        trackReplies,
        unsubscribeLink,
      },
      {
        onSuccess: () => {
          setLastStart(
            edited
              ? `draft:${remember({ body, subject, trackReplies, unsubscribeLink })}`
              : source,
          );
          // A send in flight leaves the dialog free for the next row, so only
          // close it if that row is still the one on screen.
          setSendTarget((current) => (current?.id === target.id ? null : current));
        },
      },
    );
  };

  const searching = needle !== "";
  const allTabs = searching && !scoped;
  const rows = searching ? (search.data?.rows ?? []) : (list.data?.rows ?? []);
  const loading = searching ? search.isPending : list.isPending;
  // Badges show the server's numbers: match counts while searching, list
  // totals otherwise; while either is still loading they show nothing.
  const tabCounts = searching ? search.data?.counts : counts;
  // The rows are one page of the matches; when there are more, the list says
  // so instead of passing a page off as the whole answer.
  const matchTotal = search.data
    ? scoped
      ? search.data.counts[status]
      : FILTERS.reduce((sum, filter) => sum + search.data.counts[filter.status], 0)
    : 0;
  const truncated = searching && matchTotal > rows.length;
  const sending = sendTarget !== null && busy.has(sendTarget.id);
  // A failed send keeps its dialog open, so the reason belongs in there with
  // the words that still need fixing.
  const sendFailed = act.isError && act.variables?.action === "send";

  return (
    <div className="space-y-4 pb-9">
      <Input
        aria-label="Search name or email"
        className="max-w-sm"
        onChange={(event) => {
          if (query.trim() === "" || event.target.value.trim() === "") {
            setScoped(false);
          }
          if (event.target.value.trim() === "") setNeedle("");
          setQuery(event.target.value);
        }}
        placeholder="Search name or email"
        type="search"
        value={query}
      />

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((filter) => (
          <Button
            key={filter.status}
            onClick={() => {
              setStatus(filter.status);
              setScoped(true);
            }}
            size="sm"
            variant={
              !allTabs && status === filter.status ? "default" : "outline"
            }
          >
            {filter.label}
            {tabCounts ? (
              <span className="tabular-nums opacity-60">
                {tabCounts[filter.status]}
              </span>
            ) : null}
          </Button>
        ))}
      </div>

      <div className="rounded-xl border bg-card">
        {rows.length > 0 ? (
          <ul className="divide-y">
            {rows.map((row) => (
              <li
                key={`${row.status}-${row.id}`}
                className="flex flex-wrap items-start justify-between gap-3 p-5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium">{row.name}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {row.email}
                    </span>
                  </div>
                  <RowBadges
                    group={
                      allTabs
                        ? FILTERS.find((f) => f.status === row.status)?.label
                        : undefined
                    }
                    row={row}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {row.status === "sent" ? (
                    <Button
                      disabled={busy.has(row.id)}
                      onClick={() =>
                        act.mutate({ action: "replied", outreachId: row.id })
                      }
                      size="sm"
                      variant="outline"
                    >
                      Mark replied
                    </Button>
                  ) : null}
                  {row.status === "ignored" ? (
                    <Button
                      disabled={busy.has(row.id)}
                      onClick={() =>
                        act.mutate({ action: "unignore", outreachId: row.id })
                      }
                      size="sm"
                      variant="outline"
                    >
                      Restore
                    </Button>
                  ) : (
                    <Button
                      disabled={busy.has(row.id)}
                      onClick={() =>
                        act.mutate({ action: "ignore", outreachId: row.id })
                      }
                      size="sm"
                      variant="ghost"
                    >
                      Ignore
                    </Button>
                  )}
                  <Button
                    disabled={busy.has(row.id)}
                    onClick={() => openSend(row)}
                    size="sm"
                  >
                    {row.sentCount > 0 ? "Email again" : "Email"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">
            {loading
              ? "Loading…"
              : searching
                ? "No matches."
                : "Nothing here. Run a scan to refresh."}
          </p>
        )}
      </div>

      {truncated ? (
        <p className="text-sm text-muted-foreground">
          Showing the first {rows.length} of {matchTotal} matches. Narrow the
          search to see the rest.
        </p>
      ) : null}

      {act.isError && !sendFailed ? (
        <p className="text-sm text-destructive">
          That didn&apos;t go through. Run a scan and try again.
        </p>
      ) : null}

      <Dialog
        onOpenChange={(open) => setSendTarget(open ? sendTarget : null)}
        open={sendTarget !== null}
      >
        <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] max-w-[calc(100%-2rem)] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Email {sendTarget?.name}</DialogTitle>
            <DialogDescription>
              Goes to {sendTarget?.email}.{" "}
              {trackReplies
                ? "Replies come back to your inbox and mark this row replied."
                : "Replies come straight back to your own address; the Mark replied button files the row."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-h-0 min-w-0 gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
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
                      <span className="block truncate text-sm">{option.title}</span>
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
                      disabled={saveTemplate.isPending || templateName.trim() === ""}
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
                  disabled={!sendable}
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
                {OUTREACH_PLACEHOLDERS.map((name) => (
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
              {sendFailed ? (
                <p className="text-sm text-destructive">
                  That didn&apos;t go through. The account may have unsubscribed
                  since the last scan, or the text may name a placeholder that
                  doesn&apos;t exist.
                </p>
              ) : null}
            </div>
          </div>

          <DialogFooter>
            {/* The footer column is reversed below sm, so ordering the toggles
                last keeps them painted above the send buttons there. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:order-last sm:mr-auto">
              <Label className="gap-2 font-normal text-muted-foreground">
                <Switch
                  checked={unsubscribeLink}
                  onCheckedChange={setUnsubscribeLink}
                />
                Add unsubscribe link
              </Label>
              <Label className="gap-2 font-normal text-muted-foreground">
                <Switch checked={trackReplies} onCheckedChange={setTrackReplies} />
                Track replies
              </Label>
            </div>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button disabled={sending || !sendable} onClick={submitSend}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
