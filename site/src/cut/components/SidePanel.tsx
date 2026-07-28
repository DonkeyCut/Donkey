"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Captions, Check, Clapperboard, ClipboardList, Copy, Download, Ellipsis, Film, FolderOpen, FolderPlus, Image as ImageIcon, Loader2, Music, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiveElapsed } from "@/cut/components/Elapsed";
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
import { SectionTitle } from "@/cut/components/SectionTitle";
import { Slider } from "@/components/ui/slider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { apiFetch, apiUrl } from "@/cut/lib/backend";
import { useCutCaps } from "@/cut/lib/backend/hooks";
import {
  clearAssetDrag,
  draggingLibrary,
  draggingTemplate,
  hasLibraryDrag,
  hasTemplateDrag,
  setAssetDragData,
  setCardDragImage,
} from "@/cut/lib/assetDrag";
import { draggingRef, useAssetDrop, type AssetRef } from "@/cut/lib/assetRef";
import { RefDropZone } from "./RefDropZone";
import { deleteExport, downloadProjectExport, revealExport } from "@/cut/lib/exportClient";
import { useExports, useWatchExportLands, type ExportJob } from "@/cut/lib/exportStore";
import { useElapsed } from "@/cut/hooks/useElapsed";
import { useInView } from "@/cut/hooks/useInView";
import {
  addAssetToLibraryTemplate,
  addLibraryAssetToProject,
  addProjectTemplateToTimeline,
  addTemplateToProject,
  deleteFromLibrary,
  deleteLibraryFolder,
  deleteTemplate,
  fetchLibrary,
  importLibraryAsset,
  importTemplateToProject,
  libraryMediaUrl,
  moveLibraryItem,
  renameLibraryFolder,
  renameTemplate,
  saveAssetToLibrary,
  saveTemplate,
  uploadToLibrary,
  type LibraryAsset,
  type LibraryFolder,
  type LibraryTemplateItem,
} from "@/cut/lib/library";
import { activeResidency, availableResidencies, type Residency } from "@/cut/lib/residency";
import { retryUpload } from "@/cut/lib/importQueue";
import { isMediaFile, revealMedia } from "@/cut/lib/media";
import { mediaUrl, TRANSITION_MAX } from "@/cut/lib/types";
import { genPulseOverlay, isGenTab, useGenNotify, useGenPulse, useWatchGenTab } from "@/cut/lib/genNotify";
import { CAPTION_LIMIT, normalizeTags } from "@/cut/lib/publish";
import { useEditor } from "@/cut/lib/store";
import { formatTime } from "@/cut/lib/time";
import { useLocalPref } from "@/cut/lib/uiState";
import type { MediaAsset } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { useRevealEffect, useRevealFlash } from "@/cut/lib/refReveal";
import { usePanelRequestEffect, type SidePanelTab } from "@/cut/lib/panelRequest";
import { CopyNameLabel } from "./AssetRefs";
import { AudioCardFace, AudioPanel } from "./AudioPanel";
import { FolderCrumb, FolderShelf } from "./desktopFolders";
import { TemplateCard } from "./TemplateCard";
import { GenerateVideoPanel } from "./GeneratePanel";
import { ImageGenPanel } from "./ImageGenPanel";
import { StockImagesPanel } from "./StockImagesPanel";
import { SampleLibrary } from "./StockMusicPanel";
import { StockVideosPanel } from "./StockVideosPanel";
import { STOCK_MUSIC } from "@/cut/lib/stockMusicManifest";
import { STOCK_VIDEOS } from "@/cut/lib/stockVideoManifest";
import { LibraryCard, ShelfBadge } from "./LibraryView";

// Drag a library clip onto a folder tile to file it (side panel, single card).
const LIBRARY_MOVE_MIME = "application/x-cut-library-move";
import { PlatformPreviewDialog, type ExportItem } from "./PlatformPreview";
import { SubtitlesPanel } from "./SubtitlesPanel";

type Tab = SidePanelTab;

const TABS: { id: Tab; label: string; icon: typeof Film }[] = [
  { id: "media", label: "Media", icon: Clapperboard },
  { id: "library", label: "Library", icon: FolderOpen },
  { id: "video", label: "Video", icon: Film },
  { id: "image", label: "Image", icon: ImageIcon },
  { id: "audio", label: "Audio", icon: Music },
  { id: "subtitles", label: "Subtitles", icon: Captions },
  { id: "publish", label: "Details", icon: ClipboardList },
];

export function SidePanel({
  projectId,
  onImport,
  importing,
}: {
  projectId: string;
  onImport: (files: FileList | File[], opts?: { mediaOnly?: boolean }) => void;
  importing: boolean;
}) {
  // A shared view shows only the surfaces the share opted in; the Library is
  // the viewer's own cross-project shelf and never appears there.
  const sharedFeatures = useEditor((s) => s.sharedFeatures);
  const visibleTabs = !sharedFeatures
    ? TABS
    : TABS.filter(({ id }) =>
        id === "media"
          ? sharedFeatures.media
          : id === "video" || id === "image" || id === "audio"
            ? sharedFeatures.genai
            : id === "subtitles"
              ? sharedFeatures.subtitles
              : id === "publish"
                ? sharedFeatures.details
                : false
      );
  // `null` collapses the panel: clicking the active tab unselects it, leaving
  // just the icon rail so the video canvas takes the freed width.
  const [tabPref, setTab] = useLocalPref<Tab | null>("cut-side-tab", "media", (v) =>
    v === null || TABS.some((t) => t.id === v)
  );
  // The remembered tab may be hidden in this share; fall back to collapsed.
  const tab = tabPref !== null && !visibleTabs.some((t) => t.id === tabPref) ? null : tabPref;
  // The Audio tab's Voice/Music sub-tab lives here so the Music sub-tab can lay
  // out as two columns — the generator plus the sample library — like Image/Video.
  const [audioSub, setAudioSub] = useLocalPref<"voice" | "music">(
    "cut-audio-subtab",
    "voice",
    (v) => v === "voice" || v === "music"
  );
  // Rail tiles as drop targets: a Library card (asset or template) dropped on
  // Media joins the project; a Media card dropped on Library saves it there.
  // Project media (cards and timeline clips) arrives through the ref zones
  // below; these HTML5 handlers cover the library-asset and template drags.
  const [dropTab, setDropTab] = useState<Tab | null>(null);
  const acceptsDrop = (id: Tab, e: React.DragEvent) => {
    const tpl = hasTemplateDrag(e) ? draggingTemplate() : null;
    if (id === "media") return hasLibraryDrag(e) || tpl?.scope === "library";
    if (id === "library") return tpl?.scope === "project";
    return false;
  };
  // A project asset dropped on a rail tile — from a Media card or dragged
  // straight off the timeline: Media reveals it in the panel (clears its
  // origin tag), Library saves a copy to the shared library.
  const dropRefOnTab = (id: Tab, ref: AssetRef) => {
    if (ref.scope !== "project") return;
    if (id === "media") {
      useEditor.getState().updateAsset(ref.id, { origin: undefined, chatId: undefined });
    } else {
      const asset = useEditor.getState().assets.find((a) => a.id === ref.id);
      if (asset) void saveAssetToLibrary(projectId, asset);
    }
  };
  // Generations that finished while their tab was closed: a blue count rides
  // the rail icon, and opening the tab lets the new tiles pulse for a beat.
  const unseen = useGenNotify((s) => s.unseen);
  useWatchGenTab(tab, projectId);
  // Media badges too: its arrivals are exports finishing in the background.
  useWatchExportLands(projectId);
  // While one of this project's exports renders, the Media tile spins — the
  // export row lives in that panel, which is usually closed while it runs.
  const exporting = useExports(
    (s) =>
      s.jobs.some(
        (j) => j.projectId === projectId && (j.status === "queued" || j.status === "running")
      ) || s.local.some((r) => r.projectId === projectId && r.status === "preparing")
  );

  // Clicking a reference token anywhere jumps here: switch to the tab that
  // owns the asset; the matching card scrolls into view and flashes.
  useRevealEffect((ref) => {
    setTab(
      ref.scope === "project"
        ? "media"
        : ref.scope === "library"
          ? "library"
          : STOCK_VIDEOS.some((v) => v.id === ref.id)
            ? "video"
            : "image"
    );
  });

  // The assistant's set_side_panel tool: open the tab it wants on screen, or
  // collapse the panel so the canvas gets the room.
  usePanelRequestEffect(setTab);

  return (
    <div className="flex min-h-0 border-r border-border bg-card">
      {/* Icon rail — its divider drops when collapsed so the panel's outer
          border becomes the single line between the rail and the canvas. */}
      <div
        className={cn(
          "flex min-h-0 w-[68px] shrink-0 flex-col items-center gap-1 overflow-y-auto py-3",
          tab !== null && "border-r border-border"
        )}
      >
        {visibleTabs.map(({ id, label, icon: Icon }, tabIndex) => {
          // The open tab never badges — its completions are already on screen.
          const unseenCount = isGenTab(id) && id !== tab ? unseen[id].length : 0;
          const tileClass =
            "flex shrink-0 flex-col items-center gap-1 rounded-lg px-2 py-1.5 text-muted-foreground transition-colors hover:text-foreground";
          const inner = (
            <>
              <span
                className={cn(
                  "relative grid size-9 place-items-center rounded-lg transition-colors",
                  tab === id ? "bg-muted text-foreground" : "hover:bg-muted/60",
                  dropTab === id && "bg-primary/15 text-primary"
                )}
              >
                <Icon className="size-4.5" />
                {unseenCount > 0 ? (
                  <span className="absolute -top-1 -right-1 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-[#0a84ff] px-1 text-[9px] leading-none font-semibold text-white tabular-nums ring-2 ring-card">
                    {unseenCount}
                  </span>
                ) : id === "media" && exporting ? (
                  <span className="absolute -top-1 -right-1 grid size-[15px] place-items-center rounded-full bg-card ring-2 ring-card">
                    <Loader2 className="size-3 animate-spin text-primary" />
                  </span>
                ) : null}
              </span>
              <span className={cn("text-[10px] font-medium", tab === id && "text-foreground")}>
                {label}
              </span>
            </>
          );

          const tile = (
            <button
              className={tileClass}
              aria-pressed={tab === id}
              onClick={() => setTab(tab === id ? null : id)}
              onDragOver={(e) => {
                if (!acceptsDrop(id, e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropTab(id);
              }}
              onDragLeave={() => setDropTab((d) => (d === id ? null : d))}
              onDrop={(e) => {
                if (!acceptsDrop(id, e)) return;
                e.preventDefault();
                setDropTab(null);
                const tpl = draggingTemplate();
                if (id === "media") {
                  if (tpl?.scope === "library") void importTemplateToProject(projectId, tpl.template);
                  else {
                    const lib = draggingLibrary();
                    if (lib) void importLibraryAsset(projectId, lib);
                  }
                } else if (tpl?.scope === "project") {
                  void saveTemplate(projectId, tpl.template);
                }
                clearAssetDrag();
              }}
            >
              {inner}
            </button>
          );

          return (
            <Fragment key={id}>
              {/* Soft breaks between the file tabs, the AI-generate tabs, and the finishing tabs. */}
              {(id === "video" || id === "subtitles") && tabIndex > 0 && (
                <div aria-hidden className="my-1 h-px w-8 shrink-0 bg-border" />
              )}
              {id === "media" || id === "library" ? (
                <RefDropZone
                  onRef={(ref) => dropRefOnTab(id, ref)}
                  className="shrink-0 rounded-lg"
                  activeClassName="bg-primary/10"
                >
                  {tile}
                </RefDropZone>
              ) : (
                tile
              )}
            </Fragment>
          );
        })}
      </div>

      {tab === null ? null : tab === "image" || tab === "video" ? (
        // The generate tabs are two columns: the generate input on the left,
        // the stock reference browser on the right. Clicking a stock tile loads
        // its prompt into the generate panel beside it.
        <>
          <div
            className={cn(
              "flex w-[252px] min-h-0 shrink-0 flex-col",
              !sharedFeatures && "border-r border-border"
            )}
          >
            {tab === "image" ? (
              <ImageGenPanel projectId={projectId} />
            ) : (
              <GenerateVideoPanel projectId={projectId} />
            )}
          </div>
          {/* Video browses wider: 16:9 clip tiles need the room. A shared view
              shows only the project's own generations — no stock browsing. */}
          {!sharedFeatures && (
            <div
              className={cn(
                "flex min-h-0 shrink-0 flex-col",
                tab === "image" ? "w-[264px]" : "w-[340px]"
              )}
            >
              {tab === "image" ? <StockImagesPanel /> : <StockVideosPanel />}
            </div>
          )}
        </>
      ) : tab === "audio" ? (
        // Music is two columns like the generate tabs — the generator on the
        // left, the sample library on the right; Voice is a single column.
        <>
          <div
            className={cn(
              "flex w-[264px] min-h-0 shrink-0 flex-col",
              !sharedFeatures && audioSub === "music" && STOCK_MUSIC.length > 0 && "border-r border-border"
            )}
          >
            <AudioPanel
              projectId={projectId}
              importing={importing}
              sub={audioSub}
              onSub={setAudioSub}
            />
          </div>
          {!sharedFeatures && audioSub === "music" && STOCK_MUSIC.length > 0 && (
            <div className="flex w-[340px] min-h-0 shrink-0 flex-col">
              <SampleLibrary projectId={projectId} />
            </div>
          )}
        </>
      ) : (
        <div className="flex w-[264px] min-h-0 shrink-0 flex-col">
          {tab === "media" && (
            <MediaPanel projectId={projectId} onImport={onImport} importing={importing} />
          )}
          {tab === "library" && <LibraryPanel projectId={projectId} />}
          {tab === "subtitles" && <SubtitlesPanel />}
          {tab === "publish" && <PublishPanel />}
        </div>
      )}
    </div>
  );
}

type DragProps = Pick<
  React.HTMLAttributes<HTMLElement>,
  "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"
>;

/** Narrow a whole-panel drop zone to the drags it can take: OS files, plus the
 * refs `takesRef` accepts. Without this a card dragged out of the panel — on
 * its way to the timeline — would light the panel it came from. */
function forDrags(props: DragProps, takesRef: (ref: AssetRef) => boolean): DragProps {
  const ok = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) return true;
    const ref = draggingRef();
    return !!ref && takesRef(ref);
  };
  return {
    onDragEnter: (e) => {
      if (ok(e)) props.onDragEnter?.(e);
    },
    onDragOver: (e) => {
      if (ok(e)) props.onDragOver?.(e);
    },
    onDragLeave: (e) => {
      if (ok(e)) props.onDragLeave?.(e);
    },
    onDrop: (e) => {
      if (ok(e)) props.onDrop?.(e);
    },
  };
}

function PanelHead({ title }: { title: string }) {
  return (
    <div className="flex h-12 shrink-0 items-center pr-2.5 pl-4">
      <span className="text-sm font-semibold tracking-tight">{title}</span>
    </div>
  );
}

/** Fresh-arrival ring for an export row that landed while the tab was closed. */
function ExportPulse({ file }: { file: string }) {
  const pulse = useGenPulse("media", file);
  return pulse ? <div aria-hidden className={genPulseOverlay} /> : null;
}

/** A queued or still-rendering export in the Exports list: spinner, live
 * progress, and a cancel that stops the render (the dock's X only hides the
 * notification). */
function ExportingRow({ job }: { job: ExportJob }) {
  const elapsed = useElapsed(job.status === "running" ? job.startedAt ?? null : null);
  const pct = Math.round(job.progress * 100);
  return (
    <div className="relative flex w-full items-center gap-2.5 overflow-hidden rounded-lg border border-border p-1.5">
      <div className="grid h-11 w-[25px] shrink-0 place-items-center rounded-[4px] bg-muted">
        <Loader2 className="size-3.5 animate-spin text-primary" />
      </div>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-medium">Exporting…</span>
        <span className="block text-[10.5px] text-muted-foreground tabular-nums">
          {job.status === "running" ? `${pct}%${elapsed ? ` · ${elapsed}` : ""}` : "Queued"}
        </span>
      </span>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => useExports.getState().cancel(job.id)}
      >
        Cancel
      </Button>
      {job.status === "running" && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-secondary">
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function MediaPanel({
  projectId,
  onImport,
  importing,
}: {
  projectId: string;
  onImport: (files: FileList | File[], opts?: { mediaOnly?: boolean }) => void;
  importing: boolean;
}) {
  const caps = useCutCaps();
  // Only user-imported media lives here; anything Cut created (recordings, AI
  // generations, voiceovers, freeze frames, stock adds) is tagged with an
  // `origin` and stays where it was made.
  const assets = useEditor((s) => s.assets).filter((a) => a.origin == null);
  const templates = useEditor((s) => s.templates);
  const exportOpen = useEditor((s) => s.exportOpen);
  // A render that finishes in the background (dialog closed) drops a new file in
  // the exports folder; re-read the list when it lands so it shows without a
  // manual refresh.
  // Refetch the finished-file list whenever an export for this project settles
  // (its file lands in the exports folder). Counting settled jobs gives a value
  // that changes exactly on that transition.
  const exportsSettled = useExports(
    (s) =>
      s.jobs.filter(
        (j) => j.projectId === projectId && (j.status === "done" || j.status === "error")
      ).length
  );
  // This project's exports still in flight: queued/running jobs plus the brief
  // client-only "preparing" window before the engine hands back a job id.
  const exportJobs = useExports((s) => s.jobs);
  const exportLocal = useExports((s) => s.local);
  const exporting = exportJobs.filter(
    (j) => j.projectId === projectId && (j.status === "queued" || j.status === "running")
  );
  const preparing = exportLocal.filter(
    (r) => r.projectId === projectId && r.status === "preparing"
  );
  const readOnly = useEditor((s) => s.readOnly);
  // The whole panel takes drops: OS files import into this project and stay off
  // the timeline, and a project asset made elsewhere (a generation, a
  // recording) dropped here moves into Media. It lights up for both.
  const { active: dropActive, attachTarget, targetProps } = useAssetDrop(
    (ref) => {
      if (ref.scope === "project")
        useEditor.getState().updateAsset(ref.id, { origin: undefined, chatId: undefined });
    },
    readOnly ? undefined : (files) => onImport(files, { mediaOnly: true })
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const [exports, setExports] = useState<ExportItem[]>([]);
  const [preview, setPreview] = useState<ExportItem | null>(null);
  const [deletingExport, setDeletingExport] = useState<ExportItem | null>(null);

  // Refresh the list on open, when the export dialog closes, and when a
  // background render settles (done/error).
  useEffect(() => {
    if (exportOpen) return;
    let alive = true;
    void apiFetch(`/api/cut/projects/${projectId}/exports`)
      .then((r) => (r.ok ? (r.json() as Promise<ExportItem[]>) : []))
      .then((list) => alive && setExports(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId, exportOpen, exportsSettled]);

  const removeExport = async () => {
    const it = deletingExport;
    if (!it) return;
    setDeletingExport(null);
    try {
      await deleteExport(projectId, it.file);
    } catch {
      // Fall through and re-read the folder so the list mirrors disk truth
      // (a failed delete stays visible rather than reappearing later).
    }
    const list = await apiFetch(`/api/cut/projects/${projectId}/exports`)
      .then((r) => (r.ok ? (r.json() as Promise<ExportItem[]>) : []))
      .catch(() => [] as ExportItem[]);
    setExports(list);
    if (preview && !list.some((e) => e.file === preview.file)) setPreview(null);
  };

  return (
    <div
      ref={attachTarget}
      {...forDrags(
        targetProps,
        // Only media made elsewhere — a generation, a recording — moves in here;
        // the panel's own cards are already Media.
        (ref) =>
          ref.scope === "project" &&
          useEditor.getState().assets.find((a) => a.id === ref.id)?.origin != null
      )}
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        dropActive &&
          "rounded-xl bg-[#0a84ff]/5 outline-2 outline-dashed outline-offset-[-4px] outline-[#0a84ff]/60"
      )}
    >
      {/* An export in flight spins on the Media rail tile, not here. */}
      <PanelHead title="Media" />
      {!readOnly && (
        <div className="px-3.5 pb-3">
          <Button variant="outline" className="w-full" onClick={() => inputRef.current?.click()}>
            <Upload data-icon="inline-start" /> Upload
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="video/*,audio/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) onImport(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pb-3.5">
        {templates.length > 0 && (
          <div className="flex flex-col gap-1.5 px-3.5 pb-3">
            {templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                mediaSrc={(f) => mediaUrl(projectId, f)}
                drag={{ scope: "project", template: t }}
                addTitle="Add to timeline"
                onAdd={() => addProjectTemplateToTimeline(projectId, t)}
                onRename={(name) => useEditor.getState().renameTemplate(t.id, name)}
                onDelete={() => useEditor.getState().removeTemplate(t.id)}
                onRefDrop={(r) => {
                  if (r.scope === "project") useEditor.getState().addAssetToTemplate(t.id, r.id);
                }}
                extraMenu={
                  <DropdownMenuItem onClick={() => void saveTemplate(projectId, t)}>
                    <FolderPlus /> Add to Library
                  </DropdownMenuItem>
                }
              />
            ))}
          </div>
        )}
        {assets.length === 0 && !importing ? (
          <div className="px-2 py-7 text-center text-xs leading-relaxed text-balance text-muted-foreground">
            <div className="mb-3 flex justify-center gap-3.5">
              <Film className="size-5" />
              <Music className="size-5" />
            </div>
            Drop videos, audio and images assets here. They are only available in
            this project.
          </div>
        ) : (
          <div className="grid grid-cols-2 content-start gap-2.5 px-3.5">
            {assets.map((a) => (
              <AssetCard key={a.id} asset={a} projectId={projectId} />
            ))}
            {importing && (
              <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input text-[11px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span>
                  Importing… <LiveElapsed />
                </span>
              </div>
            )}
          </div>
        )}

        {exports.length + exporting.length + preparing.length > 0 && (
          <div className="mt-5 px-3.5">
            <div className="mb-2 text-[13px] font-semibold tracking-tight">Exports</div>
            <div className="flex flex-col gap-1.5">
              {preparing.map((r) => (
                <div
                  key={r.id}
                  className="flex w-full items-center gap-2.5 rounded-lg border border-border p-1.5"
                >
                  <div className="grid h-11 w-[25px] shrink-0 place-items-center rounded-[4px] bg-muted">
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                  </div>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-medium">Exporting…</span>
                    <span className="block text-[10.5px] text-muted-foreground">Preparing…</span>
                  </span>
                </div>
              ))}
              {exporting.map((j) => (
                <ExportingRow key={j.id} job={j} />
              ))}
              {exports.map((it) => (
                <div
                  key={it.file}
                  className="export-row group relative flex w-full items-center gap-2.5 overflow-hidden rounded-lg border border-border p-1.5 transition-colors hover:border-input hover:bg-muted/50"
                >
                  <ExportPulse file={it.file} />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    title="Preview as a post"
                    onClick={() => setPreview(it)}
                  >
                    <video crossOrigin={MEDIA_CORS}
                      muted
                      playsInline
                      preload="metadata"
                      src={`${apiUrl(`/api/cut/projects/${projectId}/exports/${encodeURIComponent(it.file)}`)}#t=0.1`}
                      className="h-11 w-[25px] shrink-0 rounded-[4px] bg-black object-cover"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] font-medium">
                        {new Date(it.mtime).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="block text-[10.5px] text-muted-foreground">
                        {(it.size / (1024 * 1024)).toFixed(1)} MB · MP4
                      </span>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5 pr-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    {caps.revealInFinder ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Show in Finder"
                        title="Show in Finder"
                        onClick={() => void revealExport(projectId, it.file).catch(() => {})}
                      >
                        <FolderOpen />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Download export"
                        title="Download"
                        onClick={() => downloadProjectExport(projectId, it.file)}
                      >
                        <Download />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Delete export"
                      title="Delete export"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setDeletingExport(it)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {preview && (
        <PlatformPreviewDialog
          projectId={projectId}
          item={preview}
          onClose={() => setPreview(null)}
        />
      )}

      <AlertDialog open={!!deletingExport} onOpenChange={(o) => !o && setDeletingExport(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this export?</AlertDialogTitle>
            <AlertDialogDescription>
              The rendered file leaves the project’s exports folder. Your cut is untouched — you
              can export it again anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={(e) => {
                e.preventDefault();
                void removeExport();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The tile's upload state. The clip is already usable, so this stays out of
 * the way: a line across the bottom of the tile while the bytes go out, and a
 * message only if they don't arrive. */
function UploadState({ asset }: { asset: MediaAsset }) {
  const upload = asset.upload;
  if (!upload) return null;
  if (upload.error) {
    return (
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-black/70 px-1.5 py-1 text-[10px] text-white">
        <span className="min-w-0 flex-1 truncate">Upload failed</span>
        <button
          type="button"
          className="shrink-0 font-medium underline underline-offset-2"
          onClick={(e) => {
            e.stopPropagation();
            retryUpload(asset.id);
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/25">
      <span
        className="block h-full bg-primary transition-[width] duration-150"
        style={{ width: `${Math.round(upload.progress * 100)}%` }}
      />
    </span>
  );
}

function AssetCard({ asset, projectId }: { asset: MediaAsset; projectId: string }) {
  const caps = useCutCaps();
  const [saved, setSaved] = useState(false);
  // Number of timeline items that would be cascade-deleted; null = no prompt.
  const [confirmUses, setConfirmUses] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { flash, attachReveal } = useRevealFlash("project", asset.id);
  // A media-heavy project would open every one of these connections at once;
  // the source waits until the tile has been scrolled near.
  const [tileRef, seen] = useInView<HTMLDivElement>();

  const add = () => {
    const s = useEditor.getState();
    if (asset.type === "video" || asset.type === "image") s.addClipFromAsset(asset.id);
    else s.addAudioFromAsset(asset.id);
  };

  const saveToLibrary = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await saveAssetToLibrary(projectId, asset);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch {
      // Library write failed; nothing to roll back.
    }
  };

  const remove = (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = useEditor.getState();
    const uses =
      s.clips.filter((c) => c.assetId === asset.id).length +
      s.audioClips.filter((c) => c.assetId === asset.id).length;
    // Deleting an unused asset is harmless; only confirm when it would also
    // remove clips from the timeline.
    if (uses > 0) setConfirmUses(uses);
    else s.removeAsset(asset.id);
  };

  return (
    <>
    <div
      ref={attachReveal}
      className="asset-card group flex flex-col gap-1.5 text-left"
      title="Drag onto the timeline, or click + to add"
      draggable
      onDragStart={(e) => {
        setAssetDragData(e, asset.id);
        setCardDragImage(e, e.currentTarget);
      }}
      onDragEnd={clearAssetDrag}
      onMouseEnter={() => {
        void videoRef.current?.play().catch(() => {});
      }}
      onMouseLeave={() => {
        const v = videoRef.current;
        if (v) {
          v.pause();
          v.currentTime = 0.1;
        }
      }}
    >
      <div
        ref={tileRef}
        className={cn(
          "relative aspect-square overflow-hidden rounded-lg border border-border bg-muted transition-colors group-hover:border-input",
          flash && "ring-2 ring-[#0a84ff] ring-offset-1"
        )}
      >
        {asset.type === "video" ? (
          // Native first frame as the poster — full-resolution, no blurry thumb.
          seen && (
            <video crossOrigin={MEDIA_CORS}
              ref={videoRef}
              src={`${asset.url}#t=0.1`}
              preload="metadata"
              muted
              loop
              playsInline
              className="size-full object-cover"
            />
          )
        ) : asset.type === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- engine/static file, not Next-optimizable
          <img crossOrigin={MEDIA_CORS} src={asset.url} alt={asset.name} loading="lazy" className="size-full object-cover" />
        ) : (
          <AudioCardFace
            url={asset.url}
            duration={asset.duration}
            peaks={asset.peaks}
            // On hover the + button takes the pill's corner, as on Library cards.
            durationClassName="transition-opacity group-hover:opacity-0"
          />
        )}
        {asset.type === "video" && (
          <span className="absolute right-1 bottom-1 rounded-[5px] bg-black/65 px-1 py-px font-mono text-[9.5px] text-white tabular-nums">
            {formatTime(asset.duration)}
          </span>
        )}
        <span
          className={cn(
            "absolute flex gap-1 opacity-0 transition-opacity group-hover:opacity-100",
            // Audio keeps play bottom-left; + swaps in where the duration pill hides.
            asset.type === "audio" ? "right-1.5 bottom-2.5" : "top-1 left-1"
          )}
        >
          <span
            role="button"
            title="Add to timeline"
            className="grid size-5 scale-75 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground transition-transform group-hover:scale-100 hover:brightness-110"
            onClick={(e) => {
              e.stopPropagation();
              add();
            }}
          >
            <Plus className="size-3" />
          </span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More actions"
            title="More actions"
            className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/65 data-[state=open]:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            {saved ? <Check className="size-3" /> : <Ellipsis className="size-3" />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={saveToLibrary} disabled={!!asset.upload}>
              <FolderPlus /> Save to library
            </DropdownMenuItem>
            {caps.revealInFinder && (
              <DropdownMenuItem
                onClick={() => void revealMedia(projectId, asset.fileName).catch(() => {})}
              >
                <FolderOpen /> Show in Finder
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={remove}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {asset.type === "audio" && (
          <CopyNameLabel
            name={asset.name}
            dark
            className="absolute top-1.5 left-1.5 max-w-[70%] px-2 py-1 text-[11px] font-medium text-white transition-[max-width] group-hover:max-w-[calc(100%-4.75rem)]"
          />
        )}
        {asset.upload && <UploadState asset={asset} />}
      </div>
      {asset.type !== "audio" && (
        <CopyNameLabel name={asset.name} className="text-[11px] text-muted-foreground" />
      )}
    </div>
    <AlertDialog open={confirmUses !== null} onOpenChange={(o) => !o && setConfirmUses(null)}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove “{asset.name}” from the project?</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            onClick={(e) => {
              e.preventDefault();
              useEditor.getState().removeAsset(asset.id);
              setConfirmUses(null);
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

function LibraryPanel({ projectId }: { projectId: string }) {
  const [assets, setAssets] = useState<LibraryAsset[] | null>(null);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [templates, setTemplates] = useState<LibraryTemplateItem[]>([]);
  const [openFolder, setOpenFolder] = useLocalPref<string | null>(
    "cut-library-folder",
    null,
    (v) => v === null || typeof v === "string"
  );
  const [deleting, setDeleting] = useState<LibraryAsset | null>(null);
  const [uploading, setUploading] = useState(0);

  const reload = () =>
    fetchLibrary()
      .then((d) => {
        setAssets(d.assets);
        setFolders(d.folders);
        setTemplates(d.templates);
      })
      .catch(() => setAssets([]));

  // A remembered folder can vanish between sessions; drop back to the root.
  useEffect(() => {
    if (assets !== null && openFolder !== null && !folders.some((f) => f.id === openFolder))
      setOpenFolder(null);
  }, [assets, folders, openFolder, setOpenFolder]);

  // A revealed library asset may sit inside a folder — open it so the card is
  // on screen to scroll to and flash.
  useRevealEffect((ref) => {
    if (ref.scope !== "library") return;
    const a = (assets ?? []).find((x) => x.id === ref.id);
    if (a) setOpenFolder(a.folderId ?? null);
  });

  const removeTemplate = async (r: Residency, id: string) => {
    setTemplates((prev) => prev.filter((t) => t.id !== id));
    await deleteTemplate(r, id).catch(() => void reload());
  };

  const commitTemplateRename = async (r: Residency, id: string, name: string) => {
    setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
    await renameTemplate(r, id, name).catch(() => void reload());
  };

  useEffect(() => {
    void reload();
  }, []);

  const remove = async () => {
    if (!deleting) return;
    const { id, residency } = deleting;
    setAssets((prev) => (prev ?? []).filter((a) => a.id !== id));
    setDeleting(null);
    try {
      await deleteFromLibrary(residency, id);
    } catch {
      // Server delete failed; pull a fresh list so the UI stays truthful.
      void reload();
    }
  };

  // Every item carries its shelf; a folder belongs to one, so an item only
  // files into a folder on the same shelf.
  const shelfOf = (id: string): Residency | null =>
    (assets ?? []).find((a) => a.id === id)?.residency ??
    templates.find((t) => t.id === id)?.residency ??
    null;

  const move = async (id: string, folderId: string | null) => {
    const residency = shelfOf(id);
    if (!residency) return;
    if (folderId && folders.find((f) => f.id === folderId)?.residency !== residency) return;
    setAssets((prev) => (prev ?? []).map((a) => (a.id === id ? { ...a, folderId } : a)));
    setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, folderId } : t)));
    await moveLibraryItem(residency, id, folderId).catch(() => void reload());
  };

  // New items land on the open folder's shelf, or on the bound backend at the
  // root — the same rule the full-page library follows.
  const shelfForNew = (folderId: string | null) =>
    (folderId ? folders.find((f) => f.id === folderId)?.residency : null) ?? activeResidency();

  const upload = async (files: FileList | File[], folderId: string | null = openFolder) => {
    const list = Array.from(files).filter(isMediaFile);
    if (list.length === 0) return;
    const residency = shelfForNew(folderId);
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const asset = await uploadToLibrary(file, residency);
        if (folderId) {
          await moveLibraryItem(residency, asset.id, folderId).catch(() => {});
          asset.folderId = folderId;
        }
        setAssets((prev) => [asset, ...(prev ?? [])]);
      } catch {
        // Skip unreadable files; the rest of the batch still uploads.
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  // The whole panel takes drops: OS files upload to the shared library (into
  // the open folder), and project media dropped here is saved to it.
  const { active: dropActive, attachTarget, targetProps } = useAssetDrop(
    (ref) => {
      if (ref.scope !== "project") return;
      const asset = useEditor.getState().assets.find((a) => a.id === ref.id);
      if (!asset) return;
      void saveAssetToLibrary(projectId, asset)
        .then(() => void reload())
        .catch(() => {});
    },
    (files) => void upload(files)
  );

  // Let a clip be dragged onto a folder tile to file it (alongside the timeline
  // drag payload the card already sets). The ghost is the card itself.
  const onCardDragExtra = (e: React.DragEvent, a: LibraryAsset) => {
    e.dataTransfer.setData(LIBRARY_MOVE_MIME, JSON.stringify([a.id]));
    e.dataTransfer.effectAllowed = "copyMove";
    setCardDragImage(e, e.currentTarget as HTMLElement);
  };

  const all = assets ?? [];
  const bothShelves = availableResidencies().length > 1;
  const shown = all.filter((a) => (a.folderId ?? null) === openFolder);
  const shownTemplates = templates.filter((t) => (t.folderId ?? null) === openFolder);
  const openFolderName = folders.find((f) => f.id === openFolder)?.name;

  return (
    <div
      ref={attachTarget}
      {...forDrags(targetProps, (ref) => ref.scope === "project")}
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        dropActive &&
          "rounded-xl bg-[#0a84ff]/5 outline-2 outline-dashed outline-offset-[-4px] outline-[#0a84ff]/60"
      )}
    >
      {openFolder !== null ? (
        <div className="flex h-12 shrink-0 items-center pr-2.5 pl-2.5">
          <FolderCrumb
            className="text-sm"
            root="Library"
            name={openFolderName ?? "Folder"}
            mime={LIBRARY_MOVE_MIME}
            onBack={() => setOpenFolder(null)}
            onDropOut={(ids) => ids.forEach((id) => void move(id, null))}
          />
        </div>
      ) : (
        <PanelHead title="Library" />
      )}
      {openFolder === null && folders.length > 0 ? (
        <div className="shrink-0 px-3.5">
          <FolderShelf
            rows
            folders={folders}
            mime={LIBRARY_MOVE_MIME}
            statOf={(id) => ({
              count:
                all.filter((a) => (a.folderId ?? null) === id).length +
                templates.filter((t) => (t.folderId ?? null) === id).length,
            })}
            badgeOf={(id) => {
              const r = folders.find((f) => f.id === id)?.residency;
              return bothShelves && r ? <ShelfBadge residency={r} /> : null;
            }}
            onOpen={(id) => setOpenFolder(id)}
            onRename={async (id, name) => {
              const r = folders.find((f) => f.id === id)?.residency;
              if (!r) return;
              setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
              await renameLibraryFolder(r, id, name).catch(() => void reload());
            }}
            onDelete={async (id) => {
              const r = folders.find((f) => f.id === id)?.residency;
              if (!r) return;
              setFolders((prev) => prev.filter((f) => f.id !== id));
              setAssets((prev) =>
                (prev ?? []).map((a) => (a.folderId === id ? { ...a, folderId: null } : a))
              );
              setTemplates((prev) =>
                prev.map((t) => (t.folderId === id ? { ...t, folderId: null } : t))
              );
              if (openFolder === id) setOpenFolder(null);
              await deleteLibraryFolder(r, id).catch(() => void reload());
            }}
            onDropIds={(ids, fid) => ids.forEach((id) => void move(id, fid))}
            onRefDrop={(ref, fid) => {
              // Project media dropped on a folder tile (a Media card or a
              // timeline clip): save it to the library, filed in that folder.
              // The copy lands on the project's own shelf, so a folder on the
              // other one can't take it.
              if (ref.scope !== "project") return;
              if (folders.find((f) => f.id === fid)?.residency !== activeResidency()) return;
              const asset = useEditor.getState().assets.find((a) => a.id === ref.id);
              if (!asset) return;
              void saveAssetToLibrary(projectId, asset)
                .then((saved) => moveLibraryItem(saved.residency, saved.id, fid))
                .then(() => void reload())
                .catch(() => {});
            }}
          />
        </div>
      ) : null}
      {shownTemplates.length > 0 && (
        <div className="shrink-0 px-3.5 pb-3">
          <div className="flex flex-col gap-1.5">
            {shownTemplates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                mediaSrc={(f) => libraryMediaUrl(f, t.residency)}
                drag={{ scope: "library", template: t }}
                onDragStartExtra={(e) => {
                  e.dataTransfer.setData(LIBRARY_MOVE_MIME, JSON.stringify([t.id]));
                  e.dataTransfer.effectAllowed = "copyMove";
                }}
                addTitle="Add to this project"
                onAdd={() => void addTemplateToProject(projectId, t)}
                onRename={(name) => void commitTemplateRename(t.residency, t.id, name)}
                onDelete={() => void removeTemplate(t.residency, t.id)}
                onRefDrop={(r) => {
                  if (r.scope !== "project") return;
                  const asset = useEditor.getState().assets.find((a) => a.id === r.id);
                  if (!asset) return;
                  void addAssetToLibraryTemplate(projectId, t, asset)
                    .then((updated) =>
                      setTemplates((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
                    )
                    .catch(() => void reload());
                }}
              />
            ))}
          </div>
        </div>
      )}
      {assets === null ? (
        <div className="grid flex-1 place-items-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : shown.length === 0 && uploading === 0 ? (
        // At the root, filed-away assets, folders, and templates all count as
        // content — the invitation is only for a truly empty library.
        openFolder !== null ? (
          shownTemplates.length === 0 ? (
            <div className="px-3.5 py-6 text-center text-xs text-muted-foreground">Empty folder</div>
          ) : null
        ) : all.length === 0 && folders.length === 0 && templates.length === 0 ? (
          <div className="text-balance px-3.5 py-6 text-center text-xs text-muted-foreground">
            Drag video, audio and image assets here. Library assets are shared across all projects.
          </div>
        ) : null
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2.5 overflow-y-auto px-3.5 pb-3.5">
          {shown.map((a) => (
            <LibraryCard
              key={a.id}
              asset={a}
              onUse={() => void addLibraryAssetToProject(projectId, a)}
              onDelete={() => setDeleting(a)}
              onDragStartExtra={(e) => onCardDragExtra(e, a)}
            />
          ))}
          {uploading > 0 && (
            <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input text-[11px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>
                Uploading… <LiveElapsed />
              </span>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{deleting?.name}” from the library?</AlertDialogTitle>
            <AlertDialogDescription>
              Projects that already use it keep their own copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CopyChip({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-chip inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      disabled={!text}
      title={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Whole-video fade slider (project-level: veils picture, titles, captions,
 * and the mix at the cut's start or end). Lives here — the only
 * project-scoped panel — since per-clip fades moved into clip Effects. */
function ProjectFadeRow({ label, value, onChange }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-[12px] text-muted-foreground">
      {label}
      <span className="flex items-center gap-2">
        <Slider
          className={`project-${label.toLowerCase().replace(" ", "-")} data-horizontal:w-28`}
          min={0}
          max={TRANSITION_MAX}
          step={0.1}
          value={value}
          onValueChange={(v) => onChange(Number(v))}
        />
        <span className="w-9 text-right font-mono text-[11.5px]">
          {value < 0.05 ? "Off" : `${value.toFixed(1)}s`}
        </span>
      </span>
    </label>
  );
}

function PublishPanel() {
  const readOnly = useEditor((s) => s.readOnly);
  const publish = useEditor((s) => s.publish);
  const setPublish = useEditor((s) => s.setPublish);
  const notes = useEditor((s) => s.notes);
  const setNotes = useEditor((s) => s.setNotes);
  const fadeIn = useEditor((s) => s.fadeIn);
  const fadeOut = useEditor((s) => s.fadeOut);
  const tagsLine = normalizeTags(publish.tags);
  const combined = [publish.caption.trim(), tagsLine].filter(Boolean).join("\n\n");
  const count = combined.length;
  const [copiedAll, setCopiedAll] = useState(false);

  return (
    <>
      <PanelHead title="Details" />
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-3.5 pb-4">
        {!readOnly && (
          <div className="flex flex-col gap-1.5">
            <SectionTitle>Video</SectionTitle>
            <ProjectFadeRow
              label="Fade in"
              value={fadeIn}
              onChange={(v) => useEditor.getState().setProjectFade({ fadeIn: v })}
            />
            <ProjectFadeRow
              label="Fade out"
              value={fadeOut}
              onChange={(v) => useEditor.getState().setProjectFade({ fadeOut: v })}
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <SectionTitle>Caption</SectionTitle>
            <CopyChip text={publish.caption.trim()} label="caption" />
          </div>
          <textarea
            className="publish-caption min-h-[110px] w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-[12.5px] leading-relaxed outline-none focus:border-ring"
            placeholder={"What's happening in this video?\n\nHooks read best in the first line."}
            value={publish.caption}
            readOnly={readOnly}
            onChange={(e) => setPublish({ caption: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <SectionTitle>Tags</SectionTitle>
            <CopyChip text={tagsLine} label="tags" />
          </div>
          <input
            className="publish-tags w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-[12.5px] outline-none focus:border-ring"
            placeholder="fyp howto cut"
            value={publish.tags}
            readOnly={readOnly}
            onChange={(e) => setPublish({ tags: e.target.value })}
          />
          {tagsLine && (
            <div className="publish-tag-preview flex flex-wrap gap-1">
              {tagsLine.split(" ").map((t) => (
                <span key={t} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10.5px]">
                  {t}
                </span>
              ))}
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            3–5 focused tags work best. Tags count toward the caption limit.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <SectionTitle>Sound title</SectionTitle>
            <CopyChip text={publish.soundTitle.trim()} label="sound title" />
          </div>
          <input
            className="publish-sound w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-[12.5px] outline-none focus:border-ring"
            placeholder="My track — artist"
            value={publish.soundTitle}
            readOnly={readOnly}
            onChange={(e) => setPublish({ soundTitle: e.target.value })}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            TikTok names uploads “original sound – you”. You can rename the
            sound once after posting — paste this then.
          </p>
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border pt-4">
          <SectionTitle>Notes</SectionTitle>
          <label className="flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
            Published
            <input
              type="date"
              className="notes-date rounded-lg border border-input bg-transparent px-2 py-1 text-[12px] outline-none focus:border-ring"
              value={notes.publishedAt}
              disabled={readOnly}
              onChange={(e) => setNotes({ publishedAt: e.target.value })}
            />
          </label>
          <textarea
            className="notes-links min-h-[54px] w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-[11.5px] leading-relaxed outline-none focus:border-ring"
            placeholder={"Links, one per line\nhttps://tiktok.com/…"}
            value={notes.links.join("\n")}
            readOnly={readOnly}
            onChange={(e) => setNotes({ links: e.target.value.split("\n") })}
          />
          <textarea
            className="notes-text min-h-[70px] w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-[12.5px] leading-relaxed outline-none focus:border-ring"
            placeholder="Anything worth remembering about this cut…"
            value={notes.text}
            readOnly={readOnly}
            onChange={(e) => setNotes({ text: e.target.value })}
          />
        </div>

        <div className="mt-1 flex flex-col gap-2">
          <Button
            className="w-full"
            disabled={!combined}
            onClick={() => {
              void navigator.clipboard.writeText(combined).then(() => {
                setCopiedAll(true);
                setTimeout(() => setCopiedAll(false), 1500);
              });
            }}
          >
            {copiedAll ? (
              <>
                <Check data-icon="inline-start" /> Copied
              </>
            ) : (
              <>
                <Copy data-icon="inline-start" /> Copy caption + tags
              </>
            )}
          </Button>
          <p
            className={cn(
              "publish-count text-right font-mono text-[11px] tabular-nums",
              count > CAPTION_LIMIT ? "font-semibold text-red-600" : "text-muted-foreground"
            )}
          >
            {count.toLocaleString()} / {CAPTION_LIMIT.toLocaleString()}
          </p>
        </div>
      </div>
    </>
  );
}
