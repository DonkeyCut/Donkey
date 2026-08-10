"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, Bold, ChevronLeft, ChevronRight, Diamond, Info, Italic, RotateCcw, SlidersHorizontal, Smile, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmojiPicker } from "@/cut/components/EmojiPicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Textarea } from "@/components/ui/textarea";
import {
  EFFECT_LABELS,
  hasMaskKeys,
  hasOverlayKeys,
  KEY_EPSILON,
  keyIndexAt,
  lineLikeShape,
  maskFrameAt,
  poseAt,
  type Mask,
  type MaskKey,
  type MaskKind,
  type OverlayKey,
  OVERLAY_ANIM_DEFAULT_SECONDS,
  OVERLAY_ANIM_MAX_SECONDS,
  OVERLAY_ANIM_MIN_SECONDS,
  ZOOM_LEVELS,
  ZOOM_RAMP_MAX,
  zoomRampOf,
  type OverlayAnim,
  type OverlayAnimStyle,
  type OverlayLoopStyle,
} from "@donkeycut/effects-kit";
import { clipWindow, useEditor, type EditorState } from "@/cut/lib/store";
import { clipKeyed, clipPoseAt } from "@/cut/lib/types";
import { AnimationTiles } from "@/cut/components/AnimationTiles";
import { GenerateSubtitlesAudio } from "@/cut/components/VoicePicker";
import {
  parseNumberInput,
  parsePercentInput,
  parseSecondsInput,
  parseSpeedInput,
  parseTimeInput,
  ScrubValue,
} from "@/cut/components/ScrubValue";
import { PLATE_COLOR, PLATE_OPACITY, PLATE_RADIUS, plateFill } from "@/cut/lib/textRender";
import {
  deleteStylePreset,
  listStylePresets,
  saveStylePreset,
  type StylePreset,
} from "@/cut/lib/stylePresets";
import { writeTextStyle } from "@/cut/lib/textStyle";
import { formatTime } from "@/cut/lib/time";
import {
  allFonts,
  fontStack,
  frameOf,
  GRADE_HUE_MAX,
  GRADE_MAX,
  isEffectOverlay,
  isShapeOverlay,
  isTextOverlay,
  LAYOUTS,
  onFontsChanged,
  rectOf,
  regionLabel,
  SHAPE_LABELS,
  SPEED_FLOOR,
  SPEED_MAX,
  SPEED_MIN,
  clampOverlayPos,
  type AudioClip,
  type ColorGrade,
  type FrameRect,
  type LayoutId,
  type EffectOverlay,
  type Overlay,
  type ShapeOverlay,
  type StickerOverlay,
  type TextOverlay,
  type VideoClip,
} from "@/cut/lib/types";
import { autoGradeFromImageData, isNeutralGrade, normalizeGrade } from "@donkeycut/effects-kit";
import { getPreviewCanvas, sampleClipFrameData } from "@/cut/lib/previewCanvas";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

const SWATCHES = ["#FFFFFF", "#111114", "#FFD60A", "#FF375F", "#0A84FF", "#30D158"];

/** Last three custom colors picked with the eyedropper, newest first. */
const RECENT_COLORS_KEY = "cut-recent-colors";

/**
 * One undo checkpoint per slider drag: capture the pre-drag state on the first
 * change, then feed live changes through the transient updater so the whole
 * drag collapses to a single ⌘Z. Reset when the interaction commits.
 */
function useSliderCheckpoint() {
  const active = useRef(false);
  return {
    begin() {
      if (active.current) return;
      active.current = true;
      useEditor.getState().pushHistory();
    },
    end() {
      active.current = false;
    },
  };
}

function readRecentColors(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 3) : [];
  } catch {
    return [];
  }
}

/** Preset swatches, recent custom colors, and an eyedropper. `onBegin` marks
 * an undo checkpoint, `onLive` streams the drag, `onCommit` sets a final pick. */
function ColorSwatches({
  value,
  onBegin,
  onLive,
  onCommit,
}: {
  value: string;
  onBegin: () => void;
  onLive: (c: string) => void;
  onCommit: (c: string) => void;
}) {
  const [recents, setRecents] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : readRecentColors()
  );

  const recordRecent = (c: string) => {
    if (SWATCHES.some((s) => s.toUpperCase() === c.toUpperCase())) return;
    const next = [c, ...recents.filter((r) => r.toUpperCase() !== c.toUpperCase())].slice(0, 3);
    setRecents(next);
    try {
      localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next));
    } catch {
      // Storage full/blocked — recents just won't persist.
    }
  };

  return (
    <div className="flex max-w-44 flex-wrap items-center justify-end gap-1.5">
      {[...SWATCHES, ...recents].map((c) => (
        <button
          key={c}
          title={c}
          aria-label={`Color ${c}`}
          className={cn(
            "size-5 rounded-full border border-black/15 transition-transform hover:scale-110",
            value.toUpperCase() === c.toUpperCase() &&
              "ring-2 ring-primary ring-offset-2 ring-offset-card"
          )}
          style={{ background: c }}
          onClick={() => onCommit(c)}
        />
      ))}
      <label
        title="Custom color"
        className="color-picker-well relative size-5 cursor-pointer rounded-full border border-black/15 bg-[conic-gradient(from_0deg,#f43f5e,#f59e0b,#84cc16,#06b6d4,#6366f1,#d946ef,#f43f5e)] transition-transform hover:scale-110"
      >
        <span className="absolute inset-1 rounded-full bg-card" />
        <span className="absolute inset-[5px] rounded-full" style={{ background: value }} />
        <input
          type="color"
          aria-label="Pick a custom color"
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff"}
          onFocus={onBegin}
          onChange={(e) => onLive(e.target.value)}
          onBlur={() => recordRecent(value)}
        />
      </label>
    </div>
  );
}

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const clip = useEditor((s) =>
    selection?.kind === "clip" ? s.clips.find((c) => c.id === selection.id) : undefined
  );
  const audio = useEditor((s) =>
    selection?.kind === "audio" ? s.audioClips.find((c) => c.id === selection.id) : undefined
  );
  const overlay = useEditor((s) =>
    selection?.kind === "overlay" ? s.overlays.find((o) => o.id === selection.id) : undefined
  );

  return (
    <ScrollArea
      render={<aside />}
      className="flex min-h-0 flex-col border-l border-border bg-card"
    >
      {clip ? (
        <ClipPanel key={clip.id} clip={clip} />
      ) : audio ? (
        <AudioPanel key={audio.id} clip={audio} />
      ) : overlay ? (
        isTextOverlay(overlay) ? (
          <TextPanel key={overlay.id} overlay={overlay} />
        ) : isShapeOverlay(overlay) ? (
          <ShapePanel key={overlay.id} overlay={overlay} />
        ) : isEffectOverlay(overlay) ? (
          <EffectPanel key={overlay.id} overlay={overlay} />
        ) : (
          <StickerPanel key={overlay.id} overlay={overlay} />
        )
      ) : null}
    </ScrollArea>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center px-3.5 text-sm font-semibold tracking-tight">
      {children}
    </div>
  );
}

/** One-line header for a media clip's panel: the file name (ellipsised, with
 * the full name in its hover tooltip) and the clip's running length. */
function ClipHead({ name, time }: { name?: string; time: string }) {
  return (
    <div className="mb-1.5 flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border">
      <div className="min-w-0 truncate text-sm font-semibold tracking-tight" title={name}>
        {name}
      </div>
      <Value className="shrink-0 text-muted-foreground">{time}</Value>
    </div>
  );
}

function Row({
  label,
  info,
  grow,
  children,
}: {
  label: string;
  /** Hoverable (i) after the label explaining what the control does. */
  info?: React.ReactNode;
  /** Stretch the control over the row's free width; the default hugs the
   * control to the right edge at its own size. */
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-2.5">
      <span className="flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground">
        {label}
        {info && <InfoTip label={label}>{info}</InfoTip>}
      </span>
      <div className={cn("flex min-w-0 items-center gap-2", grow && "grow")}>{children}</div>
    </div>
  );
}

/** Hoverable (i) explaining the control it follows. */
function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          className="grid size-4 place-items-center text-muted-foreground/70 transition-colors hover:text-foreground"
          aria-label={`About ${label.toLowerCase()}`}
        >
          <Info className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-60">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * A named group of rows under a hairline. A section that owns a feature carries
 * the switch that turns it on and holds its rows back until it is, so the panel
 * reads as a short list of what the element actually has and grows only where
 * it was asked to. Pass no `onEnabledChange` for a group that is always open.
 */
function Section({
  title,
  info,
  enabled,
  onEnabledChange,
  aside,
  children,
}: {
  title: string;
  info?: React.ReactNode;
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  /** Controls that belong to the group as a whole, sat at the end of its title. */
  aside?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const gated = !!onEnabledChange;
  return (
    <section className="mt-1.5 border-t border-border pt-1.5">
      <div className="flex min-h-9 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-[13px] font-medium">
          <span className="truncate">{title}</span>
          {info && <InfoTip label={title}>{info}</InfoTip>}
        </span>
        {aside}
        {gated && (
          <Switch checked={!!enabled} onCheckedChange={onEnabledChange} aria-label={title} />
        )}
      </div>
      {(!gated || enabled) && children}
    </section>
  );
}

const Value = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn("font-mono text-[11.5px] tabular-nums", className)}>{children}</span>
);

/** Matches the store's MIN_LEN: the shortest a trim can leave a clip. */
const MIN_TRIM = 0.1;

/** Sits at the right end of a row, visible once its value has moved off the
 * default. Always occupies its slot so the row doesn't shift when it appears. */
function ResetButton({ title, show, onClick }: { title: string; show: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-hidden={!show}
      tabIndex={show ? undefined : -1}
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground",
        !show && "invisible",
      )}
      onClick={onClick}
    >
      <RotateCcw className="size-3" />
    </button>
  );
}

const formatSpeed = (v: number) => `${v.toFixed(2)}×`;
const formatPercent = (v: number) => `${Math.round(v * 100)}%`;

/** One-click frame layouts (Full / Top / Bottom / Left / Right / PiP) shared by
 * the video-clip and overlay-clip panels. Picking one regions the clip so two
 * videos can share the frame; "Full" clears the region. */
function LayoutButtons({
  rect,
  onPick,
}: {
  rect: FrameRect;
  onPick: (frame: FrameRect | undefined, fit: "fit" | "fill") => void;
}) {
  const currentId =
    (Object.keys(LAYOUTS) as LayoutId[]).find((id) => LAYOUTS[id].label === regionLabel(rect)) ??
    "full";
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-[11.5px] font-medium text-muted-foreground">Layout</span>
      <Select
        value={currentId}
        items={Object.fromEntries((Object.keys(LAYOUTS) as LayoutId[]).map((id) => [id, LAYOUTS[id].label]))}
        onValueChange={(id) => {
          const L = LAYOUTS[id as LayoutId];
          onPick(id === "full" ? undefined : { ...L.rect }, L.fit);
        }}
      >
        <SelectTrigger className="h-8 w-36 text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(LAYOUTS) as LayoutId[]).map((id) => (
            <SelectItem key={id} value={id} className="text-[12px]">
              {LAYOUTS[id].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ClipPanel({ clip }: { clip: VideoClip }) {
  const asset = useEditor((s) => s.assets.find((a) => a.id === clip.assetId));
  const updateClip = useEditor((s) => s.updateClip);
  const [speedDraft, setSpeedDraft] = useState<number | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  // The panel can push into the color-grade subview, which remembers which
  // clip opened it, so selecting another clip lands back on the main view.
  const [colorFor, setColorFor] = useState<string | null>(null);
  const view = colorFor === clip.id ? "color" : "main";
  const volume = volumeDraft ?? clip.volume ?? 1;
  const speed = speedDraft ?? clip.speed ?? 1;
  const speedLen = (clip.out - clip.in) / (speed > 0 ? speed : 1);
  // Typing can trim out to the source's end but no further; an image has no
  // intrinsic duration, so its clip can be any length.
  const maxOut = asset && asset.type !== "image" ? asset.duration : Infinity;
  if (view === "color") {
    return <ColorPanel clip={clip} onBack={() => setColorFor(null)} />;
  }
  return (
    <>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <ClipHead name={asset?.name} time={formatTime(speedLen)} />
        <Row label="Trim">
          <ScrubValue
            label="Trim start"
            value={clip.in}
            min={0}
            max={clip.out - MIN_TRIM}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => useEditor.getState().setClipTrim(clip.id, v, clip.out)}
          />
          <Value className="text-muted-foreground">–</Value>
          <ScrubValue
            label="Trim end"
            value={clip.out}
            min={clip.in + MIN_TRIM}
            max={maxOut}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => useEditor.getState().setClipTrim(clip.id, clip.in, v)}
          />
          <ResetButton
            title="Reset trim"
            show={Number.isFinite(maxOut) && (clip.in > 1e-3 || clip.out < maxOut - 1e-3)}
            onClick={() => useEditor.getState().setClipTrim(clip.id, 0, maxOut)}
          />
        </Row>
        <Row label="Starts at">
          <ScrubValue
            label="Starts at"
            value={clip.start}
            min={0}
            max={Infinity}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => {
              updateClip(clip.id, { start: Math.max(0, v) });
              useEditor.getState().sortClips();
            }}
          />
        </Row>
        <Row label="Speed">
          <Slider
            className="clip-speed data-horizontal:w-24"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.05}
            value={speed}
            onValueChange={(v) => setSpeedDraft(Number(v))}
            onValueCommitted={() => {
              if (speedDraft != null) useEditor.getState().setClipSpeed(clip.id, speedDraft);
              setSpeedDraft(null);
            }}
          />
          <ScrubValue
            label="Speed"
            className="w-9 text-muted-foreground"
            value={speed}
            min={SPEED_FLOOR}
            max={Infinity}
            step={0.05}
            format={formatSpeed}
            parse={parseSpeedInput}
            onScrub={setSpeedDraft}
            onCommit={(v) => {
              useEditor.getState().setClipSpeed(clip.id, v);
              setSpeedDraft(null);
            }}
          />
          <ResetButton
            title="Reset speed"
            show={Math.abs(speed - 1) > 1e-4}
            onClick={() => {
              useEditor.getState().setClipSpeed(clip.id, 1);
              setSpeedDraft(null);
            }}
          />
        </Row>
        <Row label="Color">
          <button
            type="button"
            className="clip-color flex h-8 w-[8.5rem] items-center justify-between rounded-md border border-input px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setColorFor(clip.id)}
          >
            <span className="flex items-center gap-1.5">
              <SlidersHorizontal className="size-3.5" />
              Adjust
              {!isNeutralGrade(clip.grade) && (
                <span className="size-1.5 rounded-full bg-violet-500" aria-label="Adjusted" />
              )}
            </span>
            <ChevronRight className="size-3.5" />
          </button>
        </Row>

        {/* Audio */}
        <div className="my-1.5 h-px bg-border" />
        <Row label="Clip volume">
          <Slider
            className="clip-volume data-horizontal:w-24"
            min={0}
            max={1.5}
            step={0.05}
            value={volume}
            onValueChange={(v) => setVolumeDraft(Number(v))}
            onValueCommitted={() => {
              if (volumeDraft != null) {
                updateClip(clip.id, { volume: volumeDraft === 1 ? undefined : volumeDraft });
              }
              setVolumeDraft(null);
            }}
          />
          <ScrubValue
            label="Clip volume"
            className="w-9 text-muted-foreground"
            value={volume}
            min={0}
            max={1.5}
            step={0.05}
            format={formatPercent}
            parse={parsePercentInput}
            onScrub={setVolumeDraft}
            onCommit={(v) => {
              updateClip(clip.id, { volume: v === 1 ? undefined : v });
              setVolumeDraft(null);
            }}
          />
        </Row>
        <Row label="Mute audio">
          <Switch
            checked={clip.muted}
            onCheckedChange={(v) => updateClip(clip.id, { muted: v })}
          />
        </Row>

        {/* Picture */}
        <div className="my-1.5 h-px bg-border" />
        <Row label="Hidden">
          <Switch
            checked={!!clip.hidden}
            onCheckedChange={(v) => updateClip(clip.id, { hidden: v })}
          />
        </Row>
        <Row label="Framing">
          <div className="clip-framing flex rounded-lg border border-input p-0.5">
            {(["fit", "fill"] as const).map((mode) => (
              <button
                key={mode}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                  (clip.fit ?? "fit") === mode
                    ? "bg-neutral-900 text-white"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-pressed={(clip.fit ?? "fit") === mode}
                onClick={() => updateClip(clip.id, { fit: mode, panX: 0, panY: 0 })}
              >
                {mode === "fit" ? "Fit" : "Fill"}
              </button>
            ))}
          </div>
        </Row>
        {clip.fit === "fill" && ((clip.panX ?? 0) !== 0 || (clip.panY ?? 0) !== 0) && (
          <Row label="Position">
            <button
              className="clip-recenter rounded-md border border-input px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => updateClip(clip.id, { panX: 0, panY: 0 })}
            >
              Center
            </button>
          </Row>
        )}
        <LayoutButtons
          rect={rectOf(clip)}
          onPick={(frame, fit) => updateClip(clip.id, { frame, fit })}
        />
        <ClipTransformSection clip={clip} />
        <ClipMaskSection clip={clip} />
        <ClipGeneratedAudio clip={clip} />
      </div>
    </>
  );
}

const GRADE_FIELDS: { key: keyof ColorGrade; label: string; max: number }[] = [
  { key: "brightness", label: "Brightness", max: GRADE_MAX },
  { key: "contrast", label: "Contrast", max: GRADE_MAX },
  { key: "saturation", label: "Saturation", max: GRADE_MAX },
  { key: "exposure", label: "Exposure", max: GRADE_MAX },
  { key: "temperature", label: "Temperature", max: GRADE_MAX },
  { key: "hue", label: "Hue", max: GRADE_HUE_MAX },
];

const formatGradeValue = (key: keyof ColorGrade, v: number) =>
  key === "hue" ? `${Math.round(v)}°` : v > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`;

/** The color-grade subview a clip panel pushes into: live histogram over the
 * adjustment sliders. Slider drags stream through the transient updater under
 * one history checkpoint, so the preview follows live and ⌘Z undoes the whole
 * drag. */
function ColorPanel({ clip, onBack }: { clip: VideoClip; onBack: () => void }) {
  const ck = useSliderCheckpoint();
  const updateClip = useEditor((s) => s.updateClip);
  const setField = (key: keyof ColorGrade, v: number) => {
    ck.begin();
    useEditor.getState().updateClipTransient(clip.id, {
      grade: normalizeGrade({ ...clip.grade, [key]: v }),
    });
  };
  // Fit a starting grade from the clip's raw decoder frame (never the graded
  // preview, which would fold the current grade back into the fit); the
  // sliders show the result and stay fully adjustable after.
  const autoGrade = () => {
    const data = sampleClipFrameData(clip.id);
    if (data) updateClip(clip.id, { grade: autoGradeFromImageData(data) });
  };
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1 px-2.5 text-sm font-semibold tracking-tight">
        <button
          type="button"
          aria-label="Back"
          className="clip-color-back grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
          onClick={onBack}
        >
          <ChevronLeft className="size-4" />
        </button>
        Color
        <button
          type="button"
          className="clip-grade-auto ml-auto flex items-center gap-1 rounded-md border border-input px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={autoGrade}
        >
          <Wand2 className="size-3" />
          Auto
        </button>
      </div>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <Histogram />
        {GRADE_FIELDS.map((f) => {
          const value = clip.grade?.[f.key] ?? 0;
          return (
            <Row key={f.key} label={f.label}>
              <Slider
                className={`clip-grade-${f.key} data-horizontal:w-24`}
                min={-f.max}
                max={f.max}
                step={1}
                value={value}
                onValueChange={(v) => setField(f.key, Number(v))}
                onValueCommitted={() => ck.end()}
              />
              <ScrubValue
                label={f.label}
                className="w-9 text-muted-foreground"
                value={value}
                min={-f.max}
                max={f.max}
                step={1}
                format={(v) => formatGradeValue(f.key, v)}
                parse={parseNumberInput}
                onScrub={(v) => setField(f.key, v)}
                onCommit={(v) => {
                  setField(f.key, v);
                  ck.end();
                }}
              />
              <ResetButton
                title={`Reset ${f.label.toLowerCase()}`}
                show={value !== 0}
                onClick={() => {
                  setField(f.key, 0);
                  ck.end();
                }}
              />
            </Row>
          );
        })}
        {!isNeutralGrade(clip.grade) && (
          <Button
            variant="outline"
            size="sm"
            className="clip-grade-reset mt-2"
            onClick={() => updateClip(clip.id, { grade: undefined })}
          >
            Reset all
          </Button>
        )}
      </div>
    </>
  );
}

/** Live RGB histogram of the composited preview frame: the three channel
 * curves screen over each other so overlaps read light. Samples a small
 * downscale of the preview canvas on a short interval while open. */
function Histogram() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const sample = document.createElement("canvas");
    sample.width = 96;
    sample.height = 54;
    const sctx = sample.getContext("2d", { willReadFrequently: true });
    if (!sctx) return;
    const BINS = 64;
    const COLORS = ["#ff453a", "#32d74b", "#0a84ff"];
    const draw = () => {
      const src = getPreviewCanvas();
      if (!src) return;
      let data: Uint8ClampedArray;
      try {
        sctx.drawImage(src, 0, 0, sample.width, sample.height);
        data = sctx.getImageData(0, 0, sample.width, sample.height).data;
      } catch {
        return; // unreadable canvas — keep whatever is drawn
      }
      const bins = [new Float64Array(BINS), new Float64Array(BINS), new Float64Array(BINS)];
      for (let i = 0; i < data.length; i += 4) {
        bins[0][data[i] >> 2]++;
        bins[1][data[i + 1] >> 2]++;
        bins[2][data[i + 2] >> 2]++;
      }
      const W = cv.width;
      const H = cv.height;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#101014";
      ctx.fillRect(0, 0, W, H);
      const peak = Math.max(1, ...bins.map((b) => Math.max(...b)));
      ctx.globalCompositeOperation = "screen";
      bins.forEach((b, ci) => {
        ctx.fillStyle = COLORS[ci];
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let i = 0; i < BINS; i++) {
          // sqrt tames the peaks so midtone shape stays visible.
          ctx.lineTo((i / (BINS - 1)) * W, H - Math.sqrt(b[i] / peak) * (H - 3));
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fill();
      });
      ctx.globalCompositeOperation = "source-over";
    };
    draw();
    const id = setInterval(draw, 150);
    return () => clearInterval(id);
  }, []);
  return <canvas ref={ref} width={256} height={80} className="mb-1.5 h-20 w-full rounded-md" />;
}

/** Per-clip generated-audio block: the voice picker, "Generate audio for clip"
 * (which transcribes just this clip when it has no cues yet), and one volume
 * slider driving the voiceovers laid over the clip. Shared by every clip
 * panel on any track. */
function ClipGeneratedAudio({ clip }: { clip: VideoClip }) {
  // Subtitle cues overlapping this clip's timeline span, for the per-clip
  // readout. A selector rather than a snapshot so the generate button reads
  // fresh ids after it auto-transcribes the cut.
  const selectClipCueIds = useCallback(
    (s: EditorState) => {
      const sp = clipWindow(s.clips, s.assets, clip.id);
      if (!sp) return [];
      return s.subtitles.cues
        .filter((c) => c.text.trim() && c.end > sp.start && c.start < sp.start + sp.len)
        .map((c) => c.id);
    },
    [clip.id]
  );
  const ensureClipCues = useCallback(
    () => useEditor.getState().generateClipSubtitles(clip.id),
    [clip.id]
  );
  // Generated voiceover clips overlapping this clip's span — the "Generated
  // audio" slider drives them all, so clip sound and voiceover balance from one
  // panel. Same joined-string trick as the cue ids for reference stability.
  const [genVolDraft, setGenVolDraft] = useState<number | null>(null);
  const genCk = useSliderCheckpoint();
  const genAudioKey = useEditor((s) => {
    const sp = clipWindow(s.clips, s.assets, clip.id);
    if (!sp) return "";
    // AI-voice audio regardless of where it was made: the Audio panel tags
    // voiceovers, the chat tags its own — both are voice over this clip.
    const voiceAssets = new Set(
      s.assets
        .filter((a) => a.origin === "voiceover" || (a.origin === "chat" && a.type === "audio"))
        .map((a) => a.id)
    );
    return s.audioClips
      .filter((a) => {
        const len = (a.out - a.in) / (a.speed && a.speed > 0 ? a.speed : 1);
        return (
          voiceAssets.has(a.assetId) && a.start < sp.start + sp.len && a.start + len > sp.start
        );
      })
      .map((a) => a.id)
      .join("\n");
  });
  const genAudioIds = useMemo(() => (genAudioKey ? genAudioKey.split("\n") : []), [genAudioKey]);
  const genVolStore = useEditor((s) => {
    const first = s.audioClips.find((a) => a.id === genAudioIds[0]);
    return first ? first.volume : 1;
  });
  const genVol = genVolDraft ?? genVolStore;
  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-border pt-3">
      <GenerateSubtitlesAudio
        selectCueIds={selectClipCueIds}
        ensureCues={ensureClipCues}
        label="Generate audio for clip"
      />
      {genAudioIds.length > 0 && (
        <Row label="Volume">
          <Slider
            className="clip-gen-volume data-horizontal:w-24"
            min={0}
            max={1.5}
            step={0.05}
            value={genVol}
            onValueChange={(v) => {
              genCk.begin();
              setGenVolDraft(Number(v));
              const s = useEditor.getState();
              genAudioIds.forEach((id) => s.updateAudioTransient(id, { volume: Number(v) }));
            }}
            onValueCommitted={() => {
              genCk.end();
              setGenVolDraft(null);
            }}
          />
          <ScrubValue
            label="Generated audio volume"
            className="w-9 text-muted-foreground"
            value={genVol}
            min={0}
            max={1.5}
            step={0.05}
            format={formatPercent}
            parse={parsePercentInput}
            onScrub={(v) => {
              genCk.begin();
              setGenVolDraft(v);
              const s = useEditor.getState();
              genAudioIds.forEach((id) => s.updateAudioTransient(id, { volume: v }));
            }}
            onCommit={(v) => {
              genCk.begin();
              const s = useEditor.getState();
              genAudioIds.forEach((id) => s.updateAudioTransient(id, { volume: v }));
              genCk.end();
              setGenVolDraft(null);
            }}
          />
        </Row>
      )}
    </div>
  );
}

function AudioPanel({ clip }: { clip: AudioClip }) {
  const asset = useEditor((s) => s.assets.find((a) => a.id === clip.assetId));
  const updateAudioTransient = useEditor((s) => s.updateAudioTransient);
  const ck = useSliderCheckpoint();
  const setAudio = (patch: Partial<AudioClip>) => {
    ck.begin();
    updateAudioTransient(clip.id, patch);
  };
  // Detached audio can carry a playback rate; its timeline length is (out-in)/speed.
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const len = (clip.out - clip.in) / speed;
  // A fade can take at most half the clip so in+out never overlap.
  const maxFade = Math.max(0.1, Math.round((len / 2) * 10) / 10);
  // Commit closes the checkpoint setAudio opened (or opens+closes one for a
  // typed entry), so any adjustment lands as a single undo step.
  const commitAudio = (patch: Partial<AudioClip>) => {
    setAudio(patch);
    ck.end();
  };
  return (
    <>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <ClipHead name={asset?.name} time={formatTime(len)} />
        <Row label="Trim">
          <ScrubValue
            label="Trim start"
            value={clip.in}
            min={0}
            max={clip.out - MIN_TRIM}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => commitAudio({ in: v })}
          />
          <Value className="text-muted-foreground">–</Value>
          <ScrubValue
            label="Trim end"
            value={clip.out}
            min={clip.in + MIN_TRIM}
            max={asset?.duration ?? clip.out}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => commitAudio({ out: v })}
          />
          <ResetButton
            title="Reset trim"
            show={!!asset && (clip.in > 1e-3 || clip.out < asset.duration - 1e-3)}
            onClick={() => asset && commitAudio({ in: 0, out: asset.duration })}
          />
        </Row>
        <Row label="Starts at">
          <ScrubValue
            label="Starts at"
            value={clip.start}
            min={0}
            max={Infinity}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => commitAudio({ start: v })}
          />
        </Row>
        <Row label="Speed">
          <Slider
            className="audio-speed data-horizontal:w-24"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.05}
            value={speed}
            onValueChange={(v) => {
              const n = Number(v);
              setAudio({ speed: Math.abs(n - 1) < 1e-4 ? undefined : n });
            }}
            onValueCommitted={ck.end}
          />
          <ScrubValue
            label="Speed"
            className="w-9 text-muted-foreground"
            value={speed}
            min={SPEED_FLOOR}
            max={Infinity}
            step={0.05}
            format={formatSpeed}
            parse={parseSpeedInput}
            onScrub={(v) => setAudio({ speed: Math.abs(v - 1) < 1e-4 ? undefined : v })}
            onCommit={(v) => commitAudio({ speed: Math.abs(v - 1) < 1e-4 ? undefined : v })}
          />
          <ResetButton
            title="Reset speed"
            show={Math.abs(speed - 1) > 1e-4}
            onClick={() => commitAudio({ speed: undefined })}
          />
        </Row>
        <Row label="Volume">
          <Slider
            className="data-horizontal:w-24"
            min={0}
            max={1.5}
            step={0.05}
            value={clip.volume}
            onValueChange={(v) => setAudio({ volume: Number(v) })}
            onValueCommitted={ck.end}
          />
          <ScrubValue
            label="Volume"
            className="w-9 text-muted-foreground"
            value={clip.volume}
            min={0}
            max={1.5}
            step={0.05}
            format={formatPercent}
            parse={parsePercentInput}
            onScrub={(v) => setAudio({ volume: v })}
            onCommit={(v) => commitAudio({ volume: v })}
          />
        </Row>
        <Row label="Fade in">
          <Slider
            className="fade-in-slider data-horizontal:w-24"
            min={0}
            max={maxFade}
            step={0.1}
            value={clip.fadeIn ?? 0}
            onValueChange={(v) => setAudio({ fadeIn: Number(v) })}
            onValueCommitted={ck.end}
          />
          <ScrubValue
            label="Fade in"
            className="w-9 text-muted-foreground"
            value={clip.fadeIn ?? 0}
            min={0}
            max={maxFade}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            parse={parseSecondsInput}
            onScrub={(v) => setAudio({ fadeIn: v })}
            onCommit={(v) => commitAudio({ fadeIn: v })}
          />
        </Row>
        <Row label="Fade out">
          <Slider
            className="fade-out-slider data-horizontal:w-24"
            min={0}
            max={maxFade}
            step={0.1}
            value={clip.fadeOut ?? 0}
            onValueChange={(v) => setAudio({ fadeOut: Number(v) })}
            onValueCommitted={ck.end}
          />
          <ScrubValue
            label="Fade out"
            className="w-9 text-muted-foreground"
            value={clip.fadeOut ?? 0}
            min={0}
            max={maxFade}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            parse={parseSecondsInput}
            onScrub={(v) => setAudio({ fadeOut: v })}
            onCommit={(v) => commitAudio({ fadeOut: v })}
          />
        </Row>
        <Row
          label="Duck others"
          info={
            clip.duck !== undefined
              ? `While this clip plays, everything else drops to ${Math.round(clip.duck * 100)}% volume.`
              : "While this clip plays, drop everything else to this volume."
          }
        >
          <Slider
            className="duck-slider data-horizontal:w-24"
            min={0}
            max={1}
            step={0.05}
            value={clip.duck ?? 1}
            onValueChange={(v) => {
              const n = Number(v);
              setAudio({ duck: n < 0.999 ? n : undefined });
            }}
            onValueCommitted={ck.end}
          />
          <ScrubValue
            label="Duck others"
            className="w-9 text-muted-foreground"
            value={clip.duck ?? 1}
            min={0}
            max={1}
            step={0.05}
            format={(v) => (v >= 0.999 ? "Off" : formatPercent(v))}
            parse={(raw) => (raw.trim().toLowerCase() === "off" ? 1 : parsePercentInput(raw))}
            onScrub={(v) => setAudio({ duck: v < 0.999 ? v : undefined })}
            onCommit={(v) => commitAudio({ duck: v < 0.999 ? v : undefined })}
          />
        </Row>
        <Row label="Hidden">
          <Switch
            checked={!!clip.hidden}
            onCheckedChange={(v) => useEditor.getState().updateAudio(clip.id, { hidden: v })}
          />
        </Row>
      </div>
    </>
  );
}

function TextPanel({ overlay: o }: { overlay: TextOverlay }) {
  const update = useEditor((s) => s.updateOverlay);
  const sizeCk = useSliderCheckpoint();
  const radiusCk = useSliderCheckpoint();
  const opacityCk = useSliderCheckpoint();
  const spacingCk = useSliderCheckpoint();
  const lineHeightCk = useSliderCheckpoint();
  const strokeCk = useSliderCheckpoint();
  const shadowCk = useSliderCheckpoint();
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The font menu re-reads the registry when Google families finish
  // registering or an uploaded font lands (the bump re-renders, and the
  // render re-reads allFonts()).
  const [, bumpFonts] = useState(0);
  useEffect(() => onFontsChanged(() => bumpFonts((n) => n + 1)), []);
  const fonts = allFonts();

  // Remember this title's look across clips and projects, so the next new title
  // starts from the same style.
  useEffect(() => {
    writeTextStyle({
      size: o.size,
      font: o.font,
      weight: o.weight,
      italic: o.italic,
      color: o.color,
      stroke: o.stroke,
      letterSpacing: o.letterSpacing,
      lineHeight: o.lineHeight,
      align: o.align,
      shadow: o.shadow,
      plate: o.plate,
      plateColor: o.plateColor,
      plateOpacity: o.plateOpacity,
      plateRadius: o.plateRadius,
    });
  }, [o.size, o.font, o.weight, o.italic, o.color, o.stroke, o.letterSpacing, o.lineHeight, o.align, o.shadow, o.plate, o.plateColor, o.plateOpacity, o.plateRadius]);

  const insertEmoji = (emoji: string) => {
    const ta = taRef.current;
    const s = useEditor.getState();
    s.pushHistory();
    const start = ta?.selectionStart ?? o.text.length;
    const end = ta?.selectionEnd ?? start;
    const next = o.text.slice(0, start) + emoji + o.text.slice(end);
    s.updateOverlayTransient(o.id, { text: next });
    // Advance the caret for the next insert without pulling focus off the
    // picker, so several emoji can be tapped in a row. The selection sticks to
    // the textarea even while it's unfocused.
    requestAnimationFrame(() => ta?.setSelectionRange(start + emoji.length, start + emoji.length));
  };

  return (
    <>
      <PanelTitle>Text</PanelTitle>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <div className="relative mb-2">
          <Textarea
            ref={taRef}
            className="min-h-16 select-text pr-9"
            rows={3}
            value={o.text}
            onChange={(e) =>
              useEditor.getState().updateOverlayTransient(o.id, { text: e.target.value })
            }
            onFocus={() => useEditor.getState().pushHistory()}
          />
          <EmojiPicker
            onPick={insertEmoji}
            trigger={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Insert emoji"
                title="Insert emoji"
                className="absolute top-1.5 right-1.5 text-muted-foreground"
              >
                <Smile />
              </Button>
            }
          />
        </div>
        <StylePresetsRow overlay={o} />
        <Row label="Font">
          <Select
            value={o.font}
            items={Object.fromEntries(fonts.map((f) => [f.id, f.label]))}
            onValueChange={(v) => update(o.id, { font: v as TextOverlay["font"] })}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fonts.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  <span style={{ fontFamily: f.stack }}>{f.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Bold"
            aria-pressed={o.weight === 700}
            className={cn(o.weight === 700 && "border-primary bg-primary/15 text-primary")}
            onClick={() => update(o.id, { weight: o.weight === 700 ? 400 : 700 })}
          >
            <Bold />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Italic"
            aria-pressed={!!o.italic}
            className={cn(o.italic && "border-primary bg-primary/15 text-primary")}
            onClick={() => update(o.id, { italic: o.italic ? undefined : true })}
          >
            <Italic />
          </Button>
        </Row>
        <Row label="Align">
          {(
            [
              ["left", AlignLeft],
              ["center", AlignCenter],
              ["right", AlignRight],
            ] as const
          ).map(([a, Icon]) => {
            const active = (o.align ?? "center") === a;
            return (
              <Button
                key={a}
                variant="outline"
                size="icon-sm"
                aria-label={`Align ${a}`}
                aria-pressed={active}
                className={cn(active && "border-primary bg-primary/15 text-primary")}
                onClick={() => update(o.id, { align: a === "center" ? undefined : a })}
              >
                <Icon />
              </Button>
            );
          })}
        </Row>
        <Row label="Size">
          <Slider
            className="data-horizontal:w-24"
            min={24}
            max={240}
            value={o.size}
            onValueChange={(v) => {
              sizeCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { size: Number(v) });
            }}
            onValueCommitted={sizeCk.end}
          />
          <ScrubValue
            label="Text size"
            className="w-9 text-muted-foreground"
            value={o.size}
            min={24}
            max={240}
            step={1}
            format={(v) => String(Math.round(v))}
            parse={parseNumberInput}
            onScrub={(v) => {
              sizeCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { size: v });
            }}
            onCommit={(v) => {
              sizeCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { size: v });
              sizeCk.end();
            }}
          />
        </Row>
        <Row label="Color">
          <ColorSwatches
            value={o.color}
            onBegin={() => useEditor.getState().pushHistory()}
            onLive={(c) => useEditor.getState().updateOverlayTransient(o.id, { color: c })}
            onCommit={(c) => update(o.id, { color: c })}
          />
        </Row>
        <Row label="Spacing">
          <Slider
            className="data-horizontal:w-24"
            min={-0.05}
            max={0.3}
            step={0.005}
            value={o.letterSpacing ?? 0}
            onValueChange={(v) => {
              spacingCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, {
                letterSpacing: Math.abs(Number(v)) < 0.0025 ? undefined : Number(v),
              });
            }}
            onValueCommitted={spacingCk.end}
          />
          <Value className="w-9 text-muted-foreground">
            {Math.round((o.letterSpacing ?? 0) * 100)}
          </Value>
        </Row>
        <Row label="Line height">
          <Slider
            className="data-horizontal:w-24"
            min={0.8}
            max={2}
            step={0.05}
            value={o.lineHeight ?? 1.25}
            onValueChange={(v) => {
              lineHeightCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, {
                lineHeight: Math.abs(Number(v) - 1.25) < 0.025 ? undefined : Number(v),
              });
            }}
            onValueCommitted={lineHeightCk.end}
          />
          <Value className="w-9 text-muted-foreground">{(o.lineHeight ?? 1.25).toFixed(2)}</Value>
        </Row>
        <Section
          title="Outline"
          enabled={!!o.stroke}
          onEnabledChange={(v) =>
            update(o.id, { stroke: v ? { color: "#111114", width: 0.04 } : undefined })
          }
        >
          {o.stroke && (
            <>
              <Row label="Color">
                <ColorSwatches
                  value={o.stroke.color}
                  onBegin={() => useEditor.getState().pushHistory()}
                  onLive={(c) =>
                    useEditor.getState().updateOverlayTransient(o.id, {
                      stroke: { ...o.stroke!, color: c },
                    })
                  }
                  onCommit={(c) => update(o.id, { stroke: { ...o.stroke!, color: c } })}
                />
              </Row>
              <Row label="Width">
                <Slider
                  className="data-horizontal:w-24"
                  min={0.01}
                  max={0.15}
                  step={0.005}
                  value={o.stroke.width}
                  onValueChange={(v) => {
                    strokeCk.begin();
                    useEditor.getState().updateOverlayTransient(o.id, {
                      stroke: { ...o.stroke!, width: Number(v) },
                    });
                  }}
                  onValueCommitted={strokeCk.end}
                />
                <Value className="w-9 text-muted-foreground">
                  {Math.round(o.stroke.width * 100)}
                </Value>
              </Row>
            </>
          )}
        </Section>
        <Section
          title="Shadow"
          enabled={!!o.shadow}
          onEnabledChange={(v) => update(o.id, { shadow: v })}
        >
          <>
            <Row label="Color">
              <ColorSwatches
                value={(typeof o.shadow === "object" ? o.shadow.color : undefined) ?? "#000000"}
                onBegin={() => useEditor.getState().pushHistory()}
                onLive={(c) =>
                  useEditor.getState().updateOverlayTransient(o.id, {
                    shadow: { ...(typeof o.shadow === "object" ? o.shadow : {}), color: c },
                  })
                }
                onCommit={(c) =>
                  update(o.id, {
                    shadow: { ...(typeof o.shadow === "object" ? o.shadow : {}), color: c },
                  })
                }
              />
            </Row>
            <Row label="Blur">
              <Slider
                className="data-horizontal:w-24"
                min={0}
                max={60}
                step={1}
                value={(typeof o.shadow === "object" ? o.shadow.blur : undefined) ?? 14}
                onValueChange={(v) => {
                  shadowCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, {
                    shadow: { ...(typeof o.shadow === "object" ? o.shadow : {}), blur: Number(v) },
                  });
                }}
                onValueCommitted={shadowCk.end}
              />
              <Value className="w-9 text-muted-foreground">
                {(typeof o.shadow === "object" ? o.shadow.blur : undefined) ?? 14}
              </Value>
            </Row>
            <Row label="Opacity">
              <Slider
                className="data-horizontal:w-24"
                min={0}
                max={1}
                step={0.01}
                value={(typeof o.shadow === "object" ? o.shadow.opacity : undefined) ?? 0.65}
                onValueChange={(v) => {
                  shadowCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, {
                    shadow: {
                      ...(typeof o.shadow === "object" ? o.shadow : {}),
                      opacity: Number(v),
                    },
                  });
                }}
                onValueCommitted={shadowCk.end}
              />
              <Value className="w-9 text-muted-foreground">
                {Math.round(((typeof o.shadow === "object" ? o.shadow.opacity : undefined) ?? 0.65) * 100)}
              </Value>
            </Row>
          </>
        </Section>
        <Section
          title="Backdrop"
          enabled={o.plate}
          onEnabledChange={(v) => update(o.id, { plate: v })}
        >
          <>
            <Row label="Color">
              <ColorSwatches
                value={o.plateColor ?? PLATE_COLOR}
                onBegin={() => useEditor.getState().pushHistory()}
                onLive={(c) => useEditor.getState().updateOverlayTransient(o.id, { plateColor: c })}
                onCommit={(c) => update(o.id, { plateColor: c })}
              />
            </Row>
            <Row label="Opacity">
              <Slider
                className="data-horizontal:w-24"
                min={0}
                max={1}
                step={0.01}
                value={o.plateOpacity ?? PLATE_OPACITY}
                onValueChange={(v) => {
                  opacityCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, { plateOpacity: Number(v) });
                }}
                onValueCommitted={opacityCk.end}
              />
              <ScrubValue
                label="Backdrop opacity"
                className="w-9 text-muted-foreground"
                value={o.plateOpacity ?? PLATE_OPACITY}
                min={0}
                max={1}
                step={0.01}
                format={(v) => String(Math.round(v * 100))}
                parse={parsePercentInput}
                onScrub={(v) => {
                  opacityCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, { plateOpacity: v });
                }}
                onCommit={(v) => {
                  opacityCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, { plateOpacity: v });
                  opacityCk.end();
                }}
              />
            </Row>
            <Row label="Radius">
              <Slider
                className="data-horizontal:w-24"
                min={0}
                max={1}
                step={0.01}
                value={o.plateRadius ?? PLATE_RADIUS}
                onValueChange={(v) => {
                  radiusCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, { plateRadius: Number(v) });
                }}
                onValueCommitted={radiusCk.end}
              />
              <ScrubValue
                label="Backdrop radius"
                className="w-9 text-muted-foreground"
                value={o.plateRadius ?? PLATE_RADIUS}
                min={0}
                max={1}
                step={0.01}
                format={(v) => String(Math.round(v * 100))}
                parse={parsePercentInput}
                onScrub={(v) => {
                  radiusCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, { plateRadius: v });
                }}
                onCommit={(v) => {
                  radiusCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, { plateRadius: v });
                  radiusCk.end();
                }}
              />
            </Row>
          </>
        </Section>
        <OverlayMaskSection overlay={o} />
        <TransformRows overlay={o} />
        <GroupRow overlay={o} />
        <AnimationRows overlay={o} />
      </div>
    </>
  );
}

/** Named text-style presets from the shared Library: chips that apply a saved
 * look to the selected title, plus saving the current look under a name. */
function StylePresetsRow({ overlay: o }: { overlay: TextOverlay }) {
  const [presets, setPresets] = useState<StylePreset[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    listStylePresets()
      .then((p) => live && setPresets(p))
      .catch(() => live && setPresets([]));
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    const projectId = useEditor.getState().projectId;
    const trimmed = name.trim();
    if (!projectId || !trimmed || busy) return;
    setBusy(true);
    try {
      const p = await saveStylePreset(projectId, trimmed, o);
      if (p) setPresets((prev) => [p, ...(prev ?? [])]);
      setNaming(false);
      setName("");
    } catch {
      // Signed out or offline shelf — the chips just don't gain one.
    } finally {
      setBusy(false);
    }
  };

  if (presets === null) return null;
  return (
    <div className="mb-1.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[13px] text-muted-foreground">Styles</span>
        {!naming && (
          <button
            type="button"
            className="text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setNaming(true)}
          >
            Save style
          </button>
        )}
      </div>
      {naming && (
        <div className="mb-1.5 flex items-center gap-1.5">
          <input
            autoFocus
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus:border-ring"
            placeholder="Style name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <Button size="sm" variant="outline" disabled={busy || !name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <span key={`${p.residency}:${p.id}`} className="group relative">
              <button
                type="button"
                title={`Apply ${p.name}`}
                className="flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-[11.5px] transition-colors hover:border-ring"
                onClick={() => useEditor.getState().updateOverlay(o.id, { ...p.style })}
              >
                <span
                  className="leading-none"
                  style={{
                    fontFamily: fontStack(p.style.font),
                    fontWeight: p.style.weight,
                    fontStyle: p.style.italic ? "italic" : undefined,
                    color: p.style.color,
                    textShadow: p.style.shadow ? "0 1px 2px rgba(0,0,0,0.5)" : undefined,
                    background: p.style.plate ? plateFill(p.style) : undefined,
                    borderRadius: p.style.plate ? 3 : undefined,
                    padding: p.style.plate ? "0 3px" : undefined,
                  }}
                >
                  Aa
                </span>
                {p.name}
              </button>
              <button
                type="button"
                title={`Delete ${p.name}`}
                aria-label={`Delete style ${p.name}`}
                className="absolute -top-1.5 -right-1.5 hidden size-4 place-items-center rounded-full bg-black/60 text-[9px] text-white group-hover:grid"
                onClick={() => {
                  void deleteStylePreset(p).catch(() => {});
                  setPresets((prev) => (prev ?? []).filter((x) => x !== p));
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Preset In / Out / Loop animation, shared by every overlay kind. Neutral
 * (all slots off) stores as absence. */
function AnimationRows({ overlay: o }: { overlay: Overlay }) {
  const lengthCk = useSliderCheckpoint();
  const speedCk = useSliderCheckpoint();
  const anim = o.anim ?? {};
  const dur = Math.max(0.2, o.end - o.start);
  const writeAnim = (patch: Partial<OverlayAnim>) => {
    const next = { ...anim, ...patch };
    if (!next.in) delete next.in;
    if (!next.out) delete next.out;
    if (!next.loop) delete next.loop;
    const value = next.in || next.out || next.loop ? next : undefined;
    // A grouped element's animation stamps the whole group.
    const st = useEditor.getState();
    const peers = o.groupId ? st.overlays.filter((x) => x.groupId === o.groupId) : [];
    const ids = peers.length > 1 ? peers.map((p) => p.id) : [o.id];
    st.updateOverlaysTransient(ids.map((id) => ({ id, patch: { anim: value } })));
  };
  /** A discrete change — its own undo step. */
  const setAnim = (patch: Partial<OverlayAnim>) => {
    useEditor.getState().pushHistory();
    writeAnim(patch);
  };
  /** A drag — one undo step for the whole gesture, not one per frame. */
  const dragAnim = (ck: ReturnType<typeof useSliderCheckpoint>, patch: Partial<OverlayAnim>) => {
    ck.begin();
    writeAnim(patch);
  };
  // In / Out / Loop pick from the same grid, one slot at a time — the tiles
  // are big enough to read the motion, which three stacked grids would not be.
  const [slot, setSlot] = useState<"in" | "out" | "loop">("in");
  const active = anim[slot];
  const seconds =
    slot === "loop" ? undefined : (anim[slot] as OverlayAnim["in"])?.seconds;
  const pick = (style: string | null) => {
    if (!style) return setAnim({ [slot]: undefined });
    if (slot === "loop") {
      setAnim({ loop: { style: style as OverlayLoopStyle, speed: anim.loop?.speed ?? 1 } });
      return;
    }
    setAnim({
      [slot]: {
        style: style as OverlayAnimStyle,
        seconds: seconds ?? OVERLAY_ANIM_DEFAULT_SECONDS,
      },
    });
  };

  return (
    <Section title="Animation">
      <div className="mt-0.5 mb-2 flex shrink-0 rounded-lg bg-muted p-0.5 text-[11.5px] font-medium">
        {(["in", "out", "loop"] as const).map((id) => (
          <button
            key={id}
            type="button"
            className={cn(
              "flex-1 rounded-md px-1.5 py-1 capitalize transition-colors",
              slot === id
                ? "bg-neutral-900 text-white"
                : "text-muted-foreground hover:text-foreground",
              // A dot marks a slot that is already set, so switching tabs is
              // not the only way to see what an element is doing.
              anim[id] && slot !== id && "text-foreground"
            )}
            onClick={() => setSlot(id)}
          >
            {id}
            {anim[id] ? " ●" : ""}
          </button>
        ))}
      </div>
      <AnimationTiles
        slot={slot}
        value={active?.style}
        isText={isTextOverlay(o)}
        onPick={pick}
      />
      {slot !== "loop" && active && (
        <Row label="Length">
          <Slider
            className="data-horizontal:w-24"
            min={OVERLAY_ANIM_MIN_SECONDS}
            max={Math.min(OVERLAY_ANIM_MAX_SECONDS, dur)}
            step={0.05}
            value={seconds ?? OVERLAY_ANIM_DEFAULT_SECONDS}
            onValueChange={(v) =>
              dragAnim(lengthCk, {
                [slot]: { style: active.style as OverlayAnimStyle, seconds: Number(v) },
              })
            }
            onValueCommitted={lengthCk.end}
          />
          <Value className="w-9 text-muted-foreground">
            {(seconds ?? OVERLAY_ANIM_DEFAULT_SECONDS).toFixed(2)}s
          </Value>
        </Row>
      )}
      {slot === "loop" && anim.loop && (
        <Row label="Speed">
          <Slider
            className="data-horizontal:w-24"
            min={0.25}
            max={4}
            step={0.25}
            value={anim.loop.speed}
            onValueChange={(v) =>
              dragAnim(speedCk, { loop: { ...anim.loop!, speed: Number(v) } })
            }
            onValueCommitted={speedCk.end}
          />
          <Value className="w-9 text-muted-foreground">{anim.loop.speed.toFixed(2)}×</Value>
        </Row>
      )}
    </Section>
  );
}

/** Group / Ungroup, shown when the selection can form one or the element is
 * in one. Grouping is shallow by design: select-one-selects-all, and gestures
 * apply member-relative deltas. */
function GroupRow({ overlay: o }: { overlay: Overlay }) {
  const selectedOverlays = useEditor(
    (s) => s.multiSelection.filter((x) => x?.kind === "overlay").length
  );
  if (o.groupId) {
    return (
      <Row label="Group">
        <Button
          size="sm"
          variant="outline"
          onClick={() => useEditor.getState().ungroupOverlays(o.groupId!)}
        >
          Ungroup
        </Button>
      </Row>
    );
  }
  if (selectedOverlays < 2) return null;
  return (
    <Row label="Group">
      <Button size="sm" variant="outline" onClick={() => useEditor.getState().groupSelectedOverlays()}>
        Group {selectedOverlays} elements
      </Button>
    </Row>
  );
}

/** Rotation and opacity, shared by every overlay kind. Neutral values store
 * as absence so untouched elements carry nothing. */
/** The element twin of the clip panels' Hidden row: parked on the timeline,
 * out of the played and exported picture. It closes the Transform section
 * (the effect panel, which has no Transform, mounts it alone), so the
 * timeline chip always has an inspector fallback. */
function HiddenRow({ overlay: o }: { overlay: Overlay }) {
  const update = useEditor((s) => s.updateOverlay);
  return (
    <Row label="Hidden">
      <Switch
        checked={!!o.hidden}
        onCheckedChange={(v) => update(o.id, { hidden: v || undefined })}
      />
    </Row>
  );
}

function TransformRows({ overlay: o }: { overlay: Overlay }) {
  const rotationCk = useSliderCheckpoint();
  const opacityCk = useSliderCheckpoint();
  const scaleCk = useSliderCheckpoint();
  const posCk = useSliderCheckpoint();
  const now = useEditor((s) => s.currentTime);
  // With keys in play these rows edit the pose at the playhead rather than the
  // element's resting fields — which is what makes them a track.
  const keyed = hasOverlayKeys(o);
  const tLocal = localTimeOf(o, now);
  const pose = poseAt(o, tLocal);
  const setKey = (patch: Partial<Omit<OverlayKey, "t">>) =>
    useEditor.getState().setOverlayKey(o.id, tLocal, patch, { transient: true });
  const setRotation = (v: number) => {
    const deg = Math.round(v);
    if (keyed) return setKey({ rotation: deg });
    useEditor.getState().updateOverlayTransient(o.id, { rotation: deg === 0 ? undefined : deg });
  };
  const setOpacity = (v: number) => {
    const a = Math.max(0, Math.min(1, v));
    if (keyed) return setKey({ opacity: a });
    useEditor.getState().updateOverlayTransient(o.id, { opacity: a >= 0.995 ? undefined : a });
  };
  // Position reads as a percentage of the frame, which is what the document
  // stores — an element sits in the same spot at any aspect, and the number
  // means the same thing on a square as on a widescreen.
  const setPos = (axis: "x" | "y", pct: number) => {
    const v = clampOverlayPos(pct / 100);
    if (keyed) return setKey({ [axis]: v });
    useEditor.getState().updateOverlayTransient(o.id, { [axis]: v });
  };
  return (
    <Section title="Transform">
      <KeyframeControls overlay={o} />
      <Row label="Position">
        {(["x", "y"] as const).map((axis) => (
          <span key={axis} className="flex items-center gap-1">
            <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
            <ScrubValue
              label={`${axis.toUpperCase()} position`}
              className="w-9 text-muted-foreground"
              value={pose[axis] * 100}
              min={2}
              max={98}
              step={0.5}
              keyStep={1}
              format={(v) => String(Math.round(v))}
              parse={parseNumberInput}
              onScrub={(v) => {
                posCk.begin();
                setPos(axis, v);
              }}
              onCommit={(v) => {
                posCk.begin();
                setPos(axis, v);
                posCk.end();
              }}
            />
          </span>
        ))}
      </Row>
      {keyed && (
        <Row label="Scale">
          <Slider
            className="data-horizontal:w-24"
            min={0.1}
            max={4}
            step={0.01}
            value={pose.scale}
            onValueChange={(v) => {
              scaleCk.begin();
              setKey({ scale: Number(v) });
            }}
            onValueCommitted={scaleCk.end}
          />
          <Value className="w-9 text-muted-foreground">{Math.round(pose.scale * 100)}%</Value>
        </Row>
      )}
      <Row label="Rotation">
        <Slider
          className="data-horizontal:w-24"
          min={-180}
          max={180}
          step={1}
          value={keyed ? pose.rotation : (o.rotation ?? 0)}
          onValueChange={(v) => {
            rotationCk.begin();
            setRotation(Number(v));
          }}
          onValueCommitted={rotationCk.end}
        />
        <ScrubValue
          label="Rotation"
          className="w-9 text-muted-foreground"
          value={keyed ? pose.rotation : (o.rotation ?? 0)}
          min={-180}
          max={180}
          step={1}
          format={(v) => `${Math.round(v)}°`}
          parse={parseNumberInput}
          onScrub={(v) => {
            rotationCk.begin();
            setRotation(v);
          }}
          onCommit={(v) => {
            rotationCk.begin();
            setRotation(v);
            rotationCk.end();
          }}
        />
      </Row>
      <Row label="Opacity">
        <Slider
          className="data-horizontal:w-24"
          min={0}
          max={1}
          step={0.01}
          value={keyed ? pose.opacity : (o.opacity ?? 1)}
          onValueChange={(v) => {
            opacityCk.begin();
            setOpacity(Number(v));
          }}
          onValueCommitted={opacityCk.end}
        />
        <ScrubValue
          label="Opacity"
          className="w-9 text-muted-foreground"
          value={keyed ? pose.opacity : (o.opacity ?? 1)}
          min={0}
          max={1}
          step={0.01}
          format={(v) => String(Math.round(v * 100))}
          parse={parsePercentInput}
          onScrub={(v) => {
            opacityCk.begin();
            setOpacity(v);
          }}
          onCommit={(v) => {
            opacityCk.begin();
            setOpacity(v);
            opacityCk.end();
          }}
        />
      </Row>
      <HiddenRow overlay={o} />
    </Section>
  );
}

/** Seconds into the element at the playhead, clamped to its own window. */
function localTimeOf(o: { start: number; end: number }, now: number): number {
  return Math.max(0, Math.min(now - o.start, Math.max(0.1, o.end - o.start)));
}

/**
 * The keyframe track: the first row of Transform, because a key holds exactly
 * what the rows under it show. The diamond stores that pose where the playhead
 * stands, the arrows walk the keys already set, and the bin drops the one under
 * the playhead. A key has no form of its own — it is edited by moving the
 * element or pulling those same rows.
 */
function KeyframeControls({ overlay: o }: { overlay: Overlay }) {
  const now = useEditor((s) => s.currentTime);
  const seek = useEditor((s) => s.seek);
  const st = () => useEditor.getState();
  return (
    <KeyRow
      element={o}
      now={now}
      keys={o.kf ?? []}
      onAdd={(tLocal) => st().setOverlayKey(o.id, tLocal)}
      onRemove={(tLocal) => st().removeOverlayKey(o.id, tLocal)}
      onSeek={seek}
    />
  );
}

/** The key track row itself — diamond, walkers, count, bin — over whichever
 * key list it is handed. The pose track and the mask track both mount it;
 * the mask track's diamond wears the timeline's amber so the two tracks
 * read apart everywhere. */
function KeyRow({
  element,
  now,
  keys,
  track = "pose",
  onAdd,
  onRemove,
  onSeek,
}: {
  element: { start: number; end: number };
  now: number;
  keys: { t: number }[];
  track?: "pose" | "mask";
  onAdd: (tLocal: number) => void;
  onRemove: (tLocal: number) => void;
  onSeek: (t: number) => void;
}) {
  const inWindow = now >= element.start - 1e-6 && now <= element.end + 1e-6;
  const tLocal = Math.max(
    0,
    Math.min(now - element.start, Math.max(0.1, element.end - element.start))
  );
  const here = keyIndexAt(keys, tLocal);
  const prev = [...keys].sort((a, b) => a.t - b.t).reverse().find((k) => k.t < tLocal - KEY_EPSILON);
  const next = [...keys].sort((a, b) => a.t - b.t).find((k) => k.t > tLocal + KEY_EPSILON);
  return (
    <Row label="Keyframes">
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        disabled={!inWindow}
        title={here >= 0 ? "Update the key here" : "Add a key at the playhead"}
        aria-label={here >= 0 ? "Update the key here" : "Add a key at the playhead"}
        onClick={() => onAdd(tLocal)}
      >
        <Diamond
          className={cn(
            "size-3.5",
            track === "mask" && "text-[#ff9f0a]",
            here >= 0 && "fill-current"
          )}
        />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        disabled={!prev}
        title="Previous key"
        aria-label="Previous key"
        onClick={() => prev && onSeek(element.start + prev.t)}
      >
        <ChevronLeft className="size-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        disabled={!next}
        title="Next key"
        aria-label="Next key"
        onClick={() => next && onSeek(element.start + next.t)}
      >
        <ChevronRight className="size-3.5" />
      </Button>
      {keys.length > 0 && <Value className="text-muted-foreground">{keys.length}</Value>}
      <Button
        size="sm"
        variant="ghost"
        // Icons centre in a 28px box; the value columns below run to the panel
        // edge. The pull-right lands this glyph on the same edge as their text.
        className="-mr-1.5 size-7 p-0 text-muted-foreground"
        disabled={here < 0}
        title="Remove the key here"
        aria-label="Remove the key here"
        onClick={() => onRemove(tLocal)}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </Row>
  );
}

const MASK_SHAPES: { id: MaskKind; label: string }[] = [
  { id: "rect", label: "Rectangle" },
  { id: "circle", label: "Circle" },
  { id: "linear", label: "Linear" },
  { id: "mirror", label: "Mirror" },
  { id: "subject", label: "Subject" },
];

/** How a panel's mask section reads and writes its owner's mask — the same
 * section serves overlay elements and video clips through this. */
interface MaskTarget {
  /** Timeline window for the keyframe row and playhead-local time. */
  element: { start: number; end: number };
  mask?: Mask;
  /** Replace the mask outright (or remove it), as one undo step. */
  set: (mask: Mask | undefined) => void;
  /** Live-drag mask update, no undo entry. */
  setTransient: (mask: Mask) => void;
  setKey: (
    tLocal: number,
    patch?: Partial<Omit<MaskKey, "t">>,
    opts?: { transient?: boolean }
  ) => void;
  removeKey: (tLocal: number) => void;
}

/**
 * A video clip's pose track: the keyframe row plus, once keys exist, the
 * position/scale/rotation/opacity rows editing the key at the playhead — the
 * element Transform contract over the clip's anchor. A clip with no keys
 * rests in its region, so the rows appear with the first key.
 */
function ClipTransformSection({ clip }: { clip: VideoClip }) {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const now = useEditor((s) => s.currentTime);
  const seek = useEditor((s) => s.seek);
  const posCk = useSliderCheckpoint();
  const scaleCk = useSliderCheckpoint();
  const rotationCk = useSliderCheckpoint();
  const opacityCk = useSliderCheckpoint();
  const st = () => useEditor.getState();
  const win = clipWindow(clips, assets, clip.id);
  if (!win) return null;
  const el = { start: win.start, end: win.start + win.len };
  const tLocal = localTimeOf(el, now);
  const keyed = clipKeyed(clip);
  const pose = clipPoseAt(clip, tLocal);
  const setKey = (patch: Partial<Omit<OverlayKey, "t">>) =>
    st().setClipKey(clip.id, tLocal, patch, { transient: true });
  return (
    <Section title="Transform">
      <KeyRow
        element={el}
        now={now}
        keys={clip.kf ?? []}
        onAdd={(t) => st().setClipKey(clip.id, t)}
        onRemove={(t) => st().removeClipKey(clip.id, t)}
        onSeek={seek}
      />
      {keyed && (
        <>
          <Row label="Position">
            {(["x", "y"] as const).map((axis) => (
              <span key={axis} className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
                <ScrubValue
                  label={`${axis.toUpperCase()} position`}
                  className="w-9 text-muted-foreground"
                  value={pose[axis] * 100}
                  min={-50}
                  max={150}
                  step={0.5}
                  keyStep={1}
                  format={(v) => String(Math.round(v))}
                  parse={parseNumberInput}
                  onScrub={(v) => {
                    posCk.begin();
                    setKey({ [axis]: v / 100 });
                  }}
                  onCommit={(v) => {
                    posCk.begin();
                    setKey({ [axis]: v / 100 });
                    posCk.end();
                  }}
                />
              </span>
            ))}
          </Row>
          <Row label="Scale">
            <Slider
              className="data-horizontal:w-24"
              min={0.1}
              max={4}
              step={0.01}
              value={pose.scale}
              onValueChange={(v) => {
                scaleCk.begin();
                setKey({ scale: Number(v) });
              }}
              onValueCommitted={scaleCk.end}
            />
            <Value className="w-9 text-muted-foreground">{Math.round(pose.scale * 100)}%</Value>
          </Row>
          <Row label="Rotation">
            <Slider
              className="data-horizontal:w-24"
              min={-180}
              max={180}
              step={1}
              value={pose.rotation}
              onValueChange={(v) => {
                rotationCk.begin();
                setKey({ rotation: Math.round(Number(v)) });
              }}
              onValueCommitted={rotationCk.end}
            />
            <Value className="w-9 text-muted-foreground">{Math.round(pose.rotation)}°</Value>
          </Row>
          <Row label="Opacity">
            <Slider
              className="data-horizontal:w-24"
              min={0}
              max={1}
              step={0.01}
              value={pose.opacity}
              onValueChange={(v) => {
                opacityCk.begin();
                setKey({ opacity: Number(v) });
              }}
              onValueCommitted={opacityCk.end}
            />
            <Value className="w-9 text-muted-foreground">{Math.round(pose.opacity * 100)}</Value>
          </Row>
        </>
      )}
    </Section>
  );
}

/** The overlay inspector's mask target, over the overlay store actions. */
function OverlayMaskSection({ overlay: o }: { overlay: Overlay }) {
  const st = () => useEditor.getState();
  return (
    <MaskSection
      target={{
        element: o,
        mask: o.mask,
        set: (mask) => st().updateOverlay(o.id, { mask }),
        setTransient: (mask) => st().updateOverlayTransient(o.id, { mask }),
        setKey: (t, patch, opts) => st().setOverlayMaskKey(o.id, t, patch, opts),
        removeKey: (t) => st().removeOverlayMaskKey(o.id, t),
      }}
    />
  );
}

/** The clip inspector's mask target, over the clip store actions. The clip's
 * timeline window comes through `clipWindow` (track-0 starts derive from the
 * span layout). */
function ClipMaskSection({ clip }: { clip: VideoClip }) {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const st = () => useEditor.getState();
  const win = clipWindow(clips, assets, clip.id);
  if (!win) return null;
  return (
    <MaskSection
      target={{
        element: { start: win.start, end: win.start + win.len },
        mask: clip.mask,
        set: (mask) => st().updateClip(clip.id, { mask }),
        setTransient: (mask) => st().updateClipTransient(clip.id, { mask }),
        setKey: (t, patch, opts) => st().setClipMaskKey(clip.id, t, patch, opts),
        removeKey: (t) => st().removeClipMaskKey(clip.id, t),
      }}
    />
  );
}

/**
 * The mask itself: shape picker, its own keyframe track, and the geometry
 * rows. With mask keys in play the rows edit the key at the playhead, the
 * same contract as Transform; otherwise they edit the mask's resting fields.
 */
function MaskSection({ target }: { target: MaskTarget }) {
  const now = useEditor((s) => s.currentTime);
  const seek = useEditor((s) => s.seek);
  const posCk = useSliderCheckpoint();
  const sizeCk = useSliderCheckpoint();
  const rotationCk = useSliderCheckpoint();
  const featherCk = useSliderCheckpoint();
  const radiusCk = useSliderCheckpoint();
  const m = target.mask;
  const tLocal = localTimeOf(target.element, now);
  const geom = m ? maskFrameAt(m, tLocal) : null;
  const writeGeom = (patch: Partial<Omit<MaskKey, "t">>) => {
    if (!m) return;
    if (hasMaskKeys(m)) return target.setKey(tLocal, patch, { transient: true });
    target.setTransient({ ...m, ...patch });
  };
  const showW = m?.kind === "rect" || m?.kind === "circle";
  const showH = showW || m?.kind === "mirror";
  const subject = m?.kind === "subject";
  return (
    <Section
      title="Mask"
      info="Trim the picture to a shape, or to the person in the shot (Subject). Feather softens the edge, and invert keeps what the shape leaves out — an inverted Subject mask sits the picture behind the speaker."
      enabled={!!m}
      onEnabledChange={(v) => target.set(v ? { kind: "rect" } : undefined)}
    >
      {m && geom && (
        <>
          <Row label="Shape">
            <Select
              value={m.kind}
              onValueChange={(kind) => target.set({ ...m, kind: kind as MaskKind })}
            >
              <SelectTrigger className="h-8 w-36 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MASK_SHAPES.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="text-[12px]">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {!subject && (
            <KeyRow
              element={target.element}
              now={now}
              keys={m.kf ?? []}
              track="mask"
              onAdd={(t) => target.setKey(t)}
              onRemove={(t) => target.removeKey(t)}
              onSeek={seek}
            />
          )}
          {!subject && (
            <Row label="Position">
              {(["x", "y"] as const).map((axis) => (
                <span key={axis} className="flex items-center gap-1">
                  <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
                  <ScrubValue
                    label={`Mask ${axis.toUpperCase()} offset`}
                    className="w-9 text-muted-foreground"
                    value={geom[axis] * 100}
                    min={-100}
                    max={100}
                    step={0.5}
                    keyStep={1}
                    format={(v) => String(Math.round(v))}
                    parse={parseNumberInput}
                    onScrub={(v) => {
                      posCk.begin();
                      writeGeom({ [axis]: v / 100 });
                    }}
                    onCommit={(v) => {
                      posCk.begin();
                      writeGeom({ [axis]: v / 100 });
                      posCk.end();
                    }}
                  />
                </span>
              ))}
            </Row>
          )}
          {showH && (
            <Row label="Size">
              {(showW ? (["w", "h"] as const) : (["h"] as const)).map((axis) => (
                <span key={axis} className="flex items-center gap-1">
                  <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
                  <ScrubValue
                    label={`Mask ${axis === "w" ? "width" : "height"}`}
                    className="w-9 text-muted-foreground"
                    value={geom[axis] * 100}
                    min={1}
                    max={200}
                    step={1}
                    format={(v) => String(Math.round(v))}
                    parse={parseNumberInput}
                    onScrub={(v) => {
                      sizeCk.begin();
                      writeGeom({ [axis]: v / 100 });
                    }}
                    onCommit={(v) => {
                      sizeCk.begin();
                      writeGeom({ [axis]: v / 100 });
                      sizeCk.end();
                    }}
                  />
                </span>
              ))}
            </Row>
          )}
          {!subject && (
            <Row label="Rotation">
              <Slider
                className="data-horizontal:w-24"
                min={-180}
                max={180}
                step={1}
                value={geom.rotation}
                onValueChange={(v) => {
                  rotationCk.begin();
                  writeGeom({ rotation: Math.round(Number(v)) });
                }}
                onValueCommitted={rotationCk.end}
              />
              <Value className="w-9 text-muted-foreground">{Math.round(geom.rotation)}°</Value>
            </Row>
          )}
          <Row label="Feather">
            <Slider
              className="data-horizontal:w-24"
              min={0}
              max={120}
              step={1}
              value={geom.feather}
              onValueChange={(v) => {
                featherCk.begin();
                writeGeom({ feather: Math.round(Number(v)) });
              }}
              onValueCommitted={featherCk.end}
            />
            <Value className="w-9 text-muted-foreground">{Math.round(geom.feather)}</Value>
          </Row>
          {m.kind === "rect" && (
            <Row label="Radius">
              <Slider
                className="data-horizontal:w-24"
                min={0}
                max={200}
                step={1}
                value={m.radius ?? 0}
                onValueChange={(v) => {
                  radiusCk.begin();
                  const radius = Math.round(Number(v));
                  target.setTransient({ ...m, radius: radius === 0 ? undefined : radius });
                }}
                onValueCommitted={radiusCk.end}
              />
              <Value className="w-9 text-muted-foreground">{m.radius ?? 0}</Value>
            </Row>
          )}
          <Row label="Invert">
            <Switch
              checked={!!m.invert}
              onCheckedChange={(v) => target.set({ ...m, invert: v || undefined })}
              aria-label="Invert mask"
            />
          </Row>
        </>
      )}
    </Section>
  );
}

function ShapePanel({ overlay: o }: { overlay: ShapeOverlay }) {
  const update = useEditor((s) => s.updateOverlay);
  const fillCk = useSliderCheckpoint();
  const radiusCk = useSliderCheckpoint();
  const strokeCk = useSliderCheckpoint();
  const boxShape = !lineLikeShape(o.shape);
  return (
    <>
      <PanelTitle>{SHAPE_LABELS[o.shape]}</PanelTitle>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <Row label={boxShape ? "Fill" : "Color"}>
          <ColorSwatches
            value={o.fill}
            onBegin={() => useEditor.getState().pushHistory()}
            onLive={(c) => useEditor.getState().updateOverlayTransient(o.id, { fill: c })}
            onCommit={(c) => update(o.id, { fill: c })}
          />
        </Row>
        {boxShape && (
          <Row label="Fill opacity">
            <Slider
              className="data-horizontal:w-24"
              min={0}
              max={1}
              step={0.01}
              value={o.fillOpacity ?? 1}
              onValueChange={(v) => {
                fillCk.begin();
                useEditor.getState().updateOverlayTransient(o.id, {
                  fillOpacity: Number(v) >= 0.995 ? undefined : Number(v),
                });
              }}
              onValueCommitted={fillCk.end}
            />
            <Value className="w-9 text-muted-foreground">
              {Math.round((o.fillOpacity ?? 1) * 100)}
            </Value>
          </Row>
        )}
        {o.shape === "rect" && (
          <Row label="Corner radius">
            <Slider
              className="data-horizontal:w-24"
              min={0}
              max={120}
              step={1}
              value={o.radius ?? 0}
              onValueChange={(v) => {
                radiusCk.begin();
                useEditor.getState().updateOverlayTransient(o.id, {
                  radius: Number(v) === 0 ? undefined : Number(v),
                });
              }}
              onValueCommitted={radiusCk.end}
            />
            <Value className="w-9 text-muted-foreground">{Math.round(o.radius ?? 0)}</Value>
          </Row>
        )}
        {boxShape && (
          <Section
            title="Outline"
            enabled={!!o.stroke}
            onEnabledChange={(v) =>
              update(o.id, { stroke: v ? { color: "#111114", width: 6 } : undefined })
            }
          >
            {o.stroke && (
              <>
                <Row label="Color">
                  <ColorSwatches
                    value={o.stroke.color}
                    onBegin={() => useEditor.getState().pushHistory()}
                    onLive={(c) =>
                      useEditor.getState().updateOverlayTransient(o.id, {
                        stroke: { ...o.stroke!, color: c },
                      })
                    }
                    onCommit={(c) => update(o.id, { stroke: { ...o.stroke!, color: c } })}
                  />
                </Row>
                <Row label="Width">
                  <Slider
                    className="data-horizontal:w-24"
                    min={1}
                    max={40}
                    step={1}
                    value={o.stroke.width}
                    onValueChange={(v) => {
                      strokeCk.begin();
                      useEditor.getState().updateOverlayTransient(o.id, {
                        stroke: { ...o.stroke!, width: Number(v) },
                      });
                    }}
                    onValueCommitted={strokeCk.end}
                  />
                  <Value className="w-9 text-muted-foreground">{o.stroke.width}</Value>
                </Row>
              </>
            )}
          </Section>
        )}
        <OverlayMaskSection overlay={o} />
        <TransformRows overlay={o} />
        <GroupRow overlay={o} />
        <AnimationRows overlay={o} />
      </div>
    </>
  );
}

function EffectPanel({ overlay: o }: { overlay: EffectOverlay }) {
  const amountCk = useSliderCheckpoint();
  return (
    <>
      <PanelTitle>{EFFECT_LABELS[o.effect]}</PanelTitle>
      {/* Which effect this is belongs to the Effects tab: it marks this one and
          swaps it on a click, so the panel is only its knobs. */}
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        {o.effect === "zoom" ? (
          <ZoomTarget overlay={o} />
        ) : (
          <Row label="Amount">
            <Slider
              className="data-horizontal:w-24"
              min={0.05}
              max={1}
              step={0.01}
              value={o.amount ?? 0.5}
              onValueChange={(v) => {
                amountCk.begin();
                useEditor.getState().updateOverlayTransient(o.id, { amount: Number(v) });
              }}
              onValueCommitted={amountCk.end}
            />
            <Value className="w-9 text-muted-foreground">
              {Math.round((o.amount ?? 0.5) * 100)}
            </Value>
          </Row>
        )}
        <HiddenRow overlay={o} />
        <GroupRow overlay={o} />
      </div>
    </>
  );
}

/** The focus puck's diameter, in px — `size-5` on the element below. */
const PUCK = 20;

/**
 * Where a zoom lands and how close it gets.
 *
 * The stage mirrors the live preview, so the point is chosen against the
 * picture the zoom will sit on: drag the puck onto what matters. Depth is
 * three steps — a zoom is a choice of how close, and a slider of it is a
 * decision nobody wants to make twice.
 */
function ZoomTarget({ overlay: o }: { overlay: EffectOverlay }) {
  const aspect = useEditor((s) => s.aspect);
  const frame = frameOf(aspect);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const portrait = frame.h > frame.w;
  const focus = { x: o.focus?.x ?? 0.5, y: o.focus?.y ?? 0.5 };
  const amount = o.amount ?? 0.5;
  // How long the push in takes: the far left is a cut straight to the close
  // shot, everything right of it moves the camera in over that many seconds.
  const ramp = zoomRampOf(o.ramp);
  const rampCk = useSliderCheckpoint();

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dst = canvasRef.current;
      const src = getPreviewCanvas();
      const ctx = dst?.getContext("2d");
      if (!dst || !src || !ctx) return;
      ctx.clearRect(0, 0, dst.width, dst.height);
      ctx.drawImage(src, 0, 0, dst.width, dst.height);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const aim = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    useEditor.getState().updateOverlayTransient(o.id, {
      focus: {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
      },
    });
  };

  return (
    <div className="flex flex-col items-center gap-2 pt-1">
      <div
        className="relative cursor-grab overflow-hidden rounded-lg bg-black select-none active:cursor-grabbing"
        style={{
          aspectRatio: `${frame.w} / ${frame.h}`,
          height: portrait ? 168 : undefined,
          width: portrait ? undefined : "100%",
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          useEditor.getState().pushHistory();
          aim(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) aim(e);
        }}
      >
        <canvas
          ref={canvasRef}
          width={Math.round(frame.w / 5)}
          height={Math.round(frame.h / 5)}
          className="pointer-events-none block size-full"
        />
        {/* The puck rides its point, pulled back by its own radius at the
            edges so the whole of it stays on the picture. */}
        <div
          className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#0a84ff] ring-2 ring-white/90 shadow-[0_1px_4px_rgba(0,0,0,0.45)]"
          style={{
            left: `calc(${focus.x * 100}% + ${((0.5 - focus.x) * PUCK).toFixed(2)}px)`,
            top: `calc(${focus.y * 100}% + ${((0.5 - focus.y) * PUCK).toFixed(2)}px)`,
          }}
        />
      </div>
      <div className="flex w-full flex-col">
        <Row label="Depth" grow>
          {/* The segmented control the rest of the inspector uses — bordered
              box, dark pill on the chosen one — stretched over the row's
              free width. */}
          <div className="flex min-w-0 grow rounded-lg border border-input p-0.5 text-[11.5px] font-medium">
            {ZOOM_LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                aria-pressed={Math.abs(amount - l.amount) < 0.01}
                className={cn(
                  `zoom-${l.id} flex-1 rounded-md px-1 py-1 whitespace-nowrap transition-colors`,
                  Math.abs(amount - l.amount) < 0.01
                    ? "bg-neutral-900 text-white"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => useEditor.getState().updateOverlay(o.id, { amount: l.amount })}
              >
                {l.label}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Speed">
          <Slider
            className="data-horizontal:w-24"
            min={0}
            max={ZOOM_RAMP_MAX}
            step={0.1}
            value={ramp}
            onValueChange={(v) => {
              rampCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { ramp: Number(v) });
            }}
            onValueCommitted={rampCk.end}
          />
          <ScrubValue
            label="Zoom speed"
            className="w-9 text-muted-foreground"
            value={ramp}
            min={0}
            max={ZOOM_RAMP_MAX}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            parse={parseSecondsInput}
            onScrub={(v) => {
              rampCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { ramp: v });
            }}
            onCommit={(v) => {
              useEditor.getState().updateOverlay(o.id, { ramp: v });
              rampCk.end();
            }}
          />
        </Row>
      </div>
    </div>
  );
}

function StickerPanel({ overlay: o }: { overlay: StickerOverlay }) {
  const widthCk = useSliderCheckpoint();
  const asset = useEditor((s) =>
    o.assetId ? s.assets.find((a) => a.id === o.assetId) : undefined
  );
  return (
    <>
      <PanelTitle>Sticker</PanelTitle>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        {asset ? (
          <div className="mb-1 truncate text-[12px] text-muted-foreground" title={asset.name}>
            {asset.name}
          </div>
        ) : null}
        <Row label="Size">
          <Slider
            className="data-horizontal:w-24"
            min={0.02}
            max={1}
            step={0.01}
            value={o.w}
            onValueChange={(v) => {
              widthCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { w: Number(v) });
            }}
            onValueCommitted={widthCk.end}
          />
          <Value className="w-9 text-muted-foreground">{Math.round(o.w * 100)}</Value>
        </Row>
        <OverlayMaskSection overlay={o} />
        <TransformRows overlay={o} />
        <GroupRow overlay={o} />
        <AnimationRows overlay={o} />
      </div>
    </>
  );
}
