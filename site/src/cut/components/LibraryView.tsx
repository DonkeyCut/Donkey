"use client";

import { dismissLibraryImport, importLibraryFiles, useLibraryFileImports, type LibraryArrival as Pending } from "@/cut/lib/libraryIntake";
import { LibraryImportCard } from "@/cut/components/LibraryImportCard";
import { libraryFolderRef } from "@/cut/lib/folderReference";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import {
  StickyNote,
  FolderOpen,
  FolderPlus,
  Link as LinkIcon,
  Loader2,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useDeleteKey } from "@/cut/hooks/useDeleteKey";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { setObjectDragImage } from "@/cut/lib/assetDrag";
import { LibraryCard, LIBRARY_TILE_AREA, LIBRARY_AUDIO_TILE_AREA, LIBRARY_SQUARE } from "@/cut/components/LibraryCard";
import { ShelfBadge } from "@/cut/components/ShelfBadge";
import { MEDIA_ACCEPT } from "@/cut/lib/media";
import { saveNote } from "@/cut/lib/notes";
import { notesKey, patchNotes, useNotes } from "@/cut/lib/queries";
import { patchLibrary, refetchLibrary, useLibrary } from "@/cut/lib/queries";
import {
  createLibraryFolder,
  deleteFromLibrary,
  deleteLibraryFolder,
  deleteTemplate,
  estimatedShape,
  folderDeleteTakes,
  importUrlToLibrary,
  libraryMediaUrl,
  carryAssetTo,
  carryTemplateTo,
  moveLibraryItem,
  updateLibraryFolder,
  renameTemplate,
  type LibraryAsset,
  type LibraryFolder,
  type LibraryTemplateItem,
  type LibraryData,
} from "@/cut/lib/library";
import { additiveClick } from "@/cut/lib/hostKeys";
import { linkFromText, normalizeLink } from "@/cut/lib/link";
import { dialogOnTop, isPasteTarget } from "@/cut/lib/shortcutGate";
import { lightboxItemFromLibrary, useLightbox } from "@/cut/lib/lightbox";
import { reportActivity } from "@/cut/lib/tabActivity";
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { useListedResidencies, useLocalCompute } from "@/cut/lib/backend/hooks";
import { setNeedsApp } from "@/cut/lib/needsApp";
import type { Residency } from "@/cut/lib/residency";
import { LibraryShareDialog } from "@/cut/components/LibraryShareDialog";
import type { LibraryShareTarget } from "@/cut/lib/librarySharing";
import { NotesView, type NotesViewHandle } from "@/cut/components/NotesView";
import { Lightbox } from "./Lightbox";
import { TabStatus } from "./TabStatus";
import { TemplateCard } from "./TemplateCard";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import {
  forgetLinkedCopies,
  linkedAccept,
  syncLinkedLibrary,
} from "@/cut/lib/linkedLibrary";
import { shapeBand } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { childrenOf, folderTrail, folderWithin, parentOf } from "@/cut/lib/folderTree";
import {
  FolderCrumb,
  FolderMenuItems,
  FolderShelf,
  Marquee,
  folderSelId,
  splitPick,
  useTilePicks,
} from "./desktopFolders";
import {
  DeleteConfirm,
  SelectionMenu,
  foldersGoNote,
  phoneGoNote,
  pickLabel,
  useSelectionMenu,
} from "./selectionMenu";

// A dragged library selection travels as a JSON array of asset ids, so a whole
// marquee-selected collection can be dropped onto a folder at once.
const LIBRARY_MOVE_MIME = "application/x-cut-library-move";
// A dragged folder tile, filed into another folder or back out to a crumb.
const LIBRARY_FOLDER_MOVE_MIME = "application/x-cut-library-folder";

/** A saved arrangement among the media a pick can carry off the shelf. */
const isTemplate = (x: LibraryAsset | LibraryTemplateItem): x is LibraryTemplateItem =>
  "layers" in x;

/** What a delete is about to take: folders and items, picked together. */
type DeleteSet = { folders: LibraryFolder[]; items: (LibraryAsset | LibraryTemplateItem)[] };
const NO_PICK: DeleteSet = { folders: [], items: [] };

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


export function LibraryView() {
  const noteView = useRef<NotesViewHandle>(null);
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  // The listing is cached (lib/queries.ts): coming back to the library paints
  // the shelf it painted last time and revalidates behind it. With the Donkey
  // app closed that cache is the Mac's half outright — those files are still
  // on that disk, so they still list, badged and read-only until the app is
  // back. Clicking one raises the gate's banner, which is where the way out
  // of that state lives.
  // Live while the page is open: a shelf filled from somewhere else — a phone
  // upload, a second tab, a linked import finishing — lands in the grid on its
  // own timer instead of waiting for a reload.
  const library = useLibrary({ live: true });
  const notes = useNotes();
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
  const folderList = library.data?.folders;
  const folders = useMemo(() => folderList ?? [], [folderList]);
  const templates = library.data?.templates ?? [];
  const listing: LibraryData = { assets: library.data?.assets ?? [], folders, templates };
  const patch = useCallback(
    (fn: (prev: LibraryData) => LibraryData) => patchLibrary(client, fn),
    [client],
  );
  const reload = useCallback(() => refetchLibrary(client), [client]);
  // The open folder lives in the URL (?folder=…) so the browser's back button
  // steps folder → root and the location survives reloads.
  const openFolder = useSearchParams().get("folder");
  // Media on its way in — an upload or a link — each one a tile in the grid
  // from the moment it starts, so the library shows the work rather than the
  // dialog holding it.
  const [linkPending, setPending] = useState<Pending[]>([]);
  const filePending = useLibraryFileImports((state) => state.items);
  const pending = useMemo(() => [...linkPending, ...filePending], [linkPending, filePending]);
  // One drain bounds probe, decode, and transfer work across overlapping drops.
  const [sharing, setSharing] = useState<(LibraryShareTarget & { residency: Residency }) | null>(null);
  useLayoutEffect(() => () => setSharing(null), []);
  const shareFolder = (id: string) => {
    const folder = folders.find((f) => f.id === id);
    if (folder && live(folder.residency)) setSharing({ kind: "folder", id, residency: folder.residency });
  };
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [folderCreating, setFolderCreating] = useState(false);
  // What a delete is about to take: the pick when the card is in it, else
  // the one card. Null while nothing is being asked.
  const [deleting, setDeleting] = useState<DeleteSet | null>(null);
  // The folder whose name field is open, when the right-click menu opened it.
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
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

  // Track one arrival from its first moment to its last: the tile goes up
  // before any bytes move, follows the work, and comes down when the asset
  // itself takes its place. A failure leaves the tile up with the reason.
  // Files land here long after the drop, so the tab carries the arrival.
  useEffect(() => {
    reportActivity("import", pending.some((p) => !p.error));
  }, [pending]);
  const addPending = (p: Pending) => setPending((q) => [...q, p]);
  const setStage = (id: string, stage: Pending["stage"]) =>
    setPending((q) => q.map((p) => (p.id === id ? { ...p, stage } : p)));
  const failPending = (id: string, error: string) =>
    setPending((q) => q.map((p) => (p.id === id ? { ...p, error } : p)));
  const dropPending = (id: string) => {
    setPending((q) => q.filter((p) => p.id !== id));
    dismissLibraryImport(id);
  };
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

  const upload = (files: FileList | File[], into: string | null = openFolder) => {
    const destination = landing(into);
    if (!live(destination.residency)) return Promise.resolve();
    return importLibraryFiles(files, destination, client);
  };

  // The link's tile goes up at once — shaped by what that kind of link usually
  // holds — and the dialog closes, so the wait happens in the library rather
  // than in front of it.
  const importLink = async (raw: string) => {
    const value = normalizeLink(raw);
    if (!value) return;
    const { residency, folderId } = landing(openFolder);
    if (!live(residency)) return;
    setUrl("");
    setAddOpen(false);
    const id = crypto.randomUUID();
    const run = async () => {
      try {
        // The card's id goes with the link: a retry from this card gets the
        // job it already queued.
        const imported = await importUrlToLibrary(
          value,
          residency,
          (stage) => setStage(id, stage),
          id,
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
      folderId,
      source: value,
      stage: "queued",
      startStage: "queued",
      startedAt: Date.now(),
      shape: estimatedShape(value),
      run,
    });
    await run();
  };

  // ⌘V takes what a drop takes: files copied from the desktop upload into the
  // open folder, and a copied link imports the way the link field imports it.
  // A field with the caret in it keeps its own paste.
  const intake = useRef({ upload, importLink });
  useEffect(() => {
    intake.current = { upload, importLink };
  });
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || isPasteTarget(e.target) || dialogOnTop()) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        void intake.current.upload(files);
        return;
      }
      const link = linkFromText(e.clipboardData?.getData("text/plain") ?? "");
      if (!link) return;
      e.preventDefault();
      void intake.current.importLink(link);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // The notes filed in a set of Library folders, which a delete of those
  // folders takes with it.
  const notesIn = (tree: Set<string>) =>
    (notes.data?.notes ?? []).filter((n) => {
      const at = n.libraryLocation;
      return !!at?.folderId && tree.has(at.folderId) &&
        folders.find((f) => f.id === at.folderId)?.residency === at.residency;
    });
  // Delete a set. A folder takes everything under it — the folders filed
  // there, however deep, and every item and note they hold — the way the
  // shelf deletes it; an item filed in one of those needs no delete of its
  // own. A camera clip filed there stays in Camera Roll, unfiled.
  const remove = async (set: DeleteSet) => {
    setDeleting(null);
    // A shelf that isn't answering keeps its items.
    const goneFolders = set.folders.filter((f) => live(f.residency));
    const takes = folderDeleteTakes(listing, goneFolders);
    const inTree = (x: { folderId?: string | null }) => !!x.folderId && takes.tree.has(x.folderId);
    const goneItems = set.items.filter((a) => live(a.residency) && !inTree(a));
    if (goneFolders.length + goneItems.length === 0) return;
    const gone = new Set([...goneItems, ...takes.assets, ...takes.templates].map((a) => a.id));
    forgetLinkedCopies([...goneItems.filter((a): a is LibraryAsset => !isTemplate(a)), ...takes.assets]);
    patch((d) => ({
      ...d,
      folders: d.folders.filter((f) => !takes.tree.has(f.id)),
      assets: d.assets
        .filter((a) => !gone.has(a.id))
        .map((a) => (inTree(a) ? { ...a, folderId: null } : a)),
      templates: d.templates.filter((t) => !gone.has(t.id)),
    }));
    const goneNotes = new Set(notesIn(takes.tree).map((n) => n.id));
    if (goneNotes.size)
      patchNotes(client, (d) => ({ ...d, notes: d.notes.filter((n) => !goneNotes.has(n.id)) }));
    setSelected(new Set());
    try {
      await Promise.all([
        ...goneItems.map((a) =>
          isTemplate(a) ? deleteTemplate(a.residency, a.id) : deleteFromLibrary(a.residency, a.id),
        ),
        ...goneFolders.map((f) => deleteLibraryFolder(f.residency, f.id)),
      ]);
    } catch {
      void reload();
    } finally {
      // Notes the delete took, or the ones a failed delete left in place.
      if (goneFolders.length) void client.invalidateQueries({ queryKey: notesKey });
    }
  };
  // How many items the folders hold between them, however deep — what the
  // confirm counts beside them.
  const heldBy = (fs: LibraryFolder[]) => {
    const takes = folderDeleteTakes(listing, fs);
    return takes.assets.length + takes.templates.length + notesIn(takes.tree).length;
  };
  // How many of the items a delete takes were synced from the phone, which
  // takes them off the phone too.
  const phoneSynced = (set: DeleteSet) =>
    [
      ...set.items.filter((a): a is LibraryAsset => !isTemplate(a)),
      ...folderDeleteTakes(listing, set.folders).assets,
    ].filter((a) => !!a.origin).length;

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
    const movingNotes = (notes.data?.notes ?? []).filter((n) => ids.includes(n.id));
    if (movingNotes.length) {
      try {
        const saved = await Promise.all(movingNotes.map((n) => saveNote({ ...n, libraryLocation: { folderId, residency: target ?? n.libraryLocation?.residency ?? landing(null).residency } })));
        const byId = new Map(saved.map((n) => [n.id, n]));
        patchNotes(client, (data) => ({ ...data, notes: data.notes.map((n) => byId.get(n.id) ?? n) }));
      } catch {
        void client.invalidateQueries({ queryKey: notesKey });
      }
    }
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

  // File folders under a folder (or out to the root, parentId null). A folder
  // files only beside itself: under a folder on its own shelf, never under
  // itself or anything inside it.
  const moveFolders = async (ids: string[], parentId: string | null) => {
    const target = parentId
      ? folders.find((f) => f.id === parentId)?.residency
      : null;
    if (parentId && !target) return;
    const moving = folders.filter(
      (f) =>
        ids.includes(f.id) &&
        live(f.residency) &&
        (!target || f.residency === target) &&
        parentOf(f) !== parentId &&
        !folderWithin(folders, parentId, f.id),
    );
    if (moving.length === 0) return;
    const idset = new Set(moving.map((f) => f.id));
    patch((d) => ({
      ...d,
      folders: d.folders.map((f) =>
        idset.has(f.id) ? { ...f, parentId } : f,
      ),
    }));
    setSelected(new Set());
    await Promise.all(
      moving.map((f) => updateLibraryFolder(f.residency, f.id, { parentId })),
    ).catch(() => void reload());
  };

  // Carry the current selection (or just this card) as a folder-move payload,
  // with a ghost — alongside the timeline-drag payload the card already sets.
  // A single card drags as itself; a multi-selection keeps the counted stack,
  // the folders in it riding under their own MIME.
  const dragSelection = (e: React.DragEvent, id: string): string[] => {
    const inPick = selected.has(id);
    const { folders: pickedFolders, items } = inPick
      ? splitPick(selected)
      : { folders: [], items: [id] };
    if (!inPick) setSelected(new Set([id]));
    e.dataTransfer.setData(LIBRARY_MOVE_MIME, JSON.stringify(items));
    if (pickedFolders.length)
      e.dataTransfer.setData(LIBRARY_FOLDER_MOVE_MIME, JSON.stringify(pickedFolders));
    e.dataTransfer.effectAllowed = "copyMove";
    return [id, ...items.filter((x) => x !== id), ...pickedFolders.map(folderSelId)];
  };
  const onCardDragExtra = (e: React.DragEvent, a: LibraryAsset) => {
    const ids = dragSelection(e, a.id);
    setObjectDragImage(e, ids.length, ids, () => setSelected(new Set()));
  };

  const bothShelves = listed.length > 1;
  const shown = all.filter((a) => (a.folderId ?? null) === openFolder);
  const shownTemplates = templates.filter(
    (t) => (t.folderId ?? null) === openFolder,
  );
  // The way down to the open folder, and what is filed right here.
  const trail = useMemo(() => folderTrail(folders, openFolder), [folders, openFolder]);
  const shownFolders = useMemo(() => childrenOf(folders, openFolder), [folders, openFolder]);
  // What can be picked at this level, in the order a ⇧-range runs: the
  // shelf's folders, then the grid with templates leading.
  const order = [
    ...shownFolders.map((f) => folderSelId(f.id)),
    ...[...shownTemplates, ...shown].map((a) => a.id),
  ];
  const { picked: selected, setPicked: setSelected, pick: pickTile } = useTilePicks(order);
  // The picked run, built once for the whole grid: every card hands the same
  // array to its drag and its ⌘C.
  const pickedRun = shown.filter((a) => selected.has(a.id));
  // The whole pick: the folders on the shelf, and the items with templates
  // leading the way the grid lays them out.
  const pick: DeleteSet = {
    folders: shownFolders.filter((f) => selected.has(folderSelId(f.id))),
    items: [...shownTemplates.filter((t) => selected.has(t.id)), ...pickedRun],
  };
  const pickSize = pick.folders.length + pick.items.length;
  // A card inside the pick carries the whole set, the rule its drag, its ⌘C
  // and its delete follow.
  const setOf = (a: LibraryAsset | LibraryTemplateItem): DeleteSet =>
    selected.has(a.id) ? pick : { ...NO_PICK, items: [a] };
  useDeleteKey(rootRef, pickSize > 0 ? () => setDeleting(pick) : null);
  const ctx = useSelectionMenu({ picked: selected, setPicked: setSelected, shown: order });
  const renameFolder = async (id: string, name: string) => {
    const r = folders.find((f) => f.id === id)?.residency;
    if (!r || !live(r)) return;
    patch((d) => ({
      ...d,
      folders: d.folders.map((f) =>
        f.id === id ? { ...f, name } : f,
      ),
    }));
    await updateLibraryFolder(r, id, { name }).catch(() => void reload());
  };
  // What the open right-click menu acts on.
  const ctxSet: DeleteSet = ctx.menu
    ? {
        folders: shownFolders.filter((f) => ctx.menu!.ids.includes(folderSelId(f.id))),
        items: [...shownTemplates, ...shown].filter((a) => ctx.menu!.ids.includes(a.id)),
      }
    : NO_PICK;
  // A menu over one folder offers the folder's own actions.
  const ctxFolder =
    ctxSet.folders.length === 1 && ctxSet.items.length === 0 ? ctxSet.folders[0] : null;
  // What the open confirm counts: the items the folders hold, and everything
  // going in all.
  const deletingHeld = deleting ? heldBy(deleting.folders) : 0;
  const deletingTotal = (deleting?.items.length ?? 0) + deletingHeld;
  // Right-click over a card: the selection menu. An arrival's preview is the
  // one other media here, and the browser's own menu never shows over it.
  const onPageContextMenu = (e: React.MouseEvent) => {
    if (!ctx.onContextMenu(e)) {
      e.preventDefault();
      ctx.openAt(e, []);
    }
  };
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
  const shownPending = pending.filter((p) => p.folderId === openFolder);
  for (const p of shownPending)
    band(p.shape ? shapeBand(p.shape.width, p.shape.height) : 0).push({
      pending: p,
    });
  for (const a of shown) band(shapeOf(a)).push({ asset: a });
  // Sound tiles, and every other file that is no picture, are 70% of the
  // shared tile's width and height.
  const TILE_AREA = LIBRARY_TILE_AREA;
  const audioArea = LIBRARY_AUDIO_TILE_AREA;
  // Where a new folder goes: inside the open folder on its shelf, or at the
  // top level of the shelf new items go to — the rule `landing` applies to
  // items, spelled out here so the render stays pure.
  const openOwner = openFolder
    ? folders.find((f) => f.id === openFolder)?.residency
    : null;
  const newShelf = openOwner && live(openOwner) ? openOwner : target;
  const newParent = openOwner === newShelf ? openFolder : null;
  // A folder the URL names and no shelf answers for — deleted elsewhere —
  // goes back to the top level.
  const staleFolder = !!openFolder && !!library.data && trail.length === 0;
  useEffect(() => {
    if (staleFolder) router.replace(homeHref(base, "library"));
  }, [staleFolder, router, base]);
  const hasContent =
    (notes.data?.notes.some((note) => !!note.libraryLocation) ?? false) ||
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
      ref={rootRef}
      className={cn(
        "min-h-full",
        fileOver &&
          "rounded-3xl outline-2 outline-dashed outline-offset-[-10px] outline-[#0a84ff]/60",
      )}
      onContextMenu={onPageContextMenu}
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
              trail={trail}
              onRename={openOwner && live(openOwner) ? renameFolder : undefined}
              mime={LIBRARY_MOVE_MIME}
              folderMime={LIBRARY_FOLDER_MOVE_MIME}
              onGo={gotoFolder}
              onDrop={(ids, id) => void moveItems(ids, id)}
              onDropFolders={(ids, id) => void moveFolders(ids, id)}
            />
          )}
          <div className="flex items-center gap-2">
            {openFolder && openOwner && <Button variant="outline" disabled={!live(openOwner)} onClick={() => shareFolder(openFolder)}><Share2 data-icon="inline-start" /> Share</Button>}
            {(openFolder === null || newParent) && (
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
            accept={`${MEDIA_ACCEPT},${linkedAccept()}`}
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

        {/* The folders filed at this level, at the top and inside any folder
          alike. A new one is made here and a dropped one is filed here. */}
        {shownFolders.length > 0 || folderCreating ? (
          <FolderShelf
            folders={shownFolders}
            referenceOf={(f) => libraryFolderRef(f, folders)}
            mime={LIBRARY_MOVE_MIME}
            folderMime={LIBRARY_FOLDER_MOVE_MIME}
            creating={folderCreating}
            onCreatingChange={setFolderCreating}
            statOf={(id) => ({
              count:
                all.filter((a) => (a.folderId ?? null) === id).length +
                templates.filter((t) => (t.folderId ?? null) === id).length +
                childrenOf(folders, id).length +
                (notes.data?.notes ?? []).filter((n) => n.libraryLocation?.folderId === id && n.libraryLocation.residency === folders.find((f) => f.id === id)?.residency).length,
            })}
            badgeOf={(id) => {
              const r = folders.find((f) => f.id === id)?.residency;
              return bothShelves && r ? (
                <ShelfBadge residency={r} offline={!live(r)} />
              ) : null;
            }}
            picked={selected}
            onPick={(e, id) => pickTile(e, folderSelId(id), order)}
            renaming={renamingFolder}
            onRenamingChange={setRenamingFolder}
            onOpen={gotoFolder}
            onShare={shareFolder}
            onCreate={async (name) => {
              if (!live(newShelf)) return;
              const f = await createLibraryFolder(name, newShelf, newParent);
              patch((d) => ({ ...d, folders: [...d.folders, f] }));
            }}
            onRename={renameFolder}
            // A folder in a pick with others takes the pick to the confirm;
            // alone, itself.
            onDelete={(id) => {
              const f = shownFolders.find((x) => x.id === id);
              if (!f) return;
              if (selected.has(folderSelId(id)) && pickSize > 1) setDeleting(pick);
              else setDeleting({ ...NO_PICK, folders: [f] });
            }}
            onDropIds={(ids, fid) => void moveItems(ids, fid)}
            onDropFolders={(ids, fid) => void moveFolders(ids, fid)}
            onDropFiles={(files, fid) => void upload(files, fid)}
          />
        ) : null}

        <NotesView ref={noteView} library={{ folderId: openFolder, residency: openOwner ?? target, name: trail.at(-1)?.name ?? "Library" }} />

        {!library.data && library.isPending && shownPending.length === 0 ? (
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
          shownPending.length === 0 &&
          shownTemplates.length === 0 &&
          shownFolders.length === 0 ? null : (
          <Marquee
            className="flex min-h-[40vh] flex-col content-start gap-8"
            selected={selected}
            setSelected={setSelected}
          >
            {shownTemplates.length > 0 && (
              <div className="flex flex-wrap items-start gap-4">
                {shownTemplates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    tile={LIBRARY_SQUARE}
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
                        ? () => setDeleting(setOf(t))
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
                      <LibraryImportCard
                        key={tile.pending.id}
                        item={tile.pending}
                        area={tile.pending.mediaType === "audio" ? audioArea : TILE_AREA}
                        onRetry={() => retryPending(tile.pending)}
                        onDismiss={() => dropPending(tile.pending.id)}
                      />
                    );
                  const a = tile.asset;
                  return (
                    <LibraryCard
                      key={a.id}
                      asset={a}
                      onShare={() => setSharing({ kind: "asset", id: a.id, residency: a.residency })}
                      area={a.type === "video" || a.type === "image" ? TILE_AREA : audioArea}
                      selected={selected.has(a.id)}
                      dragGroup={pickedRun}
                      offline={!live(a.residency)}
                      // A live item opens in the viewer. Clicking one this browser
                      // can only remember is the moment something is actually
                      // blocked, so that is when the gate's banner — and the way
                      // out of it — comes up.
                      onClick={(e) => {
                        if (additiveClick(e)) {
                          e.preventDefault();
                          pickTile(e, a.id, order);
                        } else if (live(a.residency))
                          useLightbox.getState().open(lightboxItemFromLibrary(a, true));
                        else setNeedsApp(true);
                      }}
                      onDelete={
                        live(a.residency) ? () => setDeleting(setOf(a)) : undefined
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
                        if (e.key === "Enter") void importLink(url);
                      }}
                    />
                  </div>
                  <Button
                    disabled={!url.trim()}
                    onClick={() => void importLink(url)}
                  >
                    <LinkIcon /> Import
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <SelectionMenu menu={ctx.menu} onClose={ctx.close}>
          {ctx.menu?.ids.length === 0 ? <>
            <DropdownMenuItem onClick={() => noteView.current?.create()}><StickyNote /> Add note</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAddOpen(true)}><Upload /> Add media</DropdownMenuItem>
          </> : ctxFolder ? (
            <FolderMenuItems
              onShare={() => shareFolder(ctxFolder.id)}
              onRename={() => setRenamingFolder(ctxFolder.id)}
              onDelete={() => setDeleting({ ...NO_PICK, folders: [ctxFolder] })}
            />
          ) : (
            <>
              {ctxSet.folders.length === 0 && ctxSet.items.length === 1 && shown.some((a) => a.id === ctxSet.items[0].id) && (
                <DropdownMenuItem
                  onClick={() => {
                    const asset = ctxSet.items[0];
                    if (live(asset.residency))
                      setSharing({ kind: "asset", id: asset.id, residency: asset.residency });
                  }}
                >
                  <Share2 /> Share
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(ctxSet)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </>
          )}
        </SelectionMenu>

        <DeleteConfirm
          open={!!deleting}
          title={
            deleting ? `Delete ${pickLabel(deleting.folders, deleting.items, ["item", "items"], deletingHeld)}?` : ""
          }
          description={`${foldersGoNote(deleting?.folders.length ?? 0, deletingHeld)}${phoneGoNote(deleting ? phoneSynced(deleting) : 0, deletingTotal)}Projects that already use ${deletingTotal === 1 ? "it" : "them"} keep their own copy.`}
          action="Remove"
          onClose={() => setDeleting(null)}
          onConfirm={() => deleting && void remove(deleting)}
        />

        {sharing && library.data && <LibraryShareDialog
          key={`${sharing.kind}:${sharing.id}`}
          target={sharing} library={library.data}
          onClose={() => setSharing(null)}
          onCopied={(target) => gotoFolder(target.kind === "folder" ? target.id : null)}
        />}
        <Lightbox />
      <TabStatus />
      </div>
    </div>
  );
}
