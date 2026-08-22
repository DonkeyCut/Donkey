"use client";

import {
  hexAlpha,
  WORD_BASELINE_DROP,
  renderElementPng as kitRenderElementPng,
  renderOverlayFrames as kitRenderOverlayFrames,
  LINE_HEIGHT,
  type OverlayFrameSet,
  type PaintPhase,
  type RenderEnv,
  type StickerImage,
  type WordDraw,
} from "@donkeycut/effects-kit";
import type { CSSProperties } from "react";
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

/** The css one word wears — the DOM twin of what the canvas painter draws for
 * a resolved `WordDraw`. A resize is real type size, so the line reflows
 * around it, which is what the burn-in lays out too; the word keeps the
 * line's own leading, so a bigger word never opens the line box up. A box is
 * box-shadow spread, which stays clear of the layout. */
export function wordDrawCss(d: WordDraw, lineHeight = LINE_HEIGHT): CSSProperties {
  const css: CSSProperties = { color: d.color };
  if (d.opacity < 0.999) css.opacity = d.opacity;
  // The word takes its room at the layout size and draws at its own, which
  // differ only while it is growing into its place: real type size for the
  // room, so the line reflows around a swollen word exactly as the burn-in
  // lays it out, and a transform for the rest, which leaves the layout alone.
  if (d.layoutScale !== 1) {
    css.fontSize = `${d.layoutScale}em`;
    css.lineHeight = lineHeight / d.layoutScale;
  }
  const shrink = d.scale / d.layoutScale;
  // A word drawn smaller than the room it holds shares the line's baseline, so
  // it hangs lower in its box than a scale about the box center would leave
  // it; the drop makes up the difference. Offsets are em of the size the word
  // draws at and the box is em of the size it takes room at, so they convert
  // by the ratio between the two.
  const sit = (WORD_BASELINE_DROP * (d.layoutScale - d.scale)) / d.layoutScale;
  if (shrink !== 1 || d.dx || d.dy || d.rotate) {
    css.display = "inline-block";
    css.transform =
      `translate(${d.dx * shrink}em, ${d.dy * shrink + sit}em) rotate(${d.rotate}deg)` +
      (shrink !== 1 ? ` scale(${shrink})` : "");
  }
  const mark = d.markAlpha ?? 0;
  if (d.mark === "box" && mark > 0.001) {
    const fill = hexAlpha(d.markColor ?? "#000000", mark);
    css.background = fill;
    css.boxShadow = `0 0 0 0.12em ${fill}`;
    css.borderRadius = "0.18em";
    css.textShadow = "none";
  } else if (d.mark === "underline" && mark > 0.001) {
    css.textDecoration = "underline";
    css.textDecorationColor = hexAlpha(d.color, mark);
    css.textDecorationThickness = "0.07em";
    css.textUnderlineOffset = "0.14em";
  }
  return css;
}

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
  assets: MediaAsset[] = [],
  phase?: PaintPhase
): Promise<Blob> {
  return kitRenderElementPng(overlay, width, height, cutRenderEnv(assets), phase);
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
