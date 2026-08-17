"use client";

import { framesAt } from "./mediaRead";
import { rasterCanvasToDataUrl } from "./raster";
import type { ClipSpan } from "./types";

// Sample the cut's picture for the visual-subtitles pipeline: a handful of
// small jpeg frames spread along video track 0, each stamped with its
// timeline time. Frames come off the same container reader the rest of Cut
// uses, so one pass over a file decodes every moment wanted from it and the
// sampler runs wherever the reader does.

export interface CapturedFrame {
  at: number;
  /** data:image/jpeg;base64,… */
  image: string;
}

const FRAME_W = 480;
const JPEG_Q = 0.72;
const MIN_FRAMES = 4;
const MAX_FRAMES = 20;
/** Aim for one frame every ~2.5s of timeline. */
const SECONDS_PER_FRAME = 2.5;

/** Read the given source times out of one file and stamp each result with the
 * timeline time it answers for. Times must ascend, which is what keeps this
 * to a single decode pass. An unreadable source yields nothing. */
async function readFrames(
  url: string,
  moments: { at: number; srcTime: number }[]
): Promise<CapturedFrame[]> {
  const out: CapturedFrame[] = [];
  try {
    let i = 0;
    for await (const frame of framesAt(
      url,
      moments.map((m) => m.srcTime),
      { width: FRAME_W }
    )) {
      const moment = moments[i++];
      if (!frame) continue;
      out.push({ at: moment.at, image: await rasterCanvasToDataUrl(frame.canvas, "image/jpeg", JPEG_Q) });
    }
  } catch {
    // One unreadable source yields the frames it managed, never an error:
    // the pipeline reads what it can see and writes captions for that.
  }
  return out;
}

/** Capture small stamped frames from one video file at the given times —
 * the dailies-review sampler. Times land in file seconds. */
export function captureVideoFrames(url: string, times: number[]): Promise<CapturedFrame[]> {
  const moments = [...times]
    .map((t) => Math.max(0, t))
    .sort((a, b) => a - b)
    .map((t) => ({ at: t, srcTime: t }));
  return readFrames(url, moments);
}

/** Capture timeline frames from video track 0's visible clips. */
export async function captureTimelineFrames(spans: ClipSpan[]): Promise<CapturedFrame[]> {
  const visible = spans.filter((sp) => !sp.clip.hidden);
  if (visible.length === 0) return [];
  const total = Math.max(...visible.map((sp) => sp.start + sp.len));
  const count = Math.min(
    MAX_FRAMES,
    Math.max(MIN_FRAMES, Math.round(total / SECONDS_PER_FRAME))
  );

  // Group the wanted moments by source file, so each file is opened once and
  // swept in order however the clips using it are laid out.
  const bySource = new Map<string, { url: string; moments: { at: number; srcTime: number }[] }>();
  for (let i = 0; i < count; i++) {
    const at = ((i + 0.5) * total) / count;
    const span = visible.find((sp) => at >= sp.start && at < sp.start + sp.len);
    if (!span) continue;
    const speed = span.clip.speed && span.clip.speed > 0 ? span.clip.speed : 1;
    const srcTime = Math.max(0, span.clip.in + (at - span.start) * speed);
    const group = bySource.get(span.asset.url) ?? { url: span.asset.url, moments: [] };
    group.moments.push({ at, srcTime });
    bySource.set(span.asset.url, group);
  }

  const frames: CapturedFrame[] = [];
  for (const group of bySource.values()) {
    group.moments.sort((a, b) => a.srcTime - b.srcTime);
    frames.push(...(await readFrames(group.url, group.moments)));
  }
  return frames.sort((a, b) => a.at - b.at);
}
