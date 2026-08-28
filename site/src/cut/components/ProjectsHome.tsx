"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Cloud,
  Copy,
  Film,
  FolderPlus,
  Laptop,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiveElapsed } from "@/cut/components/Elapsed";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { capturePosterWhenReady, readPoster } from "@/cut/lib/posterCache";
import { quotaErrorMessage } from "@/cut/lib/backend/cloud";
import {
  useCloudUsage,
  useCutMode,
  useListedResidencies,
  useLocalCompute,
} from "@/cut/lib/backend/hooks";
import { dropCachedDoc, seedNewProjectDoc } from "@/cut/lib/docCache";
import { lastChosenAspect } from "@/cut/lib/store";
import {
  backendFor,
  patchProjects,
  refetchProjects,
  useProjectsSection,
  type ProjectsSection,
  type Residency,
} from "@/cut/lib/queries";
import { useInView } from "@/cut/hooks/useInView";
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { NewProjectButton } from "@/cut/components/NewProjectButton";
import { track } from "@/lib/analytics";
import { useStartCheckout } from "@/queries/billing";
import { clearProjectThreads } from "@/cut/lib/chatThreads";
import { useGenerate } from "@/cut/lib/generate";
import { useGenScene } from "@/cut/lib/genScene";
import { createProjectFromFile, isMediaFile } from "@/cut/lib/media";
import { dropLocalProjectCopy, localMediaUrl } from "@/cut/lib/mediaSync";
import { copyProjectAcross } from "@/cut/lib/projectCopy";
import { homeHref, projectHref, useCutBase } from "@/cut/lib/nav";
import { daysUntil, formatDate, formatTime } from "@/cut/lib/time";
import {
  parseRatio,
  shapeBand,
  type ProjectFolder,
  type ProjectSummary,
} from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { setObjectDragImage } from "@/cut/lib/assetDrag";
import { FolderCrumb, FolderShelf, formatBytes, Marquee } from "./desktopFolders";

type View = "gallery" | "list";

// The home lists every residency the user has, talking to the backend objects
// directly — the global mode is only bound when a project opens into the
// editor. Each section's listing is cached (lib/queries.ts), so returning here
// paints the shelf immediately and revalidates behind it.
//
// That cache is also what keeps the Mac's shelf on screen with the Donkey app
// closed: local projects still exist, so they still list, and the card says
// where each one lives. What they don't do is change — a shelf whose engine
// isn't answering takes no renames, moves, or deletes, so the cards carry no
// menu and every mutation checks first. Opening one is allowed, and lands on
// the editor's "this project is on this Mac" screen with the gate's banner
// above it.

type SectionData = {
  projects: ProjectSummary[] | null;
  folders: ProjectFolder[];
  error: boolean;
};

// A dragged selection is carried as a JSON array of project ids, so one drag can
// move a whole marquee-selected collection into a folder.
const PROJECT_MIME = "application/x-cut-project";

// The badge marks where one project lives, so it says that outright rather
// than repeating the shelf heading it sits under. A local project the Donkey
// app isn't answering for says that instead: it is the reason its card can't
// be renamed or moved.
const RESIDENCY_HINT: Record<Residency, string> = {
  local: "This is a local project",
  cloud: "This is a cloud project",
  browser: "This is a local project",
};
const OFFLINE_HINT = "This is a local project — open the Donkey app to edit it";

function ResidencyBadge({
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
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span />} className={className}>
          <Icon className="size-3" />
        </TooltipTrigger>
        <TooltipContent>{offline ? OFFLINE_HINT : RESIDENCY_HINT[residency]}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** After a Pro plan ends, an over-cap account has a countdown before the daily
 * sweep reclaims its oldest projects. Say so where the projects are. */
function GraceBanner({ enabled }: { enabled: boolean }) {
  // A deletion deadline moves once a day; one read per visit is plenty.
  const usage = useCloudUsage(enabled, { poll: false });
  const checkout = useStartCheckout();
  const base = useCutBase();
  const grace = usage.data?.grace;
  const shown = useRef(false);
  useEffect(() => {
    if (grace && !shown.current) {
      shown.current = true;
      track("cut_grace_banner_shown");
    }
  }, [grace]);
  if (!grace) return null;
  const days = daysUntil(grace.deadline);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="text-destructive">
        Your Pro plan ended and you&rsquo;re over the free storage limit. Your oldest cloud projects
        will be deleted {days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`} unless you
        upgrade or free {formatBytes(grace.overBytes)}.
      </span>
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0"
        disabled={checkout.isPending}
        onClick={async () => {
          track("pro_checkout_started");
          try {
            const { url } = await checkout.mutateAsync();
            window.location.assign(url);
          } catch {
            window.location.assign(`${base}/settings`);
          }
        }}
      >
        Upgrade to Pro
      </Button>
    </div>
  );
}

export function ProjectsHome() {
  const router = useRouter();
  const base = useCutBase();
  const mode = useCutMode();
  // The home never runs in shared mode; anything else lists as local.
  const homeMode: Residency =
    mode === "cloud" ? "cloud" : mode === "browser" ? "browser" : "local";
  // What this home shows and what a new project can be made on are two
  // questions now. The Mac's shelf lists whenever this browser has used it,
  // reachable or not; creating on it needs the Donkey app answering.
  const residencies = useListedResidencies();
  const { target } = useNewProjectTarget();
  const dual = residencies.length > 1;
  const r0 = residencies[0];
  // Whether a shelf takes writes right now. The cloud always does; the Mac's
  // does while its engine answers.
  const engineUp = useLocalCompute();
  const live = useCallback((r: Residency) => r !== "local" || engineUp, [engineUp]);
  // A project moves between the two places the user thinks in: Local and
  // Cloud. The two local kinds are the same place, so a local-kind project
  // only offers the Cloud, and a cloud project offers one local kind — the
  // Mac engine when it is up, this browser's storage otherwise.
  const moveDests = useCallback(
    (from: Residency): Residency[] => {
      if (from !== "cloud") return residencies.includes("cloud") ? ["cloud"] : [];
      const local = residencies.filter((d) => d !== "cloud" && live(d));
      if (local.includes("local")) return ["local"];
      return local;
    },
    [residencies, live]
  );

  const client = useQueryClient();
  // Hooks can't run in a loop, so both sections are always wired and the
  // inactive one simply stays disabled.
  const localSection = useProjectsSection("local", {
    list: residencies.includes("local"),
    live: engineUp,
  });
  const cloudSection = useProjectsSection("cloud", {
    list: residencies.includes("cloud"),
    live: true,
  });
  const browserSection = useProjectsSection("browser", {
    list: residencies.includes("browser"),
    live: residencies.includes("browser"),
  });
  const asSection = (q: typeof localSection): SectionData => ({
    projects: q.data?.projects ?? null,
    folders: q.data?.folders ?? [],
    // A cached listing on screen outranks a failed revalidation: the cards
    // stay, and only a section with nothing to show says it couldn't load.
    error: q.isError && q.data === undefined,
  });
  const data: Record<Residency, SectionData> = {
    local: asSection(localSection),
    cloud: asSection(cloudSection),
    browser: asSection(browserSection),
  };

  // Optimistic edits to a section's cached listing; the next revalidation
  // reconciles whatever the server actually did.
  const patch = useCallback(
    (r: Residency, fn: (s: ProjectsSection) => ProjectsSection) => patchProjects(client, r, fn),
    [client]
  );
  const refresh = useCallback((r: Residency) => refetchProjects(client, r), [client]);

  // The open folder lives in the URL (?folder=…) so project URLs can point
  // back into it and the browser's back button steps folder → root.
  const openFolder = useSearchParams().get("folder");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>("gallery");
  // The residency the pending creation was launched for; null when the naming
  // dialog is closed.
  const [createIn, setCreateIn] = useState<Residency | null>(null);
  const [folderCreating, setFolderCreating] = useState<Residency | null>(null);
  const [renaming, setRenaming] = useState<{ project: ProjectSummary; residency: Residency } | null>(
    null
  );
  const [deleting, setDeleting] = useState<{ project: ProjectSummary; residency: Residency } | null>(
    null
  );
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // One line of feedback when a cross-residency duplicate fails.
  const [dupError, setDupError] = useState<string | null>(null);
  // A count of desktop files still uploading into fresh projects, plus whether an
  // OS-file drag is hovering the surface (a depth counter tames enter/leave noise
  // as the cursor crosses child tiles).
  const [importing, setImporting] = useState(0);
  const [fileOver, setFileOver] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    const saved = localStorage.getItem("cut-projects-view");
    if (saved === "list" || saved === "gallery") setView(saved);
  }, []);

  const switchView = (v: View) => {
    setView(v);
    localStorage.setItem("cut-projects-view", v);
  };

  // Each mutation below opens with the same guard: a shelf that isn't
  // answering takes no changes, and an optimistic patch would paint a rename
  // that never happened and then take it back on reconnect.
  const createFolder = async (r: Residency, fname: string) => {
    if (!live(r)) return;
    const res = await backendFor(r).fetch("/api/cut/projects/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: fname }),
    });
    if (res.ok) {
      const f = (await res.json()) as ProjectFolder;
      patch(r, (s) => ({ ...s, folders: [...s.folders, f] }));
      track("folder_created");
    }
  };

  const renameFolder = async (r: Residency, id: string, fname: string) => {
    if (!live(r)) return;
    patch(r, (s) => ({
      ...s,
      folders: s.folders.map((f) => (f.id === id ? { ...f, name: fname } : f)),
    }));
    await backendFor(r)
      .fetch(`/api/cut/projects/folders/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fname }),
      })
      .catch(() => void refresh(r));
  };

  // Open a folder (or the root, id null) by navigating, so the location is
  // shareable and back-button friendly.
  const gotoFolder = (id: string | null) => {
    setSelected(new Set());
    router.push(homeHref(base, "projects", id));
  };

  const deleteFolder = async (r: Residency, id: string) => {
    if (!live(r)) return;
    patch(r, (s) => ({
      folders: s.folders.filter((f) => f.id !== id),
      projects: s.projects.map((p) => (p.folderId === id ? { ...p, folderId: null } : p)),
    }));
    if (openFolder === id) router.replace(homeHref(base, "projects"));
    await backendFor(r)
      .fetch(`/api/cut/projects/folders/${id}`, { method: "DELETE" })
      .catch(() => void refresh(r));
  };

  // Move a collection of projects into a folder (or out to the root, folderId
  // null). Optimistic; reconciles from disk on any failure. A dragged
  // selection can span sections, so a backend only ever moves its own.
  const moveProjects = async (r: Residency, ids: string[], folderId: string | null) => {
    if (!live(r)) return;
    const own = new Set((data[r].projects ?? []).map((p) => p.id));
    const move = ids.filter((id) => own.has(id));
    if (move.length === 0) return;
    const idset = new Set(move);
    patch(r, (s) => ({
      ...s,
      projects: s.projects.map((p) => (idset.has(p.id) ? { ...p, folderId } : p)),
    }));
    setSelected(new Set());
    await Promise.all(
      move.map((id) =>
        backendFor(r).fetch(`/api/cut/projects/${id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderId }),
        })
      )
    ).catch(() => void refresh(r));
  };

  // Creating a project is the one moment where the whole answer is already
  // known: the server hands back the summary, and the document it just wrote
  // is empty. Seed both — the card is in the grid before the navigation, and
  // the editor opens on its first frame instead of waiting out a round trip
  // for a document we can describe in full.
  const openNewProject = async (r: Residency, pname: string, folderId: string | null) => {
    if (!live(r)) return;
    // The frame the editor would open this project at is written into the doc
    // at creation, so the card shows that shape before the editor's first save.
    const aspect = lastChosenAspect() ?? undefined;
    const res = await backendFor(r).fetch("/api/cut/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: pname, folderId, aspect }),
    });
    const project = (await res.json()) as ProjectSummary;
    patch(r, (s) => ({ ...s, projects: [project, ...s.projects] }));
    seedNewProjectDoc(project.id, project.name, r, aspect);
    track("project_created", { source: "projects_home" });
    router.push(projectHref(base, project.id, "projects", folderId));
  };

  const create = async (r: Residency) => {
    setBusy(true);
    try {
      await openNewProject(r, name.trim() || "Untitled", openFolder);
    } finally {
      setBusy(false);
    }
  };

  // Make a new project in the folder that's open (root when none), then jump
  // straight into it — no naming step.
  const newProjectHere = (r: Residency, folderId: string | null = openFolder) =>
    openNewProject(r, "Untitled", folderId);

  // Turn a batch of desktop files into projects filed under `folderId`. Each
  // becomes its own project and pops into the grid the moment it's ready.
  // File imports run on the globally bound backend, so they land in `mode`'s
  // section.
  const importFilesAsProjects = useCallback(
    async (files: FileList | File[], folderId: string | null) => {
      const media = Array.from(files).filter(isMediaFile);
      if (media.length === 0) return;
      setImporting((n) => n + media.length);
      for (const file of media) {
        try {
          await createProjectFromFile(file, folderId);
          track("project_created", { source: "file_import" });
        } catch {
          // A file the engine can't ingest is skipped; the rest still land.
        } finally {
          setImporting((n) => n - 1);
        }
        await refresh(homeMode);
      }
    },
    [refresh, homeMode]
  );

  const rename = async () => {
    if (!renaming) return;
    const { project, residency } = renaming;
    if (!live(residency)) return setRenaming(null);
    const next = name.trim() || project.name;
    patch(residency, (s) => ({
      ...s,
      projects: s.projects.map((p) => (p.id === project.id ? { ...p, name: next } : p)),
    }));
    setRenaming(null);
    await backendFor(residency)
      .fetch(`/api/cut/projects/${project.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      })
      .catch(() => void refresh(residency));
  };

  const duplicate = async (r: Residency, p: ProjectSummary) => {
    if (!live(r)) return;
    setBusy(true);
    setDupError(null);
    try {
      const res = await backendFor(r).fetch(`/api/cut/projects/${p.id}/duplicate`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => null)) as
        | { jobId?: string; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(
          quotaErrorMessage(res.status, body) ?? body?.error ?? "Could not duplicate the project."
        );
      }
      // Cloud duplicates queue (copies drain one at a time); poll until this
      // one lands. The engine answers with the finished summary instead.
      if (body?.jobId) {
        for (;;) {
          await new Promise((done) => setTimeout(done, 2000));
          const st = await backendFor(r).fetch(`/api/cut/copy-jobs/${body.jobId}`);
          if (!st.ok) throw new Error("Could not duplicate the project.");
          const job = (await st.json()) as { state: string; error?: string };
          if (job.state === "done") break;
          if (job.state === "error") {
            throw new Error(job.error || "Could not duplicate the project.");
          }
        }
      }
      await refresh(r);
    } catch (e) {
      setDupError(
        e instanceof Error && e.message ? e.message : "Could not duplicate the project."
      );
    } finally {
      setBusy(false);
    }
  };

  // Move a project to another residency: copy it across (projectCopy.ts does
  // the doc + media transfer and cleans up a half-made copy itself), then drop
  // the original. The copy landing first is what makes deleting it safe.
  const moveAcross = async (source: Residency, dest: Residency, p: ProjectSummary) => {
    if (!live(source) || !live(dest)) return;
    setDupError(null);
    setBusy(true);
    try {
      await copyProjectAcross(backendFor(source), backendFor(dest), p.id);
      await backendFor(source)
        .fetch(`/api/cut/projects/${p.id}`, { method: "DELETE" })
        .catch(() => {});
      // The chat history moved with the project; the old project's copy goes
      // with the project itself, as does a cloud project's browser-store copy.
      clearProjectThreads(p.id);
      if (source === "cloud") void dropLocalProjectCopy(p.id);
      await Promise.all([refresh(source), refresh(dest)]);
    } catch (e) {
      setDupError(e instanceof Error && e.message ? e.message : "Could not move the project.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    const { project, residency } = deleting;
    if (!live(residency)) return setDeleting(null);
    setBusy(true);
    const id = project.id;
    try {
      await backendFor(residency).fetch(`/api/cut/projects/${id}`, { method: "DELETE" });
      // The doc, media, and exports go with the folder on the server. Purge the
      // client-side residue keyed to this project so nothing survives it: a live
      // scene run, its in-flight renders, its chat history (whose ids the
      // render-resume guard reads to keep a deleted thread's render from
      // landing), and the cached copy of its document.
      useGenScene.getState().killProject(id);
      useGenerate.getState().cancelForOwner({ projectId: id });
      clearProjectThreads(id);
      dropCachedDoc(id, residency);
      if (residency === "cloud") void dropLocalProjectCopy(id);
      patch(residency, (s) => ({ ...s, projects: s.projects.filter((p) => p.id !== id) }));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  // Which section owns the open folder — in dual mode only that section shows.
  const folderOwner: Residency | null = openFolder
    ? (residencies.find((r) => data[r].folders.some((f) => f.id === openFolder)) ?? null)
    : null;
  const openFolderName = folderOwner
    ? data[folderOwner].folders.find((f) => f.id === openFolder)?.name
    : undefined;
  // A folder pins where a new project lands, but only a shelf that answers can
  // take one: inside a folder on an unreachable shelf, New project goes where
  // the picker points instead.
  const pinnedTarget = folderOwner && live(folderOwner) ? folderOwner : null;
  const newTarget = pinnedTarget ?? target;

  const anySettled = residencies.some((r) => data[r].projects !== null || data[r].error);
  const anyProjects = residencies.some((r) => (data[r].projects?.length ?? 0) > 0);
  const hasContent = residencies.some(
    (r) => (data[r].projects?.length ?? 0) > 0 || data[r].folders.length > 0
  );

  // One flat surface: every residency's folders on one shelf and projects in
  // one grid, newest edits first — the per-card badge says where each lives.
  const residencyOfFolder = (id: string): Residency =>
    residencies.find((r) => data[r].folders.some((f) => f.id === id)) ?? homeMode;
  const mergedFolders = residencies.flatMap((r) => data[r].folders);
  const mergedShown = residencies
    .flatMap((r) =>
      (data[r].projects ?? [])
        .filter((p) => (p.folderId ?? null) === openFolder)
        .map((p) => ({ p, r }))
    )
    .sort((a, b) => (b.p.updatedAt ?? 0) - (a.p.updatedAt ?? 0));

  // Begin a project drag. Dragging a member of the current selection carries the
  // whole selection; dragging anything else drags (and selects) just that item.
  const onProjectDragStart = (e: React.DragEvent, p: ProjectSummary) => {
    const ids = selected.has(p.id) && selected.size > 0 ? Array.from(selected) : [p.id];
    if (!selected.has(p.id)) setSelected(new Set([p.id]));
    e.dataTransfer.setData(PROJECT_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
    setObjectDragImage(e, ids.length, ids, () => setSelected(new Set()));
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Only OS-file drags are drop targets here; internal project drags carry
  // PROJECT_MIME and are handled by the folder tiles and breadcrumb instead.
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const renderShelf = () => (
    <FolderShelf
      folders={mergedFolders}
      mime={PROJECT_MIME}
      creating={folderCreating !== null}
      onCreatingChange={(c) => setFolderCreating(c ? (folderCreating ?? target) : null)}
      statOf={(id) => {
        const items = (data[residencyOfFolder(id)].projects ?? []).filter(
          (p) => (p.folderId ?? null) === id
        );
        return { count: items.length, size: items.reduce((n, p) => n + (p.sizeBytes ?? 0), 0) };
      }}
      onOpen={gotoFolder}
      onCreate={(n) => void createFolder(folderCreating ?? target, n)}
      onRename={(id, n) => void renameFolder(residencyOfFolder(id), id, n)}
      onDelete={(id) => void deleteFolder(residencyOfFolder(id), id)}
      onDropIds={(ids, fid) => void moveProjects(residencyOfFolder(fid), ids, fid)}
      // File imports run on the globally bound backend, so only its folders
      // can receive the files themselves; drops on another residency's folder
      // land at the root, like drops on the page surface.
      onDropFiles={(files, fid) =>
        void importFilesAsProjects(files, residencyOfFolder(fid) === mode ? fid : null)
      }
    />
  );

  // Similar-shape tiles get their own band of wrapped rows, so a wide tile
  // never shares a row with a tall one. Bands are ordered by their most
  // recently edited project, recency kept within each band.
  const bandsByShape = (shown: { p: ProjectSummary; r: Residency }[]) => {
    const bands = new Map<number, typeof shown>();
    for (const it of shown) {
      const frame = parseRatio(it.p.aspect) ?? { w: 9, h: 16 };
      const key = shapeBand(frame.w, frame.h);
      const band = bands.get(key) ?? [];
      if (band.length === 0) bands.set(key, band);
      band.push(it);
    }
    return [...bands.entries()];
  };

  // Every tile takes the same area — a wide project spreads, a tall one
  // stands, and each carries equal weight on the page.
  const TILE_AREA = 180 * 320;

  const renderTile = ({ p, r }: { p: ProjectSummary; r: Residency }) => {
    // Docs without an aspect are 9:16.
    const frame = parseRatio(p.aspect) ?? { w: 9, h: 16 };
    const tileW = Math.round(Math.sqrt((TILE_AREA * frame.w) / frame.h));
    return (
        <div
          key={p.id}
          data-sel-id={p.id}
          className="group max-w-full cursor-pointer"
          draggable={live(r)}
          onDragStart={(e) => onProjectDragStart(e, p)}
          onClick={(e) => {
            if (e.shiftKey || e.metaKey) {
              e.preventDefault();
              toggleSelect(p.id);
              return;
            }
            router.push(projectHref(base, p.id, "projects", openFolder));
          }}
        >
          <div
            className={cn(
              "relative grid place-items-center overflow-hidden rounded-2xl border bg-muted transition-shadow group-hover:shadow-[0_6px_28px_rgba(0,0,0,0.12)]",
              selected.has(p.id) ? "border-[#0a84ff] ring-2 ring-[#0a84ff]" : "border-border"
            )}
            style={{ width: tileW, aspectRatio: `${frame.w} / ${frame.h}` }}
          >
            <CardPreview project={p} residency={r} offline={!live(r)} />
            <span className="absolute top-2 left-2 max-w-[70%] truncate rounded-lg bg-black/55 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
              {p.name}
            </span>
            {dual && (
              <ResidencyBadge
                residency={r}
                offline={!live(r)}
                className="absolute bottom-2 left-2 z-10 grid size-5 place-items-center rounded-md bg-black/65 text-white"
              />
            )}
            <span className="absolute right-2 bottom-2 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums">
              {formatTime(p.duration)}
            </span>
            {live(r) && (
              <ProjectMenu
                className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                onRename={() => {
                  setName(p.name);
                  setRenaming({ project: p, residency: r });
                }}
                onDuplicate={() => void duplicate(r, p)}
                moveTo={moveDests(r)
                  .map((d) => ({ target: d, run: () => void moveAcross(r, d, p) }))}
                onDelete={() => setDeleting({ project: p, residency: r })}
              />
            )}
          </div>
          <div className="mt-2 px-0.5 text-xs text-muted-foreground">
            {formatBytes(p.sizeBytes ?? 0)} · edited {formatDate(p.updatedAt)}
          </div>
        </div>
    );
  };

  const renderGallery = (shown: { p: ProjectSummary; r: Residency }[]) => (
    <Marquee
      className="flex min-h-[42vh] flex-col content-start gap-8"
      selected={selected}
      setSelected={setSelected}
    >
      {bandsByShape(shown).map(([shape, band]) => (
        <div key={shape} className="flex flex-wrap items-start gap-5">
          {band.map(renderTile)}
        </div>
      ))}
    </Marquee>
  );

  const renderList = (shown: { p: ProjectSummary; r: Residency }[]) => (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid grid-cols-[1fr_90px_70px_110px_40px] items-center gap-3 border-b border-border bg-muted/50 px-4 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <span>Name</span>
        <span>Length</span>
        <span>Size</span>
        <span>Edited</span>
        <span />
      </div>
      {shown.map(({ p, r }) => (
        <div
          key={p.id}
          data-sel-id={p.id}
          className={cn(
            "group grid cursor-pointer grid-cols-[1fr_90px_70px_110px_40px] items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0 hover:bg-muted/50",
            selected.has(p.id) && "bg-[#0a84ff]/10 hover:bg-[#0a84ff]/15"
          )}
          draggable={live(r)}
          onDragStart={(e) => onProjectDragStart(e, p)}
          onClick={(e) => {
            if (e.shiftKey || e.metaKey) {
              e.preventDefault();
              toggleSelect(p.id);
              return;
            }
            router.push(projectHref(base, p.id, "projects", openFolder));
          }}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <Film className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{p.name}</span>
            {dual && (
              <ResidencyBadge
                residency={r}
                offline={!live(r)}
                className="shrink-0 text-muted-foreground"
              />
            )}
          </span>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatTime(p.duration)}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatBytes(p.sizeBytes ?? 0)}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatDate(p.updatedAt)}
          </span>
          {live(r) ? (
            <ProjectMenu
              onRename={() => {
                setName(p.name);
                setRenaming({ project: p, residency: r });
              }}
              onDuplicate={() => void duplicate(r, p)}
              moveTo={moveDests(r)
                .map((d) => ({ target: d, run: () => void moveAcross(r, d, p) }))}
              onDelete={() => setDeleting({ project: p, residency: r })}
            />
          ) : (
            <span />
          )}
        </div>
      ))}
      <button
        type="button"
        data-no-marquee
        onClick={() => void newProjectHere(newTarget)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <Plus className="size-4" /> New project
      </button>
    </div>
  );

  const soleData = data[r0];
  const showHeader = dual ? anySettled : soleData.projects !== null && hasContent;

  // Whole-surface file drops import on the globally bound backend; a folder
  // another backend owns can't receive them, so those land at the root.
  const surfaceDropFolder =
    dual && openFolder && !data[homeMode].folders.some((f) => f.id === openFolder)
      ? null
      : openFolder;

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
        void importFilesAsProjects(e.dataTransfer.files, surfaceDropFolder);
      }}
    >
    <div className="relative mx-auto w-full max-w-6xl px-10 py-9">
      {importing > 0 && (
        <div className="pointer-events-none fixed right-6 bottom-6 z-50 flex items-center gap-2 rounded-full bg-foreground/90 px-3.5 py-2.5 text-background shadow-lg">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-xs font-medium">
            Importing… <LiveElapsed className="tabular-nums" />
          </span>
        </div>
      )}
      {showHeader && (
        <div className="mb-5 flex items-center justify-between">
          {openFolder === null ? (
            <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
          ) : (
            <FolderCrumb
              root="Projects"
              name={openFolderName ?? "Folder"}
              mime={PROJECT_MIME}
              onBack={() => gotoFolder(null)}
              onDropOut={(ids) => void moveProjects(folderOwner ?? r0, ids, null)}
            />
          )}
          <div className="flex items-center gap-2">
            {/* A folder lands where a project would: New project owns that
                choice for the whole page, so this asks nothing of its own. */}
            {openFolder === null && (
              <Button variant="outline" onClick={() => setFolderCreating(target)}>
                <FolderPlus data-icon="inline-start" /> New folder
              </Button>
            )}
            <NewProjectButton
              pinned={pinnedTarget}
              onCreate={(r) => void newProjectHere(r)}
            />
            {anyProjects && (
              <div className="flex rounded-lg border border-border bg-card p-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Gallery view"
                  aria-pressed={view === "gallery"}
                  className={cn(view === "gallery" && "bg-muted text-foreground")}
                  onClick={() => switchView("gallery")}
                >
                  <LayoutGrid />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="List view"
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
      )}

      <GraceBanner enabled={residencies.includes("cloud")} />

      {dupError && <p className="mb-4 text-sm text-destructive">{dupError}</p>}

      {!anySettled ? (
        <div className="grid place-items-center py-24 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : !hasContent && residencies.every((r) => data[r].error) ? (
        <p className="py-24 text-center text-sm text-muted-foreground">
          Couldn&rsquo;t load these projects.
        </p>
      ) : !hasContent ? (
        <div className="grid min-h-[60vh] place-items-center">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="grid size-14 place-items-center rounded-2xl bg-muted">
              <Film className="size-7 text-muted-foreground" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight">
              Create a new project to get started
            </h1>
            <NewProjectButton
              pinned={pinnedTarget}
              onCreate={(r) => {
                setName("");
                setCreateIn(r);
              }}
            />
          </div>
        </div>
      ) : (
        <>
          {residencies.map(
            (r) =>
              data[r].error && (
                <p key={r} className="mb-4 text-sm text-muted-foreground">
                  Couldn&rsquo;t load {r === "cloud" ? "cloud projects" : "the projects on this Mac"}.
                </p>
              )
          )}
          {openFolder === null &&
            (mergedFolders.length > 0 || folderCreating !== null) &&
            renderShelf()}
          {view === "gallery" ? renderGallery(mergedShown) : renderList(mergedShown)}
        </>
      )}

      <Dialog open={createIn !== null} onOpenChange={(o) => !o && setCreateIn(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (createIn) void create(createIn);
            }}
          >
            <Input
              autoFocus
              placeholder="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={busy} className="w-full">
                {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
                Create project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={busy} className="w-full">
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.project.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the whole project folder, including its media files
              and exports. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </div>
  );
}

/** Card art: the actual edit (a rendered proxy) plays on hover; the poster is
 * the first clip's real first frame. Falls back to the source when no proxy
 * has been rendered yet.
 *
 * The source is withheld until the tile has been scrolled near, because each
 * card is a real media element: a grid of cloud projects would otherwise open
 * a connection per card on arrival and pull every file's metadata across the
 * network before the first row settled. A shelf that isn't answering has no
 * media to reach at all, so those cards stop at the frame they cached. */
function CardPreview({
  project: p,
  residency,
  offline = false,
}: {
  project: ProjectSummary;
  residency: Residency;
  offline?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [tileRef, seen] = useInView<HTMLDivElement>();
  // The frame this card drew last time, so coming back from a project shows the
  // picture at once instead of a grey rectangle while the media loads.
  const poster = useCardPoster(p.id, residency, videoRef, seen);
  // Whether the media itself has a frame up yet. Until it does the cached one
  // is what the tile shows — as its own layer, because the element's `poster`
  // attribute is read when the media starts loading and the cached frame comes
  // out of IndexedDB a moment after that.
  const [decoded, setDecoded] = useState(false);
  const backend = backendFor(residency);
  // A browser-resident card's media lives in the OPFS store, and blob URLs
  // are session-scoped: a fresh tab holds none until this mints one. Until it
  // resolves the card shows its cached poster, like an offline shelf.
  const [storeUrl, setStoreUrl] = useState<string | null>(null);
  const previewFile = p.previewFile;
  useEffect(() => {
    if (residency !== "browser" || !previewFile) return;
    let alive = true;
    void localMediaUrl(p.id, previewFile).then((u) => {
      if (alive && u) setStoreUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [residency, p.id, previewFile]);
  const fileUrl = (file: string) =>
    residency === "browser"
      ? (storeUrl ?? "")
      : backend.url(`/api/cut/projects/${p.id}/media/${encodeURIComponent(file)}`);

  if (offline) {
    return poster ? (
      // eslint-disable-next-line @next/next/no-img-element -- a cached data URL, not a Next asset
      <img
        src={poster}
        alt=""
        draggable={false}
        className="absolute inset-0 size-full object-cover"
      />
    ) : (
      <Film className="size-7 text-muted-foreground/50" />
    );
  }

  if (!p.previewFile && !p.hasPreview) {
    return (
      <Film className="size-7 text-muted-foreground/50 transition-transform group-hover:scale-110" />
    );
  }

  if (residency === "browser" && !storeUrl) {
    return poster ? (
      // eslint-disable-next-line @next/next/no-img-element -- a cached data URL, not a Next asset
      <img
        src={poster}
        alt=""
        draggable={false}
        className="absolute inset-0 size-full object-cover"
      />
    ) : (
      <Film className="size-7 text-muted-foreground/50" />
    );
  }

  // The proxy starts at the edit's first frame; the source starts at the clip's
  // trim-in, so both posters show what actually plays first.
  const posterT = p.hasPreview ? 0 : p.previewStart ?? 0.1;

  // A still-image project with no rendered proxy posters as the image itself.
  if (!p.hasPreview && p.previewIsImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- engine media file, not Next-optimizable
      <img
        crossOrigin={MEDIA_CORS}
        src={fileUrl(p.previewFile!)}
        alt=""
        loading="lazy"
        className="absolute inset-0 size-full object-cover"
      />
    );
  }

  const src = p.hasPreview
    ? backend.url(`/api/cut/projects/${p.id}/preview`)
    : fileUrl(p.previewFile!);

  return (
    <div
      ref={tileRef}
      className="absolute inset-0"
      onMouseEnter={() => void videoRef.current?.play().catch(() => {})}
      onMouseLeave={() => {
        const v = videoRef.current;
        if (v) {
          v.pause();
          v.currentTime = posterT;
        }
      }}
    >
      {seen && (
        <video
          crossOrigin={MEDIA_CORS}
          ref={videoRef}
          src={`${src}#t=${posterT}`}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedData={() => setDecoded(true)}
          className="size-full object-cover"
        />
      )}
      {poster && !decoded && (
        // eslint-disable-next-line @next/next/no-img-element -- a cached data URL, not a Next asset
        <img
          src={poster}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </div>
  );
}

/** The cached opening frame for a project card, once it has been read off this
 * machine, and the standing job of keeping it fresh. Null until the read lands,
 * and for a project this browser has never drawn. */
function useCardPoster(
  projectId: string,
  residency: Residency,
  videoRef: RefObject<HTMLVideoElement | null>,
  seen: boolean
): string | null {
  const [poster, setPoster] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void readPoster("card", projectId, residency).then((data) => {
      if (alive) setPoster(data);
    });
    return () => {
      alive = false;
    };
  }, [projectId, residency]);
  useEffect(() => {
    if (!seen) return;
    return capturePosterWhenReady("card", projectId, () => videoRef.current, residency);
  }, [projectId, residency, seen, videoRef]);
  return poster;
}

const MOVE_DEST: Record<Residency, { Icon: typeof Cloud; label: string }> = {
  local: { Icon: Laptop, label: "Move to Local" },
  cloud: { Icon: Cloud, label: "Move to Cloud" },
  browser: { Icon: Laptop, label: "Move to Local" },
};

function ProjectMenu({
  className,
  onRename,
  onDuplicate,
  moveTo,
  onDelete,
}: {
  className?: string;
  onRename: () => void;
  onDuplicate: () => void;
  /** The other live residencies this project can move to. */
  moveTo?: { target: Residency; run: () => void }[];
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Project actions"
            className={cn("bg-black/40 text-white hover:bg-black/60 hover:text-white", className)}
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={onRename}>
          <Pencil /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDuplicate}>
          <Copy /> Duplicate
        </DropdownMenuItem>
        {moveTo?.map(({ target, run }) => {
          const { Icon, label } = MOVE_DEST[target];
          return (
            <DropdownMenuItem key={target} onClick={run}>
              <Icon /> {label}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
