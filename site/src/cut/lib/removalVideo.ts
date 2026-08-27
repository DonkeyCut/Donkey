"use client";

/**
 * Removal pieces for the ffmpeg export: each removal clip ships its keyed
 * layer as two client-rendered, segment-aligned videos — the color (grade and
 * key and stroke ink and backdrop baked, straight alpha colors) and the alpha
 * as luma. The frames come out of the compositor's own removal stage, so the
 * engine composites the very pixels the preview draws; the graph just merges
 * the pair and frames it like any other picture. H.264 carries no alpha
 * channel, which is why the layer travels as a pair.
 */

import { matteLumaToAlpha } from "@donkeycut/effects-kit";
import { openCanvasVideo, scaledEvenSize } from "./canvasVideo";
import { FrameCompositor, type Frame } from "./composite";
import { ClipReader } from "./exportRender";
import { createRasterCanvas, decodeRasterImageUrl, type RasterSurface } from "./raster";
import { clipSpeed } from "./store";
import type { MediaAsset, VideoClip } from "./types";

export interface RemovalPieces {
  rgb: Blob;
  alpha: Blob;
}

/** Straight-alpha colors survive a getImageData round trip; premultiplied
 * draws would darken every soft edge once the engine re-applies the alpha. */
function splitFrame(
  layer: CanvasImageSource,
  lw: number,
  lh: number,
  read: { surface: RasterSurface; ctx: CanvasRenderingContext2D },
  a: ImageData,
  rgb: CanvasRenderingContext2D,
  alpha: CanvasRenderingContext2D,
  w: number,
  h: number
) {
  read.ctx.clearRect(0, 0, w, h);
  read.ctx.drawImage(layer, 0, 0, lw, lh, 0, 0, w, h);
  const px = read.ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < px.data.length; i += 4) {
    const v = px.data[i + 3];
    a.data[i] = v;
    a.data[i + 1] = v;
    a.data[i + 2] = v;
    a.data[i + 3] = 255;
    px.data[i + 3] = 255;
  }
  rgb.putImageData(px, 0, 0);
  alpha.putImageData(a, 0, 0);
}

/**
 * Render one removal clip's keyed layer over its segment: `fps` frames per
 * second for the segment's exact play length, sized to `maxShort` on the
 * short side. AI modes read the baked matte asset; without one the export
 * shows the plain picture, the preview's own degrade, so the two never
 * disagree about a clip whose bake hasn't run. `bakeLook` folds the clip's
 * look color pass into the pixels (overlay tracks, where the engine applies
 * no look to an alpha layer); track 0 leaves it out and the engine grades the
 * flattened segment. Null when the removal cannot draw here.
 */
export async function renderRemovalPieces(
  asset: MediaAsset,
  clip: VideoClip,
  assets: MediaAsset[],
  opts: { fps: number; maxShort: number; bakeLook: boolean }
): Promise<RemovalPieces | null> {
  const r = clip.removal;
  if (!r) return null;
  const matteAsset = r.matte ? assets.find((a) => a.id === r.matte!.assetId) : undefined;
  const ai = r.mode === "auto" || r.mode === "custom";
  if (ai && !matteAsset) return null;

  const speed = clipSpeed(clip);
  const still = asset.type === "image";
  const dur = Math.max(0.1, (clip.out - clip.in) / speed);
  const frames = Math.max(1, Math.ceil(dur * opts.fps));
  const baked = clip.removal!.matte;

  const reader = new ClipReader(asset, () => asset.url);
  const matteReader = matteAsset ? new ClipReader(matteAsset, () => matteAsset.url) : null;
  try {
    const first = await reader.frameAt(still ? 0 : clip.in);
    if (first.kind !== "ready") throw new Error("The removal clip's picture could not be read.");
    const { w, h } = scaledEvenSize(first.width, first.height, opts.maxShort);
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
    const rgbCtx = rgbOut.ctx;
    const alphaCtx = alphaOut.ctx;
    const readSurface = createRasterCanvas(w, h);
    const readCtx = readSurface.getContext("2d", {
      willReadFrequently: true,
    }) as CanvasRenderingContext2D | null;
    if (!readCtx) throw new Error("No drawing surface for the removal layer.");

    // The compositor renders the layer with the preview's own code; its
    // drawing canvas never draws, the scratches do the work.
    const comp = new FrameCompositor(createRasterCanvas(2, 2));
    const bakeClip = opts.bakeLook ? clip : { ...clip, look: undefined };
    const matteFrame = createRasterCanvas(2, 2);
    // The alpha plane's staging buffer, rewritten whole every frame.
    const alphaPlane = new ImageData(w, h);
    const backdrops = new Map<string, CanvasImageSource | null>();
    if (r.backdrop?.kind === "image" && r.backdrop.assetId) {
      const bd = assets.find((a) => a.id === r.backdrop!.assetId);
      const img = bd ? await decodeRasterImageUrl(bd.url).catch(() => null) : null;
      backdrops.set(r.backdrop.assetId, img ? img.source : null);
    }
    comp.backdropImageProvider = (assetId) => backdrops.get(assetId) ?? null;
    let matteReady: Frame | null = null;
    comp.removalMatteProvider = () => {
      if (matteReady?.kind !== "ready") return null;
      // Luma to alpha, once per staged frame.
      const mw = matteReady.width;
      const mh = matteReady.height;
      if (matteFrame.width !== mw || matteFrame.height !== mh) {
        matteFrame.width = mw;
        matteFrame.height = mh;
      }
      const mctx = matteFrame.getContext("2d", {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D;
      mctx.drawImage(matteReady.image, 0, 0);
      const mpx = mctx.getImageData(0, 0, mw, mh);
      matteLumaToAlpha(mpx.data);
      mctx.putImageData(mpx, 0, 0);
      return matteFrame as CanvasImageSource;
    };

    for (let i = 0; i < frames; i++) {
      const s = Math.min(dur - 1 / (opts.fps * 2), i / opts.fps);
      const srcT = still ? 0 : clip.in + s * speed;
      const frame = await reader.frameAt(srcT);
      if (frame.kind !== "ready") {
        rgbCtx.fillStyle = "#000000";
        rgbCtx.fillRect(0, 0, w, h);
        alphaCtx.fillStyle = "#000000";
        alphaCtx.fillRect(0, 0, w, h);
      } else {
        matteReady = null;
        if (matteReader && baked) {
          const mdur = Math.max(0.1, matteAsset!.duration || 0.1);
          const mt = Math.min(Math.max(0, srcT - baked.in), mdur - 0.001);
          matteReady = await matteReader.frameAt(mt);
        }
        const layer = comp.removedLayer(frame, bakeClip, clip.start + s, {
          bakeLookPost: opts.bakeLook,
        });
        splitFrame(layer, frame.width, frame.height, { surface: readSurface, ctx: readCtx }, alphaPlane, rgbCtx, alphaCtx, w, h);
      }
      await rgbOut.add(i / opts.fps, 1 / opts.fps);
      await alphaOut.add(i / opts.fps, 1 / opts.fps);
    }
    return { rgb: await rgbOut.finish(), alpha: await alphaOut.finish() };
  } finally {
    reader.dispose();
    matteReader?.dispose();
  }
}
