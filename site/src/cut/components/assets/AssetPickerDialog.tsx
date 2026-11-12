"use client";

import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Check, Search, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { refFromLibrary, refFromTemplate, type AssetRef } from "@/cut/lib/assetRef";
import { useListedResidencies, useLocalCompute } from "@/cut/lib/backend/hooks";
import { childrenOf, folderTrail } from "@/cut/lib/folderTree";
import { libraryMediaUrl } from "@/cut/lib/library";
import { importLibraryFiles, useLibraryImports } from "@/cut/lib/libraryIntake";
import { linkedAccept } from "@/cut/lib/linkedLibrary";
import { MEDIA_ACCEPT } from "@/cut/lib/media";
import { ASSET_TYPES, type AssetTypeTab } from "@/cut/lib/nav";
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { noteRef } from "@/cut/lib/noteReference";
import { NOTE_INK, noteColor } from "@/cut/lib/notes";
import { projectDocRef } from "@/cut/lib/projectLink";
import { useLibrary, useNotes, useProjectsSection } from "@/cut/lib/queries";
import type { Residency } from "@/cut/lib/residency";
import { PICKED_RING } from "@/cut/lib/assetPick";
import { formatDate } from "@/cut/lib/time";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/utils";
import { LibraryCard, LIBRARY_AUDIO_TILE_AREA, LIBRARY_SQUARE } from "@/cut/components/LibraryCard";
import { LibraryImportCard } from "@/cut/components/LibraryImportCard";
import { NoteBodyPreview } from "@/cut/components/NoteBodyPreview";
import { TemplateCard } from "@/cut/components/TemplateCard";
import { FolderCrumb, FolderGlyph } from "@/cut/components/desktopFolders";
import { ProjectTile } from "./ProjectCard";
import {
  assetEntries,
  cardArea,
  cardBox,
  entryOnTab,
  mergeFolders,
  nameMatches,
  projectFrame,
  type AssetEntry,
} from "./assetsListing";

// The picker's cards are a size down from the page's, so a window holds
// more of them.
const PICKER_LONG_SIDE = 220;
// Files that are no picture, notes and templates: the page's square, scaled
// the way the pictures are.
const PICKER_SQUARE = Math.round(LIBRARY_SQUARE * (PICKER_LONG_SIDE / 320));
// A crumb in the picker takes no drops.
const NO_DROP_MIME = "application/x-cut-no-drop";

/** A note as the picker lists it: the synced note, sized like a sound tile. */
type PickNote = { id: string; title: string; body: string; colorIndex: number };

/**
 * "Add from Assets": the Assets page in a window, behind the Home prompt's +.
 * The same search, type tabs, folders and cards; every card carries a
 * checkbox, and Add to prompt hands the picks back as the refs the prompt
 * turns into chips, in the order they were picked.
 */
export function AssetPickerDialog({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (refs: AssetRef[]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="h-[min(44rem,100%)] sm:max-w-4xl">
        {/* Mounted only while open, so the listings and media wait for the
            window and every opening starts with nothing picked. */}
        {open && <PickerBody onClose={onClose} onAdd={onAdd} />}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({ onClose, onAdd }: { onClose: () => void; onAdd: (refs: AssetRef[]) => void }) {
  const t = useTranslations("home");
  const locale = useLocale();
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [tab, setTab] = useState<AssetTypeTab>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const searching = query.trim().length > 0;

  // The same listings Assets reads, so the window shows what the page does.
  const residencies = useListedResidencies();
  const engineUp = useLocalCompute();
  const live = (r: Residency) => r !== "local" || engineUp;
  const { target } = useNewProjectTarget();
  const library = useLibrary({ live: true });
  const notes = useNotes();
  const localSection = useProjectsSection("local", { list: residencies.includes("local"), live: engineUp });
  const cloudSection = useProjectsSection("cloud", { list: residencies.includes("cloud"), live: true });
  const browserSection = useProjectsSection("browser", {
    list: residencies.includes("browser"),
    live: residencies.includes("browser"),
  });
  const shelves = useMemo(() => {
    const data = { local: localSection.data, cloud: cloudSection.data, browser: browserSection.data };
    return residencies.map((r) => ({ residency: r, projects: data[r]?.projects ?? [], folders: data[r]?.folders ?? [] }));
  }, [residencies, localSection.data, cloudSection.data, browserSection.data]);
  const listing = useMemo(() => library.data ?? { assets: [], folders: [], templates: [] }, [library.data]);
  const folders = useMemo(() => mergeFolders(listing.folders, shelves), [listing.folders, shelves]);
  const entries = useMemo(() => assetEntries(listing, shelves), [listing, shelves]);
  const pending = useLibraryImports((s) => s.items);
  const trail = folderTrail(folders, folder);
  const open = folders.find((f) => f.id === folder) ?? null;

  // What shows: the open folder's cards, or everything a search finds.
  const shownEntries = entries.filter(
    (e) => entryOnTab(e, tab) && (searching ? nameMatches(e.name, query) : e.folderId === folder),
  );
  const shownFolders = searching ? folders.filter((f) => nameMatches(f.name, query)) : childrenOf(folders, folder);
  const shownNotes: PickNote[] =
    tab === "all" || tab === "notes"
      ? (notes.data?.notes ?? []).filter((n) =>
          searching
            ? nameMatches(`${n.title} ${n.body}`, query)
            : (n.libraryLocation?.folderId ?? null) === folder && !!n.libraryLocation,
        )
      : [];
  const shownPending = searching ? [] : pending.filter((p) => p.folderId === folder);

  // A card toggles in or out of the pick.
  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // The refs, in pick order: each kind through the ref the chat already reads.
  const refOf = (id: string): AssetRef | null => {
    const e = entries.find((x) => x.id === id);
    if (e?.kind === "project") {
      return projectDocRef(e.project);
    }
    if (e?.kind === "media") {
      return refFromLibrary(e.asset);
    }
    if (e?.kind === "template") {
      return refFromTemplate(e.template);
    }
    const n = notes.data?.notes.find((x) => x.id === id);
    return n ? noteRef(n) : null;
  };
  const add = () => {
    onAdd(picked.map(refOf).filter((r): r is AssetRef => r !== null));
    onClose();
  };

  // Upload lands in the folder open here when its shelf takes files, else at
  // the top of the shelf new projects go to.
  const upload = (files: FileList) => {
    const residency = open && live(open.residency) ? open.residency : target;
    const folderId = open && open.residency === residency && open.store === "library" ? open.id : null;
    if (!live(residency)) {
      return;
    }
    void importLibraryFiles(files, { residency, folderId }, client);
  };

  const count =
    picked.length === 0
      ? t("assets.picker.none")
      : t("assets.picker.count", { count: picked.length });

  // One card with its checkbox in the top-right corner.
  const pickable = (id: string, card: React.ReactNode) => {
    const on = picked.includes(id);
    return (
      <div key={id} className="relative">
        {card}
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          aria-label={t("assets.picker.pick")}
          onClick={(e) => {
            e.stopPropagation();
            toggle(id);
          }}
          className={cn(
            "absolute top-2 right-2 z-20 grid size-5 place-items-center rounded-full border-2 shadow-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
            on ? "border-[#0a84ff] bg-[#0a84ff] text-white" : "border-white bg-black/30 text-transparent hover:bg-black/45",
          )}
        >
          <Check className="size-3" strokeWidth={3} />
        </button>
      </div>
    );
  };

  const renderCard = (e: AssetEntry) => {
    const on = picked.includes(e.id);
    if (e.kind === "project") {
      return pickable(
        e.id,
        <ProjectTile
          project={e.project}
          residency={e.residency}
          offline={!live(e.residency)}
          badge={residencies.length > 1 ? "residency" : "none"}
          selected={on}
          box={cardBox(projectFrame(e.project), PICKER_LONG_SIDE)}
          meta={t("projects.cardMeta", {
            size: formatBytes(e.project.sizeBytes ?? 0, locale),
            date: formatDate(e.project.updatedAt, locale, t("justNow")),
          })}
          onClick={() => toggle(e.id)}
        />,
      );
    }
    if (e.kind === "template") {
      return pickable(
        e.id,
        <div onClickCapture={(ev) => { ev.preventDefault(); ev.stopPropagation(); toggle(e.id); }}>
          <TemplateCard
            tile={PICKER_SQUARE}
            template={e.template}
            mediaSrc={(f) => libraryMediaUrl(f, e.template.residency)}
            selectId={e.id}
            selected={on}
          />
        </div>,
      );
    }
    const a = e.asset;
    const picture = (a.type === "video" || a.type === "image") && a.width && a.height;
    return pickable(
      e.id,
      <LibraryCard
        asset={a}
        corner="pick"
        area={picture ? cardArea({ w: a.width!, h: a.height! }, PICKER_LONG_SIDE) : LIBRARY_AUDIO_TILE_AREA * (PICKER_LONG_SIDE / 320) ** 2}
        selected={on}
        offline={!live(a.residency)}
        onClick={(ev) => {
          ev.preventDefault();
          toggle(a.id);
        }}
      />,
    );
  };

  return (
    <>
      <DialogHeader className="flex-row items-center gap-3 pr-10">
        <DialogTitle className="flex-1">{t("assets.picker.title")}</DialogTitle>
        <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
          <Upload data-icon="inline-start" /> {t("assets.upload")}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={`${MEDIA_ACCEPT},${linkedAccept()}`}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) {
              upload(e.target.files);
            }
            e.target.value = "";
          }}
        />
      </DialogHeader>

      {/* Search, then the type tabs, then the way down to the open folder. */}
      <div className="flex shrink-0 flex-col gap-2">
        <label className="flex h-9 items-center gap-2 rounded-full border border-foreground/20 bg-background px-3.5 text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:border-foreground/25">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            placeholder={t("assets.search")}
            aria-label={t("assets.search")}
            onChange={(e) => setQuery(e.target.value)}
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
        <div role="tablist" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 py-1">
          {ASSET_TYPES.map((x) => (
            <button
              key={x}
              type="button"
              role="tab"
              aria-selected={tab === x}
              onClick={() => setTab(x)}
              className={cn(
                "h-8 shrink-0 rounded-full border px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                tab === x
                  ? "border-foreground bg-foreground text-background"
                  : "border-foreground/20 text-muted-foreground hover:bg-muted hover:text-foreground dark:border-foreground/25",
              )}
            >
              {t(`assets.types.${x}`)}
            </button>
          ))}
        </div>
        {folder && !searching && (
          <FolderCrumb className="text-sm" root={t("tabs.assets")} trail={trail} mime={NO_DROP_MIME} onGo={setFolder} onDrop={() => {}} />
        )}
      </div>

      <DialogBody className="flex flex-col gap-4 pt-1">
        {shownFolders.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {shownFolders.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setQuery("");
                  setFolder(f.id);
                }}
                className="flex h-10 max-w-56 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium transition-colors hover:bg-muted"
              >
                <FolderGlyph className="size-4 shrink-0" />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap content-start items-start gap-4">
          {shownPending.map((p) => (
            <LibraryImportCard
              key={p.id}
              item={p}
              area={
                (p.mediaType === "video" || p.mediaType === "image") && p.shape
                  ? cardArea({ w: p.shape.width, h: p.shape.height }, PICKER_LONG_SIDE)
                  : LIBRARY_AUDIO_TILE_AREA * (PICKER_LONG_SIDE / 320) ** 2
              }
              onRetry={() => void p.run()}
              onDismiss={() => {}}
              opensOn="click"
            />
          ))}
          {shownNotes.map((n) =>
            pickable(
              n.id,
              <button
                type="button"
                onClick={() => toggle(n.id)}
                className={cn(
                  "light flex flex-col gap-1.5 overflow-hidden rounded-xl p-3 text-left shadow-sm",
                  picked.includes(n.id) && PICKED_RING,
                )}
                style={{
                  backgroundColor: noteColor(n.colorIndex).background,
                  color: NOTE_INK,
                  width: PICKER_SQUARE,
                  height: PICKER_SQUARE,
                }}
              >
                {n.title && <span className="truncate pr-6 text-[13px] font-semibold">{n.title}</span>}
                <NoteBodyPreview body={n.body} lines={5} className="text-[12px] opacity-80" />
              </button>,
            ),
          )}
          {shownEntries.map(renderCard)}
        </div>
        {shownEntries.length + shownNotes.length + shownFolders.length + shownPending.length === 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {searching ? t("assets.noMatches", { query: query.trim() }) : t("assets.picker.empty")}
          </p>
        )}
      </DialogBody>

      <DialogFooter className="items-center sm:justify-between">
        <span className="text-sm text-muted-foreground">{count}</span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("assets.picker.cancel")}
          </Button>
          <Button disabled={picked.length === 0} onClick={add}>
            {t("assets.picker.add")}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
