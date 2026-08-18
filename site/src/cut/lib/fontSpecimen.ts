/**
 * The picture a font shows of itself.
 *
 * Drawing the alphabet in a live face depends on that face being installed in
 * whatever page is looking at it, which is a thing that can be true one minute
 * and false the next — a shelf that did not answer, a listing that had not
 * synced. The specimen is baked once, at upload, from bytes that are in hand,
 * and the shelf keeps it as the file's cover. What the card shows afterwards is
 * a picture, so it is the same every time.
 */

import { createRasterCanvas, rasterCanvasToPng } from "./raster";

export const SPECIMEN_LINES = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "1234567890",
];

const W = 1600;
const H = 900;
const PAD = 90;
/** Measured at one size and scaled; large enough that rounding doesn't show. */
const PROBE = 100;

/**
 * A 16:9 specimen of an installed family.
 *
 * One size for all three lines: the capitals are the widest, so fitting them
 * sets the size and the rest fall where the face puts them.
 */
export async function specimenPng(family: string): Promise<Blob> {
  const canvas = createRasterCanvas(W, H);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("No 2D context for the specimen.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111111";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${PROBE}px "${family}"`;
  const widest = ctx.measureText(SPECIMEN_LINES[0]).width;
  const size = widest > 0 ? (PROBE * (W - PAD * 2)) / widest : PROBE;
  ctx.font = `${size}px "${family}"`;
  const step = size * 1.35;
  SPECIMEN_LINES.forEach((line, i) => {
    ctx.fillText(line, W / 2, H / 2 + (i - 1) * step);
  });
  return rasterCanvasToPng(canvas);
}
