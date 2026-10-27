"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe, Link as LinkIcon, Lock, X } from "lucide-react";
import { useTranslations } from "next-intl";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useQueryClient } from "@tanstack/react-query";
import { useSharing, sharingKey } from "@/queries/sharing";
import { requestSharing, type ShareResource } from "@/cut/lib/sharingClient";
import { librarySharePath, shareEmailSchema, type ShareSettings as AccessSettings } from "@/cut/lib/librarySharing";
import { refreshShareCard, refreshShareLadder } from "@/cut/lib/exportClient";
import { useCutBase } from "@/cut/lib/nav";
import { isTimelineId, TIMELINE_IDS, type ShareFeatures, type TimelineId } from "@/cut/lib/types";
import { useDescribeError } from "@/i18n/describeError";
import { useLabels } from "@/i18n/labels";

// One sharing dialog for projects, library folders, and assets. Changes save immediately.

type ShareAccess = AccessSettings["access"];
type ShareSettings = AccessSettings & { features: ShareFeatures };
type ShareState = ShareSettings & { id: string };

const NO_FEATURES: ShareFeatures = {
  chat: false,
  media: false,
  genai: false,
  subtitles: false,
  details: false,
};

type FeatureKey = Exclude<keyof ShareFeatures, "timeline">;

// The switches under "Also share", in order; each names itself through
// `features.<key>` in the editor catalog.
const FEATURE_ROWS: FeatureKey[] = ["chat", "media", "genai", "subtitles", "details"];

/** The share link for a share id: the viewer route lives beside the app
 * subtree, so the app base minus its /app segment is the share base. */
function shareLink(base: string, shareId: string): string {
  return `${window.location.origin}${base.replace(/\/app$/, "")}/s/${shareId}`;
}

export function ShareDialog(props: ShareResource & { onClose: () => void }) {
  const t = useTranslations("editor.shareDialog");
  const describeError = useDescribeError();
  const timelineLabel = useLabels("timeline");
  const { onClose } = props;
  const projectId = "projectId" in props ? props.projectId : null;
  const libraryTarget = "libraryTarget" in props ? props.libraryTarget : null;
  const base = useCutBase();
  const client = useQueryClient();
  const query = useSharing(props);
  const loading = query.isPending || query.isFetching;
  const share: ShareState | null = query.data?.share
    ? { ...query.data.share, features: query.data.share.features ?? NO_FEATURES }
    : null;
  const setShare = (next: ShareState | null) => client.setQueryData(sharingKey(props), { share: next });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  // What the controls show while a PUT is in flight, so a switch flips under
  // the finger instead of after the round trip. The server's answer replaces
  // it; a failed save drops it back to what the server still holds.
  const [pending, setPending] = useState<ShareSettings | null>(null);
  const saveSeq = useRef(0);
  const mutationBusy = useRef(false);

  const shareId = share?.id;
  useEffect(() => {
    if (projectId && shareId) refreshShareCard(projectId);
  }, [projectId, shareId]);

  /** PUT the next share state; the row is created on the first save. */
  const save = async (next: ShareSettings): Promise<ShareState | null> => {
    if (mutationBusy.current) return null;
    mutationBusy.current = true;
    const seq = ++saveSeq.current;
    setPending(next);
    setSaving(true);
    setError(null);
    try {
      const body = await requestSharing(props, "PUT", next);
      if (!body.share) throw new Error(t("saveFailed"));
      const saved = { ...body.share, features: body.share.features ?? NO_FEATURES };
      // Sharing for the first time: build the link's preview card now, so the
      // first person to open the link sees the cut rather than a placeholder,
      // and start the streaming ladder so the link is playable on a phone
      // without waiting for the editor to close. This is the one interaction
      // that earns a whole-cut render — it is the moment a link starts
      // existing — and later saves leave it to the editor's lull.
      if (!share && projectId) {
        refreshShareCard(projectId);
        void refreshShareLadder(projectId);
      }
      if (seq === saveSeq.current) setShare(saved);
      return saved;
    } catch {
      setError(t("saveFailed"));
      return null;
    } finally {
      mutationBusy.current = false;
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
    if (!shareEmailSchema.safeParse(email).success) {
      setError(t("invalidEmail"));
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

  const setFeature = (key: FeatureKey, on: boolean) => {
    void save({ ...current, features: { ...current.features, [key]: on } });
  };

  // A different timeline is a different cut on the link, so its card and
  // stream are rebuilt once the setting lands.
  const setTimeline = async (timeline: TimelineId) => {
    if (timeline === (current.features.timeline ?? "main")) return;
    const saved = await save({ ...current, features: { ...current.features, timeline } });
    if (saved && projectId) {
      refreshShareCard(projectId);
      void refreshShareLadder(projectId);
    }
  };

  const copyLink = async () => {
    // The first copy creates the share, so the link works the moment it's on
    // the clipboard.
    const target = share ?? (await save(current));
    if (!target) return;
    try {
      const link = libraryTarget
        ? `${window.location.origin}${base.replace(/\/app$/, "")}${librarySharePath(target.id)}`
        : shareLink(base, target.id);
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t("copyFailed"));
    }
  };

  const removeShare = async () => {
    if (mutationBusy.current) return;
    mutationBusy.current = true;
    setSaving(true);
    setError(null);
    try {
      await requestSharing(props, "DELETE");
      setShare(null);
    } catch {
      setError(t("removeFailed"));
    } finally {
      mutationBusy.current = false;
      setSaving(false);
    }
  };

  const busy = loading || saving || query.isError;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title", { kind: libraryTarget?.kind ?? "project" })}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t("people")}
            </span>
            <input
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-[12.5px] outline-none focus:border-ring disabled:opacity-60"
              type="email"
              placeholder={t("invitePlaceholder")}
              disabled={busy}
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
                      disabled={busy}
                      aria-label={t("removeEmail", { email })}
                      className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
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
              {t("generalAccess")}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={busy}
                className="flex items-center gap-2 rounded-lg border border-input px-2.5 py-2 text-left text-[12.5px] transition-colors hover:border-ring disabled:opacity-60 disabled:hover:border-input"
              >
                {current.access === "public" ? (
                  <Globe className="size-4 text-muted-foreground" />
                ) : (
                  <Lock className="size-4 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {current.access === "public" ? t("public") : t("restricted")}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {current.access === "public"
                      ? t("publicHint")
                      : t("restrictedHint")}
                  </span>
                </span>
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuItem onClick={() => setAccess("restricted")}>
                  <Lock />
                  <span className="flex-1">
                    {t("restricted")}
                    <span className="block text-[10.5px] text-muted-foreground">
                      {t("restrictedHint")}
                    </span>
                  </span>
                  {current.access === "restricted" && (
                    <Check className="size-3.5 text-muted-foreground" />
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAccess("public")}>
                  <Globe />
                  <span className="flex-1">
                    {t("public")}
                    <span className="block text-[10.5px] text-muted-foreground">
                      {t("publicHint")}
                    </span>
                  </span>
                  {current.access === "public" && (
                    <Check className="size-3.5 text-muted-foreground" />
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {projectId && (
            <div className="flex min-h-9 items-center justify-between gap-2.5">
              <span className="text-[13px]">
                {t("timeline")}
                <span className="block text-[10.5px] text-muted-foreground">{t("timelineHint")}</span>
              </span>
              <Select
                value={current.features.timeline ?? "main"}
                disabled={busy}
                onValueChange={(v) => {
                  if (isTimelineId(v)) void setTimeline(v);
                }}
              >
                <SelectTrigger className="w-fit min-w-28" aria-label={t("timeline")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {TIMELINE_IDS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {timelineLabel(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {projectId ? <details className="group">
            <summary className="cursor-pointer list-none text-[11px] font-medium tracking-wide text-muted-foreground uppercase select-none">
              <span className="inline-flex items-center gap-1">
                {t("alsoShare")}
                <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
              </span>
            </summary>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("alsoShareHint")}
            </p>
            <div className="mt-1 flex flex-col">
              {FEATURE_ROWS.map((key) => (
                <label
                  key={key}
                  className="flex min-h-9 cursor-pointer items-center justify-between gap-2.5"
                >
                  <span className="text-[13px]">
                    {t(`features.${key}.label`)}
                    <span className="block text-[10.5px] text-muted-foreground">{t(`features.${key}.hint`)}</span>
                  </span>
                  <Switch
                    checked={current.features[key]}
                    disabled={busy}
                    onCheckedChange={(on) => setFeature(key, on)}
                  />
                </label>
              ))}
            </div>
          </details> : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {libraryTarget?.kind === "folder"
                ? t("folderHint")
                : t("assetHint")}
            </p>
          )}

          {(error || query.error) && <p role="alert" className="text-sm text-red-600">{error ?? describeError(query.error)}</p>}
          {query.isError && <Button variant="outline" onClick={() => void query.refetch()}>{t("tryAgain")}</Button>}
        </div>
        <DialogFooter className="mt-1 flex-col gap-2 sm:flex-col">
          <Button className="w-full" disabled={busy} onClick={() => void copyLink()}>
            {copied ? (
              <>
                <Check data-icon="inline-start" /> {t("copied")}
              </>
            ) : (
              <>
                <LinkIcon data-icon="inline-start" /> {t("copyLink")}
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
            {t("stopSharing")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
