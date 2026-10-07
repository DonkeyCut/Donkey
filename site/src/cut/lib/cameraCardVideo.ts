"use client";

/**
 * Camera-card pieces for the ffmpeg export: a card clip's whole layout —
 * shadow, the picture through the card, the matted head above it — rendered
 * by the compositor at the size of the clip's box, as the color/alpha video
 * pair a removal clip ships. The engine merges the pair and lays it in the
 * box like any picture, then runs the clip's mask, pose and fades over it,
 * so it composites the very pixels the preview draws. Grade, look and any
 * cutout bake in. Without a person matte yet the card renders without the
 * head, the preview's own degrade.
 */

import { removalActive, retimeOf } from "@donkeycut/effects-kit";
import { openCanvasVideo } from "./canvasVideo";
import { FrameCompositor } from "./composite";
import { ensureClipLuts } from "./lutBuild";
import { matteStage } from "./matteAlpha";
import { createRasterCanvas, decodeRasterImageUrl } from "./raster";
import { splitFrame, type RemovalPieces } from "./removalVideo";
import type { MediaAsset, VideoClip } from "./types";
import { liveReader } from "./liveReader";

/**
 * Render one card clip's layer over its segment at `fps`, `box` pixels wide
 * and high — the clip's region box in the output frame, `frameW`×`frameH`.
 * Null when the clip has no card.
 */
export async function renderCardPieces(
  asset: MediaAsset,
  clip: VideoClip,
  assets: MediaAsset[],
  opts: { fps: number; frameW: number; frameH: number; box: { w: number; h: number } }
): Promise<RemovalPieces | null> {
  if (!clip.card) return null;
  const rt = retimeOf(clip);
  const still = asset.type === "image";
  const dur = Math.max(0.1, rt.len);
  const frames = Math.max(1, Math.ceil(dur * opts.fps));
  const w = opts.box.w;
  const h = opts.box.h;

  const reader = liveReader(asset);
  const removal = matteStage(removalActive(clip.removal) ? clip.removal?.matte : undefined, assets);
  const card = matteStage(clip.card.popOut ? clip.card.matte : undefined, assets);
  try {
    const px = w * h;
    const rgbOut = await openCanvasVideo({
      width: w,
      height: h,
      fps: opts.fps,
      frames,
      bitrate: Math.min(20_000_000, Math.max(2_000_000, Math.round(px * opts.fps * 0.12))),
    });
    const alphaOut = await openCanvasVideo({
      width: w,
      height: h,
      fps: opts.fps,
      frames,
      bitrate: Math.min(4_000_000, Math.max(600_000, Math.round(px * opts.fps * 0.02))),
    });
    const readSurface = createRasterCanvas(w, h);
    const readCtx = readSurface.getContext("2d", {
      willReadFrequently: true,
    }) as CanvasRenderingContext2D | null;
    const layer = createRasterCanvas(w, h);
    const layerCtx = layer.getContext("2d") as CanvasRenderingContext2D | null;
    if (!readCtx || !layerCtx) throw new Error("No drawing surface for the camera card layer.");

    // The compositor draws the box as its whole canvas, at the output
    // frame's design scale, so lengths match the preview's frame-sized draw.
    const comp = new FrameCompositor(layer);
    comp.colorMode = "exact";
    comp.designScale = Math.min(opts.frameW, opts.frameH) / 1080;
    await reader.colorRead.settled();
    comp.sourceProvider = () => reader.colorRead.recipe();
    // The engine places, masks, poses and fades the layer; the card and
    // everything that rides inside it draw here.
    const plain: VideoClip = {
      ...clip,
      frame: undefined,
      mask: undefined,
      kf: undefined,
      rotation: undefined,
      opacity: undefined,
      boxStyle: undefined,
      hidden: undefined,
    };
    await ensureClipLuts([comp.recipeFor(plain)]);
    const backdrops = new Map<string, CanvasImageSource | null>();
    const bd = clip.removal?.backdrop;
    if (removalActive(clip.removal) && bd?.kind === "image" && bd.assetId) {
      const a = assets.find((x) => x.id === bd.assetId);
      const img = a ? await decodeRasterImageUrl(a.url).catch(() => null) : null;
      backdrops.set(bd.assetId, img ? img.source : null);
    }
    comp.backdropImageProvider = (assetId) => backdrops.get(assetId) ?? null;
    comp.removalMatteProvider = () => removal?.get() ?? null;
    comp.cardMatteProvider = () => card?.get() ?? null;
    const alphaPlane = new ImageData(w, h);

    for (let i = 0; i < frames; i++) {
      const s = Math.min(dur - 1 / (opts.fps * 2), i / opts.fps);
      const srcT = still ? 0 : rt.srcAt(s);
      const frame = await reader.frameAt(srcT);
      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.clearRect(0, 0, w, h);
      if (frame.kind === "ready") {
        await removal?.stage(srcT);
        await card?.stage(srcT);
        comp.drawIntoRect(frame, { x: 0, y: 0, w: 1, h: 1 }, false, 1, clip.start + s, 1, plain);
      }
      splitFrame(layer, w, h, { surface: readSurface, ctx: readCtx }, alphaPlane, rgbOut.ctx, alphaOut.ctx, w, h);
      await rgbOut.add(i / opts.fps, 1 / opts.fps);
      await alphaOut.add(i / opts.fps, 1 / opts.fps);
    }
    return { rgb: await rgbOut.finish(), alpha: await alphaOut.finish() };
  } finally {
    reader.dispose();
    removal?.dispose();
    card?.dispose();
  }
}
