"use client";

import { textRoom, wrapTextToRoom } from "@donkeycut/effects-kit";
import { createRasterCanvas } from "./raster";
import { fontStack, type TextOverlay } from "./types";

/**
 * Keeping written words inside the frame.
 *
 * Text is laid out from explicit lines everywhere it is drawn — the preview's
 * DOM, the export's canvas painter — so nothing reflows on its own and a line
 * that is too long simply runs off the edge. This measures a line the way the
 * painter will draw it and breaks it where it has to break, so a title the
 * assistant writes and a caption a transcript produces both land inside the
 * picture whatever face and size they are wearing.
 *
 * The measurement goes through the raster seam, so a headless render measures
 * with the same canvas it draws with.
 */

let measured: CanvasRenderingContext2D | null | undefined;

function measureCtx(): CanvasRenderingContext2D | null {
  if (measured === undefined) {
    try {
      measured = (createRasterCanvas(8, 8).getContext("2d") ??
        null) as CanvasRenderingContext2D | null;
    } catch {
      measured = null;
    }
  }
  return measured;
}

/** Whether the page's own faces have finished loading. A line measured against
 * a fallback face is measured again once the real one arrives, so an early
 * paint never pins a wrap that the loaded font would not have produced. */
function facesReady(): boolean {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  return !fonts || fonts.status === "loaded";
}

const widths = new Map<string, number>();

/**
 * Drop every measurement taken so far.
 *
 * A headless run has no `document.fonts` to watch, so the only sign that a
 * face arrived is the install itself: `fontAssets` calls this the moment one
 * is registered or dropped. A caption measured against the fallback while the
 * project's own face was still being fetched would otherwise keep that width
 * for the life of the process and break its lines in places the drawn text
 * does not.
 */
export function forgetTextWidths(): void {
  widths.clear();
}

/** How wide one line draws, in the same pixels `frameW` is in. Falls back to a
 * conservative bold-glyph advance where there is no canvas to ask. */
export function measureLine(
  text: string,
  cssFont: string,
  sizePx: number,
  tracking = 0
): number {
  if (!text) return 0;
  const key = `${facesReady() ? 1 : 0}|${cssFont}|${tracking}|${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;
  const ctx = measureCtx();
  let w: number;
  if (ctx) {
    ctx.font = cssFont;
    if ("letterSpacing" in ctx) {
      (ctx as { letterSpacing: string }).letterSpacing = `${tracking * sizePx}px`;
    }
    w = ctx.measureText(text).width;
  } else {
    w = text.length * (0.58 + tracking) * sizePx;
  }
  // Bounded: a long lyric video walks through a lot of one-off lines.
  if (widths.size > 4000) widths.clear();
  widths.set(key, w);
  return w;
}

/** The css font a text element draws in, at a given pixel size. Mirrors the
 * kit painter's own `textCssFont`, so what is measured is what is drawn. */
export function textFontOf(
  o: Pick<TextOverlay, "italic" | "weight" | "font">,
  sizePx: number
): string {
  return `${o.italic ? "italic " : ""}${o.weight} ${sizePx}px ${fontStack(o.font)}`;
}

/** The element's text with every over-long line broken to fit the room its
 * anchor leaves in the frame. Returns the text unchanged when it already fits,
 * so nothing re-renders for an element that was never in trouble. */
export function fitTextToFrame(o: TextOverlay, frameW: number): string {
  // A stretched element is measured at its own size and drawn wider, so the
  // room shrinks by the stretch — the same arithmetic the kit painter does
  // under `ctx.scale`, which keeps the two breaking in the same places.
  const size = o.size;
  const font = textFontOf(o, size);
  const room = textRoom(o.x, frameW) / Math.max(0.01, o.stretchX ?? 1);
  const width = (line: string) => measureLine(line, font, size, o.letterSpacing ?? 0);
  if (o.text.split("\n").every((line) => width(line) <= room)) return o.text;
  return wrapTextToRoom(o.text, room, width);
}

