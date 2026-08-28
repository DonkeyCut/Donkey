"use client";

/**
 * The free matte bake: MediaPipe person segmentation walked over the clip's
 * trimmed source range and encoded as a grayscale H.264 clip (white = person
 * — luma, never alpha, which browsers can't encode reliably). It runs in
 * seconds, spends nothing, and gives every surface — headless renders
 * included — a stored matte the moment auto removal is switched on; the
 * hosted quality bake replaces it when it lands.
 */

import { MATTE_BITRATE, MATTE_FPS, MATTE_SHORT } from "@donkeycut/effects-kit";
import { openCanvasVideo, scaledEvenSize } from "../canvasVideo";
import { personSegmenter, segmentSubjectAlpha } from "../cutout";
import { createRasterCanvas } from "../raster";
import type { MediaAsset, VideoClip } from "../types";
import { liveReader } from "../liveReader";

export class MatteBakeCancelled extends Error {
  constructor() {
    super("The bake was cancelled.");
  }
}

/**
 * Segment the clip's people over `[clip.in, clip.out]` and encode the matte.
 * A still image bakes as a single frame. Throws when no segmenter is
 * available (missing assets) or the encode has no codec; a cancellation
 * surfaces as `MatteBakeCancelled`. `in` is the source second the matte's
 * zero maps to.
 */
export async function localBakeMatte(
  asset: MediaAsset,
  clip: VideoClip,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<{ blob: Blob; in: number }> {
  const segmenter = await personSegmenter();
  if (!segmenter) throw new Error("On-device segmentation is unavailable in this browser.");
  const still = asset.type === "image";
  const from = still ? 0 : Math.max(0, clip.in);
  const to = still ? from + 1 / MATTE_FPS : Math.min(clip.out, asset.duration || clip.out);
  const seconds = Math.max(1 / MATTE_FPS, to - from);
  const frames = still ? 1 : Math.max(1, Math.ceil(seconds * MATTE_FPS));

  const reader = liveReader(asset);
  try {
    const first = await reader.frameAt(from);
    if (first.kind !== "ready") throw new Error("The clip's picture could not be read.");
    const { w, h } = scaledEvenSize(first.width, first.height, MATTE_SHORT);
    const enc = await openCanvasVideo({
      width: w,
      height: h,
      fps: MATTE_FPS,
      frames,
      bitrate: MATTE_BITRATE,
    });
    const small = createRasterCanvas(w, h);
    const sctx = small.getContext("2d") as CanvasRenderingContext2D | null;

    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) {
        await enc.cancel();
        throw new MatteBakeCancelled();
      }
      const at = Math.min(to - 1 / (MATTE_FPS * 2), from + i / MATTE_FPS);
      const frame = await reader.frameAt(at);
      enc.ctx.fillStyle = "#000000";
      enc.ctx.fillRect(0, 0, w, h);
      if (frame.kind === "ready" && sctx) {
        sctx.clearRect(0, 0, w, h);
        sctx.drawImage(frame.image, 0, 0, w, h);
        const alpha = segmentSubjectAlpha(segmenter, small as HTMLCanvasElement);
        if (alpha) {
          enc.ctx.imageSmoothingEnabled = true;
          enc.ctx.drawImage(alpha, 0, 0, w, h);
        }
      }
      await enc.add(i / MATTE_FPS, 1 / MATTE_FPS);
      opts.onProgress?.((i + 1) / frames);
    }
    return { blob: await enc.finish(), in: from };
  } finally {
    reader.dispose();
  }
}
