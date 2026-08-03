"use client";

import { useEffect, useRef, useState } from "react";
import {
  EFFECT_IDS,
  EFFECT_LABELS,
  effectPreviewState,
  type EffectId,
} from "@donkeycut/effects-kit";
import { PICKED_RING, useAssetPick } from "@/cut/lib/assetPick";
import { clearElementDrag, setElementDragData } from "@/cut/lib/assetDrag";
import { useEditor } from "@/cut/lib/store";
import { isEffectOverlay, type EffectOverlay } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The Effects tab: time-ranged treatments over the finished picture — the
 * footage and everything laid over it. Two families in one list, the
 * treatments (grain, VHS, glitch, blur, vignette, light leak, flash, shake)
 * and the graded looks (vintage, noir, halation…). Drag one onto the timeline
 * to place it; a click only picks the tile, the same as every other panel.
 *
 * Select an effect on the timeline and the tab follows it: its tile is the
 * marked one, and a click on another tile changes that element to it. The
 * click never places anything — with an effect selected it retunes what is
 * already there, and with nothing selected it just picks.
 */
export function EffectsPanel() {
  const live = useEditor((s) => {
    if (s.selection?.kind !== "overlay") return null;
    const o = s.overlays.find((x) => x.id === s.selection!.id);
    return o && isEffectOverlay(o) ? o : null;
  });
  return (
    <>
      <div className="flex h-12 shrink-0 items-center pr-2.5 pl-4">
        <span className="text-sm font-semibold tracking-tight">Effects</span>
      </div>

      {/* The top pad is the selected tile's ring and its offset: the grid
          starts at the scroll edge, and a ring drawn outside the tile would be
          cut off there. */}
      <ScrollArea className="min-h-0 flex-1" contentClassName="px-3.5 pt-1 pb-4">
        <div className="grid grid-cols-2 gap-2">
          {EFFECT_IDS.map((id) => (
            <EffectTile key={id} id={id} live={live} />
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

/** One effect: the preview fills the tile with its name under it, a click
 * picks it (or swaps the selected element to it), and a drag onto the timeline
 * places it. Hovering runs the preview — the flash pulses, the glitch tears,
 * the shake moves. */
function EffectTile({ id, live }: { id: EffectId; live: EffectOverlay | null }) {
  const { picked, pick } = useAssetPick(`effect:${id}`);
  const [hover, setHover] = useState(false);
  const t = useSwatchClock(hover);
  const ref = useRef<HTMLButtonElement>(null);
  // What the selection means for this tile: it wears the ring when it is the
  // selected element's effect, and a click swaps that element onto it.
  const isLive = live?.effect === id;
  const marked = live ? isLive : picked;
  useEffect(() => {
    // Selecting an effect far down the list brings its tile into view.
    if (isLive) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isLive]);
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={marked}
      title={
        live
          ? `Change the selected effect to ${EFFECT_LABELS[id]}`
          : `Drag ${EFFECT_LABELS[id]} onto the timeline`
      }
      draggable
      onDragStart={(e) => setElementDragData(e, { kind: "effect", effect: id })}
      onDragEnd={clearElementDrag}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      onClick={() => {
        if (!live) return pick();
        if (!isLive) useEditor.getState().updateOverlay(live.id, { effect: id });
      }}
      className={cn(
        // Scroll margin keeps the whole tile — selection ring included — clear
        // of the scroller's edges when scrollIntoView lands it there.
        "flex scroll-m-2 flex-col overflow-hidden rounded-lg border border-border text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground",
        marked && PICKED_RING
      )}
    >
      <EffectSwatch id={id} t={t} className="h-16 w-full rounded-none" />
      <span className="py-1.5 leading-none">{EFFECT_LABELS[id]}</span>
    </button>
  );
}

/** Seconds into the effect the preview stands at: still at rest, running while
 * the tile is hovered so the time-varying effects show what they do. */
const SWATCH_T = 0.12; // seconds in — past a flash's white peak
const LOOP_S = 1.4;

function useSwatchClock(running: boolean): number {
  const [t, setT] = useState(SWATCH_T);
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let from = 0;
    const step = (now: number) => {
      if (!from) from = now;
      setT(((now - from) / 1000) % LOOP_S);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // Back to the resting frame as the pointer leaves.
    return () => {
      cancelAnimationFrame(raf);
      setT(SWATCH_T);
    };
  }, [running]);
  return t;
}

/** What an effect does to a picture, on a stand-in picture: the same preview
 * state the canvas pass reads, over a gradient with a bright disc in it so
 * blur, grain, vignette, tearing and shake all read at tile size. */
export function EffectSwatch({
  id,
  t = SWATCH_T,
  className,
}: {
  id: EffectId;
  t?: number;
  className?: string;
}) {
  const st = effectPreviewState(id, 0.9, t);
  const wash = st.washes?.[0];
  // The shake's offset is in design pixels against a 1080 short side; the
  // swatch is a fraction of that, so it needs the room exaggerated to read.
  const pct = (px: number) => (px / 1080) * 800;
  const shake =
    st.dx || st.dy || st.zoom
      ? `translate(${pct(st.dx ?? 0).toFixed(2)}%, ${pct(st.dy ?? 0).toFixed(2)}%) scale(${st.zoom ?? 1})`
      : undefined;
  // A zoom scales about the point it holds; everything else about the middle.
  const origin = st.origin ? `${st.origin.x * 100}% ${st.origin.y * 100}%` : undefined;
  const scene = "absolute inset-0 bg-[linear-gradient(135deg,#5b7cfa_0%,#c04cc0_55%,#f0a12e_100%)]";
  return (
    <span className={cn("relative block overflow-hidden rounded-md bg-black", className)}>
      {!!st.ghostFrac && (
        <span
          className={cn(scene, "opacity-60 mix-blend-screen")}
          style={{ transform: `translateX(${(st.ghostFrac * 900).toFixed(2)}%)` }}
        />
      )}
      <span
        className={scene}
        style={{ filter: st.cssFilter || undefined, transform: shake, transformOrigin: origin }}
      >
        <span className="absolute top-1/4 left-[18%] size-1/3 rounded-full bg-white/85" />
      </span>
      {!!st.grain && (
        <span
          className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,#fff_0.5px,transparent_0)] bg-[length:3px_3px]"
          style={{ opacity: Math.min(0.9, st.grain * 3) }}
        />
      )}
      {!!st.vignette && st.vignette > 0 && (
        <span
          className="absolute inset-0"
          style={{
            background: `radial-gradient(circle at 50% 50%, transparent 30%, rgba(0,0,0,${st.vignette.toFixed(2)}) 100%)`,
          }}
        />
      )}
      {wash && (
        <span
          className="absolute inset-0"
          style={{
            background: wash.color,
            opacity: Math.min(0.7, wash.alpha * 2.5),
            // The recipe names its wash with a canvas composite op; the ones
            // effects use are CSS blend modes by the same name.
            mixBlendMode: wash.mode as React.CSSProperties["mixBlendMode"],
          }}
        />
      )}
      {!!st.flash && (
        <span className="absolute inset-0 bg-white" style={{ opacity: Math.min(0.75, st.flash) }} />
      )}
    </span>
  );
}
