"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronLeft, CloudUpload, Loader2, Mic, Monitor, Ratio, Share2, Smartphone, Sparkles, Square, Upload, Video } from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cloudBackend } from "@/cut/lib/backend/cloud";
import { cloudUsageQueryKey, useCutMode } from "@/cut/lib/backend/hooks";
import { localBackend } from "@/cut/lib/backend/local";
import { useWebMode } from "@/cut/lib/flags";
import { backTarget, projectHref, useCutBase } from "@/cut/lib/nav";
import { copyProjectAcross } from "@/cut/lib/projectCopy";
import { useEditor } from "@/cut/lib/store";
import { useLocalPref } from "@/cut/lib/uiState";
import { ASPECT_PRESETS, aspectLabel, aspectOrientation, normalizeAspect, parseRatio, type Aspect } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { RecordDialog, type RecordMode } from "./RecordDialog";
import { ShareDialog } from "./ShareDialog";
import { StoragePill } from "./StoragePill";

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
  const isPreset = ASPECT_PRESETS.some((p) => p.value === aspect);
  // Custom is a sticky mode: picked from the menu, entered by typing in the pill,
  // or loading a project on a non-preset ratio, the pill stays a W:H editor until
  // a preset is chosen from its chevron menu. Sticky matters while typing — a
  // keystroke that lands on a preset value ("16:9") would otherwise flip
  // `isPreset` and unmount the editor out from under the cursor.
  const [customMode, setCustomMode] = useState(false);
  const showCustomEditor = customMode || !isPreset;
  // The last custom ratio survives preset detours and reloads: it's only
  // rewritten by a manual apply (or an external non-preset aspect), so
  // re-picking Custom… returns to it.
  // Remembered AS TYPED ("9.5:5"), so the pill re-shows the user's spelling
  // after reloads; the project doc always stores the reduced form ("19:10").
  const [savedCustom, setSavedCustom] = useLocalPref<string>(
    "cut-custom-aspect",
    "",
    (v) => typeof v === "string" && normalizeAspect(v) !== null
  );
  const [customW, setCustomW] = useState(() => savedCustom.split(":")[0] || "16");
  const [customH, setCustomH] = useState(() => savedCustom.split(":")[1] || "9");
  // Sides may be decimal ("1.85"); the applied/stored form is the reduced
  // whole-number ratio ("37:20").
  const customNormalized = normalizeAspect(`${customW}:${customH}`);
  // Hold the field to what normalizeAspect accepts — four whole digits, two
  // decimals — so a value can't type clean and then fail to apply. Four, so that
  // typing a frame size ("1280" by "720") is a legal entry that reduces to 16:9
  // rather than being trimmed to "128" and applied as a different ratio.
  const ratioInput = (v: string) => {
    const [whole, ...rest] = v.replace(/[^\d.]/g, "").split(".");
    const head = whole.slice(0, 4);
    return rest.length === 0 ? head : `${head}.${rest.join("").slice(0, 2)}`;
  };
  // A side mid-keystroke (empty, or a bare "1.") is unfinished rather than
  // wrong; only a settled pair that still won't normalize — a zero, or past the
  // 8:1 cap — reads as invalid, so the pill doesn't flash while someone types.
  const sideSettled = (v: string) => v !== "" && !v.endsWith(".");
  const customInvalid = sideSettled(customW) && sideSettled(customH) && !customNormalized;
  // Typing applies: a keystroke parks the pair it wants applied here, and the
  // effect below lands it a beat later, so the frame follows the fields instead
  // of waiting for a commit the user has to guess at. A newer keystroke replaces
  // the pending pair; settling, reverting, or an outside change clears it.
  const [pendingRatio, setPendingRatio] = useState<string | null>(null);
  const applyRatio = (ratio: string) => {
    const next = normalizeAspect(ratio);
    if (next) useEditor.getState().setAspect(next);
  };
  useEffect(() => {
    if (!pendingRatio) return;
    const id = setTimeout(() => {
      applyRatio(pendingRatio);
      setPendingRatio(null);
    }, 250);
    // Cancels on the next keystroke and on leaving the editor, so a ratio the
    // user moved past never lands.
    return () => clearTimeout(id);
  }, [pendingRatio]);

  // The inputs mirror aspect changes made outside the editor (AI set_aspect,
  // project load). Ours are recognised by the fields already normalizing to the
  // new value, so a live apply doesn't reformat what the user is typing.
  const [seenAspect, setSeenAspect] = useState(aspect);
  if (aspect !== seenAspect) {
    setSeenAspect(aspect);
    if (customNormalized !== aspect) {
      // The change came from outside: drop the pending keystroke so it can't land
      // a beat later and stomp it.
      setPendingRatio(null);
      const r = parseRatio(aspect);
      if (r && !ASPECT_PRESETS.some((p) => p.value === aspect)) {
        setCustomW(String(r.w));
        setCustomH(String(r.h));
      }
    }
  }

  // What Escape restores. Captured when an edit session starts rather than read
  // back from `savedCustom`, because live apply means the "last good" value is
  // whatever was typed a moment ago — Escape has to reach further back, to the
  // ratio the project had before the user touched the pill.
  const revertRef = useRef<{ w: string; h: string; aspect: Aspect } | null>(null);
  const beginEditing = () => {
    setCustomMode(true);
    revertRef.current ??= { w: customW, h: customH, aspect: useEditor.getState().aspect };
  };
  const revertCustom = () => {
    setPendingRatio(null);
    const snapshot = revertRef.current;
    revertRef.current = null;
    if (!snapshot) return;
    setCustomW(snapshot.w);
    setCustomH(snapshot.h);
    if (useEditor.getState().aspect !== snapshot.aspect) {
      useEditor.getState().setAspect(snapshot.aspect);
    }
  };
  // Leaving the pill ends the session. Whatever is typed has already been applied
  // live, so this only remembers the spelling and puts the fields back when they
  // hold something that never applied — the pill never sits showing a ratio the
  // project doesn't have.
  const endEditing = () => {
    revertRef.current = null;
    if (customNormalized) {
      setSavedCustom(`${customW}:${customH}`);
      return;
    }
    setPendingRatio(null);
    const r = parseRatio(useEditor.getState().aspect);
    if (r) {
      setCustomW(String(r.w));
      setCustomH(String(r.h));
    }
  };
  const commitCustom = () => {
    setPendingRatio(null);
    if (customNormalized) applyRatio(`${customW}:${customH}`);
    endEditing();
  };

  // "Move to Cloud" (cut-web-mode flag): copies this local project — doc and
  // every media file — to the cloud, deletes the local original, and reopens
  // the editor on the cloud copy.
  const webMode = useWebMode();
  const cutMode = useCutMode();
  const canMoveToCloud = webMode && cutMode === "local";
  // Cloud imports are real uploads worth reporting; local imports are instant
  // disk copies, so the flag-off surface stays exactly as it was.
  const cloudUploading = uploading > 0 && cutMode === "cloud";
  // Uploads settle in bursts; refresh the storage pill's number when a burst
  // ends. Only the settling edge counts — on mount nothing has landed yet.
  const queryClient = useQueryClient();
  const wasUploading = useRef(false);
  useEffect(() => {
    if (wasUploading.current && !cloudUploading) {
      void queryClient.invalidateQueries({ queryKey: cloudUsageQueryKey });
    }
    wasUploading.current = cloudUploading;
  }, [cloudUploading, queryClient]);
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
        {(() => {
          const aspectMenu = (
            <DropdownMenuContent align="start" className="w-56">
              {ASPECT_PRESETS.map((p) => (
                <DropdownMenuItem
                  key={p.value}
                  onClick={() => {
                    useEditor.getState().setAspect(p.value);
                    setCustomMode(false);
                  }}
                >
                  <AspectIcon aspect={p.value} />
                  <span className="flex-1">
                    {p.name} · {p.value}
                    {p.sublabel && (
                      <span className="block text-[10.5px] text-muted-foreground">{p.sublabel}</span>
                    )}
                  </span>
                  {!showCustomEditor && aspect === p.value && (
                    <Check className="size-3.5 text-muted-foreground" />
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onClick={() => {
                  setCustomMode(true);
                  // Picking Custom returns to the remembered ratio right away.
                  if (customNormalized) useEditor.getState().setAspect(customNormalized);
                }}
              >
                <Ratio />
                <span className="flex-1">
                  {normalizeAspect(savedCustom) ? `Custom · ${savedCustom}` : "Custom…"}
                </span>
                {showCustomEditor && <Check className="size-3.5 text-muted-foreground" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          );
          return showCustomEditor ? (
            <div
              className={cn(
                "aspect-switch flex items-center gap-1 rounded-full border bg-card px-3 py-1.5 text-xs font-medium shadow-xs",
                customInvalid ? "border-destructive text-destructive" : "border-border"
              )}
              title={customInvalid ? "Up to an 8:1 shape" : undefined}
              // The session ends when focus leaves the pill entirely. Moving
              // between the two fields (or to the chevron) stays inside it, so a
              // half-typed side is never settled out from under the user.
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) endEditing();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCustom();
                if (e.key === "Escape") revertCustom();
              }}
            >
              <Ratio className="size-3.5 text-muted-foreground" />
              <input
                aria-label="Width"
                aria-invalid={customInvalid}
                inputMode="decimal"
                className="w-10 bg-transparent text-center outline-none"
                value={customW}
                onFocus={beginEditing}
                onChange={(e) => {
                  const v = ratioInput(e.target.value);
                  setCustomW(v);
                  setPendingRatio(`${v}:${customH}`);
                }}
              />
              <span className="text-muted-foreground">:</span>
              <input
                aria-label="Height"
                aria-invalid={customInvalid}
                inputMode="decimal"
                className="w-10 bg-transparent text-center outline-none"
                value={customH}
                onFocus={beginEditing}
                onChange={(e) => {
                  const v = ratioInput(e.target.value);
                  setCustomH(v);
                  setPendingRatio(`${customW}:${v}`);
                }}
              />
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Aspect ratio presets"
                  className="grid place-items-center text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ChevronDown className="size-3" />
                </DropdownMenuTrigger>
                {aspectMenu}
              </DropdownMenu>
            </div>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger className="aspect-switch flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:text-foreground">
                <AspectIcon aspect={aspect} className="size-3.5" />
                {aspectLabel(aspect)}
                <ChevronDown className="size-3" />
              </DropdownMenuTrigger>
              {aspectMenu}
            </DropdownMenu>
          );
        })()}
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
        <StoragePill />
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
          // Our own tooltip, not the `title` attribute: the button's label is
          // just "Cloud", and the browser's native tooltip waits a beat before
          // saying what it does.
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Move to Cloud"
                    onClick={() => setMoveOpen(true)}
                  >
                    <CloudUpload data-icon="inline-start" /> Cloud
                  </Button>
                }
              />
              <TooltipContent side="bottom">Move to Cloud</TooltipContent>
            </Tooltip>
          </TooltipProvider>
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
