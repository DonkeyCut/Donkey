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

import { matteLumaToAlpha, removalActive, retimeOf, type ClipRemoval } from "@donkeycut/effects-kit";
import { openCanvasVideo } from "./canvasVideo";
import { FrameCompositor, type Frame } from "./composite";
import { ensureClipLuts } from "./lutBuild";
import { createRasterCanvas, decodeRasterImageUrl, type RasterSurface } from "./raster";
import { splitFrame, type RemovalPieces } from "./removalVideo";
import type { MediaAsset, VideoClip } from "./types";
import { liveReader } from "./liveReader";
import type { ClipReader } from "./exportRender";

type Matte = NonNullable<ClipRemoval["matte"]>;

/** One baked matte read alongside the clip: the frame staged per output
 * frame, luma turned to alpha in a canvas kept for the whole render. */
export function matteStage(m: Matte | undefined, assets: MediaAsset[]) {
  const asset = m ? assets.find((a) => a.id === m.assetId) : undefined;
  if (!m || !asset) return null;
  const reader: ClipReader = liveReader(asset);
  const canvas: RasterSurface = createRasterCanvas(2, 2);
  const dur = Math.max(0.1, asset.duration || 0.1);
  let ready = false;
  return {
    async stage(srcT: number) {
      ready = false;
      const f: Frame = await reader.frameAt(Math.min(Math.max(0, srcT - m.in), dur - 0.001));
      if (f.kind !== "ready") return;
      if (canvas.width !== f.width) canvas.width = f.width;
      if (canvas.height !== f.height) canvas.height = f.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, f.width, f.height);
      ctx.drawImage(f.image, 0, 0);
      const px = ctx.getImageData(0, 0, f.width, f.height);
      matteLumaToAlpha(px.data);
      ctx.putImageData(px, 0, 0);
      ready = true;
    },
    get: () => (ready ? (canvas as CanvasImageSource) : null),
    dispose: () => reader.dispose(),
  };
}

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
