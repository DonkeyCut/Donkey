import { wrapTextToRoom } from "@donkeycut/effects-kit";
import { createRasterCanvas, type RasterSurface } from "./raster";
import type { MediaAsset, StoredAsset } from "./types";

// A block is a shot with nothing in it yet: a source that holds a slot on the
// timeline and draws itself — a filled rect carrying the label of whatever
// belongs there. It owns no file, so blocking out a cut writes nothing to
// storage and decodes nothing; the picture is painted once, at whatever size
// asks for it, and cached by the reader that asked. A clip playing a block
// cuts, trims, moves and takes a transition like any other clip, and the day
// the footage arrives it replaces the block in place.

export const BLOCK_COLOR = "#161A22";
const LABEL_COLOR = "#E9EDF5";
const STROKE_COLOR = "#2E3644";

/** The source a shot stands on until its footage exists. It takes the
 * project's own frame, so a block fills the picture the way the footage that
 * replaces it will. */
export function blockAsset(
  shot: { seconds: number; label?: string; color?: string },
  i: number,
  frame: { w: number; h: number }
): MediaAsset {
  const label = shot.label?.trim() || `Shot ${i + 1}`;
  return {
    id: `block-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`,
    // No file: nothing is stored, so nothing is named on disk either.
    fileName: "",
    name: label,
    type: "image",
    duration: shot.seconds,
    width: frame.w,
    height: frame.h,
    url: "",
    block: { label, ...(shot.color ? { color: shot.color } : {}) },
    // Cut made this, so it belongs where it was made and not in the Media
    // panel with the person's own imports.
    origin: "block",
  };
}

/** Paint a block at this size. Both frame readers — the preview's and the
 * export's — call this in place of fetching and decoding a still. */
export function drawBlock(
  asset: Pick<StoredAsset, "block" | "name">,
  width: number,
  height: number
): RasterSurface {
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  const canvas = createRasterCanvas(w, h);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return canvas;
  const short = Math.min(w, h);
  ctx.fillStyle = asset.block?.color || BLOCK_COLOR;
  ctx.fillRect(0, 0, w, h);

  const inset = Math.round(short * 0.05);
  ctx.strokeStyle = STROKE_COLOR;
  ctx.lineWidth = Math.max(2, Math.round(short * 0.006));
  ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);

  const label = asset.block?.label?.trim() || asset.name || "";
  if (!label) return canvas;
  const size = Math.round(short * 0.062);
  ctx.font = `600 ${size}px system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`;
  ctx.fillStyle = LABEL_COLOR;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = wrapTextToRoom(label, w - inset * 4, (line) => ctx.measureText(line).width).split("\n").slice(0, 4);
  const step = size * 1.3;
  const top = h / 2 - ((lines.length - 1) * step) / 2;
  lines.forEach((line, i) => ctx.fillText(line, w / 2, top + i * step));
  return canvas;
}
