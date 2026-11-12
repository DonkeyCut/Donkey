"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AudioLines,
  Film,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  LayoutGrid,
  Layers,
  LayoutTemplate,
  Link as LinkIcon,
  List,
  Loader2,
  Search,
  Share2,
  StickyNote,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useDeleteKey } from "@/cut/hooks/useDeleteKey";
import { useProjectShelves } from "@/cut/hooks/useProjectShelves";
import { useTabTitle } from "@/cut/hooks/useTabTitle";
import { apiJson } from "@/cut/lib/api";
import { setObjectDragImage } from "@/cut/lib/assetDrag";
import { useEngineUser } from "@/cut/lib/backend/hooks";
import { childrenOf, folderTrail, folderWithin, parentOf, subtreeOf } from "@/cut/lib/folderTree";
import { libraryFolderRef } from "@/cut/lib/folderReference";
import { additiveClick, newTabClick } from "@/cut/lib/hostKeys";
import {
  carryAssetTo,
  carryTemplateTo,
  createLibraryFolder,
  deleteFromLibrary,
  deleteLibraryFolder,
  deleteTemplate,
  libraryMediaUrl,
  moveLibraryItem,
  renameTemplate,
  unifiedFolders,
  updateLibraryFolder,
  type LibraryAsset,
  type LibraryData,
  type LibraryTemplateItem,
} from "@/cut/lib/library";
import { dismissLibraryImport, importLibraryFiles, importLibraryLink, resumeLibraryLinks, useLibraryImports } from "@/cut/lib/libraryIntake";
import type { LibraryShareTarget } from "@/cut/lib/librarySharing";
import { lightboxItemFromLibrary, useLightbox } from "@/cut/lib/lightbox";
import { linkFromText, normalizeLink } from "@/cut/lib/link";
import { forgetLinkedCopies, linkedAccept, syncLinkedLibrary } from "@/cut/lib/linkedLibrary";
import { MEDIA_ACCEPT } from "@/cut/lib/media";
import { ASSET_TYPES, assetsHref, projectHref, useCutBase, type AssetTypeTab } from "@/cut/lib/nav";
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { setNeedsApp } from "@/cut/lib/needsApp";
import { saveNote } from "@/cut/lib/notes";
import {
  backendFor,
  notesKey,
  patchLibrary,
  patchNotes,
  patchProjects,
  refetchLibrary,
  refetchProjects,
  renameInLibrary,
  useLibrary,
  useNotes,
  type ProjectsSection,
} from "@/cut/lib/queries";
import type { Residency } from "@/cut/lib/residency";
import { dialogOnTop, isPasteTarget } from "@/cut/lib/shortcutGate";
import { reportActivity } from "@/cut/lib/tabActivity";
import { formatDate, formatTime } from "@/cut/lib/time";
import { errorFromBody } from "@/cut/lib/userError";
import { useDescribeError } from "@/i18n/describeError";
import { formatBytes } from "@/lib/bytes";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { LibraryCard, LIBRARY_AUDIO_TILE_AREA, LIBRARY_SQUARE } from "@/cut/components/LibraryCard";
import { LibraryImportCard } from "@/cut/components/LibraryImportCard";
import { LibraryShareDialog } from "@/cut/components/LibraryShareDialog";
import { Lightbox } from "@/cut/components/Lightbox";
import { NotesView, notesShownIn, type NotesViewHandle } from "@/cut/components/NotesView";
import { ShelfBadge } from "@/cut/components/ShelfBadge";
import { TabStatus } from "@/cut/components/TabStatus";
import { TemplateCard } from "@/cut/components/TemplateCard";
import {
  FolderCrumb,
  FolderMenuItems,
  FolderShelf,
  Marquee,
  folderSelId,
  splitPick,
  useTilePicks,
  type FolderLayout,
} from "@/cut/components/desktopFolders";
import { DeleteConfirm, SelectionMenu, usePickWords, useSelectionMenu } from "@/cut/components/selectionMenu";
import { ASSET_ROW, ASSET_ROW_PICKED, AssetTable } from "./assetTable";
import { GraceBanner } from "./GraceBanner";
import { ProjectMenu, ProjectMenuItems, ProjectTile, ResidencyBadge } from "./ProjectCard";
import { useProjectActions } from "./projectActions";
import {
  assetEntries,
  cardArea,
  cardBox,
  entryOnTab,
  mergeFolders,
  nameMatches,
  projectFrame,
  type AssetEntry,
  type AssetFolder,
} from "./assetsListing";

// Everything on the page drags under one payload: a JSON array of the ids
// picked, projects, files and notes alike, so one drop files a mixed pick.
const ASSET_MOVE_MIME = "application/x-cut-library-move";
// A dragged folder tile, filed into another folder or back out to a crumb.
const ASSET_FOLDER_MIME = "application/x-cut-library-folder";

// MouseEvent.button for the middle (wheel) button.
const MIDDLE_BUTTON = 1;

// A delete that finds the project already gone has done its job.
const HTTP_NOT_FOUND = 404;

// Grid or list, remembered per browser across both the old Projects page and
// this one.
type View = "gallery" | "list";
const VIEW_KEY = "cut-projects-view";
const viewListeners = new Set<() => void>();
const readView = (): View => (localStorage.getItem(VIEW_KEY) === "list" ? "list" : "gallery");
const serverView = (): View => "gallery";
const subscribeView = (notify: () => void) => {
  viewListeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    viewListeners.delete(notify);
    window.removeEventListener("storage", notify);
  };
};

/** What a delete is about to take: folders and cards, picked together. */
type DeleteSet = { folders: AssetFolder[]; entries: AssetEntry[] };
const NO_PICK: DeleteSet = { folders: [], entries: [] };

// Each media type's list icon.
const TYPE_ICON: Record<LibraryAsset["type"], typeof Film> = {
  video: Film,
  image: ImageIcon,
  audio: AudioLines,
  font: Type,
  lut: LayoutTemplate,
};

const isTypeTab = (v: string | null): v is AssetTypeTab => !!v && (ASSET_TYPES as readonly string[]).includes(v);

// The type tab last picked, remembered per browser: a plain link to Assets
// opens on it, and on Projects before any pick.
const TAB_KEY = "cut-assets-type";
const DEFAULT_TAB: AssetTypeTab = "projects";
const tabListeners = new Set<() => void>();
const readTab = (): AssetTypeTab => {
  const stored = localStorage.getItem(TAB_KEY);
  return isTypeTab(stored) ? stored : DEFAULT_TAB;
};
const serverTab = (): AssetTypeTab => DEFAULT_TAB;
const subscribeTab = (notify: () => void) => {
  tabListeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    tabListeners.delete(notify);
    window.removeEventListener("storage", notify);
  };
};

// A shelf's refusal: its reply body, whose code and words the failure keeps.
const refusalOf = async (res: Response | null) => (res ? await apiJson<object>(res) : null);

/** Whether the Mac's engine keeps project folders apart from library folders:
 * an app from before the one folder tree. A legacy shelf files projects only
 * in its project folders, and files only in its library folders. */
function useLegacyMacFolders(engineUp: boolean): boolean {
  const [legacy, setLegacy] = useState(false);
  useEffect(() => {
    if (!engineUp) {
      return;
    }
    let alive = true;
    void unifiedFolders("local").then((one) => {
      if (alive) {
        setLegacy(!one);
      }
    });
    return () => {
      alive = false;
    };
  }, [engineUp]);
  return legacy;
}

/**
 * Assets: every project, file, template and note the user has, on every shelf,
 * in one tree of folders. Folders hold any mix. A type tab narrows the grid,
 * search looks everywhere by name, and a drop anywhere uploads into the folder
 * that is open.
 */
export function AssetsView() {
  const t = useTranslations("home");
  const locale = useLocale();
  const describeError = useDescribeError();
  const { pickLabel, foldersGoNote, phoneGoNote } = usePickWords();
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  const noteView = useRef<NotesViewHandle>(null);

  // Where the page is: the open folder and type tab ride the URL, so the back
  // button steps out of a folder and a link opens the same view.
  const params = useSearchParams();
  const openFolder = params.get("folder");
  const typeParam = params.get("type");
  const storedTab = useSyncExternalStore(subscribeTab, readTab, serverTab);
  const tab: AssetTypeTab = isTypeTab(typeParam) ? typeParam : storedTab;
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;

  // The shelves, and which of them take changes right now.
  const { residencies, engineUp, live, sections } = useProjectShelves();
  const dual = residencies.length > 1;
  const legacyMac = useLegacyMacFolders(engineUp);
  const unified = (r: Residency) => r !== "local" || !legacyMac;
  const { target } = useNewProjectTarget();

  // The listings. The library listing merges every shelf and stays live, so
  // a phone upload or a second tab lands without a reload; projects list per
  // shelf. Both are cached, so coming back paints at once.
  const library = useLibrary({ live: true });
  const notes = useNotes();
  const shelves = useMemo(
    () =>
      residencies.map((r) => ({
        residency: r,
        projects: sections[r].data?.projects ?? [],
        folders: sections[r].data?.folders ?? [],
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the sections' data is what changes
    [residencies, sections.local.data, sections.cloud.data, sections.browser.data],
  );
  const libraryData = library.data;
  const listing: LibraryData = useMemo(
    () => libraryData ?? { assets: [], folders: [], templates: [] },
    [libraryData],
  );
  const folders = useMemo(() => mergeFolders(listing.folders, shelves), [listing.folders, shelves]);
  const entries = useMemo(() => assetEntries(listing, shelves), [listing, shelves]);
  const noteList = useMemo(() => notes.data?.notes ?? [], [notes.data]);

  // Drop the app banner when this view goes away: it belongs to the surface
  // that raised it. Linked kinds (fonts, LUTs) are put to use at once.
  useEffect(() => () => setNeedsApp(false), []);
  useEffect(() => void syncLinkedLibrary(), []);

  // A reload cuts a link import's page off from its job; its tile comes back.
  const engineUser = useEngineUser();
  useEffect(() => {
    void resumeLibraryLinks(client);
  }, [client, engineUser]);
  const pending = useLibraryImports((state) => state.items);
  useEffect(() => {
    reportActivity("import", pending.some((p) => !p.error));
  }, [pending]);

  const view = useSyncExternalStore(subscribeView, readView, serverView);
  const switchView = (v: View) => {
    localStorage.setItem(VIEW_KEY, v);
    viewListeners.forEach((notify) => notify());
  };

  // Dialog and menu state.
  const [folderCreating, setFolderCreating] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DeleteSet | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sharing, setSharing] = useState<(LibraryShareTarget & { residency: Residency }) | null>(null);
  useLayoutEffect(() => () => setSharing(null), []);
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileOver, setFileOver] = useState(false);
  const dragDepth = useRef(0);

  // Optimistic edits; the next revalidation reconciles what the shelf did.
  const patchLib = useCallback((fn: (prev: LibraryData) => LibraryData) => patchLibrary(client, fn), [client]);
  const patchShelf = useCallback(
    (r: Residency, fn: (s: ProjectsSection) => ProjectsSection) => patchProjects(client, r, fn),
    [client],
  );
  const reload = useCallback(() => {
    void refetchLibrary(client);
    for (const r of residencies) {
      void refetchProjects(client, r);
    }
  }, [client, residencies]);

  const folderOf = (id: string | null) => (id ? folders.find((f) => f.id === id) ?? null : null);
  const open = folderOf(openFolder);
  const trail = folderTrail(folders, openFolder);
  useTabTitle(params.has("note") ? null : openFolder ? trail.at(-1)?.name : t("tabs.assets"));

  // A folder the URL names and no shelf answers for — deleted elsewhere —
  // goes back to the top level.
  const settled = !!library.data && residencies.every((r) => sections[r].data || sections[r].isError);
  const staleFolder = !!openFolder && settled && !open;
  useEffect(() => {
    if (staleFolder) {
      router.replace(assetsHref(base, tab));
    }
  }, [staleFolder, router, base, tab]);

  // Where new things land: the open folder when its shelf answers and keeps
  // files there, else the top of the shelf new projects go to.
  const landing = (folderId: string | null) => {
    const f = folderOf(folderId);
    const residency = f && live(f.residency) ? f.residency : target;
    const filed = f && f.residency === residency && f.store === "library";
    return { residency, folderId: filed ? f.id : null };
  };
  const newShelf = open && live(open.residency) ? open.residency : target;
  const newParent = open && open.residency === newShelf && open.store === "library" ? open.id : null;

  // Navigation keeps the tab; a folder opens by URL so it is shareable.
  const gotoFolder = (id: string | null) => {
    setSelected(new Set());
    router.push(assetsHref(base, tab, id));
  };
  const gotoTab = (next: AssetTypeTab) => {
    setSelected(new Set());
    localStorage.setItem(TAB_KEY, next);
    tabListeners.forEach((notify) => notify());
    router.replace(assetsHref(base, next, openFolder));
  };

  // ── What shows ──────────────────────────────────────────────────────────
  // Search looks in every folder; otherwise the open folder's own cards.
  const here = (x: { folderId: string | null }) => x.folderId === openFolder;
  const shownEntries = entries.filter(
    (e) => entryOnTab(e, tab) && (searching ? nameMatches(e.name, query) : here(e)),
  );
  const shownFolders = searching
    ? folders.filter((f) => nameMatches(f.name, query))
    : childrenOf(folders, openFolder);
  const pendingTab = (mediaType: string | undefined) =>
    tab === "all" || (tab === "videos" && mediaType === "video") || (tab === "images" && mediaType === "image") || (tab === "audio" && mediaType === "audio");
  const shownPending = searching ? [] : pending.filter((p) => p.folderId === openFolder && pendingTab(p.mediaType));
  const notesShown = tab === "all" || tab === "notes";
  const notesHere = notesShown
    ? notesShownIn(noteList, { folderId: openFolder, residency: open?.residency ?? target, name: "" }, searching ? query : "").length
    : 0;

  // What can be picked, in the order a ⇧-range runs: folders, then cards.
  const order = [...shownFolders.map((f) => folderSelId(f.id)), ...shownEntries.map((e) => e.id)];
  const { picked: selected, setPicked: setSelected, pick: pickTile } = useTilePicks(order);
  const pick: DeleteSet = {
    folders: shownFolders.filter((f) => selected.has(folderSelId(f.id)) && live(f.residency)),
    entries: shownEntries.filter((e) => selected.has(e.id) && live(e.residency)),
  };
  const pickSize = pick.folders.length + pick.entries.length;
  const setOf = (e: AssetEntry): DeleteSet => (selected.has(e.id) ? pick : { ...NO_PICK, entries: [e] });
  useDeleteKey(rootRef, pickSize > 0 ? () => setDeleting(pick) : null);
  const ctx = useSelectionMenu({ picked: selected, setPicked: setSelected, shown: order });
  const pickedMedia = shownEntries.flatMap((e) => (e.kind === "media" && selected.has(e.id) ? [e.asset] : []));

  // ── Folders ─────────────────────────────────────────────────────────────
  const notesIn = (tree: Set<string>, residency: Residency) =>
    noteList.filter((n) => {
      const at = n.libraryLocation;
      return !!at?.folderId && tree.has(at.folderId) && at.residency === residency;
    });
  // Everything a folder delete takes on its shelf: the subtree, and every
  // card and note filed in it.
  const takenBy = (fs: AssetFolder[]) => {
    const tree = new Set<string>();
    for (const f of fs) {
      const own = folders.filter((x) => x.residency === f.residency);
      for (const id of subtreeOf(own, f.id)) {
        tree.add(id);
      }
    }
    const taken = entries.filter((e) => !!e.folderId && tree.has(e.folderId));
    const takenNotes = fs.flatMap((f) => notesIn(tree, f.residency));
    return { tree, entries: taken, notes: takenNotes };
  };

  const createFolder = async (fname: string) => {
    if (!live(newShelf)) {
      return;
    }
    const f = await createLibraryFolder(fname, newShelf, newParent);
    patchLib((d) => ({ ...d, folders: [...d.folders, f] }));
    track("folder_created");
  };

  // A folder is written through its store: the library's, or an older Mac
  // engine's project folders.
  const folderFetch = (f: AssetFolder, init: RequestInit) =>
    backendFor(f.residency).fetch(`/api/cut/projects/folders/${f.id}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });

  const renameFolder = async (id: string, fname: string) => {
    const f = folderOf(id);
    if (!f || !live(f.residency)) {
      return;
    }
    if (f.store === "projects") {
      patchShelf(f.residency, (s) => ({ ...s, folders: s.folders.map((x) => (x.id === id ? { ...x, name: fname } : x)) }));
      await folderFetch(f, { method: "PUT", body: JSON.stringify({ name: fname }) }).catch(() => reload());
      return;
    }
    patchLib((d) => ({ ...d, folders: d.folders.map((x) => (x.id === id ? { ...x, name: fname } : x)) }));
    await updateLibraryFolder(f.residency, id, { name: fname }).catch(() => reload());
  };

  // File folders under a folder (or out to the top, parentId null): on their
  // own shelf and store, never under themselves or anything inside them.
  const moveFolders = async (ids: string[], parentId: string | null) => {
    const parent = folderOf(parentId);
    if (parentId && !parent) {
      return;
    }
    const moving = folders.filter(
      (f) =>
        ids.includes(f.id) &&
        live(f.residency) &&
        (!parent || (f.residency === parent.residency && f.store === parent.store)) &&
        parentOf(f) !== parentId &&
        !folderWithin(folders, parentId, f.id),
    );
    if (moving.length === 0) {
      return;
    }
    const idset = new Set(moving.map((f) => f.id));
    patchLib((d) => ({ ...d, folders: d.folders.map((f) => (idset.has(f.id) ? { ...f, parentId } : f)) }));
    for (const r of residencies) {
      patchShelf(r, (s) => ({ ...s, folders: s.folders.map((f) => (idset.has(f.id) ? { ...f, parentId } : f)) }));
    }
    setSelected(new Set());
    await Promise.all(
      moving.map((f) =>
        f.store === "projects"
          ? folderFetch(f, { method: "PUT", body: JSON.stringify({ parentId }) })
          : updateLibraryFolder(f.residency, f.id, { parentId }),
      ),
    ).catch(() => reload());
  };

  // ── Filing cards ────────────────────────────────────────────────────────
  // File a pick into a folder (or out to the top). A project files on its own
  // shelf; a file or template carries across to the folder's shelf; a note
  // follows wherever it is put.
  const moveItems = async (ids: string[], folderId: string | null) => {
    const dest = folderOf(folderId);
    if (folderId && !dest) {
      return;
    }
    if (dest && !live(dest.residency)) {
      return;
    }
    const takesFiles = !dest || dest.store === "library";
    setSelected(new Set());

    // Notes ride their own library location.
    const movingNotes = takesFiles ? noteList.filter((n) => ids.includes(n.id)) : [];
    if (movingNotes.length) {
      try {
        const saved = await Promise.all(
          movingNotes.map((n) =>
            saveNote({
              ...n,
              libraryLocation: {
                folderId,
                residency: dest?.residency ?? n.libraryLocation?.residency ?? landing(null).residency,
              },
            }),
          ),
        );
        const byId = new Map(saved.map((n) => [n.id, n]));
        patchNotes(client, (d) => ({ ...d, notes: d.notes.map((n) => byId.get(n.id) ?? n) }));
      } catch {
        void client.invalidateQueries({ queryKey: notesKey });
      }
    }

    const picked = entries.filter((e) => ids.includes(e.id) && live(e.residency));

    // Projects stay on their shelf, and an older Mac engine files them only
    // in its project folders.
    const projects = picked.filter(
      (e): e is AssetEntry & { kind: "project" } =>
        e.kind === "project" &&
        e.folderId !== folderId &&
        (!dest || (dest.residency === e.residency && (dest.store === "projects" || unified(e.residency)))),
    );
    const refused = picked.some((e) => e.kind === "project" && !projects.includes(e) && e.folderId !== folderId);

    // Files and templates on the folder's shelf move; on another shelf they
    // carry across, the bytes going with them.
    const files = takesFiles
      ? picked.filter((e) => e.kind !== "project" && e.folderId !== folderId && (!dest || dest.store === "library" || unified(e.residency)))
      : [];
    const staying = files.filter((e) => !dest || e.residency === dest.residency);
    const carried = dest ? files.filter((e) => e.residency !== dest.residency) : [];

    if (refused) {
      setFailure(t("assets.projectStaysOnShelf"));
    }

    if (projects.length) {
      for (const r of residencies) {
        const mine = new Set(projects.filter((p) => p.residency === r).map((p) => p.id));
        if (mine.size === 0) {
          continue;
        }
        patchShelf(r, (s) => ({ ...s, projects: s.projects.map((p) => (mine.has(p.id) ? { ...p, folderId } : p)) }));
      }
    }
    if (staying.length) {
      const idset = new Set(staying.map((e) => e.id));
      patchLib((d) => ({
        ...d,
        assets: d.assets.map((a) => (idset.has(a.id) ? { ...a, folderId } : a)),
        templates: d.templates.map((x) => (idset.has(x.id) ? { ...x, folderId } : x)),
      }));
    }

    await Promise.all([
      ...projects.map((p) =>
        backendFor(p.residency)
          .fetch(`/api/cut/projects/${p.id}/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folderId }),
          })
          .then((res) => {
            if (!res.ok) {
              throw new Error(res.statusText);
            }
          }),
      ),
      ...staying.map((e) => moveLibraryItem(e.residency, e.id, folderId)),
      ...carried.map((e) =>
        e.kind === "template"
          ? carryTemplateTo(e.template, dest!.residency, folderId).catch(() => {})
          : e.kind === "media"
            ? carryAssetTo(e.asset, dest!.residency, folderId).catch(() => {})
            : Promise.resolve(),
      ),
    ]).catch(() => reload());
    if (carried.length) {
      void syncLinkedLibrary();
      reload();
    }
  };

  // Begin a drag: a card in the pick carries the whole pick, folders under
  // their own type; any other card carries itself.
  const dragPick = (e: React.DragEvent, id: string): string[] => {
    const inPick = selected.has(id);
    const { folders: pickedFolders, items } = inPick ? splitPick(selected) : { folders: [], items: [id] };
    if (!inPick) {
      setSelected(new Set([id]));
    }
    e.dataTransfer.setData(ASSET_MOVE_MIME, JSON.stringify(items));
    if (pickedFolders.length) {
      e.dataTransfer.setData(ASSET_FOLDER_MIME, JSON.stringify(pickedFolders));
    }
    e.dataTransfer.effectAllowed = "copyMove";
    return [id, ...items.filter((x) => x !== id), ...pickedFolders.map(folderSelId)];
  };
  const dragWithGhost = (e: React.DragEvent, id: string) => {
    const ids = dragPick(e, id);
    setObjectDragImage(e, ids.length, ids, () => setSelected(new Set()));
  };

  // ── Uploads ─────────────────────────────────────────────────────────────
  const upload = (files: FileList | File[], into: string | null = openFolder) => {
    const destination = landing(into);
    if (!live(destination.residency)) {
      return Promise.resolve();
    }
    return importLibraryFiles(files, destination, client);
  };
  // The link's tile goes up at once and the dialog closes, so the wait
  // happens on the page.
  const importLink = async (raw: string) => {
    const value = normalizeLink(raw);
    if (!value) {
      return;
    }
    const destination = landing(openFolder);
    if (!live(destination.residency)) {
      return;
    }
    setUrl("");
    setAddOpen(false);
    await importLibraryLink(value, destination, client);
  };
  // ⌘V takes what a drop takes: copied files upload into the open folder and
  // a copied link imports. A field with the caret keeps its own paste.
  const intake = useRef({ upload, importLink });
  useEffect(() => {
    intake.current = { upload, importLink };
  });
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || isPasteTarget(e.target) || dialogOnTop()) {
        return;
      }
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        void intake.current.upload(files);
        return;
      }
      const link = linkFromText(e.clipboardData?.getData("text/plain") ?? "");
      if (!link) {
        return;
      }
      e.preventDefault();
      void intake.current.importLink(link);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // ── Projects ────────────────────────────────────────────────────────────
  const actions = useProjectActions({ live, busy, setBusy, setFailure });
  const { moveDests, moveAcross } = actions;

  // A click opens the project; ⌘-click or a middle click opens it in a new
  // tab; shift-click adds it to the pick.
  const openProject = (e: React.MouseEvent, id: string) => {
    const href = projectHref(base, id, "assets", openFolder);
    if (e.button === MIDDLE_BUTTON || newTabClick(e)) {
      e.preventDefault();
      window.open(href, "_blank", "noopener");
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (additiveClick(e)) {
      e.preventDefault();
      pickTile(e, id, order);
      return;
    }
    router.push(href);
  };

  const projectMenu = (e: AssetEntry & { kind: "project" }) => ({
    ...actions.menuFor(e),
    onDelete: () => setDeleting(setOf(e)),
  });

  // ── Delete ──────────────────────────────────────────────────────────────
  // A folder takes everything under it; a card filed in one of those needs
  // no delete of its own. A shelf that isn't answering keeps its own.
  const remove = async (set: DeleteSet) => {
    setDeleting(null);
    const goneFolders = set.folders.filter((f) => live(f.residency));
    const taken = takenBy(goneFolders);
    const goneEntries = set.entries.filter((e) => live(e.residency) && !(e.folderId && taken.tree.has(e.folderId)));
    if (goneFolders.length + goneEntries.length === 0) {
      return;
    }
    const all = [...goneEntries, ...taken.entries];
    const gone = new Set(all.map((e) => e.id));
    const goneMedia = all.flatMap((e) => (e.kind === "media" ? [e.asset] : []));
    forgetLinkedCopies(goneMedia);
    patchLib((d) => ({
      folders: d.folders.filter((f) => !taken.tree.has(f.id)),
      assets: d.assets.filter((a) => !gone.has(a.id)),
      templates: d.templates.filter((x) => !gone.has(x.id)),
    }));
    for (const r of residencies) {
      patchShelf(r, (s) => ({
        folders: s.folders.filter((f) => !taken.tree.has(f.id)),
        projects: s.projects.filter((p) => !gone.has(p.id)),
      }));
    }
    const goneNotes = new Set(taken.notes.map((n) => n.id));
    if (goneNotes.size) {
      patchNotes(client, (d) => ({ ...d, notes: d.notes.filter((n) => !goneNotes.has(n.id)) }));
    }
    setSelected(new Set());
    setBusy(true);
    try {
      await Promise.all([
        ...goneEntries.map(async (e) => {
          if (e.kind === "media") {
            return deleteFromLibrary(e.residency, e.id);
          }
          if (e.kind === "template") {
            return deleteTemplate(e.residency, e.id);
          }
          const res = await backendFor(e.residency).fetch(`/api/cut/projects/${e.id}`, { method: "DELETE" });
          // A project already gone, e.g. deleted from another tab, is done.
          if (!res.ok && res.status !== HTTP_NOT_FOUND) {
            throw errorFromBody(await refusalOf(res), t("projects.deleteProjectFailed"));
          }
        }),
        ...goneFolders.map(async (f) => {
          if (f.store === "library") {
            return deleteLibraryFolder(f.residency, f.id);
          }
          const res = await folderFetch(f, { method: "DELETE" }).catch(() => null);
          if (!res?.ok) {
            throw errorFromBody(await refusalOf(res), t("projects.deleteFolderFailed"));
          }
        }),
      ]);
      for (const e of all) {
        if (e.kind === "project") {
          actions.purge(e.id, e.residency);
        }
      }
    } catch (err) {
      setFailure(describeError(err, t("projects.deleteFailed")));
      reload();
    } finally {
      setBusy(false);
      if (goneFolders.length) {
        void client.invalidateQueries({ queryKey: notesKey });
      }
    }
  };

  // What the open confirm counts and says.
  const deletingTaken = deleting ? takenBy(deleting.folders) : null;
  const deletingHeld = deletingTaken ? deletingTaken.entries.length + deletingTaken.notes.length : 0;
  const deletingAll = deleting ? [...deleting.entries, ...(deletingTaken?.entries ?? [])] : [];
  const deletingTotal = (deleting?.entries.length ?? 0) + deletingHeld;
  const deletingProjects = deletingAll.filter((e) => e.kind === "project").length;
  const deletingFiles = deletingAll.filter((e) => e.kind !== "project");
  const phoneSynced = deletingFiles.filter((e) => e.kind === "media" && !!e.asset.origin).length;
  const deleteNote = [
    foldersGoNote(deleting?.folders.length ?? 0, deletingHeld),
    phoneGoNote(phoneSynced, deletingTotal),
    deletingProjects ? `${t("projects.deletesFolders", { count: deletingProjects })} ` : "",
    deletingFiles.length ? `${t("library.keepCopy", { count: deletingFiles.length })} ` : "",
    deletingProjects ? t("projects.cannotUndo") : "",
  ].join("");

  // ── Right-click ─────────────────────────────────────────────────────────
  const ctxSet: DeleteSet = ctx.menu
    ? {
        folders: shownFolders.filter((f) => ctx.menu!.ids.includes(folderSelId(f.id)) && live(f.residency)),
        entries: shownEntries.filter((e) => ctx.menu!.ids.includes(e.id) && live(e.residency)),
      }
    : NO_PICK;
  const ctxFolder = ctxSet.folders.length === 1 && ctxSet.entries.length === 0 ? ctxSet.folders[0] : null;
  const ctxOne = ctxSet.folders.length === 0 && ctxSet.entries.length === 1 ? ctxSet.entries[0] : null;
  const ctxProjects = ctxSet.entries.filter((e): e is AssetEntry & { kind: "project" } => e.kind === "project");
  // Moving a pick across shelves offers only a place every project in it
  // can go, and only while the pick is all projects.
  const ctxMoveTo =
    ctxProjects.length && ctxProjects.length === ctxSet.entries.length && ctxSet.folders.length === 0
      ? moveDests(ctxProjects[0].residency)
          .filter((d) => ctxProjects.every((e) => moveDests(e.residency).includes(d)))
          .map((d) => ({
            target: d,
            run: () =>
              void (async () => {
                for (const e of ctxProjects) {
                  await moveAcross(d, e);
                }
              })(),
          }))
      : [];
  const onPageContextMenu = (e: React.MouseEvent) => {
    if (!ctx.onContextMenu(e)) {
      e.preventDefault();
      ctx.openAt(e, []);
    }
  };

  const shareFolder = (id: string) => {
    const f = folderOf(id);
    if (f && f.store === "library" && live(f.residency)) {
      setSharing({ kind: "folder", id, residency: f.residency });
    }
  };

  // ── Page state ──────────────────────────────────────────────────────────
  const loading = !library.data && library.isPending && residencies.every((r) => sections[r].isLoading);
  const placedNotes = noteList.some((n) => !!n.libraryLocation);
  const hasContent = entries.length > 0 || folders.length > 0 || pending.length > 0 || placedNotes;
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const cloudListed = residencies.includes("cloud");

  // ── Cards ───────────────────────────────────────────────────────────────
  const renderCard = (e: AssetEntry) => {
    if (e.kind === "project") {
      const offline = !live(e.residency);
      return (
        <ProjectTile
          key={e.id}
          project={e.project}
          residency={e.residency}
          offline={offline}
          badge={dual ? "residency" : "none"}
          selected={selected.has(e.id)}
          box={cardBox(projectFrame(e.project))}
          meta={t("projects.cardMeta", {
            size: formatBytes(e.project.sizeBytes ?? 0, locale),
            date: formatDate(e.project.updatedAt, locale, t("justNow")),
          })}
          draggable={!offline}
          onDragStart={(ev) => dragWithGhost(ev, e.id)}
          onClick={(ev) => openProject(ev, e.id)}
          onAuxClick={(ev) => openProject(ev, e.id)}
          menu={
            !offline && (
              <ProjectMenu
                className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 data-[state=open]:opacity-100"
                {...projectMenu(e)}
              />
            )
          }
        />
      );
    }
    if (e.kind === "template") {
      const x = e.template;
      return (
        <TemplateCard
          key={x.id}
          tile={LIBRARY_SQUARE}
          template={x}
          mediaSrc={(f) => libraryMediaUrl(f, x.residency)}
          drag={live(x.residency) ? { scope: "library", template: x } : undefined}
          selectId={x.id}
          selected={selected.has(x.id)}
          onDragStartExtra={(ev) => void dragPick(ev, x.id)}
          onRename={live(x.residency) ? (n) => void renameTpl(x, n) : undefined}
          onDelete={live(x.residency) ? () => setDeleting(setOf(e)) : undefined}
        />
      );
    }
    const a = e.asset;
    const picture = (a.type === "video" || a.type === "image") && a.width && a.height;
    return (
      <LibraryCard
        key={a.id}
        asset={a}
        onShare={() => setSharing({ kind: "asset", id: a.id, residency: a.residency })}
        area={picture ? cardArea({ w: a.width!, h: a.height! }) : LIBRARY_AUDIO_TILE_AREA}
        selected={selected.has(a.id)}
        dragGroup={pickedMedia}
        offline={!live(a.residency)}
        onClick={(ev) => {
          if (additiveClick(ev)) {
            ev.preventDefault();
            pickTile(ev, a.id, order);
            return;
          }
          if (live(a.residency)) {
            useLightbox.getState().open(lightboxItemFromLibrary(a, true));
            return;
          }
          setNeedsApp(true);
        }}
        onDelete={live(a.residency) ? () => setDeleting(setOf(e)) : undefined}
        onRename={live(a.residency) ? (n) => renameInLibrary(client, a, n) : undefined}
        onDragStartExtra={(ev) => dragWithGhost(ev, a.id)}
      />
    );
  };

  const renameTpl = async (x: LibraryTemplateItem, n: string) => {
    patchLib((d) => ({ ...d, templates: d.templates.map((y) => (y.id === x.id ? { ...y, name: n } : y)) }));
    await renameTemplate(x.residency, x.id, n).catch(() => reload());
  };

  // The list: one row per card, the same pick and menus.
  const renderRow = (e: AssetEntry) => {
    const offline = !live(e.residency);
    const Icon = e.kind === "project" ? Film : e.kind === "template" ? Layers : TYPE_ICON[e.asset.type];
    const length = e.kind === "project" ? e.project.duration : e.kind === "media" ? e.asset.duration : e.template.duration;
    const size = e.kind === "project" ? formatBytes(e.project.sizeBytes ?? 0, locale) : "";
    const openRow = (ev: React.MouseEvent) => {
      if (e.kind === "project") {
        openProject(ev, e.id);
        return;
      }
      if (additiveClick(ev)) {
        ev.preventDefault();
        pickTile(ev, e.id, order);
        return;
      }
      if (e.kind !== "media") {
        return;
      }
      if (live(e.residency)) {
        useLightbox.getState().open(lightboxItemFromLibrary(e.asset, true));
        return;
      }
      setNeedsApp(true);
    };
    return (
      <div
        key={e.id}
        data-sel-id={e.id}
        className={cn(ASSET_ROW, "group", selected.has(e.id) && ASSET_ROW_PICKED)}
        draggable={!offline}
        onDragStart={(ev) => dragWithGhost(ev, e.id)}
        onClick={openRow}
        onAuxClick={e.kind === "project" ? openRow : undefined}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{e.name}</span>
          {dual && <ResidencyBadge residency={e.residency} offline={offline} className="shrink-0 text-muted-foreground" />}
        </span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{length ? formatTime(length) : ""}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{size}</span>
        <span className="text-xs text-muted-foreground">{formatDate(e.at, locale, t("justNow"))}</span>
        {e.kind === "project" && !offline ? (
          <ProjectMenu
            className="bg-transparent text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground pointer-coarse:opacity-100 data-[state=open]:opacity-100"
            {...projectMenu(e)}
          />
        ) : (
          <span />
        )}
      </div>
    );
  };

  // The folders filed here (or the ones a search finds) and the notes, as
  // grid tiles or as rows of the list.
  const folderShelf = (layout: FolderLayout) => (
    <FolderShelf
      layout={layout}
      folders={shownFolders}
      referenceOf={(f) => libraryFolderRef(f, folders)}
      mime={ASSET_MOVE_MIME}
      folderMime={ASSET_FOLDER_MIME}
      creating={folderCreating}
      onCreatingChange={setFolderCreating}
      statOf={(id) => {
        const f = folderOf(id);
        return {
          count:
            entries.filter((e) => e.folderId === id).length +
            childrenOf(folders, id).length +
            (f ? noteList.filter((n) => n.libraryLocation?.folderId === id && n.libraryLocation.residency === f.residency).length : 0),
        };
      }}
      badgeOf={(id) => {
        const r = folderOf(id)?.residency;
        return dual && r ? <ShelfBadge residency={r} offline={!live(r)} /> : null;
      }}
      picked={selected}
      onPick={(e, id) => pickTile(e, folderSelId(id), order)}
      renaming={renamingFolder}
      onRenamingChange={setRenamingFolder}
      onOpen={(id) => {
        setQuery("");
        gotoFolder(id);
      }}
      onShare={shareFolder}
      onCreate={createFolder}
      onRename={renameFolder}
      onDelete={(id) => {
        const f = shownFolders.find((x) => x.id === id);
        if (!f) {
          return;
        }
        if (selected.has(folderSelId(id)) && pickSize > 1) {
          setDeleting(pick);
          return;
        }
        setDeleting({ ...NO_PICK, folders: [f] });
      }}
      onDropIds={(ids, fid) => void moveItems(ids, fid)}
      onDropFolders={(ids, fid) => void moveFolders(ids, fid)}
      onDropFiles={(files, fid) => void upload(files, fid)}
    />
  );
  const notesView = (layout: FolderLayout) => (
    <NotesView
      ref={noteView}
      layout={layout === "table" ? "rows" : "tiles"}
      query={searching ? query : ""}
      library={{
        folderId: openFolder,
        residency: open?.residency ?? target,
        name: trail.at(-1)?.name ?? t("tabs.assets"),
      }}
    />
  );

  const typeLabel = (x: AssetTypeTab) => t(`assets.types.${x}`);
  const emptyHere = shownEntries.length === 0 && shownPending.length === 0 && shownFolders.length === 0;
  // The list draws its frame once it has a row: a folder (or one being
  // named), a note, or a card on this tab.
  const listRows =
    shownFolders.length > 0 || folderCreating || notesHere > 0 || (!loading && tab !== "notes" && shownEntries.length > 0);

  return (
    <div
      ref={rootRef}
      className={cn("min-h-full", fileOver && "rounded-3xl outline-2 outline-dashed outline-offset-[-10px] outline-[#0a84ff]/60")}
      onContextMenu={onPageContextMenu}
      onDragEnter={(e) => {
        if (!isFileDrag(e)) {
          return;
        }
        e.preventDefault();
        dragDepth.current += 1;
        setFileOver(true);
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) {
          return;
        }
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setFileOver(false);
        }
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) {
          return;
        }
        e.preventDefault();
        dragDepth.current = 0;
        setFileOver(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-9 sm:px-10">
        {/* Title or the way down to the open folder, then the page's two
            actions. */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {openFolder === null ? (
            <h1 className="text-lg font-semibold tracking-tight">{t("tabs.assets")}</h1>
          ) : (
            <FolderCrumb
              root={t("tabs.assets")}
              trail={trail}
              onRename={open && live(open.residency) ? renameFolder : undefined}
              mime={ASSET_MOVE_MIME}
              folderMime={ASSET_FOLDER_MIME}
              onGo={gotoFolder}
              onDrop={(ids, id) => void moveItems(ids, id)}
              onDropFolders={(ids, id) => void moveFolders(ids, id)}
            />
          )}
          <div className="flex items-center gap-2">
            {open && open.store === "library" && (
              <Button variant="outline" disabled={!live(open.residency)} onClick={() => shareFolder(open.id)}>
                <Share2 data-icon="inline-start" /> {t("library.share")}
              </Button>
            )}
            {(openFolder === null || newParent) && (
              <Button variant="outline" onClick={() => setFolderCreating(true)}>
                <FolderPlus data-icon="inline-start" /> {t("assets.newFolder")}
              </Button>
            )}
            <Button onClick={() => setAddOpen(true)}>
              <Upload data-icon="inline-start" /> {t("assets.upload")}
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

        {/* Search, the type tabs, and grid or list. */}
        <div className="mb-5 flex flex-col gap-3">
          <label className="flex h-9 w-full items-center gap-2 rounded-full border border-foreground/20 bg-background px-3.5 text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:border-foreground/25">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={query}
              placeholder={t("assets.search")}
              aria-label={t("assets.search")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label={t("assets.clearSearch")}
                onClick={() => setQuery("")}
                className="-mr-1 grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </label>
          <div className="flex items-center justify-between gap-3">
            <div role="tablist" className="-mx-1 flex min-w-0 gap-1.5 overflow-x-auto px-1 py-1">
              {ASSET_TYPES.map((x) => (
                <button
                  key={x}
                  type="button"
                  role="tab"
                  aria-selected={tab === x}
                  onClick={() => gotoTab(x)}
                  className={cn(
                    "h-8 shrink-0 rounded-full border px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                    tab === x
                      ? "border-foreground bg-foreground text-background"
                      : "border-foreground/20 text-muted-foreground hover:bg-muted hover:text-foreground dark:border-foreground/25",
                  )}
                >
                  {typeLabel(x)}
                </button>
              ))}
            </div>
            {tab !== "notes" && entries.length > 0 && (
              <div className="flex shrink-0 rounded-lg border border-border bg-card p-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("projects.galleryView")}
                  aria-pressed={view === "gallery"}
                  className={cn(view === "gallery" && "bg-muted text-foreground")}
                  onClick={() => switchView("gallery")}
                >
                  <LayoutGrid />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("projects.listView")}
                  aria-pressed={view === "list"}
                  className={cn(view === "list" && "bg-muted text-foreground")}
                  onClick={() => switchView("list")}
                >
                  <List />
                </Button>
              </div>
            )}
          </div>
        </div>

        <GraceBanner enabled={cloudListed} />
        {failure && <p className="mb-4 text-sm text-destructive">{failure}</p>}
        {residencies.map(
          (r) =>
            sections[r].isError &&
            !sections[r].data && (
              <p key={r} className="mb-4 text-sm text-muted-foreground">
                {r === "cloud" ? t("projects.loadFailedCloud") : t("projects.loadFailedLocal")}
              </p>
            ),
        )}

        {view === "list" ? (
          <AssetTable framed={listRows}>
            {folderShelf("table")}
            {notesShown && notesView("table")}
            {!loading && tab !== "notes" && shownEntries.map(renderRow)}
          </AssetTable>
        ) : (
          <>
            {folderShelf("tiles")}
            {notesShown && notesView("tiles")}
          </>
        )}

        {loading ? (
          <div className="grid place-items-center py-24 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : !hasContent ? (
          <button className="grid w-full cursor-pointer place-items-center rounded-2xl py-24" onClick={() => setAddOpen(true)}>
            <div className="flex flex-col items-center gap-3 text-center">
              <FolderOpen className="size-8 text-muted-foreground" />
              <div className="text-base font-medium">{t("assets.emptyTitle")}</div>
              <p className="text-sm text-muted-foreground">{t("assets.emptyHint")}</p>
            </div>
          </button>
        ) : tab === "notes" ? null : emptyHere ? (
          searching && (
            <p className="py-16 text-center text-sm text-muted-foreground">{t("assets.noMatches", { query: query.trim() })}</p>
          )
        ) : view === "list" ? null : (
          <Marquee className="flex min-h-[40vh] flex-wrap content-start items-start gap-5" selected={selected} setSelected={setSelected}>
            {shownPending.map((p) => (
              <LibraryImportCard
                key={p.id}
                item={p}
                area={
                  (p.mediaType === "video" || p.mediaType === "image") && p.shape
                    ? cardArea({ w: p.shape.width, h: p.shape.height })
                    : LIBRARY_AUDIO_TILE_AREA
                }
                onRetry={() => void p.run()}
                onDismiss={() => dismissLibraryImport(p.id)}
                opensOn="click"
              />
            ))}
            {shownEntries.map(renderCard)}
          </Marquee>
        )}

        {actions.dialogs}

        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t("assets.upload")}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <button
                className="flex flex-col items-center gap-2 rounded-xl py-8 transition-colors hover:bg-muted/40"
                onClick={() => inputRef.current?.click()}
              >
                <Upload className="size-6 text-muted-foreground" />
                <span className="text-sm font-medium">{t("library.chooseFiles")}</span>
              </button>
              <div className="flex items-center gap-3 text-[11px] tracking-wide text-muted-foreground uppercase">
                <div className="h-px flex-1 bg-border" /> {t("library.orPasteLink")} <div className="h-px flex-1 bg-border" />
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <LinkIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    value={url}
                    placeholder={t("library.linkPlaceholder")}
                    className="pl-8"
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void importLink(url);
                      }
                    }}
                  />
                </div>
                <Button disabled={!url.trim()} onClick={() => void importLink(url)}>
                  <LinkIcon /> {t("library.import")}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* A pick with nothing live in it opens no menu: its shelf takes no
            changes. Right-click on the page itself offers what can be added. */}
        <SelectionMenu
          menu={ctx.menu?.ids.length === 0 || ctxSet.folders.length + ctxSet.entries.length > 0 ? ctx.menu : null}
          onClose={ctx.close}
        >
          {ctx.menu?.ids.length === 0 ? (
            <>
              {(openFolder === null || newParent) && (
                <DropdownMenuItem onClick={() => setFolderCreating(true)}>
                  <FolderPlus /> {t("assets.newFolder")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => noteView.current?.create()}>
                <StickyNote /> {t("library.addNote")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAddOpen(true)}>
                <Upload /> {t("assets.upload")}
              </DropdownMenuItem>
            </>
          ) : ctxFolder ? (
            <FolderMenuItems
              onShare={ctxFolder.store === "library" ? () => shareFolder(ctxFolder.id) : undefined}
              onRename={() => setRenamingFolder(ctxFolder.id)}
              onDelete={() => setDeleting({ ...NO_PICK, folders: [ctxFolder] })}
            />
          ) : ctxOne?.kind === "project" ? (
            <ProjectMenuItems {...projectMenu(ctxOne)} />
          ) : ctxProjects.length === ctxSet.entries.length && ctxSet.folders.length === 0 && ctxProjects.length > 0 ? (
            <ProjectMenuItems moveTo={ctxMoveTo} onDelete={() => setDeleting(ctxSet)} />
          ) : ctxSet.folders.length + ctxSet.entries.length > 0 ? (
            <>
              {ctxOne?.kind === "media" && (
                <DropdownMenuItem onClick={() => setSharing({ kind: "asset", id: ctxOne.id, residency: ctxOne.residency })}>
                  <Share2 /> {t("library.share")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(ctxSet)}>
                <Trash2 /> {t("library.delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </SelectionMenu>

        <DeleteConfirm
          open={!!deleting}
          title={
            deleting
              ? t("library.deleteTitle", {
                  what: pickLabel(
                    deleting.folders,
                    deleting.entries,
                    deleting.entries.every((e) => e.kind === "project") && deleting.entries.length > 0 ? "project" : "item",
                    deletingHeld,
                  ),
                })
              : ""
          }
          description={deleteNote}
          action={t("library.delete")}
          busy={busy}
          onClose={() => setDeleting(null)}
          onConfirm={() => deleting && void remove(deleting)}
        />

        {sharing && library.data && (
          <LibraryShareDialog
            key={`${sharing.kind}:${sharing.id}`}
            target={sharing}
            library={library.data}
            onClose={() => setSharing(null)}
            onCopied={(x) => gotoFolder(x.kind === "folder" ? x.id : null)}
          />
        )}
        <Lightbox />
        <TabStatus />
      </div>
    </div>
  );
}
