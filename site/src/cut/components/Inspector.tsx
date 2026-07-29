"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bold, ChevronLeft, ChevronRight, Info, RotateCcw, SlidersHorizontal, Smile, Wand2 } from "lucide-react";
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
import { clipWindow, useEditor, type EditorState } from "@/cut/lib/store";
import { GenerateSubtitlesAudio } from "@/cut/components/VoicePicker";
import {
  parseNumberInput,
  parsePercentInput,
  parseSecondsInput,
  parseSpeedInput,
  parseTimeInput,
  ScrubValue,
} from "@/cut/components/ScrubValue";
import { PLATE_COLOR, PLATE_OPACITY, PLATE_RADIUS } from "@/cut/lib/textRender";
import { writeTextStyle } from "@/cut/lib/textStyle";
import { formatTime } from "@/cut/lib/time";
import {
  FONTS,
  GRADE_HUE_MAX,
  GRADE_MAX,
  LAYOUTS,
  rectOf,
  regionLabel,
  SPEED_FLOOR,
  SPEED_MAX,
  SPEED_MIN,
  type AudioClip,
  type ColorGrade,
  type FrameRect,
  type LayoutId,
  type TextOverlay,
  type VideoClip,
} from "@/cut/lib/types";
import { ClipEffectsPanel, effectsSummary } from "@/cut/components/ClipEffectsPanel";
import { autoGradeFromImageData, isNeutralGrade, normalizeGrade } from "@/cut/lib/colorGrade";
import { getPreviewCanvas, sampleClipFrameData } from "@/cut/lib/previewCanvas";
import { cn } from "@/lib/utils";

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
    selection?.kind === "text" ? s.overlays.find((o) => o.id === selection.id) : undefined
  );

  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto border-l border-border bg-card">
      {clip ? (
        <ClipPanel key={clip.id} clip={clip} />
      ) : audio ? (
        <AudioPanel key={audio.id} clip={audio} />
      ) : overlay ? (
        <TextPanel key={overlay.id} overlay={overlay} />
      ) : null}
    </aside>
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
  children,
}: {
  label: string;
  /** Hoverable (i) after the label explaining what the control does. */
  info?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-2.5">
      <span className="flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground">
        {label}
        {info && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                className="grid size-4 place-items-center text-muted-foreground/70 transition-colors hover:text-foreground"
                aria-label={`About ${label.toLowerCase()}`}
              >
                <Info className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-60">
                {info}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
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
  // A transition hands this clip into the next one on its own track — every
  // track carries transitions — so offer it whenever a same-track clip
  // follows this one.
  const hasNext = useEditor((s) =>
    s.clips.some((c) => c.track === clip.track && c.start > clip.start + 1e-6)
  );
  const [speedDraft, setSpeedDraft] = useState<number | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  // The panel can push into the color-grade or effects subview. Each subview
  // remembers which clip opened it, so selecting another clip lands back on
  // the main view without an effect.
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [effectsFor, setEffectsFor] = useState<string | null>(null);
  const view =
    colorFor === clip.id ? "color" : effectsFor === clip.id ? "effects" : "main";
  const volume = volumeDraft ?? clip.volume ?? 1;
  const speed = speedDraft ?? clip.speed ?? 1;
  const speedLen = (clip.out - clip.in) / (speed > 0 ? speed : 1);
  // Typing can trim out to the source's end but no further; an image has no
  // intrinsic duration, so its clip can be any length.
  const maxOut = asset && asset.type !== "image" ? asset.duration : Infinity;
  if (view === "color") {
    return <ColorPanel clip={clip} onBack={() => setColorFor(null)} />;
  }
  if (view === "effects") {
    return <ClipEffectsPanel clip={clip} hasNext={hasNext} onBack={() => setEffectsFor(null)} />;
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
        <Row label="Effects">
          <button
            type="button"
            className="clip-effects flex h-8 w-[8.5rem] items-center justify-between rounded-md border border-input px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setEffectsFor(clip.id)}
          >
            <span className="truncate">{effectsSummary(clip, hasNext)}</span>
            <ChevronRight className="size-3.5 shrink-0" />
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
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Remember this title's look across clips and projects, so the next new title
  // starts from the same style.
  useEffect(() => {
    writeTextStyle({
      size: o.size,
      font: o.font,
      weight: o.weight,
      color: o.color,
      shadow: o.shadow,
      plate: o.plate,
      plateColor: o.plateColor,
      plateOpacity: o.plateOpacity,
      plateRadius: o.plateRadius,
    });
  }, [o.size, o.font, o.weight, o.color, o.shadow, o.plate, o.plateColor, o.plateOpacity, o.plateRadius]);

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
        <Row label="Font">
          <Select
            value={o.font}
            items={Object.fromEntries(FONTS.map((f) => [f.id, f.label]))}
            onValueChange={(v) => update(o.id, { font: v as TextOverlay["font"] })}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONTS.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.label}
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
        <Row label="Shadow">
          <Switch checked={o.shadow} onCheckedChange={(v) => update(o.id, { shadow: v })} />
        </Row>
        <Row label="Backdrop">
          <Switch checked={o.plate} onCheckedChange={(v) => update(o.id, { plate: v })} />
        </Row>
        {o.plate && (
          <>
            <Row label="Backdrop color">
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
        )}
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Drag the title in the preview to place it; use the corner handle to resize.
        </p>
      </div>
    </>
  );
}
