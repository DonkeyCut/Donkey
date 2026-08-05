"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { SwatchScene, useSwatchClock, useSwatchRatio } from "@/cut/components/EffectsPanel";
import { parseSecondsInput, ScrubValue } from "@/cut/components/ScrubValue";
import { SectionTitle } from "@/cut/components/SectionTitle";
import { clearElementDrag, setElementDragData } from "@/cut/lib/assetDrag";
import { peekEdgeFrame, requestEdgeFrame } from "@/cut/lib/media";
import { PICKED_RING, pickGridNav, useAssetPick } from "@/cut/lib/assetPick";
import { getClipSpans, resolveTransitions, useEditor } from "@/cut/lib/store";
import {
  ANIM_DEFAULT_SECONDS,
  ANIM_STYLE_IDS,
  ANIM_STYLE_LABELS,
  TRANSITION_MAX,
  TRANSITION_STYLE_GROUPS,
  TRANSITION_STYLE_IDS,
  TRANSITION_STYLE_LABELS,
  type MediaAsset,
  type TimelineTransition,
  type TransitionStyle,
  type VideoClip,
  type AnimStyle,
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
 * Select a clip and the top of the tab becomes that clip's controls: the
 * transition it already carries, and its entrance and exit. Select one that
 * already has a transition and the tab follows it — its style is the marked
 * tile, and a click on another tile changes that transition to it. The click
 * never places anything: with nothing transitioned it only picks.
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
      s.transitions.find((t) => {
        const r = roles.get(t.id);
        return !!r && r.kind === "cut" && r.clipId === s.selection!.id;
      }) ?? null
    );
  });
  const { a, b } = useCutFrames();
  return (
    <>
      {/* No header row. The top padding clears the side panel's floating
          close button: the first group's title runs beside it on the left,
          and the first tile row starts below it. */}
      <ScrollArea className="min-h-0 flex-1" contentClassName="px-3.5 pt-5 pb-4">
        <SelectedClip />
        {/* One key handler over every group, so arrows walk the whole list
            across section boundaries. It wraps only the tile grids — the
            selected clip's sliders and selects keep their own arrow keys. */}
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
  const tick = useEditor((s) => Math.round(s.currentTime * 2));
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
        a: { asset: out.asset, srcT: out.clip.in + out.len * (out.clip.speed ?? 1) },
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
  const t = useSwatchClock(true, X_LOOP, runEpoch);
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
      onDragStart={(e) => setElementDragData(e, { kind: "transition", style })}
      onDragEnd={clearElementDrag}
      onPointerEnter={() => setRunEpoch((n) => n + 1)}
      onFocus={() => setRunEpoch((n) => n + 1)}
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
  const ratio = useSwatchRatio();
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
      className={cn("relative block overflow-hidden rounded-md bg-black", className)}
      style={{ aspectRatio: ratio }}
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

/** Play the clip's handover into the next one: every change to it shows itself
 * on the real footage. The blend runs across the clip's own tail, ending at
 * the cut, so the window starts ahead of the blend and runs a beat past it. */
function previewTransition(clip: VideoClip) {
  const s = useEditor.getState();
  const spans = getClipSpans(s.clips, s.assets, clip.track);
  const i = spans.findIndex((sp) => sp.clip.id === clip.id);
  const sp = spans[i];
  const next = spans[i + 1];
  if (!sp || !next || sp.transitionOut <= 0) return;
  s.previewRange(next.start - sp.transitionOut - PREVIEW_LEAD, next.start + PREVIEW_TAIL);
}

/**
 * The selected clip's own handovers: the transition it hands over with, and its
 * entrance and exit. The transition block appears once the clip carries one —
 * transitions are placed by dragging a tile onto the track, and this is where
 * the one already there is retuned. In and Out are the same clip's own
 * arrival and departure — what a transition becomes on an open edge.
 */
function SelectedClip() {
  const clip = useEditor((s) =>
    s.selection?.kind === "clip" ? s.clips.find((c) => c.id === s.selection!.id) : undefined
  );
  const hasNext = useEditor((s) =>
    clip ? s.clips.some((c) => c.track === clip.track && c.start > clip.start + 1e-6) : false
  );
  if (!clip) return null;
  const xfade = clip.transition ?? 0;
  return (
    <section className="mb-4 flex flex-col gap-1 border-b border-border pb-2">
      <SectionTitle className="mb-0.5">Selected clip</SectionTitle>
      {hasNext && xfade > 0 && <ClipTransition clip={clip} />}
      <ClipAnim clip={clip} which="in" />
      <ClipAnim clip={clip} which="out" />
    </section>
  );
}

function ClipTransition({ clip }: { clip: VideoClip }) {
  const style = clip.transitionStyle ?? "crossfade";
  // Retiming a transition slides the clips behind it, so the drag runs on a
  // draft and lands once — the layout moves on release.
  const [draft, setDraft] = useState<number | null>(null);
  const len = draft ?? clip.transition ?? 0;
  const preview = () => previewTransition(clip);
  return (
    <>
      <Row label="Transition">
        <Select
          value={style}
          items={TRANSITION_STYLE_LABELS}
          onValueChange={(v) => {
            useEditor.getState().setClipTransition(clip.id, len, v as TransitionStyle);
            preview();
          }}
        >
          <SelectTrigger size="sm" className="clip-xstyle w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSITION_STYLE_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {TRANSITION_STYLE_LABELS[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          aria-label="Remove transition"
          title="Remove transition"
          className="clip-xremove grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => useEditor.getState().setClipTransition(clip.id, 0)}
        >
          <Trash2 className="size-3.5" />
        </button>
      </Row>
      <Row label="Length">
        <LengthSlider
          className="clip-xfade"
          value={len}
          min={0.1}
          onChange={setDraft}
          onCommit={(v) => {
            useEditor.getState().setClipTransition(clip.id, v, style);
            setDraft(null);
            preview();
          }}
        />
      </Row>
    </>
  );
}

function ClipAnim({ clip, which }: { clip: VideoClip; which: "in" | "out" }) {
  const anim = which === "in" ? clip.animIn : clip.animOut;
  // The length drag runs on a draft and lands once on release — the bar
  // behind this edge moves on commit.
  const [draft, setDraft] = useState<number | null>(null);
  // Upper tracks composite through alpha, so only the animations expressible as
  // alpha and zoom ramps are offered there.
  const styles = clip.track > 0 ? (["fade", "zoom"] as AnimStyle[]) : ANIM_STYLE_IDS;
  const labels: Record<string, string> = { none: "None", ...ANIM_STYLE_LABELS };
  const preview = () => {
    const s = useEditor.getState();
    const sp = getClipSpans(s.clips, s.assets, clip.track).find((x) => x.clip.id === clip.id);
    const fresh = s.clips.find((c) => c.id === clip.id);
    const a = which === "in" ? fresh?.animIn : fresh?.animOut;
    if (!sp || !a) return;
    if (which === "in") s.previewRange(sp.start - 0.25, sp.start + a.seconds + PREVIEW_TAIL);
    else s.previewRange(sp.start + sp.len - a.seconds - PREVIEW_LEAD, sp.start + sp.len + 0.25);
  };
  const commitSeconds = (seconds: number) => {
    if (!anim) return;
    useEditor.getState().setClipAnim(clip.id, which, { style: anim.style, seconds });
    setDraft(null);
  };
  return (
    <>
      <Row label={which === "in" ? "In" : "Out"}>
        <Select
          value={anim?.style ?? "none"}
          items={labels}
          onValueChange={(v) => {
            useEditor
              .getState()
              .setClipAnim(
                clip.id,
                which,
                v === "none"
                  ? null
                  : {
                      style: v as AnimStyle,
                      seconds: anim?.seconds ?? ANIM_DEFAULT_SECONDS,
                    }
              );
            if (v !== "none") preview();
          }}
        >
          <SelectTrigger size="sm" className={`clip-anim-${which} w-28`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            {styles.map((id) => (
              <SelectItem key={id} value={id}>
                {ANIM_STYLE_LABELS[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      {anim && (
        <Row label="Length">
          <LengthSlider
            className={`clip-anim-${which}-secs`}
            value={draft ?? anim.seconds}
            min={0.1}
            onChange={setDraft}
            onCommit={(v) => {
              commitSeconds(v);
              preview();
            }}
          />
        </Row>
      )}
    </>
  );
}

/** Seconds of a handover: slider plus a scrubbable readout, one undo
 * checkpoint per drag. */
function LengthSlider({
  className,
  value,
  min,
  onChange,
  onCommit,
}: {
  className?: string;
  value: number;
  min: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  return (
    <>
      <Slider
        className={cn(className, "data-horizontal:w-24")}
        min={min}
        max={TRANSITION_MAX}
        step={0.1}
        value={value}
        onValueChange={(v) => onChange(Number(v))}
        onValueCommitted={(v) => onCommit(Number(v))}
      />
      <ScrubValue
        label="Length"
        className="w-9 text-muted-foreground"
        value={value}
        min={min}
        max={TRANSITION_MAX}
        step={0.1}
        format={(v) => `${v.toFixed(1)}s`}
        parse={parseSecondsInput}
        onScrub={onChange}
        onCommit={onCommit}
      />
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-2.5">
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}
