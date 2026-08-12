"use client";

import { useRef, useState } from "react";
import { ChevronRight, Maximize2, Search } from "lucide-react";
import { clearRefDrag, refFromStockVideo, setRefDragData } from "@/cut/lib/assetRef";
import { setObjectDragImage } from "@/cut/lib/assetDrag";
import { useLightbox } from "@/cut/lib/lightbox";
import { useRevealEffect, useRevealFlash } from "@/cut/lib/refReveal";
import { useVideoGen } from "@/cut/lib/videoGen";
import { STOCK_CATEGORIES, stockTitle, type StockCategory, type StockVideo } from "@/cut/lib/stock";
import { STOCK_VIDEOS } from "@/cut/lib/stockVideoManifest";
import { cn } from "@/lib/utils";
import { CopyRefButton, RefHandlePill } from "./AssetRefs";
import { ScrollArea } from "@/components/ui/scroll-area";

// The Video tab's reference browser: a catalog of AI-generated stock clips.
// Every clip carries the prompt that made it — clicking one loads that
// prompt into the generate panel beside it to edit and render on the user's
// account. Videos the user generates show up in that panel, not here.
//
// Two sections: "Talking Characters" (talking-head clips whose prompt ends in
// an editable spoken line), then the "Stock Videos" footage grid. "View all"
// drills into a section, titled with a breadcrumb; search and the footage
// category chips live only inside a drilled section.

const CHARACTERS = STOCK_VIDEOS.filter((v) => v.category === "Characters");
const FOOTAGE = STOCK_VIDEOS.filter((v) => v.category !== "Characters");

// Only footage categories the catalog actually covers get a chip.
const FOOTAGE_CATEGORIES = STOCK_CATEGORIES.filter((c) =>
  FOOTAGE.some((v) => v.category === c)
);

/** Tiles a section shows at the root before "View all" drills in. */
const SECTION_PREVIEW = 6;

type View = "root" | "characters" | "videos";

const chip = (active: boolean) =>
  cn(
    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
    active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"
  );

export function StockVideosPanel() {
  const [view, setView] = useState<View>("root");
  const [cat, setCat] = useState<"all" | StockCategory>("all");
  const [query, setQuery] = useState("");

  // Search is scoped to a drilled section, so switching views starts it fresh.
  const go = (next: View) => {
    setView(next);
    setQuery("");
  };

  // A revealed stock clip may sit off screen — open the view that has its
  // tile (a drilled section, the matching chip filter).
  useRevealEffect((ref) => {
    if (ref.scope !== "stock") return;
    const item = STOCK_VIDEOS.find((v) => v.id === ref.id);
    if (!item) return;
    if (item.category === "Characters") {
      go(CHARACTERS.indexOf(item) >= SECTION_PREVIEW ? "characters" : "root");
    } else {
      go("videos");
      setCat(item.category);
    }
  });

  const q = query.trim().toLowerCase();
  const matches = (item: StockVideo) =>
    !q ||
    item.prompt.toLowerCase().includes(q) ||
    item.category.toLowerCase().includes(q) ||
    item.tags.some((t) => t.includes(q));

  // The root shows every section unfiltered; the query and category chips
  // apply once drilled in.
  const characters = view === "characters" ? CHARACTERS.filter(matches) : CHARACTERS;
  const footage =
    view === "videos"
      ? FOOTAGE.filter((v) => (cat === "all" || v.category === cat) && matches(v))
      : FOOTAGE;

  const chips = (
    <div className="flex min-w-0 flex-wrap gap-1">
      <button className={chip(cat === "all")} onClick={() => setCat("all")}>
        All
      </button>
      {FOOTAGE_CATEGORIES.map((c) => (
        <button key={c} className={chip(cat === c)} onClick={() => setCat(c)}>
          {c}
        </button>
      ))}
    </div>
  );

  return (
    <ScrollArea className="min-h-0 flex-1" contentClassName="flex flex-col gap-3 px-3.5 pt-3 pb-4">
      {STOCK_VIDEOS.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No stock videos are bundled yet.
        </p>
      ) : view === "root" ? (
        <>
          {characters.length > 0 && (
            <section className="shrink-0">
              <SectionHead
                title="Talking Characters"
                onViewAll={
                  characters.length > SECTION_PREVIEW ? () => go("characters") : undefined
                }
              />
              <Grid items={characters.slice(0, SECTION_PREVIEW)} />
            </section>
          )}
          <section className="mt-3 shrink-0">
            <SectionHead
              title="Stock Videos"
              onViewAll={footage.length > SECTION_PREVIEW ? () => go("videos") : undefined}
            />
            {footage.length > 0 ? (
              <Grid items={footage.slice(0, SECTION_PREVIEW)} />
            ) : (
              characters.length === 0 && <Empty />
            )}
          </section>
        </>
      ) : (
        <>
          <Crumb
            title={view === "characters" ? "Talking Characters" : "Stock Videos"}
            onBack={() => go("root")}
          />
          <label className="flex shrink-0 items-center gap-2 rounded-lg border border-input px-2.5 py-1.5 focus-within:border-ring">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
              placeholder={view === "characters" ? "Search characters…" : "Search videos…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {view === "videos" && chips}
          {(view === "characters" ? characters : footage).length > 0 ? (
            <Grid items={view === "characters" ? characters : footage} />
          ) : (
            <Empty />
          )}
        </>
      )}
    </ScrollArea>
  );
}

/** Drilled-section header: a breadcrumb back to the root plus the title. */
function Crumb({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-1 text-[12px]">
      <button className="text-muted-foreground transition-colors hover:text-foreground" onClick={onBack}>
        All
      </button>
      <ChevronRight className="size-3 text-muted-foreground" />
      <span className="font-semibold">{title}</span>
    </div>
  );
}

function SectionHead({
  title,
  onViewAll,
  className,
}: {
  title: string;
  onViewAll?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("mb-1.5 flex items-center justify-between", className)}>
      <span className="text-[12px] font-semibold">{title}</span>
      {onViewAll && <ViewAllButton onClick={onViewAll} />}
    </div>
  );
}

function ViewAllButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
      onClick={onClick}
    >
      View all
      <ChevronRight className="size-3" />
    </button>
  );
}

function Grid({ items }: { items: StockVideo[] }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {items.map((v) => (
        <StockTile key={v.id} item={v} />
      ))}
    </div>
  );
}

/** A stock clip: hover plays it, clicking loads it into the generate panel
 * (footage as an editable prompt, a character as character mode), and it drags
 * as a video ref (chat attachment, generation start frame, timeline drop). */
function StockTile({ item }: { item: StockVideo }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { flash, attachReveal } = useRevealFlash("stock", item.id);
  return (
    <div
      ref={attachReveal}
      className={cn(
        "group relative overflow-hidden rounded-lg",
        flash && "ring-2 ring-[#0a84ff] ring-offset-1"
      )}
      onMouseEnter={() => {
        const v = videoRef.current;
        if (!v) return;
        // Preview with sound; if the browser blocks unmuted autoplay, fall
        // back to a silent preview.
        v.muted = false;
        void v.play().catch(() => {
          v.muted = true;
          void v.play().catch(() => {});
        });
      }}
      onMouseLeave={() => {
        const v = videoRef.current;
        if (v) {
          v.pause();
          v.currentTime = 0;
          v.muted = true;
        }
      }}
    >
      <button
        className="block w-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        draggable
        onDragStart={(e) => {
          setRefDragData(e, refFromStockVideo(item));
          setObjectDragImage(e);
        }}
        onDragEnd={clearRefDrag}
        onClick={() =>
          item.category === "Characters"
            ? useVideoGen.getState().openCharacter(item)
            : useVideoGen.getState().openWith(item.prompt)
        }
      >
        <video
          ref={videoRef}
          src={item.file}
          poster={item.thumb}
          preload="none"
          muted
          loop
          playsInline
          className="aspect-[16/10] w-full bg-muted object-cover"
        />
      </button>
      {/* Clip lengths are single-digit seconds; "8s" reads better than "0:08". */}
      <span className="pointer-events-none absolute right-1 bottom-1 rounded-[5px] bg-black/65 px-1 py-px font-mono text-[9.5px] text-white tabular-nums">
        {Math.round(item.duration)}s
      </span>
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
              kind: "video",
              src: item.file,
              aspect: item.aspect,
              name: stockTitle(item.id),
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
