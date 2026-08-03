"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpToLine,
  Blend,
  Circle,
  Droplets,
  Expand,
  FoldHorizontal,
  Moon,
  Sun,
  Target,
  Trash2,
  UnfoldHorizontal,
  type LucideIcon,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tile } from "@/cut/components/PanelTile";
import { parseSecondsInput, ScrubValue } from "@/cut/components/ScrubValue";
import { SectionTitle } from "@/cut/components/SectionTitle";
import { clearElementDrag, setElementDragData } from "@/cut/lib/assetDrag";
import { PICKED_RING, useAssetPick } from "@/cut/lib/assetPick";
import { getClipSpans, resolveTransitions, useEditor } from "@/cut/lib/store";
import {
  ANIM_DEFAULT_SECONDS,
  ANIM_STYLE_IDS,
  ANIM_STYLE_LABELS,
  TRANSITION_MAX,
  TRANSITION_STYLE_GROUPS,
  TRANSITION_STYLE_IDS,
  TRANSITION_STYLE_LABELS,
  type AnimStyle,
  type TimelineTransition,
  type TransitionStyle,
  type VideoClip,
} from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

const TILE_ICONS: Record<TransitionStyle, LucideIcon> = {
  crossfade: Blend,
  crosszoom: Expand,
  dipblack: Moon,
  dipwhite: Sun,
  blur: Droplets,
  pushleft: ArrowLeft,
  pushright: ArrowRight,
  pushup: ArrowUp,
  pushdown: ArrowDown,
  wipeleft: ArrowLeftToLine,
  wiperight: ArrowRightToLine,
  wipeup: ArrowUpToLine,
  wipedown: ArrowDownToLine,
  circleopen: Circle,
  circleclose: Target,
  splitopen: UnfoldHorizontal,
  splitclose: FoldHorizontal,
};

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
  return (
    <>
      <div className="flex h-12 shrink-0 items-center pr-2.5 pl-4">
        <span className="text-sm font-semibold tracking-tight">Transitions</span>
      </div>

      <ScrollArea className="min-h-0 flex-1" contentClassName="px-3.5 pb-4">
        <SelectedClip />
        {TRANSITION_STYLE_GROUPS.map((g) => (
          <section key={g.label} className="mb-3 flex flex-col gap-1.5">
            <SectionTitle>{g.label}</SectionTitle>
            <div className="grid grid-cols-2 gap-1.5">
              {g.ids.map((id) => (
                <TransitionTile key={id} style={id} live={live} />
              ))}
            </div>
          </section>
        ))}
      </ScrollArea>
    </>
  );
}

function TransitionTile({
  style,
  live,
}: {
  style: TransitionStyle;
  live: TimelineTransition | null;
}) {
  const { picked, pick } = useAssetPick(`transition:${style}`);
  const ref = useRef<HTMLButtonElement>(null);
  const Icon = TILE_ICONS[style];
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
    <Tile
      ref={ref}
      selected={marked}
      label={TRANSITION_STYLE_LABELS[style]}
      title={
        live
          ? `Change the selected transition to ${TRANSITION_STYLE_LABELS[style]}`
          : `Drag ${TRANSITION_STYLE_LABELS[style]} onto the transition track`
      }
      // Scroll margin keeps the whole tile — selection ring included — clear
      // of the scroller's edges when scrollIntoView lands it there.
      className={cn("scroll-m-2", marked && PICKED_RING)}
      onClick={() => {
        if (!live) return pick();
        if (!isLive) useEditor.getState().updateTransition(live.id, { style });
        previewBar(live);
      }}
      draggable
      onDragStart={(e) => setElementDragData(e, { kind: "transition", style })}
      onDragEnd={clearElementDrag}
    >
      <Icon className="size-4" />
    </Tile>
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
