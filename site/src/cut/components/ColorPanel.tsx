"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Loader2, RotateCcw, SlidersHorizontal, Trash2, Wand2, X } from "lucide-react";
import {
  applyLutToImageData,
  autoGradeFromImageData,
  buildClipLut,
  GRADE_BASIC_FIELDS,
  GRADE_DETAIL_FIELDS,
  GRADE_HUE_MAX,
  GRADE_MAX,
  GRADE_PRESET_CATEGORIES,
  gradeCssApprox,
  gradeKey,
  gradePresetsInCategory,
  gradeToolDirty,
  HSL_BANDS,
  normalizeGrade,
  OUTPUT_SPACES,
  SOURCE_PROFILES,
  WHEEL_LABELS,
  WHEEL_ZONES,
  type ColorGrade,
  type GradeLut,
  type GradePreset,
  type GradePresetCategory,
  type HslBand,
  type HslTuple,
  type OutputSpace,
  type ParsedLut,
  type SourceProfile,
  type WheelTuple,
  type WheelZone,
} from "@donkeycut/effects-kit";
import { getPreviewCanvas } from "@/cut/lib/previewCanvas";
import { beginLutDraft, endLutDraft } from "@/cut/lib/lutBuild";
import { sampleClipBaseFrameData, sourceProfileOf, toBaseRendering } from "@/cut/lib/baseFrame";
import { useEditor } from "@/cut/lib/store";
import { usePanelState, useRememberedScroll } from "@/cut/lib/panelState";
import type { MediaAsset, VideoClip } from "@/cut/lib/types";
import { needsProxy, useProxyJobs } from "@/cut/lib/mediaProxy";
import {
  cachedLut,
  libraryLutId,
  listLutChoices,
  loadLibraryLut,
  LUT_MARK_ICON,
  lutIdOf,
  onLinkedChanged,
  type LutChoice,
} from "@/cut/lib/linkedLibrary";
import {
  deleteGradePreset,
  rememberSavedGrades,
  saveGradePreset,
  savedGradeOf,
  type SavedGrade,
} from "@/cut/lib/gradePresets";
import { patchLibrary, refetchLibrary, useLibrary } from "@/cut/lib/queries";
import { ResetButton, Row, Tip, useSliderCheckpoint } from "@/cut/components/panelBits";
import { ColorWheel } from "@/cut/components/ColorWheel";
import { CurveEditor } from "@/cut/components/CurveEditor";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { parseNumberInput } from "@/cut/components/ScrubValue";
import { useClipSourceFrame } from "@/cut/components/usePlayheadFrame";
import { cn } from "@/lib/utils";
import { PICKED_RING } from "@/cut/lib/assetPick";
import { draggedLutKey } from "@/cut/lib/assetDrag";
import { useInView } from "@/cut/hooks/useInView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The clip panel's Color subview, two levels deep. The first level is the
 * preset grid — the source-colour switch, category chips over click-to-apply
 * tiles (the shipped catalog and the person's saved grades), the applied
 * preset's intensity and skin-tone protection on the panel floor. The second
 * level, behind the header's sliders button, is Adjust: Basic sliders,
 * Curves, Wheels, per-hue HSL and the LUT as segmented tools, every
 * manual adjustment layering over whatever preset is applied. Both levels
 * write the one `grade` field, drafts stream through the transient updater
 * under one history checkpoint per gesture, and preview, filmstrip and
 * exports render the same numbers. Both levels end in the same footer: save
 * the grade as a preset, or land it on the selection or every clip.
 */
export function ColorPanel({ clip, peers }: { clip: VideoClip; peers?: readonly VideoClip[] }) {
  // The open level holds for the session per clip, so deselecting and coming
  // back lands on the same view. A multi-selection reads the first clip's
  // grade and lands every write on all of them.
  const [view, setView] = usePanelState<"presets" | "adjust">(clip.id, "colorView", "presets");
  if (view === "adjust") {
    return <AdjustView clip={clip} peers={peers} onBack={() => setView("presets")} />;
  }
  return <PresetView clip={clip} peers={peers} onAdjust={() => setView("adjust")} />;
}

/** The tools of the Adjust view; `dirty` feeds each tab's marker dot. The
 * Basic tab owns the Detail group too. */
const TOOLS = [
  { id: "basic", label: "Basic" },
  { id: "curves", label: "Curves" },
  { id: "wheels", label: "Wheels" },
  { id: "hsl", label: "HSL" },
  { id: "lut", label: "LUT" },
] as const;

type Tool = (typeof TOOLS)[number]["id"];

const toolDirty = (g: ColorGrade | undefined, tool: Tool) =>
  tool === "basic" ? gradeToolDirty(g, "basic") || gradeToolDirty(g, "detail") : gradeToolDirty(g, tool);

/** Shared write path: normalize and store a whole grade, transiently while a
 * gesture is live, committed at its end. A live gesture — a slider, wheel or
 * curve drag — bakes its LUTs at the draft size; the commit brings the full
 * cube back. */
function useGradeWriter(clip: VideoClip, peers?: readonly VideoClip[]) {
  const ck = useSliderCheckpoint();
  const drafting = useRef(false);
  const settle = () => {
    if (!drafting.current) return;
    drafting.current = false;
    endLutDraft();
  };
  // A panel unmounted mid-drag still ends its draft.
  useEffect(() => settle, []);
  const write = (g: ColorGrade | undefined) => {
    // The checkpoint taken on the gesture's first change is the whole undo
    // step, so every write — drag frames and the commit alike — goes through
    // the transient updater. updateClip would push a second checkpoint and
    // make ⌘Z a two-press affair.
    ck.begin();
    if (!drafting.current) {
      drafting.current = true;
      beginLutDraft();
    }
    const grade = normalizeGrade(g);
    useEditor.getState().updateClipsTransient((peers ?? [clip]).map((c) => ({ id: c.id, patch: { grade } })));
  };
  const commit = (g: ColorGrade | undefined) => {
    write(g);
    ck.end();
    settle();
  };
  return { draft: write, commit };
}


/* ------------------------------------------------------------------ */
/* Source colour                                                       */
/* ------------------------------------------------------------------ */

/** What the clip's code values mean. The header's reading is the default;
 * picking another profile writes the override onto the asset, with undo. */
function SourceColorRow({ clip }: { clip: VideoClip }) {
  const asset = useEditor((s) => s.assets.find((a) => a.id === clip.assetId));
  if (!asset || (asset.type !== "video" && asset.type !== "image")) return null;
  const detected: SourceProfile = asset.color?.detected ?? "rec709";
  const value = sourceProfileOf(asset);
  // The menu sets what the file said, and what Rec.709 means here, as a
  // small line under the name; the button carries the name alone.
  const noteOf = (id: SourceProfile) =>
    [id === detected && "Detected", id === "rec709" && "No conversion"].filter(Boolean).join(" · ");
  const items = Object.fromEntries(SOURCE_PROFILES.map((p) => [p.id, p.label]));
  return (
    <div className="px-3.5">
      <Row label="Source color">
        <Select
          value={value}
          items={items}
          onValueChange={(id) =>
            useEditor
              .getState()
              .setAssetColorProfile(asset.id, id === detected ? undefined : (id as SourceProfile))
          }
        >
          <SelectTrigger className="clip-source-color h-8 w-36 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_PROFILES.map((p) => {
              const note = noteOf(p.id);
              return (
                <SelectItem key={p.id} value={p.id} className="text-[12px]">
                  <span className="flex flex-col">
                    {p.label}
                    {note && <span className="text-[10px] leading-tight text-muted-foreground">{note}</span>}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </Row>
      <ProxyLine asset={asset} />
    </div>
  );
}

/** Where a ProRes master's preview is coming from: the proxy being made, or
 * the master itself when no proxy could be made here. Silent once the proxy
 * is in place, and for every other kind of file. */
function ProxyLine({ asset }: { asset: MediaAsset }) {
  const job = useProxyJobs((s) => s.jobs[asset.id]);
  if (!job || !needsProxy(asset)) return null;
  const text =
    job.kind === "making"
      ? `Preview proxy: ${Math.round(job.progress * 100)}%`
      : job.kind === "none"
        ? "No preview proxy on this browser. The preview plays the ProRes master."
        : `Preview proxy failed: ${job.error}`;
  return <p className="pb-2 text-[11px] leading-snug text-muted-foreground">{text}</p>;
}

/** The project's delivery space: what every clip converts to, what the
 * export writes, and what the stage shows on an HDR display. */
function ProjectColorRow() {
  const colorSpace = useEditor((s) => s.colorSpace);
  const items = Object.fromEntries(OUTPUT_SPACES.map((o) => [o.id, o.label]));
  return (
    <div className="px-3.5">
      <Row label="Project color">
        <Select
          value={colorSpace}
          items={items}
          onValueChange={(id) => useEditor.getState().setColorSpace(id as OutputSpace)}
        >
          <SelectTrigger className="project-color-space h-8 w-36 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTPUT_SPACES.map((o) => (
              <SelectItem key={o.id} value={o.id} className="text-[12px]">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Footer: save, apply to selected, apply to all                       */
/* ------------------------------------------------------------------ */

/** Land the clip's whole grade — preset, sliders, LUT and all — on the other
 * selected clips or on every clip, as one undo step; or keep it on the shelf
 * under a name. */
function GradeFooter({ clip }: { clip: VideoClip }) {
  const ck = useSliderCheckpoint();
  const client = useQueryClient();
  const others = useEditor((s) =>
    s.multiSelection.filter((m): m is { kind: "clip"; id: string } => !!m && m.kind === "clip" && m.id !== clip.id)
      .length
  );
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const grade = normalizeGrade(clip.grade);
  const apply = (ids: string[]) => {
    if (ids.length === 0) return;
    ck.begin();
    useEditor.getState().updateClipsTransient(ids.map((id) => ({ id, patch: { grade } })));
    ck.end();
  };
  const applySelected = () => {
    const s = useEditor.getState();
    apply(
      s.multiSelection
        .filter((m): m is { kind: "clip"; id: string } => !!m && m.kind === "clip" && m.id !== clip.id)
        .map((m) => m.id)
    );
  };
  const applyAll = () => apply(useEditor.getState().clips.filter((c) => c.id !== clip.id).map((c) => c.id));
  const save = async () => {
    const projectId = useEditor.getState().projectId;
    const trimmed = name.trim();
    if (!projectId || !trimmed || busy || !grade) return;
    setBusy(true);
    try {
      await saveGradePreset(projectId, trimmed, grade);
      await refetchLibrary(client);
      setNaming(false);
      setName("");
    } catch {
      // Signed out or offline shelf — the list just doesn't gain one.
    } finally {
      setBusy(false);
    }
  };
  const link =
    "clip-grade-footer-button whitespace-nowrap text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground";
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-border bg-card px-3.5 py-2">
      <button type="button" className={cn("clip-grade-save-preset", link)} disabled={!grade} onClick={() => setNaming(true)}>
        Save Preset
      </button>
      <span className="ml-auto" />
      <button
        type="button"
        className={cn("clip-grade-apply-selected", link)}
        disabled={others === 0}
        onClick={applySelected}
      >
        Apply Selected
      </button>
      <button type="button" className={cn("clip-grade-apply-all", link)} onClick={applyAll}>
        Apply to All
      </button>
      <Dialog open={naming} onOpenChange={(o) => !o && setNaming(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save color preset</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Input autoFocus placeholder="Preset name" value={name} onChange={(e) => setName(e.target.value)} />
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={busy || !name.trim()} className="w-full">
                {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
                Save preset
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Level 1: presets                                                    */
/* ------------------------------------------------------------------ */

const SAVED = "saved";
const LUTS = "luts";
type Category = GradePresetCategory | "all" | typeof SAVED | typeof LUTS;

/** A saved grade in the tile's shape: its id names the shelf copy, so a tile
 * can delete it, and its grade replaces the clip's whole grade when picked. */
type SavedTile = GradePreset & { saved: SavedGrade };

/** A LUT in the tile's shape: picking it sets the clip's LUT, under whatever
 * preset and adjustments the clip already wears. */
type LutTile = GradePreset & { lutId: string };

/** Every LUT a grade can name, re-read as the Library changes. */
const useLutChoices = (): LutChoice[] => useSyncExternalStore(onLinkedChanged, listLutChoices, listLutChoices);

function PresetView({ clip, peers, onAdjust }: { clip: VideoClip; peers?: readonly VideoClip[]; onAdjust: () => void }) {
  const [category, setCategory] = usePanelState<Category>(clip.id, "colorPresetCategory", "all");
  const gridScroll = useRememberedScroll(clip.id, `color-presets:${category}`);
  // The clip's own frame, ungraded: a swatch shows what its preset does to the
  // footage, never what the clip's current grade already did.
  const frame = useClipSourceFrame(clip.id);
  const profile = useEditor((s) => sourceProfileOf(s.assets.find((a) => a.id === clip.assetId)));
  const { draft, commit } = useGradeWriter(clip, peers);
  const client = useQueryClient();
  const library = useLibrary();
  const saved = useMemo<SavedTile[]>(
    () =>
      (library.data?.templates ?? [])
        .map(savedGradeOf)
        .filter((p): p is SavedGrade => p !== null)
        .map((p) => ({ id: `saved:${p.residency}:${p.id}`, label: p.name, category: "film", grade: p.grade, saved: p })),
    [library.data]
  );
  // The chat reads the same list off editor_state.
  useEffect(() => rememberSavedGrades(saved.map((t) => t.saved)), [saved]);
  const lutChoices = useLutChoices();
  const lutTiles = useMemo<LutTile[]>(
    () =>
      lutChoices.map((l) => ({
        id: `lut-${l.id.slice("lut:".length)}`,
        label: l.label,
        category: "film",
        grade: { lut: { id: l.id } },
        lutId: l.id,
      })),
    [lutChoices]
  );
  const active = clip.grade?.preset;
  const lut = clip.grade?.lut;
  const lutView = category === LUTS;
  const manualDirty = TOOLS.some((t) => toolDirty(clip.grade, t.id));
  const presets: (GradePreset | SavedTile | LutTile)[] =
    category === "all"
      ? GRADE_PRESET_CATEGORIES.flatMap((c) => gradePresetsInCategory(c.id))
      : category === SAVED
        ? saved
        : category === LUTS
          ? lutTiles
          : gradePresetsInCategory(category);
  const currentKey = gradeKey(clip.grade);

  const pick = (p: GradePreset | SavedTile | LutTile) => {
    if ("lutId" in p) {
      // Picking the LUT the clip wears takes it off again.
      const next: ColorGrade = { ...clip.grade };
      if (lut?.id === p.lutId) delete next.lut;
      else next.lut = { id: p.lutId, amount: lut?.amount };
      commit(next);
      return;
    }
    if ("saved" in p) {
      // A saved grade is the whole grade — it replaces what the clip wears,
      // and picking it again takes the clip back to neutral.
      commit(gradeKey(p.grade) === currentKey ? undefined : p.grade);
      return;
    }
    commit({
      ...clip.grade,
      preset: active?.id === p.id ? undefined : { id: p.id, amount: active?.amount ?? 1, skin: active?.skin },
    });
  };
  const remove = (p: SavedTile) => {
    void deleteGradePreset(p.saved).catch(() => {});
    patchLibrary(client, (prev) => ({
      ...prev,
      templates: prev.templates.filter((t) => !(t.id === p.saved.id && t.residency === p.saved.residency)),
    }));
  };

  const chip = (activeChip: boolean) =>
    cn(
      "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
      activeChip ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 bg-card pb-2">
        <div className="flex h-10 shrink-0 items-center gap-1 px-3.5 text-sm font-semibold tracking-tight">
          Color
          <Tip label="Adjust">
            <button
              type="button"
              aria-label="Adjust"
              className="clip-color-adjust relative ml-auto grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
              onClick={onAdjust}
            >
              <SlidersHorizontal className="size-4" />
              {manualDirty && (
                <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-violet-500" aria-label="Adjusted" />
              )}
            </button>
          </Tip>
        </div>
        <SourceColorRow clip={clip} />
        <ProjectColorRow />
        <div className="flex min-w-0 flex-wrap gap-1 px-3.5">
          <button type="button" className={chip(category === "all")} onClick={() => setCategory("all")}>
            All
          </button>
          {GRADE_PRESET_CATEGORIES.map((c) => (
            <button key={c.id} type="button" className={chip(category === c.id)} onClick={() => setCategory(c.id)}>
              {c.label}
            </button>
          ))}
          <button
            type="button"
            className={cn("clip-grade-category-luts", chip(category === LUTS))}
            onClick={() => setCategory(LUTS)}
          >
            LUTs
          </button>
          <button
            type="button"
            className={cn("clip-grade-category-saved", chip(category === SAVED))}
            onClick={() => setCategory(SAVED)}
          >
            Saved
          </button>
        </div>
      </div>
      <ScrollArea
        key={category}
        className="min-h-0 flex-1"
        viewportClassName="overscroll-contain"
        contentClassName="grid grid-cols-2 gap-2 px-3.5 pt-1 pb-2"
        {...gridScroll}
      >
        {presets.map((p) => (
          // Keyed by the clip too: a tile holds its last thumb across a
          // moving playhead, and that hold has to break when the footage
          // under it changes, or the swatches show the clip just left.
          <PresetTile
            key={`${clip.id}:${p.id}`}
            preset={p}
            frame={frame}
            profile={profile}
            selected={
              "lutId" in p ? lut?.id === p.lutId : "saved" in p ? gradeKey(p.grade) === currentKey : active?.id === p.id
            }
            onPick={() => pick(p)}
            onRemove={"saved" in p ? () => remove(p) : undefined}
          />
        ))}
        {category === SAVED && presets.length === 0 && (
          <p className="col-span-2 py-6 text-center text-[12px] text-muted-foreground">
            Grades you save land here.
          </p>
        )}
      </ScrollArea>
      <div className="shrink-0 border-t border-border bg-card px-3.5 py-1">
        <Row label="Intensity">
          <ValueSlider
            label="Intensity"
            sliderClassName="clip-grade-preset-amount data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={Math.round(((lutView ? lut?.amount : active?.amount) ?? 1) * 100)}
            min={0}
            max={100}
            step={1}
            disabled={lutView ? !lut : !active}
            format={(v) => `${Math.round(v)}%`}
            parse={parseNumberInput}
            onDraft={(v) => {
              if (lutView) {
                if (lut) draft({ ...clip.grade, lut: { ...lut, amount: v / 100 } });
              } else if (active) draft({ ...clip.grade, preset: { ...active, amount: v / 100 } });
            }}
            onCommit={(v) => {
              if (lutView) {
                if (lut) commit({ ...clip.grade, lut: { ...lut, amount: v / 100 } });
              } else if (active) commit({ ...clip.grade, preset: { ...active, amount: v / 100 } });
            }}
          />
        </Row>
        <Row label="Protect skin tones">
          <Switch
            size="sm"
            className="clip-grade-protect-skin"
            checked={!lutView && !!active?.skin}
            disabled={lutView || !active}
            onCheckedChange={(on: boolean) => active && commit({ ...clip.grade, preset: { ...active, skin: on || undefined } })}
          />
        </Row>
      </div>
      <GradeFooter clip={clip} />
    </div>
  );
}

/** Rendered preset thumbnails for the tiles whose recipes go beyond CSS
 * filters, and for footage whose code values need converting first: the
 * playhead frame pushed through the source conversion and the preset's real
 * LUT at a thumb size, cached per (frame, preset). The LUTs themselves are
 * built once per preset and kept for the session; a saved grade naming a
 * shelf LUT gets its table read once and its tile redrawn when it lands. */
const presetLutCache = new Map<string, GradeLut | null>();
const presetThumbCache = new Map<string, string>();

function presetLut(p: GradePreset, userLut: ParsedLut | undefined): GradeLut | null {
  const key = `${p.id}|${userLut ? "lut" : ""}`;
  let lut = presetLutCache.get(key);
  if (lut === undefined) {
    lut = buildClipLut({ profile: "rec709", grade: p.grade, output: "sdr", size: 33 }, userLut);
    presetLutCache.set(key, lut);
  }
  return lut;
}

/** A preset's recipe reaches past what a CSS filter can draw. */
const presetNeedsLutThumb = (p: GradePreset) => !!(p.grade.curves || p.grade.wheels || p.grade.hsl || p.grade.lut);

function PresetTile({
  preset,
  frame,
  profile,
  selected,
  onPick,
  onRemove,
}: {
  preset: GradePreset;
  frame: string | null;
  profile: SourceProfile;
  selected: boolean;
  onPick: () => void;
  onRemove?: () => void;
}) {
  const converted = profile !== "rec709" && profile !== "srgb";
  const needsLut = presetNeedsLutThumb(preset) || converted;
  const approx = useMemo(() => gradeCssApprox(preset.grade), [preset]);
  const lutId = lutIdOf(preset.grade);
  const userLut = lutId ? cachedLut(lutId) : undefined;
  // A LUT tile reads its file only once it scrolls near view: the grid mounts
  // every tile, and the ones below the fold stay unread until then.
  const [tileRef, seen] = useInView<HTMLDivElement>();
  const key = needsLut && frame && (seen || !lutId) ? `${preset.id}|${profile}|${userLut ? "lut" : ""}|${frame}` : null;
  // The render reads the module cache; the effect fills it asynchronously
  // (decode → convert → LUT → data URL) and bumps to re-read.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!lutId || userLut || !seen) return;
    let gone = false;
    loadLibraryLut(lutId).then(
      () => !gone && bump((n) => n + 1),
      () => {}
    );
    return () => {
      gone = true;
    };
  }, [lutId, userLut, seen]);
  useEffect(() => {
    if (!key || !frame || presetThumbCache.has(key)) return;
    let gone = false;
    const img = new Image();
    img.onload = () => {
      if (gone) return;
      const lut = presetLut(preset, userLut);
      const w = 128;
      const h = Math.max(1, Math.round((img.naturalHeight / (img.naturalWidth || 1)) * w));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      if (lut || converted) {
        const px = ctx.getImageData(0, 0, w, h);
        if (converted) toBaseRendering(px.data, profile);
        if (lut) applyLutToImageData(px.data, lut);
        ctx.putImageData(px, 0, 0);
      }
      const url = c.toDataURL("image/jpeg", 0.72);
      presetThumbCache.set(key, url);
      // The frame refreshes as the playhead moves; drop the thumbs of frames
      // that have gone by, never the ones the mounted tiles are showing.
      if (presetThumbCache.size > 128)
        for (const k of presetThumbCache.keys()) if (!k.endsWith(`|${frame}`)) presetThumbCache.delete(k);
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
  }, [key, frame, preset, userLut, converted, profile]);

  const fresh = needsLut ? (key ? presetThumbCache.get(key) ?? null : null) : frame;
  // The last thumb this tile showed holds while the fresh frame's is still
  // rendering, so a moving playhead never drops the tile to its stand-in.
  const [held, setHeld] = useState<string | null>(null);
  if (fresh && fresh !== held) setHeld(fresh);
  const src = fresh ?? held;
  return (
    <div ref={tileRef} className="group relative">
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          `clip-grade-preset-${preset.id} flex w-full flex-col items-center gap-1 rounded-lg p-1 text-[11px] font-medium outline-none transition-colors`,
          selected ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        )}
        onClick={onPick}
      >
        <span className={cn("relative block aspect-square w-full overflow-hidden rounded-md bg-muted", selected && PICKED_RING)}>
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
                <span className="absolute inset-0" style={{ backgroundColor: approx.tint, mixBlendMode: "multiply" }} />
              )}
            </>
          ) : (
            <StandInScene filter={approx.filter} tint={approx.tint} />
          )}
        </span>
        <span className="max-w-full truncate">{preset.label}</span>
      </button>
      {onRemove && (
        <Tip label="Delete preset">
          <button
            type="button"
            aria-label={`Delete ${preset.label}`}
            className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/75"
            onClick={onRemove}
          >
            <Trash2 className="size-3" />
          </button>
        </Tip>
      )}
    </div>
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

function AdjustView({ clip, peers, onBack }: { clip: VideoClip; peers?: readonly VideoClip[]; onBack: () => void }) {
  // The picked tool holds for the session, the same way the open level does.
  const [tool, setTool] = usePanelState<Tool>(clip.id, "colorTool", "basic");
  const toolScroll = useRememberedScroll(clip.id, `color-adjust:${tool}`);
  const { draft, commit } = useGradeWriter(clip, peers);
  const grade = clip.grade;
  // Manual adjustments only — reset-all keeps the preset layer.
  const manualDirty = TOOLS.some((t) => toolDirty(grade, t.id));
  // Fit a starting grade from the clip's base rendering (the decoder frame
  // through the source conversion alone, never the graded preview, which
  // would fold the current grade back into the fit); the sliders show the
  // result and stay fully adjustable after.
  const autoGrade = () => {
    const data = sampleClipBaseFrameData(clip.id);
    if (data) commit({ ...autoGradeFromImageData(data), preset: grade?.preset, lut: grade?.lut });
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
          <Tip label="Reset all adjustments">
            <button
              type="button"
              aria-label="Reset all adjustments"
              className={cn(
                "clip-grade-reset grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground",
                !manualDirty && "invisible"
              )}
              onClick={resetAll}
            >
              <RotateCcw className="size-3.5" />
            </button>
          </Tip>
        </div>
        <div className="mx-3.5 flex shrink-0 rounded-lg bg-muted p-0.5 text-[11.5px] font-medium">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={cn(
                `clip-grade-tab-${t.id} relative flex-1 rounded-md px-1 py-1 transition-colors`,
                tool === t.id ? "bg-neutral-900 text-white" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setTool(t.id)}
            >
              {t.label}
              {toolDirty(grade, t.id) && (
                <span
                  className={cn("absolute top-1 right-1 size-1 rounded-full", tool === t.id ? "bg-white/80" : "bg-violet-500")}
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
        {...toolScroll}
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
        {tool === "hsl" && <HslTool clipId={clip.id} grade={grade} draft={draft} commit={commit} />}
        {tool === "lut" && <LutTool grade={grade} draft={draft} commit={commit} />}
      </ScrollArea>
      <GradeFooter clip={clip} />
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
  const legacy: { key: "brightness" | "hue"; label: string; min: number; max: number }[] = [];
  if (grade?.brightness) legacy.push({ key: "brightness", label: "Brightness", min: -GRADE_MAX, max: GRADE_MAX });
  if (grade?.hue) legacy.push({ key: "hue", label: "Hue", min: -GRADE_HUE_MAX, max: GRADE_HUE_MAX });
  const groups = [
    { id: "light" as const, label: "Light" },
    { id: "color" as const, label: "Color" },
  ];
  const sliderRow = (key: keyof ColorGrade & string, label: string, min: number, max: number) => {
    const value = (grade?.[key] as number | undefined) ?? 0;
    // A one-sided slider reads as a plain amount; a centred one carries its sign.
    const format = (v: number) => (key === "hue" ? `${Math.round(v)}°` : min < 0 ? formatSigned(v) : `${Math.round(v)}`);
    return (
      <Row key={key} label={label}>
        <ValueSlider
          label={label}
          sliderClassName={`clip-grade-${key} data-horizontal:w-24`}
          valueClassName="w-9 text-muted-foreground"
          value={value}
          min={min}
          max={max}
          step={1}
          snap={min < 0 ? [0] : undefined}
          format={format}
          parse={parseNumberInput}
          onDraft={(v) => draft({ ...grade, [key]: v })}
          onCommit={(v) => commit({ ...grade, [key]: v })}
        />
        <ResetButton title={`Reset ${label.toLowerCase()}`} show={value !== 0} onClick={() => commit({ ...grade, [key]: 0 })} />
      </Row>
    );
  };
  return (
    <>
      {groups.map((g) => (
        <div key={g.id} className="flex flex-col gap-1">
          <span className="mt-1 text-xs font-semibold text-muted-foreground">{g.label}</span>
          {GRADE_BASIC_FIELDS.filter((f) => f.group === g.id).map((f) => sliderRow(f.key, f.label, f.min, GRADE_MAX))}
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <span className="mt-1 text-xs font-semibold text-muted-foreground">Detail</span>
        {GRADE_DETAIL_FIELDS.map((f) => sliderRow(f.key, f.label, f.min, GRADE_MAX))}
      </div>
      {legacy.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="mt-1 text-xs font-semibold text-muted-foreground">Legacy</span>
          {legacy.map((f) => sliderRow(f.key, f.label, f.min, f.max))}
        </div>
      )}
    </>
  );
}

function WheelsTool({ grade, draft, commit }: GradeWrite) {
  const wheels = grade?.wheels;
  const tuple = (z: WheelZone): WheelTuple => wheels?.[z] ?? [0, 0, 0];
  const write = (to: (g: ColorGrade) => void, z: WheelZone, next: WheelTuple) =>
    to({ ...grade, wheels: { ...wheels, [z]: next } });
  return (
    <>
      <div className="mt-1 grid grid-cols-2 gap-2">
        {WHEEL_ZONES.map((z) => {
          const [dx, dy, lum] = tuple(z);
          return (
            <div key={z} className={`clip-grade-wheel-${z}`}>
              <ColorWheel
                label={WHEEL_LABELS[z]}
                value={[dx, dy]}
                onDraft={([nx, ny]) => write(draft, z, [nx, ny, lum])}
                onCommit={([nx, ny]) => write(commit, z, [nx, ny, lum])}
              />
            </div>
          );
        })}
      </div>
      <span className="mt-2 text-xs font-semibold text-muted-foreground">Luminance</span>
      {WHEEL_ZONES.map((z) => {
        const [dx, dy, lum] = tuple(z);
        const label = WHEEL_LABELS[z];
        return (
          <Row key={z} label={label}>
            <ValueSlider
              label={`${label} luminance`}
              sliderClassName={`clip-grade-wheel-${z}-luma data-horizontal:w-24`}
              valueClassName="w-9 text-muted-foreground"
              value={lum}
              min={-GRADE_MAX}
              max={GRADE_MAX}
              step={1}
              snap={[0]}
              format={formatSigned}
              parse={parseNumberInput}
              onDraft={(v) => write(draft, z, [dx, dy, v])}
              onCommit={(v) => write(commit, z, [dx, dy, v])}
            />
            <ResetButton
              title={`Reset ${label.toLowerCase()} wheel`}
              show={dx !== 0 || dy !== 0 || lum !== 0}
              onClick={() => write(commit, z, [0, 0, 0])}
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

function HslTool({ clipId, grade, draft, commit }: GradeWrite & { clipId: string }) {
  const [band, setBand] = usePanelState<HslBand>(clipId, "hslBand", "orange");
  const active = HSL_BANDS.find((b) => b.id === band)!;
  const tuple: HslTuple = grade?.hsl?.[band] ?? [0, 0, 0];
  const write = (to: (g: ColorGrade) => void, next: HslTuple) => to({ ...grade, hsl: { ...grade?.hsl, [band]: next } });
  return (
    <>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {HSL_BANDS.map((b) => (
          <Tip key={b.id} label={b.label}>
            <button
              type="button"
              aria-label={b.label}
              aria-pressed={band === b.id}
              className={cn(
                `clip-grade-hsl-${b.id} relative size-7 rounded-full border-2 transition-transform`,
                band === b.id ? "border-[#0a84ff]" : "border-transparent hover:scale-105"
              )}
              style={{ backgroundColor: b.swatch }}
              onClick={() => setBand(b.id)}
            >
              {!!grade?.hsl?.[b.id] && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-violet-500" />}
            </button>
          </Tip>
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

/* ------------------------------------------------------------------ */
/* LUT                                                                 */
/* ------------------------------------------------------------------ */

/** The label of a built-in or Library LUT, re-read as the Library changes. */
function useLutLabel(id: string | null): string | undefined {
  const choices = useLutChoices();
  return id ? choices.find((c) => c.id === id)?.label : undefined;
}

/** The LUT tool: the applied table as a chip with its intensity. A LUT file
 * dragged from the Library onto this tool or onto a clip applies it. A LUT
 * sits under the grade — the picture after the source conversion goes
 * through it, and the sliders work on what comes out. */
function LutTool({ grade, draft, commit }: GradeWrite) {
  const [over, setOver] = useState(false);
  const applied = lutIdOf(grade);
  const label = useLutLabel(applied);
  const amount = Math.round((grade?.lut?.amount ?? 1) * 100);
  const remove = () => {
    const next = { ...grade };
    delete next.lut;
    commit(next);
  };
  return (
    <div
      className={cn("clip-grade-lut-drop -mx-1 rounded-md px-1 pb-1", over && "bg-[#0a84ff]/10 shadow-[inset_0_0_0_1.5px_rgba(10,132,255,0.4)]")}
      onDragOver={(e) => {
        if (!draggedLutKey(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        const key = draggedLutKey(e);
        setOver(false);
        if (!key) return;
        e.preventDefault();
        commit({ ...grade, lut: { id: libraryLutId(key), amount: grade?.lut?.amount } });
      }}
    >
      {applied ? (
        <div className="clip-grade-lut-chip mt-1 flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-[12px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LUT_MARK_ICON} alt="" aria-hidden className="size-5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-medium">{label ?? "LUT not in the library"}</span>
          <Tip label="Remove LUT">
            <button
              type="button"
              aria-label="Remove LUT"
              className="clip-grade-lut-remove grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
              onClick={remove}
            >
              <X className="size-3.5" />
            </button>
          </Tip>
        </div>
      ) : (
        <p className="clip-grade-lut-empty mt-1 rounded-md border border-dashed border-input py-3 text-center text-[12px] text-muted-foreground">
          Drag a LUT from the Library
        </p>
      )}
      <Row label="Intensity">
        <ValueSlider
          label="LUT intensity"
          sliderClassName="clip-grade-lut-amount data-horizontal:w-24"
          valueClassName="w-9 text-muted-foreground"
          value={amount}
          min={0}
          max={100}
          step={1}
          disabled={!applied}
          format={(v) => `${Math.round(v)}%`}
          parse={parseNumberInput}
          onDraft={(v) => applied && draft({ ...grade, lut: { id: applied, amount: v / 100 } })}
          onCommit={(v) => applied && commit({ ...grade, lut: { id: applied, amount: v / 100 } })}
        />
      </Row>
    </div>
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
