"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe, Link as LinkIcon, Lock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/cut/lib/backend";
import { refreshShareCard, refreshShareLadder } from "@/cut/lib/exportClient";
import { useCutBase } from "@/cut/lib/nav";
import type { ShareFeatures } from "@/cut/lib/types";

// Google-Docs-style sharing for a cloud project: invite people by email or
// open the link to anyone, always read-only. The advanced switches opt extra
// surfaces in; with all of them off a viewer gets the preview and timeline
// only. Every change PUTs immediately — closing the dialog is done.
//
// The dialog renders its final layout on the first frame and disables the
// controls until the fetch lands, so nothing reflows while it loads. The
// "Stop sharing" slot keeps its space for the same reason: creating a share
// by copying the link fills it in place.

type ShareAccess = "restricted" | "public";

/** What a share says, minus the identity the server assigns it. */
interface ShareSettings {
  access: ShareAccess;
  emails: string[];
  features: ShareFeatures;
}

interface ShareState extends ShareSettings {
  id: string;
}

const NO_FEATURES: ShareFeatures = {
  chat: false,
  media: false,
  genai: false,
  subtitles: false,
  details: false,
};

const FEATURE_ROWS: { key: keyof ShareFeatures; label: string; hint: string }[] = [
  { key: "chat", label: "Chat", hint: "AI chat threads and their cards" },
  { key: "media", label: "Media", hint: "Uploaded files beyond the timeline" },
  { key: "genai", label: "AI generations", hint: "Generated video, image, and audio" },
  { key: "subtitles", label: "Subtitles", hint: "The transcript panel" },
  { key: "details", label: "Details", hint: "Caption, tags, and notes" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The share link for a share id: the viewer route lives beside the app
 * subtree, so the app base minus its /app segment is the share base. */
function shareLink(base: string, shareId: string): string {
  return `${window.location.origin}${base.replace(/\/app$/, "")}/s/${shareId}`;
}

export function ShareDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const base = useCutBase();
  const [loading, setLoading] = useState(true);
  const [share, setShare] = useState<ShareState | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  // What the controls show while a PUT is in flight, so a switch flips under
  // the finger instead of after the round trip. The server's answer replaces
  // it; a failed save drops it back to what the server still holds.
  const [pending, setPending] = useState<ShareSettings | null>(null);
  const saveSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    void apiFetch(`/api/cut/projects/${projectId}/share`)
      .then((r) => (r.ok ? (r.json() as Promise<{ share: ShareState | null }>) : { share: null }))
      .then((body) => {
        if (!alive) return;
        // Opening the dialog is the moment before a link gets pasted
        // somewhere, so bring an existing share's preview card up to date with
        // the cut as it stands.
        // The card is a five-second render and can ride a dialog open. The
        // ladder cannot: it re-encodes the whole cut once per rung, so it waits
        // for the editor's own lull instead (Editor.tsx).
        if (body.share) refreshShareCard(projectId);
        setShare(body.share);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setError("Could not load sharing.");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  /** PUT the next share state; the row is created on the first save. */
  const save = async (next: ShareSettings): Promise<ShareState | null> => {
    const seq = ++saveSeq.current;
    setPending(next);
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/cut/projects/${projectId}/share`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { share: ShareState };
      // Sharing for the first time: build the link's preview card now, so the
      // first person to open the link sees the cut rather than a placeholder,
      // and start the streaming ladder so the link is playable on a phone
      // without waiting for the editor to close. This is the one interaction
      // that earns a whole-cut render — it is the moment a link starts
      // existing — and later saves leave it to the editor's lull.
      if (!share) {
        refreshShareCard(projectId);
        void refreshShareLadder(projectId);
      }
      setShare(body.share);
      return body.share;
    } catch {
      setError("Could not save sharing.");
      return null;
    } finally {
      // Only the newest save owns the controls: an earlier response landing
      // late leaves a rapid second toggle showing what was just clicked.
      if (seq === saveSeq.current) {
        setPending(null);
        setSaving(false);
      }
    }
  };

  const current: ShareSettings = pending ??
    share ?? {
      access: "restricted",
      emails: [],
      features: NO_FEATURES,
    };

  const addEmail = () => {
    const email = draft.trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_RE.test(email)) {
      setError("That doesn't look like an email address.");
      return;
    }
    setDraft("");
    setError(null);
    if (current.emails.includes(email)) return;
    void save({ ...current, emails: [...current.emails, email] });
  };

  const removeEmail = (email: string) => {
    void save({ ...current, emails: current.emails.filter((e) => e !== email) });
  };

  const setAccess = (access: ShareAccess) => {
    if (access !== current.access) void save({ ...current, access });
  };

  const setFeature = (key: keyof ShareFeatures, on: boolean) => {
    void save({ ...current, features: { ...current.features, [key]: on } });
  };

  const copyLink = async () => {
    // The first copy creates the share, so the link works the moment it's on
    // the clipboard.
    const target = share ?? (await save(current));
    if (!target) return;
    await navigator.clipboard.writeText(shareLink(base, target.id));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const removeShare = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/cut/projects/${projectId}/share`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setShare(null);
    } catch {
      setError("Could not remove the share.");
    } finally {
      setSaving(false);
    }
  };

  const busy = loading || saving;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Share project</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              People
            </span>
            <input
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-[12.5px] outline-none focus:border-ring disabled:opacity-60"
              type="email"
              placeholder="Invite by email, press Enter"
              disabled={loading}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addEmail();
                }
              }}
            />
            {current.emails.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {current.emails.map((email) => (
                  <span
                    key={email}
                    className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2 text-[11.5px]"
                  >
                    {email}
                    <button
                      aria-label={`Remove ${email}`}
                      className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-black/10 hover:text-foreground"
                      onClick={() => removeEmail(email)}
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              General access
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={loading}
                className="flex items-center gap-2 rounded-lg border border-input px-2.5 py-2 text-left text-[12.5px] transition-colors hover:border-ring disabled:opacity-60 disabled:hover:border-input"
              >
                {current.access === "public" ? (
                  <Globe className="size-4 text-muted-foreground" />
                ) : (
                  <Lock className="size-4 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {current.access === "public" ? "Anyone with the link" : "Restricted"}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {current.access === "public"
                      ? "Anyone can view — no sign-in needed"
                      : "Only people you invite can view, signed in"}
                  </span>
                </span>
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuItem onClick={() => setAccess("restricted")}>
                  <Lock />
                  <span className="flex-1">
                    Restricted
                    <span className="block text-[10.5px] text-muted-foreground">
                      Only people you invite can view, signed in
                    </span>
                  </span>
                  {current.access === "restricted" && (
                    <Check className="size-3.5 text-muted-foreground" />
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAccess("public")}>
                  <Globe />
                  <span className="flex-1">
                    Anyone with the link
                    <span className="block text-[10.5px] text-muted-foreground">
                      Anyone can view — no sign-in needed
                    </span>
                  </span>
                  {current.access === "public" && (
                    <Check className="size-3.5 text-muted-foreground" />
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <details className="group">
            <summary className="cursor-pointer list-none text-[11px] font-medium tracking-wide text-muted-foreground uppercase select-none">
              <span className="inline-flex items-center gap-1">
                Also share
                <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
              </span>
            </summary>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Viewers always get the preview and timeline, read-only. Switch
              on anything else they should see.
            </p>
            <div className="mt-1 flex flex-col">
              {FEATURE_ROWS.map(({ key, label, hint }) => (
                <label
                  key={key}
                  className="flex min-h-9 cursor-pointer items-center justify-between gap-2.5"
                >
                  <span className="text-[13px]">
                    {label}
                    <span className="block text-[10.5px] text-muted-foreground">{hint}</span>
                  </span>
                  <Switch
                    checked={current.features[key]}
                    disabled={loading}
                    onCheckedChange={(on) => setFeature(key, on)}
                  />
                </label>
              ))}
            </div>
          </details>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <DialogFooter className="mt-1 flex-col gap-2 sm:flex-col">
          <Button className="w-full" disabled={busy} onClick={() => void copyLink()}>
            {copied ? (
              <>
                <Check data-icon="inline-start" /> Copied
              </>
            ) : (
              <>
                <LinkIcon data-icon="inline-start" /> Copy link
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            aria-hidden={!share}
            tabIndex={share ? undefined : -1}
            className={`w-full text-muted-foreground hover:text-destructive ${
              share ? "" : "pointer-events-none invisible"
            }`}
            disabled={busy || !share}
            onClick={() => void removeShare()}
          >
            Stop sharing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
