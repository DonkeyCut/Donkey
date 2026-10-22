"use client";

import { baselineDrop, cycleFaceAt as faceShowingAt, forgetSettledFaces, overlayFontCycle, settleCycleFace, textWrapRoom, withFontCycle, wrapTextToRoom, LINE_HEIGHT, PLATE_PAD_X, PLATE_PAD_Y, type CycleFace } from "@donkeycut/effects-kit";
import { faceEmAscent } from "./fontEm";
import { createRasterCanvas } from "./raster";
import { fontStack, type Overlay, type TextOverlay } from "./types";

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
/** Each face's lift (`textLineLift`), by css font. A face read while it was
 * still loading was read as its fallback, so the page finishing a load drops
 * the readings before anything reads them again. */
const lifts = new Map<string, number>();
if (typeof document !== "undefined") document.fonts?.addEventListener?.("loadingdone", () => lifts.clear());

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
  lifts.clear();
  settled = new WeakMap();
  forgetSettledFaces();
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

/**
 * How far above a CSS line the painter sets the same line's type, in pixels
 * of `cssFont`'s own size.
 *
 * A CSS line box centres the face's ascent and descent in its height, so the
 * baseline sits half their difference under the line's middle. The painter
 * sets each line's baseline under its middle by the face's em box
 * (`baselineDrop`), the same on every canvas. On a face with a tall ascent the
 * two part by a tenth of an em: Jost at 110 px sits 12 px lower in the DOM
 * than the export draws it. The preview lifts its type by this much. The line
 * box is read off this browser's canvas, the one the DOM's lines are set by;
 * a canvas that cannot report the face's line metrics lifts nothing.
 */
export function textLineLift(cssFont: string): number {
  const hit = lifts.get(cssFont);
  if (hit !== undefined) return hit;
  const ctx = measureCtx();
  let lift = 0;
  if (ctx) {
    ctx.font = cssFont;
    const was = ctx.textBaseline;
    ctx.textBaseline = "alphabetic";
    const line = ctx.measureText("Hg");
    const cssDrop = (line.fontBoundingBoxAscent - line.fontBoundingBoxDescent) / 2;
    const painterDrop = baselineDrop(ctx, Number(/([\d.]+)px/.exec(cssFont)?.[1]), faceEmAscent(cssFont));
    ctx.textBaseline = was;
    if (Number.isFinite(cssDrop) && Number.isFinite(painterDrop)) lift = cssDrop - painterDrop;
  }
  // Bounded: every stage size is a size of its own.
  if (lifts.size > 500) lifts.clear();
  lifts.set(cssFont, lift);
  return lift;
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
export function fitTextToFrame(o: TextOverlay, frameW: number, frameH?: number): string {
  const size = o.size;
  const font = textFontOf(o, size);
  const room = textWrapRoom(o, frameW, frameH);
  const width = (line: string) => measureLine(line, font, size, o.letterSpacing ?? 0);
  if (o.text.split("\n").every((line) => width(line) <= room)) return o.text;
  return wrapTextToRoom(o.text, room, width);
}

/** Each element's settled faces, one per face, frame width and font state,
 * so a playing preview resolves a cycling title without re-wrapping it on
 * every tick. Keyed by the element, so an edit starts afresh. */
let settled = new WeakMap<Overlay, { face: CycleFace; frameW: number; frameH?: number; ready: boolean; out: Overlay }[]>();
/** Settled faces one element keeps: its faces at a few frame widths. */
const SETTLED_PER_ELEMENT = 32;

/** The element as it is set `tLocal` seconds in, a font cycle's face set on
 * the title's own lines the way the kit's painters set it (`settleCycleFace`),
 * so the preview never reflows a title the export keeps on one line. One face
 * at one frame width hands back the same element every tick. */
export function cycleFaceAt<T extends Overlay>(o: T, tLocal: number, frameW: number, frameH?: number): T {
  const c = overlayFontCycle(o);
  const face = c ? faceShowingAt(c, tLocal) : null;
  if (!face) return o;

  // A face already settled at this width, in fonts that have not changed since.
  const ready = facesReady();
  const known = settled.get(o) ?? [];
  for (const k of known) {
    if (k.face === face && k.frameW === frameW && k.frameH === frameH && k.ready === ready) return k.out as T;
  }

  const el = withFontCycle(o, tLocal);
  const out = settleCycleFace(el, textWrapRoom(el as TextOverlay, frameW, frameH), (type, line) =>
    measureLine(line, textFontOf(type, type.size), type.size, type.letterSpacing ?? 0)
  );
  if (known.length >= SETTLED_PER_ELEMENT) known.shift();
  known.push({ face, frameW, frameH, ready, out });
  settled.set(o, known);
  return out;
}

/** Resting box in design pixels, measured once for resize gestures. */
export function textBoxSize(o: TextOverlay, frameW: number, frameH?: number): { width: number; height: number } {
  const lines = fitTextToFrame(o, frameW, frameH).split("\n");
  const width = o.wrapWidth ? textWrapRoom(o, frameW) : Math.max(1, ...lines.map((line) => measureLine(line, textFontOf(o, o.size), o.size, o.letterSpacing ?? 0)));
  return { width: width + (o.plate ? 2 * PLATE_PAD_X * o.size : 0), height: (lines.length * (o.lineHeight ?? LINE_HEIGHT) + (o.plate ? 2 * PLATE_PAD_Y : 0)) * o.size };
}
