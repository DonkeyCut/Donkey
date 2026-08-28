"use client";

import { sampleClipFrameData } from "../previewCanvas";
import { createRasterCanvas } from "../raster";
import type { MediaAsset, VideoClip } from "../types";
import { liveReader } from "../liveReader";

const SAMPLE_W = 96;
const SAMPLE_H = 54;

/** The median of a small frame readout's border pixels, where a backdrop
 * lives. */
function medianBorder(data: Uint8ClampedArray, w: number): string {
  const h = Math.round(data.length / 4 / w);
  const chans: number[][] = [[], [], []];
  const take = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) chans[c].push(data[i + c]);
  };
  for (let x = 0; x < w; x += 2) {
    take(x, 0);
    take(x, h - 1);
  }
  for (let y = 1; y < h - 1; y += 2) {
    take(0, y);
    take(w - 1, y);
  }
  const hex = chans
    .map((v) => {
      v.sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)].toString(16).padStart(2, "0");
    })
    .join("");
  return `#${hex}`;
}

/** The key color the clip's live preview frame suggests; null when no
 * decoder currently shows the clip (off the playhead, headless). */
export function suggestKeyColor(clipId: string): string | null {
  const data = sampleClipFrameData(clipId);
  return data ? medianBorder(data, SAMPLE_W) : null;
}

/** The key color read from the clip's own footage, decoded at its in-point —
 * for callers with no live decoder on the clip (the chat tool, a clip away
 * from the playhead). Null when the picture can't be read. */
export async function clipKeyColor(asset: MediaAsset, clip: VideoClip): Promise<string | null> {
  const reader = liveReader(asset);
  try {
    const frame = await reader.frameAt(asset.type === "image" ? 0 : Math.max(0, clip.in));
    if (frame.kind !== "ready") return null;
    const canvas = createRasterCanvas(SAMPLE_W, SAMPLE_H);
    const ctx = canvas.getContext("2d", {
      willReadFrequently: true,
    }) as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(frame.image, 0, 0, SAMPLE_W, SAMPLE_H);
    return medianBorder(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data, SAMPLE_W);
  } catch {
    return null;
  } finally {
    reader.dispose();
  }
}
