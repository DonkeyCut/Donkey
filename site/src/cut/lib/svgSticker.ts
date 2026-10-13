"use client";

/**
 * Stickers drawn from SVG markup: the assistant writes a small vector — a UI
 * icon, a mouse pointer, a spinner arc, a badge — and it lands as an
 * origin-"sticker" PNG like any other. The markup is rasterized here, in the
 * browser, so the sticker is an ordinary image to every renderer (the live
 * preview, the in-tab export and the server's headless render alike).
 */

import { enrichAsset, uploadProjectImage } from "./media";
import { createRasterCanvas, decodeRasterImage, rasterCanvasToPng } from "./raster";
import { useEditor } from "./store";
import { mediaSlug, type MediaAsset } from "./types";

/** The long side a drawn sticker is rasterized at, px: crisp at full-frame
 * size on a 4K export's short side. */
export const SVG_STICKER_PX = 1024;

/** The markup's own aspect, from its viewBox or width/height; null when it
 * names neither. */
export function svgAspect(svg: string): number | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const box = /viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)\s*["']/i.exec(root);
  if (box) {
    const w = Number(box[3]);
    const h = Number(box[4]);
    return w > 0 && h > 0 ? w / h : null;
  }
  const w = Number(/\swidth\s*=\s*["']([\d.]+)/i.exec(root)?.[1]);
  const h = Number(/\sheight\s*=\s*["']([\d.]+)/i.exec(root)?.[1]);
  return w > 0 && h > 0 ? w / h : null;
}

/**
 * The markup made ready to draw at `w`×`h`: one root <svg> with the SVG
 * namespace and the raster's size, so the browser scales the viewBox to fill
 * it. Throws on markup that is not a single sized SVG.
 */
export function sizedSvg(svg: string, w: number, h: number): string {
  const text = svg.trim();
  if (!/^(<\?xml[^>]*>\s*)?<svg\b/i.test(text) || !/<\/svg>\s*$/i.test(text)) {
    throw new Error("svg must be one <svg …>…</svg> element.");
  }
  if (/<(script|foreignObject)\b/i.test(text) || /\bon[a-z]+\s*=/i.test(text)) {
    throw new Error("svg can't carry scripts, event handlers or foreignObject.");
  }
  if (/\b(href|src)\s*=\s*["'](?!#)/i.test(text)) {
    throw new Error("svg can't load outside files; draw everything inline.");
  }
  if (!svgAspect(text)) throw new Error("svg needs a viewBox (or width and height).");
  return text.replace(/<svg\b([^>]*)>/i, (_, attrs: string) => {
    const kept = attrs.replace(/\s(width|height|xmlns)\s*=\s*["'][^"']*["']/gi, "");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"${kept}>`;
  });
}

/** Draw SVG markup to a transparent PNG, `SVG_STICKER_PX` on its long side. */
export async function rasterizeSvg(svg: string): Promise<Blob> {
  const aspect = svgAspect(svg) ?? 1;
  const w = Math.max(1, Math.round(aspect >= 1 ? SVG_STICKER_PX : SVG_STICKER_PX * aspect));
  const h = Math.max(1, Math.round(aspect >= 1 ? SVG_STICKER_PX / aspect : SVG_STICKER_PX));
  // Decoded and drawn through the raster seam: the page's DOM image and
  // canvas, or the skia surface a headless runner installs.
  const img = await decodeRasterImage(new Blob([sizedSvg(svg, w, h)], { type: "image/svg+xml" }));
  if (!img) {
    throw new Error("The svg did not draw; check that it is valid SVG markup.");
  }
  const canvas = createRasterCanvas(w, h);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.drawImage(img.source, 0, 0, w, h);
  return rasterCanvasToPng(canvas);
}

/** Rasterize `svg` and save it as an origin-"sticker" asset of the open
 * project, named `name`. */
export async function saveSvgSticker(projectId: string, svg: string, name: string): Promise<MediaAsset> {
  const png = await rasterizeSvg(svg);
  const asset = await uploadProjectImage(projectId, png, `${mediaSlug(name, "sticker")}.png`, {
    name,
    origin: "sticker",
  });
  useEditor.getState().addAsset(asset);
  void enrichAsset(asset);
  return asset;
}
