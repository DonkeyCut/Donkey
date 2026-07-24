"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Clapperboard, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch, setCutMode } from "@/cut/lib/backend";
import { renderPreviewProxy } from "@/cut/lib/exportClient";
import { fileZoneAt, hasRefDrag } from "@/cut/lib/assetRef";
import { enrichAsset, importFileToProject } from "@/cut/lib/media";
// Side-effect import: registers the brief-to-video resume subscription, so a
// persisted run resumes on project load even when the AI panel never mounts.
import "@/cut/lib/genScene";
import { installDevHooks } from "@/cut/lib/devHooks";
import { backTarget, useCutBase } from "@/cut/lib/nav";
import { resolveProjectMode } from "@/cut/lib/residency";
import { projectDuration, serializeDoc, storedAssets, useEditor } from "@/cut/lib/store";
import type { MediaAsset } from "@/cut/lib/types";
import { AiPanel } from "./AiPanel";
import { ExportDialog } from "./ExportDialog";
import { Inspector } from "./Inspector";
import { Lightbox } from "./Lightbox";
import { Preview } from "./Preview";
import { SidePanel } from "./SidePanel";
import { Timeline } from "./Timeline";
import { TopBar } from "./TopBar";

export function Editor({
  projectId,
  from,
  folder,
}: {
  projectId: string;
  from?: string | null;
  folder?: string | null;
}) {
  useEffect(() => installDevHooks(), []);
  const back = backTarget(useCutBase(), from, folder);
  const loaded = useEditor((s) => s.loaded);
  const loadError = useEditor((s) => s.loadError);
  // Until loadProject runs, the store still holds the previously open project;
  // rendering the editor against it would leak that project's state (chat,
  // clips, selection) into this route.
  const stale = useEditor((s) => s.projectId) !== projectId;
  const exportOpen = useEditor((s) => s.exportOpen);
  const aiOpen = useEditor((s) => s.aiOpen);
  // The inspector only earns its column when the selection has a panel to
  // show; otherwise (nothing selected, or a subtitle cue) it is an empty white
  // panel, so collapse it and let the preview take the space.
  const hasInspector = useEditor((s) => s.selection != null && s.selection.kind !== "cue");
  const [importing, setImporting] = useState(0);
  const [conflictReloaded, setConflictReloaded] = useState(false);
  const dragDepth = useRef(0);

  // Load the project document, then enrich assets (thumbs/waveforms) lazily.
  // Residency is a fact about the project, not the link: resolve where the id
  // lives (residency.ts) and bind the backend before anything else fetches.
  useEffect(() => {
    let alive = true;
    void resolveProjectMode(projectId).then((mode) => {
      if (!alive) return;
      setCutMode(mode);
      void useEditor
        .getState()
        .loadProject(projectId)
        .then(() => {
          for (const asset of useEditor.getState().assets) void enrichAsset(asset);
        });
    });
    // An export still rendering after a reload rejoins on its own: the app-wide
    // exports dock polls the engine's job feed, so it reappears with no per-
    // project reconnect here.
    return () => {
      alive = false;
    };
  }, [projectId]);

  // A cloud save hit a newer stored version (another session's edits won).
  // Take the newer doc through the ordinary load path — the GET returns it and
  // rebinds the driver's version — and say so.
  useEffect(() => {
    const onConflict = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string }>).detail;
      if (!detail || detail.projectId !== projectId) return;
      void useEditor
        .getState()
        .loadProject(projectId)
        .then(() => {
          for (const asset of useEditor.getState().assets) void enrichAsset(asset);
        });
      setConflictReloaded(true);
    };
    window.addEventListener("cut-cloud-doc-conflict", onConflict);
    return () => window.removeEventListener("cut-cloud-doc-conflict", onConflict);
  }, [projectId]);

  // Keep the project card's hover proxy fresh: rebuild it a few seconds after
  // the cut settles. Best-effort and single-flight; skips when there's no cut.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rendering = false;
    const render = async () => {
      const s = useEditor.getState();
      if (rendering || !s.loaded || s.projectId !== projectId || s.clips.length === 0) return;
      rendering = true;
      try {
        await renderPreviewProxy(
          projectId,
          {
            assets: s.assets,
            clips: s.clips,
            audioClips: s.audioClips,
            overlays: s.overlays,
            subtitles: s.subtitles,
            fadeIn: s.fadeIn,
            fadeOut: s.fadeOut,
          },
          s.aspect
        );
      } finally {
        rendering = false;
      }
    };
    let last: {
      clips: unknown;
      audioClips: unknown;
      overlays: unknown;
      subtitles: unknown;
      aspect: string;
      fadeIn: number;
      fadeOut: number;
    } | null = null;
    const unsub = useEditor.subscribe((s) => {
      if (!s.loaded || s.projectId !== projectId) return;
      const changed =
        last !== null &&
        (s.clips !== last.clips ||
          s.audioClips !== last.audioClips ||
          s.overlays !== last.overlays ||
          s.subtitles !== last.subtitles ||
          s.aspect !== last.aspect ||
          s.fadeIn !== last.fadeIn ||
          s.fadeOut !== last.fadeOut);
      last = {
        clips: s.clips,
        audioClips: s.audioClips,
        overlays: s.overlays,
        subtitles: s.subtitles,
        aspect: s.aspect,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
      };
      if (!changed) return; // first tick just primes the baseline
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void render(), 8000);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  // Autosave: debounce document changes into PUT /api/cut/projects/<id>.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = serializeDoc(useEditor.getState());
    let lastName = useEditor.getState().projectName;

    const save = async () => {
      const s = useEditor.getState();
      if (!s.loaded || s.projectId !== projectId) return;
      s.setSaveState("saving");
      try {
        const res = await apiFetch(`/api/cut/projects/${projectId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(serializeDoc(s)),
        });
        if (!res.ok) throw new Error();
        useEditor.getState().setSaveState("saved");
      } catch {
        useEditor.getState().setSaveState("error");
      }
    };

    let primed = false;
    // Assets change identity on runtime enrichment (thumbs, peaks) too, so a
    // new reference compares by its stored projection: field edits like an
    // origin change ("Add to Media", chat tagging) must save, enrichment not.
    let lastAssetsRef = useEditor.getState().assets;
    let lastAssetsJson = JSON.stringify(storedAssets(lastAssetsRef));
    const assetsChanged = (assets: MediaAsset[]): boolean => {
      if (assets === lastAssetsRef) return false;
      const json = JSON.stringify(storedAssets(assets));
      const changed = json !== lastAssetsJson;
      lastAssetsRef = assets;
      lastAssetsJson = json;
      return changed;
    };
    const unsub = useEditor.subscribe((s) => {
      if (!s.loaded || s.projectId !== projectId) return;
      if (!primed) {
        // First tick after load: snapshot the freshly loaded doc so opening
        // a project never counts as an edit.
        primed = true;
        last = serializeDoc(s);
        lastName = s.projectName;
        assetsChanged(s.assets);
        return;
      }
      // Evaluated every tick (not short-circuited) so the asset baseline
      // advances even when another slice triggered this save.
      const assetsDirty = assetsChanged(s.assets);
      const changed =
        assetsDirty ||
        s.clips !== (last.clips as unknown) ||
        s.audioClips !== (last.audioClips as unknown) ||
        s.overlays !== (last.overlays as unknown) ||
        s.templates !== (last.templates as unknown) ||
        s.subtitles !== (last.subtitles as unknown) ||
        s.aspect !== last.aspect ||
        s.fadeIn !== (last.fadeIn ?? 0) ||
        s.fadeOut !== (last.fadeOut ?? 0) ||
        s.publish.caption !== last.publish?.caption ||
        s.publish.tags !== last.publish?.tags ||
        s.publish.soundTitle !== last.publish?.soundTitle ||
        s.publish.handle !== last.publish?.handle ||
        s.notes.text !== last.notes?.text ||
        s.notes.publishedAt !== last.notes?.publishedAt ||
        s.notes.links.join("") !== (last.notes?.links ?? []).join("") ||
        // Normalized like serializeDoc stores it (?? null): a project with no
        // run holds undefined in state and null in the doc — not a change.
        (s.genvideo ?? null) !== ((last.genvideo ?? null) as unknown) ||
        s.renders !== (last.renders as unknown) ||
        s.projectName !== lastName;
      if (!changed) return;
      last = serializeDoc(s);
      lastName = s.projectName;
      if (s.saveState !== "saving") s.setSaveState("dirty");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void save(), 800);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  const importFiles = useCallback(
    async (
      files: FileList | File[],
      opts?: { at?: number; origin?: MediaAsset["origin"]; mediaOnly?: boolean }
    ) => {
      const list = Array.from(files);
      setImporting((n) => n + list.length);
      for (const file of list) {
        try {
          const asset = await importFileToProject(projectId, file);
          if (!asset) continue;
          // Recordings are created media: tag them so they land on the timeline
          // but never in the Media panel (reserved for user imports).
          if (opts?.origin) asset.origin = opts.origin;
          const s = useEditor.getState();
          s.addAsset(asset);
          // mediaOnly stocks the Media panel and leaves the timeline alone
          // (drops that land outside the timeline); placement is up to the user.
          if (!opts?.mediaOnly) {
            if (asset.type === "video" || asset.type === "image") {
              // A drop on the timeline lands at the pointer (sliding to track
              // 0's next free slot); an upload appends at the end. A still
              // rides track 0 like footage.
              s.addClipFromAsset(asset.id, opts?.at);
            } else {
              // A timeline drop lands at the pointer; an upload drops at the
              // playhead (the store slides it right only if that spot is taken).
              s.addAudioFromAsset(asset.id, opts?.at);
            }
          }
          void enrichAsset(asset);
        } catch (err) {
          console.error(`Import failed for ${file.name}:`, err);
        } finally {
          setImporting((n) => n - 1);
        }
      }
    },
    [projectId]
  );

  // Whole-window drag & drop for OS files. Chrome tags native <img> drags
  // with `Files` too, so internal drags — which always carry the ref MIME —
  // are filtered out; dragging a stock tile never lights the drop hints.
  useEffect(() => {
    const isFileDrag = (e: DragEvent) =>
      !!e.dataTransfer?.types.includes("Files") && !hasRefDrag(e);
    // "media" when the drag carries at least one video/audio/image (the
    // timeline is a valid target); text-only drags only concern the chat.
    // Items that hide their MIME type during the drag count as media.
    const dragKind = (e: DragEvent): "media" | "other" => {
      const items = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === "file");
      return items.length === 0 ||
        items.some((i) => !i.type || /^(video|audio|image)\//.test(i.type))
        ? "media"
        : "other";
    };
    const enter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current++;
      useEditor.getState().setDropActive(dragKind(e));
    };
    const over = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) useEditor.getState().setDropActive(null);
    };
    // Time under the pointer when the drop lands on the timeline's tracks,
    // else null. Geometric, because the drop is handled at the window level
    // and the pointer may sit over any timeline child.
    const timelineDropTime = (e: DragEvent): number | null => {
      const scroll = document.querySelector(".tl-scroll");
      const inner = document.querySelector(".tl-content");
      if (!scroll || !inner) return null;
      const r = scroll.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right)
        return null;
      const t = (e.clientX - inner.getBoundingClientRect().left) / useEditor.getState().pxPerSec;
      return Math.max(0, t);
    };
    const drop = (e: DragEvent) => {
      if (hasRefDrag(e) || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      dragDepth.current = 0;
      useEditor.getState().setDropActive(null);
      // A drop on a file-taking composer (generate/chat attachments) belongs
      // to it; a drop on the timeline places at the pointer; anywhere else
      // the files land in the Media panel only.
      const zone = fileZoneAt(e.clientX, e.clientY);
      if (zone) {
        zone(Array.from(e.dataTransfer.files));
        return;
      }
      const at = timelineDropTime(e);
      void importFiles(e.dataTransfer.files, at == null ? { mediaOnly: true } : { at });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [importFiles]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inputType = (target as HTMLInputElement).type;
      const textEntry =
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable ||
        (target.tagName === "INPUT" &&
          !["checkbox", "radio", "range", "button"].includes(inputType));
      if (textEntry) return;
      // Let native toggle/slider behavior win for focused controls.
      const controlFocused =
        target.tagName === "INPUT" || target.closest('[role="switch"],[role="slider"]') !== null;
      const s = useEditor.getState();
      if (s.exportOpen || document.querySelector('[data-slot="dialog-content"]')) return;

      if (e.code === "Space" && !controlFocused) {
        e.preventDefault();
        if (!s.playing && s.currentTime >= projectDuration(s) - 0.01) s.seek(0);
        s.setPlaying(!s.playing);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        s.deleteSelection();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        if (s.copySelection()) e.preventDefault();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        if (s.paste()) e.preventDefault();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        s.setAiOpen(!s.aiOpen);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        // iMovie: cut at the skimmer when the mouse is over the timeline.
        s.splitAtPlayhead(s.skimTime ?? undefined);
      } else if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) {
        s.splitAtPlayhead(s.skimTime ?? undefined);
      } else if (e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey) {
        s.addOverlay();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !controlFocused) {
        e.preventDefault();
        // While playing, arrows skip in 1s jumps and playback rolls on (seek
        // never pauses); paused, they step a frame — 1s with Shift — for
        // precise editing.
        const step = s.playing ? 1 : e.shiftKey ? 1 : 1 / 30;
        s.seek(s.currentTime + (e.key === "ArrowLeft" ? -step : step));
      } else if (e.key === "Escape") {
        s.select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loadError && !stale) {
    return (
      <div className="grid h-screen place-items-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <Clapperboard className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href={back.href}>Back to {back.tab}</Link>}
          />
        </div>
      </div>
    );
  }

  if (!loaded || stale) {
    return (
      <div className="grid h-screen place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-screen min-w-[900px] overflow-hidden">
      <div className="grid min-w-0 flex-1 grid-rows-[46px_minmax(0,1fr)_auto]">
        <TopBar onImport={importFiles} from={from} folder={folder} uploading={importing} />
        <div
          className={`grid min-h-0 ${
            hasInspector ? "grid-cols-[auto_minmax(0,1fr)_272px]" : "grid-cols-[auto_minmax(0,1fr)]"
          }`}
        >
          <SidePanel projectId={projectId} onImport={importFiles} importing={importing > 0} />
          <div className="grid min-h-0 min-w-0">
            <Preview />
          </div>
          {hasInspector && <Inspector />}
        </div>
        <Timeline />
      </div>
      {aiOpen && (
        <AiPanel
          key={projectId}
          projectId={projectId}
          onClose={() => useEditor.getState().setAiOpen(false)}
        />
      )}
      {exportOpen && <ExportDialog />}
      {conflictReloaded && (
        <div className="fixed top-14 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-foreground/90 py-1.5 pr-1.5 pl-3.5 text-background shadow-lg">
          <span className="text-xs font-medium">Reloaded a newer version saved elsewhere.</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            className="rounded-full text-background hover:bg-background/15 hover:text-background"
            onClick={() => setConflictReloaded(false)}
          >
            <X />
          </Button>
        </div>
      )}
      <Lightbox />
    </div>
  );
}
