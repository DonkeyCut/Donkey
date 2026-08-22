"use client";

import {
  renderElementPng as kitRenderElementPng,
  renderOverlayFrames as kitRenderOverlayFrames,
  LINE_HEIGHT,
  wordSwell,
  type OverlayFrameSet,
  type PaintPhase,
  type RenderEnv,
  type StickerImage,
} from "@donkeycut/effects-kit";
import type { CSSProperties } from "react";
import { createRasterCanvas, decodeRasterImage, rasterCanvasToPng } from "./raster";
import { fontStack, type MediaAsset, type Overlay, type WordAccentMode } from "./types";

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
  WORD_ACCENT_DEFAULT,
  WORD_ACCENT_LABELS,
  WORD_ACCENT_MODE_IDS,
  WORD_POP_SCALE,
} from "@donkeycut/effects-kit";

/** The css one emphasized word wears — the DOM twin of what the canvas
 * painter draws for `highlightMode`. A swell is real type size, so the line
 * reflows around it: the words beside it move out of its way and settle back
 * as the emphasis travels on, which is what the burn-in lays out too. The
 * word keeps the line's own leading, so a bigger word never opens the line
 * box up. A box is box-shadow spread, which stays clear of the layout. */
export function wordAccentCss(look: {
  mode: WordAccentMode;
  color: string;
  text: string;
  /** How far the word swells; absent = the mode's default. */
  scale?: number;
  /** The block's line height, so the swollen word can hold it. */
  lineHeight?: number;
}): CSSProperties {
  const swell = wordSwell({ style: look.mode, scale: look.scale });
  const lh = look.lineHeight ?? LINE_HEIGHT;
  const size: CSSProperties =
    swell === 1 ? {} : { fontSize: `${swell}em`, lineHeight: lh / swell };
  const treatment: CSSProperties =
    look.mode === "box"
      ? {
          color: look.text,
          background: look.color,
          boxShadow: `0 0 0 0.12em ${look.color}`,
          borderRadius: "0.18em",
          textShadow: "none",
        }
      : look.mode === "color" || look.mode === "pop"
        ? { color: look.color }
        : {
            color: look.color,
            textDecoration: "underline",
            textDecorationThickness: "0.07em",
            textUnderlineOffset: "0.14em",
          };
  return { ...treatment, ...size };
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
