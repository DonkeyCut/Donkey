/**
 * The picture a font shows of itself: a pangram on a warm charcoal sheet,
 * wrapped and left-aligned.
 *
 * Drawing the line in a live face depends on that face being installed in
 * whatever page is looking at it, which is a thing that can be true one minute
 * and false the next — a shelf that did not answer, a listing that had not
 * synced. The specimen is baked once, at upload, from bytes that are in hand,
 * and the shelf keeps it as the file's cover, so a card with no face installed
 * still shows the typeface.
 */

import { createRasterCanvas, rasterCanvasToPng } from "./raster";

/** What a font shows of itself, wrapped and left-aligned, on the card and in
 * the big view alike. */
export const SPECIMEN_TEXT = "Pack my box with five dozen jugs";

/** The sheet the specimen is set on, shared by the baked picture and the card
 * that draws the face live, so the two read as one object. */
export const SPECIMEN_BG = "#1E1C18";
/** The face itself on that sheet. */
export const SPECIMEN_INK = "#F1EFE8";
/** The card's footnote beside the name: file kind and size. */
export const SPECIMEN_META = "#8A877E";

/** What a baked specimen is called. The name carries the sheet's layout, so a
 * cover baked before this one — a centred alphabet on a wide sheet — is spotted
 * by its name and passed over. */
export const SPECIMEN_FILE_SUFFIX = ".specimen-square.png";
export const isCurrentSpecimen = (url: string) =>
  url.split("?")[0].endsWith(SPECIMEN_FILE_SUFFIX);

const S = 1200;
const PAD = 90;
const LEADING = 1.2;

/** The pangram broken into lines at `size`, greedily, the way the card's
 * text wraps. */
function wrapLines(ctx: CanvasRenderingContext2D, size: number, family: string, room: number): string[] | null {
  ctx.font = `${size}px "${family}"`;
  const lines: string[] = [];
  let line = "";
  for (const word of SPECIMEN_TEXT.split(" ")) {
    if (ctx.measureText(word).width > room) return null;
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > room) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A square specimen of an installed family, set the way the card sets it: the
 * largest size at which the wrapped words fit the sheet.
 */
export async function specimenPng(family: string): Promise<Blob> {
  const canvas = createRasterCanvas(S, S);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("No 2D context for the specimen.");
  const room = S - PAD * 2;
  let lo = 8;
  let hi = 600;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const lines = wrapLines(ctx, mid, family, room);
    if (lines && lines.length * mid * LEADING <= room) lo = mid;
    else hi = mid;
  }
  const lines = wrapLines(ctx, lo, family, room) ?? [SPECIMEN_TEXT];
  ctx.fillStyle = SPECIMEN_BG;
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = SPECIMEN_INK;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `${lo}px "${family}"`;
  const step = lo * LEADING;
  const top = S / 2 - ((lines.length - 1) * step) / 2;
  lines.forEach((line, i) => ctx.fillText(line, PAD, top + i * step));
  return rasterCanvasToPng(canvas);
}
