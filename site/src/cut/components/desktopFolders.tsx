"use client";

import { Fragment, useEffect, useRef, useState } from "react";
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
import type { AssetRef } from "@/cut/lib/assetRef";
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

export function formatBytes(n: number): string {
  if (n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
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

/** A drag ghost mirroring the collection under the cursor: one card, or a small
 * stack labelled with the count. Lives off-screen just long enough for the
 * browser to snapshot it as the drag image. */
export function buildDragGhost(count: number, label: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;top:-1000px;left:-1000px;pointer-events:none;";
  if (count > 1) {
    const back = document.createElement("div");
    back.style.cssText =
      "position:absolute;inset:0;transform:translate(7px,7px);border-radius:11px;background:rgba(30,30,38,0.55);";
    el.appendChild(back);
  }
  const card = document.createElement("div");
  card.textContent = label;
  card.style.cssText =
    "position:relative;padding:7px 13px;border-radius:11px;background:rgba(18,18,24,0.94);color:#fff;" +
    "font:600 12px/1.2 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;max-width:220px;overflow:hidden;" +
    "text-overflow:ellipsis;box-shadow:0 8px 24px rgba(0,0,0,0.4);";
  el.appendChild(card);
  return el;
}

/** Folder tile glyph: the Lucide folder, filled blue. */
export function FolderGlyph({ className }: { className?: string }) {
  return <Folder className={cn("fill-[#8cc5ff] text-[#8cc5ff]", className)} aria-hidden="true" />;
}

// Elements a press should not turn into a rubber-band: the cards themselves
// (they drag), folder tiles / breadcrumbs, and any interactive control.
const MARQUEE_SKIP =
  "[data-sel-id],[data-no-marquee],button,a,input,textarea,select,[role='button'],[role='menuitem'],[contenteditable='true']";

/** Rubber-band selection like a desktop: press-drag on empty space to sweep a
 * rectangle, and every tile (marked `data-sel-id`) it touches is selected. Armed
 * off the whole `<main>` arena — so it starts anywhere in the content area, not
 * just over the grid — while the left sidebar is left alone. ⇧/⌘ keeps the prior
 * selection; a plain click on empty space clears it. */
export function Marquee({
  className,
  selected,
  setSelected,
  children,
}: {
  className?: string;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null
  );

  useEffect(() => {
    const arena = ref.current?.closest("main") ?? ref.current?.parentElement;
    if (!arena) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(MARQUEE_SKIP)) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const additive = e.shiftKey || e.metaKey;
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
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        if (!moved && !additive) setSelected(new Set());
        setRect(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    };
    arena.addEventListener("pointerdown", onPointerDown);
    return () => arena.removeEventListener("pointerdown", onPointerDown);
  }, [setSelected]);

  return (
    <div ref={ref} className="relative min-h-[68vh] flex-1">
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

/** Root breadcrumb shown while a folder is open. The root label is itself a drop
 * target, so a selection can be dragged back out to the top level. */
export function FolderCrumb({
  root,
  name,
  mime,
  onBack,
  onDropOut,
  className,
}: {
  root: string;
  name: string;
  mime: string;
  onBack: () => void;
  onDropOut: (ids: string[]) => void;
  className?: string;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cn("flex items-center gap-2 text-lg font-semibold tracking-tight", className)}
      data-no-marquee
    >
      <button
        className={cn(
          "rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground",
          over && "bg-primary/15 text-primary"
        )}
        onClick={onBack}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes(mime)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onDropOut(readDragIds(e, mime));
        }}
      >
        {root}
      </button>
      <span className="text-muted-foreground/50">/</span>
      <span className="truncate">{name}</span>
    </div>
  );
}

/** The desktop-style folder shelf at the root: each folder as a blue folder
 * icon and a drop target for dragged items. Folder creation is driven by the
 * host (e.g. a header button) through `creating`/`onCreatingChange`. */
export function FolderShelf<F extends DeskFolder>({
  folders,
  statOf,
  badgeOf,
  mime,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onDropIds,
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
  onOpen: (id: string) => void;
  onCreate?: (name: string) => void | Promise<void>;
  onRename: (id: string, name: string) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onDropIds: (ids: string[], folderId: string) => void;
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
  // A folder tile accepts both an internal selection (its MIME) and, when the
  // host wires it up, OS files dragged from the desktop.
  const dragTypes = (e: React.DragEvent) => Array.from(e.dataTransfer.types);
  const accepts = (e: React.DragEvent) =>
    dragTypes(e).includes(mime) || (!!onDropFiles && dragTypes(e).includes("Files"));
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
                  if (!accepts(e)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = dragTypes(e).includes(mime) ? "move" : "copy";
                  setOver(f.id);
                },
                onDragLeave: () => setOver((o: string | null) => (o === f.id ? null : o)),
                onDrop: (e: React.DragEvent) => {
                  if (!accepts(e)) return;
                  e.preventDefault();
                  setOver(null);
                  // Files land in this folder; stop the drop bubbling to the page's
                  // catch-all so it isn't also imported at the current level.
                  if (onDropFiles && dragTypes(e).includes("Files") && e.dataTransfer.files.length) {
                    e.stopPropagation();
                    onDropFiles(e.dataTransfer.files, f.id);
                    return;
                  }
                  onDropIds(readDragIds(e, mime), f.id);
                },
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
            <div className={cn("grid place-items-center transition-transform", isOver && "scale-105")}>
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
