"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Cloud,
  FolderOpen,
  FolderPlus,
  Laptop,
  Link as LinkIcon,
  Loader2,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { clearAssetDrag, setCardDragImage, setLibraryDragData } from "@/cut/lib/assetDrag";
import { useInView } from "@/cut/hooks/useInView";
import { isMediaFile } from "@/cut/lib/media";
import { patchLibrary, refetchLibrary, useLibrary } from "@/cut/lib/queries";
import {
  createLibraryFolder,
  deleteFromLibrary,
  deleteLibraryFolder,
  deleteTemplate,
  importUrlToLibrary,
  libraryMediaUrl,
  moveLibraryItem,
  renameLibraryFolder,
  renameTemplate,
  uploadToLibrary,
  type LibraryAsset,
  type LibraryData,
} from "@/cut/lib/library";
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { availableResidencies, RESIDENCY_LABEL, type Residency } from "@/cut/lib/residency";
import { TemplateCard } from "./TemplateCard";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import { useRevealFlash } from "@/cut/lib/refReveal";
import { formatTime } from "@/cut/lib/time";
import { cn } from "@/lib/utils";
import { CopyNameLabel } from "./AssetRefs";
import { AudioCardFace } from "./AudioPanel";
import { buildDragGhost, FolderCrumb, FolderShelf, Marquee } from "./desktopFolders";

// A dragged library selection travels as a JSON array of asset ids, so a whole
// marquee-selected collection can be dropped onto a folder at once.
const LIBRARY_MOVE_MIME = "application/x-cut-library-move";

/** Which shelf an item sits on, on its card. The library merges both, so the
 * badge is how you tell a clip on this Mac from one in the cloud. */
export function ShelfBadge({
  residency,
  className,
}: {
  residency: Residency;
  className?: string;
}) {
  const Icon = residency === "cloud" ? Cloud : Laptop;
  return (
    <span title={RESIDENCY_LABEL[residency]} className={className}>
      <Icon className="size-3" />
    </span>
  );
}

export function LibraryView() {
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  // The listing is cached (lib/queries.ts): coming back to the library paints
  // the shelf it painted last time and revalidates behind it.
  const library = useLibrary();
  // New projects and new library items answer the same question — which shelf
  // is this browser putting things on — so they read the one choice the user
  // already made, rather than the backend the app happens to be bound to.
  const { target } = useNewProjectTarget();
  const all = library.data?.assets ?? [];
  const folders = library.data?.folders ?? [];
  const templates = library.data?.templates ?? [];
  const patch = useCallback(
    (fn: (prev: LibraryData) => LibraryData) => patchLibrary(client, fn),
    [client]
  );
  const reload = useCallback(() => refetchLibrary(client), [client]);
  // The open folder lives in the URL (?folder=…) so the browser's back button
  // steps folder → root and the location survives reloads.
  const openFolder = useSearchParams().get("folder");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [folderCreating, setFolderCreating] = useState(false);
  const [deleting, setDeleting] = useState<LibraryAsset | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whether an OS-file drag is hovering the surface (a depth counter tames
  // enter/leave noise as the cursor crosses child tiles).
  const [fileOver, setFileOver] = useState(false);
  const dragDepth = useRef(0);

  // Every mutation goes to the shelf its item sits on; only new items need a
  // destination, and that is the folder they land in, or the bound backend.
  const shelfOf = (id: string): Residency | null =>
    all.find((a) => a.id === id)?.residency ??
    templates.find((t) => t.id === id)?.residency ??
    null;
  const shelfForNew = (folderId: string | null) =>
    (folderId ? folders.find((f) => f.id === folderId)?.residency : null) ?? target;

  const renameTpl = async (r: Residency, id: string, name: string) => {
    patch((d) => ({ ...d, templates: d.templates.map((t) => (t.id === id ? { ...t, name } : t)) }));
    await renameTemplate(r, id, name).catch(() => void reload());
  };

  const removeTpl = async (r: Residency, id: string) => {
    patch((d) => ({ ...d, templates: d.templates.filter((t) => t.id !== id) }));
    await deleteTemplate(r, id).catch(() => void reload());
  };

  // Upload a batch into `folderId` (the open folder by default — folder tiles
  // pass their own id when files are dropped straight onto them).
  const upload = async (files: FileList | File[], folderId: string | null = openFolder) => {
    const list = Array.from(files).filter(isMediaFile);
    const residency = shelfForNew(folderId);
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const asset = await uploadToLibrary(file, residency);
        if (folderId) {
          await moveLibraryItem(residency, asset.id, folderId).catch(() => {});
          asset.folderId = folderId;
        }
        patch((d) => ({ ...d, assets: [asset, ...d.assets] }));
      } catch {
        // Skip unreadable files; the rest of the batch still uploads.
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const importUrl = async () => {
    const value = url.trim();
    if (!value || importing) return;
    setImporting(true);
    setUrlError(null);
    const residency = shelfForNew(openFolder);
    try {
      const imported = await importUrlToLibrary(value, residency);
      if (openFolder) {
        for (const asset of imported) {
          await moveLibraryItem(residency, asset.id, openFolder).catch(() => {});
          asset.folderId = openFolder;
        }
      }
      patch((d) => ({ ...d, assets: [...imported, ...d.assets] }));
      setUrl("");
      setAddOpen(false);
    } catch (e) {
      setUrlError(e instanceof Error ? e.message : "Could not import that URL.");
    } finally {
      setImporting(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    const { id, residency } = deleting;
    setDeleting(null);
    patch((d) => ({ ...d, assets: d.assets.filter((a) => a.id !== id) }));
    try {
      await deleteFromLibrary(residency, id);
    } catch {
      void reload();
    }
  };

  // Open a folder (or the root, id null) by navigating, so the location is
  // shareable and back-button friendly.
  const gotoFolder = (id: string | null) => {
    setSelected(new Set());
    router.push(homeHref(base, "library", id));
  };

  // A folder belongs to one shelf, so a drag that spans both files only the
  // items already on that folder's shelf; the rest stay where they are.
  const moveItems = async (ids: string[], folderId: string | null) => {
    const target = folderId ? folders.find((f) => f.id === folderId)?.residency : null;
    const moving = ids
      .map((id) => ({ id, residency: shelfOf(id) }))
      .filter((x): x is { id: string; residency: Residency } => !!x.residency)
      .filter((x) => !target || x.residency === target);
    if (moving.length === 0) return;
    const idset = new Set(moving.map((x) => x.id));
    patch((d) => ({
      ...d,
      assets: d.assets.map((a) => (idset.has(a.id) ? { ...a, folderId } : a)),
      templates: d.templates.map((t) => (idset.has(t.id) ? { ...t, folderId } : t)),
    }));
    setSelected(new Set());
    await Promise.all(
      moving.map((x) => moveLibraryItem(x.residency, x.id, folderId))
    ).catch(() => void reload());
  };

  // Carry the current selection (or just this card) as a folder-move payload,
  // with a ghost — alongside the timeline-drag payload the card already sets.
  // A single card drags as itself; a multi-selection keeps the counted stack.
  const onCardDragExtra = (e: React.DragEvent, a: LibraryAsset) => {
    const ids = selected.has(a.id) && selected.size > 0 ? Array.from(selected) : [a.id];
    if (!selected.has(a.id)) setSelected(new Set([a.id]));
    e.dataTransfer.setData(LIBRARY_MOVE_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "copyMove";
    if (ids.length > 1) {
      const ghost = buildDragGhost(ids.length, `${ids.length} items`);
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 18, 16);
      setTimeout(() => ghost.remove(), 0);
    } else {
      setCardDragImage(e, e.currentTarget as HTMLElement);
    }
  };

  const bothShelves = availableResidencies().length > 1;
  const shown = all.filter((a) => (a.folderId ?? null) === openFolder);
  const shownTemplates = templates.filter((t) => (t.folderId ?? null) === openFolder);
  const openFolderName = folders.find((f) => f.id === openFolder)?.name;
  const hasContent =
    all.length > 0 || folders.length > 0 || templates.length > 0 || uploading > 0;

  // Only OS-file drags are drop targets here; internal card drags carry
  // LIBRARY_MOVE_MIME and are handled by the folder tiles and breadcrumb.
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  return (
    <div
      className={cn(
        "min-h-full",
        fileOver &&
          "rounded-3xl outline-2 outline-dashed outline-offset-[-10px] outline-[#0a84ff]/60"
      )}
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setFileOver(true);
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setFileOver(false);
        }
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setFileOver(false);
        void upload(e.dataTransfer.files);
      }}
    >
    <div className="mx-auto w-full max-w-6xl px-10 py-9">
      <div className="mb-5 flex items-center justify-between gap-4">
        {openFolder === null ? (
          <h1 className="text-lg font-semibold tracking-tight">Library</h1>
        ) : (
          <FolderCrumb
            root="Library"
            name={openFolderName ?? "Folder"}
            mime={LIBRARY_MOVE_MIME}
            onBack={() => gotoFolder(null)}
            onDropOut={(ids) => void moveItems(ids, null)}
          />
        )}
        <div className="flex items-center gap-2">
          {openFolder === null && (
            <Button variant="outline" onClick={() => setFolderCreating(true)}>
              <FolderPlus data-icon="inline-start" /> New folder
            </Button>
          )}
          <Button onClick={() => { setUrlError(null); setAddOpen(true); }}>
            <Upload data-icon="inline-start" /> Add media
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="video/*,audio/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) {
              void upload(e.target.files);
              setAddOpen(false);
            }
            e.target.value = "";
          }}
        />
      </div>

      {openFolder === null && (folders.length > 0 || folderCreating) ? (
        <FolderShelf
          folders={folders}
          mime={LIBRARY_MOVE_MIME}
          creating={folderCreating}
          onCreatingChange={setFolderCreating}
          statOf={(id) => ({
            count:
              all.filter((a) => (a.folderId ?? null) === id).length +
              templates.filter((t) => (t.folderId ?? null) === id).length,
          })}
          badgeOf={(id) => {
            const r = folders.find((f) => f.id === id)?.residency;
            return bothShelves && r ? <ShelfBadge residency={r} /> : null;
          }}
          onOpen={gotoFolder}
          onCreate={async (name) => {
            const f = await createLibraryFolder(name, target);
            patch((d) => ({ ...d, folders: [...d.folders, f] }));
          }}
          onRename={async (id, name) => {
            const r = folders.find((f) => f.id === id)?.residency;
            if (!r) return;
            patch((d) => ({
              ...d,
              folders: d.folders.map((f) => (f.id === id ? { ...f, name } : f)),
            }));
            await renameLibraryFolder(r, id, name).catch(() => void reload());
          }}
          onDelete={async (id) => {
            const r = folders.find((f) => f.id === id)?.residency;
            if (!r) return;
            patch((d) => ({
              folders: d.folders.filter((f) => f.id !== id),
              assets: d.assets.map((a) => (a.folderId === id ? { ...a, folderId: null } : a)),
              templates: d.templates.map((t) =>
                t.folderId === id ? { ...t, folderId: null } : t
              ),
            }));
            if (openFolder === id) router.replace(homeHref(base, "library"));
            await deleteLibraryFolder(r, id).catch(() => void reload());
          }}
          onDropIds={(ids, fid) => void moveItems(ids, fid)}
          onDropFiles={(files, fid) => void upload(files, fid)}
        />
      ) : null}

      {shownTemplates.length > 0 && (
        <div className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
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
              onRename={(name) => void renameTpl(t.residency, t.id, name)}
              onDelete={() => void removeTpl(t.residency, t.id)}
            />
          ))}
        </div>
      )}

      {!library.data && library.isPending ? (
        <div className="grid place-items-center py-24 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : !hasContent ? (
        <button
          className="grid w-full cursor-pointer place-items-center rounded-2xl py-24"
          onClick={() => {
            setUrlError(null);
            setAddOpen(true);
          }}
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <FolderOpen className="size-8 text-muted-foreground" />
            <div className="text-base font-medium">
              Your Library is shared across all projects.
            </div>
            <p className="text-sm text-muted-foreground">
              Drag and drop videos, images, or audio files here.
            </p>
          </div>
        </button>
      ) : shown.length === 0 && uploading === 0 ? null : (
        <Marquee
          className="grid min-h-[40vh] grid-cols-[repeat(auto-fill,minmax(160px,1fr))] content-start gap-4"
          selected={selected}
          setSelected={setSelected}
        >
          {shown.map((a) => (
            <LibraryCard
              key={a.id}
              asset={a}
              selected={selected.has(a.id)}
              onDelete={() => setDeleting(a)}
              onDragStartExtra={(e) => onCardDragExtra(e, a)}
            />
          ))}
          {uploading > 0 && (
            <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-input text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>
                Uploading… <LiveElapsed />
              </span>
            </div>
          )}
        </Marquee>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add media</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <button
              className="flex flex-col items-center gap-2 rounded-xl py-8 transition-colors hover:bg-muted/40"
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="size-6 text-muted-foreground" />
              <span className="text-sm font-medium">Choose files</span>
            </button>
            <div className="flex items-center gap-3 text-[11px] tracking-wide text-muted-foreground uppercase">
              <div className="h-px flex-1 bg-border" /> or paste a link{" "}
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <LinkIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    value={url}
                    placeholder="TikTok, YouTube, or Instagram link…"
                    className="pl-8"
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void importUrl();
                    }}
                  />
                </div>
                <Button disabled={!url.trim() || importing} onClick={() => void importUrl()}>
                  {importing ? <Loader2 className="animate-spin" /> : <LinkIcon />} Import
                </Button>
              </div>
              {importing && (
                <p className="text-xs text-muted-foreground">
                  Downloading… <LiveElapsed />
                </p>
              )}
              {urlError && <p className="text-xs text-destructive">{urlError}</p>}
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
    </div>
  );
}

export function LibraryCard({
  asset: a,
  selected,
  onDelete,
  onUse,
  onDragStartExtra,
}: {
  asset: LibraryAsset;
  selected?: boolean;
  onDelete?: () => void;
  onUse?: () => void;
  onDragStartExtra?: (e: React.DragEvent) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { flash, attachReveal } = useRevealFlash("library", a.id);
  // With one shelf reachable, every card is on it — the badge would say
  // nothing.
  const bothShelves = availableResidencies().length > 1;
  // Each card is a real media element, so the source waits until the tile has
  // been scrolled near: a large library would otherwise pull every file's
  // metadata across the network the moment the page opened.
  const [tileRef, seen] = useInView<HTMLDivElement>();
  // Poster from the video itself so the still matches what plays on hover.
  // An ffmpeg still washes out iPhone HDR (HLG) footage — the browser tone-maps
  // the video correctly, so we render the frame instead of a baked thumbnail.
  const posterT = Math.min(1, Math.max(0.1, (a.duration || 2) / 10));

  return (
    <div
      ref={attachReveal}
      data-sel-id={a.id}
      className="group flex flex-col"
      draggable
      onDragStart={(e) => {
        setLibraryDragData(e, a);
        onDragStartExtra?.(e);
      }}
      onDragEnd={clearAssetDrag}
      onMouseEnter={() => void videoRef.current?.play().catch(() => {})}
      onMouseLeave={() => {
        const v = videoRef.current;
        if (v) {
          v.pause();
          v.currentTime = posterT;
        }
      }}
    >
      <div
        ref={tileRef}
        className={cn(
          "relative aspect-square cursor-grab overflow-hidden rounded-xl border bg-muted transition-shadow group-hover:shadow-[0_4px_20px_rgba(0,0,0,0.1)] active:cursor-grabbing",
          selected || flash ? "border-[#0a84ff] ring-2 ring-[#0a84ff]" : "border-border"
        )}
      >
        {a.type === "video" ? (
          seen && (
            <video
              crossOrigin={MEDIA_CORS}
              ref={videoRef}
              src={`${libraryMediaUrl(a.fileName, a.residency)}#t=${posterT}`}
              muted
              loop
              playsInline
              preload="metadata"
              className="size-full object-cover"
            />
          )
        ) : a.type === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- library media file, not Next-optimizable
          <img crossOrigin={MEDIA_CORS} src={libraryMediaUrl(a.fileName, a.residency)} alt={a.name} loading="lazy" className="size-full object-cover" />
        ) : (
          <AudioCardFace
            url={libraryMediaUrl(a.fileName, a.residency)}
            duration={a.duration}
            // On hover the + button takes the pill's corner.
            durationClassName={!!onUse && "transition-opacity group-hover:opacity-0"}
          />
        )}
        {a.type === "video" && (
          <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums">
            {formatTime(a.duration)}
          </span>
        )}
        {onUse && (
          <button
            aria-label="Add to timeline"
            title="Add to timeline"
            className={cn(
              "absolute grid size-6 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow transition-all group-hover:opacity-100 hover:scale-110",
              // Audio keeps play bottom-left; + swaps in where the badge hides.
              a.type === "audio" ? "right-1.5 bottom-1.5" : "bottom-1.5 left-1.5"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onUse();
            }}
          >
            <Plus className="size-3.5" />
          </button>
        )}
        {bothShelves && (
          <ShelfBadge
            residency={a.residency}
            className={cn(
              "absolute top-2 right-2 text-white/85 transition-opacity",
              // The delete button takes this corner on hover.
              onDelete && "group-hover:opacity-0"
            )}
          />
        )}
        <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100">
          {onDelete && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Remove from library"
              className="bg-black/40 text-white hover:bg-black/60 hover:text-white"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 />
            </Button>
          )}
        </div>
        <CopyNameLabel
          name={a.name}
          dark={a.type === "audio"}
          className={cn(
            "absolute top-1.5 left-1.5 max-w-[70%] px-2 py-1 text-[11px] font-medium text-white transition-[max-width] group-hover:max-w-[calc(100%-2.75rem)]",
            // The emerald fill is its own backdrop; thumbnails need the scrim pill.
            a.type !== "audio" && "rounded-lg bg-black/55 backdrop-blur-sm"
          )}
        />
      </div>
    </div>
  );
}
