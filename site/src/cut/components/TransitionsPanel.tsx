"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PHASE_STEP } from "@/cut/components/AnimationTiles";
import { SwatchScene, useSwatchClock } from "@/cut/components/EffectsPanel";
import { SectionTitle } from "@/cut/components/SectionTitle";
import { clearElementDrag, setElementDragData, setObjectDragImage } from "@/cut/lib/assetDrag";
import { peekEdgeFrame, requestEdgeFrame } from "@/cut/lib/media";
import { PICKED_RING, pickGridNav, useAssetPick } from "@/cut/lib/assetPick";
import { getClipSpans, resolveTransitions, useEditor } from "@/cut/lib/store";
import { usePreviewTimeEvery } from "@/cut/lib/playhead";
import {
  TRANSITION_STYLE_GROUPS,
  TRANSITION_STYLE_LABELS,
  type MediaAsset,
  type TimelineTransition,
  type TransitionStyle,
} from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The Transitions tab: how one clip hands over to the next, and how a clip
 * enters and leaves on its own.
 *
 * Drag a tile onto the timeline and it takes the nearest place with a handover
 * to make: a cut between two clips, or a clip's own head or tail, where it
 * arrives from or leaves to nothing. On the timeline it is a bar of its own
 * above the tracks: drag it along the track to move it, drag its edge to
 * retime it. A click here only picks the tile, the same as every other panel.
 *
 * Select a clip carrying a transition — or a bar itself — and the tab follows
 * it: its style is the marked tile, and a click on another tile changes that
 * transition to it. The click never places anything: with nothing transitioned
 * it only picks.
 */
export function TransitionsPanel() {
  // The bar the tab is tuned to: a selected bar directly, or the one playing
  // the selected clip's cut.
  const live = useEditor((s) => {
    if (s.selection?.kind === "transition")
      return s.transitions.find((t) => t.id === s.selection!.id) ?? null;
    if (s.selection?.kind !== "clip") return null;
    const roles = resolveTransitions(s.clips, s.transitions);
    return (
      s.transitions.find((t) =>
        (roles.get(t.id) ?? []).some((r) => r.kind === "cut" && r.clipId === s.selection!.id)
      ) ?? null
    );
  });
  const { a, b } = useCutFrames();
  return (
    <>
      {/* No header row. The top padding clears the side panel's floating
          close button: the first group's title runs beside it on the left,
          and the first tile row starts below it. */}
      <ScrollArea className="min-h-0 flex-1" contentClassName="px-3.5 pt-5 pb-4">
        {/* One key handler over every group, so arrows walk the whole list
            across section boundaries. */}
        <div onKeyDown={pickGridNav}>
          {TRANSITION_STYLE_GROUPS.map((g) => (
            <section key={g.label} className="mb-3 flex flex-col gap-1.5">
              <SectionTitle>{g.label}</SectionTitle>
              <div className="grid grid-cols-2 gap-2">
                {g.ids.map((id) => (
                  <TransitionTile key={id} style={id} live={live} a={a} b={b} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

/** The frame an asset shows at `srcT` seconds into its source: the nearest
 * filmstrip thumb for video, the picture itself for an image. */
function frameAt(asset: MediaAsset, srcT: number): string | null {
  if (asset.thumbs?.length) {
    const step = asset.thumbStep || 1;
    const i = Math.max(0, Math.min(asset.thumbs.length - 1, Math.round(srcT / step)));
    return asset.thumbs[i];
  }
  if (asset.type === "image") return asset.url;
  return null;
}

/** Tile-height capture for the swatch previews: covers a 2× retina portrait
 * tile whichever way the source is oriented. */
const TILE_FRAME_H = 640;

/** One side of the cut: the sharp capture at the exact source time once it
 * lands, the nearest filmstrip thumb (or the image itself) until then. */
function useCutFrame(
  slot: string,
  side: { asset: MediaAsset; srcT: number } | null
): string | null {
  const url = side?.asset.type === "video" ? side.asset.url : null;
  const time = side?.srcT ?? 0;
  const id = url ? `${url}#${time.toFixed(2)}` : "";
  const cached = url ? peekEdgeFrame(url, time, TILE_FRAME_H) : null;
  const [frame, setFrame] = useState<{ id: string; src: string } | null>(null);
  useEffect(() => {
    if (!url || cached) return;
    let live = true;
    void requestEdgeFrame(slot, url, time, TILE_FRAME_H).then((src) => {
      if (live && src) setFrame({ id, src });
    });
    return () => {
      live = false;
    };
  }, [url, time, slot, id, cached]);
  if (!side) return null;
  const sharp = cached ?? (frame?.id === id ? frame.src : null);
  return sharp ?? frameAt(side.asset, time);
}

/** The two frames either side of the cut nearest the playhead — the real
 * footage a transition dropped there would blend. Null sides fall back to the
 * tiles' stand-in scenes. */
function useCutFrames(): { a: string | null; b: string | null } {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  // Re-pick the cut as the playhead crosses half-second marks.
  const tick = usePreviewTimeEvery(2);
  const cut = useMemo(() => {
    const spans = getClipSpans(clips, assets);
    let best: {
      a: { asset: MediaAsset; srcT: number };
      b: { asset: MediaAsset; srcT: number };
    } | null = null;
    let bestDist = Infinity;
    for (let i = 0; i + 1 < spans.length; i++) {
      const out = spans[i];
      const inc = spans[i + 1];
      const dist = Math.abs(tick / 2 - inc.start);
      if (dist >= bestDist) continue;
      bestDist = dist;
      best = {
        a: { asset: out.asset, srcT: out.clip.out },
        b: { asset: inc.asset, srcT: inc.clip.in },
      };
    }
    return best;
  }, [clips, assets, tick]);
  const a = useCutFrame("xtile-a", cut?.a ?? null);
  const b = useCutFrame("xtile-b", cut?.b ?? null);
  return { a, b };
}

/** How a transition tile's loop spends its time: a beat on the first shot,
 * the handover, a beat on the second. */
const X_LOOP = 2.4;
const X_HOLD = 0.5;
const X_RUN = 1.2;

/** Each tile's place across the whole list, group boundaries included. The
 * golden-ratio phase steps against it, so at any moment only a few tiles —
 * scattered through the grid — are mid-handover. */
const TILE_INDEX = new Map(
  TRANSITION_STYLE_GROUPS.flatMap((g) => g.ids).map((id, i) => [id, i] as const)
);

function TransitionTile({
  style,
  live,
  a,
  b,
}: {
  style: TransitionStyle;
  live: TimelineTransition | null;
  a: string | null;
  b: string | null;
}) {
  const { picked, pick } = useAssetPick(`transition:${style}`);
  const ref = useRef<HTMLButtonElement>(null);
  // Hovering a tile starts its handover over from the top, so the pointer
  // never lands mid-blend waiting for the loop to come around.
  const [runEpoch, setRunEpoch] = useState(0);
  // A golden-ratio phase by place in the list staggers the grid's loops. The
  // hover restart plays from the top, so it zeroes this tile's phase too.
  const [phase, setPhase] = useState(() => (((TILE_INDEX.get(style) ?? 0) * PHASE_STEP) % 1) * X_LOOP);
  const restart = () => {
    setPhase(0);
    setRunEpoch((n) => n + 1);
  };
  const playing = useEditor((s) => s.playing);
  const clock = useSwatchClock(true, X_LOOP, runEpoch);
  // At rest during playback the clock holds its still frame; the phase only
  // shifts a running loop.
  const t = playing ? clock : (clock + phase) % X_LOOP;
  // What the selection means for this tile: it wears the ring when it is the
  // live bar's style, and a click swaps that bar onto it.
  const isLive = !!live && live.style === style;
  const marked = live ? isLive : picked;
  useEffect(() => {
    // Selecting a transition brings its tile into view — the list is long
    // enough that its group is often scrolled away.
    if (isLive) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isLive]);
  return (
    <button
      ref={ref}
      type="button"
      data-pick-id={`transition:${style}`}
      aria-pressed={marked}
      draggable
      onDragStart={(e) => {
        setElementDragData(e, { kind: "transition", style });
        setObjectDragImage(e);
      }}
      onDragEnd={clearElementDrag}
      onPointerEnter={restart}
      onFocus={restart}
      onClick={() => {
        if (!live) return pick();
        if (!isLive) useEditor.getState().updateTransition(live.id, { style });
        previewBar(live);
      }}
      // Scroll margin keeps the whole tile — selection ring included — clear
      // of the scroller's edges when scrollIntoView lands it there. The picked
      // ring is the focus indicator; the browser outline stays off.
      className="flex scroll-m-2 flex-col gap-1.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground"
    >
      <TransitionSwatch
        style={style}
        a={a}
        b={b}
        t={t}
        className={cn("w-full rounded-lg border border-border", marked && PICKED_RING)}
      />
      <span className="leading-none">{TRANSITION_STYLE_LABELS[style]}</span>
    </button>
  );
}

/** One full-tile layer of the handover — a shot, transformed or clipped as
 * the style's moment demands. */
function Layer({
  frame,
  variant,
  style,
}: {
  frame: string | null;
  variant: "day" | "dusk";
  style?: React.CSSProperties;
}) {
  return (
    <span className="absolute inset-0 overflow-hidden" style={style}>
      <SwatchScene frame={frame} variant={variant} />
    </span>
  );
}

/** The handover itself, played on the two shots: each style renders its own
 * moment at progress `p` — sliding, wiping, dipping or blending shot A into
 * shot B the way the real render does. */
function TransitionSwatch({
  style,
  a,
  b,
  t,
  className,
}: {
  style: TransitionStyle;
  a: string | null;
  b: string | null;
  t: number;
  className?: string;
}) {
  const p0 = Math.min(1, Math.max(0, (t - X_HOLD) / X_RUN));
  const p = p0 * p0 * (3 - 2 * p0);
  const pc = (n: number) => `${(n * 100).toFixed(1)}%`;
  const A = (s?: React.CSSProperties) => <Layer frame={a} variant="day" style={s} />;
  const B = (s?: React.CSSProperties) => <Layer frame={b} variant="dusk" style={s} />;
  let layers: React.ReactNode;
  switch (style) {
    case "crossfade":
      layers = (
        <>
          {A()}
          {B({ opacity: p })}
        </>
      );
      break;
    case "crosszoom":
      layers = (
        <>
          {A({ transform: `scale(${(1 + 0.4 * p).toFixed(3)})` })}
          {B({ opacity: p, transform: `scale(${(1.4 - 0.4 * p).toFixed(3)})` })}
        </>
      );
      break;
    case "dipblack":
    case "dipwhite":
      layers = (
        <>
          {p < 0.5 ? A() : B()}
          <span
            className="absolute inset-0"
            style={{
              background: style === "dipblack" ? "#000" : "#fff",
              opacity: 1 - Math.abs(2 * p - 1),
            }}
          />
        </>
      );
      break;
    case "blur":
      layers = (
        <>
          {A({ filter: `blur(${(p * 3).toFixed(2)}px)` })}
          {B({ opacity: p, filter: `blur(${((1 - p) * 3).toFixed(2)}px)` })}
        </>
      );
      break;
    case "pushleft":
      layers = (
        <>
          {A({ transform: `translateX(${pc(-p)})` })}
          {B({ transform: `translateX(${pc(1 - p)})` })}
        </>
      );
      break;
    case "pushright":
      layers = (
        <>
          {A({ transform: `translateX(${pc(p)})` })}
          {B({ transform: `translateX(${pc(-(1 - p))})` })}
        </>
      );
      break;
    case "pushup":
      layers = (
        <>
          {A({ transform: `translateY(${pc(-p)})` })}
          {B({ transform: `translateY(${pc(1 - p)})` })}
        </>
      );
      break;
    case "pushdown":
      layers = (
        <>
          {A({ transform: `translateY(${pc(p)})` })}
          {B({ transform: `translateY(${pc(-(1 - p))})` })}
        </>
      );
      break;
    case "wipeleft":
      layers = (
        <>
          {A()}
          {B({ clipPath: `inset(0 0 0 ${pc(1 - p)})` })}
        </>
      );
      break;
    case "wiperight":
      layers = (
        <>
          {A()}
          {B({ clipPath: `inset(0 ${pc(1 - p)} 0 0)` })}
        </>
      );
      break;
    case "wipeup":
      layers = (
        <>
          {A()}
          {B({ clipPath: `inset(${pc(1 - p)} 0 0 0)` })}
        </>
      );
      break;
    case "wipedown":
      layers = (
        <>
          {A()}
          {B({ clipPath: `inset(0 0 ${pc(1 - p)} 0)` })}
        </>
      );
      break;
    case "circleopen":
      layers = (
        <>
          {A()}
          {B({ clipPath: `circle(${(p * 72).toFixed(1)}% at 50% 50%)` })}
        </>
      );
      break;
    case "circleclose":
      layers = (
        <>
          {B()}
          {A({ clipPath: `circle(${((1 - p) * 72).toFixed(1)}% at 50% 50%)` })}
        </>
      );
      break;
    case "splitopen":
      layers = (
        <>
          {A()}
          {B({ clipPath: `inset(0 ${pc((1 - p) / 2)})` })}
        </>
      );
      break;
    case "splitclose":
      layers = (
        <>
          {B()}
          {A({ clipPath: `inset(0 ${pc(p / 2)})` })}
        </>
      );
      break;
  }
  return (
    <span
      data-drag-object
      className={cn("relative block aspect-square overflow-hidden rounded-md bg-black", className)}
    >
      {layers}
    </span>
  );
}

/** How far ahead of a handover the preview starts, and how long it runs past
 * it, so a change plays itself on the real footage. */
const PREVIEW_LEAD = 0.4;
const PREVIEW_TAIL = 0.35;

/** Play a bar's window on the real footage: a beat ahead of it, a beat past. */
function previewBar(t: { start: number; seconds: number }) {
  const s = useEditor.getState();
  s.previewRange(Math.max(0, t.start - PREVIEW_LEAD), t.start + t.seconds + PREVIEW_TAIL);
}

