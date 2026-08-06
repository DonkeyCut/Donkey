"use client";

import { useEffect, useRef, useState } from "react";
import {
  EFFECT_IDS,
  EFFECT_LABELS,
  effectPreviewState,
  grainTileUrl,
  LEAK_TINT,
  leakGradient,
  streakGradient,
  type EffectId,
} from "@donkeycut/effects-kit";
import { PICKED_RING, pickGridNav, useAssetPick } from "@/cut/lib/assetPick";
import { clearElementDrag, setElementDragData, setObjectDragImage } from "@/cut/lib/assetDrag";
import { SubTabs } from "@/cut/components/SubTabs";
import { getPreviewCanvas } from "@/cut/lib/previewCanvas";
import { useEditor } from "@/cut/lib/store";
import { isEffectOverlay, type EffectOverlay } from "@/cut/lib/types";
import { useLocalPref } from "@/cut/lib/uiState";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import "./grain.css";

/**
 * The Effects tab: time-ranged treatments over the finished picture — the
 * footage and everything laid over it. A segmented toggle splits the grid
 * into two families: Moving, the effects that play over their stretch of
 * timeline (zoom, grain, VHS, glitch, light leak, flash, shake), and
 * Filters, the still treatments and graded looks (blur, vignette, vintage,
 * noir, halation…). Drag one onto the timeline to place it; a click only
 * picks the tile, the same as every other panel.
 *
 * Select an effect on the timeline and the tab follows it: its family opens,
 * its tile is the marked one, and a click on another tile changes that
 * element to it. The click never places anything — with an effect selected
 * it retunes what is already there, and with nothing selected it just picks.
 */

type EffectGroup = "moving" | "filters";

const GROUPS = [
  { id: "moving", label: "Moving" },
  { id: "filters", label: "Filters" },
] as const;

const MOVING: EffectId[] = ["zoom", "grain", "vhs", "glitch", "lightleak", "flash", "shake"];

const groupOf = (id: EffectId): EffectGroup => (MOVING.includes(id) ? "moving" : "filters");

export function EffectsPanel() {
  const live = useEditor((s) => {
    if (s.selection?.kind !== "overlay") return null;
    const o = s.overlays.find((x) => x.id === s.selection!.id);
    return o && isEffectOverlay(o) ? o : null;
  });
  const [group, setGroup] = useLocalPref<EffectGroup>("cut-effects-group", "moving", (v) =>
    GROUPS.some((g) => g.id === v)
  );
  // The tab follows the selection into its family so the marked tile shows.
  const liveEffect = live?.effect;
  useEffect(() => {
    if (liveEffect) setGroup(groupOf(liveEffect));
  }, [liveEffect, setGroup]);
  const frame = usePlayheadFrame();
  return (
    <>
      {/* PanelHead's height, so the side panel's floating close button lands
          on the toggle's centerline; the right padding keeps clear of it. */}
      <div className="flex h-12 shrink-0 items-center pr-12 pl-3.5">
        <SubTabs tabs={GROUPS} value={group} onChange={setGroup} />
      </div>

      {/* The top pad is the selected tile's ring and its offset: the grid
          starts at the scroll edge, and a ring drawn outside the tile would be
          cut off there. */}
      <ScrollArea className="min-h-0 flex-1" contentClassName="px-3.5 pt-1 pb-4">
        <div className="grid grid-cols-2 gap-2" onKeyDown={pickGridNav}>
          {EFFECT_IDS.filter((id) => groupOf(id) === group).map((id) => (
            <EffectTile key={id} id={id} live={live} frame={frame} />
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

/** The sampled preview frame's short side, doubled from the tile swatch's
 * on-screen size so it stays sharp on retina displays. */
const FRAME_SHORT = 360;

/** A snapshot of the live preview canvas — the whole frame under the playhead,
 * at the canvas's own aspect — encoded small for the tile swatches; null when
 * the canvas has no picture yet. */
function snapshotPreview(): string | null {
  const src = getPreviewCanvas();
  if (!src || !src.width || !src.height) return null;
  const scale = FRAME_SHORT / Math.min(src.width, src.height);
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(src, 0, 0, c.width, c.height);
    // The engine leaves the canvas untouched until a decoder has a frame; a
    // fully transparent readback means there is no picture to show yet.
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = false;
    for (let i = 3; i < px.length; i += 397 * 4) {
      if (px[i] > 0) {
        lit = true;
        break;
      }
    }
    if (!lit) return null;
    return c.toDataURL("image/jpeg", 0.72);
  } catch {
    // A tainted canvas or a blocked readback: the swatch keeps its stand-in.
    return null;
  }
}

/** The last sampled frame, kept across tab switches: the panel unmounts when
 * another tab opens, and a fresh mount seeds from here so the tiles paint the
 * real picture at once with no pass through the stand-in. */
let lastFrame: { project: string; url: string } | null = null;

/** The frame under the playhead as a small data URL, re-sampled as the
 * playhead moves (about five times a second, a beat after each move so the
 * decoder has painted); null until the preview has a picture. */
function usePlayheadFrame(): string | null {
  const projectId = useEditor((s) => s.projectId);
  const [frame, setFrame] = useState<string | null>(() =>
    lastFrame && lastFrame.project === projectId ? lastFrame.url : null
  );
  const tick = useEditor((s) => Math.round(s.currentTime * 5));
  const epoch = useEditor((s) => s.loadEpoch);
  const hasClips = useEditor((s) => s.clips.length > 0);
  useEffect(() => {
    if (!hasClips || !projectId) return;
    const t = setTimeout(() => {
      const shot = snapshotPreview();
      if (shot) {
        lastFrame = { project: projectId, url: shot };
        setFrame(shot);
      }
    }, 160);
    return () => clearTimeout(t);
  }, [tick, epoch, hasClips, projectId]);
  return hasClips ? frame : null;
}

/** One effect: the preview fills the tile with its name under it, a click
 * picks it (or swaps the selected element to it), and a drag onto the timeline
 * places it. Hovering runs the preview — the flash pulses, the glitch tears,
 * the shake moves. */
function EffectTile({
  id,
  live,
  frame,
}: {
  id: EffectId;
  live: EffectOverlay | null;
  frame: string | null;
}) {
  const { picked, pick } = useAssetPick(`effect:${id}`);
  const [hover, setHover] = useState(false);
  // A moving effect's whole point is its motion, so its swatch always plays;
  // a filter swatch stands still until the pointer asks it to run. The leak's
  // motion is a slow continuous wander — the shared 1.4s loop samples a sliver
  // of it and snaps back, so its clock never wraps and the bloom just roams.
  const t = useSwatchClock(hover || groupOf(id) === "moving", id === "lightleak" ? Infinity : LOOP_S);
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
      data-pick-id={`effect:${id}`}
      aria-pressed={marked}
      draggable
      onDragStart={(e) => {
        setElementDragData(e, { kind: "effect", effect: id });
        setObjectDragImage(e);
      }}
      onDragEnd={clearElementDrag}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      onClick={() => {
        if (!live) return pick();
        if (!isLive) useEditor.getState().updateOverlay(live.id, { effect: id });
      }}
      // Scroll margin keeps the whole tile — selection ring included — clear
      // of the scroller's edges when scrollIntoView lands it there. The picked
      // ring is the focus indicator; the browser outline stays off.
      className="flex scroll-m-2 flex-col gap-1.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground"
    >
      <EffectSwatch
        id={id}
        t={t}
        frame={frame}
        className={cn("w-full rounded-lg border border-border", marked && PICKED_RING)}
      />
      <span className="leading-none">{EFFECT_LABELS[id]}</span>
    </button>
  );
}

/** Seconds into the effect the preview stands at: still at rest, running while
 * the tile is hovered so the time-varying effects show what they do. */
const SWATCH_T = 0.12; // seconds in — past a flash's white peak
const LOOP_S = 1.4;

/** One frame callback for every swatch on screen. A tab holds a dozen-odd
 * tiles, and a rAF each would be a dozen wake-ups a frame competing with the
 * preview for the same main thread; they all read this clock instead, so the
 * cost of a running tab is one callback and one batched render. */
const swatchClock = {
  now: 0,
  raf: 0,
  from: 0,
  readers: new Set<() => void>(),
  step(t: number) {
    if (!swatchClock.from) swatchClock.from = t;
    swatchClock.now = (t - swatchClock.from) / 1000;
    for (const read of swatchClock.readers) read();
    swatchClock.raf = requestAnimationFrame(swatchClock.step);
  },
  join(read: () => void) {
    swatchClock.readers.add(read);
    if (!swatchClock.raf) swatchClock.raf = requestAnimationFrame(swatchClock.step);
    return () => {
      swatchClock.readers.delete(read);
      if (swatchClock.readers.size === 0) {
        cancelAnimationFrame(swatchClock.raf);
        swatchClock.raf = 0;
        swatchClock.from = 0;
        swatchClock.now = 0;
      }
    };
  },
};

/** A looping clock for tile previews, shared with the Transitions tab. A
 * `resetKey` change starts the loop over from the top. Swatches stand still
 * while the cut is playing: the picture is what the frames are for then. */
export function useSwatchClock(running: boolean, loop = LOOP_S, resetKey = 0): number {
  const playing = useEditor((s) => s.playing);
  const [t, setT] = useState(SWATCH_T);
  const live = running && !playing;
  useEffect(() => {
    if (!live) return;
    const from = swatchClock.now;
    const leave = swatchClock.join(() => setT((swatchClock.now - from) % loop));
    // Back to the resting frame as the pointer leaves.
    return () => {
      leave();
      setT(SWATCH_T);
    };
  }, [live, loop, resetKey]);
  return t;
}

/** The picture a swatch treats: the given frame when there is one, fit whole
 * inside the square tile, and a small colored landscape as the stand-in, so
 * every treatment reads at tile size. The stand-in comes in two casts — day
 * (sun over green hills) and dusk (moon over dark ones) — so a transition
 * tile can hand over between two scenes that read as different shots. Shared
 * with the Transitions tab. */
export function SwatchScene({
  frame,
  variant = "day",
}: {
  frame: string | null;
  variant?: "day" | "dusk";
}) {
  if (frame) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a transient data URL or filmstrip thumb; the image optimizer has no role
      <img src={frame} alt="" draggable={false} className="absolute inset-0 size-full object-contain" />
    );
  }
  if (variant === "dusk") {
    return (
      <>
        <span className="absolute inset-0 bg-[linear-gradient(165deg,#2b3f77_0%,#5a4a8a_55%,#c26d4a_100%)]" />
        <span className="absolute top-[14%] right-[16%] aspect-square w-[15%] rounded-full bg-[#f3ead0]" />
        <svg
          viewBox="0 0 100 56"
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[56%] w-full"
        >
          <polygon points="0,56 30,8 60,56" fill="#17293c" />
          <polygon points="38,56 70,22 100,52 100,56" fill="#1f3a4d" />
        </svg>
      </>
    );
  }
  return (
    <>
      <span className="absolute inset-0 bg-[linear-gradient(165deg,#6ea8f5_0%,#a97ee0_55%,#f0a12e_100%)]" />
      <span className="absolute top-[12%] left-[14%] aspect-square w-[22%] rounded-full bg-[#fdf0c2]" />
      <svg
        viewBox="0 0 100 56"
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[56%] w-full"
      >
        <polygon points="0,56 30,8 60,56" fill="#255c3f" />
        <polygon points="38,56 70,22 100,52 100,56" fill="#3a7a52" />
      </svg>
    </>
  );
}

/** What an effect does to the picture: the same preview state the canvas pass
 * reads, applied over the swatch scene. */
export function EffectSwatch({
  id,
  t = SWATCH_T,
  frame = null,
  className,
}: {
  id: EffectId;
  t?: number;
  /** The frame under the playhead as a data URL; null shows the stand-in. */
  frame?: string | null;
  className?: string;
}) {
  // The leak wanders at a pace tuned to a clip's seconds; the tile doubles its
  // clock so the roaming reads without a long watch.
  const st = effectPreviewState(id, 0.9, id === "lightleak" ? t * 2 : t);
  const grainUrl = grainTileUrl();
  const wash = st.washes?.[0];
  // Filter blur radii are design px against the full frame; the swatch is a
  // small fraction of one, so the same radius smears it to a wash. Scale the
  // radius to the tile so the picture stays readable through the blur.
  const filter = (st.cssFilter || "").replace(
    /blur\(([\d.]+)px\)/,
    (_, n) => `blur(${(Number(n) * 0.15).toFixed(2)}px)`
  );
  // The shake's offset is in design pixels against a 1080 short side; the
  // swatch is a fraction of that, so the offset is scaled up just enough to
  // read as a tremble at tile size.
  const pct = (px: number) => (px / 1080) * 40;
  const shake =
    st.dx || st.dy || st.zoom
      ? `translate(${pct(st.dx ?? 0).toFixed(2)}%, ${pct(st.dy ?? 0).toFixed(2)}%) scale(${st.zoom ?? 1})`
      : undefined;
  // A zoom scales about the point it holds; everything else about the middle.
  const origin = st.origin ? `${st.origin.x * 100}% ${st.origin.y * 100}%` : undefined;
  // The glitch's chroma ghost is a few pixels of screen blend, and bright
  // footage swallows it at tile size. The swatch tears the picture the way
  // the full-size channel shift reads: strips of the frame knocked sideways,
  // jumping on the preview state's quantized clock.
  const tears =
    id === "glitch"
      ? [0, 1].map((i) => {
          const step = Math.floor(t * 9) + 3 * i;
          const j = ((step * 7919) % 5) - 2; // -2..2, deterministic
          return {
            top: i ? 58 : 22,
            h: i ? 8 : 12,
            dx: (j || 1) * (i ? -2.6 : 3.2),
          };
        })
      : [];
  return (
    <span
      data-drag-object
      className={cn("relative block aspect-square overflow-hidden rounded-md bg-black", className)}
    >
      {!!st.ghostFrac && (
        <span
          className="absolute inset-0 opacity-60 mix-blend-screen"
          style={{ transform: `translateX(${(st.ghostFrac * 900).toFixed(2)}%)` }}
        >
          <SwatchScene frame={frame} />
        </span>
      )}
      <span
        className="absolute inset-0"
        style={{ filter: filter || undefined, transform: shake, transformOrigin: origin }}
      >
        <SwatchScene frame={frame} />
      </span>
      {tears.map((tear) => (
        <span
          key={tear.top}
          className="absolute inset-0"
          style={{
            clipPath: `inset(${tear.top}% 0 ${100 - tear.top - tear.h}% 0)`,
            transform: `translateX(${tear.dx.toFixed(2)}%)`,
          }}
        >
          <SwatchScene frame={frame} />
        </span>
      ))}
      {!!st.grain && grainUrl && (
        <span
          className="cut-grain absolute inset-0"
          style={{ opacity: st.grain, backgroundImage: `url(${grainUrl})` }}
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
      {st.leak && (
        // Each gradient — the bloom, then every streak band — lands twice,
        // the canvas pass's two blends: screen lights the darks, the plain
        // layer tints the brights.
        <span className="absolute inset-0">
          {[
            { bg: leakGradient(st.leak.x, st.leak.y), alpha: st.leak.alpha },
            ...st.leak.streaks.map((s) => ({ bg: streakGradient(s), alpha: s.alpha })),
          ].map((l, j) => (
            <span key={j} className="absolute inset-0">
              <span
                className="absolute inset-0 mix-blend-screen"
                style={{ opacity: l.alpha, background: l.bg }}
              />
              <span
                className="absolute inset-0"
                style={{ opacity: l.alpha * LEAK_TINT, background: l.bg }}
              />
            </span>
          ))}
        </span>
      )}
      {!!st.flash && (
        <span className="absolute inset-0 bg-white" style={{ opacity: Math.min(0.75, st.flash) }} />
      )}
    </span>
  );
}

