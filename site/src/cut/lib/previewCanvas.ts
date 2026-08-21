"use client";

import { createRasterCanvas, type RasterSurface } from "./raster";

/**
 * The live preview <canvas>, registered by Preview while it is mounted, so
 * panels can sample the composited frame (the color panel's histogram reads
 * it). Media decoders load with crossOrigin=anonymous and the engine serves
 * CORS, so the canvas stays readable.
 */
let el: HTMLCanvasElement | null = null;

export function setPreviewCanvas(canvas: HTMLCanvasElement | null) {
  el = canvas;
}

export function getPreviewCanvas(): HTMLCanvasElement | null {
  return el;
}

/** Where the picture waits while the backing store is replaced under it. Kept
 * for the page's life: a resize is a moment where allocating is the last thing
 * to be doing. */
let carry: RasterSurface | null = null;

/**
 * Resize the preview's backing store, keeping the picture.
 *
 * Assigning a canvas's width or height erases it, and the engine repaints on
 * its own schedule — with a decoder still opening it deliberately leaves what
 * is on screen alone, which is the whole reason the preview holds a frame
 * instead of strobing. Those two together are a black flash: the store is
 * cleared, and the frame that would refill it is not ready yet. So the picture
 * comes across the resize — copied out, then laid back down scaled to the new
 * store — and the canvas is never empty at any instant. The next real frame
 * simply paints over it.
 */
export function resizePreviewSurface(canvas: HTMLCanvasElement, w: number, h: number): void {
  if (canvas.width === w && canvas.height === h) return;
  const held = holdPicture(canvas);
  canvas.width = w;
  canvas.height = h;
  if (!held) return;
  const ctx = canvas.getContext("2d");
  ctx?.drawImage(held, 0, 0, w, h);
}

/** The canvas's current pixels, on a surface of their own. Null when there is
 * nothing to keep or nowhere to put it. */
function holdPicture(canvas: HTMLCanvasElement): RasterSurface | null {
  const { width: w, height: h } = canvas;
  if (w < 1 || h < 1) return null;
  if (!carry) carry = createRasterCanvas(w, h);
  if (carry.width !== w) carry.width = w;
  if (carry.height !== h) carry.height = h;
  const ctx = carry.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);
  // Cross-origin media taints the canvas; drawing one into another is still
  // allowed, and nothing here reads pixels back.
  ctx.drawImage(canvas, 0, 0);
  return carry;
}

/**
 * A clip's raw decoded frame, straight from the playback engine's decoder
 * element — before any color grade — so analysis (the color panel's Auto)
 * never fits corrections on top of its own output. The engine registers the
 * sampler while mounted; null when the clip has no ready decoder.
 */
type SourceSampler = (clipId: string) => CanvasImageSource | null;
let sampler: SourceSampler | null = null;

export function registerSourceSampler(fn: SourceSampler | null) {
  sampler = fn;
}

export function sampleClipSource(clipId: string): CanvasImageSource | null {
  return sampler?.(clipId) ?? null;
}

/** A small RGBA readout of the clip's raw frame, for analysis (auto grade);
 * null when no decoder is ready or the pixels are unreadable. */
export function sampleClipFrameData(clipId: string, w = 96, h = 54): Uint8ClampedArray | null {
  const src = sampleClipSource(clipId);
  if (!src) return null;
  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(src, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
}
