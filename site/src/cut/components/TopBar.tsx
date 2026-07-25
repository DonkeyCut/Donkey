"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ChevronLeft, Cloud, Loader2, Mic, Monitor, Share2, Smartphone, Sparkles, Square, Upload, Video } from "lucide-react";
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
import { cloudBackend } from "@/cut/lib/backend/cloud";
import { useCutMode } from "@/cut/lib/backend/hooks";
import { localBackend } from "@/cut/lib/backend/local";
import { useWebMode } from "@/cut/lib/flags";
import { backTarget, projectHref, useCutBase } from "@/cut/lib/nav";
import { copyProjectAcross } from "@/cut/lib/projectCopy";
import { useEditor } from "@/cut/lib/store";
import { ASPECT_PRESETS, aspectLabel, aspectOrientation, type Aspect } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { RecordDialog, type RecordMode } from "./RecordDialog";
import { ShareDialog } from "./ShareDialog";

function AspectIcon({ aspect, className }: { aspect: Aspect; className?: string }) {
  const o = aspectOrientation(aspect);
  const Icon = o === "square" ? Square : o === "landscape" ? Monitor : Smartphone;
  return <Icon className={className} />;
}

export function TopBar({
  onImport,
  from,
  folder,
  uploading = 0,
}: {
  onImport: (files: File[], opts?: { origin?: "recording" }) => void;
  from?: string | null;
  folder?: string | null;
  /** Media files currently importing; on a cloud project the save indicator
   * reports them ("Uploading") — those are real network uploads, not local
   * disk copies. */
  uploading?: number;
}) {
  const base = useCutBase();
  const back = backTarget(base, from, folder);
  const hasClips = useEditor((s) => s.clips.length > 0);
  const aspect = useEditor((s) => s.aspect);
  const projectName = useEditor((s) => s.projectName);
  const saveState = useEditor((s) => s.saveState);
  const aiOpen = useEditor((s) => s.aiOpen);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [recordMode, setRecordMode] = useState<RecordMode | null>(null);

  // "Move to Cloud" (cut-web-mode flag): copies this local project — doc and
  // every media file — to the cloud, deletes the local original, and reopens
  // the editor on the cloud copy.
  const webMode = useWebMode();
  const cutMode = useCutMode();
  const canMoveToCloud = webMode && cutMode === "local";
  // Cloud imports are real uploads worth reporting; local imports are instant
  // disk copies, so the flag-off surface stays exactly as it was.
  const cloudUploading = uploading > 0 && cutMode === "cloud";
  const [shareOpen, setShareOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveProgress, setMoveProgress] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const moveToCloud = async () => {
    const projectId = useEditor.getState().projectId;
    if (!projectId) return;
    setMoving(true);
    setMoveError(null);
    try {
      // Let a pending autosave land so the copy reads the current cut.
      for (let i = 0; i < 40 && useEditor.getState().saveState !== "saved"; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const newId = await copyProjectAcross(localBackend, cloudBackend, projectId, {
        onProgress: (done, total) => setMoveProgress(`Moving media ${done}/${total}…`),
      });
      await localBackend
        .fetch(`/api/cut/projects/${projectId}`, { method: "DELETE" })
        .catch(() => {});
      window.location.href = projectHref(base, newId, "projects", null);
    } catch (e) {
      setMoveError(
        e instanceof Error && e.message ? e.message : "Could not move the project."
      );
      setMoving(false);
      setMoveProgress(null);
    }
  };

  const commitName = () => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== projectName) useEditor.getState().setProjectName(name);
  };

  return (
    <header className="relative flex items-center justify-between border-b border-border bg-card pr-3 pl-2">
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger className="aspect-switch flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:text-foreground">
            <AspectIcon aspect={aspect} className="size-3.5" />
            {aspectLabel(aspect)}
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {ASPECT_PRESETS.map((p) => (
              <DropdownMenuItem key={p.value} onClick={() => useEditor.getState().setAspect(p.value)}>
                <AspectIcon aspect={p.value} />
                <span className="flex-1">
                  {p.name} · {p.value}
                  <span className="block text-[10.5px] text-muted-foreground">{p.sublabel}</span>
                </span>
                {aspect === p.value && <Check className="size-3.5 text-muted-foreground" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger className="record-switch flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:text-foreground">
            <span className="size-2 rounded-full bg-red-500" aria-hidden />
            Record
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" style={{ width: "12rem" }}>
            <DropdownMenuItem onClick={() => setRecordMode("camera")}>
              <Video /> Record camera
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRecordMode("audio")}>
              <Mic /> Record audio
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {recordMode && (
        <RecordDialog
          mode={recordMode}
          onClose={() => setRecordMode(null)}
          onUse={(file) => onImport([file], { origin: "recording" })}
        />
      )}
      <div className="flex min-w-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Back to ${back.tab}`}
          nativeButton={false}
          render={<Link href={back.href} />}
        >
          <ChevronLeft />
        </Button>
        <span className="grid size-[22px] shrink-0 place-items-center">
          <img
            src="/donkey-logo.svg"
            alt="Donkey"
            width={22}
            height={22}
            className="block h-full w-full object-contain"
          />
        </span>
        {editing ? (
          <input
            autoFocus
            className="ml-1.5 h-7 w-52 rounded-md border border-input bg-transparent px-2 text-sm font-medium outline-none select-text focus:border-ring"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <button
            className="ml-1.5 max-w-64 cursor-text truncate rounded-md px-2 py-1 text-sm font-medium tracking-tight hover:bg-muted"
            title="Rename project"
            onClick={() => {
              setDraft(projectName);
              setEditing(true);
            }}
          >
            {projectName}
          </button>
        )}
        <span
          className={cn(
            "ml-2 flex items-center gap-1 text-[11px] text-muted-foreground transition-opacity",
            saveState === "saved" && !cloudUploading && "opacity-60"
          )}
        >
          {cloudUploading ? (
            <>
              <Loader2 className="size-3 animate-spin" />{" "}
              {uploading === 1 ? "Uploading" : `Uploading ${uploading} files`}
            </>
          ) : saveState === "saving" || saveState === "dirty" ? (
            <>
              <Loader2 className="size-3 animate-spin" /> Saving
            </>
          ) : saveState === "error" ? (
            <span className="text-destructive">Couldn’t save</span>
          ) : (
            <>
              <Check className="size-3" /> Saved
            </>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {cutMode === "cloud" && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Share"
            title="Share"
            onClick={() => setShareOpen(true)}
          >
            <Share2 data-icon="inline-start" /> Share
          </Button>
        )}
        {canMoveToCloud && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Move to Cloud"
            title="Move to Cloud"
            onClick={() => setMoveOpen(true)}
          >
            <Cloud data-icon="inline-start" /> Move to Cloud
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={!hasClips}
          onClick={() => {
            const s = useEditor.getState();
            s.setPlaying(false);
            s.setExportOpen(true);
          }}
        >
          <Upload data-icon="inline-start" /> Export
        </Button>
        <div aria-hidden className="h-4 w-px bg-border" />
        <Button
          variant={aiOpen ? "default" : "outline"}
          size="sm"
          className="ai-toggle"
          aria-label="Chat"
          aria-pressed={aiOpen}
          title="Chat (⌘J)"
          onClick={() => {
            const s = useEditor.getState();
            s.setAiOpen(!s.aiOpen);
          }}
        >
          <Sparkles data-icon="inline-start" /> Chat
        </Button>
      </div>
      {shareOpen && (
        <ShareDialog
          projectId={useEditor.getState().projectId ?? ""}
          onClose={() => setShareOpen(false)}
        />
      )}
      {moveOpen && (
        <Dialog open onOpenChange={(open) => !open && !moving && setMoveOpen(false)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Move to Cloud</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Copies this project and its media to the cloud, then removes it
              from this Mac. Exports rendered here stay behind.
            </p>
            {moveError && <p className="text-sm text-red-600">{moveError}</p>}
            <DialogFooter className="mt-2">
              <Button disabled={moving} className="w-full" onClick={() => void moveToCloud()}>
                {moving && <Loader2 className="animate-spin" data-icon="inline-start" />}
                {moving ? (moveProgress ?? "Moving…") : "Move to Cloud"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </header>
  );
}
