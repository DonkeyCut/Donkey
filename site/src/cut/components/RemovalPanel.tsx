"use client";

import { useEffect, useRef, useState } from "react";
import { Ban, ChevronLeft, Loader2, WandSparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BRUSH_SIZE_MAX,
  BRUSH_SIZE_MIN,
  useBrushUi,
  type BrushTool,
} from "@/cut/lib/removal/brushUi";
import {
  confirmMatteBake,
  ensureMatteBake,
  retryMatteBake,
  useMatteBakes,
  type MatteBakeJob,
} from "@/cut/lib/removal/bakeJobs";
import { clipKeyColor, suggestKeyColor } from "@/cut/lib/removal/keyColor";
import { HostedErrorText } from "@/cut/components/hostedError";
import { useEditor } from "@/cut/lib/store";
import { playheadAt } from "@/cut/lib/playhead";
import { usePanelView } from "@/cut/lib/panelViews";
import {
  CHROMA_DEFAULT_INTENSITY,
  CHROMA_DEFAULT_SOFTNESS,
  CHROMA_DEFAULT_SPILL,
  paintStrokeInk,
  STROKE_DEFAULT_WIDTH,
  STROKE_OFFSET_MAX,
  STROKE_WIDTH_MAX,
} from "@donkeycut/effects-kit";
import {
  removalActive,
  removalFingerprint,
  STROKE_STYLE_LABELS,
  STROKE_STYLES,
  type ClipRemoval,
  type RemovalMode,
  type StrokeStyleId,
  type VideoClip,
} from "@/cut/lib/types";
import { ColorField } from "@/cut/components/ColorField";
import { Row, useSliderCheckpoint } from "@/cut/components/panelBits";
import { parseNumberInput } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * The clip panel's Cutout view: labeled inspector rows. Layer picks what the
 * rows below edit — Removal (the mode and its controls), Stroke (ink around
 * the kept silhouette), Background (the fill behind it). Removal leads with
 * Auto — most people want the background gone in one pick — and brushing sits
 * underneath as the refinement. Every write lands on the one `clip.removal`
 * field; drafts stream through the transient updater under one checkpoint per
 * gesture, the way the color panel writes its grade.
 */

const LAYERS = [
  { id: "removal", label: "Removal" },
  { id: "stroke", label: "Stroke" },
  { id: "background", label: "Background" },
] as const;
type Layer = (typeof LAYERS)[number]["id"];

const MODES: { id: RemovalMode | "off"; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "custom", label: "Custom" },
  { id: "chroma", label: "Chroma" },
  { id: "off", label: "Off" },
];

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

/** One inspector row: a label and a compact dropdown, the shape every row in
 * this panel shares. */
function RowSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  hook,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (next: T) => void;
  hook: string;
}) {
  return (
    <Row label={label}>
      <Select
        value={value}
        items={Object.fromEntries(options.map((o) => [o.id, o.label]))}
        onValueChange={(v) => onChange(v as T)}
      >
        <SelectTrigger className={`${hook} h-8 w-36 text-[12px]`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id} className={`${hook}-${o.id} text-[12px]`}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

export function RemovalPanel({ clip, onBack }: { clip: VideoClip; onBack: () => void }) {
  // The open layer holds for the session per clip, so leaving the panel and
  // coming back lands on the same rows.
  const [layer, setLayer] = usePanelView<Layer>(`cutout-layer:${clip.id}`, "removal");
  const removal = clip.removal;
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
  const fp =
    removal && (removal.mode === "auto" || removal.mode === "custom")
      ? removalFingerprint(clip.assetId, removal)
      : null;
  useEffect(() => {
    if (fp) ensureMatteBake(clip.id);
  }, [clip.id, fp, clip.in, clip.out]);

  // The brush session follows custom mode while its panel is open.
  useEffect(() => {
    const brush = useBrushUi.getState();
    if (removal?.mode === "custom") brush.open(clip.id);
    else if (brush.clipId === clip.id) brush.close();
    return () => {
      const b = useBrushUi.getState();
      if (b.clipId === clip.id) b.close();
    };
  }, [clip.id, removal?.mode]);

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
        key={layer}
        className="min-h-0 flex-1"
        viewportClassName="overscroll-contain"
        contentClassName="flex flex-col gap-1 px-3.5 pt-1 pb-4"
      >
        <RowSelect
          label="Layer"
          value={layer}
          options={LAYERS}
          onChange={setLayer}
          hook="clip-cutout-layer"
        />
        {layer === "removal" && <RemovalView clip={clip} />}
        {layer === "stroke" && <StrokeView clip={clip} />}
        {layer === "background" && <BackgroundView clip={clip} />}
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
        {layer === "removal" && <RemovalActions clip={clip} />}
      </ScrollArea>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Removal                                                             */
/* ------------------------------------------------------------------ */

/** The suggested key: the live frame when a decoder shows the clip, its own
 * decoded in-point frame otherwise, and green as the visible last resort the
 * user corrects with the eyedropper. */
async function keyColorOf(clip: VideoClip): Promise<string> {
  const live = suggestKeyColor(clip.id);
  if (live) return live;
  const asset = useEditor.getState().assets.find((a) => a.id === clip.assetId);
  return (asset && (await clipKeyColor(asset, clip))) || "#00ff00";
}

/** The Mode row: every layer's entry into the cutout. Stroke and Background
 * render it too while no mode is picked, so the pick happens in place. */
function ModeRow({ clip }: { clip: VideoClip }) {
  const { commit } = useRemovalWriter(clip);
  const removal = clip.removal;
  const mode: RemovalMode | "off" = removal?.mode ?? "off";

  const pickMode = (next: RemovalMode | "off") => {
    if (next === mode) return;
    if (next === "off") {
      commit(undefined);
      return;
    }
    const base: ClipRemoval = { ...removal, mode: next };
    if (next === "chroma" && !base.chroma) {
      // The key defaults to the footage's border color. A clip away from the
      // playhead has no live frame, so its own in-point frame decodes first.
      void keyColorOf(clip).then((color) => commit({ ...base, chroma: { color } }));
      return;
    }
    if (next === "custom" && !base.seeds) base.seeds = { prompts: [] };
    commit(base);
  };

  return (
    <RowSelect
      label="Mode"
      value={mode}
      options={MODES}
      onChange={pickMode}
      hook="clip-removal-mode"
    />
  );
}

function RemovalView({ clip }: { clip: VideoClip }) {
  const { draft, commit } = useRemovalWriter(clip);
  const removal = clip.removal;
  const mode: RemovalMode | "off" = removal?.mode ?? "off";

  return (
    <>
      <ModeRow clip={clip} />
      {mode === "custom" && <CustomControls clip={clip} />}
      {mode === "chroma" && removal?.chroma && (
        <ChromaControls removal={removal} draft={draft} commit={commit} />
      )}
    </>
  );
}

function BakeStatus({ clipId, job }: { clipId: string; job: MatteBakeJob | undefined }) {
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
    <div className="flex items-center gap-2 pt-1 text-[11.5px] text-muted-foreground">
      <Loader2 className="size-3 shrink-0 animate-spin" />
      <span>{job.quality === "hq" ? "Refining the cutout…" : "Preparing the cutout…"}</span>
      <span className="ml-auto font-mono tabular-nums">
        {Math.round(job.progress * 100)}%
        {job.secondsLeft !== undefined && job.etaAt !== undefined && (
          <TickingEta secondsLeft={job.secondsLeft} etaAt={job.etaAt} />
        )}
      </span>
    </div>
  );
}

/** The countdown between progress steps: each estimate ticks down in real
 * time from the moment it was stamped until the next one replaces it. */
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
  // The four tools are two axes: what a stroke does (keep or erase) and how
  // it lands (smart object pick or plain paint).
  const erasing = tool === "erase" || tool === "quickErase";
  const smart = tool === "quick" || tool === "quickErase";
  const pick = (erase: boolean, sm: boolean): BrushTool =>
    sm ? (erase ? "quickErase" : "quick") : erase ? "erase" : "brush";
  // Strokes live on the frames they were drawn on, so after playing away the
  // overlay looks empty — this seeks back to a stroke frame, cycling through
  // them when several frames carry paint.
  const seeds = clip.removal?.seeds;
  const strokeTimes = Array.from(
    new Set([...(seeds?.prompts ?? []), ...(seeds?.paint ?? [])].map((s) => s.t))
  ).sort((a, b) => a - b);
  const showStrokes = () => {
    if (!strokeTimes.length) return;
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const srcNow = clip.in + Math.max(0, playheadAt() - clip.start) * speed;
    const next = strokeTimes.find((t) => t > srcNow + 0.05) ?? strokeTimes[0];
    useEditor.getState().seek(clip.start + (next - clip.in) / speed);
  };
  return (
    <>
      <Row label="Tool">
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
              onClick={() => useBrushUi.getState().setTool(pick(erase, smart))}
            >
              {erase ? "Erase" : "Brush"}
            </button>
          ))}
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "clip-brush-smart grid size-[30px] place-items-center rounded-lg border transition-colors",
                    smart
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : "border-input text-muted-foreground hover:text-foreground"
                  )}
                  aria-pressed={smart}
                  aria-label="Smart select"
                  onClick={() => useBrushUi.getState().setTool(pick(erasing, !smart))}
                >
                  <WandSparkles className="size-3.5" />
                </button>
              }
            />
            <TooltipContent side="bottom">Smart select</TooltipContent>
          </Tooltip>
        </TooltipProvider>
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
      <p className="pt-1 text-[12px] text-muted-foreground">
        Paint on the preview to pick what stays.
      </p>
    </>
  );
}

/** The panel floor: the bake's status line and its actions. The bake runs
 * only from here — Start (auto) or Apply (custom) marks the removal
 * requested, so picking a mode by itself never spends compute. */
function RemovalActions({ clip }: { clip: VideoClip }) {
  const job = useMatteBakes((s) => s.jobs[clip.id]);
  const { commit } = useRemovalWriter(clip);
  const r = clip.removal;
  if (!r || (r.mode !== "auto" && r.mode !== "custom")) return null;
  const custom = r.mode === "custom";
  const hasSelection =
    custom && !!(r.seeds?.prompts.length || r.seeds?.paint?.length || r.subject?.trim());
  const running = job?.status === "running";
  const start = () => {
    commit({ ...r, requested: true });
    if (custom) confirmMatteBake(clip.id);
    else ensureMatteBake(clip.id);
  };
  const showStart = !custom && !r.requested && !running;
  const showCustom = custom && hasSelection && !running;
  return (
    <>
      <BakeStatus clipId={clip.id} job={job} />
      {(showStart || showCustom) && (
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
              custom ? "clip-brush-apply" : "clip-removal-start"
            )}
            onClick={start}
          >
            {custom ? "Apply" : "Start"}
          </button>
        </div>
      )}
    </>
  );
}

function ChromaControls({
  removal,
  draft,
  commit,
}: {
  removal: ClipRemoval;
  draft: (r: ClipRemoval) => void;
  commit: (r: ClipRemoval) => void;
}) {
  const key = removal.chroma!;
  const setKey = (patch: Partial<typeof key>, live?: boolean) =>
    (live ? draft : commit)({ ...removal, chroma: { ...key, ...patch } });
  const pct = (v: number | undefined, fallback: number) => Math.round((v ?? fallback) * 100);
  const slider = (
    label: string,
    field: "intensity" | "softness" | "spill",
    fallback: number
  ) => (
    <Row label={label}>
      <ValueSlider
        label={label}
        sliderClassName={`clip-chroma-${field} data-horizontal:w-24`}
        valueClassName="w-9 text-muted-foreground"
        value={pct(key[field], fallback)}
        min={0}
        max={100}
        step={1}
        format={(v) => `${Math.round(v)}%`}
        parse={parseNumberInput}
        onDraft={(v) => setKey({ [field]: v / 100 }, true)}
        onCommit={(v) => setKey({ [field]: v / 100 })}
      />
    </Row>
  );
  return (
    <>
      <Row label="Key color">
        <ColorField
          value={key.color}
          label="Key color"
          onBegin={() => {}}
          onLive={(hex) => setKey({ color: hex }, true)}
          onCommit={(hex) => setKey({ color: hex })}
        />
      </Row>
      {slider("Intensity", "intensity", CHROMA_DEFAULT_INTENSITY)}
      {slider("Softness", "softness", CHROMA_DEFAULT_SOFTNESS)}
      {slider("Spill", "spill", CHROMA_DEFAULT_SPILL)}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Stroke                                                              */
/* ------------------------------------------------------------------ */

/** A blob silhouette drawn into `ctx`, the stand-in subject the style tiles
 * ink around. */
function paintBlob(ctx: CanvasRenderingContext2D, w: number, h: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.62, w * 0.22, h * 0.3, 0, 0, Math.PI * 2);
  ctx.ellipse(w * 0.5, h * 0.3, w * 0.13, h * 0.17, 0, 0, Math.PI * 2);
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
    paintBlob(sctx, w, h, "#ffffff");
    const ink = document.createElement("canvas");
    ink.width = w;
    ink.height = h;
    const ictx = ink.getContext("2d")!;
    paintStrokeInk(ictx, sil, w, h, { style, color, width: 6 }, 0.6, 1);
    ictx.globalCompositeOperation = "source-in";
    ictx.fillStyle = color;
    ictx.fillRect(0, 0, w, h);
    paintBlob(ctx, w, h, "#52525b");
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(ink, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }, [style, color]);
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        `clip-stroke-${style} flex flex-col items-center gap-1 rounded-lg border p-1.5 pb-1 text-[10.5px] font-medium transition-colors`,
        selected
          ? "border-neutral-900 text-foreground"
          : "border-input text-muted-foreground hover:text-foreground"
      )}
      onClick={onPick}
    >
      <canvas ref={ref} width={96} height={64} className="w-full rounded bg-neutral-950/90" />
      {STROKE_STYLE_LABELS[style]}
    </button>
  );
}

function StrokeView({ clip }: { clip: VideoClip }) {
  const { draft, commit } = useRemovalWriter(clip);
  const removal = clip.removal;
  if (!removal)
    return (
      <>
        <ModeRow clip={clip} />
        <p className="pt-1 text-[12px] text-muted-foreground">
          The stroke draws around what the cutout keeps.
        </p>
      </>
    );
  const stroke = removal.stroke;
  const color = stroke?.color ?? "#ffffff";
  const setStroke = (patch: Partial<NonNullable<typeof stroke>>, live?: boolean) =>
    (live ? draft : commit)({
      ...removal,
      stroke: { style: stroke?.style ?? "solid", color, ...stroke, ...patch },
    });
  return (
    <>
      <div className="grid grid-cols-3 gap-1.5 pt-1">
        <button
          type="button"
          aria-pressed={!stroke}
          className={cn(
            "clip-stroke-none flex flex-col items-center justify-center gap-1 rounded-lg border p-1.5 pb-1 text-[10.5px] font-medium transition-colors",
            !stroke
              ? "border-neutral-900 text-foreground"
              : "border-input text-muted-foreground hover:text-foreground"
          )}
          onClick={() => commit({ ...removal, stroke: undefined })}
        >
          <span className="grid aspect-[3/2] w-full place-items-center rounded bg-neutral-950/90 text-neutral-500">
            <Ban className="size-4" />
          </span>
          None
        </button>
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

function BackgroundView({ clip }: { clip: VideoClip }) {
  const { draft, commit } = useRemovalWriter(clip);
  const removal = clip.removal;
  const assets = useEditor((s) => s.assets);
  const images = assets.filter((a) => a.type === "image" && !a.origin);
  if (!removal)
    return (
      <>
        <ModeRow clip={clip} />
        <p className="pt-1 text-[12px] text-muted-foreground">
          The background fills the area the cutout removes.
        </p>
      </>
    );
  const backdrop = removal.backdrop;
  const kind = backdrop?.kind ?? "none";
  const setBackdrop = (b: ClipRemoval["backdrop"], live?: boolean) =>
    (live ? draft : commit)({ ...removal, backdrop: b });
  const pill = (id: "none" | "color" | "image", label: string) => (
    <button
      key={id}
      type="button"
      className={cn(
        `clip-backdrop-${id} relative flex-1 rounded-md px-1.5 py-1 transition-colors`,
        kind === id ? "bg-neutral-900 text-white" : "text-muted-foreground hover:text-foreground"
      )}
      onClick={() =>
        setBackdrop(
          id === "none"
            ? undefined
            : id === "color"
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
        {pill("none", "None")}
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
          <RowSelect
            label="Image"
            value={backdrop?.assetId ?? images[0].id}
            options={images.map((a) => ({ id: a.id, label: a.name }))}
            onChange={(id) => setBackdrop({ kind: "image", assetId: id })}
            hook="clip-backdrop-image"
          />
        ))}
    </>
  );
}
