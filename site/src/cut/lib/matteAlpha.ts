/**
 * Baked mattes turned into alpha. A matte bakes as a luma video — white where
 * the subject is — and the compositor wants it as an alpha picture, so every
 * reader of a matte runs the same pixel pass: draw the frame, read it back,
 * move luma into alpha. The pass is a full read of the matte's pixels, and a
 * matte advances at its own baked rate (MATTE_FPS) below any output rate, so
 * the pass runs once per matte frame and every draw in between reuses it.
 */

import { matteLumaToAlpha, MATTE_FPS, type ClipRemoval } from "@donkeycut/effects-kit";
import { liveReader } from "./liveReader";
import { createRasterCanvas, type RasterSurface } from "./raster";
import type { MediaAsset } from "./types";

type Matte = NonNullable<ClipRemoval["matte"]>;

/** A decoded matte frame, as any reader hands it over. */
interface MatteFrame {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** Which baked matte frame source time `mt` falls in — equal stamps are the
 * same pixels. */
export const matteStamp = (assetId: string, mt: number): string =>
  `${assetId}:${Math.floor(mt * MATTE_FPS)}`;

/** One matte's alpha picture, held on a single surface and converted only
 * when the frame's stamp moves. */
export class MatteAlpha {
  private surface: RasterSurface | null = null;
  private stamp: string | null = null;

  /** The picture of `stamp` when it is the one already converted. */
  held(stamp: string): CanvasImageSource | null {
    return this.surface && this.stamp === stamp ? (this.surface as CanvasImageSource) : null;
  }

  /** `frame`'s alpha picture, converted unless `stamp` is already held. */
  of(frame: MatteFrame, stamp: string): CanvasImageSource | null {
    const held = this.held(stamp);
    if (held) return held;
    const s = this.surface ?? (this.surface = createRasterCanvas(frame.width, frame.height));
    if (s.width !== frame.width) s.width = frame.width;
    if (s.height !== frame.height) s.height = frame.height;
    const ctx = s.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.clearRect(0, 0, s.width, s.height);
    ctx.drawImage(frame.image, 0, 0, s.width, s.height);
    const px = ctx.getImageData(0, 0, s.width, s.height);
    matteLumaToAlpha(px.data);
    ctx.putImageData(px, 0, 0);
    this.stamp = stamp;
    return s as CanvasImageSource;
  }
}

/** One baked matte read alongside a clip in an export pass: `stage` before
 * each output frame, then `get` reads the alpha picture for that frame. A
 * stamp already converted skips both the read and the pixel pass. Null when
 * there is no matte or its asset is gone. */
export function matteStage(m: Matte | undefined, assets: MediaAsset[]) {
  const asset = m ? assets.find((a) => a.id === m.assetId) : undefined;
  if (!m || !asset) return null;
  const reader = liveReader(asset);
  const alpha = new MatteAlpha();
  const dur = Math.max(0.1, asset.duration || 0.1);
  let ready: CanvasImageSource | null = null;
  return {
    async stage(srcT: number) {
      const mt = Math.min(Math.max(0, srcT - m.in), dur - 0.001);
      const stamp = matteStamp(m.assetId, mt);
      ready = alpha.held(stamp);
      if (ready) return;
      const f = await reader.frameAt(mt);
      ready = f.kind === "ready" ? alpha.of(f, stamp) : null;
    },
    get: () => ready,
    dispose: () => reader.dispose(),
  };
}
