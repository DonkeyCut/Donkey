"use client";

import { apiFetch, apiJson, getBackend, type CutBackend } from "./backend";
import {
  removeBrowserExportJob,
  reserveBrowserExportJob,
  updateBrowserExportJob,
} from "./backend/browser/exportJobs";
import { exportsDir, readFileAt, saveExport } from "./backend/browser/opfs";
import { holdRegistered, registerBlobFile, releaseRegistered } from "./backend/browser/registry";
import { quotaErrorMessage } from "./backend/cloud";
import { downloadFromUrl } from "./download";
import { renderProjectToMp4 } from "./exportRender";
import { putSigned } from "./media";
import { createRasterCanvas, rasterCanvasToPng } from "./raster";
import { clipSpeed, getClipSpans, overlayLayers, projectDuration, spanSequence, useEditor } from "./store";
import { captionStyle, cueOverlay, cueWordWindows, laneCues, laneHidden, subtitleLaneCount, trackPos } from "./subtitles";
import { isMaskAnimated, isOverlayAnimated, normalizeGrade, paintMaskLuma } from "@donkeycut/effects-kit";
import { renderElementFrames, renderElementPng } from "./textRender";
import { clipCovers, clipKeyed, clipPosed, clipPoseAt, clipZoom, contentRect, frameOf, isStickerOverlay, isTextOverlay, laneOf, overlayAnimStyle, projectBackground, rectOf, regionPx, shadowInk, subjectMasked } from "./types";
import type {
  Aspect,
  AudioClip,
  ClipAnim,
  MediaAsset,
  Overlay,
  SubtitlesBlock,
  VideoClip,
} from "./types";

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
}

/** Presets pick a short-side target; `presetSettings` derives both dims from
 * the project ratio. */
export const EXPORT_PRESETS = [
  {
    id: "tiktok",
    label: "Best · 1080p",
    detail: "H.264 · best quality",
    shortSide: 1080,
    settings: { fps: 30, crf: 19, preset: "medium" },
  },
  {
    id: "fast",
    label: "Quick share · 1080p",
    detail: "smaller file, faster",
    shortSide: 1080,
    settings: { fps: 30, crf: 24, preset: "veryfast" },
  },
  {
    id: "light",
    label: "Draft · 720p",
    detail: "fastest render",
    shortSide: 720,
    settings: { fps: 30, crf: 24, preset: "veryfast" },
  },
] as const;

/** Frame dims for an aspect scaled to a short-side target, even-rounded. */
function scaledFrame(aspect: Aspect, shortSide: number): { width: number; height: number } {
  const f = frameOf(aspect);
  const k = shortSide / Math.min(f.w, f.h);
  const even = (n: number) => 2 * Math.round((n * k) / 2);
  return { width: even(f.w), height: even(f.h) };
}

export function presetSettings(
  preset: (typeof EXPORT_PRESETS)[number],
  aspect: Aspect
): ExportSettings {
  return { ...scaledFrame(aspect, preset.shortSide), ...preset.settings };
}

/**
 * "Original": the highest resolution the timeline's own footage justifies,
 * along the project aspect. It scales the 1080p base by the sharpest source
 * clip — never below the base (so it is always the highest option), never
 * above 4K, and never upscaled past the source. Unknown source sizes fall
 * back to the base.
 */
export function originalSettings(
  aspect: Aspect,
  clips: VideoClip[],
  assets: MediaAsset[]
): ExportSettings {
  const base = frameOf(aspect);
  const longBase = Math.max(base.w, base.h);
  const srcLong = Math.max(
    0,
    ...getClipSpans(clips, assets).map((sp) =>
      Math.max(sp.asset.width ?? 0, sp.asset.height ?? 0)
    )
  );
  // The 4K long-side cap wins over the 1080 base floor: a very wide custom
  // ratio (whose base already exceeds 3840) scales down to stay encodable.
  const k = Math.min(
    3840 / longBase,
    Math.min(2, Math.max(1, srcLong / longBase || 1))
  );
  const even = (n: number) => 2 * Math.round((n * k) / 2);
  return { width: even(base.w), height: even(base.h), fps: 30, crf: 19, preset: "medium" };
}

/**
 * Rough output size for a preset, in bytes. The encoder is CRF (variable
 * bitrate), so this is a heuristic: it models H.264 bits-per-pixel as halving
 * every +6 CRF from a ~0.08 bpp anchor at CRF 23, scaled by frame area and fps,
 * plus the fixed 192 kbps AAC audio. Busy footage runs larger and flat footage
 * smaller, so the dialog shows it as an approximation, not a promise.
 */
export function estimateExportBytes(settings: ExportSettings, durationSec: number): number {
  if (durationSec <= 0) return 0;
  const pixelsPerSec = settings.width * settings.height * settings.fps;
  const bpp = 0.08 * 2 ** ((23 - settings.crf) / 6);
  const videoBps = pixelsPerSec * bpp;
  const audioBps = 192_000;
  return ((videoBps + audioBps) * durationSec) / 8;
}

/** Human-readable size estimate matching the finished-export MB display. */
export function formatSizeEstimate(bytes: number): string {
  if (bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "~1 MB";
  if (mb < 1000) return `~${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `~${(mb / 1024).toFixed(1)} GB`;
}

/** Reveal a rendered export in Finder (local engine only). */
export async function revealExport(
  projectId: string,
  file: string,
  backend: CutBackend = getBackend()
) {
  await backend.fetch(
    `/api/cut/projects/${projectId}/exports/${encodeURIComponent(file)}/reveal`,
    { method: "POST" }
  );
}

/** Download a rendered export by file name — what stands in for revealExport
 * when the backend has no Finder (the cloud route 302s to a signed R2 URL with
 * attachment disposition). */
export function downloadProjectExport(projectId: string, file: string) {
  downloadFromUrl(
    getBackend().url(`/api/cut/projects/${projectId}/exports/${encodeURIComponent(file)}`),
    file
  );
}

/** Delete a rendered export from the project folder. Throws on failure so the
 * UI can stay truthful instead of optimistically dropping a file that's still
 * on disk (which is why deleted exports used to reappear on the next refresh). */
export async function deleteExport(projectId: string, file: string) {
  const res = await apiFetch(
    `/api/cut/projects/${projectId}/exports/${encodeURIComponent(file)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not delete the export.");
  }
}

export interface ExportDoc {
  /** Output frame ratio the cut renders at — keeps burn-in layout (caption
   * wrap) in the same design space as the live preview. */
  aspect: Aspect;
  assets: MediaAsset[];
  /** Every video clip, any track (track 0 folds sequentially, others composite). */
  clips: VideoClip[];
  audioClips: AudioClip[];
  overlays: Overlay[];
  subtitles: SubtitlesBlock;
  /** Whole-video fades (seconds): in from black / out to black on the final
   * composite. */
  fadeIn?: number;
  fadeOut?: number;
  /** The frame's own color behind every clip and element (hex); absent = black. */
  background?: string;
}


/** The neutral built cut: the engine spec plus the browser-rendered overlay
 * PNGs. The local path serializes it to the engine's multipart form; the
 * cloud path presigns the PNGs to R2 and posts the spec as JSON. */
interface ExportPayload {
  spec: object;
  pngs: { name: string; blob: Blob }[];
}

/** A masked video clip's coverage in the spec: one grayscale still, a
 * sampled sequence when the mask is keyframed, or the shared person matte
 * (`subject`) with its knobs. */
interface SpecMask {
  file?: string;
  frames?: { file: string; duration: number }[];
  subject?: { invert?: boolean; feather?: number };
}

/** How often a keyframed clip mask samples — the person-matte cadence; the
 * server re-stamps the output fps over it. */
const MASK_SAMPLE_FPS = 15;

/** Paint a clip's mask coverage for its export segment: one luma PNG for a
 * resting mask, a 15fps sampled sequence for a keyframed one. Keyframed
 * opacity folds into the luma — a clip fading under its pose track exports
 * an opacity-scaled coverage (flat white when it has no shape mask), so the
 * graph never needs an animatable alpha filter. The pictures land in `pngs`
 * and the returned entry references them by name. */
async function renderClipMaskPictures(
  clip: VideoClip,
  box: { x: number; y: number; w: number; h: number },
  W: number,
  H: number,
  dur: number,
  tag: string,
  pngs: ExportPayload["pngs"]
): Promise<SpecMask | undefined> {
  const m = clip.mask && clip.mask.kind !== "subject" ? clip.mask : undefined;
  const opacityVaries = (clip.kf ?? []).some((k) => Math.abs(k.opacity - 1) > 1e-3);
  const radius = clip.boxStyle?.radius ?? 0;
  if (!m && !opacityVaries && radius <= 0) return undefined;
  const rect = rectOf(clip);
  const anchor = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const frame = { width: W, height: H, scale: Math.min(W, H) / 1080 };
  // Rounded corners trim coverage at the clip's box: outside the rounded box
  // everything drops, and inside it the mask keeps deciding.
  const rp = regionPx(clip.frame, W, H);
  const rb = rp
    ? { x: rp.rx - box.x, y: rp.ry - box.y, w: rp.rw, h: rp.rh }
    : { x: -box.x, y: -box.y, w: W, h: H };
  const canvas = createRasterCanvas(box.w, box.h);
  const blobAt = (tLocal: number) => {
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    if (radius > 0) {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(rb.x, rb.y, rb.w, rb.h, radius * frame.scale);
      ctx.clip();
    }
    if (m) {
      paintMaskLuma(canvas, m, tLocal, frame, anchor, box.x, box.y);
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (radius > 0) ctx.restore();
    if (opacityVaries) {
      const v = Math.round(
        255 * Math.max(0, Math.min(1, clipPoseAt(clip, tLocal).opacity))
      );
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-over";
    }
    return rasterCanvasToPng(canvas);
  };
  if (!(m && isMaskAnimated(m)) && !opacityVaries) {
    const name = `${tag}.png`;
    pngs.push({ name, blob: await blobAt(0) });
    return { file: name };
  }
  const step = 1 / MASK_SAMPLE_FPS;
  const n = Math.max(1, Math.round(dur * MASK_SAMPLE_FPS));
  const frames: { file: string; duration: number }[] = [];
  for (let i = 0; i < n; i++) {
    const name = `${tag}_f${i}.png`;
    pngs.push({ name, blob: await blobAt(i * step) });
    frames.push({ file: name, duration: i === n - 1 ? Math.max(step, dur - (n - 1) * step) : step });
  }
  return { frames };
}

/**
 * Paint the shadow a clip casts, frame-sized and transparent everywhere else.
 * The silhouette is the picture the clip really shows — its box, its rounded
 * corners, its mask, its pose — thrown behind itself and then punched back
 * out, so the graph can lay the result over the frame and get what sitting
 * behind the clip would have looked like. A moving clip samples the shadow
 * per frame, the way a keyframed mask samples its coverage. Null without a
 * shadow.
 */
async function renderClipShadowPictures(
  clip: VideoClip,
  asset: { width?: number; height?: number },
  W: number,
  H: number,
  dur: number,
  tag: string,
  pngs: ExportPayload["pngs"]
): Promise<SpecMask | undefined> {
  const sh = clip.boxStyle?.shadow;
  if (!sh) return undefined;
  const scale = Math.min(W, H) / 1080;
  const frame = { width: W, height: H, scale };
  const rect = rectOf(clip);
  const box = { x: rect.x * W, y: rect.y * H, w: rect.w * W, h: rect.h * H };
  const radius = Math.max(0, (clip.boxStyle?.radius ?? 0) * scale);
  const mask = clip.mask && clip.mask.kind !== "subject" ? clip.mask : undefined;
  // The picture's own footprint inside the box — a fitted clip's shadow follows
  // the picture, not the empty margins beside it.
  const pic =
    asset.width && asset.height
      ? contentRect(box, asset.width, asset.height, clipCovers(clip), clipZoom(clip), clip.panX ?? 0, clip.panY ?? 0)
      : box;
  const shape = createRasterCanvas(W, H);
  const cover = createRasterCanvas(W, H);
  const canvas = createRasterCanvas(W, H);
  const anchor = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const blobAt = (tLocal: number) => {
    const shapeCtx = shape.getContext("2d") as CanvasRenderingContext2D;
    shapeCtx.setTransform(1, 0, 0, 1, 0, 0);
    shapeCtx.clearRect(0, 0, W, H);
    const pose = clipPosed(clip) ? clipPoseAt(clip, tLocal) : null;
    if (pose) {
      shapeCtx.translate(pose.x * W, pose.y * H);
      shapeCtx.rotate((pose.rotation * Math.PI) / 180);
      shapeCtx.scale(pose.scale, pose.scale);
      shapeCtx.translate(-anchor.x * W, -anchor.y * H);
    }
    // The lit shape: the picture, trimmed at the box's rounded corners.
    shapeCtx.save();
    shapeCtx.beginPath();
    shapeCtx.roundRect(box.x, box.y, box.w, box.h, radius);
    shapeCtx.clip();
    shapeCtx.fillStyle = "#ffffff";
    shapeCtx.fillRect(pic.x, pic.y, pic.w, pic.h);
    shapeCtx.restore();
    if (mask) {
      // The mask decides the rest of the shape; its luma becomes coverage.
      paintMaskLuma(cover, mask, tLocal, frame, anchor, 0, 0);
      shapeCtx.setTransform(1, 0, 0, 1, 0, 0);
      shapeCtx.globalCompositeOperation = "destination-in";
      shapeCtx.drawImage(cover as CanvasImageSource, 0, 0);
      shapeCtx.globalCompositeOperation = "source-over";
    }
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.shadowColor = shadowInk(sh);
    ctx.shadowBlur = Math.max(0, sh.blur) * scale;
    ctx.shadowOffsetX = (sh.x ?? 0) * scale;
    ctx.shadowOffsetY = (sh.y ?? 0) * scale;
    ctx.drawImage(shape as CanvasImageSource, 0, 0);
    ctx.restore();
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(shape as CanvasImageSource, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    return rasterCanvasToPng(canvas);
  };
  const moves = (mask && isMaskAnimated(mask)) || clipKeyed(clip);
  if (!moves) {
    const name = `${tag}.png`;
    pngs.push({ name, blob: await blobAt(0) });
    return { file: name };
  }
  const step = 1 / MASK_SAMPLE_FPS;
  const n = Math.max(1, Math.round(dur * MASK_SAMPLE_FPS));
  const frames: { file: string; duration: number }[] = [];
  for (let i = 0; i < n; i++) {
    const name = `${tag}_f${i}.png`;
    pngs.push({ name, blob: await blobAt(i * step) });
    frames.push({ file: name, duration: i === n - 1 ? Math.max(step, dur - (n - 1) * step) : step });
  }
  return { frames };
}

/** Paint the clip's border ring — a stroked rounded rect along its box edge,
 * transparent everywhere else — sized to the segment the graph frames (the
 * full frame for track 0, the region box for overlays). The engine overlays
 * it onto the segment before fades, masks and pose, so the ring rides the
 * clip like the preview's stroke does. Null without a border. */
function renderClipBorderPng(
  clip: VideoClip,
  seg: { w: number; h: number },
  ring: { x: number; y: number; w: number; h: number },
  W: number,
  H: number
): Promise<Blob> | null {
  const bs = clip.boxStyle;
  if (!bs?.borderWidth) return null;
  const scale = Math.min(W, H) / 1080;
  const bw = bs.borderWidth * scale;
  const rad = Math.max(0, (bs.radius ?? 0) * scale);
  const canvas = createRasterCanvas(seg.w, seg.h);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.strokeStyle = bs.borderColor ?? "#ffffff";
  ctx.lineWidth = bw;
  ctx.beginPath();
  ctx.roundRect(ring.x + bw / 2, ring.y + bw / 2, ring.w - bw, ring.h - bw, Math.max(0, rad - bw / 2));
  ctx.stroke();
  return rasterCanvasToPng(canvas);
}

/** Build the export spec + overlay PNGs from the cut. Media already lives in
 * the project folder — the spec references it by file name; only overlay PNGs
 * travel with the request. Shared by full exports and the low-res hover proxy. */
async function buildExportPayload(
  projectId: string,
  doc: ExportDoc,
  settings: ExportSettings,
  target: "export" | "preview" | "card" | "hls"
): Promise<ExportPayload> {
  const spans = getClipSpans(doc.clips, doc.assets);
  const duration = projectDuration(doc);
  const pngs: ExportPayload["pngs"] = [];
  const assetById = new Map(doc.assets.map((a) => [a.id, a]));
  // Cuts with an empty track 0 still export: track 0 becomes a bed of the
  // project's background color the length of the cut and the elements, layers
  // and soundtrack composite onto it — the same path as a gap before the first
  // track-0 clip. A cut of nothing but titles and shapes is that case for its
  // whole length. Anything on any row gives the project a duration, so having
  // one is the same question as having something to render.
  if (!(duration > 0)) {
    throw new Error("Add something to the timeline first.");
  }

  // The person matte renders first, so the loops below attach subject fields
  // only when the effect will actually composite (no person segmenter, or no
  // person → everything renders plain, matching the preview's degrade). The
  // spec field keeps its `behindMask` name so older engines keep rendering
  // behind-tagged text.
  let behindMask: { file: string; from: number } | undefined;
  const wantsSubject =
    doc.overlays.some((o) => subjectMasked(o) && !o.hidden) ||
    doc.clips.some((c) => c.mask?.kind === "subject" && !c.hidden);
  if (wantsSubject) {
    const mask = await import("./maskVideo")
      .then((m) => m.renderSubjectMask(doc, duration))
      .catch(() => null);
    if (mask) {
      pngs.push({ name: "behind_mask.mp4", blob: mask.blob });
      behindMask = { file: "behind_mask.mp4", from: mask.from };
    }
  }
  /** A clip whose resting turn or fade rides as a one-key pose track: the
   * graph and the mask painter both read the picture's pose off `kf`, and a
   * single key holds flat, so the export renders the resting transform
   * through the path the animated one already takes. */
  const posed = (c: VideoClip): VideoClip => {
    if (!clipPosed(c) || clipKeyed(c)) return c;
    const rect = rectOf(c);
    return {
      ...c,
      kf: [
        {
          t: 0,
          x: rect.x + rect.w / 2,
          y: rect.y + rect.h / 2,
          scale: 1,
          rotation: c.rotation ?? 0,
          opacity: c.opacity ?? 1,
        },
      ],
    };
  };

  /** The subject entry a masked item ships, or undefined without a matte. */
  const subjectOf = (m: { invert?: boolean; feather?: number } | undefined) =>
    behindMask && m
      ? {
          ...(m.invert ? { invert: true } : {}),
          ...(m.feather ? { feather: m.feather } : {}),
        }
      : undefined;

  const clipEntries = spans.map((sp) => ({
    file: sp.asset.fileName,
    in: sp.clip.in,
    out: sp.clip.out,
    muted: sp.clip.muted,
    volume: sp.clip.volume ?? 1,
    fit: sp.clip.fit ?? "fit",
    zoom: clipZoom(sp.clip),
    panX: sp.clip.panX ?? 0,
    panY: sp.clip.panY ?? 0,
    frame: sp.clip.frame,
    speed: clipSpeed(sp.clip),
    transition: sp.transitionOut,
    // A cross dissolve carries its own window: the picture cuts, so the
    // server's blend must not see one. The handles are what the crossing
    // reaches into so both clips are audible over that cut.
    soundCross: sp.soundOut,
    soundAhead: sp.soundAhead,
    soundBack: sp.soundBack,
    // The style rides along with the overlap; the server resolves it to an
    // xfade name (and the cross-zoom ramps) itself, so the spec carries only
    // the id.
    transitionStyle: sp.clip.transitionStyle,
    animIn: sp.clip.animIn,
    animOut: sp.clip.animOut,
    look: sp.clip.look,
    lookAmount: sp.clip.lookAmount,
    hidden: sp.clip.hidden,
    // A still: the server loops the image for the clip's length instead of
    // trimming a source span.
    image: sp.asset.type === "image",
    grade: normalizeGrade(sp.clip.grade),
    mask: undefined as SpecMask | undefined,
    shadow: undefined as SpecMask | undefined,
    kf: posed(sp.clip).kf,
    border: undefined as string | undefined,
  }));
  // Track-0 segments render at the full output frame (regioned clips pad out
  // to it), so their masks paint full-frame. A subject mask rides the shared
  // matte; painted pictures still travel beside it when the pose track keys
  // opacity, since opacity ships as coverage luma.
  for (let i = 0; i < spans.length; i++) {
    const c = posed(spans[i].clip);
    const dur = Math.max(0.1, (c.out - c.in) / clipSpeed(c));
    const pictures = await renderClipMaskPictures(
      c,
      { x: 0, y: 0, w: settings.width, h: settings.height },
      settings.width,
      settings.height,
      dur,
      `mask_c${i}`,
      pngs
    );
    const subject = c.mask?.kind === "subject" ? subjectOf(c.mask) : undefined;
    if (pictures || subject) {
      clipEntries[i].mask = { ...(pictures ?? {}), ...(subject ? { subject } : {}) };
    }
    const rp = regionPx(c.frame, settings.width, settings.height);
    const ring = rp
      ? { x: rp.rx, y: rp.ry, w: rp.rw, h: rp.rh }
      : { x: 0, y: 0, w: settings.width, h: settings.height };
    const borderBlob = renderClipBorderPng(
      c,
      { w: settings.width, h: settings.height },
      ring,
      settings.width,
      settings.height
    );
    if (borderBlob) {
      const name = `border_c${i}.png`;
      pngs.push({ name, blob: await borderBlob });
      clipEntries[i].border = name;
    }
    clipEntries[i].shadow = await renderClipShadowPictures(
      c,
      spans[i].asset,
      settings.width,
      settings.height,
      dur,
      `shadow_c${i}`,
      pngs
    );
  }

  // The server's video graph is a sequential fold, so gaps between the
  // free-placed clips ship as explicit spacer segments: no file, hidden and
  // muted, which the server renders as black + silence for the gap's length.
  const spacer = (len: number) => ({
    file: "",
    in: 0,
    out: len,
    muted: true,
    volume: 0,
    fit: "fit" as const,
    zoom: 1,
    panX: 0,
    panY: 0,
    frame: undefined,
    speed: 1,
    transition: 0,
    hidden: true,
    image: false,
  });
  // An overlay-only cut has no track-0 spans: the whole base is one black bed.
  const clips =
    spans.length === 0
      ? [spacer(duration)]
      : spanSequence(spans).flatMap(({ gapBefore }, i) => [
          ...(gapBefore > 0 ? [spacer(gapBefore)] : []),
          clipEntries[i],
        ]);

  // Video tracks composited over track 0; hidden ones are dropped. Each
  // track's transitions and animations translate into per-clip head/tail
  // ramps: on an upper track a fade is an alpha fade (transparent, so the
  // tracks beneath show through), and a transition blends the incoming clip
  // in over the outgoing one — the incoming alpha-fades in for the overlap
  // while the outgoing stays opaque underneath it (cross zoom adds its zoom
  // ramps). Animations map fade/zoom natively; the styles that need frame
  // motion degrade to a fade up here.
  const overlayTracks = [...new Set(overlayLayers(doc.clips).map((c) => c.track))];
  // Entry → its source clip, so the mask loop below can paint per clip after
  // the entries assemble.
  const overlayClipOf = new Map<object, VideoClip>();
  const overlayVideos = overlayTracks.flatMap((track) => {
    const trackSpans = getClipSpans(doc.clips, doc.assets, track);
    const ramps = trackSpans.map(() => ({
      headFade: 0,
      tailFade: 0,
      headZoom: 0,
      tailZoom: 0,
      // Sound-only ramps: a dissolve on the sound leaves the picture alone,
      // so its windows ride apart from the alpha fades.
      headSound: 0,
      tailSound: 0,
      soundAhead: 0,
      soundBack: 0,
    }));
    trackSpans.forEach((sp, i) => {
      const r = ramps[i];
      const applyAnim = (a: ClipAnim | undefined, side: "head" | "tail") => {
        if (!a) return;
        const secs = Math.min(a.seconds, sp.len);
        if (overlayAnimStyle(a.style) === "zoom") {
          r[side === "head" ? "headZoom" : "tailZoom"] = secs;
        } else {
          r[side === "head" ? "headFade" : "tailFade"] = secs;
        }
      };
      // A transitioned joint owns its edges: that side's animation is held so
      // it never fights the transition's blend (mirrors preview and track 0).
      if (!((trackSpans[i - 1]?.transitionOut ?? 0) > 0)) applyAnim(sp.clip.animIn, "head");
      if (!(sp.transitionOut > 0)) applyAnim(sp.clip.animOut, "tail");
      if (sp.transitionOut > 0 && trackSpans[i + 1]) {
        const nr = ramps[i + 1];
        nr.headFade = Math.max(nr.headFade, sp.transitionOut);
        if ((sp.clip.transitionStyle ?? "crossfade") === "crosszoom") {
          r.tailZoom = Math.max(r.tailZoom, sp.transitionOut);
          nr.headZoom = Math.max(nr.headZoom, sp.transitionOut);
        }
      }
      if (sp.soundOut > 0 && trackSpans[i + 1]) {
        r.tailSound = Math.max(r.tailSound, sp.soundOut);
        ramps[i + 1].headSound = Math.max(ramps[i + 1].headSound, sp.soundOut);
      }
      r.soundAhead = sp.soundAhead;
      r.soundBack = sp.soundBack;
    });
    return trackSpans
      .map((sp, i) => ({ c: sp.clip, ramp: ramps[i] }))
      .filter(({ c }) => !c.hidden && c.start < duration)
      .map(({ c, ramp }) => {
        const entry = {
          file: assetById.get(c.assetId)!.fileName,
          in: c.in,
          out: c.out,
          start: c.start,
          track: c.track,
          frame: c.frame,
          // Pass `fit` through unset so the server's "default full-frame overlay
          // covers what's below" branch fires — normalizing to "fit" defeated it.
          fit: c.fit,
          zoom: clipZoom(c),
          panX: c.panX ?? 0,
          panY: c.panY ?? 0,
          muted: c.muted,
          volume: c.volume,
          speed: c.speed,
          image: assetById.get(c.assetId)!.type === "image",
          grade: normalizeGrade(c.grade),
          look: c.look,
          lookAmount: c.lookAmount,
          mask: undefined as SpecMask | undefined,
          shadow: undefined as SpecMask | undefined,
          kf: posed(c).kf,
          border: undefined as string | undefined,
          ...ramp,
        };
        overlayClipOf.set(entry, posed(c));
        return entry;
      });
  });
  // Upper-track segments render at their region box (letterboxed ones pad out
  // to it when masked), so their masks paint box-sized. Subject masks ride
  // the shared matte, with opacity-key luma pictures beside them.
  for (let i = 0; i < overlayVideos.length; i++) {
    const entry = overlayVideos[i];
    const c = overlayClipOf.get(entry);
    if (!c) continue;
    const region = regionPx(c.frame, settings.width, settings.height);
    const box = region
      ? { x: region.rx, y: region.ry, w: region.rw, h: region.rh }
      : { x: 0, y: 0, w: settings.width, h: settings.height };
    const ospeed = c.speed && c.speed > 0 ? c.speed : 1;
    const olen = Math.max(0.1, (c.out - c.in) / ospeed);
    const pictures = await renderClipMaskPictures(
      c,
      box,
      settings.width,
      settings.height,
      olen,
      `mask_ov${i}`,
      pngs
    );
    const subject = c.mask?.kind === "subject" ? subjectOf(c.mask) : undefined;
    if (pictures || subject) {
      entry.mask = { ...(pictures ?? {}), ...(subject ? { subject } : {}) };
    }
    const borderBlob = renderClipBorderPng(
      c,
      { w: box.w, h: box.h },
      { x: 0, y: 0, w: box.w, h: box.h },
      settings.width,
      settings.height
    );
    if (borderBlob) {
      const name = `border_ov${i}.png`;
      pngs.push({ name, blob: await borderBlob });
      entry.border = name;
    }
    entry.shadow = await renderClipShadowPictures(
      c,
      assetById.get(c.assetId) ?? {},
      settings.width,
      settings.height,
      olen,
      `shadow_ov${i}`,
      pngs
    );
  }

  const audio = doc.audioClips
    .filter((a) => !a.hidden && a.start < duration && assetById.has(a.assetId))
    .map((a) => ({
      file: assetById.get(a.assetId)!.fileName,
      in: a.in,
      out: a.out,
      start: a.start,
      volume: a.volume,
      fadeIn: a.fadeIn ?? 0,
      fadeOut: a.fadeOut ?? 0,
      speed: a.speed,
      duck: a.duck,
    }));

  const overlays: {
    file?: string;
    start: number;
    end: number;
    x?: number;
    y?: number;
    blank?: string;
    frames?: { file: string; duration: number }[];
    /** The element trims by the shared person matte (invert = behind the
     * speaker). */
    subject?: { invert?: boolean; feather?: number };
    /** Its row: lane 0 is the top of the stack, and the effects interleave
     * with these by lane. */
    lane?: number;
  }[] = [];
  // Effect elements never rasterize: they ship as time-gated filter recipes
  // the server builds into the graph (the ids ride, never filter text). The
  // audio ones ride the same list and treat the mix rather than the picture.
  const effects = doc.overlays
    .filter((o) => o.kind === "effect" && !o.hidden && o.start < duration)
    .map((o) => ({
      effect: (o as { effect: string }).effect,
      amount: (o as { amount?: number }).amount,
      focus: (o as { focus?: { x: number; y: number } }).focus,
      ramp: (o as { ramp?: number }).ramp,
      lane: laneOf(o),
      start: o.start,
      end: Math.min(o.end, duration),
    }));

  for (let i = 0; i < doc.overlays.length; i++) {
    const o = doc.overlays[i];
    if (o.hidden || o.start >= duration) continue;
    if (o.kind === "effect") continue;
    // A blank title has no pixels to burn; shapes and stickers always render.
    if (isTextOverlay(o) && !o.text.trim()) continue;
    // A subject-masked element's stream must run its whole window so the
    // server can multiply the matte in per frame — the frames mechanism
    // covers that (a static element costs one frame plus the blank).
    const subject = subjectMasked(o) && o.mask ? subjectOf(o.mask) : undefined;
    const subjectFields = subject ? { subject } : {};
    // A Lottie sticker's pixels move on their own, so it exports as frames
    // even with no transform animation set.
    if (isOverlayAnimated(o) || (isStickerOverlay(o) && o.lottie) || subject) {
      // Animated: a region-cropped 30fps frame sequence that the server plays
      // as a concat-demuxer slideshow overlaid at the region. Presets sample
      // their heads and tails and reuse the middle; a keyframed pose changes
      // on its own schedule, so its whole span is sampled frame by frame.
      const set = await renderElementFrames(o, settings.width, settings.height, 30, doc.assets);
      const names = set.images.map((blob, j) => {
        const name = `overlay_${i}_f${j}.png`;
        pngs.push({ name, blob });
        return name;
      });
      const blank = `overlay_${i}_blank.png`;
      pngs.push({ name: blank, blob: set.blank });
      overlays.push({
        start: o.start,
        end: Math.min(o.end, duration),
        x: set.x,
        y: set.y,
        blank,
        frames: set.entries.map((e) => ({ file: names[e.image], duration: e.duration })),
        lane: laneOf(o),
        ...subjectFields,
      });
      continue;
    }
    const png = await renderElementPng(o, settings.width, settings.height, doc.assets);
    const key = `overlay_${i}.png`;
    pngs.push({ name: key, blob: png });
    overlays.push({
      file: key,
      start: o.start,
      end: Math.min(o.end, duration),
      lane: laneOf(o),
      ...subjectFields,
    });
  }

  // Subtitle stills travel in their own spec lane: the server plays each
  // subtitle track as one concat-demuxer slideshow (with a transparent filler
  // frame for gaps), so karaoke word windows don't each become an ffmpeg
  // input. Tracks overlap each other in time, so every track (language) gets
  // its own slideshow, marked by `lane`.
  const captions: { file: string; start: number; end: number; lane?: number }[] = [];
  if (doc.subtitles.showOnVideo) {
    const capStyle = captionStyle(doc.subtitles.style);
    for (let lane = 0; lane < subtitleLaneCount(doc.subtitles); lane++) {
      if (laneHidden(doc.subtitles, lane)) continue;
      const cues = laneCues(doc.subtitles, lane);
      const pos = trackPos(doc.subtitles, capStyle, lane);
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        if (cue.start >= duration || !cue.text.trim()) continue;
        // Karaoke burns one frame per word window (the spoken word accented);
        // otherwise the whole cue is a single still.
        const windows = doc.subtitles.wordHighlight
          ? cueWordWindows(cue)
          : [{ start: cue.start, end: cue.end }];
        for (let wi = 0; wi < windows.length; wi++) {
          const win = windows[wi];
          if (win.start >= duration) break;
          const png = await renderElementPng(
            cueOverlay(
              cue,
              capStyle,
              i === 0,
              pos,
              doc.subtitles.wordHighlight ? wi : undefined,
              // Wrap in design space (1080 short side) from the project ratio —
              // the same width the preview passes, whatever the render size.
              frameOf(doc.aspect).w
            ),
            settings.width,
            settings.height
          );
          const key = windows.length > 1 ? `sub_${lane}_${i}_${wi}.png` : `sub_${lane}_${i}.png`;
          pngs.push({ name: key, blob: png });
          captions.push({
            file: key,
            start: win.start,
            end: Math.min(win.end, duration),
            ...(lane > 0 ? { lane } : {}),
          });
        }
      }
    }
    if (captions.length > 0) {
      const blank = createRasterCanvas(settings.width, settings.height);
      pngs.push({ name: "sub_blank.png", blob: await rasterCanvasToPng(blank) });
    }
  }

  return {
    spec: {
      projectId,
      target,
      ...settings,
      duration,
      fadeIn: doc.fadeIn ?? 0,
      fadeOut: doc.fadeOut ?? 0,
      background: projectBackground(doc.background),
      clips,
      audio,
      overlayVideos,
      overlays,
      captions,
      ...(effects.length ? { effects } : {}),
      ...(behindMask ? { behindMask } : {}),
    },
    pngs,
  };
}

/** Serialize a payload to the engine's multipart form: PNGs in render order,
 * then the spec — the exact request shape from before the payload split. */
function exportFormFromPayload({ spec, pngs }: ExportPayload): FormData {
  const form = new FormData();
  for (const p of pngs) form.append(p.name, p.blob, p.name);
  form.append("spec", JSON.stringify(spec));
  return form;
}

/** Kick off an export on the given backend, returning the create response.
 * The backend is captured when the export starts, so a job keeps rendering
 * against its own backend even after the app rebinds to the other residency.
 * Local: the engine's multipart form. Cloud: presign the overlay PNGs, PUT
 * them straight to R2, then POST the JSON export body. */
async function postExport(
  projectId: string,
  payload: ExportPayload,
  outName: string,
  backend: CutBackend,
  extra?: Record<string, unknown>
): Promise<Response> {
  if (backend.kind !== "cloud") {
    return backend.fetch("/api/cut/export", { method: "POST", body: exportFormFromPayload(payload) });
  }
  const overlays: { name: string; key: string }[] = [];
  if (payload.pngs.length > 0) {
    const pre = await backend.fetch("/api/cut/export/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: payload.pngs.map((p) => ({ name: p.name, bytes: p.blob.size })),
      }),
    });
    const preBody =
      await apiJson<{ files?: { name: string; key: string; type?: string; url: string }[] }>(pre);
    if (!pre.ok || !preBody.files) {
      throw new Error(
        quotaErrorMessage(pre.status, preBody) ?? preBody.error ?? "Export failed to start."
      );
    }
    const byName = new Map(preBody.files.map((f) => [f.name, f]));
    await Promise.all(
      payload.pngs.map(async (p) => {
        const target = byName.get(p.name);
        if (!target) throw new Error("Export failed to start.");
        // The content type the URL was signed with, not the blob's: they agree
        // for the PNG frames and differ for the behind-speaker mask clip, and
        // sending anything but the signed one fails the signature.
        await putSigned(target.url, p.blob, target.type || "image/png");
      })
    );
    for (const p of payload.pngs) overlays.push({ name: p.name, key: byName.get(p.name)!.key });
  }
  return backend.fetch("/api/cut/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec: payload.spec, overlays, projectId, outName, ...extra }),
  });
}

/** The cloud names the output client-side (the engine derives it from the
 * project name itself, deduping on disk); mirror the engine's sanitize rule. */
function exportOutName(): string {
  const base =
    useEditor.getState().projectName.replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 60) || "export";
  return `${base}.mp4`;
}

/** Poll an export job to completion, reporting progress. Returns the file name. */
export async function pollExport(
  jobId: string,
  onProgress: (stage: string, ratio: number) => void,
  isCanceled: () => boolean = () => false,
  backend: CutBackend = getBackend()
): Promise<string> {
  for (;;) {
    if (isCanceled()) throw new Error("Export canceled.");
    await new Promise((r) => setTimeout(r, 400));
    const st = await backend.fetch(`/api/cut/export/${jobId}`);
    const status = await apiJson<{
      status?: string;
      progress?: number;
      outName?: string;
    }>(st);
    if (!st.ok || status.status === "error") throw new Error(status.error ?? "Export failed.");
    onProgress("Rendering", status.progress ?? 0);
    if (status.status === "done") return status.outName ?? "export.mp4";
  }
}

/** Trigger a browser download of a finished export by job id. */
export function downloadExport(jobId: string, outName: string, backend: CutBackend = getBackend()) {
  const a = document.createElement("a");
  a.href = backend.url(`/api/cut/export/${jobId}/file`);
  a.download = outName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Build the cut and hand it to the engine, returning the new job id. Progress,
 * cancel, download, and the finished-file actions are all driven from the
 * engine's job feed by the exports dock — this only kicks the render off, so it
 * returns the moment the job is queued and never blocks on the encode. */
export async function createExportJob(
  projectId: string,
  doc: ExportDoc,
  settings: ExportSettings
): Promise<string> {
  const backend = getBackend(); // pinned: the payload build takes a while
  const payload = await buildExportPayload(projectId, doc, settings, "export");
  const res = await postExport(projectId, payload, exportOutName(), backend);
  const body = await apiJson<{ id?: string }>(res);
  if (!res.ok || !body.id) {
    // A quota rejection raises the upgrade wall on its way through, the same as
    // one from an upload — otherwise the only sign is a terse line in the dock.
    throw new Error(
      quotaErrorMessage(res.status, body) ?? body.error ?? "Export failed to start."
    );
  }
  return body.id;
}

/**
 * Render the cut in this tab and store the result, returning the finished job's
 * id.
 *
 * The worker path exists because a hosted page had no way to encode video; it
 * does now. Rendering here removes the round trip a queued export costs — the
 * media does not have to be pulled back out of storage into a container, and
 * nothing waits behind another account's render — and the file matches the
 * preview, because the same compositor drew both.
 *
 * Cloud projects only: a local project's engine has ffmpeg, a whole machine,
 * and the media already on disk.
 */
export async function runBrowserExport(
  projectId: string,
  doc: ExportDoc,
  settings: ExportSettings,
  opts: {
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
    /** Dock-row label for a browser-resident render's tab-local job. */
    projectName?: string;
    /** The reserved job's id, as soon as it exists — the dock hides that row
     * while this tab is the thing rendering it. */
    onClaimed?: (jobId: string) => void;
  } = {}
): Promise<string> {
  const backend = getBackend(); // pinned: the render outlives navigation
  if (backend.kind === "browser") return runStoreExport(projectId, doc, settings, opts);
  if (backend.kind !== "cloud") throw new Error("This project renders on its own machine.");

  // The name and the destination are claimed before a frame is drawn, so a
  // render that is going to be refused for space or for the render cap is
  // refused now rather than after minutes of work. The claim is a job row, so
  // a second export started while this one renders sees it and takes the next
  // name instead of overwriting this one's file.
  const claim = await backend.fetch("/api/cut/export/client/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, outName: exportOutName() }),
  });
  const claimed = await apiJson<{ jobId?: string; url?: string; outName?: string }>(claim);
  if (!claim.ok || !claimed.jobId || !claimed.url) {
    throw new Error(
      quotaErrorMessage(claim.status, claimed) ?? claimed.error ?? "Export failed to start."
    );
  }
  const jobId = claimed.jobId;
  opts.onClaimed?.(jobId);

  // The render keeps reading the project's store-served blob URLs after the
  // user opens another project; the hold keeps them alive until it finishes.
  holdRegistered(`/api/cut/projects/${projectId}/`);
  try {
    const rendered = await renderProjectToMp4(doc, settings, {
      // Read the asset's URL at the moment it is needed rather than off the
      // snapshot: a long render can outlive the links it started with, and the
      // store re-mints them behind it.
      resolve: (asset) =>
        useEditor.getState().assets.find((a) => a.id === asset.id)?.url ?? asset.url,
      signal: opts.signal,
      // The render is nearly all of the work; the upload is the tail of the bar.
      onProgress: ({ ratio }) => opts.onProgress?.(ratio * 0.9),
    });

    try {
      await putSigned(claimed.url, rendered.file, "video/mp4", {
        signal: opts.signal,
        onProgress: (fraction) => opts.onProgress?.(0.9 + fraction * 0.1),
      });
    } finally {
      // The file streamed from scratch disk into the upload; its space comes
      // back as soon as the upload is done with it.
      void rendered.discard();
    }

    const done = await backend.fetch("/api/cut/export/client/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    const body = await apiJson<{ id?: string }>(done);
    if (!done.ok || !body.id) throw new Error(body.error ?? "Could not save the export.");
    return body.id;
  } catch (err) {
    // A render that stopped — cancelled, failed, or refused — gives back the
    // name it was holding. Leaving the row behind would keep the name taken and
    // a render slot spent for a file that will never exist.
    void backend
      .fetch(`/api/cut/export/client/${jobId}/release`, { method: "POST" })
      .catch(() => {});
    throw err;
  } finally {
    releaseRegistered(`/api/cut/projects/${projectId}/`);
  }
}

/** A browser-resident project's export: the same in-tab render, with the
 * finished file written into the project's exports shelf in the browser store.
 * The job is a row in the tab-local feed, so the dock tracks, cancels, and
 * downloads it the way it does every other residency's. */
async function runStoreExport(
  projectId: string,
  doc: ExportDoc,
  settings: ExportSettings,
  opts: Parameters<typeof runBrowserExport>[3] = {}
): Promise<string> {
  const job = reserveBrowserExportJob(projectId, opts.projectName);
  opts.onClaimed?.(job.id);
  holdRegistered(`/api/cut/projects/${projectId}/`);
  try {
    const rendered = await renderProjectToMp4(doc, settings, {
      resolve: (asset) =>
        useEditor.getState().assets.find((a) => a.id === asset.id)?.url ?? asset.url,
      signal: opts.signal,
      onProgress: ({ ratio }) => {
        opts.onProgress?.(ratio);
        updateBrowserExportJob(job.id, { progress: ratio });
      },
    });
    let outName: string;
    try {
      outName = await saveExport(projectId, rendered.file, exportOutName());
    } finally {
      void rendered.discard();
    }
    // Serve the finished file from the store copy: the scratch file behind the
    // render is already gone, and these two paths are what the dock's download
    // button and the exports shelf resolve through backend.url().
    const saved = await readFileAt(await exportsDir(projectId), outName);
    if (saved) {
      registerBlobFile(`/api/cut/export/${job.id}/file`, saved);
      registerBlobFile(
        `/api/cut/projects/${projectId}/exports/${encodeURIComponent(outName)}`,
        saved
      );
    }
    updateBrowserExportJob(job.id, { status: "done", progress: 1, outName });
    return job.id;
  } catch (err) {
    removeBrowserExportJob(job.id);
    throw err;
  } finally {
    releaseRegistered(`/api/cut/projects/${projectId}/`);
  }
}

/** Cancel a running or queued export job, or retire a settled one from the
 * export-jobs feed. */
export function cancelExportJob(jobId: string, backend: CutBackend = getBackend()) {
  void backend.fetch(`/api/cut/export/${jobId}`, { method: "DELETE" }).catch(() => {});
}

/**
 * Build the share's streaming ladder for the cut as it stands.
 *
 * A share plays HLS rather than a single file, so this is what makes a shared
 * project watchable — see server/hlsLadder.ts for why. The render is queued and
 * not waited on: it re-encodes the whole cut once per rung, so the caller
 * returns immediately and the viewer's page polls for the ladder to appear.
 *
 * The top rung is capped at the source, so the frame size sent here is the
 * ceiling on what any viewer can ever see; it renders at the doc's own size.
 *
 * `shareSubtitles` is what the share grants, and it decides whether captions
 * are burned in at all. The doc is what the OWNER sees, so passing it through
 * unfiltered would put cue text in the pixels of a stream sent to viewers whose
 * share hides Subtitles — and pixels are past the point where the server's doc
 * filter can take it back out.
 */
export async function renderShareLadder(
  projectId: string,
  doc: ExportDoc,
  shareSubtitles: boolean
): Promise<void> {
  const backend = getBackend(); // pinned: the ladder outlives the dialog
  // The master renders at "Original" — the ladder caps its top rung at this
  // frame, so anything given up here is given up for every viewer. The encode
  // preset is loosened because this master is an intermediate: every rung is
  // re-encoded from it, so its own compression never reaches a viewer.
  const settings: ExportSettings = {
    ...originalSettings(doc.aspect, doc.clips, doc.assets),
    preset: "veryfast",
  };
  // Both the flag and the cues go: the flag is what the burn-in reads, and
  // dropping the cues as well means no path through the pipeline can put this
  // text on screen for a viewer whose share does not grant it.
  const source: ExportDoc = shareSubtitles
    ? doc
    : { ...doc, subtitles: { ...doc.subtitles, cues: [], showOnVideo: false } };
  const burnedSubtitles = shareSubtitles && doc.subtitles?.showOnVideo === true;
  try {
    const payload = await buildExportPayload(projectId, source, settings, "hls");
    await postExport(projectId, payload, "master.m3u8", backend, { burnedSubtitles });
  } catch {
    // No clips yet, or a slot was busy. The share keeps playing whatever it
    // already had until a later attempt lands.
  }
}

/** Low-res proxy of the actual edit for the project card's hover preview.
 * Renders through the same pipeline (overlays and all), writing the project's
 * preview.mp4. Best-effort: silently no-ops if a slot is busy or there's no
 * footage yet. */
export async function renderPreviewProxy(projectId: string, doc: ExportDoc) {
  const backend = getBackend(); // pinned: the proxy render outlives navigation
  const settings: ExportSettings = { ...scaledFrame(doc.aspect, 360), fps: 24, crf: 30, preset: "veryfast" };
  let res: Response;
  try {
    const payload = await buildExportPayload(projectId, doc, settings, "preview");
    res = await postExport(projectId, payload, "preview.mp4", backend);
  } catch {
    return; // no clips yet
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  if (!res.ok || !body.id) return; // a slot was busy; try again later
  await pollExport(body.id, () => {}, undefined, backend).catch(() => {});
}

/** Seconds of the cut a share card shows. */
const CARD_SECONDS = 5;

/** The cut's first `seconds`, as a doc. Clips keep their trim-in and lose
 * whatever hangs past the cut-off; everything starting after it drops. Used
 * for the share card, which is a five-second window onto the opening rather
 * than a render of the whole project. */
export function docFirstSeconds(doc: ExportDoc, seconds: number): ExportDoc {
  // A clip's timeline footprint is (out - in) / speed, so the trim that ends
  // it at `seconds` scales back through the speed.
  const clampOut = <T extends { start: number; in: number; out: number; speed?: number }>(
    clip: T
  ): T => {
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const room = (seconds - clip.start) * speed;
    return clip.out - clip.in <= room ? clip : { ...clip, out: clip.in + room };
  };
  const starts = <T extends { start: number }>(item: T) => item.start < seconds;
  return {
    ...doc,
    clips: doc.clips.filter(starts).map(clampOut),
    audioClips: doc.audioClips.filter(starts).map(clampOut),
    overlays: doc.overlays
      .filter(starts)
      .map((o) => (o.end <= seconds ? o : { ...o, end: seconds })),
    subtitles: {
      ...doc.subtitles,
      cues: doc.subtitles.cues
        .filter(starts)
        .map((c) => (c.end <= seconds ? c : { ...c, end: seconds })),
    },
    // A fade-out belongs to the end of the project, which the card cuts away.
    fadeOut: 0,
  };
}

/** Card frame size for an aspect: 16:9 sits close to the 1.91:1 social cards
 * want, and portrait cuts get a tall card rather than a letterboxed wide one. */
function cardSettings(aspect: Aspect): ExportSettings {
  return { ...scaledFrame(aspect, 720), fps: 15, crf: 26, preset: "veryfast" };
}

/** Render the project's link-preview card: the opening five seconds, which
 * the worker turns into the still frame and the animated thumbnail a shared
 * link unfurls with. Only shared projects have one, so this asks first and
 * costs a single small request when the project isn't shared.
 *
 * Best-effort throughout — a project with no footage, an unconfigured
 * backend, or a busy render slot simply keeps the card it already had. */
async function renderShareCard(projectId: string, doc: ExportDoc): Promise<void> {
  const backend = getBackend(); // pinned: the card render outlives navigation
  if (backend.kind !== "cloud") return;
  try {
    const res = await backend.fetch(`/api/cut/projects/${projectId}/share`);
    const body = (await res.json().catch(() => ({}))) as { share?: unknown | null };
    if (!res.ok || !body.share) return;
  } catch {
    return;
  }
  let res: Response;
  try {
    const payload = await buildExportPayload(
      projectId,
      docFirstSeconds(doc, CARD_SECONDS),
      cardSettings(doc.aspect),
      "card"
    );
    res = await postExport(projectId, payload, "card.mp4", backend);
  } catch {
    return; // no clips yet
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  if (!res.ok || !body.id) return;
  await pollExport(body.id, () => {}, undefined, backend).catch(() => {});
}

/** Rebuild the open project's share card from the cut as it stands. Fire and
 * forget: the card is an accessory to the link, and a failed render leaves the
 * previous one (or the generated placeholder) in place. */
export function refreshShareCard(projectId: string): void {
  const s = useEditor.getState();
  if (!s.loaded || s.projectId !== projectId || projectDuration(s) <= 0) return;
  void renderShareCard(projectId, {
    aspect: s.aspect,
    assets: s.assets,
    clips: s.clips,
    audioClips: s.audioClips,
    overlays: s.overlays,
    subtitles: s.subtitles,
    fadeIn: s.fadeIn,
    fadeOut: s.fadeOut,
    background: s.background,
  }).catch(() => {});
}

/**
 * Rebuild the open project's streaming ladder from the cut as it stands.
 *
 * Fire and forget, like the card: a failed render leaves the previous ladder
 * serving. Unlike the card, this is not cheap — it re-encodes the whole cut
 * once per rung — so it belongs on the same lull the hover proxy waits for
 * (the editor closing, or the tab going to the background), never on an
 * interaction like opening a dialog. The server drops it for a project that
 * has no share, so callers do not have to know.
 *
 * `shareSubtitles` decides whether captions are burned in; pass what the share
 * actually grants, not what the owner is looking at.
 */
export async function refreshShareLadder(projectId: string): Promise<void> {
  const s = useEditor.getState();
  if (!s.loaded || s.projectId !== projectId || projectDuration(s) <= 0) return;
  const backend = getBackend();
  // The share decides what the render may contain, so it is read first. This
  // also settles whether to render at all: an unshared project has no viewer to
  // build a ladder for.
  const res = await backend.fetch(`/api/cut/projects/${projectId}/share`).catch(() => null);
  if (!res?.ok) return;
  const body = (await res.json().catch(() => null)) as {
    share?: { features?: { subtitles?: boolean } } | null;
  } | null;
  if (!body?.share) return;
  await renderShareLadder(
    projectId,
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
    body.share.features?.subtitles === true
  );
}
