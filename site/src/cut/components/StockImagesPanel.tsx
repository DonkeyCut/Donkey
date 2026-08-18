"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Search } from "lucide-react";
import { clearRefDrag, refFromStock, setRefDragData } from "@/cut/lib/assetRef";
import { setObjectDragImage } from "@/cut/lib/assetDrag";
import { useLightbox } from "@/cut/lib/lightbox";
import { useRevealEffect, useRevealFlash } from "@/cut/lib/refReveal";
import { useImageGen } from "@/cut/lib/imageGen";
import { aspectRatio, STOCK_CATEGORIES, type StockCategory, type StockImage } from "@/cut/lib/stock";
import { STOCK_IMAGES } from "@/cut/lib/stockManifest";
import { cn } from "@/lib/utils";
import { CopyRefButton, RefHandlePill } from "./AssetRefs";
import { ScrollArea } from "@/components/ui/scroll-area";

/** A readable title from a stock id, e.g. "business-boardroom" → "Business Boardroom". */
const titleFromId = (id: string) =>
  id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// The Image tab's reference browser: a searchable catalog of AI-generated stock
// images. Every image carries the prompt that made it — clicking one loads that
// prompt into the generate panel beside it to edit and render on the user's
// account. Images the user generates show up in that panel, not here.

type View = "all" | StockCategory;

/** Categories shown as chips; the rest sit behind the "…" menu. */
const chip = (active: boolean) =>
  cn(
    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
    active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"
  );

export function StockImagesPanel() {
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");

  // A revealed stock image may sit behind a category view — open its category
  // so the tile is on screen to flash.
  useRevealEffect((ref) => {
    if (ref.scope !== "stock") return;
    const item = STOCK_IMAGES.find((i) => i.id === ref.id);
    if (!item) return;
    setView(item.category);
    setQuery("");
  });

  const q = query.trim().toLowerCase();
  const matches = (item: StockImage) =>
    !q ||
    item.prompt.toLowerCase().includes(q) ||
    item.category.toLowerCase().includes(q) ||
    item.tags.some((t) => t.includes(q));

  const stock = STOCK_IMAGES.filter(matches);

  return (
    <>
      <div className="flex h-12 shrink-0 items-center pr-2.5 pl-2.5">
        <span className="flex min-w-0 items-center gap-1 text-sm font-semibold tracking-tight">
          {view !== "all" && (
            <button
              title="All stock images"
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
              onClick={() => setView("all")}
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          <span className={cn("truncate", view === "all" && "pl-1.5")}>
            {view === "all" ? "Stock Images" : view}
          </span>
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1" contentClassName="flex flex-col gap-3 px-3.5 pb-4">
        <label className="flex shrink-0 items-center gap-2 rounded-lg border border-input px-2.5 py-1.5 focus-within:border-ring">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <div className="flex shrink-0 flex-wrap gap-1">
          <button className={chip(view === "all")} onClick={() => setView("all")}>
            All
          </button>
          {STOCK_CATEGORIES.map((c) => (
            <button key={c} className={chip(view === c)} onClick={() => setView(c)}>
              {c}
            </button>
          ))}
        </div>

        {view === "all" ? (
          <>
            {STOCK_CATEGORIES.map((c) => {
              const items = stock.filter((i) => i.category === c);
              if (items.length === 0) return null;
              return (
                <section key={c} className="shrink-0">
                  <SectionHead title={c} onViewAll={items.length > 6 ? () => setView(c) : undefined} />
                  <div className="grid grid-cols-2 gap-1.5">
                    {items.slice(0, 6).map((i) => (
                      <StockTile key={i.id} item={i} />
                    ))}
                  </div>
                </section>
              );
            })}
            {stock.length === 0 && <Empty />}
          </>
        ) : (
          (() => {
            const items = stock.filter((i) => i.category === view);
            return items.length > 0 ? (
              <div className="grid grid-cols-2 gap-1.5">
                {items.map((i) => (
                  <StockTile key={i.id} item={i} />
                ))}
              </div>
            ) : (
              <Empty />
            );
          })()
        )}
      </ScrollArea>
    </>
  );
}

function SectionHead({ title, onViewAll }: { title: string; onViewAll?: () => void }) {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <span className="text-[12px] font-semibold">{title}</span>
      {onViewAll && (
        <button
          className="flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={onViewAll}
        >
          View all
          <ChevronRight className="size-3" />
        </button>
      )}
    </div>
  );
}

/** A stock thumbnail; clicking loads its saved prompt into the generate panel,
 * and it drags as an asset ref (chat attachment, generation reference). */
function StockTile({ item }: { item: StockImage }) {
  const { flash, attachReveal } = useRevealFlash("stock", item.id);
  return (
    <div
      ref={attachReveal}
      className={cn(
        "group relative overflow-hidden rounded-lg",
        flash && "ring-2 ring-[#0a84ff] ring-offset-1"
      )}
    >
      <button
        className="block w-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        draggable
        onDragStart={(e) => {
          setRefDragData(e, refFromStock(item));
          setObjectDragImage(e);
        }}
        onDragEnd={clearRefDrag}
        onClick={() => useImageGen.getState().openWith(item.prompt)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- bundled static thumbs on a client-only page */}
        <img
          src={item.thumb}
          alt={item.prompt}
          loading="lazy"
          className="aspect-[16/10] w-full bg-muted object-cover transition-transform group-hover:scale-[1.04]"
        />
      </button>
      <RefHandlePill
        token={`@${item.id}`}
        className="absolute bottom-1 left-1 opacity-0 transition-opacity group-hover:opacity-100"
      />
      <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          title="Expand"
          className="grid size-5 place-items-center rounded-full bg-black/45 text-white hover:bg-black/65"
          onClick={() =>
            useLightbox.getState().open({
              kind: "image",
              src: item.file,
              ratio: aspectRatio(item.aspect),
              name: titleFromId(item.id),
              prompt: item.prompt,
              assetId: null,
            })
          }
        >
          <Maximize2 className="size-3" />
        </button>
        <CopyRefButton name={item.id} />
      </div>
    </div>
  );
}

function Empty() {
  return <p className="text-[11px] text-muted-foreground">No matches.</p>;
}
