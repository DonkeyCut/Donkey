"use client";

import {
  autoGradeFromImageData,
  colorStatsFromImageData,
  EFFECT_IDS,
  GRADE_BASIC_FIELDS,
  GRADE_PRESETS,
  HSL_BANDS,
  matchGrade,
  normalizeGrade,
  semanticMasterCurve,
  type ColorStats,
  type CurvePoint,
  type EffectId,
  type GradeCurves,
  type HslBand,
  type WheelTuple,
  type Mask,
  OVERLAY_ANIM_DEFAULT_SECONDS,
  OVERLAY_ANIM_MAX_SECONDS,
  OVERLAY_ANIM_MIN_SECONDS,
  OVERLAY_ANIM_STYLE_IDS,
  OVERLAY_LOOP_STYLE_IDS,
  type OverlayAnim,
  type OverlayAnimStyle,
  type OverlayLoopStyle,
} from "@donkeycut/effects-kit";
import type { AiPanelToolName } from "@/cut/components/AiPanel.tools";
import type { OverlayAnimationToolName } from "@/cut/components/AnimationTiles.tools";
import type { AudioToolName } from "@/cut/components/AudioPanel.tools";
import type { EditorToolName } from "@/cut/components/Editor.tools";
import type { EffectsToolName } from "@/cut/components/EffectsPanel.tools";
import { SHAPE_KINDS, type ElementsToolName } from "@/cut/components/ElementsPanel.tools";
import type { VideoGenToolName } from "@/cut/components/GeneratePanel.tools";
import type { ImageGenToolName } from "@/cut/components/ImageGenPanel.tools";
import type { InspectorToolName } from "@/cut/components/Inspector.tools";
import type { LibraryToolName } from "@/cut/components/LibraryView.tools";
import type { PreviewToolName } from "@/cut/components/Preview.tools";
import type { SceneToolName } from "@/cut/components/SceneCard.tools";
import type { SidePanelToolName } from "@/cut/components/SidePanel.tools";
import type { StockToolName } from "@/cut/components/StockPanels.tools";
import type { SubtitlesToolName } from "@/cut/components/SubtitlesPanel.tools";
import type { TimelineToolName } from "@/cut/components/Timeline.tools";
import type { TopBarToolName } from "@/cut/components/TopBar.tools";
import type { TransitionsToolName } from "@/cut/components/TransitionsPanel.tools";
import { apiFetch, apiJson, getBackend } from "./backend";
import { refFromAsset, refFromStockVideo, type AssetRef } from "./assetRef";
import { chatOwner, tagChatAsset } from "./chatAssets";
import { applyOwnership, useGenerate, type VideoAttempt, type VideoGenOptions } from "./generate";
import { useGenScene } from "./genScene";
import { anchorRefused } from "./genvideo/shotAttempts";
import {
  addTemplateToProject,
  createLibraryFolder,
  deleteFromLibrary,
  deleteLibraryFolder,
  deleteTemplate,
  fetchLibrary,
  importLibraryAsset,
  moveLibraryItem,
  renameLibraryFolder,
  saveAssetToLibrary,
} from "./library";
import { fetchNotes } from "./notes";
import {
  captureFreezeFrame,
  detectSilenceClientSide,
  enrichAsset,
  ensurePeaks,
  importImage,
  importStockVideo,
  importUrlMedia,
  composeSheets,
  makeStillFrame,
  renderAudioSpanWav,
  sampleWatchFrames,
} from "./media";
import { convertAssetToMp4 } from "./mediaConvert";
import { isLottieAsset } from "./lottieAssets";
import { BREATH, REACH, refineEdge, type SilenceSpan } from "./cutRefine";
import { requestSidePanel } from "./panelRequest";
import { blobToInlineAudio, refToInlineAudio, visualRefs, type InlineImage } from "./refMedia";
import { characterPrompt, stockAspectDims, stockTitle } from "./stock";
import { STOCK_IMAGES } from "./stockManifest";
import { STOCK_VIDEOS } from "./stockVideoManifest";
import { applyOverlayPatchSettled, track0Clips, laneGapAt, getClipSpans, nextFreeStart, overlayLaneOrder, overlayLayers, parkedTransitions, projectDuration, resolveTransitions, totalDuration, useEditor } from "./store";
import { playheadAt } from "./playhead";
import { renderProjectFrame } from "./exportRender";
import { createRasterCanvas, decodeRasterImageUrl, rasterCanvasToDataUrl } from "./raster";
import { buildAiContext } from "./aiContext";
import { sampleClipFrameData } from "./previewCanvas";
import { CAPTION_STYLES, laneCues, subtitleLaneCount } from "./subtitles";
import { fuseTimeline, renderFusedTimeline } from "./watch/fuse";
import { mergeWatch, mergeWatchNotes, uncoveredSeconds, unnotedSpans } from "./watch/merge";
import { syncLines, type TimedWord } from "./lyricSync";
import {
  composeTextRun,
  TEXT_LAYOUT_IDS,
  type ComposeLine,
  type TextLayout,
  type TextVariation,
} from "./textCompose";
import { partialWrites, syncToSpeech, type SyncReport } from "./cueSync";
import { requireTextLook, type TextLook } from "./textLooks";
import {
  MOVE_STRENGTH_MAX,
  MOVE_STRENGTH_MIN,
  TEXT_MOVE_IDS,
  type TextMoveId,
} from "./textMotion";
import { queueWatchSweep, withSweepPaused } from "./watch/sweep";
import { synthesizeMusic } from "./audioGen";
import { composeMusicPrompt } from "./composeGen";
import { stockAssetInDoc } from "./genvideo/docWriter";
import { resolveVoice, synthesizeSpeech, SPEECH_VOICES } from "./tts";
import { defaultVideoAspects } from "./videoModels";
import { DUCK_DEFAULT, generateSubtitlesReadout } from "./voiceover";
import {
  allFonts,
  ANIM_DEFAULT_SECONDS,
  ANIM_STYLE_IDS,
  CLIP_MAX_ZOOM,
  clipCovers,
  DEFAULT_BACKGROUND,
  clampOverlayPos,
  clipZoom,
  frameOf,
  IMAGE_CLIP_SECONDS,
  isEffectOverlay,
  isTextOverlay,
  LAYOUTS,
  MAX_SUBTITLE_LANES,
  mediaUrl,
  nearestAspect,
  normalizeAspect,
  overlayAnimStyle,
  projectBackground,
  rectOf,
  regionLabel,
  SHAPE_LABELS,
  SIDE_PANEL_TABS,
  SPEED_FLOOR,
  TRANSITION_STYLE_IDS,
  type AnimStyle,
  type AssetWatch,
  type CaptionStyleId,
  type AudioClip,
  type ClipShadow,
  type ColorGrade,
  type FontId,
  type MediaAsset,
  type Selection,
  type ShapeKind,
  type SidePanelTab,
  type TransitionStyle,
  type VideoClip,
} from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The timeline rows a mutation touched, small enough to ride every result:
 * ids, starts, and lengths for track 0 and the soundtrack, read fresh after
 * the store settled. The model keeps editing from these — new ids after a
 * split, closed-up starts after a delete — with no get_state poll between
 * steps.
 *
 * `parkedTransitions` rides along: a bar the edit left lining up with
 * nothing. The model sees its own debris the moment it makes it, in the same
 * payload it already reads, so a stranded blend gets cleared or reattached
 * inside the turn instead of sitting on the row. */
function tracksAfter() {
  const cur = useEditor.getState();
  const row = track0Clips(cur.clips).map((c) => ({
    id: c.id,
    start: round2(c.start),
    len: round2((c.out - c.in) / (c.speed && c.speed > 0 ? c.speed : 1)),
  }));
  const lanes = cur.audioClips.map((a) => ({
    id: a.id,
    start: round2(a.start),
    len: round2(a.out - a.in),
  }));
  const parked = parkedTransitions(cur.clips, cur.transitions);
  return {
    track0: row.slice(0, 60),
    ...(row.length > 60 ? { track0Truncated: true } : {}),
    soundtrack: lanes.slice(0, 60),
    ...(lanes.length > 60 ? { soundtrackTruncated: true } : {}),
    ...(parked.length > 0
      ? {
          parkedTransitions: parked.map((t) => ({
            id: t.id,
            start: round2(t.start),
            seconds: round2(t.seconds),
            style: t.style,
          })),
          parkedTransitionsNote:
            "These transition bars line up with no cut or clip edge and play nothing. Clear each one with remove_transition, or reattach it with set_transition/set_animation on the edge it belongs to. If it isn't clear which the user wanted, say what's there and ask.",
        }
      : {}),
  };
}

/** The model crosses the transition and animation vocabularies — the retired
 * edge styles (fadein/zoomin/…) especially. Style ids arrive as structured
 * tool input, so resolve each known synonym to the nearest supported style. */
const TRANSITION_STYLE_SYNONYMS: Record<string, TransitionStyle> = {
  fade: "crossfade",
  fadein: "crossfade",
  fadeout: "crossfade",
  dissolve: "crossfade",
  zoom: "crosszoom",
  zoomin: "crosszoom",
  zoomout: "crosszoom",
  slideleft: "pushleft",
  slideright: "pushright",
  slideup: "pushup",
  slidedown: "pushdown",
};

const ANIM_STYLE_SYNONYMS: Record<string, AnimStyle> = {
  crossfade: "fade",
  fadein: "fade",
  fadeout: "fade",
  dipblack: "fade",
  dipwhite: "fade",
  blur: "fade",
  crosszoom: "zoom",
  zoomin: "zoom",
  zoomout: "zoom",
  pushleft: "slideleft",
  pushright: "slideright",
  pushup: "slideup",
  pushdown: "slidedown",
  wipeleft: "slideleft",
  wiperight: "slideright",
  wipeup: "slideup",
  wipedown: "slidedown",
};

/** The basic sliders the grade tool patches — the panel's field list plus the
 * legacy pair, so the schema and handler can never disagree. */
const GRADE_KEYS = [...GRADE_BASIC_FIELDS.map((f) => f.key), "brightness", "hue"] as const;

/** Color stats for a grading reference: a clip's current decoded frame
 * (pre-grade, like Auto reads) or an image asset's pixels. */
async function colorStatsForRef(
  s: ReturnType<typeof useEditor.getState>,
  ref: { clipId?: string; assetId?: string }
): Promise<ColorStats> {
  if (ref.clipId) {
    const clip = requireItem(s.clips, ref.clipId, "video clip");
    const data = sampleClipFrameData(clip.id, 192, 108);
    if (!data)
      throw new ToolError(
        "No decoded frame for that clip yet — seek into it so it is on screen, then retry."
      );
    const stats = colorStatsFromImageData(data);
    if (!stats) throw new ToolError("Could not read pixels off that clip's frame.");
    return stats;
  }
  if (ref.assetId) {
    const asset = requireItem(s.assets, ref.assetId, "project asset");
    if (asset.type !== "image")
      throw new ToolError(
        "Color stats read images and clip frames — for a video asset, place it on the timeline and pass its clip id."
      );
    const img = await decodeRasterImageUrl(asset.url);
    if (!img || !img.width) throw new ToolError("Could not decode that image.");
    const w = 192;
    const h = Math.max(1, Math.round((img.height / img.width) * w));
    const c = createRasterCanvas(w, h);
    const ctx = c.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) throw new ToolError("Could not read that image's pixels.");
    ctx.drawImage(img.source, 0, 0, w, h);
    const stats = colorStatsFromImageData(ctx.getImageData(0, 0, w, h).data);
    if (!stats) throw new ToolError("Could not read pixels off that image.");
    return stats;
  }
  throw new ToolError("Pass clipId or assetId.");
}

/** Stats shaped for the model: rounded, with the quantile probes labeled. */
function statsReport(stats: ColorStats) {
  const r1 = (v: number) => Math.round(v * 100) / 100;
  return {
    quantiles: "values 0..255 at p2, p10, p25, p50, p75, p90, p98",
    r: stats.r,
    g: stats.g,
    b: stats.b,
    luma: stats.luma,
    meanR: Math.round(stats.meanR),
    meanG: Math.round(stats.meanG),
    meanB: Math.round(stats.meanB),
    meanSat: r1(stats.meanSat),
    warmth: r1(stats.warmth),
  };
}

/** Long side of a captured frame: enough for the model to read a title, small
 * enough to ride a turn. */
const CAPTURE_LONG_SIDE = 640;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The row an element tool was aimed at, if it named one. Rows are how
 * elements stack, row 0 at the front: two on the same row slide clear of each
 * other, so a title that has to sit over a shape names a lower row than it. */
const aimedLane = (input: Record<string, unknown>): { lane?: number } | undefined =>
  isNum(input.lane) ? { lane: Math.max(0, Math.round(input.lane)) } : undefined;

/** Every tool that runs in the browser: the full catalog minus the
 * `server: true` skills tools the engine answers itself. */
type BrowserToolName = Exclude<
  | AiPanelToolName
  | AudioToolName
  | EditorToolName
  | EffectsToolName
  | ElementsToolName
  | ImageGenToolName
  | InspectorToolName
  | LibraryToolName
  | OverlayAnimationToolName
  | PreviewToolName
  | SceneToolName
  | SidePanelToolName
  | StockToolName
  | SubtitlesToolName
  | TimelineToolName
  | TopBarToolName
  | TransitionsToolName
  | VideoGenToolName,
  "list_skills" | "read_skill"
>;

type Editor = ReturnType<typeof useEditor.getState>;

type ToolRun = (s: Editor, input: Record<string, unknown>) => Promise<unknown> | unknown;

/** The browser handler for every tool, keyed by the names the `*.tools.ts`
 * modules beside the components export, so a tool added, removed, or renamed
 * there refuses to compile until this map matches. */
const toolRuns: Record<BrowserToolName, ToolRun> = {
  add_shape: (s, input) => {
    const shape = String(input.shape) as ShapeKind;
    if (!(shape in SHAPE_LABELS))
      throw new ToolError(`shape must be one of ${SHAPE_KINDS.join(", ")}.`);
    if (isNum(input.start)) s.seek(input.start);
    s.addShape(shape, aimedLane(input));
    const sel = useEditor.getState().selection;
    if (sel?.kind !== "overlay") throw new ToolError("Could not create the shape.");
    applyOverlayPatchSettled(sel.id, overlayPatch({ ...input, id: sel.id }, "shape"));
    const o = useEditor.getState().overlays.find((x) => x.id === sel.id)!;
    return { id: o.id, shape, start: round2(o.start), end: round2(o.end) };
  },

  add_sticker: (s, input) => {
    const assetId = typeof input.asset_id === "string" && input.asset_id ? input.asset_id : undefined;
    if (!assetId) throw new ToolError("Pass asset_id.");
    const stickerAsset = s.assets.find((a) => a.id === assetId);
    if (stickerAsset?.type !== "image") throw new ToolError(`No image asset with id ${assetId}.`);
    if (isNum(input.start)) s.seek(input.start);
    s.addSticker({ assetId, ...(isLottieAsset(stickerAsset) ? { lottie: true } : {}), ...aimedLane(input) });
    const sel = useEditor.getState().selection;
    if (sel?.kind !== "overlay") throw new ToolError("Could not create the sticker.");
    applyOverlayPatchSettled(sel.id, overlayPatch({ ...input, id: sel.id }, "sticker"));
    const o = useEditor.getState().overlays.find((x) => x.id === sel.id)!;
    return { id: o.id, assetId, start: round2(o.start), end: round2(o.end) };
  },

  create_sticker: async (s, input) => {
    const idea = String(input.idea ?? "").trim();
    if (!idea) throw new ToolError("idea is required.");
    if (!s.projectId) throw new ToolError("No project open.");
    const { createCustomSticker } = await import("./stickerCreate");
    const asset = await createCustomSticker(s.projectId, idea);
    if (isNum(input.start)) s.seek(input.start);
    useEditor.getState().addSticker({ assetId: asset.id, ...aimedLane(input) });
    const sel = useEditor.getState().selection;
    if (sel?.kind !== "overlay") throw new ToolError("Could not place the sticker.");
    applyOverlayPatchSettled(sel.id, overlayPatch({ ...input, id: sel.id }, "sticker"));
    const o = useEditor.getState().overlays.find((x) => x.id === sel.id)!;
    return { id: o.id, assetId: asset.id, start: round2(o.start), end: round2(o.end) };
  },

  add_effect: (s, input) => {
    const effect = String(input.effect ?? "");
    if (!(EFFECT_IDS as string[]).includes(effect))
      throw new ToolError(`effect must be one of ${EFFECT_IDS.join(", ")}.`);
    if (isNum(input.start)) s.seek(input.start);
    s.addEffect(effect as EffectId, aimedLane(input));
    const sel = useEditor.getState().selection;
    if (sel?.kind !== "overlay") throw new ToolError("Could not create the effect.");
    applyOverlayPatchSettled(sel.id, overlayPatch({ ...input, id: sel.id }, "effect"));
    // Where a zoom holds: the rest of the effects fill the frame, so the
    // point only means anything for this one.
    if (effect === "zoom" && (isNum(input.focus_x) || isNum(input.focus_y))) {
      useEditor.getState().updateOverlay(sel.id, {
        focus: {
          x: clamp(isNum(input.focus_x) ? input.focus_x : 0.5, 0, 1),
          y: clamp(isNum(input.focus_y) ? input.focus_y : 0.5, 0, 1),
        },
      });
    }
    const o = useEditor.getState().overlays.find((x) => x.id === sel.id)!;
    return { id: o.id, effect, start: round2(o.start), end: round2(o.end) };
  },

  set_overlay_animation: (s, input) => {
    const o = requireItem(s.overlays, input.id, "overlay element");
    const anim: OverlayAnim = { ...(o.anim ?? {}) };
    const edge = (slot: "in" | "out", styleKey: string, secondsKey: string) => {
      const raw = input[styleKey];
      const secs = isNum(input[secondsKey])
        ? clamp(input[secondsKey], OVERLAY_ANIM_MIN_SECONDS, OVERLAY_ANIM_MAX_SECONDS)
        : undefined;
      if (typeof raw === "string") {
        if (raw === "none") {
          delete anim[slot];
          return;
        }
        if (!(OVERLAY_ANIM_STYLE_IDS as string[]).includes(raw))
          throw new ToolError(`Unknown ${slot} style: ${raw}`);
        if (raw === "typewriter" && (o.kind ?? "text") !== "text")
          throw new ToolError("typewriter animates titles only.");
        anim[slot] = {
          style: raw as OverlayAnimStyle,
          seconds: secs ?? anim[slot]?.seconds ?? OVERLAY_ANIM_DEFAULT_SECONDS,
        };
      } else if (secs !== undefined && anim[slot]) {
        anim[slot] = { ...anim[slot]!, seconds: secs };
      }
    };
    edge("in", "in_style", "in_seconds");
    edge("out", "out_style", "out_seconds");
    if (typeof input.move === "string") {
      if (input.move === "none") delete anim.move;
      else {
        if (!TEXT_MOVE_IDS.includes(input.move))
          throw new ToolError(`Unknown move: ${input.move}. Use one of: ${TEXT_MOVE_IDS.join(", ")}.`);
        const strength = isNum(input.move_strength)
          ? clamp(input.move_strength, MOVE_STRENGTH_MIN, MOVE_STRENGTH_MAX)
          : (anim.move?.strength ?? 1);
        anim.move = { style: input.move, strength };
      }
    } else if (isNum(input.move_strength) && anim.move) {
      anim.move = {
        ...anim.move,
        strength: clamp(input.move_strength, MOVE_STRENGTH_MIN, MOVE_STRENGTH_MAX),
      };
    }
    const rawLoop = input.loop_style;
    const speed = isNum(input.loop_speed) ? clamp(input.loop_speed, 0.25, 4) : undefined;
    if (typeof rawLoop === "string") {
      if (rawLoop === "none") delete anim.loop;
      else if (!(OVERLAY_LOOP_STYLE_IDS as string[]).includes(rawLoop))
        throw new ToolError(`Unknown loop style: ${rawLoop}`);
      else anim.loop = { style: rawLoop as OverlayLoopStyle, speed: speed ?? anim.loop?.speed ?? 1 };
    } else if (speed !== undefined && anim.loop) {
      anim.loop = { ...anim.loop, speed };
    }
    s.updateOverlay(o.id, {
      anim: anim.in || anim.out || anim.loop || anim.move ? anim : undefined,
    });
    const next = useEditor.getState().overlays.find((x) => x.id === o.id)!;
    return { id: next.id, anim: next.anim ?? null };
  },

  set_overlay_keyframes: (s, input) => {
    const o = requireItem(s.overlays, input.id, "overlay element");
    const raw = input.keys;
    if (!Array.isArray(raw)) throw new ToolError("keys must be a list.");
    const dur = Math.max(0.1, o.end - o.start);
    let kf = o.kf;
    if (raw.length === 0) {
      s.clearOverlayKeys(o.id);
      kf = undefined;
    } else {
      // Each key builds on the pose already at its time, so a key that only
      // names `x` keeps whatever the element was doing otherwise.
      s.pushHistory();
      for (const k of raw as Record<string, unknown>[]) {
        if (!isNum(k.t)) throw new ToolError("Every key needs a time `t`.");
        s.setOverlayKey(
          o.id,
          clamp(k.t, 0, dur),
          {
            ...(isNum(k.x) ? { x: clamp(k.x, 0.02, 0.98) } : {}),
            ...(isNum(k.y) ? { y: clamp(k.y, 0.02, 0.98) } : {}),
            ...(isNum(k.scale) ? { scale: clamp(k.scale, 0.1, 4) } : {}),
            ...(isNum(k.rotation) ? { rotation: clamp(Math.round(k.rotation), -180, 180) } : {}),
            ...(isNum(k.opacity) ? { opacity: clamp(k.opacity, 0, 1) } : {}),
          },
          { transient: true }
        );
      }
      kf = useEditor.getState().overlays.find((x) => x.id === o.id)?.kf;
    }
    return { id: o.id, keys: (kf ?? []).map((k) => ({ ...k, t: round2(k.t) })) };
  },

  set_clip_keyframes: (s, input) => {
    const clip = requireItem(s.clips, input.clipId, "video clip");
    const raw = input.keys;
    if (!Array.isArray(raw)) throw new ToolError("keys must be a list.");
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const dur = Math.max(0.1, (clip.out - clip.in) / speed);
    let kf = clip.kf;
    if (raw.length === 0) {
      s.clearClipKeys(clip.id);
      kf = undefined;
    } else {
      // Each key builds on the pose already at its time, so a key that only
      // names `x` keeps whatever the clip was doing otherwise.
      s.pushHistory();
      for (const k of raw as Record<string, unknown>[]) {
        if (!isNum(k.t)) throw new ToolError("Every key needs a time `t`.");
        s.setClipKey(
          clip.id,
          clamp(k.t, 0, dur),
          {
            ...(isNum(k.x) ? { x: clamp(k.x, -0.5, 1.5) } : {}),
            ...(isNum(k.y) ? { y: clamp(k.y, -0.5, 1.5) } : {}),
            ...(isNum(k.scale) ? { scale: clamp(k.scale, 0.1, 4) } : {}),
            ...(isNum(k.rotation) ? { rotation: clamp(Math.round(k.rotation), -180, 180) } : {}),
            ...(isNum(k.opacity) ? { opacity: clamp(k.opacity, 0, 1) } : {}),
          },
          { transient: true }
        );
      }
      kf = useEditor.getState().clips.find((c) => c.id === clip.id)?.kf;
    }
    return { id: clip.id, keys: (kf ?? []).map((k) => ({ ...k, t: round2(k.t) })) };
  },

  set_mask: (s, input) => {
    // One id space: an overlay element or a video clip on any track.
    const o = s.overlays.find((x) => x.id === input.id);
    const clip = o ? undefined : s.clips.find((c) => c.id === input.id);
    if (!o && !clip)
      throw new ToolError("No overlay element or video clip with that id.");
    if (o && isEffectOverlay(o)) throw new ToolError("Effect elements have no pixels to mask.");
    const current = o ? o.mask : clip!.mask;
    const setMask = (mask: Mask | undefined) =>
      o ? s.updateOverlay(o.id, { mask }) : s.updateClip(clip!.id, { mask });
    if (input.kind === "none") {
      setMask(undefined);
      return { id: input.id, mask: null };
    }
    const kinds = ["rect", "square", "circle", "linear", "mirror", "subject"];
    const kind =
      typeof input.kind === "string"
        ? input.kind
        : (current?.kind ?? "rect");
    if (!kinds.includes(kind)) throw new ToolError(`Unknown mask kind. Use one of: ${kinds.join(", ")}, none.`);
    const geom = (k: Record<string, unknown>) => ({
      ...(isNum(k.x) ? { x: clamp(k.x, -1, 1) } : {}),
      ...(isNum(k.y) ? { y: clamp(k.y, -1, 1) } : {}),
      ...(isNum(k.w) ? { w: clamp(k.w, 0.01, 2) } : {}),
      ...(isNum(k.h) ? { h: clamp(k.h, 0.01, 2) } : {}),
      ...(isNum(k.rotation) ? { rotation: clamp(Math.round(k.rotation), -180, 180) } : {}),
      ...(isNum(k.feather) ? { feather: clamp(k.feather, 0, 200) } : {}),
    });
    const mask: Mask = {
      ...(current ?? {}),
      ...geom(input),
      kind: kind as Mask["kind"],
      ...(typeof input.invert === "boolean" ? { invert: input.invert || undefined } : {}),
      ...(isNum(input.radius) ? { radius: clamp(input.radius, 0, 400) || undefined } : {}),
    };
    // A circle with no explicit h is a perfect circle: w and h are fractions
    // of different frame edges, so round means unequal fractions.
    if (mask.kind === "circle" && !isNum(input.h)) {
      const fr = frameOf(s.aspect);
      mask.h = clamp(((mask.w ?? 0.5) * fr.w) / fr.h, 0.01, 2);
    }
    setMask(mask);
    // Keys layer on after the mask lands, so each one captures against the
    // geometry the call just set.
    const raw = input.keys;
    if (Array.isArray(raw)) {
      const st = useEditor.getState();
      const dur = o
        ? Math.max(0.1, o.end - o.start)
        : Math.max(0.1, (clip!.out - clip!.in) / (clip!.speed && clip!.speed > 0 ? clip!.speed : 1));
      if (raw.length === 0) {
        if (o) st.clearOverlayMaskKeys(o.id);
        else st.clearClipMaskKeys(clip!.id);
      } else {
        for (const k of raw as Record<string, unknown>[]) {
          if (!isNum(k.t)) throw new ToolError("Every mask key needs a time `t`.");
          const t = clamp(k.t, 0, dur);
          if (o) st.setOverlayMaskKey(o.id, t, geom(k), { transient: true });
          else st.setClipMaskKey(clip!.id, t, geom(k), { transient: true });
        }
      }
    }
    const after = useEditor.getState();
    const next = o
      ? after.overlays.find((x) => x.id === o.id)?.mask
      : after.clips.find((c) => c.id === clip!.id)?.mask;
    return { id: input.id, mask: next ?? null };
  },

  set_transition: (s, input) => {
    const clip = requireItem(s.clips, input.clipId, "video clip");
    // A transition joins a clip to the next one on its own track.
    const row = s.clips.filter((c) => c.track === clip.track);
    if (row.findIndex((c) => c.id === clip.id) === row.length - 1)
      throw new ToolError("That is its track's last clip — nothing after it to transition into.");
    if (!isNum(input.seconds)) throw new ToolError("seconds is required (0 clears the transition).");
    let style: TransitionStyle | undefined;
    if (input.style !== undefined) {
      const requested = TRANSITION_STYLE_SYNONYMS[input.style as string] ?? input.style;
      style = TRANSITION_STYLE_IDS.find((x) => x === requested);
      if (!style) throw new ToolError(`Unknown style. Use one of: ${TRANSITION_STYLE_IDS.join(", ")}.`);
    }
    s.setClipTransition(clip.id, input.seconds, style);
    const after = useEditor.getState();
    const next = after.clips.find((c) => c.id === clip.id)!;
    // The bar's own id rides the result so remove_transition can round-trip it.
    const roles = resolveTransitions(after.clips, after.transitions);
    const bar = after.transitions.find((t) =>
      (roles.get(t.id) ?? []).some((r) => r.kind !== "in" && r.clipId === clip.id)
    );
    return {
      id: next.id,
      transitionId: bar?.id ?? null,
      transition: next.transition ?? 0,
      style: next.transitionStyle ?? "crossfade",
    };
  },

  remove_transition: (s, input) => {
    const id = String(input.transitionId ?? "");
    if (!s.transitions.some((t) => t.id === id))
      throw new ToolError(`No transition bar with id ${id}.`);
    s.removeTransition(id);
    return { removed: id, ...tracksAfter() };
  },

  set_animation: (s, input) => {
    const clip = requireItem(s.clips, input.clipId, "video clip");
    const which = input.which === "in" || input.which === "out" ? input.which : null;
    if (!which) throw new ToolError('which must be "in" or "out".');
    if (input.style === "none") {
      s.setClipAnim(clip.id, which, null);
      return { id: clip.id, which, style: "none" };
    }
    const requested = ANIM_STYLE_SYNONYMS[input.style as string] ?? input.style;
    const style = ANIM_STYLE_IDS.find((x) => x === requested);
    if (!style)
      throw new ToolError(`Unknown style. Use one of: ${ANIM_STYLE_IDS.join(", ")}, none.`);
    if (clip.track > 0 && overlayAnimStyle(style) !== style)
      throw new ToolError("Upper-track clips animate with fade or zoom only.");
    const seconds = isNum(input.seconds) ? input.seconds : ANIM_DEFAULT_SECONDS;
    s.setClipAnim(clip.id, which, { style, seconds });
    const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
    const anim = which === "in" ? next.animIn : next.animOut;
    return { id: next.id, which, style: anim?.style ?? "none", seconds: anim?.seconds ?? 0 };
  },

  get_state: () => {
      // The tool result carries the whole transcript; the per-message context
      // snapshot trims it, so this is how the model pulls every cue when needed.
      return buildAiContext({ fullCues: true });
  },

  capture_frame: async (s, input) => {
      // Composited through the render path, so the frame carries what the
      // finished file would carry — clips, transitions, effects, elements,
      // captions, the project fade — rather than the preview's video layer
      // with its DOM elements floating above it.
      const total = totalDuration(s.clips);
      const at = clamp(isNum(input.t) ? input.t : playheadAt(), 0, Math.max(0, total - 0.001));
      const frame = frameOf(s.aspect);
      const k = CAPTURE_LONG_SIDE / Math.max(frame.w, frame.h);
      const canvas = await renderProjectFrame(
        {
          aspect: s.aspect,
          assets: s.assets,
          clips: s.clips,
          audioClips: s.audioClips,
          overlays: s.overlays,
          subtitles: s.subtitles,
          fadeIn: s.fadeIn,
          fadeOut: s.fadeOut,
          background: s.background,
        },
        at,
        { width: Math.round(frame.w * k), height: Math.round(frame.h * k) },
        (asset) => asset.url
      ).catch((e) => {
        throw new ToolError(e instanceof Error ? e.message : "Could not draw the frame.");
      });
      return { image: await rasterCanvasToDataUrl(canvas, "image/jpeg", 0.75), at };
  },

  watch_video: async (s, input) => {
      const { asset, clip, speed, from, to } = resolveWatchRange(s, input);
      // The reading of the last look comes before the next one. Without it a
      // long source is watched into a conversation that keeps dropping the
      // sheets, and the tail arrives with the head already gone.
      const owed = unwritten.get(asset.id);
      if (owed && !spanIsNoted(asset.watch, owed))
        throw new ToolError(
          `You watched ${round2(owed.from)}-${round2(owed.to)}s of "${asset.name}" and have not written down what it showed. ` +
            "Those sheets leave this conversation as it grows, so record them while you can still see them: call note_source with what that stretch showed — the on-screen text word for word, what happens, how it is shot, the timings — then watch on."
        );
      if (asset.type === "audio")
        throw new ToolError(`"${asset.name}" is audio — listen_audio hears it, detect_silence finds its dead air.`);
      // One path for both backends: the browser decodes the source (the same
      // URL the preview plays) and the shared selector keeps distinct frames.
      if (asset.type === "image") {
        const body = await makeStillFrame(asset.url).catch((e) => {
          throw new ToolError(e instanceof Error ? e.message : "Could not read the image.");
        });
        return {
          images: [body.frames[0].image],
          source: { assetId: asset.id, name: asset.name },
          note: "A still image — one frame, no time axis.",
        };
      }
      // The sweep yields its decoders to this call for its whole duration.
      // The budget keeps the call inside the tool bridge's 120s deadline: a
      // slow decode salvages what it covered (truncated + coveredTo) rather
      // than timing out with nothing.
      const body = await withSweepPaused(() =>
        sampleWatchFrames(asset.url, {
          from,
          ...(to !== undefined ? { to } : {}),
          ...(isNum(input.interval_seconds) ? { interval: input.interval_seconds } : {}),
          budgetMs: 90_000,
        })
      ).catch((e) => {
        throw new ToolError(e instanceof Error ? e.message : "Could not watch the video.");
      });
      // The metadata persists on the asset (it saves with the project and
      // dies with the asset), so what has been seen survives this thread.
      // Merge against the asset's CURRENT record — a sweep segment may have
      // landed while this call was decoding, and a merge computed from the
      // pre-decode snapshot would overwrite it.
      const st = useEditor.getState();
      const liveAsset = st.assets.find((x) => x.id === asset.id);
      if (liveAsset) {
        // A pass that covered nothing records nothing.
        if (body.coveredTo > from) {
          st.updateAsset(asset.id, {
            watch: mergeWatch(liveAsset.watch, {
              from,
              to: body.coveredTo,
              frames: body.frames.map((f) => ({ t: f.t, via: f.via })),
              sceneChanges: body.sceneChanges,
            }),
          });
        }
        // A source with more to see owes a reading of what just went past:
        // the next watch of it asks for this span's notes first.
        if (body.coveredTo > from && asset.duration - body.coveredTo > 0.5)
          unwritten.set(asset.id, { from: round2(from), to: round2(body.coveredTo) });
        else unwritten.delete(asset.id);
        // A first look queues the quiet background sweep of the rest of the
        // source — metadata only, merged in as segments land.
        queueWatchSweep(asset.id);
      }
      const unwatched = uncoveredSeconds(
        useEditor.getState().assets.find((x) => x.id === asset.id)?.watch,
        asset.duration
      );
      // Tile the kept frames 3×3 and stamp each cell's source time.
      const sheets = await composeSheets(body.frames).catch(() => null);
      const keptTimes = body.frames.map((f) => f.t);
      // Kept frames woven into the speech on one clock, so the model reads
      // precomputed frame↔speech alignment. Project captions win (cue times
      // are timeline seconds, mapped to source through the clip); with none,
      // the asset's own transcript serves — it is already source time, so it
      // fuses for asset-only watches too.
      let speech: { start: number; end: number; text: string }[] = [];
      if (clip) {
        speech = laneCues(s.subtitles, s.subtitleLane)
          .map((c) => ({
            start: clip.in + (c.start - clip.start) * speed,
            end: clip.in + (c.end - clip.start) * speed,
            text: c.text,
          }))
          .filter((c) => c.end > from && c.start < body.coveredTo);
      }
      if (speech.length === 0) speech = (liveAsset ?? asset).speech?.segments ?? [];
      let timelineText: string | undefined;
      if (speech.length > 0) {
        timelineText = renderFusedTimeline(
          fuseTimeline(keptTimes, speech, { from, to: body.coveredTo })
        ).slice(0, 4000);
      }
      // Each cell's time plus why the selector kept it — "global" a hard cut,
      // "action" local motion, "settled" new settled detail (text, ink, UI).
      const cellInfo = body.frames.map((f) => ({ t: round2(f.t), via: f.via }));
      const perSheet = sheets ? sheets.map((sh) => sh.frames.length) : [cellInfo.length];
      let cellAt = 0;
      return {
        images: sheets ? sheets.map((sh) => sh.image) : body.frames.map((f) => f.image),
        sheetFrames: perSheet.map((n) => cellInfo.slice(cellAt, (cellAt += n))),
        distinctFrames: body.frames.length,
        candidates: body.candidates,
        sceneChanges: body.sceneChanges.map(round2),
        coveredTo: round2(body.coveredTo),
        truncated: body.truncated,
        // What NOBODY has looked at, anywhere in the source — the union of
        // every watched span subtracted from its length, so a watch aimed at
        // the middle counts the head it skipped as well as the tail it never
        // reached. `truncated` only says whether the sampler stopped early,
        // and a caller who passed a short `to` gets truncated: false; this is
        // the honest number, stated in the payload and in the note.
        unwatchedSeconds: unwatched,
        // The written record of this source, which outlives the sheets: what
        // was already noted about the stretch on screen now, and the spans of
        // the source nothing has been written about yet.
        recorded: notesIn((liveAsset ?? asset).watch, from, body.coveredTo),
        unnoted: unnotedSpans((liveAsset ?? asset).watch, asset.duration).map((g) => ({
          from: round2(g.from),
          to: round2(g.to),
        })),
        source: { assetId: asset.id, name: asset.name, duration: round2(asset.duration) },
        ...(clip
          ? {
              clip: {
                id: clip.id,
                timelineStart: round2(clip.start),
                in: round2(clip.in),
                out: round2(clip.out),
                speed: round2(speed),
                note: `timeline_t = ${round2(clip.start)} + (source_t - ${round2(clip.in)}) / ${round2(speed)}, for source_t in [${round2(clip.in)}, ${round2(clip.out)}]`,
              },
            }
          : {}),
        ...(timelineText ? { timeline: timelineText } : {}),
        note:
          "Cells read left→right then top→bottom; each stamp is SOURCE seconds. " +
          "Cells are distinct moments (near-duplicates removed), so gaps between stamps mean nothing changed there. " +
          "sheetFrames says why each cell was kept: global = hard cut, action = local motion, settled = new settled detail (text/UI)." +
          (unwatched > 0.5
            ? ` You have seen ${round2(from)}-${round2(body.coveredTo)}s of a ${round2(asset.duration)}s source; ` +
              `${unwatched}s of it has NOT been looked at (this call's range plus anything else already watched)` +
              (body.truncated ? " (this call hit its budget)" : " (your own `to` ended this call)") +
              `. Call again with from=${round2(body.coveredTo)} to continue — and do continue before describing, summarizing, or reproducing the source as a whole.`
            : "") +
          " These sheets are in this conversation only, and it drops the oldest media as it grows. Write what they showed into note_source now — text word for word, what happens, the timings — and the reading stays on the source for every later turn and every later chat." +
          (sheets ? "" : " (Sheets unavailable — each image is one frame; sheetFrames lists the times.)"),
      };
  },

  note_source: (s, input) => {
      const { asset } = resolveWatchTarget(s, input);
      const raw = Array.isArray(input.notes) ? input.notes : [];
      const notes = raw
        .filter((n): n is Record<string, unknown> => typeof n === "object" && n !== null)
        .map((n) => ({
          from: isNum(n.from) ? clamp(n.from, 0, asset.duration) : 0,
          to: isNum(n.to) ? clamp(n.to, 0, asset.duration) : asset.duration,
          text: typeof n.text === "string" ? n.text.trim() : "",
        }))
        .filter((n) => n.text.length > 0);
      if (notes.length === 0)
        throw new ToolError("Pass notes: [{from, to, text}] — source seconds and what that stretch showed.");
      s.updateAsset(asset.id, { watch: mergeWatchNotes(asset.watch, notes) });
      const cur = useEditor.getState().assets.find((a) => a.id === asset.id);
      const owed = unwritten.get(asset.id);
      if (owed && spanIsNoted(cur?.watch, owed)) unwritten.delete(asset.id);
      const unnoted = unnotedSpans(cur?.watch, asset.duration);
      return {
        source: { assetId: asset.id, name: asset.name, duration: round2(asset.duration) },
        notes: (cur?.watch?.notes ?? []).map((n) => ({
          from: round2(n.from),
          to: round2(n.to),
          text: n.text,
        })),
        unnoted: unnoted.map((g) => ({ from: round2(g.from), to: round2(g.to) })),
        note:
          "Written onto the source: it saves with the project, rides the editor state from here on, and outlives this conversation's images." +
          (unnoted.length > 0
            ? ` Still undescribed: ${unnoted
                .map((g) => `${round2(g.from)}-${round2(g.to)}s`)
                .join(", ")}.`
            : " The whole source is described."),
      };
  },

  detect_silence: async (s, input) => {
      const { projectId, asset, clip, speed, from, to } = resolveWatchRange(s, input);
      if (asset.type === "image") throw new ToolError(`"${asset.name}" is an image — it has no audio.`);
      const silences = await fetchSilences(projectId, asset, {
        from,
        ...(to !== undefined ? { to } : {}),
        ...(isNum(input.threshold_db) ? { thresholdDb: input.threshold_db } : {}),
        ...(isNum(input.min_silence) ? { minSilence: input.min_silence } : {}),
      });
      // Pre-map each silence's overlap with the clip's trimmed range onto the
      // timeline so the model cuts on ready numbers.
      const toTimeline = (t: number) =>
        round2(clip!.start + (clamp(t, clip!.in, clip!.out) - clip!.in) / speed);
      return {
        silences: silences.map((x) => ({
          start: round2(x.start),
          end: round2(x.end),
          duration: round2(x.duration),
          ...(clip && x.end > clip.in && x.start < clip.out
            ? { timeline: { start: toTimeline(x.start), end: toTimeline(x.end) } }
            : {}),
        })),
        source: { assetId: asset.id, name: asset.name, duration: round2(asset.duration) },
        ...(clip
          ? {
              clip: {
                id: clip.id,
                timelineStart: round2(clip.start),
                in: round2(clip.in),
                out: round2(clip.out),
                speed: round2(speed),
              },
            }
          : {}),
        ...(silences.length === 0
          ? { note: "No silence at these settings — a higher threshold_db or shorter min_silence hears more." }
          : {}),
      };
  },

  listen_audio: async (s, input) => {
      const { projectId, asset, clip, from, to } = resolveWatchRange(s, input);
      if (asset.type === "image")
        throw new ToolError(`"${asset.name}" is an image — it has no sound. watch_video shows it.`);
      // A whole audio asset rides its own file bytes. A video, or any trimmed
      // range, gets its audio track pulled off by the engine first — so the
      // muxed video never travels and a long source still fits the inline cap.
      const wholeAudio = asset.type === "audio" && !clip && !isNum(input.from) && !isNum(input.to);
      const inline = wholeAudio
        ? await refToInlineAudio(refFromAsset(asset))
        : await listenToSource(projectId, asset, from, to);
      // Listening shows interest in the source's sound — queue the background
      // sweep so its transcript (and, for video, its visual map) fills in.
      queueWatchSweep(asset.id);
      if (!inline)
        throw new ToolError(
          "That stretch is too long to listen to inline (≈12MB cap) — pass a narrower from/to."
        );
      // The `audio` data URL leaves the JSON in the chat transport and rides
      // to the model as an input_audio part, the way attachments do.
      return {
        name: asset.name,
        duration: round2(asset.duration),
        ...(clip ? { clipId: clip.id } : {}),
        ...(from > 0 ? { from: round2(from) } : {}),
        ...(to !== undefined ? { to: round2(to) } : {}),
        audio: `data:${inline.mimeType};base64,${inline.data}`,
      };
  },

  seek: (s, input) => {
      if (!isNum(input.t)) throw new ToolError("t (seconds) is required.");
      s.seek(input.t);
      return { playhead: playheadAt() };
  },

  set_playing: (s, input) => {
      s.setPlaying(Boolean(input.playing));
      return { playing: Boolean(input.playing) };
  },

  select: (s, input) => {
      const kind = String(input.kind);
      if (kind === "none") {
        s.select(null);
        return { selection: null };
      }
      const id = String(input.id ?? "");
      // A video clip on any track selects as "clip"; "overlayClip" is accepted
      // as a legacy alias for a layer clip and "text" for an overlay element.
      const pool =
        kind === "clip" || kind === "overlayClip"
          ? s.clips
          : kind === "audio"
            ? s.audioClips
            : kind === "overlay" || kind === "text"
              ? s.overlays
              : null;
      if (!pool) throw new ToolError(`Unknown kind: ${kind}`);
      if (!pool.some((x) => x.id === id)) throw new ToolError(`No ${kind} with id ${id}.`);
      const selKind =
        kind === "overlayClip" ? "clip" : kind === "text" ? "overlay" : (kind as "clip" | "audio" | "overlay");
      s.select({ kind: selKind, id });
      return { selection: { kind: selKind, id } };
  },

  set_side_panel: (_s, input) => {
      const panel = String(input.panel);
      if (panel !== "none" && !SIDE_PANEL_TABS.some((t) => t === panel))
        throw new ToolError(`Unknown panel: ${panel}`);
      requestSidePanel(panel === "none" ? null : (panel as SidePanelTab));
      return { panel };
  },

  split_at: (s, input) => {
      const before = s.clips.length + s.audioClips.length;
      s.splitAtPlayhead(isNum(input.t) ? input.t : undefined);
      const after = useEditor.getState();
      const made = after.clips.length + after.audioClips.length - before;
      if (made === 0) throw new ToolError("Nothing to split at that time.");
      return { split: true, ...tracksAfter() };
  },

  move_clip: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      // Reordering by index is a base-sequence operation; a layer clip is
      // free-positioned — move it with update_overlay_video (start/track).
      if (clip.track !== 0)
        throw new ToolError(
          "That clip is on an overlay track — use update_overlay_video to move it."
        );
      if (!isNum(input.toIndex)) throw new ToolError("toIndex is required.");
      const row = track0Clips(s.clips);
      s.moveClip(clip.id, clamp(Math.round(input.toIndex), 0, row.length - 1));
      return { moved: clip.id, ...tracksAfter() };
  },

  place_clip: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      if (!isNum(input.start)) throw new ToolError("start (seconds) is required.");
      const len = (clip.out - clip.in) / (clip.speed && clip.speed > 0 ? clip.speed : 1);
      const taken = s.clips
        .filter((c) => c.id !== clip.id && c.track === clip.track)
        .map((c) => ({
          start: c.start,
          end: c.start + (c.out - c.in) / (c.speed && c.speed > 0 ? c.speed : 1),
        }));
      const at = nextFreeStart(taken, Math.max(0, input.start), len);
      // Closing a gap is this tool's main job, so the clip's blends travel
      // with it: a bar playing its head or its cut lands on the edge's new
      // time instead of staying behind on the row.
      const before = s.clips;
      s.updateClip(clip.id, { start: at });
      useEditor.getState().sortClips();
      useEditor.getState().reanchorBars(before);
      return {
        id: clip.id,
        start: round2(at),
        ...(Math.abs(at - Math.max(0, input.start)) > 0.005
          ? { note: "That spot was taken — slid right to the next free one." }
          : {}),
        ...tracksAfter(),
      };
  },

  add_clip: (s, input) => {
      const asset = requireItem(s.assets, input.asset_id, "project asset");
      return placeAssetOnTimeline(asset, input);
  },

  add_overlay_video: (s, input) => {
      const asset = requireItem(s.assets, input.asset_id, "project asset");
      if (asset.type !== "video" && asset.type !== "image")
        throw new ToolError("Only video or image assets can sit on a video track.");
      const start = isNum(input.start) ? Math.max(0, input.start) : playheadAt();
      // Tracks stack bottom-up from track 0; overlays live on 1+. A stale
      // negative (the old behind-track model) clamps to the first layer.
      const track = isNum(input.track) ? Math.max(1, Math.round(input.track)) : 1;
      if (isNum(input.track) && Math.round(input.track) === 0)
        throw new ToolError("Track 0 holds the timeline clips — use place_clip for it.");
      s.addVideoFromAsset(asset.id, { kind: "track", track }, start);
      const cur = useEditor.getState();
      const sel = cur.selection;
      const id = sel?.kind === "clip" ? sel.id : null;
      if (!id) throw new ToolError("Could not create the overlay clip.");
      // Same undo step as the add: the layout rides the transient patch.
      if (typeof input.layout === "string")
        cur.updateClipTransient(id, layoutPatch(input.layout));
      const c = useEditor.getState().clips.find((x) => x.id === id)!;
      return {
        id: c.id,
        track: c.track,
        start: round2(c.start),
        len: round2((c.out - c.in) / (c.speed && c.speed > 0 ? c.speed : 1)),
        layout: regionLabel(rectOf(c)),
      };
  },

  update_overlay_video: (s, input) => {
      const c = requireItem(overlayLayers(s.clips), input.id, "overlay video clip");
      const asset = s.assets.find((a) => a.id === c.assetId);
      // A still has no source bound, so its clip can stretch to any length.
      const dur = asset?.type === "image" ? Infinity : asset?.duration ?? c.out;
      const patch: Partial<VideoClip> = {};
      if (isNum(input.start)) patch.start = Math.max(0, input.start);
      if (isNum(input.in)) patch.in = clamp(input.in, 0, dur - 0.1);
      if (isNum(input.out)) patch.out = clamp(input.out, 0.1, dur);
      if (patch.in !== undefined || patch.out !== undefined) {
        if ((patch.out ?? c.out) - (patch.in ?? c.in) < 0.1)
          throw new ToolError("Clip must stay at least 0.1s long.");
      }
      if (isNum(input.track)) {
        const track = Math.round(input.track);
        if (track === 0) throw new ToolError("Track 0 holds the timeline clips — overlays are 1 or higher.");
        patch.track = Math.max(1, track);
      }
      if (typeof input.muted === "boolean") patch.muted = input.muted;
      if (typeof input.hidden === "boolean") patch.hidden = input.hidden || undefined;
      if (typeof input.layout === "string") {
        Object.assign(patch, layoutPatch(input.layout));
      } else if (input.region && typeof input.region === "object") {
        const rg = input.region as Record<string, unknown>;
        if (!isNum(rg.x) || !isNum(rg.y) || !isNum(rg.w) || !isNum(rg.h))
          throw new ToolError("region needs numeric x, y, w, h (frame fractions).");
        const w = clamp(rg.w, 0.05, 1);
        const h = clamp(rg.h, 0.05, 1);
        patch.frame = { x: clamp(rg.x, 0, 1 - w), y: clamp(rg.y, 0, 1 - h), w, h };
      }
      if (input.fit === "fit" || input.fit === "fill") patch.fit = input.fit;
      if (isNum(input.zoom)) {
        const z = clamp(input.zoom, 1, CLIP_MAX_ZOOM);
        patch.zoom = z > 1 ? z : undefined;
      }
      if (isNum(input.rotation)) {
        const deg = Math.round(clamp(input.rotation, -180, 180));
        patch.rotation = deg === 0 ? undefined : deg;
      }
      if (isNum(input.opacity)) {
        const o = clamp(input.opacity, 0, 1);
        patch.opacity = o >= 1 ? undefined : o;
      }
      if (isNum(input.speed)) patch.speed = Math.max(SPEED_FLOOR, input.speed);
      if (Object.keys(patch).length === 0) throw new ToolError("Nothing to change.");
      s.updateClip(c.id, patch);
      const next = useEditor.getState().clips.find((x) => x.id === c.id)!;
      return {
        id: next.id,
        track: next.track,
        start: round2(next.start),
        layout: regionLabel(rectOf(next)),
        fit: next.fit ?? "fit",
        ...(clipZoom(next) > 1 ? { zoom: clipZoom(next) } : {}),
        ...(next.rotation ? { rotation: next.rotation } : {}),
        ...((next.opacity ?? 1) < 1 ? { opacity: next.opacity } : {}),
        muted: next.muted,
        ...(next.hidden ? { hidden: true } : {}),
      };
  },

  trim_clip: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      const asset = s.assets.find((a) => a.id === clip.assetId);
      // A still has no source bound, so its clip can stretch to any length.
      const dur = asset?.type === "image" ? Infinity : asset?.duration ?? clip.out;
      const nextIn = isNum(input.in) ? clamp(input.in, 0, dur - 0.1) : clip.in;
      const nextOut = isNum(input.out) ? clamp(input.out, 0.1, dur) : clip.out;
      if (nextOut - nextIn < 0.1) throw new ToolError("Clip must stay at least 0.1s long.");
      // Trim through the store's resize path so track 0 keeps its no-overlap
      // invariant: extending a clip pushes the following run right.
      s.setClipTrim(clip.id, nextIn, nextOut);
      return {
        in: nextIn,
        out: nextOut,
        len: Math.round((nextOut - nextIn) * 100) / 100,
        ...tracksAfter(),
      };
  },

  refine_speech_cuts: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const ids = Array.isArray(input.clip_ids) ? input.clip_ids.map(String) : [];
      if (ids.length === 0)
        throw new ToolError("clip_ids is required — the recut clips whose edges are speech cuts.");
      const chosen = ids.map((id) => requireItem(s.clips, id, "video clip"));

      // Every trim is planned before anything is written, so the re-lay below
      // can preserve the spacing the cut already has.
      const plans = new Map<string, { in: number; out: number }>();
      const flags = new Map<string, string[]>();
      const flag = (id: string, note: string) =>
        flags.set(id, [...(flags.get(id) ?? []), note]);
      await Promise.all(
        chosen.map(async (clip) => {
          const asset = s.assets.find((a) => a.id === clip.assetId);
          if (!asset || asset.type === "image" || !(asset.duration > 0)) {
            flag(clip.id, "no audio-bearing source — skipped");
            return;
          }
          // One scan spanning both edges when the clip is short, else one
          // window around each. Fine pauses matter here, so the scan listens
          // for stretches down to a single breath.
          const win = REACH + 0.6;
          const ranges: [number, number][] =
            clip.out - clip.in <= 2 * win
              ? [[clip.in - win, clip.out + win]]
              : [
                  [clip.in - win, clip.in + win],
                  [clip.out - win, clip.out + win],
                ];
          const spans: SilenceSpan[] = (
            await Promise.all(
              ranges.map(([a, b]) =>
                fetchSilences(projectId, asset, {
                  from: clamp(a, 0, asset.duration),
                  to: clamp(b, 0, asset.duration),
                  thresholdDb: -30,
                  minSilence: BREATH,
                })
              )
            )
          ).flat();
          const inEdge = refineEdge(spans, clip.in, "in");
          const outEdge = refineEdge(spans, clip.out, "out");
          if (!inEdge.pause)
            flag(clip.id, "no pause within reach of the in edge — speech runs continuously; left alone");
          if (!outEdge.pause)
            flag(clip.id, "no pause within reach of the out edge — speech runs continuously; left alone");
          const nextIn = clamp(inEdge.t, 0, asset.duration);
          const nextOut = clamp(outEdge.t, 0, asset.duration);
          if (nextOut - nextIn >= 0.15) plans.set(clip.id, { in: nextIn, out: nextOut });
          else flag(clip.id, "refining would collapse the clip — left as cut");
        })
      );

      // Two sides of one removed stretch never cross back into each other's
      // material, so no word plays twice across a joint.
      const spd = (c: VideoClip) => (c.speed && c.speed > 0 ? c.speed : 1);
      const rows = new Map<number, VideoClip[]>();
      for (const c of s.clips) rows.set(c.track, [...(rows.get(c.track) ?? []), c]);
      for (const row of rows.values()) {
        row.sort((a, b) => a.start - b.start);
        for (let i = 0; i + 1 < row.length; i++) {
          const a = row[i];
          const b = row[i + 1];
          if (a.assetId !== b.assetId || a.out > b.in + 1e-3) continue;
          const pa = plans.get(a.id);
          const pb = plans.get(b.id);
          if ((pa?.out ?? a.out) <= (pb?.in ?? b.in) + 1e-6) continue;
          if (pa) pa.out = a.out;
          if (pb) pb.in = b.in;
          for (const c of [a, b])
            if (plans.has(c.id)) flag(c.id, "its joint's edges would cross the removed stretch — that edge left as cut");
        }
      }

      // Drop no-op plans so the report says which edges already sat right.
      for (const [id, plan] of [...plans]) {
        const c = chosen.find((x) => x.id === id)!;
        if (Math.abs(plan.in - c.in) < 0.005 && Math.abs(plan.out - c.out) < 0.005)
          plans.delete(id);
      }

      // One write for the whole call: each planned clip takes its new trim in
      // place, and every clip after it on the track shifts by the length
      // change — butted joints stay butted, deliberate beats keep their width,
      // and a tightened clip closes up instead of opening a gap.
      if (plans.size > 0) {
        const before = s.clips;
        s.pushHistory();
        const patches: { id: string; patch: Partial<VideoClip> }[] = [];
        for (const row of rows.values()) {
          let delta = 0;
          for (const c of row) {
            const plan = plans.get(c.id);
            const patch: Partial<VideoClip> = {};
            if (Math.abs(delta) > 1e-6) patch.start = Math.max(0, c.start + delta);
            if (plan) {
              patch.in = plan.in;
              patch.out = plan.out;
              delta += (plan.out - plan.in - (c.out - c.in)) / spd(c);
            }
            if (plan || patch.start !== undefined) patches.push({ id: c.id, patch });
          }
        }
        useEditor.getState().updateClipsTransient(patches);
        useEditor.getState().sortClips();
        // Every edge here moved because the audio said so, and the run behind
        // each one shifted with it — a retime, so the bars ride along.
        useEditor.getState().reanchorBars(before);
      }

      return {
        refined: chosen.map((clip) => {
          const plan = plans.get(clip.id);
          const notes = flags.get(clip.id);
          return {
            clipId: clip.id,
            ...(plan
              ? {
                  in: { from: round2(clip.in), to: round2(plan.in) },
                  out: { from: round2(clip.out), to: round2(plan.out) },
                }
              : {}),
            ...(notes
              ? { notes }
              : plan
                ? {}
                : { notes: ["edges already sit in their pauses"] }),
          };
        }),
        note: `Each moved edge sits ~${BREATH}s inside a real pause; clip spacing is preserved. Listen at any flagged edge.`,
        ...tracksAfter(),
      };
  },

  set_clip_muted: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      s.updateClip(clip.id, { muted: Boolean(input.muted) });
      return { muted: Boolean(input.muted) };
  },

  set_clip_volume: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      if (!isNum(input.volume)) throw new ToolError("volume is required (0..1.5).");
      const volume = clamp(input.volume, 0, 1.5);
      s.updateClip(clip.id, { volume: Math.abs(volume - 1) < 1e-4 ? undefined : volume });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, volume: next.volume ?? 1 };
  },

  set_clip_hidden: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      s.updateClip(clip.id, { hidden: input.hidden ? true : undefined });
      return { id: clip.id, hidden: Boolean(input.hidden) };
  },

  reorder_track: (s, input) => {
      if (!isNum(input.from) || !isNum(input.to) || input.from < 0 || input.to < 0)
        throw new ToolError("from and to must be 0 or higher.");
      const from = Math.round(input.from);
      const to = Math.round(input.to);
      const kind = String(input.kind);
      const rows =
        kind === "video"
          ? [...new Set(s.clips.map((c) => c.track))].sort((a, b) => a - b)
          : kind === "soundtrack"
            ? [...new Set(s.audioClips.map((a) => a.lane ?? 0))].sort((a, b) => a - b)
            : kind === "text"
              ? overlayLaneOrder(s.overlays)
              : null;
      if (!rows) throw new ToolError("kind must be video, soundtrack, or text.");
      if (rows.length < 2) throw new ToolError(`There is only one ${kind} row, so nothing to reorder.`);
      const i = rows.indexOf(from);
      if (i < 0) throw new ToolError(`No ${kind} row ${from} — rows ${rows.join(", ")} exist.`);
      const j = Math.min(rows.length - 1, rows.indexOf(to) >= 0 ? rows.indexOf(to) : to);
      if (i === j) return { kind, from: i, to: j, rows: rows.length, moved: false };
      if (kind === "video") s.moveVideoTrack(i, j);
      else if (kind === "soundtrack") s.moveAudioLane(i, j);
      else s.moveOverlayLane(i, j);
      return { kind, from: i, to: j, rows: rows.length, moved: true };
    },

  set_track_hidden: (s, input) => {
      if (!isNum(input.track) || input.track < 0)
        throw new ToolError("track must be 0 or higher.");
      const track = Math.round(input.track);
      const hidden = Boolean(input.hidden);
      switch (input.kind) {
        case "video": {
          const n = s.clips.filter((c) => c.track === track).length;
          if (!n) throw new ToolError(`No clips on video track ${track}.`);
          s.setTrackHidden(track, hidden);
          return { kind: "video", track, hidden, clips: n };
        }
        case "soundtrack": {
          const n = s.audioClips.filter((a) => (a.lane ?? 0) === track).length;
          if (!n) throw new ToolError(`No clips on soundtrack lane ${track}.`);
          s.setAudioLaneHidden(track, hidden);
          return { kind: "soundtrack", track, hidden, clips: n };
        }
        case "text": {
          const n = s.overlays.filter((o) => (o.lane ?? 0) === track).length;
          if (!n) throw new ToolError(`No titles on text track ${track}.`);
          s.setTextLaneHidden(track, hidden);
          return { kind: "text", track, hidden, titles: n };
        }
        case "subtitles": {
          const count = subtitleLaneCount(s.subtitles);
          if (track >= count)
            throw new ToolError(`No subtitle track ${track} — tracks 0–${count - 1} exist.`);
          s.setSubtitleTrackMeta(track, { hidden: hidden ? true : undefined });
          return { kind: "subtitles", track, hidden, cues: laneCues(s.subtitles, track).length };
        }
        default:
          throw new ToolError('`kind` must be "video", "soundtrack", "text", or "subtitles".');
      }
  },

  set_track_muted: (s, input) => {
      if (!isNum(input.track) || input.track < 0)
        throw new ToolError("track must be 0 or higher.");
      const track = Math.round(input.track);
      const n = s.clips.filter((c) => c.track === track).length;
      if (!n) throw new ToolError(`No clips on video track ${track}.`);
      s.setTrackMuted(track, Boolean(input.muted));
      return { track, muted: Boolean(input.muted), clips: n };
  },

  detach_audio: (s, input) => {
      const id = input.clipId ? String(input.clipId) : s.selection?.kind === "clip" ? s.selection.id : null;
      if (!id) throw new ToolError("Pass clipId or select a video clip first.");
      const clip = requireItem(s.clips, id, "video clip");
      if (clip.muted) throw new ToolError("That clip's audio is muted — nothing to detach.");
      s.select({ kind: "clip", id: clip.id });
      s.detachAudio();
      const asset = s.assets.find((a) => a.id === clip.assetId);
      if (asset) void ensurePeaks(asset);
      const sel = useEditor.getState().selection;
      return { audioClipId: sel?.kind === "audio" ? sel.id : null };
  },

  delete_item: (s, input) => {
      const kind = String(input.kind) as "clip" | "overlayClip" | "audio" | "overlay" | "text";
      const id = String(input.id ?? "");
      const pool =
        kind === "clip" || kind === "overlayClip"
          ? s.clips
          : kind === "audio"
            ? s.audioClips
            : s.overlays;
      if (!pool.some((x) => x.id === id)) throw new ToolError(`No ${kind} with id ${id}.`);
      const selKind =
        kind === "overlayClip" ? "clip" : kind === "text" ? "overlay" : (kind as "clip" | "audio" | "overlay");
      s.select({ kind: selKind, id });
      s.deleteSelection();
      return {
        deleted: { kind: selKind, id },
        ...(selKind === "overlay" ? {} : tracksAfter()),
      };
  },

  remove_gap: (s, input) => {
      if (!isNum(input.at)) throw new ToolError("at (seconds) is required.");
      const track = isNum(input.track) ? input.track : 0;
      const lane = { kind: "video", index: track } as const;
      const gap = laneGapAt(s, lane, input.at);
      if (!gap) throw new ToolError(`No track-${track} gap at ${input.at}s — pass a time inside the empty span.`);
      s.removeLaneGap(lane, input.at);
      return { closed: { track, ...gap }, ...tracksAfter() };
  },

  add_title: (s, input) => {
      if (typeof input.text !== "string" || !input.text.trim())
        throw new ToolError("text is required.");
      if (isNum(input.start)) s.seek(input.start);
      s.addOverlay(aimedLane(input));
      const sel = useEditor.getState().selection;
      if (sel?.kind !== "overlay") throw new ToolError("Could not create the title.");
      applyOverlayPatchSettled(sel.id, overlayPatch({ ...input, id: sel.id }, "text"));
      const o = useEditor.getState().overlays.find((x) => x.id === sel.id)!;
      return { id: o.id, ...(isTextOverlay(o) ? { text: o.text } : {}), start: o.start, end: o.end };
  },

  add_text_sequence: (s, input) => {
      const look = requireTextLook(input.look);
      const lane = isNum(input.lane) ? Math.max(0, Math.round(input.lane)) : 0;
      const wantCards =
        typeof input.cards === "boolean" ? input.cards : look.frame.cards.length > 0;
      const cards = wantCards && look.frame.cards.length > 0 ? look.frame.cards : [];
      const lines = textSequenceLines(s, input);
      if (lines.length === 0)
        throw new ToolError(
          "Pass lines: [{text, start, end}], or from_captions: true to build the sequence from the caption track."
        );
      const variation: TextVariation =
        input.variation === "none" || input.variation === "subtle" || input.variation === "bold"
          ? input.variation
          : (look.defaultVariation ?? "bold");
      if (typeof input.layout === "string" && !TEXT_LAYOUT_IDS.includes(input.layout as TextLayout))
        throw new ToolError(`Unknown layout. Use one of: ${TEXT_LAYOUT_IDS.join(", ")}.`);
      const layout = typeof input.layout === "string" ? (input.layout as TextLayout) : undefined;
      if (paintsFrame(look, input.background)) s.setBackground(look.frame.background);
      // Row 0 is the front of the element stack, so the words take the row the
      // caller named and each card goes one row under them. Cards over words
      // would paint the line out.
      const cardLane = lane + 1;
      const composed = composeTextRun(lines, look, {
        variation,
        layout,
        frame: frameOf(s.aspect),
        cards,
      });
      const made: { id: string; start: number; end: number; text: string }[] = [];
      composed.forEach((line, i) => {
        const card = cards.length > 0 ? cards[i % cards.length] : null;
        if (card) {
          useEditor.getState().seek(line.start);
          useEditor.getState().addShape("rect", { lane: cardLane });
          const sel = useEditor.getState().selection;
          if (sel?.kind === "overlay")
            applyOverlayPatchSettled(sel.id, {
              start: line.start,
              end: line.end,
              x: 0.5,
              y: 0.5,
              w: 1,
              h: 1,
              fill: card,
            });
        }
        useEditor.getState().seek(line.start);
        useEditor.getState().addOverlay({ lane });
        const sel = useEditor.getState().selection;
        if (sel?.kind !== "overlay") return;
        applyOverlayPatchSettled(sel.id, {
          start: line.start,
          end: line.end,
          text: line.text,
          x: line.x,
          y: line.y,
          rotation: line.rotation,
          size: line.size,
          font: line.font,
          weight: line.weight,
          color: line.color,
          italic: line.italic || look.text.italic,
          letterSpacing: look.text.letterSpacing,
          lineHeight: look.text.lineHeight,
          stroke: look.text.stroke,
          plate: look.text.plate ?? false,
          plateColor: look.text.plateColor,
          plateOpacity: look.text.plateOpacity,
          shadow: look.text.shadow ?? false,
          align: "center",
        });
        useEditor.getState().updateOverlay(sel.id, { anim: line.anim });
        const o = useEditor.getState().overlays.find((x) => x.id === sel.id);
        if (o) made.push({ id: o.id, start: round2(o.start), end: round2(o.end), text: line.text });
      });
      const faces = [...new Set(composed.map((l) => l.font))];
      const moves = [...new Set(composed.map((l) => l.move))].filter((m) => m !== "none");
      return {
        look: look.id,
        variation,
        layout: layout ?? (variation === "none" ? "center" : look.ensemble.layout),
        count: made.length,
        lanes: cards.length > 0 ? { cards: cardLane, text: lane } : { text: lane },
        background: useEditor.getState().background,
        faces,
        moves,
        items: made.slice(0, 40),
        ...(made.length > 40 ? { itemsTruncated: true } : {}),
        note:
          cards.length > 0
            ? `Words on row ${lane} with their cards on row ${cardLane} behind them, colors cycling ${look.frame.cards.join(" \u2192 ")}.`
            : look.keepsFrame
              ? `Words on row ${lane} over the cut as it already looks; the frame color is untouched.`
              : `Words on row ${lane} over the ${look.frame.background} frame.`,
      };
  },

  set_caption_look: (s, input) => {
      const patch: Parameters<typeof s.setSubtitlesView>[0] = {};
      if (typeof input.look === "string") {
        const look = requireTextLook(input.look);
        patch.style = look.captions.style;
        patch.wordHighlight = look.captions.wordHighlight;
        if (look.captions.size !== undefined) patch.size = look.captions.size;
        if (look.captions.font) patch.font = look.captions.font;
        if (look.captions.accentColor) patch.accentColor = look.captions.accentColor;
        if (look.captions.accentMode) patch.accentMode = look.captions.accentMode;
        if (paintsFrame(look, input.background)) s.setBackground(look.frame.background);
      }
      if (typeof input.style === "string") {
        if (!(input.style in CAPTION_STYLES))
          throw new ToolError(`Unknown caption style. Use one of: ${Object.keys(CAPTION_STYLES).join(", ")}.`);
        patch.style = input.style as CaptionStyleId;
      }
      if (isNum(input.size)) patch.size = clamp(Math.round(input.size), 16, 200);
      if (typeof input.font === "string" && allFonts().some((f) => f.id === input.font))
        patch.font = input.font;
      if (typeof input.word_highlight === "boolean") patch.wordHighlight = input.word_highlight;
      if (typeof input.accent_color === "string") patch.accentColor = input.accent_color;
      if (input.accent_mode === "color" || input.accent_mode === "underline" || input.accent_mode === "box")
        patch.accentMode = input.accent_mode;
      if (isNum(input.y)) patch.y = clamp(input.y, 0.02, 0.98);
      if (isNum(input.x)) patch.x = clamp(input.x, 0.02, 0.98);
      if (Object.keys(patch).length === 0) throw new ToolError("Nothing to change.");
      s.setSubtitlesView(patch);
      const cur = useEditor.getState().subtitles;
      return {
        style: cur.style ?? "clean",
        size: cur.size,
        font: cur.font,
        wordHighlight: cur.wordHighlight === true,
        accentColor: cur.accentColor,
        accentMode: cur.accentMode,
      };
  },

  sync_lyrics: async (s, input) => {
      const text = typeof input.text === "string" ? input.text : "";
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length === 0) throw new ToolError("Pass text — the lyrics or script, one line per screen.");
      const lane = targetSubtitleTrack(input);
      // The recording's own clock. Existing captions serve; without them the
      // cut is transcribed first, which is what puts times on the words.
      let cues = laneCues(useEditor.getState().subtitles, lane);
      if (cues.length === 0) {
        await useEditor.getState().generateSubtitles();
        const cur = useEditor.getState();
        if (cur.subtitleStatus === "error")
          throw new ToolError(cur.subtitleError ?? "Could not transcribe the audio.");
        cues = laneCues(cur.subtitles, lane);
      }
      const st = useEditor.getState();
      const span = {
        from: isNum(input.from) ? Math.max(0, input.from) : 0,
        to: isNum(input.to) ? input.to : Math.max(projectDuration(st), cues[cues.length - 1]?.end ?? 0),
      };
      const timed = syncLines(lines, cueWords(cues), span);
      // The transcript's clock only covers the words it recognized. Every other
      // line here was interpolated between them, so the run is measured against
      // the mix itself before it is written — the same pass the captions got,
      // reaching wider because these times are guesses.
      const mix = await st.cutMixSamples();
      const report = mix
        ? syncToSpeech(timed, mix.samples, mix.sampleRate, { reach: 0.6 })
        : null;
      st.setLaneCues(lane, report?.evidence ? report.items : timed);
      if (typeof input.look === "string") {
        const look = requireTextLook(input.look);
        st.setSubtitlesView({
          style: look.captions.style,
          wordHighlight: look.captions.wordHighlight,
          ...(look.captions.size !== undefined ? { size: look.captions.size } : {}),
          ...(look.captions.font ? { font: look.captions.font } : {}),
          ...(look.captions.accentColor ? { accentColor: look.captions.accentColor } : {}),
          ...(look.captions.accentMode ? { accentMode: look.captions.accentMode } : {}),
        });
        if (paintsFrame(look, input.background)) st.setBackground(look.frame.background);
      }
      const heardWords = cueWords(cues).length;
      // What the track now carries, which is what the assistant must reason
      // against: the aligned times when the mix moved them, the transcript's
      // own otherwise.
      const written = report?.evidence ? report.items : timed;
      return {
        track: lane,
        count: written.length,
        lines: written.slice(0, 40).map((l) => ({ start: l.start, end: l.end, text: l.text })),
        ...(written.length > 40 ? { linesTruncated: true } : {}),
        aligned: report?.evidence === true,
        ...(report?.evidence ? { movedOntoSpeech: report.moved.length, maxShift: report.maxShift } : {}),
        note:
          `Your text is on the track verbatim, timed against ${heardWords} recognized words. ` +
          (report?.evidence
            ? `${report.moved.length} line(s) then moved onto the speech in the mix itself (farthest ${report.maxShift}s). `
            : "The mix offered no readable speech edges to check them against, so the lines carry the transcript's clock alone. ") +
          "Spot-check a line or two with seek + capture_frame, and retime with update_cue.",
      };
  },

  align_to_audio: async (s, input) => {
      if (!s.projectId) throw new ToolError("No project open.");
      const target = input.target === "elements" ? "elements" : "captions";
      const reach = isNum(input.reach) ? clamp(input.reach, 0.1, 2) : 0.6;
      const only = Array.isArray(input.ids) ? new Set(input.ids.map(String)) : null;
      const mix = await useEditor.getState().cutMixSamples();
      if (!mix)
        throw new ToolError(
          "Nothing audible on the timeline to measure against — the audio or video the words belong to has to be in the cut."
        );

      if (target === "captions") {
        const lane = targetSubtitleTrack(input);
        // The whole track is measured even when only some cues are being
        // written: the pass weighs the transcript against the mix as a whole
        // before it moves anything, and a handful of cues out of a hundred
        // look like a mix about something else.
        const cues = laneCues(useEditor.getState().subtitles, lane);
        if (cues.length === 0)
          throw new ToolError(`Subtitle track ${lane} has no captions to align.`);
        const report = syncToSpeech(cues, mix.samples, mix.sampleRate, { reach });
        // Writing part of an aligned track fits the written cues between the
        // ones left where they were; captions on a track may not overlap.
        const writes = partialWrites(report.items, cues, (c) => !only || only.has(c.id));
        if (report.evidence)
          useEditor.getState().retimeItems({
            cues: writes.map((c) => ({
              id: c.id,
              start: c.start,
              end: c.end,
              ...(c.words ? { words: c.words } : {}),
            })),
          });
        return {
          target,
          track: lane,
          count: cues.length,
          ...syncResult(report, cues, only),
        };
      }

      const overlays = useEditor.getState().overlays;
      const row = isNum(input.lane) ? Math.max(0, Math.round(input.lane)) : 0;
      const picked = only
        ? [...only].map((id) => requireItem(overlays, id, "overlay element"))
        : overlays.filter((o) => (o.lane ?? 0) === row);
      if (picked.length === 0)
        throw new ToolError(`No elements on row ${row} to align — pass ids, or the row the run sits on.`);

      // Rows are measured whole, one at a time. A row's items are what may not
      // overlap each other, and the fit against the mix is read over the whole
      // run rather than the few elements being written.
      const lanes = [...new Set(picked.map((o) => o.lane ?? 0))].sort((a, b) => a - b);
      const writes = new Map<string, { id: string; start: number; end: number }>();
      const partners: { from: { start: number; end: number }; to: { start: number; end: number } }[] = [];
      const reports = lanes.map((lane) => {
        const items = overlays
          .filter((o) => (o.lane ?? 0) === lane)
          .sort((a, b) => a.start - b.start);
        const report = syncToSpeech(
          items.map((o) => ({
            id: o.id,
            text: isTextOverlay(o) ? o.text : o.kind ?? "element",
            start: o.start,
            end: o.end,
          })),
          mix.samples,
          mix.sampleRate,
          { reach }
        );
        if (report.evidence) {
          // Part of a row may be written while the rest stays; each written
          // item is fitted between the neighbours it lands among, since items
          // sharing a row may never overlap.
          const fitted = partialWrites(report.items, items, (next) =>
            picked.some((p) => p.id === next.id)
          );
          for (const next of fitted) {
            const was = items.find((o) => o.id === next.id)!;
            writes.set(next.id, { id: next.id, start: next.start, end: next.end });
            // Only a move that is actually being written can carry a partner
            // with it: a card following a word that stayed put would be the
            // desync this ride-along exists to prevent.
            partners.push({ from: { start: was.start, end: was.end }, to: next });
          }
        }
        return { lane, items, report };
      });

      // A look's color cards sit on the row under its words, one per line and
      // timed to it. They belong to the line, so an element elsewhere holding
      // exactly a moved item's old window rides along — otherwise the words
      // land on the speech and their cards stay behind.
      const EPS = 0.05;
      for (const o of overlays) {
        if (writes.has(o.id) || lanes.includes(o.lane ?? 0)) continue;
        const pair = partners.find(
          (p) => Math.abs(p.from.start - o.start) <= EPS && Math.abs(p.from.end - o.end) <= EPS
        );
        if (pair) writes.set(o.id, { id: o.id, start: pair.to.start, end: pair.to.end });
      }
      if (writes.size > 0) useEditor.getState().retimeItems({ overlays: [...writes.values()] });
      return {
        target,
        lane: lanes[0],
        ...(lanes.length > 1 ? { lanes } : {}),
        count: reports.reduce((n, r) => n + r.items.length, 0),
        ...syncResult(
          mergeReports(reports.map((r) => r.report)),
          reports.flatMap((r) =>
            r.items.map((o) => ({ id: o.id, text: isTextOverlay(o) ? o.text : o.kind ?? "element" }))
          ),
          only
        ),
      };
  },

  update_overlay: (s, input) => {
      const o = requireItem(s.overlays, input.id, "overlay element");
      s.updateOverlay(o.id, overlayPatch(input, o.kind ?? "text"));
      const next = useEditor.getState().overlays.find((x) => x.id === o.id)!;
      return {
        id: next.id,
        kind: next.kind ?? "text",
        ...(isTextOverlay(next) ? { text: next.text, color: next.color, size: next.size } : {}),
        start: round2(next.start),
        end: round2(next.end),
      };
  },

  update_audio: (s, input) => {
      const a = requireItem(s.audioClips, input.id, "soundtrack clip");
      const aSpeed = a.speed && a.speed > 0 ? a.speed : 1;
      const len = (a.out - a.in) / aSpeed;
      const patch: Partial<AudioClip> = {};
      if (isNum(input.volume)) patch.volume = clamp(input.volume, 0, 1.5);
      if (isNum(input.fadeIn)) patch.fadeIn = clamp(input.fadeIn, 0, len / 2);
      if (isNum(input.fadeOut)) patch.fadeOut = clamp(input.fadeOut, 0, len / 2);
      if (isNum(input.start)) patch.start = Math.max(0, input.start);
      if (isNum(input.in)) patch.in = Math.max(0, input.in);
      if (isNum(input.out)) patch.out = input.out;
      if (isNum(input.speed))
        patch.speed =
          Math.abs(input.speed - 1) < 1e-4 ? undefined : Math.max(SPEED_FLOOR, input.speed);
      // duck >= 1 clears ducking (undefined); below 1 sets the gain.
      if (isNum(input.duck)) patch.duck = input.duck >= 1 ? undefined : clamp(input.duck, 0, 1);
      if (typeof input.hidden === "boolean") patch.hidden = input.hidden || undefined;
      if (isNum(patch.in ?? NaN) || isNum(patch.out ?? NaN)) {
        const nIn = patch.in ?? a.in;
        const nOut = patch.out ?? a.out;
        if (nOut - nIn < 0.1) throw new ToolError("Audio clip must stay at least 0.1s long.");
      }
      if (!("duck" in patch) && Object.keys(patch).length === 0)
        throw new ToolError("Nothing to change.");
      s.updateAudio(a.id, patch);
      // Report where the clip actually sits: the store slides a committed move
      // to the lane's next free slot when the requested start overlaps.
      const landed = useEditor.getState().audioClips.find((c) => c.id === a.id)!;
      return {
        id: a.id,
        ...patch,
        ...("start" in patch ? { start: round2(landed.start) } : {}),
      };
  },

  set_framing: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      const mode = input.mode === "fill" ? "fill" : "fit";
      const zoom = isNum(input.zoom) ? clamp(input.zoom, 1, CLIP_MAX_ZOOM) : 1;
      // Pan only means something once something overflows the box.
      const pannable = mode === "fill" || zoom > 1;
      s.updateClip(clip.id, {
        fit: mode,
        zoom: zoom > 1 ? zoom : undefined,
        panX: pannable && isNum(input.panX) ? clamp(input.panX, -1, 1) : 0,
        panY: pannable && isNum(input.panY) ? clamp(input.panY, -1, 1) : 0,
      });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return {
        id: next.id,
        fit: next.fit,
        zoom: clipZoom(next),
        panX: next.panX ?? 0,
        panY: next.panY ?? 0,
      };
  },

  set_clip_style: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      if (input.clear === true) {
        s.updateClip(clip.id, { boxStyle: undefined });
        return { id: clip.id, boxStyle: null };
      }
      const bs = { ...clip.boxStyle };
      if (isNum(input.radius)) bs.radius = Math.max(0, input.radius) || undefined;
      if (isNum(input.border_width)) bs.borderWidth = Math.max(0, input.border_width) || undefined;
      if (typeof input.border_color === "string") bs.borderColor = input.border_color;
      const shadowTouched =
        isNum(input.shadow_blur) ||
        isNum(input.shadow_x) ||
        isNum(input.shadow_y) ||
        typeof input.shadow_color === "string" ||
        isNum(input.shadow_opacity);
      if (shadowTouched) {
        const sh: ClipShadow = {
          blur: Math.max(0, isNum(input.shadow_blur) ? input.shadow_blur : bs.shadow?.blur ?? 24),
          ...(isNum(input.shadow_x)
            ? input.shadow_x !== 0 && { x: input.shadow_x }
            : bs.shadow?.x !== undefined && { x: bs.shadow.x }),
          ...(isNum(input.shadow_y)
            ? input.shadow_y !== 0 && { y: input.shadow_y }
            : bs.shadow?.y !== undefined && { y: bs.shadow.y }),
          ...(typeof input.shadow_color === "string"
            ? { color: input.shadow_color }
            : bs.shadow?.color !== undefined && { color: bs.shadow.color }),
          ...(isNum(input.shadow_opacity)
            ? { opacity: clamp(input.shadow_opacity, 0, 1) }
            : bs.shadow?.opacity !== undefined && { opacity: bs.shadow.opacity }),
        };
        // A shadow with no blur and no throw is no shadow.
        bs.shadow = sh.blur > 0 || sh.x || sh.y ? sh : undefined;
      }
      const boxStyle =
        bs.radius || bs.borderWidth || bs.shadow ? bs : undefined;
      s.updateClip(clip.id, { boxStyle });
      return { id: clip.id, boxStyle: boxStyle ?? null };
  },

  freeze_frame: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const spans = getClipSpans(s.clips, s.assets);
      if (spans.length === 0) throw new ToolError("The timeline is empty.");
      const total = totalDuration(s.clips);
      const t = clamp(isNum(input.t) ? input.t : playheadAt(), 0, Math.max(0, total - 0.001));
      const span = spans.find((sp) => t >= sp.start && t < sp.start + sp.len) ?? spans[spans.length - 1];
      // Timeline seconds run at the clip's speed in source time, so a sped-up
      // clip freezes the frame the preview actually shows.
      const srcTime =
        span.clip.in +
        (t - span.start) *
          (span.clip.speed && span.clip.speed > 0 ? span.clip.speed : 1);
      let body: MediaAsset;
      if (getBackend().kind !== "local") {
        // No engine to bake a still video — grab the frame in the browser and
        // store it as a project image; image clips carry their own length,
        // sized below to the requested duration, mirroring the engine's
        // /freeze clamps (default 1s, 0.5..10s).
        const freezeDur = Math.min(10, Math.max(0.5, isNum(input.duration) ? input.duration : 1));
        body = await captureFreezeFrame(projectId, span.asset.url, srcTime, freezeDur, {
          frame: frameOf(s.aspect),
          cover: clipCovers(span.clip),
          zoom: clipZoom(span.clip),
          panX: span.clip.panX ?? 0,
          panY: span.clip.panY ?? 0,
        }).catch(
          (e) => {
            throw new ToolError(
              e instanceof Error ? e.message : "Could not render the freeze frame."
            );
          }
        );
      } else {
        const res = await apiFetch(`/api/cut/projects/${projectId}/freeze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: span.asset.fileName,
            srcTime,
            duration: isNum(input.duration) ? input.duration : 1,
            // Bake the still at the current project frame, framed exactly as
            // the preview shows it. Switching aspect later letterboxes this
            // still — capture a fresh one to re-fit.
            frame: frameOf(s.aspect),
            framing: {
              fit: span.clip.fit ?? "fit",
              zoom: clipZoom(span.clip),
              panX: span.clip.panX ?? 0,
              panY: span.clip.panY ?? 0,
            },
          }),
        });
        const made = await apiJson<MediaAsset>(res);
        if (!res.ok) throw new ToolError(made.error ?? "Could not render the freeze frame.");
        body = made;
      }
      const asset: MediaAsset = { ...body, url: mediaUrl(projectId, body.fileName), origin: "freeze" };
      const cur = useEditor.getState();
      cur.addAsset(asset);
      cur.addClipFromAsset(asset.id); // lands at the end, selected
      const sel = useEditor.getState().selection;
      // A cloud freeze is a still image, placed at the default image-clip
      // length — resize it to the requested duration (the engine path bakes a
      // video whose duration addClipFromAsset adopts on its own).
      if (sel?.kind === "clip" && body.type === "image" && body.duration > 0) {
        cur.updateClip(sel.id, { out: body.duration });
      }
      const index = clamp(isNum(input.index) ? Math.round(input.index) : 0, 0, useEditor.getState().clips.length - 1);
      if (sel?.kind === "clip") cur.moveClip(sel.id, index);
      void enrichAsset(asset);
      return {
        assetId: asset.id,
        clipId: sel?.kind === "clip" ? sel.id : null,
        index,
        duration: body.duration,
        from: { time: Math.round(t * 100) / 100, source: span.asset.name },
      };
  },

  generate_image: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt) throw new ToolError("A prompt is required.");
      const refs = resolveRefAssets(input.reference_asset_ids);

      // Captured before the render: the image files under the chat that
      // asked, even if the user switches threads while it generates. Ownership
      // rides the job from creation, so neither the job row nor the landed
      // asset ever touches the Image panel.
      const chatId = chatOwner();
      // Hosted image generation is synchronous and quick, so wait it out.
      const job = await useGenerate.getState().generateImage(projectId, prompt, {
        ...(input.aspect === "16:9" || input.aspect === "9:16" || input.aspect === "1:1"
          ? { aspect: input.aspect }
          : {}),
        ...(input.resolution === "1K" || input.resolution === "2K" || input.resolution === "4K"
          ? { resolution: input.resolution }
          : {}),
        ...(refs.length > 0 ? { refs } : {}),
        ...(chatId ? { chatId } : {}),
      });
      if (job.status !== "done" || !job.assetId) {
        throw new ToolError(job.error ?? "Image generation failed.");
      }
      const cur = useEditor.getState();
      const asset = cur.assets.find((a) => a.id === job.assetId);
      if (!asset) throw new ToolError("The generated image did not land in the project.");
      const placed = wantsTimeline(input, "index")
        ? addVideoTrackClip(asset.id, promptedIndex(input))
        : NOT_PLACED;
      return {
        assetId: asset.id,
        name: asset.name,
        kind: "image",
        // A still has no source length; report its default placed length.
        duration: IMAGE_CLIP_SECONDS,
        addedToTimeline: placed.added,
        clipId: placed.clipId,
        index: placed.index,
      };
  },

  generate_video: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt) throw new ToolError("A prompt is required.");
      const gen = useGenerate.getState();
      // The render is fire-and-forget below, so a signed-out user must be
      // caught here — an unprobed session (null) resolves before we claim
      // success. Deeper errors surface in the panel's job list.
      const signedIn = gen.signedIn ?? (await gen.probeNow());
      if (!signedIn) throw new ToolError("Sign in to Donkey to generate video.");

      // Video renders can outrun the assistant tool bridge's 2-minute cap, so
      // don't block: start the job and let its completion place the clip.
      const refs =
        input.reference_asset_id === undefined
          ? []
          : resolveRefAssets([input.reference_asset_id]);
      // Audio references carry no picture: they ride in `refs` for the compose
      // pass to hear, while anchor rungs take the first ref that has a frame.
      const anchors = visualRefs(refs);
      // The model renders the whole clip with audio in one pass and picks its
      // own length (up to ~10s) — aspect is the only knob.
      const baseOpts: Omit<VideoGenOptions, "onDone"> = {
        ...(input.aspect === "16:9" || input.aspect === "9:16" ? { aspect: input.aspect } : {}),
      };
      // A one-off render walks the same identity ladder as a scene shot:
      // seed image first (the strongest anchor), the picture as an identity
      // reference second, text-only last — so a safety-blocked anchor
      // degrades the render instead of killing it. The text rung is gated
      // exactly like a scene shot's: it runs only when the provider refused
      // the image anchor itself. An ordinary failure (timeout, 5xx) must
      // fail the job — a render that never saw the user's picture is not a
      // success to show them.
      const asReference = (anchor: AssetRef): VideoAttempt => ({
        prompt,
        opts: { ...baseOpts, referenceImages: [anchor] },
      });
      const textOnly: VideoAttempt = { prompt, opts: { ...baseOpts }, gate: anchorRefused };
      // "Animate this image": the referenced frame is the product, so it seeds
      // the render untouched — no image-model redesign in between, and no
      // text-only rung (a render without the image isn't what was asked).
      if (refs.length > 0 && input.animate_reference === true) {
        if (anchors.length === 0)
          throw new ToolError(
            "animate_reference needs an image or video reference — audio has no frame to animate."
          );
        return launchVideoJob(
          projectId,
          input,
          [
            { prompt, opts: { ...baseOpts, refs: [anchors[0]], composeRefs: false } },
            asReference(anchors[0]),
          ],
          {
            note: "Animating the referenced image as the literal opening frame — the clip previews in this chat when it lands, in a minute or two.",
          }
        );
      }
      // Staged, like the scene pipeline: reference work happens in the image
      // model first — it holds identity far better than any video model — and
      // the video model then animates the approved frame. The still lands as
      // a chat asset (its card previews above the render's), and the render
      // seeds from it with the prompt as written. Text-only asks skip
      // straight to video; a failed still degrades to the composed-seed hop.
      if (anchors.length > 0) {
        const still = await gen.generateImage(projectId, prompt, {
          refs,
          aspect:
            input.aspect === "16:9" || input.aspect === "9:16"
              ? input.aspect
              : nearestAspect(useEditor.getState().aspect, defaultVideoAspects()),
          chatId: chatOwner() ?? undefined,
        });
        const stillAsset =
          still.status === "done" && still.assetId
            ? useEditor.getState().assets.find((a) => a.id === still.assetId)
            : undefined;
        if (stillAsset) {
          return launchVideoJob(
            projectId,
            input,
            [
              { prompt, opts: { ...baseOpts, refs: [refFromAsset(stillAsset)], composeRefs: false } },
              asReference(anchors[0]),
              textOnly,
            ],
            {
              extra: { stillAssetId: stillAsset.id },
              note: "Designed the opening frame from the reference first (the image card above the render), then started the video from that exact frame — it previews in this chat when it lands, in a minute or two.",
            }
          );
        }
        return launchVideoJob(projectId, input, [
          { prompt, opts: { ...baseOpts, refs } },
          asReference(anchors[0]),
          textOnly,
        ]);
      }
      // Audio-only reference: no frame to anchor, so a single rung renders with
      // the compose pass folding what it hears into the prompt.
      if (refs.length > 0) {
        return launchVideoJob(projectId, input, [{ prompt, opts: { ...baseOpts, refs } }]);
      }
      // No reference: text is the whole request, so the single rung runs ungated.
      return launchVideoJob(projectId, input, [{ prompt, opts: { ...baseOpts } }]);
  },

  wait_for_renders: async (s) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const watched = useGenerate
        .getState()
        .jobs.filter(
          (j) => j.kind === "video" && j.status === "running" && j.projectId === projectId
        )
        .map((j) => j.id);
      if (watched.length === 0) {
        return { renders: [], note: "No renders in flight — check `renders` in the state for recent outcomes." };
      }
      // Poll the job store rather than the settlement promises: it also tracks
      // renders another tab owns. Stay under the tool bridge's 2-minute cap;
      // whatever hasn't settled reports as still rendering.
      const deadline = Date.now() + 100_000;
      while (Date.now() < deadline) {
        const jobs = useGenerate.getState().jobs;
        if (!watched.some((id) => jobs.find((j) => j.id === id)?.status === "running")) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const jobs = useGenerate.getState().jobs;
      const cur = useEditor.getState();
      const renders = watched.map((id) => {
        const j = jobs.find((x) => x.id === id);
        if (!j) return { jobId: id, status: "dismissed" as const };
        const asset = j.assetId ? cur.assets.find((a) => a.id === j.assetId) : undefined;
        return {
          jobId: id,
          status: j.status,
          ...(asset ? { assetId: asset.id, name: asset.name, duration: asset.duration } : {}),
          ...(j.status === "error" && j.error ? { error: j.error } : {}),
        };
      });
      const stillRunning = renders.filter((x) => x.status === "running").length;
      return {
        renders,
        ...(stillRunning > 0
          ? { note: `${stillRunning} still rendering — call wait_for_renders again to keep waiting.` }
          : {}),
      };
  },

  generate_character_video: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const id = String(input.character_id ?? "");
      const character = STOCK_VIDEOS.find((v) => v.id === id && v.persona);
      if (!character)
        throw new ToolError(`No talking character with id ${id}. Call stock_search kind:"character".`);
      const line = String(input.line ?? "").trim();
      if (!line) throw new ToolError("line is required — what should they say?");
      const gen = useGenerate.getState();
      const signedIn = gen.signedIn ?? (await gen.probeNow());
      if (!signedIn) throw new ToolError("Sign in to Donkey to generate video.");
      return launchVideoJob(
        projectId,
        input,
        [
          {
            prompt: characterPrompt(character.persona!, line),
            opts: {
              aspect: character.aspect,
              // The character's own clip seeds the render so the same person
              // delivers the line — composing would swap the face, so it rides
              // raw, and there is no weaker rung: another anchor is another face.
              refs: [refFromStockVideo(character)],
              composeRefs: false,
            },
          },
        ],
        { extra: { character: character.id } }
      );
  },

  generate_scene: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const gen = useGenerate.getState();
      const signedIn = gen.signedIn ?? (await gen.probeNow());
      if (!signedIn) throw new ToolError("Sign in to Donkey to generate a video.");
      const brief = String(input.brief ?? "").trim();
      const fromAudio =
        input.from_audio_asset_id !== undefined ? String(input.from_audio_asset_id) : undefined;
      if (!brief && !fromAudio)
        throw new ToolError("A brief is required (or from_audio_asset_id to animate existing audio).");
      if (fromAudio) {
        const asset = s.assets.find((a) => a.id === fromAudio);
        const audio = s.assets.filter((a) => a.type === "audio");
        const hint = audio.length
          ? ` The project's audio: ${audio.map((a) => `${a.id} ("${a.name}")`).join(", ")}.`
          : " This project has no audio asset — omit from_audio_asset_id to write a fresh narration instead.";
        if (!asset) throw new ToolError(`No project asset with id ${fromAudio}.${hint}`);
        if (asset.type !== "audio")
          throw new ToolError(`"${asset.name}" is ${asset.type}, not audio — from_audio_asset_id must be the audio to animate.${hint}`);
        // The scene transcriber keys its recognizer off asset.language; a
        // mismatched recognizer turns foreign speech into garbage the plan
        // then depicts.
        const lang = typeof input.audio_language === "string" ? input.audio_language.trim() : "";
        if (lang) s.updateAsset(fromAudio, { language: lang });
      }
      // Plan up to the shot list and stop; approve_scene starts the paid renders.
      // Tag every asset the run creates to the asking chat, so intermediates and
      // shots stay off the Media/Video/Image/Audio panels.
      const res = await useGenScene.getState().start(projectId, {
        chatId: chatOwner(),
        ...(brief ? { brief } : {}),
        ...(fromAudio ? { fromAudioAssetId: fromAudio } : {}),
        ...(isNum(input.target_seconds)
          ? { targetSeconds: clamp(Math.round(input.target_seconds), 6, 90) }
          : {}),
        ...(typeof input.style === "string" && input.style.trim() ? { style: input.style.trim() } : {}),
        ...(Array.isArray(input.reference_asset_ids)
          ? { referenceAssetIds: input.reference_asset_ids.map(String) }
          : {}),
      });
      if (!res.started) throw new ToolError(res.message);
      return {
        planned: true,
        shots: res.shotCount,
        note: `${res.message} A storyboard card below shows each shot's opening frame for the user, so keep your reply to one short line — don't re-describe the shots or the timing. Ask them to review it; if they want a frame changed, call regenerate_shot (at this stage it just redraws that frame, no credits). When they approve, call approve_scene — that starts the paid video renders, so don't approve on your own.`,
      };
  },

  approve_scene: () => {
      const res = useGenScene.getState().approve();
      if (!res.ok) throw new ToolError(res.message);
      return { rendering: true, note: res.message };
  },

  cancel_scene: () => {
      const res = useGenScene.getState().cancel();
      if (!res.ok) throw new ToolError(res.message);
      return { stopped: true, note: res.message };
  },

  regenerate_shot: (_s, input) => {
      if (!isNum(input.n)) throw new ToolError("n (the 1-based shot number) is required.");
      const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined;
      const res = useGenScene.getState().regenerateShot(Math.round(input.n), note);
      if (!res.ok) throw new ToolError(res.message);
      return { note: res.message };
  },

  recut_scene: (_s, input) => {
      if (!isNum(input.from_shot) || !isNum(input.to_shot))
        throw new ToolError("from_shot and to_shot (1-based, inclusive) are required.");
      const instruction = String(input.instruction ?? "").trim();
      if (!instruction) throw new ToolError("An instruction is required — what should this span become?");
      const res = useGenScene
        .getState()
        .recutShots(Math.round(input.from_shot), Math.round(input.to_shot), instruction);
      if (!res.ok) throw new ToolError(res.message);
      return { note: res.message };
  },

  restyle_scene: (_s, input) => {
      const style = String(input.style ?? "").trim();
      if (!style) throw new ToolError("style is required — the new look for the whole video.");
      const res = useGenScene.getState().restyle(style);
      if (!res.ok) throw new ToolError(res.message);
      return { note: res.message };
  },

  stock_search: (s, input) => {
      const q = String(input.query ?? "").trim().toLowerCase();
      const kindIn =
        input.kind === "video" || input.kind === "image" || input.kind === "character"
          ? input.kind
          : undefined;
      interface Hit {
        id: string;
        kind: "video" | "image" | "character";
        category: string;
        aspect: string;
        duration?: number;
        persona?: string;
        prompt: string;
        tags: string[];
      }
      const hits: Hit[] = [];
      for (const v of STOCK_VIDEOS) {
        const kind = v.category === "Characters" ? "character" : "video";
        if (kindIn && kindIn !== kind) continue;
        hits.push({
          id: v.id,
          kind,
          category: v.category,
          aspect: v.aspect,
          duration: round2(v.duration),
          ...(v.persona ? { persona: v.persona } : {}),
          prompt: v.prompt,
          tags: v.tags,
        });
      }
      if (!kindIn || kindIn === "image") {
        for (const i of STOCK_IMAGES) {
          hits.push({
            id: i.id,
            kind: "image",
            category: i.category,
            aspect: i.aspect,
            prompt: i.prompt,
            tags: i.tags,
          });
        }
      }
      const words = q.split(/\s+/).filter(Boolean);
      const matches = hits.filter((h) => {
        const hay = [h.id, h.category, h.prompt, h.persona ?? "", ...h.tags]
          .join(" ")
          .toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      const trim = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
      return {
        results: matches.slice(0, 12).map((h) => ({
          ...h,
          prompt: trim(h.prompt, 160),
          ...(h.persona ? { persona: trim(h.persona, 160) } : {}),
          tags: h.tags.slice(0, 6),
        })),
        total: matches.length,
        ...(matches.length > 12 ? { truncated: true } : {}),
      };
  },

  stock_add: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const id = String(input.id ?? "");
      const vid = STOCK_VIDEOS.find((v) => v.id === id);
      const img = vid ? undefined : STOCK_IMAGES.find((i) => i.id === id);
      if (!vid && !img)
        throw new ToolError(`No stock item with id ${id}. Call stock_search for ids.`);
      // Captured before the import: the media files under the chat that
      // asked, even if the user switches threads while it downloads.
      const chatId = chatOwner();
      const asset = vid
        ? await importStockVideo(projectId, {
            url: vid.file,
            name: stockTitle(vid.id),
            duration: vid.duration,
            ...stockAspectDims(vid.aspect),
          })
        : await importImage(projectId, { url: img!.file, name: stockTitle(img!.id) });
      tagChatAsset(asset.id, chatId);
      const addToTimeline = wantsTimeline(input, "start");
      let clipId: string | null = null;
      if (addToTimeline) {
        useEditor
          .getState()
          .addClipFromAsset(asset.id, isNum(input.start) ? Math.max(0, input.start) : undefined);
        const sel = useEditor.getState().selection;
        clipId = sel?.kind === "clip" ? sel.id : null;
      }
      return {
        assetId: asset.id,
        name: asset.name,
        kind: vid ? "video" : "image",
        duration: round2(vid ? asset.duration : IMAGE_CLIP_SECONDS),
        addedToTimeline: addToTimeline,
        clipId,
      };
  },

  import_url: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const url = String(input.url ?? "").trim();
      if (!url) throw new ToolError("A URL is required.");
      // Captured before the download: the media files under the chat that
      // asked, even if the user switches threads while it downloads.
      const chatId = chatOwner();
      const { assets, text } = await importUrlMedia(projectId, url);
      for (const asset of assets) tagChatAsset(asset.id, chatId);
      return {
        assets: assets.map((asset) => ({
          assetId: asset.id,
          name: asset.name,
          kind: asset.type,
          duration: round2(asset.type === "image" ? IMAGE_CLIP_SECONDS : asset.duration),
        })),
        ...(text ? { sourceText: text } : {}),
      };
  },

  library_list: async () => {
      const lib = await fetchLibrary();
      return {
        folders: lib.folders.map((f) => ({ id: f.id, name: f.name })),
        assets: lib.assets.map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.type,
          duration: round2(a.duration),
          ...(a.folderId ? { folderId: a.folderId } : {}),
          // "camera" = recorded on the user's phone (their Camera Roll);
          // "inspiration" = saved from the phone's Ideas tab.
          ...(a.origin ? { origin: a.origin } : {}),
        })),
        templates: lib.templates.map((t) => ({
          id: t.id,
          name: t.name,
          duration: round2(t.duration),
          parts: t.layers.length + t.audio.length + t.texts.length + t.cues.length,
        })),
      };
  },

  notes_list: async () => {
      const { notes, folders } = await fetchNotes();
      const folderName = new Map(folders.map((f) => [f.id, f.name]));
      return {
        folders: folders.map((f) => ({ id: f.id, name: f.name })),
        notes: notes.map((n) => ({
          id: n.id,
          title: n.title,
          body: n.body,
          ...(n.folderId ? { folder: folderName.get(n.folderId) ?? n.folderId } : {}),
          updatedAt: new Date(n.updatedAt).toISOString(),
        })),
      };
  },

  library_add: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const lib = (await fetchLibrary()).assets.find((a) => a.id === String(input.id ?? ""));
      if (!lib)
        throw new ToolError(`No library asset with id ${String(input.id)}. Call library_list for ids.`);
      if (lib.type === "font")
        throw new ToolError(
          `"${lib.name}" is a font. It is already available to this project — set a title or the captions to font id font:${lib.id}.`
        );
      // Captured before the import: the media files under the chat that asked,
      // even if the user switches threads while it copies.
      const chatId = chatOwner();
      const asset = await importLibraryAsset(projectId, lib);
      tagChatAsset(asset.id, chatId);
      const place =
        input.add_to_timeline === true || isNum(input.start) || isNum(input.index);
      return {
        assetId: asset.id,
        name: asset.name,
        kind: asset.type,
        duration: round2(asset.type === "image" ? IMAGE_CLIP_SECONDS : asset.duration),
        ...(place
          ? { addedToTimeline: true, clip: placeAssetOnTimeline(asset, input) }
          : { addedToTimeline: false }),
      };
  },

  template_add: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const t = (await fetchLibrary()).templates.find((x) => x.id === String(input.id ?? ""));
      if (!t)
        throw new ToolError(`No template with id ${String(input.id)}. Call library_list for ids.`);
      const chatId = chatOwner();
      const before = new Set(s.assets.map((a) => a.id));
      await addTemplateToProject(projectId, t);
      // Chat-fetched media files under the asking thread, like stock/library
      // imports; the template's clips reference it, so it survives cleanup.
      for (const a of useEditor.getState().assets) {
        if (!before.has(a.id)) tagChatAsset(a.id, chatId);
      }
      return {
        added: t.name,
        duration: round2(t.duration),
        parts: t.layers.length + t.audio.length + t.texts.length + t.cues.length,
      };
  },

  save_template: (s, input) => {
      if (!s.projectId) throw new ToolError("No project open.");
      const name = String(input.name ?? "").trim();
      if (!name) throw new ToolError("A template name is required.");
      const ids = Array.isArray(input.item_ids) ? input.item_ids.map(String) : [];
      if (ids.length === 0) throw new ToolError("item_ids is required — the timeline items to save.");
      const sels = ids.map((id): NonNullable<Selection> => {
        if (s.clips.some((c) => c.id === id)) return { kind: "clip", id };
        if (s.audioClips.some((c) => c.id === id)) return { kind: "audio", id };
        if (s.overlays.some((o) => o.id === id)) return { kind: "overlay", id };
        if (s.subtitles.cues.some((c) => c.id === id)) return { kind: "cue", id };
        throw new ToolError(`No timeline item with id ${id}. Call get_state for current ids.`);
      });
      // Build through the store's selection-template path — the same shape the
      // user's Save-selection button produces — leaving the items selected.
      s.select(sels[0]);
      for (const sel of sels.slice(1)) s.toggleSelect(sel);
      const built = useEditor.getState().selectionTemplate();
      if (!built) throw new ToolError("Could not build a template from those items.");
      const saved = useEditor.getState().addTemplate({ ...built, name });
      return { id: saved.id, name: saved.name, duration: round2(saved.duration) };
  },

  library_organize: async (_s, input) => {
      // The library spans every shelf, so each id is resolved against the
      // current listing to find the backend that owns it.
      const lib = await fetchLibrary();
      const folderShelf = (id: string) => lib.folders.find((f) => f.id === id)?.residency;
      const itemShelf = (id: string) =>
        lib.assets.find((a) => a.id === id)?.residency ??
        lib.templates.find((t) => t.id === id)?.residency;
      switch (String(input.action ?? "")) {
        case "create_folder": {
          const name = String(input.name ?? "").trim();
          if (!name) throw new ToolError("A folder name is required.");
          const f = await createLibraryFolder(name);
          return { folderId: f.id, name: f.name };
        }
        case "rename_folder": {
          const name = String(input.name ?? "").trim();
          if (!name) throw new ToolError("A folder name is required.");
          const id = String(input.folder_id ?? "");
          const r = folderShelf(id);
          if (!r) throw new ToolError(`No library folder with id ${id}.`);
          await renameLibraryFolder(r, id, name);
          return { renamed: true, name };
        }
        case "delete_folder": {
          const id = String(input.folder_id ?? "");
          const r = folderShelf(id);
          if (!r) throw new ToolError(`No library folder with id ${id}.`);
          await deleteLibraryFolder(r, id);
          return { deleted: true, note: "Its assets moved to the Library root." };
        }
        case "move_asset": {
          const folderId =
            typeof input.folder_id === "string" && input.folder_id ? input.folder_id : null;
          const id = String(input.id ?? "");
          const r = itemShelf(id);
          if (!r) throw new ToolError(`No library item with id ${id}.`);
          if (folderId && folderShelf(folderId) !== r) {
            throw new ToolError("That folder is on a different library shelf.");
          }
          await moveLibraryItem(r, id, folderId);
          return { moved: true, folderId };
        }
        case "delete_asset": {
          const id = String(input.id ?? "");
          const r = lib.assets.find((a) => a.id === id)?.residency;
          if (!r) throw new ToolError(`No library asset with id ${id}.`);
          await deleteFromLibrary(r, id);
          return { deleted: true };
        }
        case "delete_template": {
          const id = String(input.id ?? "");
          const r = lib.templates.find((t) => t.id === id)?.residency;
          if (!r) throw new ToolError(`No library template with id ${id}.`);
          await deleteTemplate(r, id);
          return { deleted: true };
        }
        default:
          throw new ToolError(`Unknown action "${String(input.action)}".`);
      }
  },

  file_asset: async (s, input) => {
      const asset = requireItem(s.assets, input.asset_id, "project asset");
      if (input.to === "media") {
        s.updateAsset(asset.id, { origin: undefined, chatId: undefined });
        return { filed: "media", name: asset.name };
      }
      if (input.to === "library") {
        const projectId = s.projectId;
        if (!projectId) throw new ToolError("No project open.");
        const saved = await saveAssetToLibrary(projectId, asset);
        return { filed: "library", libraryId: saved.id, name: saved.name };
      }
      throw new ToolError('`to` must be "media" or "library".');
  },

  convert_media: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const ids = Array.isArray(input.asset_ids) ? input.asset_ids.map((v) => String(v)) : [];
      if (ids.length === 0) throw new ToolError("Pass the asset ids to convert.");
      const maxHeight = isNum(input.max_height) ? Math.round(input.max_height) : undefined;
      // Named `assets` so each converted file renders as its own card in the
      // thread (ToolOutputAssets keys off assetId) — the user drops files on
      // the chat and takes the MP4s back from the same place.
      const converted: Record<string, unknown>[] = [];
      const failed: { assetId: string; name?: string; error: string }[] = [];
      for (const id of ids) {
        // Read live: each conversion rewrites the asset it just finished.
        const asset = useEditor.getState().assets.find((a) => a.id === id);
        if (!asset) {
          failed.push({ assetId: id, error: `No project asset with id ${id}.` });
          continue;
        }
        try {
          const out = await convertAssetToMp4(projectId, asset, { maxHeight });
          converted.push({
            assetId: out.assetId,
            // The card now reads `name`; `from` is what the user dropped.
            name: out.name,
            ...(out.name !== asset.name ? { from: asset.name } : {}),
            file: out.fileName,
            // False means the packets were copied — same picture, new container.
            reencoded: out.reencoded,
            ...(out.unchanged ? { unchanged: true } : {}),
            duration: round2(out.duration),
            ...(out.width !== undefined ? { width: out.width, height: out.height } : {}),
            // The file stayed where it already lived: a chat attachment on its
            // card in this thread, an import in the Media panel.
            where: asset.origin === "chat" ? "chat card" : asset.origin ?? "media panel",
          });
        } catch (e) {
          failed.push({
            assetId: id,
            name: asset.name,
            error: e instanceof Error ? e.message : "Could not convert that file.",
          });
        }
      }
      if (converted.length === 0) throw new ToolError(failed[0]?.error ?? "Nothing was converted.");
      const untouched = converted.every((c) => c.unchanged);
      return {
        assets: converted,
        ...(failed.length > 0 ? { failed } : {}),
        ...(untouched
          ? { note: "These were already MP4 with H.264 picture and AAC sound, so they were left as they are — say so." }
          : {}),
      };
  },

  delete_asset: (s, input) => {
      const asset = requireItem(s.assets, input.asset_id, "project asset");
      const uses =
        s.clips.filter((c) => c.assetId === asset.id).length +
        s.audioClips.filter((c) => c.assetId === asset.id).length;
      s.removeAsset(asset.id);
      return { removed: asset.name, clipsRemoved: uses };
  },

  subtitles_generate: async (_s, input) => {
      const lane = targetSubtitleTrack(input);
      if (typeof input.locale === "string" && input.locale)
        useEditor.getState().setSubtitleTrackMeta(lane, { locale: input.locale });
      await useEditor.getState().generateSubtitles();
      const cur = useEditor.getState();
      if (cur.subtitleStatus === "error")
        throw new ToolError(cur.subtitleError ?? "Transcription failed.");
      const made = laneCues(cur.subtitles, lane);
      if (made.length > 0 && cur.timelineH < 276) cur.setTimelineH(276);
      // The cues ride the result — the model's next move is usually editing
      // them, and the ids are what update_cue/delete_cue/merge_cue take.
      return {
        status: cur.subtitleStatus,
        track: lane,
        count: made.length,
        cues: made
          .slice(0, 60)
          .map((q) => ({ id: q.id, start: round2(q.start), end: round2(q.end), text: q.text })),
        ...(made.length > 60 ? { cuesTruncated: true } : {}),
        note:
          cur.subtitleStatus === "empty"
            ? "No speech found — no subtitles were added to the video."
            : undefined,
      };
  },

  captions_generate: async (_s, input) => {
      const raw = typeof input.style === "string" ? input.style : "hook";
      const style = (["clean", "hook", "punchy"].includes(raw) ? raw : "hook") as
        | "clean"
        | "hook"
        | "punchy";
      const lane = targetSubtitleTrack(input);
      await useEditor.getState().generateCaptions(style);
      const cur = useEditor.getState();
      if (cur.subtitleStatus === "error")
        throw new ToolError(cur.subtitleError ?? "Captions failed.");
      const made = laneCues(cur.subtitles, lane).length;
      if (made > 0 && cur.timelineH < 276) cur.setTimelineH(276);
      return {
        status: cur.subtitleStatus,
        track: lane,
        cues: made,
        style: cur.subtitles.style,
        note:
          cur.subtitleStatus === "empty"
            ? "No speech found — no captions were added to the video."
            : undefined,
      };
  },

  subtitles_from_visuals: async (_s, input) => {
      const lane = targetSubtitleTrack(input);
      if (typeof input.locale === "string" && input.locale)
        useEditor.getState().setSubtitleTrackMeta(lane, { locale: input.locale });
      await useEditor.getState().generateVisualSubtitles();
      const cur = useEditor.getState();
      if (cur.subtitleStatus === "error")
        throw new ToolError(cur.subtitleError ?? "Visual captioning failed.");
      const made = laneCues(cur.subtitles, lane).length;
      if (made > 0 && cur.timelineH < 276) cur.setTimelineH(276);
      return { status: cur.subtitleStatus, track: lane, cues: made };
  },

  subtitles_add_track: (s, input) => {
      const count = subtitleLaneCount(s.subtitles);
      if (count >= MAX_SUBTITLE_LANES)
        throw new ToolError(`Already at ${MAX_SUBTITLE_LANES} subtitle tracks.`);
      s.addSubtitleTrack(
        typeof input.language === "string" && input.language.trim()
          ? input.language.trim()
          : undefined
      );
      return { track: count, tracks: count + 1 };
  },

  subtitles_remove_track: (s, input) => {
      if (!isNum(input.track)) throw new ToolError("track is required.");
      const lane = Math.round(input.track);
      const count = subtitleLaneCount(s.subtitles);
      if (lane < 0 || lane >= count) throw new ToolError(`No subtitle track ${lane}.`);
      if (count <= 1) {
        // The editor always keeps one lane, so removing the only track
        // empties it instead.
        const cleared = laneCues(s.subtitles, 0).length;
        s.removeSubtitleTrack(0);
        return { track: 0, tracks: 1, clearedCues: cleared };
      }
      s.removeSubtitleTrack(lane);
      return { removed: lane, tracks: count - 1 };
  },

  subtitles_translate_track: async (s, input) => {
      const language = typeof input.language === "string" ? input.language.trim() : "";
      if (!language) throw new ToolError("language (BCP-47, e.g. ko-KR) is required.");
      const subs = s.subtitles;
      const count = subtitleLaneCount(subs);
      const localeOf = (i: number) =>
        subs.tracks?.[i]?.locale ?? (i === 0 ? subs.locale : undefined);
      const hasCues = (i: number) => laneCues(subs, i).length > 0;
      const lanes = Array.from({ length: count }, (_, i) => i);
      const from = isNum(input.from_track)
        ? Math.round(input.from_track)
        : lanes.find(hasCues) ?? -1;
      if (from < 0 || from >= count || !hasCues(from))
        throw new ToolError("No captions to translate — generate subtitles first.");
      // Reuse the track already set to this language, else add one.
      let target = lanes.find((i) => i !== from && localeOf(i) === language) ?? -1;
      if (target < 0) {
        if (count >= MAX_SUBTITLE_LANES)
          throw new ToolError(
            `Already at ${MAX_SUBTITLE_LANES} subtitle tracks — remove one first.`
          );
        s.addSubtitleTrack(language);
        target = count;
      }
      const st = useEditor.getState();
      st.setSubtitleLane(target);
      st.setSubtitleTrackMeta(target, { locale: language });
      await useEditor.getState().translateSubtitleTrack(from);
      const cur = useEditor.getState();
      if (cur.subtitleStatus === "error")
        throw new ToolError(cur.subtitleError ?? "Translation failed.");
      if (cur.timelineH < 276) cur.setTimelineH(276);
      return {
        track: target,
        language,
        from,
        cues: laneCues(cur.subtitles, target).length,
      };
  },

  list_voices: () => {
      // Gemini's prebuilt voice catalog is fixed and ships hardcoded.
      return {
        voices: SPEECH_VOICES.map((v) => ({ name: v.name, style: v.style })),
        total: SPEECH_VOICES.length,
      };
  },

  voiceover_generate: (s, input) => {
      if (typeof input.script !== "string" || !input.script.trim())
        throw new ToolError("script is required.");
      const start = isNum(input.start) ? Math.max(0, input.start) : playheadAt();
      // Label with the spoken line (capped) so its preview fills across the row.
      const lead = input.script.replace(/\s+/g, " ").trim().slice(0, 200);
      const place = wantsTimeline(input, "start");
      return synthesizeVoiceover(
        [{ text: input.script, at: 0 }],
        `AI voice — ${lead}`,
        start,
        input,
        place
      );
  },

  generate_music: async (s, input) => {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt) throw new ToolError("A prompt is required.");
      const gen = useGenerate.getState();
      // An unprobed session (null) resolves before we spend the user's credits.
      const signedIn = gen.signedIn ?? (await gen.probeNow());
      if (!signedIn) throw new ToolError("Sign in to Donkey to generate music.");
      const variant = input.length === "song" ? "song" : "clip";
      // Default to a vocal-free bed; the model opts into a sung song explicitly.
      const instrumental = input.instrumental !== false;
      // References ("match this audio", "the tone of this video"): the music
      // model reads only text, so a multimodal pass listens to/looks at each
      // reference and folds a description of its sound into the prompt. A failed
      // compose falls back to the raw prompt so the render still happens. Keep
      // the user's own words as the track name — the composed prompt is verbose.
      const refs = resolveRefAssets(input.reference_asset_ids);
      let sent = prompt;
      if (refs.length > 0) {
        const composed = await composeMusicPrompt(prompt, refs);
        if (composed) sent = composed;
      }
      // Captured before synthesis: the track files under the chat that asked,
      // even if the user switches threads while it renders.
      const chatId = chatOwner();
      const asset = await synthesizeMusic(projectId, sent, {
        variant,
        instrumental,
        ...(sent !== prompt ? { name: prompt } : {}),
      });
      const cur = useEditor.getState();
      // The render can outlast the open project: if the user switched away while
      // it ran, save it into the project it was made for — never the one now on
      // screen — and don't touch the current store.
      if (cur.projectId !== projectId) {
        // Stamp chat ownership before persisting — the render outlived the open
        // project, but it still belongs to the thread that asked, exactly as the
        // still-open path tags it (and as generate.ts persists chat renders).
        applyOwnership(asset, chatId);
        void stockAssetInDoc(projectId, asset).catch(() => {});
        return {
          assetId: asset.id,
          name: asset.name,
          duration: round2(asset.duration),
          addedToTimeline: false,
          note: "The music finished and was saved to the project it was generated for; the user has since switched projects, so it isn't on this one.",
        };
      }
      cur.addAsset(asset);
      tagChatAsset(asset.id, chatId);
      void enrichAsset(asset);
      if (!wantsTimeline(input, "start")) {
        return {
          assetId: asset.id,
          name: asset.name,
          duration: round2(asset.duration),
          addedToTimeline: false,
          note: "The music previews in this chat — the user can play it and drag it onto the soundtrack; pass add_to_timeline or start when they ask for it in the cut.",
        };
      }
      const start = isNum(input.start) ? Math.max(0, input.start) : playheadAt();
      cur.addAudioFromAsset(asset.id, start);
      // Sits under speech at a soft bed volume by default; the model can raise it.
      const volume = isNum(input.volume) ? clamp(input.volume, 0, 1.5) : 0.4;
      const sel = useEditor.getState().selection;
      const clipId = sel?.kind === "audio" ? sel.id : null;
      if (clipId) useEditor.getState().updateAudio(clipId, { volume });
      // Report where the clip actually landed: addAudioFromAsset slides it to the
      // next free slot on the soundtrack when the requested start overlaps
      // existing audio, so `start` is not necessarily where it sits.
      const placed = clipId
        ? useEditor.getState().audioClips.find((c) => c.id === clipId)
        : undefined;
      const placedStart = placed?.start ?? start;
      return {
        assetId: asset.id,
        name: asset.name,
        audioClipId: clipId,
        start: round2(placedStart),
        duration: round2(asset.duration),
        volume,
        addedToTimeline: true,
      };
  },

  read_subtitles_aloud: async (s, input) => {
      const lane = targetSubtitleTrack(input);
      if (!laneCues(useEditor.getState().subtitles, lane).some((c) => c.text.trim()))
        throw new ToolError("No subtitles on that track — generate subtitles first.");
      const voice = resolveVoice(typeof input.voice === "string" ? input.voice : undefined);
      // The shared readout also re-times the cues to the generated voice's
      // pace, keeping the word highlighter in step.
      const out = await generateSubtitlesReadout(voice, {
        direction:
          typeof input.direction === "string" && input.direction.trim()
            ? input.direction.trim()
            : undefined,
        language: typeof input.language === "string" ? input.language : undefined,
        duck: isNum(input.duck) ? clamp(input.duck, 0, 1) : undefined,
      });
      const sel = useEditor.getState().selection;
      return {
        assetId: out.asset.id,
        name: out.asset.name,
        audioClipId: sel?.kind === "audio" ? sel.id : null,
        voice,
        start: round2(out.start),
        duration: round2(out.asset.duration),
        duck: out.duck,
        lines: out.lines,
      };
  },

  subtitles_set_view: (s, input) => {
      const patch: { showOnVideo?: boolean; showOnTimeline?: boolean } = {};
      if (typeof input.showOnVideo === "boolean") patch.showOnVideo = input.showOnVideo;
      if (typeof input.showOnTimeline === "boolean") patch.showOnTimeline = input.showOnTimeline;
      s.setSubtitlesView(patch);
      if (patch.showOnTimeline && s.subtitles.cues.length > 0 && s.timelineH < 276) s.setTimelineH(276);
      return patch;
  },

  update_cue: (s, input) => {
      const cue = requireItem(s.subtitles.cues, input.id, "subtitle cue");
      if (typeof input.text === "string") s.setCueText(cue.id, input.text);
      if (isNum(input.start) || isNum(input.end)) {
        const start = isNum(input.start) ? Math.max(0, input.start) : cue.start;
        const end = isNum(input.end) ? input.end : cue.end;
        if (end - start < 0.15) throw new ToolError("Cue must stay at least 0.15s long.");
        s.setCueTiming(cue.id, start, end);
      }
      const next = useEditor.getState().subtitles.cues.find((c) => c.id === cue.id);
      return next ? { id: next.id, start: next.start, end: next.end, text: next.text } : { deleted: cue.id };
  },

  delete_cue: (s, input) => {
      const cue = requireItem(s.subtitles.cues, input.id, "subtitle cue");
      s.deleteCue(cue.id);
      return { deleted: cue.id };
  },

  set_publish: (s, input) => {
      const patch: Record<string, string> = {};
      for (const k of ["caption", "tags", "soundTitle", "handle"] as const) {
        if (typeof input[k] === "string") patch[k] = input[k] as string;
      }
      if (Object.keys(patch).length === 0) throw new ToolError("Nothing to change.");
      s.setPublish(patch);
      return patch;
  },

  set_view: (s, input) => {
      const out: Record<string, number> = {};
      if (input.fit) {
        const el = document.querySelector<HTMLElement>(".tl-scroll");
        const dur = totalDuration(s.clips);
        if (el && dur > 0) {
          s.setPxPerSec((el.clientWidth - 60) / dur);
          el.scrollLeft = 0;
        }
        out.pxPerSec = useEditor.getState().pxPerSec;
      } else if (isNum(input.pxPerSec)) {
        s.setPxPerSec(input.pxPerSec);
        out.pxPerSec = useEditor.getState().pxPerSec;
      }
      if (isNum(input.timelineH)) {
        s.setTimelineH(input.timelineH);
        out.timelineH = useEditor.getState().timelineH;
      }
      return out;
  },

  undo: (s) => {
      s.undo();
      return { ok: true };
  },

  redo: (s) => {
      s.redo();
      return { ok: true };
  },

  open_export: (s) => {
      if (!(projectDuration(s) > 0))
        throw new ToolError("Add something to the timeline first.");
      s.setExportOpen(true);
      return { open: true };
  },

  set_speed: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      if (!isNum(input.speed)) throw new ToolError("speed is required (e.g. 1.5).");
      s.setClipSpeed(clip.id, input.speed);
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, speed: next.speed ?? 1 };
  },

  set_color_grade: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      // reset and auto rebuild the manual layer; the preset layer stays.
      let grade: ColorGrade =
        input.reset === true ? { preset: clip.grade?.preset } : { ...clip.grade };
      if (input.auto === true) {
        const data = sampleClipFrameData(clip.id);
        if (!data)
          throw new ToolError(
            "No decoded frame for that clip yet — seek into it so it is on screen, then retry."
          );
        grade = { ...autoGradeFromImageData(data), preset: clip.grade?.preset };
      }
      for (const k of GRADE_KEYS) if (isNum(input[k])) grade[k] = input[k];
      s.updateClip(clip.id, { grade: normalizeGrade(grade) });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, grade: next.grade ?? "neutral" };
  },

  set_color_preset: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      const id = typeof input.preset === "string" ? input.preset : "";
      if (id !== "none" && !GRADE_PRESETS[id])
        throw new ToolError(`No color preset "${id}" — pass one of the catalog ids or "none".`);
      const preset =
        id === "none"
          ? undefined
          : {
              id,
              amount: isNum(input.amount) ? Math.max(0, Math.min(1, input.amount)) : undefined,
              skin: input.protect_skin === true || undefined,
            };
      s.updateClip(clip.id, { grade: normalizeGrade({ ...clip.grade, preset }) });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return {
        id: next.id,
        preset: next.grade?.preset ?? "none",
        ...(preset ? { label: GRADE_PRESETS[id].label } : {}),
        ...(preset && next.grade?.preset?.amount === 0
          ? { note: "amount 0 holds the preset at neutral — raise it for the look to show." }
          : {}),
      };
  },

  set_color_curves: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      const curves: GradeCurves = input.reset === true ? {} : { ...clip.grade?.curves };
      const channels = [
        ["m", input.master],
        ["r", input.red],
        ["g", input.green],
        ["b", input.blue],
      ] as const;
      for (const [ch, pts] of channels) {
        if (!Array.isArray(pts)) continue;
        if (pts.length === 0) delete curves[ch];
        else curves[ch] = pts as CurvePoint[];
      }
      if (isNum(input.curve_contrast) || isNum(input.fade)) {
        const master = semanticMasterCurve(
          isNum(input.curve_contrast) ? input.curve_contrast : 0,
          isNum(input.fade) ? input.fade : 0
        );
        if (master) curves.m = master;
        else delete curves.m;
      }
      s.updateClip(clip.id, { grade: normalizeGrade({ ...clip.grade, curves }) });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, curves: next.grade?.curves ?? "neutral" };
  },

  set_color_wheels: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      const wheels = input.reset === true ? {} : { ...clip.grade?.wheels };
      const zones = [
        ["s", input.shadows],
        ["m", input.midtones],
        ["h", input.highlights],
      ] as const;
      for (const [zone, w] of zones) {
        if (!w || typeof w !== "object") continue;
        const t = w as { dx?: number; dy?: number; luma?: number };
        wheels[zone] = [t.dx ?? 0, t.dy ?? 0, t.luma ?? 0] as WheelTuple;
      }
      s.updateClip(clip.id, { grade: normalizeGrade({ ...clip.grade, wheels }) });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, wheels: next.grade?.wheels ?? "neutral" };
  },

  set_color_hsl: (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      const hsl = input.reset_all === true ? {} : { ...clip.grade?.hsl };
      const band = typeof input.band === "string" ? (input.band as HslBand) : undefined;
      if (band) {
        if (!HSL_BANDS.some((b) => b.id === band))
          throw new ToolError(`band must be one of ${HSL_BANDS.map((b) => b.id).join(", ")}.`);
        hsl[band] = [
          isNum(input.hue) ? input.hue : 0,
          isNum(input.sat) ? input.sat : 0,
          isNum(input.luma) ? input.luma : 0,
        ];
      } else if (input.reset_all !== true) {
        throw new ToolError("Pass a band to adjust, or reset_all to clear every band.");
      }
      s.updateClip(clip.id, { grade: normalizeGrade({ ...clip.grade, hsl }) });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, hsl: next.grade?.hsl ?? "neutral" };
  },

  read_color_stats: async (s, input) => {
      const stats = await colorStatsForRef(s, {
        clipId: typeof input.clipId === "string" ? input.clipId : undefined,
        assetId: typeof input.assetId === "string" ? input.assetId : undefined,
      });
      return statsReport(stats);
  },

  match_color_grade: async (s, input) => {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      const source = await colorStatsForRef(s, { clipId: clip.id });
      const reference = await colorStatsForRef(s, {
        clipId: typeof input.ref_clip_id === "string" ? input.ref_clip_id : undefined,
        assetId: typeof input.ref_asset_id === "string" ? input.ref_asset_id : undefined,
      });
      const grade = matchGrade(source, reference);
      // The frames already agree: the clip's own grade stays as it is rather
      // than being wiped by a match that has nothing to say.
      if (!grade)
        return {
          id: clip.id,
          grade: clip.grade ?? "neutral",
          note: "The footage already matches the reference — nothing changed.",
        };
      // The computed curves carry the whole look, so the match replaces the
      // clip's grade — a preset left underneath would double the move.
      s.updateClip(clip.id, { grade });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return {
        id: next.id,
        grade: next.grade ?? "already matched (no change needed)",
        note: "Verify with read_color_stats on the clip and refine with the grading tools.",
      };
  },

  merge_cue: (s, input) => {
      const cue = requireItem(s.subtitles.cues, input.id, "subtitle cue");
      const mates = laneCues(s.subtitles, cue.lane ?? 0);
      if (mates.findIndex((c) => c.id === cue.id) <= 0)
        throw new ToolError("That is its track's first cue — nothing before it to merge into.");
      s.mergeCueIntoPrev(cue.id);
      return { mergedInto: "previous cue" };
  },

  set_aspect: (s, input) => {
      const a = typeof input.aspect === "string" ? normalizeAspect(input.aspect) : null;
      if (!a)
        throw new ToolError(
          'aspect must be "W:H" up to an 8:1 shape — whole or decimal sides, e.g. "9:16", "1:1", "9:2", "2.39:1".'
        );
      s.setAspect(a);
      const f = frameOf(a);
      return { aspect: a, frame: `${f.w}x${f.h}` };
  },

  set_project_fade: (s, input) => {
      if (!isNum(input.fadeIn) && !isNum(input.fadeOut))
        throw new ToolError("Pass fadeIn and/or fadeOut seconds (0 clears).");
      s.setProjectFade({
        ...(isNum(input.fadeIn) ? { fadeIn: input.fadeIn } : {}),
        ...(isNum(input.fadeOut) ? { fadeOut: input.fadeOut } : {}),
      });
      const after = useEditor.getState();
      return { fadeIn: after.fadeIn, fadeOut: after.fadeOut };
  },

  set_background: (s, input) => {
    const raw = typeof input.color === "string" ? input.color : "";
    const hex = projectBackground(raw);
    // projectBackground falls back rather than throwing, so a color it could
    // not read would silently paint the frame black. Say so instead.
    if (raw.trim() && hex === DEFAULT_BACKGROUND && !/^#?(000|000000)$/i.test(raw.trim()))
      throw new ToolError(`Could not read ${raw} as a color — pass a hex like #FFFFFF.`);
    s.setBackground(hex);
    return { background: useEditor.getState().background };
  },

  set_project_name: (s, input) => {
      if (typeof input.name !== "string" || !input.name.trim())
        throw new ToolError("name is required.");
      s.setProjectName(input.name.trim());
      return { name: input.name.trim() };
  },
};

class ToolError extends Error {}

/**
 * Execute an assistant tool call against the live editor store.
 * Returns a small JSON-safe result; throws ToolError with a readable message.
 */
/** Tools whose whole effect is the editor UI in an open tab — panel focus,
 * scroll, playback. A session with no page answers them with a typed no-op so
 * the model keeps its footing. Everything else runs anywhere the media
 * primitives do. */
export const UI_TOOLS: ReadonlySet<string> = new Set([
  "set_side_panel",
  "set_view",
  "open_export",
  "set_playing",
]);

/** Tools that decode or rasterize media — frame grabs, audio scans, image
 * decodes, the transcription mixdown. A page has those primitives and a
 * headless process installs them; a process that installed neither refuses
 * these with a typed error rather than a stray "document is not defined". */
export const MEDIA_RUNTIME_TOOLS: ReadonlySet<string> = new Set([
  "convert_media",
  "watch_video",
  "listen_audio",
  "detect_silence",
  "refine_speech_cuts",
  "capture_frame",
  "freeze_frame",
  "create_sticker",
  "subtitles_generate",
  "captions_generate",
  "subtitles_from_visuals",
  "sync_lyrics",
  "align_to_audio",
  "stock_add",
]);

export async function runAiTool(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const s = useEditor.getState();

  // "update_title" stays as an alias so older threads keep working.
  const key = name === "update_title" ? "update_overlay" : name;
  const run = (toolRuns as Partial<Record<string, ToolRun>>)[key];
  if (!run) throw new ToolError(`Unknown tool: ${name}`);
  return run(s, input);
}

/** Synthesize speech segments with hosted Gemini voices (the user's Donkey
 * sign-in and credits), register the media, and drop one soundtrack clip
 * (voiceovers duck other audio by default). Shared by voiceover_generate and
 * read_subtitles_aloud. */
async function synthesizeVoiceover(
  segments: { text: string; at: number }[],
  name: string,
  start: number,
  input: Record<string, unknown>,
  place: boolean
) {
  const projectId = useEditor.getState().projectId;
  if (!projectId) throw new ToolError("No project open.");
  const voice = resolveVoice(typeof input.voice === "string" ? input.voice : undefined);
  const direction =
    typeof input.direction === "string" && input.direction.trim()
      ? input.direction.trim()
      : undefined;
  const duck = isNum(input.duck) ? clamp(input.duck, 0, 1) : DUCK_DEFAULT;
  // Captured before synthesis: the audio files under the chat that asked,
  // even if the user switches threads while it renders.
  const chatId = chatOwner();
  const { asset, offset } = await synthesizeSpeech(projectId, segments, {
    voice,
    direction,
    language: typeof input.language === "string" ? input.language : undefined,
    name,
  });
  const cur = useEditor.getState();
  cur.addAsset(asset);
  tagChatAsset(asset.id, chatId);
  void enrichAsset(asset);
  if (!place) {
    return {
      assetId: asset.id,
      name: asset.name,
      voice,
      duration: round2(asset.duration),
      addedToTimeline: false,
      note: "The voiceover previews in this chat — the user can play it and drag it onto the soundtrack; pass add_to_timeline or start when they ask for it in the cut.",
    };
  }
  // A single script lands at `start`; a multi-line readout is pre-offset to its
  // first cue, so it lands at that offset.
  const at = segments.length === 1 ? start : offset;
  cur.addAudioFromAsset(asset.id, at, { duck: duck < 1 ? duck : undefined });
  const sel = useEditor.getState().selection;
  return {
    assetId: asset.id,
    name: asset.name,
    audioClipId: sel?.kind === "audio" ? sel.id : null,
    voice,
    start: round2(at),
    duration: round2(asset.duration),
    duck: duck < 1 ? duck : null,
    addedToTimeline: true,
  };
}

/** Resolve a watch/listen target: a timeline clip (its source plus trim and
 * placement) or a bare project asset. */
/** The words a caption track carries, on the timeline clock: the
 * transcriber's own word times where it left them, and an even split of each
 * cue's span where it did not. */
function cueWords(cues: { start: number; end: number; text: string; words?: TimedWord[] }[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const c of cues) {
    if (c.words && c.words.length > 0) {
      out.push(...c.words);
      continue;
    }
    const parts = c.text.split(/\s+/).filter((w) => w.length > 0);
    const step = parts.length > 0 ? (c.end - c.start) / parts.length : 0;
    parts.forEach((w, i) => out.push({ w, t0: c.start + step * i, t1: c.start + step * (i + 1) }));
  }
  return out;
}

/** An alignment pass as the model reads it. The audio declining to testify is
 * a result of its own, never a silent success: a caller told "0 moved" without
 * `evidence` would report a mix it could not read as captions already in sync. */
function syncResult(
  report: SyncReport<{ id: string; text: string; start: number; end: number }>,
  items: { id: string; text: string }[],
  only: ReadonlySet<string> | null
) {
  if (!report.evidence)
    return {
      evidence: false,
      moved: 0,
      note:
        "The mix has no readable speech edges over these times — digital silence, a bed of music that never lets up, " +
        "or speech that does not line up with them at all. Nothing moved, and nothing was confirmed either: check by ear with listen_audio.",
    };
  const moved = report.moved.filter((m) => !only || only.has(report.items[m.index].id));
  const sizes = moved.map((m) => Math.abs(m.shift)).sort((a, b) => a - b);
  const median = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 0;
  const worst = sizes.length > 0 ? sizes[sizes.length - 1] : 0;
  return {
    evidence: true,
    moved: moved.length,
    medianShift: median,
    maxShift: worst,
    items: moved.slice(0, 40).map((m) => ({
      id: report.items[m.index].id,
      text: items.find((i) => i.id === report.items[m.index].id)?.text,
      start: m.start,
      end: m.end,
      shift: m.shift,
    })),
    ...(moved.length > 40 ? { itemsTruncated: true } : {}),
    note:
      moved.length === 0
        ? "Every edge was already on the speech; nothing needed moving."
        : `${moved.length} moved onto the speech in the mix itself (median ${median}s, farthest ${worst}s). Times sitting inside continuous speech, where nothing audible marks a boundary, kept what they had.`,
  };
}

/** Several rows' passes read as one. Indexes are rebased onto the concatenated
 * item list the caller reports from. */
function mergeReports<T extends { id: string; text: string; start: number; end: number }>(
  reports: SyncReport<T>[]
): SyncReport<T> {
  const items: T[] = [];
  const moved: SyncReport<T>["moved"] = [];
  let evidence = false;
  for (const r of reports) {
    const base = items.length;
    items.push(...r.items);
    moved.push(...r.moved.map((m) => ({ ...m, index: base + m.index })));
    evidence ||= r.evidence;
  }
  const sizes = moved.map((m) => Math.abs(m.shift)).sort((a, b) => a - b);
  return {
    items,
    evidence,
    moved,
    medianShift: sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 0,
    maxShift: sizes.length > 0 ? sizes[sizes.length - 1] : 0,
  };
}

/** Whether dressing the project in this look repaints the frame color. A look
 * that keeps the frame only repaints it when the caller asked for it in so
 * many words — adding words to a cut is not a reason to recolor it. */
function paintsFrame(look: TextLook, background: unknown): boolean {
  if (typeof background === "boolean") return background;
  return look.keepsFrame !== true;
}

/** The lines a text sequence should place: the ones passed in, or the caption
 * track read as a running order. */
function textSequenceLines(
  s: ReturnType<typeof useEditor.getState>,
  input: Record<string, unknown>
): ComposeLine[] {
  if (input.from_captions === true || isNum(input.from_captions)) {
    const lane = isNum(input.from_captions) ? Math.max(0, Math.round(input.from_captions)) : 0;
    return laneCues(s.subtitles, lane).map((c) => ({
      text: c.text,
      start: round2(c.start),
      end: round2(c.end),
    }));
  }
  const raw = Array.isArray(input.lines) ? input.lines : [];
  const lines = raw
    .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null)
    .map((l) => ({
      text: typeof l.text === "string" ? l.text.replace(/\\n/g, "\n").trim() : "",
      start: isNum(l.start) ? Math.max(0, l.start) : NaN,
      end: isNum(l.end) ? l.end : NaN,
      ...(typeof l.color === "string" ? { color: l.color } : {}),
      ...(isNum(l.size) ? { size: clamp(Math.round(l.size), 16, 320) } : {}),
      ...(l.emphasis === "whisper" || l.emphasis === "hero" || l.emphasis === "normal"
        ? { emphasis: l.emphasis }
        : {}),
      ...(typeof l.section === "string" && l.section ? { section: l.section } : {}),
      ...(typeof l.font === "string" ? { font: l.font } : {}),
      ...(isNum(l.x) ? { x: clampOverlayPos(l.x) } : {}),
      ...(isNum(l.y) ? { y: clampOverlayPos(l.y) } : {}),
      ...(isNum(l.rotation) ? { rotation: clamp(l.rotation, -45, 45) } : {}),
      ...(typeof l.in_style === "string" ? { inStyle: l.in_style as OverlayAnimStyle } : {}),
      ...(typeof l.move === "string" && TEXT_MOVE_IDS.includes(l.move as TextMoveId)
        ? { move: l.move as TextMoveId }
        : {}),
    }))
    .filter((l) => l.text.length > 0);
  // A line with no times follows the one before it; the first starts at the
  // playhead. Every line gets a real span, so nothing lands on top of
  // anything.
  let cursor = playheadAt();
  return lines.map((l, i) => {
    const start = Number.isNaN(l.start) ? cursor : l.start;
    const nextStart = lines[i + 1]?.start ?? NaN;
    const fallbackEnd = Number.isNaN(nextStart) ? start + 2 : nextStart;
    // Every line lands at least 0.2s long, whichever way its end was
    // decided — a following line that starts earlier cannot invert it.
    const end = Math.max(Number.isNaN(l.end) ? fallbackEnd : l.end, start + 0.2);
    cursor = end;
    return { ...l, start: round2(start), end: round2(end) } as ComposeLine;
  });
}

/** Spans watched this session that nobody has written down yet, by asset id.
 * Contact sheets fall out of the conversation as it grows, so the record has
 * to be written while the frames are still on screen; a second look at the
 * same source asks for the first look's reading before it spends a call. */
const unwritten = new Map<string, { from: number; to: number }>();

/** A span counts as written down once notes describe all but a sliver of it. */
function spanIsNoted(watch: AssetWatch | undefined, span: { from: number; to: number }): boolean {
  let cursor = span.from;
  for (const n of [...(watch?.notes ?? [])].sort((a, b) => a.from - b.from)) {
    if (n.to <= cursor) continue;
    if (n.from > cursor + 2) break;
    cursor = Math.max(cursor, n.to);
  }
  return cursor >= span.to - 2;
}

/** What has been written about a stretch of a source: the notes overlapping
 * it, oldest span first. */
function notesIn(
  watch: AssetWatch | undefined,
  from: number,
  to: number
): { from: number; to: number; text: string }[] {
  return (watch?.notes ?? [])
    .filter((n) => n.to > from && n.from < to)
    .map((n) => ({ from: round2(n.from), to: round2(n.to), text: n.text }));
}

function resolveWatchTarget(
  s: ReturnType<typeof useEditor.getState>,
  input: Record<string, unknown>
): {
  asset: MediaAsset;
  clip: { id: string; start: number; in: number; out: number; speed?: number } | null;
} {
  if (input.clip_id !== undefined && input.clip_id !== null) {
    const id = String(input.clip_id);
    const clip =
      s.clips.find((c) => c.id === id) ??
      s.audioClips.find((c) => c.id === id);
    if (!clip) throw new ToolError(`No clip with id ${id}. Call get_state for current ids.`);
    const asset = s.assets.find((a) => a.id === clip.assetId);
    if (!asset) throw new ToolError("That clip's media asset is missing.");
    return { asset, clip };
  }
  if (input.asset_id !== undefined && input.asset_id !== null) {
    return { asset: requireItem(s.assets, input.asset_id, "project asset"), clip: null };
  }
  throw new ToolError("Pass clip_id or asset_id — see videoTrack and media in the editor state.");
}

/** The shared preamble for the source-reading tools (watch_video, detect_silence):
 * require an open project, resolve the target asset/clip, and derive the source
 * range to scan. Each tool then does its own media-type check and API call. */
function resolveWatchRange(
  s: ReturnType<typeof useEditor.getState>,
  input: Record<string, unknown>,
): {
  projectId: string;
  asset: MediaAsset;
  clip: { id: string; start: number; in: number; out: number; speed?: number } | null;
  speed: number;
  from: number;
  to: number | undefined;
} {
  const projectId = s.projectId;
  if (!projectId) throw new ToolError("No project open.");
  const { asset, clip } = resolveWatchTarget(s, input);
  const speed = clip?.speed && clip.speed > 0 ? clip.speed : 1;
  const dur = asset.duration > 0 ? asset.duration : Infinity;
  const from = clamp(isNum(input.from) ? input.from : clip ? clip.in : 0, 0, dur);
  // An unknown duration leaves `to` for the engine to probe.
  const to = isNum(input.to)
    ? clamp(input.to, 0, dur)
    : clip
      ? clip.out
      : Number.isFinite(dur)
        ? dur
        : undefined;
  if (to !== undefined && to <= from)
    throw new ToolError("from/to describe an empty range of the source.");
  return { projectId, asset, clip, speed, from, to };
}

/** Silent stretches of a source range, in source seconds — the engine's
 * ffmpeg scan locally, the browser's RMS fold in cloud mode. Shared by
 * detect_silence (the model's ears) and refine_speech_cuts (the mechanical
 * re-trim). */
async function fetchSilences(
  projectId: string,
  asset: MediaAsset,
  opts: { from: number; to?: number; thresholdDb?: number; minSilence?: number }
): Promise<{ start: number; end: number; duration: number }[]> {
  // Same defaults and clamps as the engine's silence handler.
  const thresholdDb = clamp(opts.thresholdDb ?? -30, -90, 0);
  const minSilence = clamp(opts.minSilence ?? 0.35, 0.05, 10);
  if (getBackend().kind !== "local") {
    return detectSilenceClientSide(asset.url, {
      from: opts.from,
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      thresholdDb,
      minSilence,
    }).catch((e) => {
      throw new ToolError(e instanceof Error ? e.message : "Could not scan for silence.");
    });
  }
  const res = await apiFetch(`/api/cut/projects/${projectId}/silence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file: asset.fileName,
      from: opts.from,
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      threshold_db: thresholdDb,
      min_silence: minSilence,
    }),
  });
  const body = await apiJson<{
    silences: { start: number; end: number; duration: number }[];
    error?: string;
  }>(res);
  if (!res.ok) throw new ToolError(body.error ?? "Could not scan for silence.");
  return body.silences;
}

/** Pull a source's audio track off (video and audio alike) and inline it for
 * the model; null when the range clears the inline cap. Local: the engine
 * extracts mono AAC. Cloud: the browser renders the span to 16 kHz mono WAV. */
async function listenToSource(
  projectId: string,
  asset: MediaAsset,
  from: number,
  to: number | undefined,
): Promise<InlineImage | null> {
  if (getBackend().kind !== "local") {
    const wav = await renderAudioSpanWav(asset.url, from, to).catch((e) => {
      throw new ToolError(e instanceof Error ? e.message : "Could not read the audio.");
    });
    return blobToInlineAudio(wav);
  }
  const res = await apiFetch(`/api/cut/projects/${projectId}/audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: asset.fileName, from, ...(to !== undefined ? { to } : {}) }),
  });
  if (!res.ok) {
    const body = await apiJson<{ error?: string }>(res).catch(() => ({ error: undefined }));
    throw new ToolError(body.error ?? "Could not read the audio.");
  }
  return blobToInlineAudio(await res.blob());
}

function requireItem<T extends { id: string }>(pool: T[], id: unknown, label: string): T {
  const item = pool.find((x) => x.id === String(id ?? ""));
  if (!item) throw new ToolError(`No ${label} with id ${String(id)}. Call get_state for current ids.`);
  return item;
}

/** Resolve a subtitle-track tool param (default: the active track), make it
 * the active track — generation, translation, and readout all write there. */
function targetSubtitleTrack(input: Record<string, unknown>): number {
  const s = useEditor.getState();
  const count = subtitleLaneCount(s.subtitles);
  const lane = isNum(input.track) ? Math.round(input.track) : s.subtitleLane;
  if (lane < 0 || lane >= count)
    throw new ToolError(
      `No subtitle track ${lane} — tracks 0–${count - 1} exist (subtitles_add_track adds one).`
    );
  s.setSubtitleLane(lane);
  return lane;
}

/** Map generation reference ids to project asset refs. Any media resolves:
 * images and video frames ride as pictures; audio rides to the compose pass,
 * which folds what it hears (speech, sound) into the prompt. An id may carry
 * a pinned moment as "<assetId>@<seconds>" — the model forwards a user's pin
 * this way, and the ref then reads from that moment (its frame capture, its
 * audio segment) instead of the default spot. */
function resolveRefAssets(ids: unknown): AssetRef[] {
  if (ids === undefined || ids === null) return [];
  const s = useEditor.getState();
  return (Array.isArray(ids) ? ids : [ids]).map((raw) => {
    const token = String(raw);
    const at = token.lastIndexOf("@");
    const suffix = at > 0 ? Number(token.slice(at + 1)) : NaN;
    const pinned = Number.isFinite(suffix) && suffix >= 0;
    const id = pinned ? token.slice(0, at) : token;
    // The whole token wins over the split when both name an asset — an id
    // that happens to contain "@" is still addressable.
    const asset = s.assets.find((a) => a.id === token) ?? (pinned ? s.assets.find((a) => a.id === id) : undefined);
    if (!asset)
      throw new ToolError(`No project asset with id ${token} — see media in the editor state.`);
    return pinned && asset.id === id ? { ...refFromAsset(asset), t: suffix } : refFromAsset(asset);
  });
}

/** An overlay clip's frame patch for a layout preset name. */
const OVERLAY_LAYOUT_KEYS = {
  full: "full",
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
  pip: "corner",
} as const;

function layoutPatch(layout: string): Partial<VideoClip> {
  const key = OVERLAY_LAYOUT_KEYS[layout as keyof typeof OVERLAY_LAYOUT_KEYS];
  if (!key)
    throw new ToolError(`Unknown layout "${layout}". Use full, top, bottom, left, right, or pip.`);
  const L = LAYOUTS[key];
  return { frame: key === "full" ? undefined : { ...L.rect }, fit: L.fit };
}

/** The model asked for timeline placement — explicitly, or implicitly by
 * giving a position. Otherwise generated media stays on its chat card. */
function wantsTimeline(input: Record<string, unknown>, positionKey: "index" | "start"): boolean {
  return input.add_to_timeline === true || isNum(input[positionKey]);
}

const NOT_PLACED = { added: false, clipId: null, index: null };

/** Place a project asset on the timeline like a drag: video/image onto track 0
 * (an `index` insert, a free-positioned `start`, or appended at the end),
 * audio onto the soundtrack. Returns the created clip's summary. */
function placeAssetOnTimeline(asset: MediaAsset, input: Record<string, unknown>) {
  const s = useEditor.getState();
  const start = isNum(input.start) ? Math.max(0, input.start) : undefined;
  if (asset.type === "audio") {
    s.addAudioFromAsset(asset.id, start);
    const sel = useEditor.getState().selection;
    const c =
      sel?.kind === "audio"
        ? useEditor.getState().audioClips.find((x) => x.id === sel.id)
        : undefined;
    if (!c) throw new ToolError("Could not create the soundtrack clip.");
    return { id: c.id, kind: asset.type, start: round2(c.start), len: round2(c.out - c.in) };
  }
  let clipId: string | null;
  if (isNum(input.index)) {
    clipId = addVideoTrackClip(asset.id, Math.round(input.index)).clipId;
  } else {
    s.addClipFromAsset(asset.id, start);
    const sel = useEditor.getState().selection;
    clipId = sel?.kind === "clip" ? sel.id : null;
  }
  const c = clipId ? useEditor.getState().clips.find((x) => x.id === clipId) : undefined;
  if (!c) throw new ToolError("Could not create the clip.");
  return {
    id: c.id,
    kind: asset.type,
    index: track0Clips(useEditor.getState().clips).findIndex((x) => x.id === c.id),
    start: round2(c.start),
    len: round2(c.out - c.in),
  };
}

const promptedIndex = (input: Record<string, unknown>): number | undefined =>
  isNum(input.index) ? Math.round(input.index) : undefined;

/** Append a project asset to the video track, at `index` when given. Shared
 * by add_clip, generate_image (inline), and the video renders' completion. */
function addVideoTrackClip(
  assetId: string,
  index?: number
): { added: boolean; clipId: string | null; index: number | null } {
  const s = useEditor.getState();
  if (!s.assets.some((a) => a.id === assetId)) return NOT_PLACED;
  s.addClipFromAsset(assetId); // lands at the end, selected
  const sel = useEditor.getState().selection;
  const clipId = sel?.kind === "clip" ? sel.id : null;
  const count = useEditor.getState().clips.length;
  const at = index === undefined ? count - 1 : clamp(Math.round(index), 0, count - 1);
  if (clipId && at !== count - 1) s.moveClip(clipId, at);
  return { added: true, clipId, index: at };
}

/** Start a video render — the shared shape of generate_video and
 * generate_character_video: one job (and one chat card) spans the ladder's
 * fallback rungs, the landed asset files under the asking chat, and it goes
 * onto the timeline only when the model asked.
 *
 * Awaits the submission, not the render: it returns started:true only once the
 * backend actually accepted the render, so the model can say it is underway. An
 * instant reject — bad credentials, no credits, a bad request — settles the
 * submit in well under a second and comes back started:false with the reason,
 * so the model reports the failure instead of narrating a clip that never
 * started. `success.note` overrides the default "rendering" line; `success.extra`
 * merges caller facts (the designed still, the character) into either outcome. */
async function launchVideoJob(
  projectId: string,
  input: Record<string, unknown>,
  attempts: VideoAttempt[],
  success?: { note?: string; extra?: Record<string, unknown> }
) {
  const addToTimeline = wantsTimeline(input, "index");
  const index = promptedIndex(input);
  // Captured now: the render must file under the chat that asked, even if
  // the user switches threads before it lands. Ownership rides the job from
  // creation, so neither the job row nor the landed asset ever touches the
  // Video panel — including a render that errors and lands no asset.
  const chatId = chatOwner();
  const { jobId, submitted } = useGenerate.getState().generateVideoLadder(projectId, attempts, {
    ...(chatId ? { chatId } : {}),
    onDone: (asset) => {
      if (addToTimeline) addVideoTrackClip(asset.id, index);
    },
  });
  const extra = success?.extra ?? {};
  const outcome = await submitted;
  if (!outcome.ok) {
    return {
      kind: "video",
      started: false,
      jobId,
      ...extra,
      error: outcome.error,
      note: `The render didn't start — ${outcome.error} Tell the user it failed; don't say it's rendering.`,
    };
  }
  return {
    kind: "video",
    started: true,
    jobId,
    addToTimeline,
    ...extra,
    note:
      success?.note ??
      ("Rendering — it previews in this chat when it lands, in a minute or two" +
        (addToTimeline
          ? ", and goes onto the timeline."
          : ". It stays in the chat until the user places it.")),
  };
}

/** Sanitize an overlay-element patch from tool input: shared fields (timing,
 * position, rotation, opacity, hidden) plus the target kind's own fields.
 * Outline width is em for text (scales with the type) and design px for
 * shapes, so the interpretation follows the element being patched. */
function overlayPatch(input: Record<string, unknown>, kind: "text" | "shape" | "sticker" | "effect") {
  const patch: Record<string, unknown> = {};
  if (isNum(input.start)) patch.start = Math.max(0, input.start);
  if (isNum(input.end)) patch.end = input.end;
  if (isNum(input.lane)) patch.lane = Math.max(0, Math.round(input.lane));
  if (isNum(input.x)) patch.x = clamp(input.x, 0.02, 0.98);
  if (isNum(input.y)) patch.y = clamp(input.y, 0.02, 0.98);
  if (isNum(input.rotation))
    patch.rotation = Math.round(clamp(input.rotation, -180, 180)) || undefined;
  if (isNum(input.opacity))
    patch.opacity = input.opacity >= 0.995 ? undefined : clamp(input.opacity, 0, 1);
  if (typeof input.hidden === "boolean") patch.hidden = input.hidden || undefined;

  if (kind === "text") {
    // A literal backslash-n in the call is always a meant newline — models
    // double-escape multi-line titles.
    if (typeof input.text === "string" && input.text.trim())
      patch.text = input.text.replace(/\\n/g, "\n");
    if (isNum(input.size)) patch.size = clamp(Math.round(input.size), 16, 320);
    if (typeof input.color === "string") patch.color = input.color;
    // Only ids the registry knows: an unknown one resolves to the default
    // face, so storing it would silently render a font the user never chose
    // and leave the Inspector's font menu blank.
    if (typeof input.font === "string" && allFonts().some((f) => f.id === input.font))
      patch.font = input.font as FontId;
    if (input.weight === 400 || input.weight === 700) patch.weight = input.weight;
    if (typeof input.italic === "boolean") patch.italic = input.italic || undefined;
    if (["left", "center", "right"].includes(String(input.align)))
      patch.align = input.align === "center" ? undefined : input.align;
    if (isNum(input.letter_spacing))
      patch.letterSpacing = Math.abs(input.letter_spacing) < 0.0025 ? undefined : clamp(input.letter_spacing, -0.05, 0.5);
    if (isNum(input.line_height))
      patch.lineHeight = Math.abs(input.line_height - 1.25) < 0.01 ? undefined : clamp(input.line_height, 0.7, 2.5);
    if (isNum(input.stretch_x))
      patch.stretchX = Math.abs(input.stretch_x - 1) < 0.005 ? undefined : clamp(input.stretch_x, 0.25, 4);
    if (isNum(input.stretch_y))
      patch.stretchY = Math.abs(input.stretch_y - 1) < 0.005 ? undefined : clamp(input.stretch_y, 0.25, 4);
    if (typeof input.shadow === "boolean") patch.shadow = input.shadow;
    if (typeof input.plate === "boolean") patch.plate = input.plate;
    if (isNum(input.plateRadius)) patch.plateRadius = clamp(input.plateRadius, 0, 1);
    if (typeof input.stroke_color === "string" || isNum(input.stroke_width)) {
      const width = isNum(input.stroke_width) ? clamp(input.stroke_width, 0, 0.3) : 0.04;
      patch.stroke =
        width > 0
          ? { color: typeof input.stroke_color === "string" ? input.stroke_color : "#111114", width }
          : undefined;
    }
    return patch;
  }

  if (kind === "shape") {
    if (isNum(input.w)) patch.w = clamp(input.w, 0.01, 2);
    if (isNum(input.h)) patch.h = clamp(input.h, 0.002, 2);
    if (typeof input.fill === "string") patch.fill = input.fill;
    if (isNum(input.fill_opacity))
      patch.fillOpacity = input.fill_opacity >= 0.995 ? undefined : clamp(input.fill_opacity, 0, 1);
    if (isNum(input.radius)) patch.radius = clamp(input.radius, 0, 200) || undefined;
    if (typeof input.stroke_color === "string" || isNum(input.stroke_width)) {
      const width = isNum(input.stroke_width) ? clamp(input.stroke_width, 0, 60) : 6;
      patch.stroke =
        width > 0
          ? { color: typeof input.stroke_color === "string" ? input.stroke_color : "#111114", width }
          : undefined;
    }
    return patch;
  }

  if (kind === "effect") {
    if (isNum(input.amount)) patch.amount = clamp(input.amount, 0.05, 1);
    return patch;
  }

  if (isNum(input.w)) patch.w = clamp(input.w, 0.02, 1.5);
  return patch;
}
