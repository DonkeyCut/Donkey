"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BRUSH_SIZE_MAX, BRUSH_SIZE_MIN, useBrushUi } from "@/cut/lib/removal/brushUi";
import {
  cancelMatteBake,
  confirmMatteBake,
  ensureMatteBake,
  retryMatteBake,
  useMatteBakes,
  type MatteBakeJob,
} from "@/cut/lib/removal/bakeJobs";
import { HostedErrorText } from "@/cut/components/hostedError";
import { useEditor } from "@/cut/lib/store";
import { playheadAt } from "@/cut/lib/playhead";
import {
  paintStrokeInk,
  STROKE_DEFAULT_WIDTH,
  STROKE_FEATHER_MAX,
  STROKE_OFFSET_MAX,
  STROKE_WIDTH_MAX,
  retimeOf,
} from "@donkeycut/effects-kit";
import {
  removalActive,
  removalFingerprint,
  STROKE_STYLE_LABELS,
  STROKE_STYLES,
  type ClipRemoval,
  type StrokeStyleId,
  type VideoClip,
  type MediaAsset,
} from "@/cut/lib/types";
import { PICKED_RING } from "@/cut/lib/assetPick";
import { ColorField } from "@/cut/components/ColorField";
import { Row, Section, useSliderCheckpoint } from "@/cut/components/panelBits";
import { parseNumberInput } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The clip panel's Cutout view: one flat pane. A segmented Remove control
 * leads — Off, Background (keep the person, drop the rest), Subject (drop the
 * person, keep the rest), Custom (brush what stays) — and every bake starts
 * from the Apply button, so a pick alone runs nothing.
 * The two complements stack under their own section labels:
 * Stroke (ink around the selection's silhouette) and Fill (the backdrop
 * painted behind the kept picture; its label stays clear of "Background",
 * which the Remove control uses for the direction). Every write lands on the
 * one `clip.removal` field; drafts stream through the transient updater under
 * one checkpoint per gesture, the way the color panel writes its grade.
 */

/** The one choice: what goes, and how the selection is found. Background and
 * Subject share the person matte and differ only in direction; Custom is the
 * brush flow, where the paint marks what stays. */
const TARGETS = [
  { id: "off", label: "Off" },
  { id: "background", label: "Background" },
  { id: "subject", label: "Subject" },
  { id: "custom", label: "Custom" },
] as const;
type Target = (typeof TARGETS)[number]["id"];

/** Shared write path: transiently while a gesture is live, committed at its
 * end, one checkpoint per gesture. */
function useRemovalWriter(clip: VideoClip) {
  const ck = useSliderCheckpoint();
  const draft = (r: ClipRemoval | undefined) => {
    ck.begin();
    useEditor.getState().updateClipTransient(clip.id, { removal: r });
  };
  const commit = (r: ClipRemoval | undefined) => {
    draft(r);
    ck.end();
  };
  return { draft, commit };
}

export function RemovalPanel({ clip, onBack }: { clip: VideoClip; onBack: () => void }) {
  const removal = clip.removal;
  const { commit } = useRemovalWriter(clip);
  const peeking = useEditor((s) => s.removalPeek === clip.id);

  // Peek only while held; a switched selection or a closed panel lets go too.
  useEffect(
    () => () => {
      if (useEditor.getState().removalPeek) useEditor.setState({ removalPeek: null });
    },
    [clip.id]
  );

  // The bake the clip's AI matte owes, restarted whenever trims or seeds move
  // it. The doc sweep covers the closed-panel cases; this keeps the open
  // panel immediate.
  const fp = removal && !removal.off ? removalFingerprint(clip.assetId, removal) : null;
  useEffect(() => {
    if (fp) ensureMatteBake(clip.id);
  }, [clip.id, fp, clip.in, clip.out]);

  // The brush session follows custom mode while its panel is open.
  useEffect(() => {
    const brush = useBrushUi.getState();
    if (removal?.mode === "custom" && !removal.off) brush.open(clip.id);
    else if (brush.clipId === clip.id) brush.close();
    return () => {
      const b = useBrushUi.getState();
      if (b.clipId === clip.id) b.close();
    };
  }, [clip.id, removal?.mode, removal?.off]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 bg-card pb-2">
        <div className="flex h-10 shrink-0 items-center gap-1 px-2.5 text-sm font-semibold tracking-tight">
          <button
            type="button"
            aria-label="Back"
            className="clip-cutout-back grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            onClick={onBack}
          >
            <ChevronLeft className="size-4" />
          </button>
          Cutout
        </div>
      </div>
      <ScrollArea
        className="min-h-0 flex-1"
        viewportClassName="overscroll-contain"
        contentClassName="flex flex-col gap-1 px-3.5 pt-1 pb-4"
      >
        <RemovalView clip={clip} />
        {removalActive(removal) && (
          <Row label="Original">
            <button
              type="button"
              aria-pressed={peeking}
              className={cn(
                "clip-cutout-peek rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition-colors",
                peeking
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-input text-muted-foreground hover:text-foreground"
              )}
              onClick={() => useEditor.setState({ removalPeek: peeking ? null : clip.id })}
            >
              {peeking ? "Hide" : "Show"}
            </button>
          </Row>
        )}
        <RemovalActions clip={clip} />
        {removal && removalActive(removal) && (
          <>
            <Section
              title="Stroke"
              info="Ink drawn around the cutout's silhouette — pick a style, color, and width."
              enabled={!!removal.stroke}
              onEnabledChange={(v) =>
                commit({ ...removal, stroke: v ? { style: "solid", color: "#ffffff" } : undefined })
              }
            >
              <StrokeView clip={clip} />
            </Section>
            <Section
              title="Fill"
              info="A color or image painted into the removed area, inside the clip's own frame."
              enabled={!!removal.backdrop && removal.backdrop.kind !== "none"}
              onEnabledChange={(v) =>
                commit({ ...removal, backdrop: v ? { kind: "color", color: "#101014" } : undefined })
              }
            >
              <BackgroundView clip={clip} />
            </Section>
          </>
        )}
      </ScrollArea>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Removal                                                             */
/* ------------------------------------------------------------------ */

/** The Remove control: one segmented row, every option in sight. A pick
 * only sets the direction — Apply starts the bake. Background and Subject
 * share the free person matte, so switching between them just flips the
 * direction and a baked matte carries over. Custom opens the brush flow,
 * where the paint marks what stays. */
function ModePicker({ clip }: { clip: VideoClip }) {
  const { commit } = useRemovalWriter(clip);
  const removal = clip.removal;
  // One job at a time: while a bake runs, the other choices wait — Cancel is
  // the way to change course mid-bake.
  const running = useMatteBakes((s) => s.jobs[clip.id]?.status === "running");
  const target: Target =
    !removal || removal.off
      ? "off"
      : removal.mode === "custom"
        ? "custom"
        : removal.invert
          ? "subject"
          : "background";

  const pick = (next: Target) => {
    if (next === target) return;
    // Off keeps the removal and its baked matte on the clip — it just stops
    // rendering and baking — so switching back on costs nothing.
    if (next === "off") {
      commit({ ...removal!, off: true });
      return;
    }
    const mode = next === "custom" ? ("custom" as const) : ("auto" as const);
    const base: ClipRemoval = { ...removal, mode };
    delete base.off;
    delete base.invert;
    // A new mode returns to un-applied — its bake waits for Apply. Flipping
    // Background/Subject stays inside one matte, so the ask carries over.
    if (removal?.mode !== mode) delete base.requested;
    if (next === "subject") base.invert = true;
    if (next === "custom" && !base.seeds) base.seeds = { prompts: [] };
    commit(base);
  };

  return (
    <div className="pb-1">
      <div className="pb-1.5 text-[13px] text-muted-foreground">Remove</div>
      <div className="clip-removal-target flex shrink-0 rounded-lg bg-muted p-0.5 text-[11.5px] font-medium">
        {TARGETS.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={target === o.id}
            disabled={running && target !== o.id}
            className={cn(
              `clip-removal-target-${o.id} whitespace-nowrap rounded-md px-2 py-1 transition-colors`,
              // Every label carries the same padding, sized so all four fit
              // the pane at their natural width — a squeezed row would shrink
              // the last segment's padding. The real options grow from their
              // own width, so leftover space spreads evenly and Off stays at
              // its size.
              o.id !== "off" && "grow",
              target === o.id
                ? "bg-neutral-900 text-white"
                : "text-muted-foreground hover:text-foreground",
              "disabled:pointer-events-none disabled:opacity-40"
            )}
            onClick={() => pick(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RemovalView({ clip }: { clip: VideoClip }) {
  return (
    <>
      <ModePicker clip={clip} />
      {clip.removal?.mode === "custom" && !clip.removal.off && <CustomControls clip={clip} />}
    </>
  );
}

function BakeStatus({
  clipId,
  job,
  label,
  onCancel,
}: {
  clipId: string;
  job: MatteBakeJob | undefined;
  /** What the running bake is actually doing — the work is the selection,
   * shared by both directions, so the line never claims a side. */
  label: string;
  onCancel?: () => void;
}) {
  if (!job) return null;
  if (job.status === "error")
    return (
      <div className="flex items-start justify-between gap-2 pt-1 text-[11.5px] text-muted-foreground">
        <span className="min-w-0">
          <HostedErrorText error={job.error ?? "The cutout could not be prepared."} />
        </span>
        <button
          type="button"
          className="clip-removal-retry shrink-0 rounded-md border border-input px-2 py-0.5 font-medium transition-colors hover:text-foreground"
          onClick={() => retryMatteBake(clipId)}
        >
          Retry
        </button>
      </div>
    );
  return (
    <div className="flex items-start justify-between gap-2 pt-1 text-[11.5px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-2 py-0.5">
        <Loader2 className="size-3 shrink-0 animate-spin" />
        <span>{label}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {onCancel && (
          <button
            type="button"
            className="clip-removal-cancel rounded-md border border-input px-2 py-0.5 font-medium transition-colors hover:text-foreground"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
        <span className="font-mono tabular-nums">
          {Math.round(job.progress * 100)}%
          {job.secondsLeft !== undefined && job.etaAt !== undefined ? (
            <TickingEta secondsLeft={job.secondsLeft} etaAt={job.etaAt} />
          ) : job.startedAt !== undefined ? (
            <TickingElapsed startedAt={job.startedAt} />
          ) : null}
        </span>
      </span>
    </div>
  );
}

/** The countdown between progress steps: each estimate ticks down in real
 * time from the moment it was stamped until the next one replaces it. */
/** The running time, ticking up from the bake's start until the pace
 * estimate lands and the countdown takes the slot. */
function TickingElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  return `, ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function TickingEta({ secondsLeft, etaAt }: { secondsLeft: number; etaAt: number }) {
  const [now, setNow] = useState(etaAt);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, secondsLeft - Math.max(0, Math.round((now - etaAt) / 1000)));
  return `, ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

function CustomControls({ clip }: { clip: VideoClip }) {
  const tool = useBrushUi((s) => s.tool);
  const size = useBrushUi((s) => s.size);
  const erasing = tool === "erase";
  // Strokes live on the frames they were drawn on, so after playing away the
  // overlay looks empty — this seeks back to a stroke frame, cycling through
  // them when several frames carry paint. Only frames inside the clip's
  // current trim count: a trim can move past stored paint, and a seek to a
  // frame the clip no longer plays would land off the clip.
  const seeds = clip.removal?.seeds;
  const strokeTimes = Array.from(new Set((seeds?.paint ?? []).map((s) => s.t)))
    .filter((t) => t >= clip.in - 0.05 && t <= clip.out + 0.05)
    .sort((a, b) => a - b);
  const showStrokes = () => {
    if (!strokeTimes.length) return;
    const rt = retimeOf(clip);
    const srcNow = rt.srcAt(Math.max(0, playheadAt() - clip.start));
    const next = strokeTimes.find((t) => t > srcNow + 0.05) ?? strokeTimes[0];
    const end = clip.start + rt.len;
    useEditor
      .getState()
      .seek(Math.min(Math.max(clip.start, clip.start + rt.tAt(next)), end - 0.001));
  };
  return (
    <>
      <Row
        label="Tool"
        info={clip.removal?.invert ? "Paint to pick what goes" : "Paint to pick what stays"}
      >
        <div className="clip-brush-tool flex rounded-lg border border-input p-0.5">
          {([false, true] as const).map((erase) => (
            <button
              key={String(erase)}
              type="button"
              className={cn(
                `clip-brush-tool-${erase ? "erase" : "brush"} rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors`,
                erasing === erase
                  ? "bg-neutral-900 text-white"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-pressed={erasing === erase}
              onClick={() => useBrushUi.getState().setTool(erase ? "erase" : "brush")}
            >
              {erase ? "Erase" : "Brush"}
            </button>
          ))}
        </div>
      </Row>
      <div className="clip-brush-size-row">
        <Row label="Size">
          <ValueSlider
            label="Size"
            sliderClassName="clip-brush-size data-horizontal:w-24"
            valueClassName="w-12 text-muted-foreground"
            value={Math.round(size * 1080)}
            min={Math.round(BRUSH_SIZE_MIN * 1080)}
            max={Math.round(BRUSH_SIZE_MAX * 1080)}
            step={1}
            format={(v) => `${Math.round(v)}px`}
            parse={parseNumberInput}
            onDraft={(v) => useBrushUi.getState().setSize(v / 1080)}
            onCommit={(v) => useBrushUi.getState().setSize(v / 1080)}
          />
        </Row>
      </div>
      {strokeTimes.length > 0 && (
        <Row label="Strokes">
          <button
            type="button"
            className="clip-brush-strokes rounded-md border border-input px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={showStrokes}
          >
            Show
          </button>
        </Row>
      )}
    </>
  );
}

/** The panel floor: the bake's status line and its actions. Nothing bakes
 * on its own — Apply starts each rung: auto's free person matte, then the
 * hosted quality pass; custom's tracked bake for the painted selection. */
function RemovalActions({ clip }: { clip: VideoClip }) {
  const job = useMatteBakes((s) => s.jobs[clip.id]);
  const { commit } = useRemovalWriter(clip);
  const r = clip.removal;
  if (!r || r.off) return null;
  const custom = r.mode === "custom";
  // Paint outside the clip's current trim can't seed this bake (the tracker
  // drops it), so it doesn't count as a selection.
  const inTrim = (t: number) => t >= clip.in - 0.05 && t <= clip.out + 0.05;
  const hasSelection =
    custom &&
    !!(
      r.seeds?.prompts.some((s) => inTrim(s.t)) ||
      r.seeds?.paint?.some((s) => inTrim(s.t)) ||
      r.subject?.trim()
    );
  const running = job?.status === "running";
  const showStart = !custom && !r.matte && !r.requested && !running;
  const showRefine = !custom && r.matte?.quality === "local" && !r.refine && !running;
  const showCustom = custom && hasSelection && !running;
  const start = () => {
    if (custom) {
      commit({ ...r, requested: true });
      confirmMatteBake(clip.id);
    } else if (!r.matte) {
      commit({ ...r, requested: true });
      ensureMatteBake(clip.id);
    } else {
      commit({ ...r, refine: true });
      ensureMatteBake(clip.id);
    }
  };
  // Cancel by rung: the quality pass falls back to what stands (auto keeps
  // the quick matte, custom returns to un-applied — its paid ticket resumes
  // a re-Apply); cancelling the free bake clears the ask, so the mode stays
  // picked and the sweep restarts nothing until the next Apply.
  const cancel = !running
    ? undefined
    : () => {
        if (job!.quality === "hq") {
          commit(custom ? { ...r, requested: undefined } : { ...r, refine: undefined });
        } else {
          commit({ ...r, requested: undefined });
        }
        cancelMatteBake(clip.id);
      };
  return (
    <>
      <BakeStatus
        clipId={clip.id}
        job={job}
        label={
          custom
            ? "Tracking the selection…"
            : job?.quality === "hq"
              ? "Refining the person matte…"
              : "Finding the person…"
        }
        onCancel={cancel}
      />
      {(showStart || showRefine || showCustom) && (
        <div className="flex items-center justify-end gap-1.5 pt-1">
          {showCustom && (
            <button
              type="button"
              className="clip-brush-reset shrink-0 rounded-md border border-input px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              onClick={() =>
                commit({
                  ...r,
                  seeds: { prompts: [] },
                  matte: undefined,
                  requested: undefined,
                })
              }
            >
              Reset
            </button>
          )}
          <button
            type="button"
            className={cn(
              "shrink-0 rounded-md bg-neutral-900 px-2.5 py-0.5 text-[11.5px] font-medium text-white transition-colors hover:bg-neutral-700",
              custom ? "clip-brush-apply" : "clip-removal-refine"
            )}
            onClick={start}
          >
            Apply
          </button>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Stroke                                                              */
/* ------------------------------------------------------------------ */

/** A person silhouette drawn into `ctx`, the stand-in subject the style
 * tiles ink around: the user-icon figure filled — a floating round head
 * over a shoulder dome, with clear air between the two so the ink traces
 * each shape the way it traces a real matte's edges. Proportions follow the
 * icon's 24-grid (head r 4 at y 7, shoulders 14 wide from y 15 to 21). */
function paintPerson(ctx: CanvasRenderingContext2D, w: number, h: number, fill: string) {
  const s = h;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(w * 0.5, s * 0.3, s * 0.165, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(w * 0.5 - s * 0.3, s * 0.61, s * 0.6, s * 0.31, [
    s * 0.155,
    s * 0.155,
    s * 0.05,
    s * 0.05,
  ]);
  ctx.fill();
}

function StrokeTile({
  style,
  color,
  selected,
  onPick,
}: {
  style: StrokeStyleId;
  color: string;
  selected: boolean;
  onPick: () => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const sil = document.createElement("canvas");
    sil.width = w;
    sil.height = h;
    const sctx = sil.getContext("2d")!;
    paintPerson(sctx, w, h, "#ffffff");
    const ink = document.createElement("canvas");
    ink.width = w;
    ink.height = h;
    const ictx = ink.getContext("2d")!;
    paintStrokeInk(ictx, sil, w, h, { style, color, width: 6 }, 0.6, 1);
    ictx.globalCompositeOperation = "source-in";
    ictx.fillStyle = color;
    ictx.fillRect(0, 0, w, h);
    paintPerson(ctx, w, h, "#52525b");
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(ink, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }, [style, color]);
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        `clip-stroke-${style} flex flex-col items-center gap-1.5 text-[10.5px] font-medium outline-none transition-colors`,
        selected ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
      onClick={onPick}
    >
      <canvas
        ref={ref}
        width={96}
        height={64}
        className={cn(
          "w-full rounded-lg border border-border bg-neutral-950/90",
          selected && PICKED_RING
        )}
      />
      <span className="leading-none">{STROKE_STYLE_LABELS[style]}</span>
    </button>
  );
}

/** The Stroke section, rendered only under an active cutout. */
function StrokeView({ clip }: { clip: VideoClip }) {
  const { draft, commit } = useRemovalWriter(clip);
  const removal = clip.removal;
  if (!removal) return null;
  const stroke = removal.stroke;
  const color = stroke?.color ?? "#ffffff";
  const setStroke = (patch: Partial<NonNullable<typeof stroke>>, live?: boolean) =>
    (live ? draft : commit)({
      ...removal,
      stroke: { style: stroke?.style ?? "solid", color, ...stroke, ...patch },
    });
  return (
    <>
      <div className="grid grid-cols-3 gap-2 pt-1">
        {STROKE_STYLES.map((s) => (
          <StrokeTile
            key={s}
            style={s}
            color={color}
            selected={stroke?.style === s}
            onPick={() => setStroke({ style: s })}
          />
        ))}
      </div>
      {stroke && (
        <>
          <Row label="Color">
            <ColorField
              value={color}
              onBegin={() => {}}
              onLive={(hex) => setStroke({ color: hex }, true)}
              onCommit={(hex) => setStroke({ color: hex })}
            />
          </Row>
          <Row label="Width">
            <ValueSlider
              label="Width"
              sliderClassName="clip-stroke-width data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={stroke.width ?? STROKE_DEFAULT_WIDTH}
              min={1}
              max={STROKE_WIDTH_MAX}
              step={1}
              format={(v) => `${Math.round(v)}`}
              parse={parseNumberInput}
              onDraft={(v) => setStroke({ width: v }, true)}
              onCommit={(v) => setStroke({ width: v })}
            />
          </Row>
          <Row label="Feather">
            <ValueSlider
              label="Feather"
              sliderClassName="clip-stroke-feather data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={stroke.feather ?? 0}
              min={0}
              max={STROKE_FEATHER_MAX}
              step={1}
              snap={[0]}
              format={(v) => `${Math.round(v)}`}
              parse={parseNumberInput}
              onDraft={(v) => setStroke({ feather: v }, true)}
              onCommit={(v) => setStroke({ feather: v || undefined })}
            />
          </Row>
          {stroke.style === "offset" && (
            <>
              <Row label="Horizontal">
                <ValueSlider
                  label="Horizontal"
                  sliderClassName="clip-stroke-offset-x data-horizontal:w-24"
                  valueClassName="w-9 text-muted-foreground"
                  value={stroke.offsetX ?? 0}
                  min={-STROKE_OFFSET_MAX}
                  max={STROKE_OFFSET_MAX}
                  step={1}
                  snap={[0]}
                  format={(v) => `${Math.round(v)}`}
                  parse={parseNumberInput}
                  onDraft={(v) => setStroke({ offsetX: v }, true)}
                  onCommit={(v) => setStroke({ offsetX: v || undefined })}
                />
              </Row>
              <Row label="Vertical">
                <ValueSlider
                  label="Vertical"
                  sliderClassName="clip-stroke-offset-y data-horizontal:w-24"
                  valueClassName="w-9 text-muted-foreground"
                  value={stroke.offsetY ?? 0}
                  min={-STROKE_OFFSET_MAX}
                  max={STROKE_OFFSET_MAX}
                  step={1}
                  snap={[0]}
                  format={(v) => `${Math.round(v)}`}
                  parse={parseNumberInput}
                  onDraft={(v) => setStroke({ offsetY: v }, true)}
                  onCommit={(v) => setStroke({ offsetY: v || undefined })}
                />
              </Row>
            </>
          )}
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Background                                                          */
/* ------------------------------------------------------------------ */

/** A backdrop image choice, in the trigger and the dropdown alike: the
 * picture itself leads, since the file's name says nothing about it. */
function BackdropImageOption({ asset, thumb }: { asset: MediaAsset; thumb: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <img
        src={asset.url}
        alt=""
        draggable={false}
        className={cn("shrink-0 rounded border border-black/10 object-cover", thumb)}
      />
      <span className="truncate">{asset.name}</span>
    </span>
  );
}

/** The Fill section, rendered only under an active cutout. */
function BackgroundView({ clip }: { clip: VideoClip }) {
  const { draft, commit } = useRemovalWriter(clip);
  const removal = clip.removal;
  const assets = useEditor((s) => s.assets);
  const images = assets.filter((a) => a.type === "image" && !a.origin);
  if (!removal) return null;
  const backdrop = removal.backdrop;
  const kind = backdrop?.kind ?? "none";
  const setBackdrop = (b: ClipRemoval["backdrop"], live?: boolean) =>
    (live ? draft : commit)({ ...removal, backdrop: b });
  const pill = (id: "color" | "image", label: string) => (
    <button
      key={id}
      type="button"
      className={cn(
        `clip-backdrop-${id} relative flex-1 rounded-md px-1.5 py-1 transition-colors`,
        kind === id ? "bg-neutral-900 text-white" : "text-muted-foreground hover:text-foreground"
      )}
      onClick={() =>
        setBackdrop(
          id === "color"
            ? { kind: "color", color: backdrop?.color ?? "#101014" }
            : { kind: "image", color: backdrop?.color, assetId: backdrop?.assetId ?? images[0]?.id }
        )
      }
    >
      {label}
    </button>
  );
  return (
    <>
      <div className="flex shrink-0 rounded-lg bg-muted p-0.5 text-[11.5px] font-medium">
        {pill("color", "Color")}
        {pill("image", "Image")}
      </div>
      {kind === "color" && (
        <Row label="Color">
          <ColorField
            value={backdrop?.color ?? "#101014"}
            onBegin={() => {}}
            onLive={(hex) => setBackdrop({ kind: "color", color: hex }, true)}
            onCommit={(hex) => setBackdrop({ kind: "color", color: hex })}
          />
        </Row>
      )}
      {kind === "image" &&
        (images.length === 0 ? (
          <p className="pt-2 text-[12px] text-muted-foreground">
            Import an image into Media to use it as the background.
          </p>
        ) : (
          <Row label="Image">
            <Select
              value={backdrop?.assetId ?? images[0].id}
              onValueChange={(id) => setBackdrop({ kind: "image", assetId: id as string })}
            >
              <SelectTrigger className="clip-backdrop-image w-36 py-1 text-[12px]">
                <SelectValue>
                  {(id: string) => {
                    const a = images.find((i) => i.id === id);
                    return a ? <BackdropImageOption asset={a} thumb="h-5 w-8" /> : null;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {images.map((a) => (
                  <SelectItem
                    key={a.id}
                    value={a.id}
                    className={`clip-backdrop-image-${a.id} text-[12px]`}
                  >
                    <BackdropImageOption asset={a} thumb="h-7 w-11" />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        ))}
    </>
  );
}
