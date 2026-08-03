"use client";

import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { Tile } from "@/cut/components/PanelTile";
import { SectionTitle } from "@/cut/components/SectionTitle";
import { clearElementDrag, setElementDragData, type ElementDrag } from "@/cut/lib/assetDrag";
import { PICKED_RING, useAssetPick } from "@/cut/lib/assetPick";
import { useEditor } from "@/cut/lib/store";
import { SHAPE_LABELS, type ShapeKind } from "@/cut/lib/types";
import { useLocalPref } from "@/cut/lib/uiState";
import { cn } from "@/lib/utils";
import { CreateSticker, StickerTile, useProjectStickers } from "./Stickers";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The Elements tab: what you lay over the picture — the project's stickers
 * and the shapes.
 *
 * It browses in two levels. The top level is a shelf: each category shows a
 * row of what's in it and a "View all" into the category's own full grid.
 * The chips jump straight to a category, and the back arrow returns to the
 * shelf. A click picks a tile and nothing else, wherever it is; dragging one
 * onto the timeline is what places it (`assetPick.ts`).
 */

type Category = "stickers" | "shapes";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "stickers", label: "Stickers" },
  { id: "shapes", label: "Shapes" },
];

const SHAPE_KINDS = Object.keys(SHAPE_LABELS) as ShapeKind[];

/** How many of a category the shelf shows before "View all". */
const PEEK = 4;

export function ElementsPanel({ projectId }: { projectId: string }) {
  const readOnly = useEditor((s) => s.readOnly);
  const [view, setView] = useLocalPref<Category | "all">(
    "cut-elements-view",
    "all",
    (v) => v === "all" || CATEGORIES.some((c) => c.id === v)
  );
  const { stickers, handleOf } = useProjectStickers();

  const stickerTiles = (limit?: number) =>
    (limit ? stickers.slice(0, limit) : stickers).map((a) => (
      <StickerTile
        key={a.id}
        asset={a}
        projectId={projectId}
        handle={handleOf(a.id)}
        readOnly={readOnly}
      />
    ));

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 pr-2.5 pl-4">
        {view !== "all" && (
          <button
            type="button"
            title="All elements"
            aria-label="All elements"
            className="-ml-2 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => setView("all")}
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
        <span className="text-sm font-semibold tracking-tight">
          {view === "all" ? "Elements" : CATEGORIES.find((c) => c.id === view)?.label}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1" contentClassName="flex flex-col gap-4 px-3.5 pb-4">
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <Chip active={view === "all"} onClick={() => setView("all")}>
            All
          </Chip>
          {CATEGORIES.map((c) => (
            <Chip key={c.id} active={view === c.id} onClick={() => setView(c.id)}>
              {c.label}
            </Chip>
          ))}
        </div>

        {view === "all" && (
          <>
            <Section title="Stickers" onViewAll={() => setView("stickers")}>
              <div className="grid grid-cols-4 gap-1.5">
                {!readOnly && (
                  <PeekTile title="Create a sticker" onClick={() => setView("stickers")}>
                    <Sparkles className="size-4 text-muted-foreground" />
                  </PeekTile>
                )}
                {stickerTiles(readOnly ? PEEK : PEEK - 1)}
              </div>
            </Section>

            <Section title="Shapes" onViewAll={() => setView("shapes")}>
              <div className="grid grid-cols-4 gap-1.5">
                {SHAPE_KINDS.slice(0, PEEK).map((k) => (
                  <ShapePeek key={k} shape={k} />
                ))}
              </div>
            </Section>
          </>
        )}

        {view === "stickers" && (
          <>
            {!readOnly && <CreateSticker projectId={projectId} />}
            {stickers.length > 0 ? (
              <div className="grid shrink-0 grid-cols-2 gap-1.5">{stickerTiles()}</div>
            ) : (
              <p className="px-2 py-6 text-center text-xs leading-relaxed text-balance text-muted-foreground">
                Stickers you make land here, cut out and ready to place.
              </p>
            )}
          </>
        )}

        {view === "shapes" && (
          <div className="grid shrink-0 grid-cols-3 gap-1.5">
            {SHAPE_KINDS.map((k) => (
              <ShapeTile key={k} shape={k} />
            ))}
          </div>
        )}
      </ScrollArea>
    </>
  );
}

/** A category filter at the top of the panel; picking one opens its grid. */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/** One shelf row: the category's name, a way into it, and its peek. */
function Section({
  title,
  onViewAll,
  children,
}: {
  title: string;
  onViewAll: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="flex shrink-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>{title}</SectionTitle>
        <button
          type="button"
          className="flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={onViewAll}
        >
          View all
          <ChevronRight className="size-3" />
        </button>
      </div>
      {children}
    </section>
  );
}

/** A square on a shelf row — the preview carries the meaning, so the name
 * rides the tooltip and the grid inside the category carries the label. */
function PeekTile({
  title,
  onClick,
  picked,
  drag,
  children,
}: {
  title: string;
  onClick: () => void;
  picked?: boolean;
  /** What this tile places when dragged onto the timeline. */
  drag?: ElementDrag;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={picked}
      draggable={!!drag}
      onDragStart={drag ? (e) => setElementDragData(e, drag) : undefined}
      onDragEnd={drag ? clearElementDrag : undefined}
      className={cn(
        "grid aspect-square w-full place-items-center overflow-hidden rounded-lg border border-border p-1.5 transition-colors hover:bg-muted/60",
        picked && PICKED_RING
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A shape on the shelf row and in the Shapes grid: a click picks it, a drag
 * onto the timeline places it. */
function ShapePeek({ shape }: { shape: ShapeKind }) {
  const { picked, pick } = useAssetPick(`shape:${shape}`);
  return (
    <PeekTile
      title={`Drag ${SHAPE_LABELS[shape]} onto the timeline`}
      picked={picked}
      drag={{ kind: "shape", shape }}
      onClick={pick}
    >
      <ShapeSwatch shape={shape} className="size-6" />
    </PeekTile>
  );
}

function ShapeTile({ shape }: { shape: ShapeKind }) {
  const { picked, pick } = useAssetPick(`shape:${shape}`);
  return (
    <Tile
      selected={picked}
      label={SHAPE_LABELS[shape]}
      title={`Drag ${SHAPE_LABELS[shape]} onto the timeline`}
      className={cn(picked && PICKED_RING)}
      onClick={pick}
      draggable
      onDragStart={(e) => setElementDragData(e, { kind: "shape", shape })}
      onDragEnd={clearElementDrag}
    >
      <ShapeSwatch shape={shape} className="size-7" />
    </Tile>
  );
}

/** A shape's silhouette, drawn the way the painter lays it out. */
function ShapeSwatch({ shape, className }: { shape: ShapeKind; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn("text-foreground", className)}
    >
      {shape === "rect" && <rect x="3" y="6" width="18" height="12" rx="2" />}
      {shape === "ellipse" && <ellipse cx="12" cy="12" rx="9.5" ry="7" />}
      {shape === "line" && <rect x="2" y="11" width="20" height="2" rx="1" />}
      {shape === "arrow" && (
        <>
          <rect x="2" y="11" width="14" height="2" rx="1" />
          <polygon points="22,12 14,7.5 14,16.5" />
        </>
      )}
    </svg>
  );
}
