"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Cloud,
  Download,
  Ellipsis,
  ExternalLink,
  Film,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Laptop,
  Link as LinkIcon,
  Loader2,
  Music,
  Plus,
  RotateCcw,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useElapsed } from "@/cut/hooks/useElapsed";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import {
  clearAssetDrag,
  setLibraryDragData,
  setObjectDragImage,
} from "@/cut/lib/assetDrag";
import { useInView } from "@/cut/hooks/useInView";
import { fileKind, isMediaFile } from "@/cut/lib/media";
import { patchLibrary, refetchLibrary, useLibrary } from "@/cut/lib/queries";
import {
  createLibraryFolder,
  deleteFromLibrary,
  deleteLibraryFolder,
  deleteTemplate,
  downloadLibraryAsset,
  estimatedShape,
  importUrlToLibrary,
  libraryMediaUrl,
  libraryPosterUrl,
  carryAssetTo,
  carryTemplateTo,
  moveLibraryItem,
  renameLibraryFolder,
  renameTemplate,
  uploadToLibrary,
  type ImportStage,
  type LibraryAsset,
  type LibraryTemplateItem,
  type LibraryData,
} from "@/cut/lib/library";
import { normalizeLink } from "@/cut/lib/link";
import { useLightbox } from "@/cut/lib/lightbox";
import { reportActivity } from "@/cut/lib/tabActivity";
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { useListedResidencies, useLocalCompute } from "@/cut/lib/backend/hooks";
import { setNeedsApp } from "@/cut/lib/needsApp";
import {
  availableResidencies,
  RESIDENCY_LABEL,
  type Residency,
} from "@/cut/lib/residency";
import { Lightbox } from "./Lightbox";
import { TabStatus } from "./TabStatus";
import { TemplateCard } from "./TemplateCard";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import {
  forgetLinkedCopy,
  expandLinkedFiles,
  isLinkedFile,
  linkedAccept,
  isLinkedType,
  shelfForNewItem,
  syncLinkedLibrary,
} from "@/cut/lib/linkedLibrary";
import { shapeBand } from "@/cut/lib/types";
import { useRevealFlash } from "@/cut/lib/refReveal";
import { formatTime } from "@/cut/lib/time";
import { cn } from "@/lib/utils";
import { CopyNameLabel } from "./AssetRefs";
import { FontSpecimen } from "./FontSpecimen";
import {
  SPECIMEN_BG,
  SPECIMEN_INK,
  SPECIMEN_META,
} from "@/cut/lib/fontSpecimen";
import { AudioCardFace } from "./AudioPanel";
import {
  buildDragGhost,
  FolderCrumb,
  FolderShelf,
  formatBytes,
  Marquee,
} from "./desktopFolders";
import { useMediaFileSize } from "@/cut/hooks/useMediaFileSize";

// A dragged library selection travels as a JSON array of asset ids, so a whole
// marquee-selected collection can be dropped onto a folder at once.
const LIBRARY_MOVE_MIME = "application/x-cut-library-move";

/** What an arriving item is doing right now. An upload is one push from this
 * browser; a link is fetched by whichever shelf is taking it, and comes down
 * in stages. */
type PendingStage = "uploading" | ImportStage;

/** Media on its way into the library: the tile it will occupy, standing in
 * for it while the work runs. */
interface Pending {
  id: string;
  /** The whole link, for the tile's tooltip: the label on the face is cut to
   * the site and the post's id. */
  source?: string;
  /** The file name being uploaded, or the link being imported. */
  name: string;
  stage: PendingStage;
  startedAt: number;
  /** A guess at the media's shape, for a link, so the tile opens near the size
   * the clip will take. Uploads sit square until the file lands. */
  shape?: { width: number; height: number };
  /** Set when the arrival failed: the tile holds the reason, and the way to
   * try again or give up, until the user picks one. */
  error?: string;
  /** The stage the work opens in, so a retry reads from the start again. */
  startStage: PendingStage;
  /** The whole arrival, ready to run once more: a failed tile retries by
   * calling this, with the file or link and where it was headed still in
   * hand. */
  run: () => Promise<void>;
}

/** Routing words a path spends on the way to the thing: they say nothing about
 * which post this is, so a label built from one ("youtube.com/watch") reads the
 * same for every import from that site. */
const ROUTE_SEGMENT = new Set([
  "watch",
  "video",
  "videos",
  "embed",
  "v",
  "e",
  "p",
  "post",
  "posts",
  "status",
  "share",
  "media",
  "download",
]);

/** A link's name on its tile: the site it points at and the token that
 * identifies the post — the last telling path segment, or the id a watch URL
 * carries in its query — so two imports from one site read apart. */
function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const id =
      u.pathname
        .split("/")
        .filter(Boolean)
        .reverse()
        .find((seg) => !ROUTE_SEGMENT.has(seg.toLowerCase())) ??
      u.searchParams.get("v");
    return id ? `${host}/${id}` : host;
  } catch {
    return url;
  }
}

const STAGE_LABEL: Record<PendingStage, string> = {
  uploading: "Uploading",
  queued: "Starting",
  downloading: "Downloading",
  saving: "Saving",
};

/** The tile an arriving item occupies: a card the size and shape the media
 * will take, its face a skeleton until the file lands, with the link it came
 * from and what the work is doing riding on top. A failed arrival holds the
 * reason until the user clears it. */
function PendingTile({
  item,
  area,
  onRetry,
  onDismiss,
}: {
  item: Pending;
  area: number;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const elapsed = useElapsed(item.error ? null : item.startedAt);
  const frame = item.shape ?? { width: 1, height: 1 };
  return (
    <div
      className={cn(
        "relative max-w-full overflow-hidden rounded-xl border",
        item.error ? "border-destructive/50 bg-muted" : "border-border",
      )}
      style={{
        width: Math.round(Math.sqrt((area * frame.width) / frame.height)),
        aspectRatio: `${frame.width} / ${frame.height}`,
      }}
    >
      {item.error ? (
        // Clear of the strip the link and the reason share along the top.
        <div className="flex size-full flex-col items-center justify-center gap-1.5 pt-8">
          <Button
            variant="outline"
            size="sm"
            className="w-24 justify-start"
            onClick={onRetry}
          >
            <RotateCcw data-icon="inline-start" /> Retry
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-24 justify-start text-destructive hover:text-destructive"
            onClick={onDismiss}
          >
            <X data-icon="inline-start" /> Cancel
          </Button>
        </div>
      ) : (
        <Skeleton className="size-full rounded-none" />
      )}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  "absolute top-1.5 left-1.5 truncate rounded-lg bg-black/55 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm",
                  item.error ? "max-w-[calc(100%-4rem)]" : "max-w-[70%]",
                )}
              />
            }
          >
            {item.name}
          </TooltipTrigger>
          <TooltipContent className="max-w-xs break-all">
            {item.source ?? item.name}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {item.error ? (
        // The reason rides in the tooltip: on a tile this size the message
        // itself would cover the media it stands in for.
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="absolute top-1.5 right-1.5 rounded-md bg-destructive/90 px-1.5 py-0.5 text-[10px] text-white" />
              }
            >
              Failed
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{item.error}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <span className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] text-white">
          <span className="truncate">{STAGE_LABEL[item.stage]}</span>
          <span className="shrink-0 font-mono tabular-nums">{elapsed}</span>
        </span>
      )}
    </div>
  );
}

/** Which shelf an item sits on, on its card. The library merges both, so the
 * badge is how you tell a clip on this Mac from one in the cloud — and, when
 * the app isn't answering, why that clip is showing but not usable. */
export function ShelfBadge({
  residency,
  offline = false,
  className,
}: {
  residency: Residency;
  offline?: boolean;
  className?: string;
}) {
  const Icon = residency === "cloud" ? Cloud : Laptop;
  return (
    <span
      title={
        offline
          ? "Local — open the Donkey app to use it"
          : RESIDENCY_LABEL[residency]
      }
      className={className}
    >
      <Icon className="size-3" />
    </span>
  );
}

export function LibraryView() {
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  // The listing is cached (lib/queries.ts): coming back to the library paints
  // the shelf it painted last time and revalidates behind it. With the Donkey
  // app closed that cache is the Mac's half outright — those files are still
  // on that disk, so they still list, badged and read-only until the app is
  // back. Clicking one raises the gate's banner, which is where the way out
  // of that state lives.
  const library = useLibrary();
  const listed = useListedResidencies();
  const engineUp = useLocalCompute();
  // Every shelf but the Mac's is always answering: the cloud is a request away
  // and the browser shelf is this page's own storage.
  const live = useCallback(
    (r: Residency) => r !== "local" || engineUp,
    [engineUp],
  );
  // Drop the flag when this view goes away: the banner belongs to the surface
  // that raised it.
  useEffect(() => () => setNeedsApp(false), []);
  // Lent items draw themselves in what they are — a font card is set in its own
  // face — so the shelf's kinds are put to use as soon as the page is open,
  // ahead of any upload.
  useEffect(() => void syncLinkedLibrary(), []);
  // New projects and new library items answer the same question — which shelf
  // is this browser putting things on — so they read the one choice the user
  // already made, rather than the backend the app happens to be bound to.
  const { target } = useNewProjectTarget();
  // Phone camera recordings have their own home tab (Camera Roll); the
  // Library grid lists everything else.
  const all = (library.data?.assets ?? []).filter((a) => a.origin !== "camera");
  const folders = library.data?.folders ?? [];
  const templates = library.data?.templates ?? [];
  const patch = useCallback(
    (fn: (prev: LibraryData) => LibraryData) => patchLibrary(client, fn),
    [client],
  );
  const reload = useCallback(() => refetchLibrary(client), [client]);
  // The open folder lives in the URL (?folder=…) so the browser's back button
  // steps folder → root and the location survives reloads.
  const openFolder = useSearchParams().get("folder");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Media on its way in — an upload or a link — each one a tile in the grid
  // from the moment it starts, so the library shows the work rather than the
  // dialog holding it.
  const [pending, setPending] = useState<Pending[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [folderCreating, setFolderCreating] = useState(false);
  const [deleting, setDeleting] = useState<LibraryAsset | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whether an OS-file drag is hovering the surface (a depth counter tames
  // enter/leave noise as the cursor crosses child tiles).
  const [fileOver, setFileOver] = useState(false);
  const dragDepth = useRef(0);

  // Every mutation goes to the shelf its item sits on; only new items need a
  // destination, and that is the folder they land in, or the bound backend. A
  // shelf that isn't answering takes none of them, so each one checks first.
  const shelfOf = (id: string): Residency | null =>
    all.find((a) => a.id === id)?.residency ??
    templates.find((t) => t.id === id)?.residency ??
    null;
  // Where a new item lands, and the folder it can land in: a folder on a shelf
  // that isn't answering can't take one, so the item goes to the root of the
  // shelf new items go to.
  const landing = (folderId: string | null) => {
    const owner = folderId
      ? folders.find((f) => f.id === folderId)?.residency
      : null;
    const residency = owner && live(owner) ? owner : target;
    return { residency, folderId: owner === residency ? folderId : null };
  };

  const renameTpl = async (r: Residency, id: string, name: string) => {
    if (!live(r)) return;
    patch((d) => ({
      ...d,
      templates: d.templates.map((t) => (t.id === id ? { ...t, name } : t)),
    }));
    await renameTemplate(r, id, name).catch(() => void reload());
  };

  const removeTpl = async (r: Residency, id: string) => {
    if (!live(r)) return;
    patch((d) => ({ ...d, templates: d.templates.filter((t) => t.id !== id) }));
    await deleteTemplate(r, id).catch(() => void reload());
  };

  // Track one arrival from its first moment to its last: the tile goes up
  // before any bytes move, follows the work, and comes down when the asset
  // itself takes its place. A failure leaves the tile up with the reason.
  // Files land here long after the drop, so the tab carries the arrival.
  useEffect(() => {
    reportActivity("import", pending.some((p) => !p.error));
  }, [pending]);
  const addPending = (p: Pending) => setPending((q) => [...q, p]);
  const setStage = (id: string, stage: PendingStage) =>
    setPending((q) => q.map((p) => (p.id === id ? { ...p, stage } : p)));
  const failPending = (id: string, error: string) =>
    setPending((q) => q.map((p) => (p.id === id ? { ...p, error } : p)));
  const dropPending = (id: string) =>
    setPending((q) => q.filter((p) => p.id !== id));
  // Run a failed arrival again on the tile it already has: the reason clears,
  // the clock restarts, and the same work goes out once more.
  const retryPending = (item: Pending) => {
    setPending((q) =>
      q.map((p) =>
        p.id === item.id
          ? {
              ...p,
              error: undefined,
              stage: item.startStage,
              startedAt: Date.now(),
            }
          : p,
      ),
    );
    void item.run();
  };

  // Upload a batch into `folderId` (the open folder by default — folder tiles
  // pass their own id when files are dropped straight onto them).
  const upload = async (
    files: FileList | File[],
    into: string | null = openFolder,
  ) => {
    const list = (await expandLinkedFiles(Array.from(files))).filter(
      (f) => isMediaFile(f) || isLinkedFile(f),
    );
    const { residency, folderId } = landing(into);
    if (!live(residency)) return;
    for (const file of list) {
      const id = crypto.randomUUID();
      const run = async () => {
        try {
          // Something the Library lends rather than copies, dropped outside a
          // folder, takes the shelf every surface can read; dropped into one,
          // the folder still decides.
          const shelf =
            isLinkedFile(file) && !folderId
              ? await shelfForNewItem(file.size)
              : residency;
          const asset = await uploadToLibrary(file, shelf);
          if (folderId) {
            await moveLibraryItem(shelf, asset.id, folderId).catch(() => {});
            asset.folderId = folderId;
          }
          patch((d) => ({ ...d, assets: [asset, ...d.assets] }));
          // A lent item is only usable once it is in reach of the menus.
          if (isLinkedType(asset.type)) void syncLinkedLibrary();
          dropPending(id);
        } catch (e) {
          failPending(
            id,
            e instanceof Error ? e.message : "Could not upload that file.",
          );
        }
      };
      addPending({
        id,
        name: file.name,
        stage: "uploading",
        startStage: "uploading",
        startedAt: Date.now(),
        run,
      });
      await run();
    }
  };

  // The link's tile goes up at once — shaped by what that kind of link usually
  // holds — and the dialog closes, so the wait happens in the library rather
  // than in front of it.
  const importUrl = async () => {
    const value = normalizeLink(url);
    if (!value) return;
    const { residency, folderId } = landing(openFolder);
    if (!live(residency)) return;
    setUrl("");
    setAddOpen(false);
    const id = crypto.randomUUID();
    const run = async () => {
      try {
        const imported = await importUrlToLibrary(value, residency, (stage) =>
          setStage(id, stage),
        );
        if (folderId) {
          for (const asset of imported) {
            await moveLibraryItem(residency, asset.id, folderId).catch(
              () => {},
            );
            asset.folderId = folderId;
          }
        }
        patch((d) => ({ ...d, assets: [...imported, ...d.assets] }));
        dropPending(id);
      } catch (e) {
        failPending(
          id,
          e instanceof Error ? e.message : "Could not import that URL.",
        );
      }
    };
    addPending({
      id,
      name: linkLabel(value),
      source: value,
      stage: "queued",
      startStage: "queued",
      startedAt: Date.now(),
      shape: estimatedShape(value),
      run,
    });
    await run();
  };

  const remove = async () => {
    if (!deleting) return;
    const { id, residency } = deleting;
    setDeleting(null);
    if (!live(residency)) return;
    patch((d) => ({ ...d, assets: d.assets.filter((a) => a.id !== id) }));
    if (isLinkedType(deleting.type)) forgetLinkedCopy(id);
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
  // items already on that folder's shelf — except a lent item, which is small
  // enough to carry to the folder's shelf and follow the user's filing.
  const moveItems = async (ids: string[], folderId: string | null) => {
    const target = folderId
      ? folders.find((f) => f.id === folderId)?.residency
      : null;
    const moving = ids
      .map((id) => ({ id, residency: shelfOf(id) }))
      .filter((x): x is { id: string; residency: Residency } => !!x.residency)
      .filter((x) => live(x.residency))
      .filter((x) => !target || x.residency === target);
    const carried =
      target && live(target)
        ? ids
            .map((id) => all.find((a) => a.id === id))
            .filter(
              (a): a is LibraryAsset =>
                !!a && a.residency !== target && live(a.residency),
            )
        : [];
    const carriedTemplates =
      target && live(target)
        ? ids
            .map((id) => templates.find((t) => t.id === id))
            .filter(
              (t): t is LibraryTemplateItem =>
                !!t && t.residency !== target && live(t.residency),
            )
        : [];
    if (carriedTemplates.length > 0) {
      setSelected(new Set());
      await Promise.all(
        carriedTemplates.map((t) =>
          carryTemplateTo(t, target!, folderId).catch(() => {}),
        ),
      );
      void reload();
    }
    if (carried.length > 0) {
      setSelected(new Set());
      await Promise.all(
        carried.map((a) => carryAssetTo(a, target!, folderId).catch(() => {})),
      );
      // The listing decides what the font menu offers, and it just changed.
      void syncLinkedLibrary();
      void reload();
    }
    if (moving.length === 0) return;
    const idset = new Set(moving.map((x) => x.id));
    patch((d) => ({
      ...d,
      assets: d.assets.map((a) => (idset.has(a.id) ? { ...a, folderId } : a)),
      templates: d.templates.map((t) =>
        idset.has(t.id) ? { ...t, folderId } : t,
      ),
    }));
    setSelected(new Set());
    await Promise.all(
      moving.map((x) => moveLibraryItem(x.residency, x.id, folderId)),
    ).catch(() => void reload());
  };

  // Carry the current selection (or just this card) as a folder-move payload,
  // with a ghost — alongside the timeline-drag payload the card already sets.
  // A single card drags as itself; a multi-selection keeps the counted stack.
  const dragSelection = (e: React.DragEvent, id: string): string[] => {
    const ids =
      selected.has(id) && selected.size > 0 ? Array.from(selected) : [id];
    if (!selected.has(id)) setSelected(new Set([id]));
    e.dataTransfer.setData(LIBRARY_MOVE_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "copyMove";
    return ids;
  };

  const onCardDragExtra = (e: React.DragEvent, a: LibraryAsset) => {
    const ids = dragSelection(e, a.id);
    if (ids.length > 1) {
      const ghost = buildDragGhost(ids.length, `${ids.length} items`);
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 18, 16);
      setTimeout(() => ghost.remove(), 0);
    } else {
      setObjectDragImage(e);
    }
  };

  const bothShelves = listed.length > 1;
  const shown = all.filter((a) => (a.folderId ?? null) === openFolder);
  // Similar-shape tiles get their own band of wrapped rows, so a wide tile
  // never shares a row with a tall one; audio and unmeasured assets band as
  // squares. Order within and across bands follows the listing. An arrival
  // bands by the shape its link is expected to take and waits at the front of
  // that band, which is where the finished asset lands.
  const shapeOf = (a: LibraryAsset) =>
    a.type === "audio" || !a.width || !a.height
      ? 0
      : shapeBand(a.width, a.height);
  const shownBands = new Map<
    number,
    ({ pending: Pending } | { asset: LibraryAsset })[]
  >();
  const band = (key: number) => {
    const found = shownBands.get(key) ?? [];
    if (found.length === 0) shownBands.set(key, found);
    return found;
  };
  for (const p of pending)
    band(p.shape ? shapeBand(p.shape.width, p.shape.height) : 0).push({
      pending: p,
    });
  for (const a of shown) band(shapeOf(a)).push({ asset: a });
  // Every tile takes the same area — a wide clip spreads, a tall one stands,
  // and each carries equal weight on the page. The area is the projects grid's,
  // so a clip and a project of the same shape are the same card.
  const TILE_AREA = 180 * 320;
  const shownTemplates = templates.filter(
    (t) => (t.folderId ?? null) === openFolder,
  );
  const openFolderName = folders.find((f) => f.id === openFolder)?.name;
  const hasContent =
    all.length > 0 ||
    folders.length > 0 ||
    templates.length > 0 ||
    pending.length > 0;

  // Only OS-file drags are drop targets here; internal card drags carry
  // LIBRARY_MOVE_MIME and are handled by the folder tiles and breadcrumb.
  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  return (
    <div
      className={cn(
        "min-h-full",
        fileOver &&
          "rounded-3xl outline-2 outline-dashed outline-offset-[-10px] outline-[#0a84ff]/60",
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
            <Button onClick={() => setAddOpen(true)}>
              <Upload data-icon="inline-start" /> Add media
            </Button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept={`video/*,audio/*,${linkedAccept()}`}
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

        {/* Folders live at the root and nowhere else, so an open folder shows
          only what is filed in it. */}
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
              return bothShelves && r ? (
                <ShelfBadge residency={r} offline={!live(r)} />
              ) : null;
            }}
            onOpen={gotoFolder}
            onCreate={async (name) => {
              if (!live(target)) return;
              const f = await createLibraryFolder(name, target);
              patch((d) => ({ ...d, folders: [...d.folders, f] }));
            }}
            onRename={async (id, name) => {
              const r = folders.find((f) => f.id === id)?.residency;
              if (!r || !live(r)) return;
              patch((d) => ({
                ...d,
                folders: d.folders.map((f) =>
                  f.id === id ? { ...f, name } : f,
                ),
              }));
              await renameLibraryFolder(r, id, name).catch(() => void reload());
            }}
            onDelete={async (id) => {
              const r = folders.find((f) => f.id === id)?.residency;
              if (!r || !live(r)) return;
              patch((d) => ({
                folders: d.folders.filter((f) => f.id !== id),
                assets: d.assets.map((a) =>
                  a.folderId === id ? { ...a, folderId: null } : a,
                ),
                templates: d.templates.map((t) =>
                  t.folderId === id ? { ...t, folderId: null } : t,
                ),
              }));
              if (openFolder === id) router.replace(homeHref(base, "library"));
              await deleteLibraryFolder(r, id).catch(() => void reload());
            }}
            onDropIds={(ids, fid) => void moveItems(ids, fid)}
            onDropFiles={(files, fid) => void upload(files, fid)}
          />
        ) : null}

        {!library.data && library.isPending ? (
          <div className="grid place-items-center py-24 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : !hasContent ? (
          <button
            className="grid w-full cursor-pointer place-items-center rounded-2xl py-24"
            onClick={() => setAddOpen(true)}
          >
            <div className="flex flex-col items-center gap-3 text-center">
              <FolderOpen className="size-8 text-muted-foreground" />
              <div className="text-base font-medium">
                Your Library is shared across all projects.
              </div>
              <p className="text-sm text-muted-foreground">
                Drag and drop videos, images, audio, or font files here.
              </p>
            </div>
          </button>
        ) : shown.length === 0 &&
          pending.length === 0 &&
          shownTemplates.length === 0 ? null : (
          <Marquee
            className="flex min-h-[40vh] flex-col content-start gap-8"
            selected={selected}
            setSelected={setSelected}
          >
            {shownTemplates.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                {shownTemplates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    mediaSrc={(f) => libraryMediaUrl(f, t.residency)}
                    drag={
                      live(t.residency)
                        ? { scope: "library", template: t }
                        : undefined
                    }
                    selectId={t.id}
                    selected={selected.has(t.id)}
                    onDragStartExtra={(e) => void dragSelection(e, t.id)}
                    onRename={
                      live(t.residency)
                        ? (name) => void renameTpl(t.residency, t.id, name)
                        : undefined
                    }
                    onDelete={
                      live(t.residency)
                        ? () => void removeTpl(t.residency, t.id)
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
            {[...shownBands.entries()].map(([shape, tiles]) => (
              <div key={shape} className="flex flex-wrap items-start gap-4">
                {tiles.map((tile) => {
                  if ("pending" in tile)
                    return (
                      <PendingTile
                        key={tile.pending.id}
                        item={tile.pending}
                        area={TILE_AREA}
                        onRetry={() => retryPending(tile.pending)}
                        onDismiss={() => dropPending(tile.pending.id)}
                      />
                    );
                  const a = tile.asset;
                  return (
                    <LibraryCard
                      key={a.id}
                      asset={a}
                      area={TILE_AREA}
                      selected={selected.has(a.id)}
                      offline={!live(a.residency)}
                      // A live item opens in the viewer. Clicking one this browser
                      // can only remember is the moment something is actually
                      // blocked, so that is when the gate's banner — and the way
                      // out of it — comes up.
                      onClick={
                        live(a.residency)
                          ? () =>
                              useLightbox.getState().open({
                                kind: a.type,
                                src: libraryMediaUrl(a.fileName, a.residency),
                                name: a.name,
                                prompt: "",
                                assetId: null,
                                libraryId: a.id,
                                bare: true,
                                ...(a.width && a.height
                                  ? { ratio: a.width / a.height }
                                  : {}),
                                ...(libraryPosterUrl(a)
                                  ? { poster: libraryPosterUrl(a) }
                                  : {}),
                              })
                          : () => setNeedsApp(true)
                      }
                      onDelete={
                        live(a.residency) ? () => setDeleting(a) : undefined
                      }
                      onDragStartExtra={(e) => onCardDragExtra(e, a)}
                    />
                  );
                })}
              </div>
            ))}
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
                  <Button
                    disabled={!url.trim()}
                    onClick={() => void importUrl()}
                  >
                    <LinkIcon /> Import
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={!!deleting}
          onOpenChange={(o) => !o && setDeleting(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Remove “{deleting?.name}” from the library?
              </AlertDialogTitle>
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

        <Lightbox />
      <TabStatus />
      </div>
    </div>
  );
}

/** A font's card is set in the font: once the shelf sync has installed it, the
 * family resolves through the registry and the tile shows the typeface itself.
 * Until then (or on a shelf that isn't answering) it falls back to the UI face,
 * which still reads as a name. */
export function LibraryCard({
  asset: a,
  selected,
  offline = false,
  area,
  mention = false,
  onClick,
  onDelete,
  onUse,
  onDragStartExtra,
}: {
  asset: LibraryAsset;
  selected?: boolean;
  /** The shelf this item is on isn't answering: it lists from memory, so the
   * card shows what it knows and reaches for no media it can't load. */
  offline?: boolean;
  /** Tile area in square pixels. When set, the tile takes the media's own
   * aspect at this shared area — a wide clip spreads, a tall one stands, and
   * every card carries the same weight. Unset, the tile fills its grid cell
   * as a square. Audio and unmeasured assets sit square either way. */
  area?: number;
  /** The card sits beside a prompt (the editor's Library panel), so its name
   * doubles as a mention token to copy. */
  mention?: boolean;
  onClick?: () => void;
  onDelete?: () => void;
  onUse?: () => void;
  onDragStartExtra?: (e: React.DragEvent) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { flash, attachReveal } = useRevealFlash("library", a.id);
  // With one shelf listed, every card is on it — the badge would say nothing.
  const bothShelves = availableResidencies().length > 1 || offline;
  // Each card is a real media element, so the source waits until the tile has
  // been scrolled near: a large library would otherwise pull every file's
  // metadata across the network the moment the page opened.
  const [tileRef, seen] = useInView<HTMLDivElement>();
  // Poster from the video itself so the still matches what plays on hover.
  // An ffmpeg still washes out iPhone HDR (HLG) footage — the browser tone-maps
  // the video correctly, so we render the frame instead of a baked thumbnail.
  const posterT = Math.min(1, Math.max(0.1, (a.duration || 2) / 10));
  // The size pill only shows on hover, so the lookup waits for the first one.
  // A font wears its size in the footer at rest, so that one asks as it scrolls
  // into view.
  const [hovered, setHovered] = useState(false);
  const font = a.type === "font";
  const sizeBytes = useMediaFileSize(
    offline ? "" : libraryMediaUrl(a.fileName, a.residency),
    hovered || (font && seen),
  );
  // TTF · 42 KB — what the file is, and how much of it there is.
  const fontMeta = [
    fileKind(a.fileName),
    sizeBytes != null && formatBytes(sizeBytes),
  ]
    .filter(Boolean)
    .join(" · ");
  const frame =
    area && a.type !== "audio" && a.width && a.height
      ? { w: a.width, h: a.height }
      : font
        ? { w: 16, h: 6 }
        : { w: 1, h: 1 };
  const tileStyle = {
    ...(area
      ? {
          width: Math.round(Math.sqrt((area * frame.w) / frame.h)),
          aspectRatio: `${frame.w} / ${frame.h}`,
        }
      : {}),
    ...(font ? { backgroundColor: SPECIMEN_BG, color: SPECIMEN_INK } : {}),
  };

  return (
    <div
      ref={attachReveal}
      data-sel-id={a.id}
      className="group flex flex-col"
      draggable={!offline}
      onClick={onClick}
      onDragStart={(e) => {
        setLibraryDragData(e, a);
        onDragStartExtra?.(e);
      }}
      onDragEnd={clearAssetDrag}
      onMouseEnter={() => {
        setHovered(true);
        void videoRef.current?.play().catch(() => {});
      }}
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
        data-drag-object
        className={cn(
          "relative max-w-full cursor-grab overflow-hidden rounded-xl border bg-muted transition-shadow group-hover:shadow-[0_4px_20px_rgba(0,0,0,0.1)] active:cursor-grabbing",
          !area && (font ? "aspect-[16/7]" : "aspect-square"),
          // The sheet is the card, so nothing is drawn around it; the type
          // scales with the tile, which runs from a panel column to a full row.
          font && "@container flex flex-col",
          selected || flash
            ? "border-[#0a84ff] ring-2 ring-[#0a84ff]"
            : font
              ? "border-transparent"
              : "border-border",
        )}
        style={tileStyle}
      >
        {font ? (
          // A pangram set in the face, and under a hairline the name it goes by
          // with the file behind it. Nothing to load from a shelf that isn't
          // answering, so that card shows the kind mark instead.
          <div className="flex size-full min-h-0 flex-col">
            <div className="grid min-h-0 flex-1 place-items-center px-3 pt-3 @[220px]:px-5 @[220px]:pt-5">
              {offline ? (
                <Type className="size-6 text-white/35" />
              ) : (
                <FontSpecimen
                  assetId={a.id}
                  fitHeight
                  pad={0}
                  className="size-full"
                />
              )}
            </div>
            <div className="mx-3 flex items-center justify-between gap-2 border-t border-white/10 py-2 @[220px]:mx-5 @[220px]:py-3">
              <CopyNameLabel
                name={a.name}
                dark
                mention={mention}
                className="min-w-0 text-[11px] font-medium @[220px]:text-[13px]"
              />
              {fontMeta && (
                <span
                  data-drag-omit
                  className="shrink-0 text-[10px] tabular-nums @[220px]:text-[11px]"
                  style={{ color: SPECIMEN_META }}
                >
                  {fontMeta}
                </span>
              )}
            </div>
          </div>
        ) : offline ? (
          // Nothing to load from a shelf that isn't answering, so the card
          // shows what it knows: the kind of file, its name, its length.
          <span className="grid size-full place-items-center">
            {a.type === "audio" ? (
              <Music className="size-6 text-muted-foreground/50" />
            ) : a.type === "image" ? (
              <ImageIcon className="size-6 text-muted-foreground/50" />
            ) : (
              <Film className="size-6 text-muted-foreground/50" />
            )}
          </span>
        ) : a.type === "video" ? (
          seen && (
            <>
              <video
                crossOrigin={MEDIA_CORS}
                ref={videoRef}
                src={`${libraryMediaUrl(a.fileName, a.residency)}#t=${posterT}`}
                poster={libraryPosterUrl(a)}
                muted
                loop
                playsInline
                preload="metadata"
                className="size-full object-cover"
              />
              {/* The source's own cover — a video's thumbnail where it came
                  from — is the face at rest: the element's poster gives way as
                  soon as the browser has the frame at #t, and that frame is
                  whatever the clip happens to hold a second in. Hovering
                  uncovers the video, which is what plays. */}
              {libraryPosterUrl(a) && (
                // eslint-disable-next-line @next/next/no-img-element -- library media file, not Next-optimizable
                <img
                  crossOrigin={MEDIA_CORS}
                  src={libraryPosterUrl(a)}
                  alt=""
                  aria-hidden
                  className="pointer-events-none absolute inset-0 size-full object-cover transition-opacity group-hover:opacity-0"
                />
              )}
            </>
          )
        ) : a.type === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- library media file, not Next-optimizable
          <img
            crossOrigin={MEDIA_CORS}
            src={libraryMediaUrl(a.fileName, a.residency)}
            alt={a.name}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <AudioCardFace
            url={libraryMediaUrl(a.fileName, a.residency)}
            duration={a.duration}
            // On hover the + button takes the pill's corner.
            durationClassName={
              !!onUse && "transition-opacity group-hover:opacity-0"
            }
          />
        )}
        {a.type !== "audio" &&
          !font &&
          (a.type === "video" || sizeBytes != null) && (
            // Length and size share one pill in the corner: on a card this narrow
            // two of them collide. The length reads at rest, the size takes over
            // on hover, where the + button is what the pointer is there for.
            <span
              data-drag-omit
              className={cn(
                "absolute right-1.5 bottom-1.5 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums",
                a.type !== "video" &&
                  "opacity-0 transition-opacity group-hover:opacity-100",
              )}
            >
              {a.type === "video" && (
                <span className={cn(sizeBytes != null && "group-hover:hidden")}>
                  {formatTime(a.duration)}
                </span>
              )}
              {sizeBytes != null && (
                <span
                  className={cn(
                    a.type === "video" && "hidden group-hover:inline",
                  )}
                >
                  {formatBytes(sizeBytes)}
                </span>
              )}
            </span>
          )}
        {a.type === "audio" && sizeBytes != null && (
          // Clear of the play circle, matching the face's duration pill.
          <span className="absolute bottom-3 left-12 rounded-md bg-[#2b4e42] px-1.5 py-0.5 font-mono text-[10px] text-[#d6eddf] tabular-nums opacity-0 transition-opacity group-hover:opacity-100">
            {formatBytes(sizeBytes)}
          </span>
        )}
        {onUse && (
          <button
            aria-label="Add to timeline"
            title="Add to timeline"
            className={cn(
              "absolute grid size-6 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow transition-all group-hover:opacity-100 hover:scale-110",
              // Audio keeps play bottom-left; + swaps in where the badge hides.
              // A font's bottom edge is its footer, so its + takes the corner
              // the name used to sit in.
              a.type === "audio"
                ? "right-1.5 bottom-1.5"
                : font
                  ? "top-1.5 left-1.5"
                  : "bottom-1.5 left-1.5",
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
            offline={offline}
            className={cn(
              "absolute top-2 right-2 transition-opacity",
              offline ? "text-muted-foreground" : "text-white/85",
              // The actions menu takes this corner on hover.
              "group-hover:opacity-0",
            )}
          />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More actions"
            title="More actions"
            className={cn(
              "absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full text-white opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100",
              // A black scrim disappears into the charcoal sheet.
              font
                ? "bg-white/10 hover:bg-white/20"
                : "bg-black/40 hover:bg-black/60",
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <Ellipsis className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            // Hung off the card's right edge rather than laid over the media:
            // the tile stays readable behind the open menu.
            align="start"
            alignOffset={4}
            className="w-44"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuItem
              onClick={() => downloadLibraryAsset(a)}
              disabled={offline}
            >
              <Download /> Download
            </DropdownMenuItem>
            {a.source?.url && (
              // An imported clip keeps the link it came from, so the post it was
              // cut out of is one click away.
              <DropdownMenuItem
                onClick={() =>
                  window.open(a.source!.url, "_blank", "noopener,noreferrer")
                }
              >
                <ExternalLink /> Open original
              </DropdownMenuItem>
            )}
            {onDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 /> Remove from library
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {!font && (
          <CopyNameLabel
            name={a.name}
            dark={a.type === "audio"}
            mention={mention}
            className={cn(
              "absolute top-1.5 left-1.5 max-w-[70%] px-2 py-1 text-[11px] font-medium text-white transition-[max-width] group-hover:max-w-[calc(100%-2.75rem)]",
              // The emerald fill is its own backdrop; thumbnails need the scrim pill.
              a.type !== "audio" && "rounded-lg bg-black/55 backdrop-blur-sm",
            )}
          />
        )}
      </div>
    </div>
  );
}
