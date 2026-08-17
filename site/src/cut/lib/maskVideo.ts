"use client";

/**
 * The person-matte video for the ffmpeg export path. The page — the only
 * place that can run segmentation — composes the video layers over the
 * subject window at a small size, segments each frame, and encodes the
 * person mask as a plain grayscale H.264 clip (white = person; no alpha
 * encoding, which browsers can't do reliably). The server scales it up, pads
 * it to the timeline, and every subject-masked consumer — behind elements,
 * front subject elements, subject-masked clips — trims by it. The matte
 * source leaves subject-masked clips out of its composite, so a trimmed clip
 * never reads its own pixels back.
 */

import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { personSegmenter, segmentSubjectAlpha } from "./cutout";
import { FrameCompositor, MISSING_FRAME } from "./composite";
import { overlayPlan, trackZeroPlan } from "./framePlan";
import { ClipReader, VIDEO_CODECS } from "./exportRender";
import type { ExportDoc } from "./exportClient";
import { createRasterCanvas } from "./raster";
import { getClipSpans } from "./store";
import { frameOf, isEffectOverlay, isFullRect, isTextOverlay, rectOf, subjectMasked, type ClipSpan, type MediaAsset } from "./types";

/** Encoded mask rate — the server's fps filter duplicates frames up to the
 * output rate, and a person moves little in 1/15s. */
export const MASK_FPS = 15;
/** Mask frame short side; alphamerge scales it to the output. */
const MASK_SHORT = 480;

/** Timeline second inside a span mapped to its source second. */
const sourceTimeAt = (sp: ClipSpan, t: number) => {
  const speed = sp.clip.speed && sp.clip.speed > 0 ? sp.clip.speed : 1;
  return Math.min(sp.clip.out, sp.clip.in + Math.max(0, t - sp.start) * speed);
};

/** A clip whose picture trims by the person matte (either direction). */
const subjectClip = (c: { mask?: { kind: string } }) => c.mask?.kind === "subject";

/**
 * Render the person-mask video covering every subject-masked consumer's
 * window (one union range): behind and front subject elements, and
 * subject-masked video clips. Null when nothing reads the matte, no person
 * segmenter is available, or the range is empty — the export simply proceeds
 * without the effect, matching the preview's degrade.
 */
export async function renderSubjectMask(
  doc: ExportDoc,
  duration: number
): Promise<{ blob: Blob; from: number } | null> {
  const windows: { start: number; end: number }[] = doc.overlays
    .filter(
      (o) =>
        subjectMasked(o) &&
        !o.hidden &&
        !isEffectOverlay(o) &&
        (!isTextOverlay(o) || !!o.text.trim()) &&
        o.start < duration
    )
    .map((o) => ({ start: o.start, end: o.end }));
  for (const track of [...new Set(doc.clips.map((c) => c.track))]) {
    for (const sp of getClipSpans(doc.clips, doc.assets, track)) {
      if (!subjectClip(sp.clip) || sp.clip.hidden || sp.start >= duration) continue;
      windows.push({ start: sp.start, end: sp.start + sp.len });
    }
  }
  if (windows.length === 0) return null;
  const from = Math.max(0, Math.min(...windows.map((w) => w.start)));
  const to = Math.min(duration, Math.max(...windows.map((w) => w.end)));
  if (to - from < 0.05) return null;
  const segmenter = await personSegmenter();
  if (!segmenter) return null;

  const frame = frameOf(doc.aspect);
  const scale = MASK_SHORT / Math.min(frame.w, frame.h);
  const even = (n: number) => 2 * Math.round((n * scale) / 2);
  const W = even(frame.w);
  const H = even(frame.h);
  const codec = await getFirstEncodableVideoCodec(VIDEO_CODECS, { width: W, height: H });
  if (!codec) return null;

  // A small compositor: the video layers only, at mask resolution.
  const compose = createRasterCanvas(W, H);
  const comp = new FrameCompositor(compose);
  const mask = createRasterCanvas(W, H);
  const mctx = mask.getContext("2d") as CanvasRenderingContext2D;

  const spans = getClipSpans(doc.clips, doc.assets);
  const overlayTracks = [...new Set(doc.clips.filter((c) => c.track !== 0).map((c) => c.track))];
  const byTrack = new Map(overlayTracks.map((track) => [track, getClipSpans(doc.clips, doc.assets, track)]));
  const spanOfClip = new Map<string, ClipSpan>();
  for (const list of byTrack.values()) for (const sp of list) spanOfClip.set(sp.clip.id, sp);
  const readers = new Map<string, ClipReader>();
  const readerFor = (asset: MediaAsset) => {
    let r = readers.get(asset.id);
    if (!r) readers.set(asset.id, (r = new ClipReader(asset, () => asset.url)));
    return r;
  };

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const video = new CanvasSource(mask, { codec, bitrate: 1_000_000 });
  const frames = Math.max(1, Math.ceil((to - from) * MASK_FPS));
  output.addVideoTrack(video, { frameRate: MASK_FPS, maximumPacketCount: frames + 8 });

  try {
    await output.start();
    for (let i = 0; i < frames; i++) {
      const t = Math.min(to, from + i / MASK_FPS);
      comp.clear();
      // Subject-masked clips stay out of the matte's composite (their shape
      // masks still apply through the compositor): the matte drives their
      // trim, so reading their own pixels back would feed the mask itself.
      const master = spans.find((sp) => t >= sp.start && t < sp.start + sp.len);
      if (master && !master.clip.hidden && !subjectClip(master.clip)) {
        const plan = trackZeroPlan(master, spans, t);
        if (plan.backdrop && !subjectClip(plan.backdrop.span.clip)) {
          const f = await readerFor(plan.backdrop.span.asset).frameAt(plan.backdrop.at);
          comp.drawLayer(f, plan.backdrop.span.clip, false, 1, t);
        }
        const f = await readerFor(master.asset).frameAt(sourceTimeAt(master, t));
        comp.drawLayer(f ?? MISSING_FRAME, master.clip, false, 1, t);
      }
      for (const layer of overlayPlan(overlayTracks, (track) => byTrack.get(track) ?? [], t)) {
        if (subjectClip(layer.clip)) continue;
        const span = spanOfClip.get(layer.clip.id);
        if (!span) continue;
        const f = await readerFor(layer.asset).frameAt(sourceTimeAt(span, t));
        const rect = rectOf(layer.clip);
        const cover = layer.clip.fit === "fill" || (layer.clip.fit == null && isFullRect(rect));
        comp.drawIntoRect(f, rect, cover, layer.alpha, t, layer.zoom, layer.clip);
      }
      // Luma mask: black frame, the subject's alpha silhouette drawn white.
      mctx.globalCompositeOperation = "source-over";
      mctx.fillStyle = "#000000";
      mctx.fillRect(0, 0, W, H);
      const alpha = segmentSubjectAlpha(segmenter, compose as HTMLCanvasElement);
      if (alpha) mctx.drawImage(alpha, 0, 0, W, H);
      await video.add(i / MASK_FPS, 1 / MASK_FPS);
    }
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) return null;
    return { blob: new Blob([buffer], { type: "video/mp4" }), from };
  } catch {
    await output.cancel().catch(() => {});
    return null;
  } finally {
    for (const r of readers.values()) r.dispose();
  }
}
