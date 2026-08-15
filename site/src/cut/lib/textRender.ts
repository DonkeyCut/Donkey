"use client";

import {
  renderElementPng as kitRenderElementPng,
  renderOverlayFrames as kitRenderOverlayFrames,
  type OverlayFrameSet,
  type RenderEnv,
  type StickerImage,
} from "@donkeycut/effects-kit";
import { createRasterCanvas, decodeRasterImage, rasterCanvasToPng } from "./raster";
import { fontStack, type MediaAsset, type Overlay } from "./types";

// The shared text metrics and painters live in the effects kit; these
// re-exports keep the app's preview components on the same constants.
export {
  LINE_HEIGHT,
  PLATE_COLOR,
  PLATE_FILL,
  PLATE_OPACITY,
  PLATE_PAD_X,
  PLATE_PAD_Y,
  PLATE_RADIUS,
  plateFill,
  SHADOW,
} from "@donkeycut/effects-kit";

/** Decoded sticker images by asset id, shared across one page's renders. An
 * <img> decode handles SVG too (createImageBitmap on an SVG blob does not). */
const stickerCache = new Map<string, Promise<StickerImage | null>>();

function decodeSticker(url: string): Promise<StickerImage | null> {
  return fetch(url)
    .then((res) => (res.ok ? res.blob() : Promise.reject(new Error("fetch failed"))))
    .then((blob) => decodeRasterImage(blob)
    )
    .catch(() => null);
}

/** The kit render env bound to this app: Cut's font stacks, and sticker
 * assets resolved from the given project media (their URLs already point at
 * the active backend — local engine or signed R2). */
export function cutRenderEnv(assets: MediaAsset[]): RenderEnv {
  return {
    fontStack,
    createCanvas: (w, h) => createRasterCanvas(w, h) as HTMLCanvasElement,
    canvasToPngBlob: (canvas) => rasterCanvasToPng(canvas),
    resolveLottie: (assetId) =>
      import("./lottieAssets").then((m) => m.sharedLottieHandle(assetId, assets)),
    resolveAsset: (assetId) => {
      const asset = assets.find((a) => a.id === assetId);
      if (!asset) return Promise.resolve(null);
      let hit = stickerCache.get(asset.id);
      if (!hit) {
        hit = decodeSticker(asset.url).then((img) => {
          // A failed decode is not worth pinning; the next render retries.
          if (!img) stickerCache.delete(asset.id);
          return img;
        });
        stickerCache.set(asset.id, hit);
      }
      return hit;
    },
  };
}

/**
 * Render an overlay element (text, shape, or sticker) to a transparent
 * full-frame PNG at the export resolution, matching the DOM preview's
 * metrics. `assets` supplies sticker bytes; text and shapes need none.
 */
export function renderElementPng(
  overlay: Overlay,
  width: number,
  height: number,
  assets: MediaAsset[] = []
): Promise<Blob> {
  return kitRenderElementPng(overlay, width, height, cutRenderEnv(assets));
}

/** Rasterize an animated element into its region-cropped frame set (the
 * export's ffconcat slideshow food), bound to this app's render env. */
export function renderElementFrames(
  overlay: Overlay,
  width: number,
  height: number,
  fps: number,
  assets: MediaAsset[] = []
): Promise<OverlayFrameSet> {
  return kitRenderOverlayFrames(overlay, width, height, fps, cutRenderEnv(assets));
}
