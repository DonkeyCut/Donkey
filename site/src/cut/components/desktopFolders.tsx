"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { setObjectDragImage } from "@/cut/lib/assetDrag";
import { additiveClick } from "@/cut/lib/hostKeys";
import type { AssetRef } from "@/cut/lib/assetRef";
import { formatBytes } from "@/lib/bytes";
import { RefDropZone } from "./RefDropZone";
import { cn } from "@/lib/utils";

// A desktop-style folder surface shared by the projects home and the library:
// macOS folder tiles, marquee multi-select, drag a selection onto a folder with
// a ghost, and open-to-navigate. Both pages carry a selection as a JSON array of
// ids under their own MIME type, so one drag can move a whole collection.

export interface DeskFolder {
  id: string;
  name: string;
  /** A folder the host derives from the items themselves (the editor's Camera
   * Roll): it opens like any other but can't be renamed, deleted, or dropped
   * into. */
  locked?: boolean;
}

export function readDragIds(e: React.DragEvent, mime: string): string[] {
  const raw = e.dataTransfer.getData(mime);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return raw ? [raw] : [];
  }
}

/** Folder tile glyph: the Lucide folder, filled blue. */
export function FolderGlyph({ className, ...rest }: { className?: string } & Record<string, unknown>) {
  return (
    <Folder className={cn("fill-[#8cc5ff] text-[#8cc5ff]", className)} aria-hidden="true" {...rest} />
  );
}

/**
 * Click selection over a grid of tiles, the desktop's rules: a plain click
 * picks one, ⌘/Ctrl toggles one in or out, ⇧ takes the run from the last pick
 * to this one. Pairs with `Marquee`, which sweeps the same set.
 */
export function useTilePicks(shown?: readonly string[]) {
  const [raw, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  // A pick reaches no further than the eye does. Navigating into a folder or
  // deleting a tile leaves ids in the set that are no longer on screen, and a
  // drag that carried those would file or lay down items nobody can see.
  const picked = useMemo(() => {
    if (!shown) return raw;
    const live = new Set(shown);
    return new Set([...raw].filter((id) => live.has(id)));
  }, [raw, shown]);
  const pick = useCallback((e: React.MouseEvent, id: string, order: string[]) => {
    if (e.metaKey || e.ctrlKey) {
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchor.current = id;
      return;
    }
    if (e.shiftKey && anchor.current) {
      const from = order.indexOf(anchor.current);
      const to = order.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setPicked(new Set(order.slice(lo, hi + 1)));
        return;
      }
    }
    setPicked(new Set([id]));
    anchor.current = id;
  }, []);
  return { picked, setPicked, pick };
}

// Elements a press should not turn into a rubber-band: the cards themselves
// (they drag), folder tiles / breadcrumbs, anything else draggable sharing the
// scroll region (template and export rows), the scrollbar, and any
// interactive control.
const MARQUEE_SKIP =
  "[data-sel-id],[data-no-marquee],[draggable='true'],button,a,input,textarea,select," +
  "[role='button'],[role='menuitem'],[contenteditable='true']," +
  "[data-slot='scroll-area-scrollbar'],[data-slot='scroll-area-thumb']";

/** Rubber-band selection like a desktop: press-drag on empty space to sweep a
 * rectangle, and every tile (marked `data-sel-id`) it touches is selected. Armed
 * off the whole `<main>` arena — so it starts anywhere in the content area, not
 * just over the grid — while the left sidebar is left alone. ⇧/⌘ keeps the prior
 * selection; a plain click on empty space clears it. */
export function Marquee({
  className,
  rootClassName = "relative min-h-[68vh] flex-1",
  scope = "page",
  selected,
  setSelected,
  children,
}: {
  className?: string;
  /** The band's own box. A page grid fills the arena; a panel grid takes the
   * column it is in. */
  rootClassName?: string;
  /** Where a press starts a sweep. "page" arms the whole content arena, so a
   * press anywhere beside the grid begins one; "self" arms the scroll region
   * this box sits in, which is what a side panel wants — the empty space
   * under the grid sweeps, while the preview and the timeline are left
   * alone. */
  scope?: "page" | "self";
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  });
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null
  );

  useEffect(() => {
    const arena =
      scope === "self"
        ? (ref.current?.closest<HTMLElement>("[data-slot='scroll-area-viewport']") ?? ref.current)
        : (ref.current?.closest("main") ?? ref.current?.parentElement);
    if (!arena) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(MARQUEE_SKIP)) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const additive = additiveClick(e);
      const base = new Set(additive ? selectedRef.current : []);
      let moved = false;

      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        moved = true;
        const r = {
          left: Math.min(startX, ev.clientX),
          top: Math.min(startY, ev.clientY),
          width: Math.abs(ev.clientX - startX),
          height: Math.abs(ev.clientY - startY),
        };
        setRect(r);
        const hit = new Set(base);
        ref.current?.querySelectorAll<HTMLElement>("[data-sel-id]").forEach((el) => {
          const b = el.getBoundingClientRect();
          const overlaps =
            b.left < r.left + r.width && b.right > r.left && b.top < r.top + r.height && b.bottom > r.top;
          if (overlaps) hit.add(el.dataset.selId!);
        });
        setSelected(hit);
      };
      const done = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("dragstart", onDrag, true);
        setRect(null);
      };
      const onUp = () => {
        done();
        if (!moved && !additive) setSelected(new Set());
      };
      // A press that turns into a native drag gets no pointerup at all, so the
      // sweep stands down when the drag takes over.
      const onDrag = () => done();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("dragstart", onDrag, true);
    };
    arena.addEventListener("pointerdown", onPointerDown);
    // A plain press anywhere beyond the arena lets the selection go too — the
    // desktop's rule: only a card, a control, or an open menu or dialog (which
    // acts on the pick) holds it.
    const onDocDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
      const t = e.target as HTMLElement;
      if (
        t.closest(MARQUEE_SKIP) ||
        t.closest("[role='menu'],[role='dialog'],[role='alertdialog']")
      )
        return;
      if (selectedRef.current.size) setSelected(new Set());
    };
    document.addEventListener("pointerdown", onDocDown);
    return () => {
      arena.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerdown", onDocDown);
    };
  }, [setSelected, scope]);

  return (
    <div ref={ref} className={rootClassName}>
      <div className={className}>{children}</div>
      {rect && (
        <div
          className="pointer-events-none fixed z-50 rounded-[3px] border-2 border-[#0a84ff]"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      )}
    </div>
  );
}

/** One step of the breadcrumb that can be gone back to: a button, and a drop
 * target for an item selection under `mime` and, when the host nests folders,
 * for folders under `folderMime`. */
function CrumbStep({
  label,
  mime,
  folderMime,
  onGo,
  onDrop,
  onDropFolders,
}: {
  label: string;
  mime: string;
  folderMime?: string;
  onGo: () => void;
  onDrop: (ids: string[]) => void;
  onDropFolders?: (ids: string[]) => void;
}) {
  const [over, setOver] = useState(false);
  const carried = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    if (types.includes(mime)) return "items";
    if (folderMime && onDropFolders && types.includes(folderMime)) return "folders";
    return null;
  };
  return (
    <button
      className={cn(
        "rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground",
        over && "bg-primary/15 text-primary"
      )}
      onClick={onGo}
      onDragOver={(e) => {
        if (!carried(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const kind = carried(e);
        if (!kind) return;
        e.preventDefault();
        setOver(false);
        if (kind === "folders") onDropFolders?.(readDragIds(e, folderMime!));
        else onDrop(readDragIds(e, mime));
      }}
    >
      {label}
    </button>
  );
}

/** The breadcrumb shown while a folder is open: the root, then every folder
 * on the way down to the open one. Each step above the open folder is a
 * button and a drop target, so a selection can be dragged back out to any
 * level. `id` is null for the root. */
export function FolderCrumb({
  root,
  trail,
  mime,
  folderMime,
  onGo,
  onDrop,
  onDropFolders,
  className,
}: {
  root: string;
  /** The folders from the top level down to the open one, the open one last. */
  trail: { id: string; name: string }[];
  mime: string;
  /** Set when folders themselves are dragged; steps then take those drops too. */
  folderMime?: string;
  onGo: (id: string | null) => void;
  onDrop: (ids: string[], id: string | null) => void;
  onDropFolders?: (ids: string[], id: string | null) => void;
  className?: string;
}) {
  const open = trail[trail.length - 1];
  return (
    <div
      className={cn("flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight", className)}
      data-no-marquee
    >
      <CrumbStep
        label={root}
        mime={mime}
        folderMime={folderMime}
        onGo={() => onGo(null)}
        onDrop={(ids) => onDrop(ids, null)}
        onDropFolders={onDropFolders && ((ids) => onDropFolders(ids, null))}
      />
      {trail.slice(0, -1).map((f) => (
        <Fragment key={f.id}>
          <span className="text-muted-foreground/50">/</span>
          <CrumbStep
            label={f.name}
            mime={mime}
            folderMime={folderMime}
            onGo={() => onGo(f.id)}
            onDrop={(ids) => onDrop(ids, f.id)}
            onDropFolders={onDropFolders && ((ids) => onDropFolders(ids, f.id))}
          />
        </Fragment>
      ))}
      {open && (
        <>
          <span className="text-muted-foreground/50">/</span>
          <span className="truncate">{open.name}</span>
        </>
      )}
    </div>
  );
}

/** The desktop-style folder shelf: each folder as a blue folder icon and a
 * drop target for dragged items. Folder creation is driven by the host (e.g.
 * a header button) through `creating`/`onCreatingChange`. A host that nests
 * folders passes `folderMime`; tiles are then draggable, carrying their own
 * id under it, and every other tile takes that drop. */
export function FolderShelf<F extends DeskFolder>({
  folders,
  statOf,
  badgeOf,
  mime,
  folderMime,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onDropIds,
  onDropFolders,
  onDropFiles,
  onRefDrop,
  creating = false,
  onCreatingChange,
  rows = false,
}: {
  folders: F[];
  statOf: (id: string) => { count: number; size?: number };
  /** Small marker beside the item count — where the library says which shelf
   * a folder is on. */
  badgeOf?: (id: string) => React.ReactNode;
  mime: string;
  /** The MIME a dragged folder tile carries its id under. */
  folderMime?: string;
  onOpen: (id: string) => void;
  onCreate?: (name: string) => void | Promise<void>;
  onRename: (id: string, name: string) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onDropIds: (ids: string[], folderId: string) => void;
  /** Folders dropped onto a folder tile — filed inside it. */
  onDropFolders?: (ids: string[], folderId: string) => void;
  /** Desktop files dropped onto a folder tile — dropped straight into it. */
  onDropFiles?: (files: FileList, folderId: string) => void;
  /** When set, folder tiles also take media drops from cards and timeline
   * clips — filter by `ref.scope` and file the media into the folder. */
  onRefDrop?: (ref: AssetRef, folderId: string) => void;
  creating?: boolean;
  onCreatingChange?: (creating: boolean) => void;
  /** Stacked full-width rows — glyph left, then name over an item-count
   * subtext — for narrow panels; default is the desktop tile grid. */
  rows?: boolean;
}) {
  // A folder tile accepts an internal selection (its MIME), another folder
  // tile when the host nests folders, and, when the host wires it up, OS
  // files dragged from the desktop.
  const dragTypes = (e: React.DragEvent) => Array.from(e.dataTransfer.types);
  const nests = !!folderMime && !!onDropFolders;
  // The tile being dragged, so it does not light up as its own target. The
  // payload is drop-only, which is why the id is held here.
  const [dragging, setDragging] = useState<string | null>(null);
  const accepts = (e: React.DragEvent, target: string) =>
    dragTypes(e).includes(mime) ||
    (nests && dragTypes(e).includes(folderMime) && dragging !== target) ||
    (!!onDropFiles && dragTypes(e).includes("Files"));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [over, setOver] = useState<string | null>(null);
  // Every close path clears the draft, so the next create opens with an empty
  // name field.
  const closeCreate = () => {
    setDraft("");
    onCreatingChange?.(false);
  };
  const closeRename = () => {
    setDraft("");
    setEditingId(null);
  };

  const editRowClass = rows
    ? "flex items-center gap-2.5 rounded-lg px-2 py-1.5"
    : "flex w-[92px] flex-col items-start gap-1 px-2 pt-1.5";
  const editGlyphClass = rows ? "size-7 shrink-0" : "size-[40px]";

  return (
    <div
      className={cn(rows ? "mb-4 flex flex-col" : "-ml-2 mb-7 flex flex-wrap gap-2")}
      data-no-marquee
    >
      {folders.map((f) => {
        const s = statOf(f.id);
        const isOver = over === f.id;
        if (editingId === f.id)
          return (
            <div key={f.id} className={editRowClass}>
              <FolderGlyph className={editGlyphClass} />
              <Input
                autoFocus
                value={draft}
                className={cn("h-6 text-[11px]", rows ? "flex-1" : "w-full")}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={closeRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && draft.trim()) {
                    void onRename(f.id, draft.trim());
                    closeRename();
                  } else if (e.key === "Escape") closeRename();
                }}
              />
            </div>
          );
        const interact = {
          onClick: () => onOpen(f.id),
          ...(f.locked
            ? {}
            : {
                onDoubleClick: () => {
                  setDraft(f.name);
                  setEditingId(f.id);
                },
                onDragOver: (e: React.DragEvent) => {
                  if (!accepts(e, f.id)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = dragTypes(e).includes("Files") ? "copy" : "move";
                  setOver(f.id);
                },
                onDragLeave: () => setOver((o: string | null) => (o === f.id ? null : o)),
                onDrop: (e: React.DragEvent) => {
                  if (!accepts(e, f.id)) return;
                  e.preventDefault();
                  setOver(null);
                  // Files land in this folder; stop the drop bubbling to the page's
                  // catch-all so it isn't also imported at the current level.
                  if (onDropFiles && dragTypes(e).includes("Files") && e.dataTransfer.files.length) {
                    e.stopPropagation();
                    onDropFiles(e.dataTransfer.files, f.id);
                    return;
                  }
                  if (nests && dragTypes(e).includes(folderMime)) {
                    onDropFolders(readDragIds(e, folderMime), f.id);
                    return;
                  }
                  onDropIds(readDragIds(e, mime), f.id);
                },
                // The tile itself is what a nesting host drags: its own id,
                // with the glyph as the ghost.
                ...(nests
                  ? {
                      draggable: true,
                      onDragStart: (e: React.DragEvent) => {
                        e.dataTransfer.setData(folderMime, JSON.stringify([f.id]));
                        e.dataTransfer.effectAllowed = "move";
                        setDragging(f.id);
                        setObjectDragImage(e, 1, [f.id]);
                      },
                      onDragEnd: () => setDragging(null),
                    }
                  : {}),
              }),
        };
        const menu = f.locked ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Folder options"
                  className={cn(
                    "size-6 opacity-0 group-hover/f:opacity-100 data-[state=open]:opacity-100",
                    rows
                      ? "shrink-0 text-muted-foreground hover:text-foreground"
                      : "absolute top-1 right-1 bg-black/25 text-white hover:bg-black/40 hover:text-white"
                  )}
                  onClick={(e) => e.stopPropagation()}
                />
              }
            >
              <MoreHorizontal className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem
                onClick={() => {
                  setDraft(f.name);
                  setEditingId(f.id);
                }}
              >
                <Pencil /> Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => void onDelete(f.id)}>
                <Trash2 /> Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
        const tile = rows ? (
          <div
            className={cn(
              "group/f flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60",
              isOver && "bg-primary/10"
            )}
            {...interact}
          >
            <FolderGlyph
              className={cn(
                "size-7 shrink-0 drop-shadow-sm transition-transform",
                isOver && "scale-105 brightness-110"
              )}
              data-drag-object="bare"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{f.name}</div>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
                {s.count} {s.count === 1 ? "item" : "items"}
                {s.size != null ? ` · ${formatBytes(s.size)}` : ""}
                {badgeOf?.(f.id)}
              </div>
            </div>
            {menu}
          </div>
        ) : (
          <div
            className="group/f relative flex w-[92px] cursor-pointer flex-col items-start rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
            {...interact}
          >
            <div
              className={cn("grid place-items-center transition-transform", isOver && "scale-105")}
              data-drag-object="bare"
            >
              <FolderGlyph className={cn("size-[40px] drop-shadow-sm", isOver && "brightness-110")} />
            </div>
            <span className="mt-0.5 line-clamp-2 max-w-full text-xs font-medium leading-tight">
              {f.name}
            </span>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
              {s.count}
              {s.size != null ? ` · ${formatBytes(s.size)}` : ""}
              {badgeOf?.(f.id)}
            </span>
            {menu}
          </div>
        );
        return onRefDrop ? (
          <RefDropZone
            key={f.id}
            onRef={(r) => onRefDrop(r, f.id)}
            activeClassName={cn("bg-primary/10", rows ? "rounded-lg" : "rounded-xl")}
          >
            {tile}
          </RefDropZone>
        ) : (
          <Fragment key={f.id}>{tile}</Fragment>
        );
      })}

      {creating && (
        <div className={editRowClass}>
          <FolderGlyph className={cn(editGlyphClass, "opacity-60")} />
          <Input
            autoFocus
            value={draft}
            placeholder="Name"
            className={cn("h-6 text-[11px]", rows ? "flex-1" : "w-full")}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={closeCreate}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) {
                void onCreate?.(draft.trim());
                closeCreate();
              } else if (e.key === "Escape") closeCreate();
            }}
          />
        </div>
      )}
    </div>
  );
}
