"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Plus } from "lucide-react";
import { PeakStrip } from "@/cut/components/AudioPanel";
import { clearRefDrag, refFromStockMusic, setRefDragData } from "@/cut/lib/assetRef";
import { setCardDragImage } from "@/cut/lib/assetDrag";
import { importStockMusic } from "@/cut/lib/media";
import { useMusicGen } from "@/cut/lib/musicGen";
import { usePreviewAudio } from "@/cut/lib/previewAudio";
import { STOCK_MUSIC_CATEGORIES, stockTitle, type StockMusic, type StockMusicCategory } from "@/cut/lib/stock";
import { STOCK_MUSIC } from "@/cut/lib/stockMusicManifest";
import { useEditor } from "@/cut/lib/store";
import { formatTime } from "@/cut/lib/time";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

/** The category header already names the genre, so drop the id's leading
 * category segment: "cinematic-rising-strings" → "Rising Strings". */
const sampleName = (id: string) => stockTitle(id.split("-").slice(1).join("-") || id);

/** Load a sample into the generator to remix — its prompt and vocals mode. */
const remix = (s: StockMusic) =>
  useMusicGen.getState().load({ prompt: s.prompt, instrumental: s.category !== "Songs" });

/** The bundled music sample library — the right column of the Music tab, beside
 * the generator (like the stock browser on the Image/Video tabs). Category chips
 * filter; samples are grouped into per-genre sections of playable cards. Each
 * card previews in the shared player, "+" imports it onto the soundtrack, click
 * loads its prompt into the generator, and it drags onto the timeline or the
 * prompt box. */
export function SampleLibrary({ projectId }: { projectId: string }) {
  // Its own handle on the app-wide preview player, so a sample and a generated
  // row never play at once; leaving the tab silences this column's preview.
  const playingUrl = usePreviewAudio((s) => s.url);
  const ownedUrl = useRef<string | null>(null);
  const togglePlay = (url: string) => {
    ownedUrl.current = url;
    usePreviewAudio.getState().toggle(url);
  };
  useEffect(
    () => () => {
      if (ownedUrl.current) usePreviewAudio.getState().stop(ownedUrl.current);
    },
    []
  );

  const [cat, setCat] = useState<StockMusicCategory | "all">("all");
  const sections = (cat === "all" ? STOCK_MUSIC_CATEGORIES : [cat])
    .map((c) => ({ category: c, items: STOCK_MUSIC.filter((s) => s.category === c) }))
    .filter((s) => s.items.length > 0);

  return (
    <>
      {/* Chips sit at the same top inset as the left column's Voice/Music tabs.
          The right inset keeps the first row clear of the side panel's floating
          close button. */}
      <div className="shrink-0 pt-4 pr-12 pb-3 pl-3.5">
        <div className="flex flex-wrap gap-1.5">
          <Chip active={cat === "all"} onClick={() => setCat("all")}>
            All
          </Chip>
          {STOCK_MUSIC_CATEGORIES.map((c) => (
            <Chip key={c} active={cat === c} onClick={() => setCat(c)}>
              {c}
            </Chip>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" contentClassName="flex flex-col gap-4 px-3.5 pb-4">
        {sections.map(({ category, items }) => (
          <div key={category} className="flex flex-col gap-2">
            <div className="text-[13px] font-semibold tracking-tight">{category}</div>
            <div className="grid grid-cols-2 gap-2">
              {items.map((s) => (
                <SampleCard
                  key={s.id}
                  sample={s}
                  name={sampleName(s.id)}
                  playing={playingUrl === s.file}
                  onTogglePlay={() => togglePlay(s.file)}
                  onAdd={() =>
                    void importStockMusic(projectId, {
                      url: s.file,
                      name: sampleName(s.id),
                      duration: s.duration,
                    })
                      .then((a) => useEditor.getState().addAssetAtPlayhead(a.id))
                      .catch(() => {})
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </ScrollArea>
    </>
  );
}

/** One sample: a soft card with a gray waveform, a play circle top-left, a
 * duration pill bottom-right, a hover "+" to add, and the name beneath. Click
 * loads its prompt into the generator; drag it onto the timeline (lands on the
 * soundtrack) or onto the prompt box (loads the prompt to remix). */
function SampleCard({
  sample,
  name,
  playing,
  onTogglePlay,
  onAdd,
}: {
  sample: StockMusic;
  name: string;
  playing: boolean;
  onTogglePlay: () => void;
  onAdd: () => void;
}) {
  return (
    <div
      className="group flex cursor-grab flex-col overflow-hidden rounded-xl border border-border bg-muted/40"
      draggable
      onDragStart={(e) => {
        setRefDragData(e, refFromStockMusic(sample));
        setCardDragImage(e, e.currentTarget);
      }}
      onDragEnd={clearRefDrag}
      onClick={() => remix(sample)}
      title="Click to load its prompt · drag onto the timeline or the prompt box"
    >
      <div className="relative h-14">
        <PeakStrip
          peaks={sample.peaks}
          className="absolute inset-x-2.5 top-1/2 mt-0 h-6 -translate-y-1/2 text-muted-foreground/50"
        />
        <button
          type="button"
          title={playing ? "Pause" : "Play"}
          aria-label={playing ? "Pause" : "Play"}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePlay();
          }}
          className="absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-background text-foreground shadow-sm ring-1 ring-border transition-transform hover:scale-105"
        >
          {playing ? <Pause className="size-3" /> : <Play className="size-3 translate-x-px" />}
        </button>
        <span className="absolute right-1.5 bottom-1.5 rounded-md border border-border bg-background px-1 py-0.5 font-mono text-[9px] text-foreground tabular-nums">
          {formatTime(sample.duration)}
        </span>
        <button
          type="button"
          title="Add at the playhead"
          aria-label="Add at the playhead"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-foreground text-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:brightness-110"
        >
          <Plus className="size-3" />
        </button>
      </div>
      <div className="border-t border-border px-2.5 py-1.5">
        <span className="block truncate text-[11.5px] font-medium" title={name}>
          {name}
        </span>
      </div>
    </div>
  );
}

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
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-transparent bg-foreground text-background"
          : "border-input text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
