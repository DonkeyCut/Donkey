"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Loader2, RotateCcw, SlidersHorizontal, Trash2, Wand2, X } from "lucide-react";
import {
  applyLutToImageData,
  autoGrade as fitAutoGrade,
  buildClipLut,
  GRADE_BASIC_FIELDS,
  GRADE_DETAIL_FIELDS,
  GRADE_HUE_MAX,
  GRADE_MAX,
  GRADE_PRESET_CATEGORIES,
  GRADE_PRESETS,
  gradeCssApprox,
  gradeKey,
  gradePresetsInCategory,
  gradeToolDirty,
  HSL_BANDS,
  normalizeGrade,
  OUTPUT_SPACES,
  SOURCE_PROFILES,
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
import { sampleClipRawFrame, sourceProfileOf, toBaseRendering } from "@/cut/lib/baseFrame";
import { useEditor } from "@/cut/lib/store";
import { usePanelState, useRememberedScroll } from "@/cut/lib/panelState";
import type { MediaAsset, VideoClip } from "@/cut/lib/types";
import { useProxyJobs } from "@/cut/lib/mediaProxy";
import {
  builtinLutOf,
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
import { useDescribeError } from "@/i18n/describeError";
import { useLabels } from "@/i18n/labels";
import type { Messages } from "@/i18n/namespaces";

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
 * Basic tab owns the Detail group too. Each names itself under
 * `inspector.color.tools`. */
const TOOLS = [{ id: "basic" }, { id: "curves" }, { id: "wheels" }, { id: "hsl" }, { id: "lut" }] as const;

type Tool = (typeof TOOLS)[number]["id"];

type ColorMessages = Messages["inspector"]["color"];

/**
 * Names the color registries in the page's language: the shipped presets,
 * the built-in LUTs and the source and delivery spaces, keyed by id. A saved
 * grade and a Library LUT keep the name the person gave them.
 */
function useColorNames() {
  const t = useTranslations("inspector.color");
  const lutName = (l: { id: string; label: string }) => {
    const builtin = builtinLutOf(l.id);
    return builtin ? t(`builtinLuts.${builtin.id as keyof ColorMessages["builtinLuts"]}`) : l.label;
  };
  const presetName = (p: GradePreset | SavedTile | LutTile) => {
    if ("saved" in p) {
      return p.label;
    }
    if ("lutId" in p) {
      return lutName({ id: p.lutId, label: p.label });
    }
    return GRADE_PRESETS[p.id] ? t(`gradePresets.${p.id as keyof ColorMessages["gradePresets"]}`) : p.label;
  };
  return {
    lutName,
    presetName,
    category: (id: GradePresetCategory) => t(`categories.${id}`),
    source: (id: SourceProfile) => t(`sourceProfiles.${id}`),
    output: (id: OutputSpace) => t(`outputSpaces.${id}`),
  };
}

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
  const t = useTranslations("inspector.color");
  const names = useColorNames();
  const asset = useEditor((s) => s.assets.find((a) => a.id === clip.assetId));
  if (!asset || (asset.type !== "video" && asset.type !== "image")) return null;
  const detected: SourceProfile = asset.color?.detected ?? "rec709";
  const value = sourceProfileOf(asset);
  // The menu sets what the file said, and what Rec.709 means here, as a
  // small line under the name; the button carries the name alone.
  const noteOf = (id: SourceProfile) =>
    [id === detected && t("detected"), id === "rec709" && t("noConversion")].filter(Boolean).join(" · ");
  const items = Object.fromEntries(SOURCE_PROFILES.map((p) => [p.id, names.source(p.id)]));
  return (
    <div className="px-3.5">
      <Row label={t("sourceColor")}>
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
                    {names.source(p.id)}
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

/** Where a proxied video's preview is coming from: the proxy being made, or
 * the master itself when no proxy could be made here. Silent once the proxy
 * is in place, and for every file no proxy was asked for. */
function ProxyLine({ asset }: { asset: MediaAsset }) {
  const t = useTranslations("inspector.color");
  const describeError = useDescribeError();
  const job = useProxyJobs((s) => s.jobs[asset.id]);
  // A job only exists for a file that needed a proxy where it was asked.
  if (!job) return null;
  const master = asset.color?.codec?.startsWith("ap") ? "prores" : "original";
  const text =
    job.kind === "making"
      ? t("proxyMaking", { percent: Math.round(job.progress * 100) })
      : job.kind === "none"
        ? t("proxyNone", { master })
        : t("proxyFailed", { error: describeError(job) });
  return <p className="pb-2 text-[11px] leading-snug text-muted-foreground">{text}</p>;
}

/** The project's delivery space: what every clip converts to, what the
 * export writes, and what the stage shows on an HDR display. */
function ProjectColorRow() {
  const t = useTranslations("inspector.color");
  const names = useColorNames();
  const colorSpace = useEditor((s) => s.colorSpace);
  const items = Object.fromEntries(OUTPUT_SPACES.map((o) => [o.id, names.output(o.id)]));
  return (
    <div className="px-3.5">
      <Row label={t("projectColor")}>
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
                {names.output(o.id)}
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
  const t = useTranslations("inspector.color");
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
        {t("savePresetButton")}
      </button>
      <span className="ml-auto" />
      <button
        type="button"
        className={cn("clip-grade-apply-selected", link)}
        disabled={others === 0}
        onClick={applySelected}
      >
        {t("applySelected")}
      </button>
      <button type="button" className={cn("clip-grade-apply-all", link)} onClick={applyAll}>
        {t("applyAll")}
      </button>
      <Dialog open={naming} onOpenChange={(o) => !o && setNaming(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("saveDialogTitle")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Input autoFocus placeholder={t("presetName")} value={name} onChange={(e) => setName(e.target.value)} />
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={busy || !name.trim()} className="w-full">
                {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
                {t("savePreset")}
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

/** Every LUT as a tile: the built-in looks, then the account's own files. */
function useLutTiles(): LutTile[] {
  const choices = useLutChoices();
  return useMemo(
    () =>
      choices.map((l) => ({
        id: `lut-${l.id.slice("lut:".length)}`,
        label: l.label,
        category: "film",
        grade: { lut: { id: l.id } },
        lutId: l.id,
      })),
    [choices]
  );
}

/** The grade with this LUT put on, or taken off when it is the one the clip
 * already wears. */
function withLutToggled(grade: ColorGrade | undefined, lutId: string): ColorGrade {
  const next: ColorGrade = { ...grade };
  if (lutIdOf(grade) === lutId) delete next.lut;
  else next.lut = { id: lutId, amount: grade?.lut?.amount };
  return next;
}

function PresetView({ clip, peers, onAdjust }: { clip: VideoClip; peers?: readonly VideoClip[]; onAdjust: () => void }) {
  const t = useTranslations("inspector.color");
  const names = useColorNames();
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
  const lutTiles = useLutTiles();
  const active = clip.grade?.preset;
  const lut = clip.grade?.lut;
  const lutView = category === LUTS;
  const manualDirty = TOOLS.some((tool) => toolDirty(clip.grade, tool.id));
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
      commit(withLutToggled(clip.grade, p.lutId));
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
          {t("title")}
          <Tip label={t("adjust")}>
            <button
              type="button"
              aria-label={t("adjust")}
              className="clip-color-adjust relative ml-auto grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
              onClick={onAdjust}
            >
              <SlidersHorizontal className="size-4" />
              {manualDirty && (
                <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-violet-500" aria-label={t("adjusted")} />
              )}
            </button>
          </Tip>
        </div>
        <SourceColorRow clip={clip} />
        <ProjectColorRow />
        <div className="mt-2 flex min-w-0 flex-wrap gap-1 px-3.5">
          <button type="button" className={chip(category === "all")} onClick={() => setCategory("all")}>
            {t("all")}
          </button>
          {GRADE_PRESET_CATEGORIES.map((c) => (
            <button key={c.id} type="button" className={chip(category === c.id)} onClick={() => setCategory(c.id)}>
              {names.category(c.id)}
            </button>
          ))}
          <button
            type="button"
            className={cn("clip-grade-category-luts", chip(category === LUTS))}
            onClick={() => setCategory(LUTS)}
          >
            {t("luts")}
          </button>
          <button
            type="button"
            className={cn("clip-grade-category-saved", chip(category === SAVED))}
            onClick={() => setCategory(SAVED)}
          >
            {t("saved")}
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
            label={names.presetName(p)}
            frame={frame}
            profile={profile}
            selected={
              "lutId" in p ? lutIdOf(clip.grade) === p.lutId : "saved" in p ? gradeKey(p.grade) === currentKey : active?.id === p.id
            }
            onPick={() => pick(p)}
            onRemove={"saved" in p ? () => remove(p) : undefined}
          />
        ))}
        {category === SAVED && presets.length === 0 && (
          <p className="col-span-2 py-6 text-center text-[12px] text-muted-foreground">
            {t("savedEmpty")}
          </p>
        )}
      </ScrollArea>
      <div className="shrink-0 border-t border-border bg-card px-3.5 py-1">
        <Row label={t("intensity")}>
          <ValueSlider
            label={t("intensity")}
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
        <Row label={t("protectSkin")}>
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

/** Thumbs are 128px wide: a 17³ lattice draws them without visible error and
 * builds in a few milliseconds even through a log clip's scene grade. */
const THUMB_LUT_SIZE = 17;

/** The preset through the clip's own recipe, from raw code values to the
 * display: the source conversion, the grade (in scene light for log) and its
 * LUT in one lattice. */
function presetLut(p: GradePreset, profile: SourceProfile, userLut: ParsedLut | undefined): GradeLut | null {
  const key = `${p.id}|${profile}|${userLut ? "lut" : ""}`;
  let lut = presetLutCache.get(key);
  if (lut === undefined) {
    lut = buildClipLut({ profile, grade: p.grade, output: "sdr", size: THUMB_LUT_SIZE }, userLut);
    presetLutCache.set(key, lut);
  }
  return lut;
}

/** A preset's recipe reaches past what a CSS filter can draw. */
const presetNeedsLutThumb = (p: GradePreset) => !!(p.grade.curves || p.grade.wheels || p.grade.hsl || p.grade.lut);

function PresetTile({
  preset,
  label,
  frame,
  profile,
  selected,
  onPick,
  onRemove,
}: {
  preset: GradePreset;
  /** The tile's name in the page's language. */
  label: string;
  frame: string | null;
  profile: SourceProfile;
  selected: boolean;
  onPick: () => void;
  onRemove?: () => void;
}) {
  const t = useTranslations("inspector.color");
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
      const lut = presetLut(preset, profile, userLut);
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
        if (lut) applyLutToImageData(px.data, lut);
        else toBaseRendering(px.data, profile);
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
        <span className="max-w-full truncate">{label}</span>
      </button>
      {onRemove && (
        <Tip label={t("deletePreset")}>
          <button
            type="button"
            aria-label={t("deleteNamed", { name: label })}
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
  const t = useTranslations("inspector.color");
  // The picked tool holds for the session, the same way the open level does.
  const [tool, setTool] = usePanelState<Tool>(clip.id, "colorTool", "basic");
  const toolScroll = useRememberedScroll(clip.id, `color-adjust:${tool}`);
  const { draft, commit } = useGradeWriter(clip, peers);
  const grade = clip.grade;
  // Manual adjustments only — reset-all keeps the preset layer.
  const manualDirty = TOOLS.some((item) => toolDirty(grade, item.id));
  // Fit a starting grade from the clip's code values rendered through its
  // own recipe (never the graded preview, which would fold the current grade
  // back into the fit); the sliders show the result and stay fully
  // adjustable after.
  const autoGrade = async () => {
    const raw = sampleClipRawFrame(clip.id);
    if (!raw) {
      return;
    }
    const kept: ColorGrade = { preset: grade?.preset, lut: grade?.lut };
    const lutId = lutIdOf(kept);
    const userLut = lutId ? await loadLibraryLut(lutId) : undefined;
    commit({ ...fitAutoGrade(raw.px, { ...raw.recipe, grade: kept }, userLut), ...kept });
  };
  const resetAll = () => commit(grade?.preset ? { preset: grade.preset } : undefined);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 bg-card pb-2">
        <div className="flex h-10 shrink-0 items-center gap-1 px-2.5 text-sm font-semibold tracking-tight">
          <button
            type="button"
            aria-label={t("back")}
            className="clip-color-back grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            onClick={onBack}
          >
            <ChevronLeft className="size-4" />
          </button>
          {t("adjust")}
          <button
            type="button"
            className="clip-grade-auto ml-auto flex items-center gap-1 rounded-md border border-input px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={autoGrade}
          >
            <Wand2 className="size-3" />
            {t("auto")}
          </button>
          <Tip label={t("resetAll")}>
            <button
              type="button"
              aria-label={t("resetAll")}
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
          {TOOLS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                `clip-grade-tab-${item.id} relative flex-1 rounded-md px-1 py-1 transition-colors`,
                tool === item.id ? "bg-neutral-900 text-white" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setTool(item.id)}
            >
              {t(`tools.${item.id}`)}
              {toolDirty(grade, item.id) && (
                <span
                  className={cn("absolute top-1 right-1 size-1 rounded-full", tool === item.id ? "bg-white/80" : "bg-violet-500")}
                  aria-label={t("toolAdjusted", { tool: t(`tools.${item.id}`) })}
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
        {tool === "lut" && <LutTool clip={clip} grade={grade} draft={draft} commit={commit} />}
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

type GradeFieldKey = keyof ColorMessages["fields"];

function BasicTool({ grade, draft, commit }: GradeWrite) {
  const t = useTranslations("inspector.color");
  // Legacy fields keep rendering and stay editable on clips that carry them;
  // fresh grades never surface the rows.
  const legacy: { key: "brightness" | "hue"; min: number; max: number }[] = [];
  if (grade?.brightness) legacy.push({ key: "brightness", min: -GRADE_MAX, max: GRADE_MAX });
  if (grade?.hue) legacy.push({ key: "hue", min: -GRADE_HUE_MAX, max: GRADE_HUE_MAX });
  const groups = [{ id: "light" as const }, { id: "color" as const }];
  const sliderRow = (key: GradeFieldKey, min: number, max: number) => {
    const label = t(`fields.${key}`);
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
        <ResetButton title={t(`resetField.${key}`)} show={value !== 0} onClick={() => commit({ ...grade, [key]: 0 })} />
      </Row>
    );
  };
  return (
    <>
      {groups.map((g) => (
        <div key={g.id} className="flex flex-col gap-1">
          <span className="mt-1 text-xs font-semibold text-muted-foreground">{t(`groups.${g.id}`)}</span>
          {GRADE_BASIC_FIELDS.filter((f) => f.group === g.id).map((f) => sliderRow(f.key, f.min, GRADE_MAX))}
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <span className="mt-1 text-xs font-semibold text-muted-foreground">{t("groups.detail")}</span>
        {GRADE_DETAIL_FIELDS.map((f) => sliderRow(f.key, f.min, GRADE_MAX))}
      </div>
      {legacy.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="mt-1 text-xs font-semibold text-muted-foreground">{t("groups.legacy")}</span>
          {legacy.map((f) => sliderRow(f.key, f.min, f.max))}
        </div>
      )}
    </>
  );
}

function WheelsTool({ grade, draft, commit }: GradeWrite) {
  const t = useTranslations("inspector.color");
  const wheelLabel = useLabels("wheel");
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
                label={wheelLabel(z)}
                value={[dx, dy]}
                onDraft={([nx, ny]) => write(draft, z, [nx, ny, lum])}
                onCommit={([nx, ny]) => write(commit, z, [nx, ny, lum])}
              />
            </div>
          );
        })}
      </div>
      <span className="mt-2 text-xs font-semibold text-muted-foreground">{t("luminance")}</span>
      {WHEEL_ZONES.map((z) => {
        const [dx, dy, lum] = tuple(z);
        const label = wheelLabel(z);
        return (
          <Row key={z} label={label}>
            <ValueSlider
              label={t("wheelLuminance", { wheel: label })}
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
              title={t(`resetWheel.${z}`)}
              show={dx !== 0 || dy !== 0 || lum !== 0}
              onClick={() => write(commit, z, [0, 0, 0])}
            />
          </Row>
        );
      })}
    </>
  );
}

/** The three sliders of a hue band; each names itself under
 * `inspector.color.hslAxes`. */
const HSL_AXES = [
  { index: 0, id: "hue" },
  { index: 1, id: "saturation" },
  { index: 2, id: "luminance" },
] as const;

function HslTool({ clipId, grade, draft, commit }: GradeWrite & { clipId: string }) {
  const t = useTranslations("inspector.color");
  const [band, setBand] = usePanelState<HslBand>(clipId, "hslBand", "orange");
  const active = HSL_BANDS.find((b) => b.id === band)!;
  const tuple: HslTuple = grade?.hsl?.[band] ?? [0, 0, 0];
  const write = (to: (g: ColorGrade) => void, next: HslTuple) => to({ ...grade, hsl: { ...grade?.hsl, [band]: next } });
  return (
    <>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {HSL_BANDS.map((b) => (
          <Tip key={b.id} label={t(`hslBands.${b.id}`)}>
            <button
              type="button"
              aria-label={t(`hslBands.${b.id}`)}
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
        {t.rich("adjustingBand", {
          band: t(`hslBands.${active.id}`),
          b: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
        })}
      </div>
      {HSL_AXES.map((axis) => (
        <Row key={axis.id} label={t(`hslAxes.${axis.id}`)}>
          <ValueSlider
            label={t(`bandAxis.${axis.id}`, { band: t(`hslBands.${active.id}`) })}
            sliderClassName={`clip-grade-hsl-${axis.id} data-horizontal:w-24`}
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
            title={t(`resetField.${axis.id}`)}
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
  const names = useColorNames();
  const choice = id ? choices.find((c) => c.id === id) : undefined;
  return choice ? names.lutName(choice) : undefined;
}

/** The LUT tool: the applied table as a chip with its intensity, over every
 * LUT as a tile — the built-in looks and the account's own files. A LUT file
 * dragged from the Library onto this tool or onto a clip applies it too. A
 * LUT sits under the grade — the picture after the source conversion goes
 * through it, and the sliders work on what comes out. */
function LutTool({ clip, grade, draft, commit }: GradeWrite & { clip: VideoClip }) {
  const t = useTranslations("inspector.color");
  const names = useColorNames();
  const [over, setOver] = useState(false);
  const tiles = useLutTiles();
  // The clip's own frame, ungraded, so each tile shows what its LUT does.
  const frame = useClipSourceFrame(clip.id);
  const profile = useEditor((s) => sourceProfileOf(s.assets.find((a) => a.id === clip.assetId)));
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
          <span className="min-w-0 flex-1 truncate font-medium">{label ?? t("lutMissing")}</span>
          <Tip label={t("removeLut")}>
            <button
              type="button"
              aria-label={t("removeLut")}
              className="clip-grade-lut-remove grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
              onClick={remove}
            >
              <X className="size-3.5" />
            </button>
          </Tip>
        </div>
      ) : (
        <p className="clip-grade-lut-empty mt-1 rounded-md border border-dashed border-input py-3 text-center text-[12px] text-muted-foreground">
          {t("lutEmpty")}
        </p>
      )}
      <Row label={t("intensity")}>
        <ValueSlider
          label={t("lutIntensity")}
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
      <div className="clip-grade-lut-grid mt-1 grid grid-cols-2 gap-2 pt-1">
        {tiles.map((tile) => (
          <PresetTile
            key={`${clip.id}:${tile.id}`}
            preset={tile}
            label={names.presetName(tile)}
            frame={frame}
            profile={profile}
            selected={applied === tile.lutId}
            onPick={() => commit(withLutToggled(grade, tile.lutId))}
          />
        ))}
      </div>
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
