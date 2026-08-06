"use client";

import { lineLikeShape, shapePathD } from "@donkeycut/effects-kit";
import { SubTabs } from "@/cut/components/SubTabs";
import { clearElementDrag, setElementDragData, setObjectDragImage } from "@/cut/lib/assetDrag";
import { PICKED_RING, pickGridNav, useAssetPick } from "@/cut/lib/assetPick";
import { useEditor } from "@/cut/lib/store";
import { SHAPE_LABELS, type ShapeKind } from "@/cut/lib/types";
import { SHAPE_KINDS } from "@/cut/components/ElementsPanel.tools";
import { useLocalPref } from "@/cut/lib/uiState";
import { cn } from "@/lib/utils";
import { CreateSticker, StickerTile, useProjectStickers } from "./Stickers";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The Elements tab: what you lay over the picture. A segmented toggle at the
 * top switches between the project's stickers and the shapes, each a grid of
 * tiles. A click picks a tile and nothing else; dragging one onto the
 * timeline is what places it (`assetPick.ts`).
 */

type Category = "stickers" | "shapes";

const CATEGORIES = [
  { id: "stickers", label: "Stickers" },
  { id: "shapes", label: "Shapes" },
] as const;

export function ElementsPanel({ projectId }: { projectId: string }) {
  const readOnly = useEditor((s) => s.readOnly);
  const [view, setView] = useLocalPref<Category>("cut-elements-view", "stickers", (v) =>
    CATEGORIES.some((c) => c.id === v)
  );
  const { stickers, handleOf } = useProjectStickers();

  return (
    <>
      {/* PanelHead's height, so the side panel's floating close button lands
          on the toggle's centerline; the right padding keeps clear of it. */}
      <div className="flex h-12 shrink-0 items-center pr-12 pl-3.5">
        <SubTabs tabs={CATEGORIES} value={view} onChange={setView} />
      </div>

      {/* The top pad is the selected tile's ring and its offset: the grid starts
          at the scroll edge, and a ring drawn outside a tile would be cut off
          there. */}
      <ScrollArea className="min-h-0 flex-1" contentClassName="flex flex-col gap-4 px-3.5 pt-1 pb-4">
        {view === "stickers" && (
          <>
            {!readOnly && <CreateSticker projectId={projectId} />}
            {stickers.length > 0 ? (
              <div className="grid shrink-0 grid-cols-2 gap-1.5" onKeyDown={pickGridNav}>
                {stickers.map((a) => (
                  <StickerTile
                    key={a.id}
                    asset={a}
                    projectId={projectId}
                    handle={handleOf(a.id)}
                    readOnly={readOnly}
                  />
                ))}
              </div>
            ) : (
              <p className="px-2 py-6 text-center text-xs leading-relaxed text-balance text-muted-foreground">
                Stickers you make land here, cut out and ready to place.
              </p>
            )}
          </>
        )}

        {view === "shapes" && (
          <div className="grid shrink-0 grid-cols-2 gap-2" onKeyDown={pickGridNav}>
            {SHAPE_KINDS.map((k) => (
              <ShapeTile key={k} shape={k} />
            ))}
          </div>
        )}
      </ScrollArea>
    </>
  );
}

/** A shape in the Shapes grid — a square swatch sized like the effect tiles
 * with its name under it. A click picks it, a drag onto the timeline places
 * it. */
function ShapeTile({ shape }: { shape: ShapeKind }) {
  const { picked, pick } = useAssetPick(`shape:${shape}`);
  return (
    <button
      type="button"
      data-pick-id={`shape:${shape}`}
      aria-pressed={picked}
      draggable
      onDragStart={(e) => {
        setElementDragData(e, { kind: "shape", shape });
        setObjectDragImage(e);
      }}
      onDragEnd={clearElementDrag}
      onClick={pick}
      className="flex flex-col items-center gap-1.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground"
    >
      <span
        className={cn(
          "flex aspect-video w-full items-center justify-center rounded-lg border border-border",
          picked && PICKED_RING
        )}
      >
        <ShapeSwatch shape={shape} className="size-16" />
      </span>
      <span className="leading-none">{SHAPE_LABELS[shape]}</span>
    </button>
  );
}

/** A shape's silhouette, drawn the way the painter lays it out; lines and
 * arrows sit diagonally, pointing up and to the right. */
function ShapeSwatch({ shape, className }: { shape: ShapeKind; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      data-drag-object
      className={cn("text-foreground/70", className)}
    >
      {shape === "rect" && <rect x="3" y="6" width="18" height="12" rx="2" />}
      {shape === "ellipse" && <ellipse cx="12" cy="12" rx="9.5" ry="7" />}
      {shape === "line" && <rect x="2" y="11" width="20" height="2" rx="1" transform="rotate(-45 12 12)" />}
      {shape === "arrow" && (
        <g transform="rotate(-45 12 12)">
          <rect x="2" y="11" width="14" height="2" rx="1" />
          <polygon points="22,12 14,7.5 14,16.5" />
        </g>
      )}
      {!lineLikeShape(shape) && shape !== "rect" && shape !== "ellipse" && (
        <path d={shapePathD(shape, 18, 18)} transform="translate(3 3)" />
      )}
    </svg>
  );
}
