"use client";

import { useState } from "react";

import { useOutreachDrafts } from "@/app/cut/app/su/outreach/drafts";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { OutreachStatus } from "@/lib/marketing/campaigns";
import { OUTREACH_PLACEHOLDERS } from "@/lib/marketing/placeholders";
import { useOutreach, useOutreachAction, type OutreachRow } from "@/queries/outreach";
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

function ago(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

// The list carries the numbers the scan wrote; the badges say what they mean
// without a second read.
function RowBadges({ row }: { row: OutreachRow }) {
  const broke = Number(row.balance) <= 0;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <Badge variant="secondary">${row.spent} spent</Badge>
      <Badge variant={broke ? "destructive" : "outline"}>
        {broke ? `$0 left · ${ago(row.ranOutAt)}` : `$${row.balance} left`}
      </Badge>
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
  const [sendTarget, setSendTarget] = useState<OutreachRow | null>(null);
  const [source, setSource] = useState(BLANK);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [naming, setNaming] = useState(false);
  const list = useOutreach(status);
  const act = useOutreachAction();
  const templates = useOutreachTemplates();
  const saveTemplate = useSaveOutreachTemplate();
  const deleteTemplate = useDeleteOutreachTemplate();
  const { drafts, remember } = useOutreachDrafts();

  const saved = templates.data?.templates ?? [];

  // Saved templates are shared and outlive the browser; recent sends are this
  // browser's own. Both are starting points: whatever ends up in the fields is
  // what goes out.
  const sources: { id: string; label: string; subject: string; body: string }[] = [
    { id: BLANK, label: "Blank", subject: "", body: "" },
    ...saved.map((template) => ({
      id: `tpl:${template.id}`,
      label: template.name,
      subject: template.subject,
      body: template.body,
    })),
    ...drafts.map((draft, index) => ({
      id: `draft:${index}`,
      label: `${draft.subject} · sent ${ago(draft.savedAt)}`,
      subject: draft.subject,
      body: draft.body,
    })),
  ];
  const sourceLabels = Object.fromEntries(sources.map((s) => [s.id, s.label]));

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
    setNaming(false);
  };

  const openSend = (row: OutreachRow) => {
    // Open on the first saved template so the common case is one click from
    // ready; with none saved yet, a blank note.
    const start = sources[1] ?? sources[0];
    setSource(start.id);
    setSubject(start.subject);
    setBody(start.body);
    setNaming(false);
    setSendTarget(row);
  };

  const submitTemplate = () => {
    const name = templateName.trim();
    if (name === "" || !sendable) return;
    saveTemplate.mutate(
      { body, name, subject },
      {
        onSuccess: (result) => {
          setSource(`tpl:${result.template.id}`);
          setNaming(false);
        },
      },
    );
  };

  const removeTemplate = () => {
    if (!selectedTemplate) return;
    deleteTemplate.mutate(selectedTemplate.id, {
      onSuccess: () => setSource(BLANK),
    });
  };

  const submitSend = () => {
    if (!sendTarget || subject.trim() === "" || body.trim() === "") return;
    act.mutate(
      { action: "send", body, outreachId: sendTarget.id, subject },
      {
        onSuccess: () => {
          remember({ body, subject });
          setSendTarget(null);
        },
      },
    );
  };

  const rows = list.data?.rows ?? [];

  return (
    <div className="space-y-4 pb-9">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((filter) => (
          <Button
            key={filter.status}
            onClick={() => setStatus(filter.status)}
            size="sm"
            variant={status === filter.status ? "default" : "outline"}
          >
            {filter.label}
          </Button>
        ))}
      </div>

      <div className="rounded-xl border bg-card">
        {rows.length > 0 ? (
          <ul className="divide-y">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-start justify-between gap-3 p-5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium">{row.name}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {row.email}
                    </span>
                  </div>
                  <RowBadges row={row} />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {row.status === "sent" ? (
                    <Button
                      disabled={act.isPending}
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
                      disabled={act.isPending}
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
                      disabled={act.isPending}
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
                    disabled={act.isPending}
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
            {list.isPending ? "Loading…" : "Nothing here. Run a scan to refresh."}
          </p>
        )}
      </div>

      {act.isError ? (
        <p className="text-sm text-destructive">
          That didn&apos;t go through. The account may have unsubscribed since the
          last scan, or the text may name a placeholder that doesn&apos;t exist.
        </p>
      ) : null}

      <Dialog
        onOpenChange={(open) => setSendTarget(open ? sendTarget : null)}
        open={sendTarget !== null}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Email {sendTarget?.name}</DialogTitle>
            <DialogDescription>
              Goes to {sendTarget?.email}. Replies come back to your inbox and mark
              this row replied.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="outreach-source">Start from</Label>
              <div className="flex items-center gap-2">
                <Select
                  items={sourceLabels}
                  onValueChange={(id) => pickSource(id as string)}
                  value={source}
                >
                  <SelectTrigger className="flex-1" id="outreach-source">
                    <span className="truncate">{sourceLabels[source]}</span>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {sources.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedTemplate ? (
                  <Button
                    disabled={deleteTemplate.isPending}
                    onClick={removeTemplate}
                    size="sm"
                    variant="ghost"
                  >
                    Delete
                  </Button>
                ) : null}
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
              </div>
              {naming ? (
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Template name"
                    autoFocus
                    maxLength={80}
                    onChange={(event) => setTemplateName(event.target.value)}
                    placeholder="Template name"
                    value={templateName}
                  />
                  <Button
                    disabled={saveTemplate.isPending || templateName.trim() === ""}
                    onClick={submitTemplate}
                    size="sm"
                  >
                    {saveTemplate.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button onClick={() => setNaming(false)} size="sm" variant="ghost">
                    Cancel
                  </Button>
                </div>
              ) : null}
              {saveTemplate.isError || deleteTemplate.isError ? (
                <p className="text-sm text-destructive">
                  Couldn&apos;t save that template. Try a different name.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="outreach-subject">Subject</Label>
              <Input
                id="outreach-subject"
                maxLength={200}
                onChange={(event) => setSubject(event.target.value)}
                value={subject}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="outreach-body">Message</Label>
              <Textarea
                className="min-h-64"
                id="outreach-body"
                maxLength={5000}
                onChange={(event) => setBody(event.target.value)}
                value={body}
              />
              <p className="text-xs text-muted-foreground">
                Blank line starts a paragraph. Placeholders:{" "}
                {OUTREACH_PLACEHOLDERS.map((name) => `{{${name}}}`).join(" ")}
              </p>
            </div>
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button disabled={act.isPending || !sendable} onClick={submitSend}>
              {act.isPending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
