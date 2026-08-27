"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, RotateCcw, SlidersHorizontal, Wand2 } from "lucide-react";
import {
  applyLutToImageData,
  autoGradeFromImageData,
  buildGradeLut,
  GRADE_BASIC_FIELDS,
  GRADE_HUE_MAX,
  GRADE_MAX,
  GRADE_PRESET_CATEGORIES,
  gradeCssApprox,
  gradePresetsInCategory,
  gradeToolDirty,
  HSL_BANDS,
  normalizeGrade,
  type ColorGrade,
  type GradeLut,
  type GradePreset,
  type GradePresetCategory,
  type HslBand,
  type HslTuple,
  type WheelTuple,
} from "@donkeycut/effects-kit";
import { getPreviewCanvas, sampleClipFrameData } from "@/cut/lib/previewCanvas";
import { useEditor } from "@/cut/lib/store";
import { usePanelView } from "@/cut/lib/panelViews";
import type { VideoClip } from "@/cut/lib/types";
import { ResetButton, Row, useSliderCheckpoint } from "@/cut/components/panelBits";
import { ColorWheel } from "@/cut/components/ColorWheel";
import { CurveEditor } from "@/cut/components/CurveEditor";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { parseNumberInput } from "@/cut/components/ScrubValue";
import { useClipSourceFrame } from "@/cut/components/usePlayheadFrame";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";

/**
 * The clip panel's Color subview, two levels deep. The first level is the
 * preset grid — category chips over click-to-apply tiles, with the applied
 * preset's intensity and skin-tone protection on the panel floor. The second
 * level, behind the header's sliders button, is Adjust: Basic sliders,
 * Curves, Wheels and per-hue HSL as segmented tools, every manual adjustment
 * layering over whatever preset is applied. Both levels write the one `grade`
 * field, drafts stream through the transient updater under one history
 * checkpoint per gesture, and preview, filmstrip and exports render the same
 * numbers.
 */
export function ColorPanel({ clip, onBack }: { clip: VideoClip; onBack: () => void }) {
  // The open level holds for the session per clip, so deselecting and coming
  // back lands on the same view.
  const [view, setView] = usePanelView<"presets" | "adjust">(
    `color-level:${clip.id}`,
    "presets"
  );
  if (view === "adjust") {
    return <AdjustView clip={clip} onBack={() => setView("presets")} />;
  }
  return <PresetView clip={clip} onBack={onBack} onAdjust={() => setView("adjust")} />;
}

/** The tools of the Adjust view; `dirty` feeds each tab's marker dot. */
const TOOLS = [
  { id: "basic", label: "Basic" },
  { id: "curves", label: "Curves" },
  { id: "wheels", label: "Wheels" },
  { id: "hsl", label: "HSL" },
] as const;

type Tool = (typeof TOOLS)[number]["id"];

/** Shared write path: normalize and store a whole grade, transiently while a
 * gesture is live, committed at its end. */
function useGradeWriter(clip: VideoClip) {
  const ck = useSliderCheckpoint();
  const write = (g: ColorGrade | undefined) => {
    // The checkpoint taken on the gesture's first change is the whole undo
    // step, so every write — drag frames and the commit alike — goes through
    // the transient updater. updateClip would push a second checkpoint and
    // make ⌘Z a two-press affair.
    ck.begin();
    useEditor.getState().updateClipTransient(clip.id, { grade: normalizeGrade(g) });
  };
  const commit = (g: ColorGrade | undefined) => {
    write(g);
    ck.end();
  };
  return { draft: write, commit };
}

/* ------------------------------------------------------------------ */
/* Level 1: presets                                                    */
/* ------------------------------------------------------------------ */

function PresetView({
  clip,
  onBack,
  onAdjust,
}: {
  clip: VideoClip;
  onBack: () => void;
  onAdjust: () => void;
}) {
  const [category, setCategory] = useState<GradePresetCategory | "all">("all");
  // The clip's own frame, ungraded: a swatch shows what its preset does to the
  // footage, never what the clip's current grade already did.
  const frame = useClipSourceFrame(clip.id);
  const { draft, commit } = useGradeWriter(clip);
  const active = clip.grade?.preset;
  const manualDirty = TOOLS.some((t) => gradeToolDirty(clip.grade, t.id));
  const presets =
    category === "all"
      ? GRADE_PRESET_CATEGORIES.flatMap((c) => gradePresetsInCategory(c.id))
      : gradePresetsInCategory(category);

  const pick = (id: string) => {
    commit({
      ...clip.grade,
      preset:
        active?.id === id
          ? undefined
          : { id, amount: active?.amount ?? 1, skin: active?.skin },
    });
  };

  const chip = (activeChip: boolean) =>
    cn(
      "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
      activeChip ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 bg-card pb-2">
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
            title="Adjust"
            aria-label="Adjust"
            className="clip-color-adjust relative ml-auto grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            onClick={onAdjust}
          >
            <SlidersHorizontal className="size-4" />
            {manualDirty && (
              <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-violet-500" aria-label="Adjusted" />
            )}
          </button>
        </div>
        <div className="flex min-w-0 flex-wrap gap-1 px-3.5">
          <button type="button" className={chip(category === "all")} onClick={() => setCategory("all")}>
            All
          </button>
          {GRADE_PRESET_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={chip(category === c.id)}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <ScrollArea
        key={category}
        className="min-h-0 flex-1"
        viewportClassName="overscroll-contain"
        contentClassName="grid grid-cols-2 gap-2 px-3.5 pt-1 pb-2"
      >
        {presets.map((p) => (
          // Keyed by the clip too: a tile holds its last thumb across a
          // moving playhead, and that hold has to break when the footage
          // under it changes, or the swatches show the clip just left.
          <PresetTile
            key={`${clip.id}:${p.id}`}
            preset={p}
            frame={frame}
            selected={active?.id === p.id}
            onPick={pick}
          />
        ))}
      </ScrollArea>
      <div className="shrink-0 border-t border-border bg-card px-3.5 py-1">
        <Row label="Intensity">
          <ValueSlider
            label="Intensity"
            sliderClassName="clip-grade-preset-amount data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={Math.round((active?.amount ?? 1) * 100)}
            min={0}
            max={100}
            step={1}
            disabled={!active}
            format={(v) => `${Math.round(v)}%`}
            parse={parseNumberInput}
            onDraft={(v) =>
              active && draft({ ...clip.grade, preset: { ...active, amount: v / 100 } })
            }
            onCommit={(v) =>
              active && commit({ ...clip.grade, preset: { ...active, amount: v / 100 } })
            }
          />
        </Row>
        <Row label="Protect skin tones">
          <Switch
            size="sm"
            className="clip-grade-protect-skin"
            checked={!!active?.skin}
            disabled={!active}
            onCheckedChange={(on: boolean) =>
              active && commit({ ...clip.grade, preset: { ...active, skin: on || undefined } })
            }
          />
        </Row>
      </div>
    </div>
  );
}

/** Rendered preset thumbnails for the tiles whose recipes go beyond CSS
 * filters: the playhead frame pushed through the preset's real LUT at a thumb
 * size, cached per (frame, preset). The LUTs themselves are built once per
 * preset and kept for the session. */
const presetLutCache = new Map<string, GradeLut | null>();
const presetThumbCache = new Map<string, string>();

function presetLut(p: GradePreset): GradeLut | null {
  let lut = presetLutCache.get(p.id);
  if (lut === undefined) {
    lut = buildGradeLut(p.grade);
    presetLutCache.set(p.id, lut);
  }
  return lut;
}

/** A preset's recipe reaches past what a CSS filter can draw. */
const presetNeedsLutThumb = (p: GradePreset) => !!(p.grade.curves || p.grade.wheels || p.grade.hsl);

function PresetTile({
  preset,
  frame,
  selected,
  onPick,
}: {
  preset: GradePreset;
  frame: string | null;
  selected: boolean;
  onPick: (id: string) => void;
}) {
  const needsLut = presetNeedsLutThumb(preset);
  const approx = useMemo(() => gradeCssApprox(preset.grade), [preset]);
  const key = needsLut && frame ? `${preset.id}|${frame}` : null;
  // The render reads the module cache; the effect fills it asynchronously
  // (decode → LUT → data URL) and bumps to re-read.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key || !frame || presetThumbCache.has(key)) return;
    let gone = false;
    const img = new Image();
    img.onload = () => {
      if (gone) return;
      const lut = presetLut(preset);
      const w = 128;
      const h = Math.max(1, Math.round((img.naturalHeight / (img.naturalWidth || 1)) * w));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      if (lut) {
        const px = ctx.getImageData(0, 0, w, h);
        applyLutToImageData(px.data, lut);
        ctx.putImageData(px, 0, 0);
      }
      const url = c.toDataURL("image/jpeg", 0.72);
      presetThumbCache.set(key, url);
      // The frame refreshes as the playhead moves; drop the thumbs of frames
      // that have gone by, never the ones the mounted tiles are showing.
      if (presetThumbCache.size > 128)
        for (const k of presetThumbCache.keys())
          if (!k.endsWith(`|${frame}`)) presetThumbCache.delete(k);
      // Decoded before the swap, so the tile flips straight from the old
      // thumb to a ready bitmap.
      const pre = new Image();
      pre.src = url;
      const land = () => {
        if (!gone) bump((n) => n + 1);
      };
      pre.decode().then(land, land);
    };
    img.src = frame;
    return () => {
      gone = true;
    };
  }, [key, frame, preset]);

  const fresh = needsLut ? (key ? presetThumbCache.get(key) ?? null : null) : frame;
  // The last thumb this tile showed holds while the fresh frame's is still
  // rendering, so a moving playhead never drops the tile to its stand-in.
  const [held, setHeld] = useState<string | null>(null);
  if (fresh && fresh !== held) setHeld(fresh);
  const src = fresh ?? held;
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        `clip-grade-preset-${preset.id} group flex flex-col items-center gap-1 rounded-lg p-1 text-[11px] font-medium outline-none transition-colors`,
        selected ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
      onClick={() => onPick(preset.id)}
    >
      <span
        className={cn(
          "relative block aspect-square w-full overflow-hidden rounded-md bg-muted",
          selected && "ring-2 ring-[#0a84ff] ring-offset-1 ring-offset-card"
        )}
      >
        {src ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full object-cover"
              style={needsLut ? undefined : { filter: approx.filter || undefined }}
            />
            {!needsLut && approx.tint && (
              <span
                className="absolute inset-0"
                style={{ backgroundColor: approx.tint, mixBlendMode: "multiply" }}
              />
            )}
          </>
        ) : (
          <StandInScene filter={approx.filter} tint={approx.tint} />
        )}
      </span>
      {preset.label}
    </button>
  );
}

/** A drawn stand-in for projects with no picture yet, taking the preset's CSS
 * approximation so the tiles still read differently from each other. */
function StandInScene({ filter, tint }: { filter: string; tint: string | null }) {
  return (
    <span className="absolute inset-0" style={{ filter: filter || undefined }}>
      <span className="absolute inset-0 bg-[#7fa8c9]" />
      <span className="absolute inset-x-0 bottom-0 h-[38%] bg-[#b08d5f]" />
      <span className="absolute bottom-[20%] left-1/2 size-[26%] -translate-x-1/2 rounded-full bg-[#e2b189]" />
      {tint && <span className="absolute inset-0" style={{ backgroundColor: tint, mixBlendMode: "multiply" }} />}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Level 2: adjust                                                     */
/* ------------------------------------------------------------------ */

function AdjustView({ clip, onBack }: { clip: VideoClip; onBack: () => void }) {
  // The picked tool holds for the session, the same way the open level does.
  const [tool, setTool] = usePanelView<Tool>(`color-tool:${clip.id}`, "basic");
  const { draft, commit } = useGradeWriter(clip);
  const grade = clip.grade;
  // Manual adjustments only — reset-all keeps the preset layer.
  const manualDirty = TOOLS.some((t) => gradeToolDirty(grade, t.id));
  // Fit a starting grade from the clip's raw decoder frame (never the graded
  // preview, which would fold the current grade back into the fit); the
  // sliders show the result and stay fully adjustable after.
  const autoGrade = () => {
    const data = sampleClipFrameData(clip.id);
    if (data) commit({ ...autoGradeFromImageData(data), preset: grade?.preset });
  };
  const resetAll = () => commit(grade?.preset ? { preset: grade.preset } : undefined);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 bg-card pb-2">
        <div className="flex h-10 shrink-0 items-center gap-1 px-2.5 text-sm font-semibold tracking-tight">
          <button
            type="button"
            aria-label="Back"
            className="clip-color-back grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            onClick={onBack}
          >
            <ChevronLeft className="size-4" />
          </button>
          Adjust
          <button
            type="button"
            className="clip-grade-auto ml-auto flex items-center gap-1 rounded-md border border-input px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={autoGrade}
          >
            <Wand2 className="size-3" />
            Auto
          </button>
          <button
            type="button"
            title="Reset all adjustments"
            aria-label="Reset all adjustments"
            className={cn(
              "clip-grade-reset grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground",
              !manualDirty && "invisible"
            )}
            onClick={resetAll}
          >
            <RotateCcw className="size-3.5" />
          </button>
        </div>
        <div className="mx-3.5 flex shrink-0 rounded-lg bg-muted p-0.5 text-[11.5px] font-medium">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={cn(
                `clip-grade-tab-${t.id} relative flex-1 rounded-md px-1.5 py-1 transition-colors`,
                tool === t.id ? "bg-neutral-900 text-white" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setTool(t.id)}
            >
              {t.label}
              {gradeToolDirty(grade, t.id) && (
                <span
                  className={cn(
                    "absolute top-1 right-1.5 size-1 rounded-full",
                    tool === t.id ? "bg-white/80" : "bg-violet-500"
                  )}
                  aria-label={`${t.label} adjusted`}
                />
              )}
            </button>
          ))}
        </div>
      </div>
      <ScrollArea
        key={tool}
        className="min-h-0 flex-1"
        viewportClassName="overscroll-contain"
        contentClassName="flex flex-col gap-1 px-3.5 pt-1 pb-4"
      >
        <Histogram />
        {tool === "basic" && <BasicTool grade={grade} draft={draft} commit={commit} />}
        {tool === "curves" && (
          <CurveEditor
            curves={grade?.curves}
            onDraft={(curves) => draft({ ...grade, curves })}
            onCommit={(curves) => commit({ ...grade, curves })}
          />
        )}
        {tool === "wheels" && <WheelsTool grade={grade} draft={draft} commit={commit} />}
        {tool === "hsl" && <HslTool grade={grade} draft={draft} commit={commit} />}
      </ScrollArea>
    </div>
  );
}

type GradeWrite = {
  grade: ColorGrade | undefined;
  draft: (g: ColorGrade) => void;
  commit: (g: ColorGrade | undefined) => void;
};

const formatSigned = (v: number) => (v > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`);

function BasicTool({ grade, draft, commit }: GradeWrite) {
  // Legacy fields keep rendering and stay editable on clips that carry them;
  // fresh grades never surface the rows.
  const legacy: { key: "brightness" | "hue"; label: string; max: number }[] = [];
  if (grade?.brightness) legacy.push({ key: "brightness", label: "Brightness", max: GRADE_MAX });
  if (grade?.hue) legacy.push({ key: "hue", label: "Hue", max: GRADE_HUE_MAX });
  const groups = [
    { id: "light" as const, label: "Light" },
    { id: "color" as const, label: "Color" },
  ];
  const sliderRow = (key: keyof ColorGrade & string, label: string, max: number) => {
    const value = (grade?.[key] as number | undefined) ?? 0;
    return (
      <Row key={key} label={label}>
        <ValueSlider
          label={label}
          sliderClassName={`clip-grade-${key} data-horizontal:w-24`}
          valueClassName="w-9 text-muted-foreground"
          value={value}
          min={-max}
          max={max}
          step={1}
          snap={[0]}
          format={(v) => (key === "hue" ? `${Math.round(v)}°` : formatSigned(v))}
          parse={parseNumberInput}
          onDraft={(v) => draft({ ...grade, [key]: v })}
          onCommit={(v) => commit({ ...grade, [key]: v })}
        />
        <ResetButton
          title={`Reset ${label.toLowerCase()}`}
          show={value !== 0}
          onClick={() => commit({ ...grade, [key]: 0 })}
        />
      </Row>
    );
  };
  return (
    <>
      {groups.map((g) => (
        <div key={g.id} className="flex flex-col gap-1">
          <span className="mt-1 text-xs font-semibold text-muted-foreground">{g.label}</span>
          {GRADE_BASIC_FIELDS.filter((f) => f.group === g.id).map((f) =>
            sliderRow(f.key, f.label, GRADE_MAX)
          )}
        </div>
      ))}
      {legacy.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="mt-1 text-xs font-semibold text-muted-foreground">Legacy</span>
          {legacy.map((f) => sliderRow(f.key, f.label, f.max))}
        </div>
      )}
    </>
  );
}

const WHEEL_ZONES = [
  { id: "s" as const, label: "Shadows" },
  { id: "m" as const, label: "Midtones" },
  { id: "h" as const, label: "Highlights" },
];

function WheelsTool({ grade, draft, commit }: GradeWrite) {
  const wheels = grade?.wheels;
  const tuple = (z: "s" | "m" | "h"): WheelTuple => wheels?.[z] ?? [0, 0, 0];
  const write = (
    to: (g: ColorGrade) => void,
    z: "s" | "m" | "h",
    next: WheelTuple
  ) => to({ ...grade, wheels: { ...wheels, [z]: next } });
  return (
    <>
      <div className="mt-1 grid grid-cols-3 gap-2">
        {WHEEL_ZONES.map((z) => {
          const [dx, dy, lum] = tuple(z.id);
          return (
            <div key={z.id} className={`clip-grade-wheel-${z.id}`}>
              <ColorWheel
                label={z.label}
                value={[dx, dy]}
                onDraft={([nx, ny]) => write(draft, z.id, [nx, ny, lum])}
                onCommit={([nx, ny]) => write(commit, z.id, [nx, ny, lum])}
              />
            </div>
          );
        })}
      </div>
      <span className="mt-2 text-xs font-semibold text-muted-foreground">Luminance</span>
      {WHEEL_ZONES.map((z) => {
        const [dx, dy, lum] = tuple(z.id);
        return (
          <Row key={z.id} label={z.label}>
            <ValueSlider
              label={`${z.label} luminance`}
              sliderClassName={`clip-grade-wheel-${z.id}-luma data-horizontal:w-24`}
              valueClassName="w-9 text-muted-foreground"
              value={lum}
              min={-GRADE_MAX}
              max={GRADE_MAX}
              step={1}
              snap={[0]}
              format={formatSigned}
              parse={parseNumberInput}
              onDraft={(v) => write(draft, z.id, [dx, dy, v])}
              onCommit={(v) => write(commit, z.id, [dx, dy, v])}
            />
            <ResetButton
              title={`Reset ${z.label.toLowerCase()} wheel`}
              show={dx !== 0 || dy !== 0 || lum !== 0}
              onClick={() => write(commit, z.id, [0, 0, 0])}
            />
          </Row>
        );
      })}
    </>
  );
}

const HSL_AXES = [
  { index: 0, label: "Hue" },
  { index: 1, label: "Saturation" },
  { index: 2, label: "Luminance" },
] as const;

function HslTool({ grade, draft, commit }: GradeWrite) {
  const [band, setBand] = useState<HslBand>("orange");
  const active = HSL_BANDS.find((b) => b.id === band)!;
  const tuple: HslTuple = grade?.hsl?.[band] ?? [0, 0, 0];
  const write = (to: (g: ColorGrade) => void, next: HslTuple) =>
    to({ ...grade, hsl: { ...grade?.hsl, [band]: next } });
  return (
    <>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {HSL_BANDS.map((b) => (
          <button
            key={b.id}
            type="button"
            title={b.label}
            aria-label={b.label}
            aria-pressed={band === b.id}
            className={cn(
              `clip-grade-hsl-${b.id} relative size-7 rounded-full border-2 transition-transform`,
              band === b.id ? "border-[#0a84ff]" : "border-transparent hover:scale-105"
            )}
            style={{ backgroundColor: b.swatch }}
            onClick={() => setBand(b.id)}
          >
            {!!grade?.hsl?.[b.id] && (
              <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-violet-500" />
            )}
          </button>
        ))}
      </div>
      <div className="mt-1 text-[12px] text-muted-foreground">
        Adjusting <span className="font-semibold text-foreground">{active.label}</span>
      </div>
      {HSL_AXES.map((axis) => (
        <Row key={axis.label} label={axis.label}>
          <ValueSlider
            label={`${active.label} ${axis.label.toLowerCase()}`}
            sliderClassName={`clip-grade-hsl-${axis.label.toLowerCase()} data-horizontal:w-24`}
            valueClassName="w-9 text-muted-foreground"
            value={tuple[axis.index]}
            min={-GRADE_MAX}
            max={GRADE_MAX}
            step={1}
            snap={[0]}
            format={formatSigned}
            parse={parseNumberInput}
            onDraft={(v) => {
              const next = [...tuple] as HslTuple;
              next[axis.index] = v;
              write(draft, next);
            }}
            onCommit={(v) => {
              const next = [...tuple] as HslTuple;
              next[axis.index] = v;
              write(commit, next);
            }}
          />
          <ResetButton
            title={`Reset ${axis.label.toLowerCase()}`}
            show={tuple[axis.index] !== 0}
            onClick={() => {
              const next = [...tuple] as HslTuple;
              next[axis.index] = 0;
              write(commit, next);
            }}
          />
        </Row>
      ))}
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
