"use client";

/**
 * One canvas-fed H.264 encode — the ceremony behind every baked video the
 * removal suite writes: mattes, tracker segments, keyed layers. The caller
 * draws each frame onto `canvas` and calls `add`; `finish` closes the stream
 * and hands back the file. Throws when no encoder or drawing surface is
 * available.
 */

import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  Quality,
} from "mediabunny";
import { VIDEO_CODECS } from "./exportRender";
import { createRasterCanvas, type RasterSurface } from "./raster";

export interface CanvasVideoEncoder {
  canvas: RasterSurface;
  ctx: CanvasRenderingContext2D;
  /** Stage the canvas as the frame at `t` seconds, held for `dur` seconds. */
  add(t: number, dur: number): Promise<void>;
  /** Close the stream and hand back the file. */
  finish(): Promise<Blob>;
  /** Abandon the encode (a cancelled bake). */
  cancel(): Promise<void>;
}

export async function openCanvasVideo(opts: {
  width: number;
  height: number;
  fps: number;
  frames: number;
  bitrate: number;
  /** The frame loop reads pixels back off the canvas. */
  readback?: boolean;
}): Promise<CanvasVideoEncoder> {
  const codec = await getFirstEncodableVideoCodec(VIDEO_CODECS, {
    width: opts.width,
    height: opts.height,
  });
  if (!codec) throw new Error("No video encoder is available.");
  const canvas = createRasterCanvas(opts.width, opts.height);
  const ctx = canvas.getContext(
    "2d",
    opts.readback ? { willReadFrequently: true } : undefined
  ) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("No drawing surface for the encode.");
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new CanvasSource(canvas as HTMLCanvasElement, {
    codec,
    quality: new Quality({ bitrate: opts.bitrate }),
  });
  output.addVideoTrack(source, {
    frameRate: opts.fps,
    maximumPacketCount: opts.frames + 8,
  });
  await output.start();
  return {
    canvas,
    ctx,
    add: (t, dur) => source.add(t, dur),
    finish: async () => {
      await output.finalize();
      const buffer = target.buffer;
      if (!buffer) throw new Error("The encode produced nothing.");
      return new Blob([buffer], { type: "video/mp4" });
    },
    cancel: () => output.cancel().catch(() => {}),
  };
}

/** Even-dimensioned frame size for a source scaled down to `maxShort` on its
 * short side — even because the encoder's 4:2:0 subsampling needs it, capped
 * at 1 so a small source keeps its size. */
export function scaledEvenSize(
  srcW: number,
  srcH: number,
  maxShort: number
): { w: number; h: number } {
  const scale = Math.min(1, maxShort / Math.max(1, Math.min(srcW, srcH)));
  return {
    w: Math.max(2, Math.round((srcW * scale) / 2) * 2),
    h: Math.max(2, Math.round((srcH * scale) / 2) * 2),
  };
}
