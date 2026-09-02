"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronLeft, CloudUpload, Loader2, Mic, Monitor, MoreHorizontal, Ratio, Share2, Smartphone, Sparkles, Square, Upload, Video } from "lucide-react";
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
import { browserBackend } from "@/cut/lib/backend/browser";
import { localBackend } from "@/cut/lib/backend/local";
import { clearProjectThreads } from "@/cut/lib/chatThreads";
import { retryUpload } from "@/cut/lib/importQueue";
import { backTarget, projectHref, useCutBase } from "@/cut/lib/nav";
import { copyProjectAcross } from "@/cut/lib/projectCopy";
import { projectDuration, useEditor } from "@/cut/lib/store";
import { useLocalPref } from "@/cut/lib/uiState";
import { ASPECT_PRESETS, aspectLabel, aspectOrientation, normalizeAspect, parseRatio, type Aspect } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { CreditsPill } from "./CreditsPill";
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
  copying = 0,
}: {
  onImport: (files: File[], opts?: { origin?: "recording" }) => void;
  from?: string | null;
  folder?: string | null;
  /** Media files currently importing; on a cloud project the save indicator
   * reports them ("Uploading") — those are real network uploads, not local
   * disk copies. */
  uploading?: number;
  /** Library files copying into the project on the cloud's own shelf; the
   * bytes never touch this browser, so the indicator calls it a copy. */
  copying?: number;
}) {
  const base = useCutBase();
  const back = backTarget(base, from, folder);
  // Something to render, which footage is only one way to have: a cut of
  // titles and shapes over the background frame exports like any other.
  const hasPicture = useEditor((s) => projectDuration(s) > 0);
  const aspect = useEditor((s) => s.aspect);
  const projectName = useEditor((s) => s.projectName);
  const saveState = useEditor((s) => s.saveState);
  const aiOpen = useEditor((s) => s.aiOpen);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [recordMode, setRecordMode] = useState<RecordMode | null>(null);
  // The right-hand actions step down as the bar tightens: full labels →
  // icon-only Share/Cloud/Export → everything in a … menu. The credits and
  // storage pills never fold. Which step fits is measured against hidden copies of the
  // full and compact rows, because the visible row can't report a width it
  // isn't showing. Every measured box is content-sized — none of them depend
  // on the chosen step — so the measurement can't feed back into itself.
  const headerRef = useRef<HTMLElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const middleRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const fullRowRef = useRef<HTMLDivElement>(null);
  const compactRowRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<"full" | "compact" | "menu">("full");
  useEffect(() => {
    const boxes = [
      headerRef.current,
      leftRef.current,
      middleRef.current,
      pillRef.current,
      fullRowRef.current,
      compactRowRef.current,
    ];
    if (boxes.some((el) => !el)) return;
    const [header, left, middle, pill, fullRow, compactRow] = boxes as HTMLElement[];
    const refit = () => {
      // The fixed seams around the actions: the two spacers' min-w-2 (16),
      // the pill↔actions gap-2 (8), and the bar's pr-3 inset (12).
      const room =
        header.clientWidth -
        left.offsetWidth -
        middle.offsetWidth -
        pill.offsetWidth -
        36;
      setFit(
        fullRow.offsetWidth <= room
          ? "full"
          : compactRow.offsetWidth <= room
            ? "compact"
            : "menu"
      );
    };
    refit();
    // The header for the window resizing; the rest for their contents
    // changing — the project name, the custom-aspect editor, the pill and
    // buttons that come and go with the project's backend.
    const ro = new ResizeObserver(refit);
    boxes.forEach((el) => ro.observe(el!));
    return () => ro.disconnect();
  }, []);
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

  // "Move to Cloud": copies this local or browser project — doc and every
  // media file — to the cloud, deletes the original, and reopens the editor on
  // the cloud copy.
  const cutMode = useCutMode();
  const canMoveToCloud = cutMode === "local" || cutMode === "browser";
  // Cloud imports are real uploads worth reporting; local imports are instant
  // disk copies, so they report nothing.
  const cloudUploading = (uploading > 0 || copying > 0) && cutMode === "cloud";
  const transferLabel =
    uploading > 0
      ? uploading === 1
        ? "Uploading"
        : `Uploading ${uploading} files`
      : copying === 1
        ? "Copying"
        : `Copying ${copying} files`;
  const finishingLabel = uploading > 0 ? "Finishing uploads…" : "Finishing copies…";
  // An import whose bytes never landed is absent from the saved document, so
  // its clip disappears on the next open. The Media panel shows this for a
  // dropped file, but a stock or library import lives on the timeline and has
  // no tile there — the save indicator is the one place every import reports.
  const failedImports = useEditor((s) => s.assets.filter((a) => a.upload?.error).length);
  const retryFailedImports = () => {
    for (const a of useEditor.getState().assets) if (a.upload?.error) retryUpload(a.id);
  };
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
      const src = cutMode === "browser" ? browserBackend : localBackend;
      const newId = await copyProjectAcross(src, cloudBackend, projectId, {
        onProgress: (done, total) => setMoveProgress(`Moving media ${done}/${total}…`),
      });
      await src
        .fetch(`/api/cut/projects/${projectId}`, { method: "DELETE" })
        .catch(() => {});
      // The chat history moved with the project; the old project's copy goes
      // with the project itself.
      clearProjectThreads(projectId);
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

  // One set of actions rendered both ways: labelled, and icon-only when the
  // bar tightens. Chat keeps its label in both — it is the primary control.
  const actionButtons = (compact: boolean) => (
    <>
      {(cutMode === "cloud" || cutMode === "browser") && (
        // Shares are served from the cloud, so for a browser project the
        // Share button leads to the move that makes sharing possible.
        <Button
          variant="ghost"
          size={compact ? "icon-sm" : "sm"}
          aria-label="Share"
          title={cutMode === "browser" ? "Move to Cloud to share" : "Share"}
          onClick={() => (cutMode === "browser" ? setMoveOpen(true) : setShareOpen(true))}
        >
          <Share2 data-icon={compact ? undefined : "inline-start"} />
          {!compact && "Share"}
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
                  size={compact ? "icon-sm" : "sm"}
                  aria-label="Move to Cloud"
                  onClick={() => setMoveOpen(true)}
                >
                  <CloudUpload data-icon={compact ? undefined : "inline-start"} />
                  {!compact && "Cloud"}
                </Button>
              }
            />
            <TooltipContent side="bottom">Move to Cloud</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <Button
        variant="ghost"
        size={compact ? "icon-sm" : "sm"}
        aria-label="Export"
        // A render reads the saved document, which an import still uploading
        // (or one that failed) is deliberately absent from — exporting now
        // would quietly leave it out of the video.
        disabled={!hasPicture || cloudUploading || failedImports > 0}
        title={
          failedImports > 0
            ? "Retry the failed imports first"
            : cloudUploading
              ? finishingLabel
              : compact
                ? "Export"
                : undefined
        }
        onClick={() => {
          const s = useEditor.getState();
          s.setPlaying(false);
          s.setExportOpen(true);
        }}
      >
        <Upload data-icon={compact ? undefined : "inline-start"} />
        {!compact && "Export"}
      </Button>
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
    </>
  );

  return (
    // One flex row — left group, switches, right rail — with a stretching
    // spacer either side of the switches. With room to spare the spacers
    // match and the switches sit centred; as the bar tightens they drift
    // toward whichever side has slack instead of colliding with the rail.
    <header ref={headerRef} className="relative flex items-center border-b border-border bg-card">
      <div ref={leftRef} className="flex shrink-0 items-center gap-1 pl-2">
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
          {failedImports > 0 ? (
            <>
              <span className="text-destructive">
                {failedImports === 1 ? "1 import failed" : `${failedImports} imports failed`}
              </span>
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                onClick={retryFailedImports}
              >
                Retry
              </button>
            </>
          ) : cloudUploading ? (
            <>
              <Loader2 className="size-3 animate-spin" />{" "}
              {transferLabel}
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
      <div className="min-w-2 flex-1" />
      <div ref={middleRef} className="flex shrink-0 items-center gap-2">
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
      <div className="min-w-2 flex-1" />
      {/* No clipping on the rail: stepping down is what keeps it inside the
          bar, and the hidden measuring rows need no help staying out of
          sight. Clipping would only shave the focus ring off the last
          button. */}
      <div className="flex shrink-0 items-center gap-2 pr-3">
        <div ref={pillRef} className="flex items-center gap-2">
          <CreditsPill />
          <StoragePill />
        </div>
        <div className="relative flex items-center">
          {/* Inert copies of the labelled and icon-only rows, held out of the
              flow; their natural widths are what the fit measurement reads. */}
          <div
            ref={fullRowRef}
            inert
            aria-hidden
            className="invisible absolute right-0 flex items-center gap-2"
          >
            {actionButtons(false)}
          </div>
          <div
            ref={compactRowRef}
            inert
            aria-hidden
            className="invisible absolute right-0 flex items-center gap-2"
          >
            {actionButtons(true)}
          </div>
          {fit !== "menu" ? (
            <div className="flex items-center gap-2">{actionButtons(fit === "compact")}</div>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions" />}
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {cutMode === "cloud" && (
                  <DropdownMenuItem onClick={() => setShareOpen(true)}>
                    <Share2 /> Share
                  </DropdownMenuItem>
                )}
                {canMoveToCloud && (
                  <DropdownMenuItem onClick={() => setMoveOpen(true)}>
                    <CloudUpload /> Move to Cloud
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={!hasPicture || cloudUploading}
                  onClick={() => {
                    const s = useEditor.getState();
                    s.setPlaying(false);
                    s.setExportOpen(true);
                  }}
                >
                  <Upload /> {cloudUploading ? finishingLabel : "Export"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    const s = useEditor.getState();
                    s.setAiOpen(!s.aiOpen);
                  }}
                >
                  <Sparkles />
                  <span className="flex-1">Chat</span>
                  {aiOpen && <Check className="size-3.5 text-muted-foreground" />}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
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
              from {cutMode === "browser" ? "this browser" : "this Mac"}.
              Exports rendered here stay behind.
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
