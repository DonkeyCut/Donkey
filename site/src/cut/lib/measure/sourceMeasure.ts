/** Measurements of a source's own pixels at source seconds — the numbers a
 * replica is built from: every hard cut to its frame, the colour of a region,
 * and the box an element fills frame by frame with the ease of each move.
 * Frames come through the same base-rendering sink the watch and the colour
 * reads use, so a log or HDR source measures as the preview shows it. */

import { baseFrameSink, colorReadAt } from "../baseFrame";
import { openMedia, UnreadableMediaError, videoTrackOf, type FrameSize } from "../mediaRead";
import { createRasterCanvas, decodeRasterImageUrl } from "../raster";
import type { WrappedCanvas } from "mediabunny";
import { hexOf, regionColor, parseHex, type PixelRect, type Pixels, type Rgb } from "./color";
import { changePct, gridMeans, pickCuts } from "./cuts";
import { fitMoves, type Move } from "./easeFit";
import { inkBox, shapeBox } from "./track";

/** A box as the editor places one: centre and size, frame fractions. */
export interface FrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every frame of a cut scan is this small: a cut changes the whole picture,
 * and 64² holds the 16-grid the scorer reads at four pixels a cell. */
const SCAN_SIZE: FrameSize = { width: 64, height: 64, fit: "fill" };
/** Long side colours are read at: a 1080p source's own pixels. */
const COLOR_LONG_SIDE = 1920;
/** Long side elements are tracked at: a pixel is 0.14% of the frame. */
const TRACK_LONG_SIDE = 720;
/** Reads a pass back off by this much so the frame on `from` is scored. */
const LEAD_S = 0.001;

/** An open video source: its display size, first timestamp and frame reads. */
interface SourceVideo {
  width: number;
  height: number;
  first: number;
  frames(from: number, to: number, size: FrameSize): AsyncGenerator<SourceFrame>;
  framesAt(times: number[], size: FrameSize): AsyncGenerator<SourceFrame | null>;
}

interface SourceFrame extends Pixels {
  t: number;
  duration: number;
}

function pixelsOf(w: WrappedCanvas): SourceFrame {
  const canvas = w.canvas;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Could not read the frame's pixels.");
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: image.data, width: image.width, height: image.height, t: w.timestamp, duration: w.duration };
}

/** Open `url`'s video track for the length of `fn`, closing it after. */
async function withSourceVideo<T>(url: string, fn: (v: SourceVideo) => Promise<T>): Promise<T> {
  const input = openMedia(url);
  try {
    const track = await videoTrackOf(input);
    if (!track) throw new UnreadableMediaError("This file has no readable video.");
    const reading = colorReadAt(url);
    const width = await track.getDisplayWidth();
    const height = await track.getDisplayHeight();
    const first = await track.getFirstTimestamp().catch(() => 0);
    return await fn({
      width,
      height,
      first,
      frames: async function* (from, to, size) {
        // A small pool: each frame is read and dropped before the next.
        for await (const w of baseFrameSink(track, size, reading, { poolSize: 2 }).canvases(from, to)) yield pixelsOf(w);
      },
      framesAt: async function* (times, size) {
        for await (const w of baseFrameSink(track, size, reading).canvasesAtTimestamps(times)) yield w ? pixelsOf(w) : null;
      },
    });
  } finally {
    input.dispose();
  }
}

/** A picture's pixels at `longSide`, for a still asset. */
async function imagePixels(url: string, longSide: number): Promise<Pixels> {
  const img = await decodeRasterImageUrl(url);
  if (!img || !img.width || !img.height) throw new Error("Could not read the image.");
  const k = Math.min(1, longSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const canvas = createRasterCanvas(w, h);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Could not read the image.");
  ctx.drawImage(img.source, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  return { data: image.data, width: w, height: h };
}

/** The read size for a source at `longSide`, never past its own pixels. */
function sizeAt(width: number, height: number, longSide: number): FrameSize {
  const k = Math.min(1, longSide / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), fit: "fill" };
}

/** A centre-and-size box in frame fractions, as pixels of `px`. */
const toPixels = (px: Pixels, b: FrameBox): PixelRect => ({
  x: (b.x - b.w / 2) * px.width,
  y: (b.y - b.h / 2) * px.height,
  w: Math.max(1, b.w * px.width),
  h: Math.max(1, b.h * px.height),
});

/** A pixel box as centre-and-size frame fractions. */
const toFrame = (px: { width: number; height: number }, r: PixelRect): FrameBox => ({
  x: (r.x + r.w / 2) / px.width,
  y: (r.y + r.h / 2) / px.height,
  w: r.w / px.width,
  h: r.h / px.height,
});

/** The frame rate a run of decoded frames plays at: the median frame
 * duration, or the median gap between timestamps when durations are absent. */
function rateOf(times: number[], durations: number[]): number {
  const steps = durations.filter((d) => d > 0);
  const gaps = steps.length > 0 ? steps : times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0);
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return 1 / gaps[Math.floor(gaps.length / 2)];
}

export interface CutScan {
  fps: number;
  frames: number;
  cuts: { t: number; frame: number; change: number }[];
  coveredTo: number;
  truncated: boolean;
}

/** Every hard cut in [from, to) of a video, found by scoring every frame
 * against the one before it. A pass stops at `maxCuts` or at the time
 * budget, and `coveredTo` says where the next pass picks up. */
export async function scanCuts(
  url: string,
  opts: { from: number; to: number; maxCuts: number; budgetMs: number }
): Promise<CutScan> {
  return withSourceVideo(url, async (v) => {
    const deadline = Date.now() + opts.budgetMs;
    const times: number[] = [];
    const durations: number[] = [];
    const scores: number[] = [];
    let prev: Float32Array | null = null;
    let outOfTime = false;
    for await (const f of v.frames(Math.max(0, opts.from - LEAD_S), opts.to, SCAN_SIZE)) {
      if (Date.now() > deadline) {
        outOfTime = true;
        break;
      }
      const grid = gridMeans(f);
      scores.push(prev ? changePct(prev, grid) : NaN);
      times.push(f.t);
      durations.push(f.duration);
      prev = grid;
    }
    if (times.length === 0) throw new Error("Could not read any frames in that span.");

    const fps = rateOf(times, durations);
    const picked = pickCuts(scores);
    const kept = picked.slice(0, opts.maxCuts);
    const capped = picked.length > kept.length;
    // A capped pass ends on the frame before the first cut it leaves out, so
    // the next pass scores that cut against it.
    const coveredTo = capped ? times[picked[kept.length] - 1] : outOfTime ? times[times.length - 1] : opts.to;
    return {
      fps,
      frames: times.length,
      cuts: kept.map((i) => ({
        t: times[i],
        frame: fps > 0 ? Math.round((times[i] - v.first) * fps) : i,
        change: Math.round(scores[i]),
      })),
      coveredTo,
      truncated: capped || outOfTime,
    };
  });
}

export interface ColorSample {
  t: number;
  box: FrameBox;
}

/** The colour of each sample's region at its moment, read in one ordered
 * pass over the source. `k` ≥ 2 adds the k colours each region is made of. */
export async function sampleColors(
  url: string,
  kind: "video" | "image",
  samples: ColorSample[],
  k: number
): Promise<ReturnType<typeof regionColor>[]> {
  if (kind === "image") {
    const px = await imagePixels(url, COLOR_LONG_SIDE);
    return samples.map((s) => regionColor(px, toPixels(px, s.box), k));
  }
  const times = [...new Set(samples.map((s) => s.t))].sort((a, b) => a - b);
  return withSourceVideo(url, async (v) => {
    const size = sizeAt(v.width, v.height, COLOR_LONG_SIDE);
    const out = new Array<ReturnType<typeof regionColor>>(samples.length);
    let at = 0;
    for await (const f of v.framesAt(times, size)) {
      const t = times[at++];
      if (!f) throw new Error(`Could not read the frame at ${t}s.`);
      samples.forEach((s, i) => {
        if (s.t === t) out[i] = regionColor(f, toPixels(f, s.box), k);
      });
    }
    return out;
  });
}

export type TrackMatch = "shape" | "ink";

export interface TrackRun {
  color: string;
  fps: number;
  /** Per frame read: its time and the element's box, or null where absent. */
  boxes: { t: number; box: FrameBox | null }[];
  moves: (Move & { prop: keyof FrameBox })[];
  coveredTo: number;
  truncated: boolean;
}

/** The box an element fills in every frame of [from, to) — one frame at
 * `from` when `to` is absent — and the moves of its centre and size, each
 * fitted with an ease. The element is the piece of `color` the seed points
 * at ("shape"), or every pixel of it inside the seed ("ink"); with no colour
 * the seed's own median colour on the first frame is the element's. */
export async function trackElement(
  url: string,
  kind: "video" | "image",
  opts: {
    from: number;
    to?: number;
    seed: FrameBox;
    within?: FrameBox;
    color?: string;
    tolerance: number;
    match: TrackMatch;
    maxFrames: number;
  }
): Promise<TrackRun> {
  let truncated = false;
  let coveredTo = opts.to ?? opts.from;

  // The element's box in each frame, carried forward as the next one's seed.
  let target: Rgb | null = opts.color ? parseHex(opts.color) : null;
  let near: PixelRect | null = null;
  const boxes: TrackRun["boxes"] = [];
  const read = (t: number, px: Pixels) => {
    const seed = toPixels(px, opts.seed);
    if (!target) target = parseHex(regionColor(px, seed).hex)!;
    const area = opts.within ? toPixels(px, opts.within) : opts.match === "ink" ? seed : { x: 0, y: 0, w: px.width, h: px.height };
    const found =
      opts.match === "ink"
        ? inkBox(px, target, opts.tolerance, area)
        : (shapeBox(px, target, opts.tolerance, area, near ?? seed) ??
          (near ? shapeBox(px, target, opts.tolerance, area, seed) : null));
    if (found) near = found;
    boxes.push({ t, box: found ? toFrame(px, found) : null });
  };

  let size = { width: 1, height: 1 };
  const times: number[] = [];
  const durations: number[] = [];
  if (kind === "image") {
    const px = await imagePixels(url, TRACK_LONG_SIDE);
    size = px;
    read(0, px);
  } else {
    await withSourceVideo(url, async (v) => {
      const at = sizeAt(v.width, v.height, TRACK_LONG_SIDE);
      size = { width: at.width!, height: at.height! };
      if (opts.to === undefined || opts.to <= opts.from) {
        for await (const f of v.framesAt([opts.from], at)) {
          if (!f) throw new Error(`Could not read the frame at ${opts.from}s.`);
          read(opts.from, f);
        }
        return;
      }
      for await (const f of v.frames(opts.from, opts.to, at)) {
        if (times.length >= opts.maxFrames) {
          truncated = true;
          coveredTo = times[times.length - 1];
          break;
        }
        times.push(f.t);
        durations.push(f.duration);
        read(f.t, f);
      }
    });
  }

  // Each of the four numbers fitted on its own: a grow moves w and h, a
  // slide moves x or y, and one fit per number keys each the way it moved.
  const moves: TrackRun["moves"] = [];
  if (boxes.length > 2) {
    const ts = boxes.map((b) => b.t);
    for (const prop of ["x", "y", "w", "h"] as const) {
      const step = 1 / (prop === "x" || prop === "w" ? size.width : size.height);
      for (const m of fitMoves(ts, boxes.map((b) => (b.box ? b.box[prop] : null)), step)) moves.push({ ...m, prop });
    }
    moves.sort((a, b) => a.from - b.from);
  }
  const rgb = target as Rgb | null;
  return {
    color: rgb ? hexOf(...rgb) : "",
    fps: rateOf(times, durations),
    boxes,
    moves,
    coveredTo,
    truncated,
  };
}
