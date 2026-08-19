/**
 * The picture a font shows of itself, on a warm charcoal sheet: a pangram on
 * the card, the alphabet in the big view.
 *
 * Drawing the line in a live face depends on that face being installed in
 * whatever page is looking at it, which is a thing that can be true one minute
 * and false the next — a shelf that did not answer, a listing that had not
 * synced. The specimen is baked once, at upload, from bytes that are in hand,
 * and the shelf keeps it as the file's cover, so a card with no face installed
 * still shows the typeface.
 */

import { createRasterCanvas, rasterCanvasToPng } from "./raster";

/** What a card shows: one line, enough of the face to recognise it by. */
export const SPECIMEN_LINES = ["Pack my box with five dozen jugs"];

/** What the big view shows, and what the cover is baked from: every letter and
 * figure, the way a font file previews anywhere else. */
export const SPECIMEN_ALPHABET = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "1234567890",
];

/** The sheet the specimen is set on, shared by the baked picture and the card
 * that draws the face live, so the two read as one object. */
export const SPECIMEN_BG = "#1E1C18";
/** The face itself on that sheet. */
export const SPECIMEN_INK = "#F1EFE8";
/** The card's footnote beside the name: file kind and size. */
export const SPECIMEN_META = "#8A877E";

/** What a baked specimen is called. The name carries the sheet's colours, so a
 * cover baked before this one is spotted by its name and passed over: an old
 * white sheet inside the charcoal card would read as a hole in it. */
export const SPECIMEN_FILE_SUFFIX = ".specimen-dark.png";
export const isCurrentSpecimen = (url: string) =>
  url.split("?")[0].endsWith(SPECIMEN_FILE_SUFFIX);

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
  ctx.fillStyle = SPECIMEN_BG;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = SPECIMEN_INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${PROBE}px "${family}"`;
  const widest = ctx.measureText(SPECIMEN_ALPHABET[0]).width;
  const size = widest > 0 ? (PROBE * (W - PAD * 2)) / widest : PROBE;
  ctx.font = `${size}px "${family}"`;
  const step = size * 1.35;
  const mid = (SPECIMEN_ALPHABET.length - 1) / 2;
  SPECIMEN_ALPHABET.forEach((line, i) => {
    ctx.fillText(line, W / 2, H / 2 + (i - mid) * step);
  });
  return rasterCanvasToPng(canvas);
}
