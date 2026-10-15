import { renderProjectFrames } from "./exportRender";
import { bestShift, diffPixels, meanDiff, runShift, SCORE_LONG_SIDE, SWEEP_TARGET, sweepStats, worstStretches } from "./frameDiff";
import { composeComparison, makeStillFrame } from "./media";
import { framesAt } from "./mediaRead";
import { createRasterCanvas, decodeRasterImageUrl, rasterCanvasToDataUrl } from "./raster";
import type { ExportDoc } from "./renderSnapshot";
import { clipLen } from "./store";
import { DEFAULT_BACKGROUND, frameOf, type MediaAsset } from "./types";

// Holding a replica up against the video it copies, as pictures and as
// numbers. The pictures are for the eye; the numbers say how far off each
// frame is, where in the frame, and whether the difference is the right thing
// a few frames early or late. A sweep is the same score run over a whole
// stretch of the cut, so the model can find what is off before it looks.

/** Long side of each frame in a comparison picture. */
const COMPARE_LONG_SIDE = 480;

/** Long side a sweep renders at, twice the score's: titles drawn at this size
 * and shrunk read the way the picture call's do. */
const SWEEP_LONG_SIDE = SCORE_LONG_SIDE * 2;

/** One frame of the cut, the step a sweep never goes under. */
const FRAME = 1 / 30;

/** How many frames either side of a moment the timing read looks. */
const SHIFT_REACH = 3;

/** The most samples one sweep scores; a longer span widens its step. */
const MAX_SWEEP_SAMPLES = 900;

/** How long a sweep scores before it hands back what it has, inside the
 * bridge's two-minute deadline with room for the reply. */
const SWEEP_BUDGET_MS = 60_000;

/** How many of a sweep's worst stretches come back. */
const MAX_STRETCHES = 5;

/** Aspect ratios this close draw edge to edge; anything further letterboxes. */
const ASPECT_SLACK = 0.01;

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A frame size with the cut's shape and the given long side. */
function sizeOf(doc: ExportDoc, longSide: number): { width: number; height: number } {
  const frame = frameOf(doc.aspect);
  const k = longSide / Math.max(frame.w, frame.h);
  return { width: Math.max(1, Math.round(frame.w * k)), height: Math.max(1, Math.round(frame.h * k)) };
}

/** The label of the block standing in for footage at `t`, if one is. */
function blockAt(doc: ExportDoc, t: number): string | undefined {
  for (const c of doc.clips) {
    if (t < c.start || t >= c.start + clipLen(c)) {
      continue;
    }
    const asset = doc.assets.find((a) => a.id === c.assetId);
    if (asset?.origin === "block") {
      return asset.block?.label || asset.name;
    }
  }
  return undefined;
}

/**
 * Reads any frame down to the score's size, in the cut's shape. A source of
 * another shape is letterboxed into it over the cut's background, the way a
 * clip of that shape would sit on the timeline, and the scorer remembers it
 * did so the result can say so.
 */
function makeScorer(doc: ExportDoc) {
  const size = sizeOf(doc, SCORE_LONG_SIDE);
  const canvas = createRasterCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error("No 2d context to score frames on.");
  }
  ctx.imageSmoothingQuality = "high";
  let letterboxed: { w: number; h: number } | undefined;
  return {
    // Held here so the surface lives as long as its context: a server
    // canvas's context keeps only a weak hold on it.
    canvas,
    size,
    get letterboxed() {
      return letterboxed;
    },
    pixels(source: CanvasImageSource, w: number, h: number): Uint8ClampedArray {
      ctx.fillStyle = doc.background ?? DEFAULT_BACKGROUND;
      ctx.fillRect(0, 0, size.width, size.height);
      if (Math.abs(w / h / (size.width / size.height) - 1) <= ASPECT_SLACK) {
        ctx.drawImage(source, 0, 0, size.width, size.height);
      } else {
        letterboxed = { w, h };
        const k = Math.min(size.width / w, size.height / h);
        const dw = w * k;
        const dh = h * k;
        ctx.drawImage(source, (size.width - dw) / 2, (size.height - dh) / 2, dw, dh);
      }
      return ctx.getImageData(0, 0, size.width, size.height).data;
    },
  };
}

/** The line a result carries when the source was letterboxed to score it. */
function frameNote(doc: ExportDoc, shape: { w: number; h: number } | undefined): string | undefined {
  if (!shape) {
    return undefined;
  }
  return (
    `The source's frame is ${round1(shape.w / shape.h)}:1 and the cut's is ${doc.aspect}, so scores read the source letterboxed into the cut's frame over its background. ` +
    "Bars the cut does not have count as difference; set_aspect to the source's shape when the copy should match it."
  );
}

/** A still source's one frame, as the scorer reads it. */
async function stillPixels(asset: MediaAsset, scorer: ReturnType<typeof makeScorer>) {
  const still = await makeStillFrame(asset.url, "read");
  const img = await decodeRasterImageUrl(still.frames[0].image);
  if (!img) {
    throw new Error(`Could not read "${asset.name}".`);
  }
  return { image: still.frames[0].image, pixels: scorer.pixels(img.source, img.width, img.height) };
}

/** One moment checked: where it was read on each clock, the score, the grid,
 * and the timing read when there is one. */
type Checked = { at: number; source: number; diff: number; grid: number[][]; shift?: number; block?: string };

/**
 * The picture call: each moment rendered, its source frame read, both put
 * side by side in one picture and scored. Every source frame within
 * SHIFT_REACH frames of a moment comes along in the same decode pass, so a
 * frame that is right but early or late says by how much.
 */
export async function compareMoments(
  doc: ExportDoc,
  asset: MediaAsset,
  moments: { at: number; sourceAt: number }[],
  total: number
): Promise<{ images: string[]; checked: Checked[]; frame?: string }> {
  const size = sizeOf(doc, COMPARE_LONG_SIDE);
  const scorer = makeScorer(doc);
  const wanted = moments.map((m) => ({
    at: clamp(m.at, 0, Math.max(0, total - 0.001)),
    sourceAt: clamp(m.sourceAt, 0, Math.max(0, asset.duration - 0.001)),
  }));

  // Every source second this call needs, keyed to the millisecond: each
  // moment's own and its neighbours', read in one pass in play order.
  const key = (t: number) => Math.round(t * 1000);
  const timeAt = (m: { sourceAt: number }, k: number) => clamp(m.sourceAt + k * FRAME, 0, Math.max(0, asset.duration - 0.001));
  const centers = new Set(wanted.map((m) => key(m.sourceAt)));
  const pixels = new Map<number, Uint8ClampedArray>();
  const pictures = new Map<number, string>();
  if (asset.type === "image") {
    const still = await stillPixels(asset, scorer);
    for (const m of wanted) {
      pixels.set(key(m.sourceAt), still.pixels);
      pictures.set(key(m.sourceAt), still.image);
    }
  } else {
    const times = [...new Set(wanted.flatMap((m) => Array.from({ length: SHIFT_REACH * 2 + 1 }, (_, i) => key(timeAt(m, i - SHIFT_REACH)))))]
      .sort((a, b) => a - b)
      .map((k) => k / 1000);
    // The source keeps its own aspect: a height alone lets a widescreen
    // reference stay widescreen beside a vertical cut, which is half of what
    // the comparison is for. Asking for both dimensions squashes it.
    let seen = 0;
    for await (const c of framesAt(asset.url, times, { height: size.height })) {
      const k = key(times[seen++]);
      if (!c) {
        continue;
      }
      pixels.set(k, scorer.pixels(c.canvas, c.canvas.width, c.canvas.height));
      if (centers.has(k)) {
        pictures.set(k, await rasterCanvasToDataUrl(c.canvas, "image/jpeg", 0.82));
      }
    }
  }
  for (const m of wanted) {
    if (!pictures.has(key(m.sourceAt))) {
      throw new Error(`Could not read "${asset.name}" at ${Math.round(m.sourceAt * 100) / 100}s.`);
    }
  }

  // One prepared painter for every moment: preparing stamps every title
  // and may bring up the segmenter, and the document does not change
  // between them. Each frame is scored before the next overwrites it.
  const pairs: { t: number; sourceAt: number; source: string; cut: string }[] = [];
  const checked: Checked[] = [];
  await renderProjectFrames(doc, wanted.map((m) => m.at), size, (a) => a.url, async (canvas, at) => {
    const m = wanted[pairs.length];
    const cut = scorer.pixels(canvas, canvas.width, canvas.height);
    const { diff, grid } = diffPixels(cut, pixels.get(key(m.sourceAt))!, scorer.size.width, scorer.size.height);
    const near: { shift: number; diff: number }[] = [];
    for (let k = -SHIFT_REACH; k <= SHIFT_REACH; k++) {
      const t = timeAt(m, k);
      const px = pixels.get(key(t));
      if (k === 0 || !px || key(t) === key(m.sourceAt)) {
        continue;
      }
      near.push({ shift: round3(t - m.sourceAt), diff: round1(meanDiff(cut, px)) });
    }
    const shift = bestShift(diff, near)?.shift;
    const block = blockAt(doc, at);
    checked.push({
      at: round3(at),
      source: Math.round(m.sourceAt * 100) / 100,
      diff: round1(diff),
      grid,
      ...(shift !== undefined ? { shift } : {}),
      ...(block ? { block } : {}),
    });
    pairs.push({
      t: round3(at),
      sourceAt: Math.round(m.sourceAt * 100) / 100,
      source: pictures.get(key(m.sourceAt))!,
      cut: await rasterCanvasToDataUrl(canvas, "image/jpeg", 0.82),
    });
  });
  const images = await composeComparison(pairs);
  const frame = frameNote(doc, scorer.letterboxed);
  return { images, checked, ...(frame ? { frame } : {}) };
}

/** Thrown inside the render loop when a sweep's time is up. */
class SweepOutOfTime extends Error {}

/** One stretch of a sweep worth a look. */
type Stretch = {
  from: number;
  to: number;
  diff: number;
  peak: number;
  at: number;
  source: number;
  grid: number[][];
  shift?: number;
  block?: string;
};

export type SweepResult = {
  mode: "sweep";
  from: number;
  to: number;
  step: number;
  offset: number;
  sampled: number;
  coveredTo?: number;
  median: number;
  p95: number;
  max: number;
  target: number;
  worst: Stretch[];
  timing?: { shift: number; diff: number };
  onBlocks?: number;
  frame?: string;
};

/**
 * The sweep: the cut scored against the source at every step of a span, with
 * the source read at a constant offset, and no pictures. The source is read
 * in one pass in lockstep with the render, and each cut frame is also scored
 * against the source samples SHIFT_REACH steps either side, so a stretch that
 * is right but late says how late.
 */
export async function sweepSource(
  doc: ExportDoc,
  asset: MediaAsset,
  span: { from: number; to: number; step?: number; offset: number },
  total: number
): Promise<SweepResult> {
  const from = clamp(span.from, 0, total);
  const to = clamp(span.to, from, total);
  const step = Math.max(FRAME, span.step ?? FRAME, (to - from) / MAX_SWEEP_SAMPLES);

  // The samples, kept to those whose source second is inside the source: a
  // constant offset makes them one unbroken run.
  const count = Math.ceil((to - from) / step - 1e-6);
  const samples: { at: number; source: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = round3(from + i * step);
    const source = round3(at + span.offset);
    if (source >= 0 && source < asset.duration) {
      samples.push({ at, source });
    }
  }
  if (samples.length === 0) {
    throw new Error(
      `No second of ${round3(from)}-${round3(to)}s lands inside "${asset.name}" (0-${round3(asset.duration)}s) at offset ${span.offset}s. ` +
        "The offset is the source second minus the timeline second; pass one that puts the span inside the source."
    );
  }

  const size = sizeOf(doc, SWEEP_LONG_SIDE);
  const scorer = makeScorer(doc);
  const width = SHIFT_REACH * 2 + 1;
  const near = new Float32Array(samples.length * width).fill(NaN);
  const diffs: number[] = [];
  const grids: number[][][] = [];
  const cuts = new Map<number, Uint8ClampedArray>();
  const sources = new Map<number, Uint8ClampedArray | null>();

  // The source side: a still answers every sample with its one frame; a
  // video is pulled a frame at a time, in step with the render.
  const still = asset.type === "image" ? (await stillPixels(asset, scorer)).pixels : null;
  const reader = still ? null : framesAt(asset.url, samples.map((s) => s.source), { height: size.height });
  const started = performance.now();
  try {
    await renderProjectFrames(doc, samples.map((s) => s.at), size, (a) => a.url, async (canvas) => {
      const j = diffs.length;
      if (j > 0 && performance.now() - started > SWEEP_BUDGET_MS) {
        throw new SweepOutOfTime();
      }
      let src = still;
      if (reader) {
        const next = await reader.next();
        const c = next.done ? null : next.value;
        src = c ? scorer.pixels(c.canvas, c.canvas.width, c.canvas.height) : null;
      }
      const cut = scorer.pixels(canvas, canvas.width, canvas.height);

      // The sample's own score, then the timing read: this cut frame against
      // the source samples before it, and the cut frames before it against
      // this source sample. Only the last SHIFT_REACH of each are kept.
      const own = src ? diffPixels(cut, src, scorer.size.width, scorer.size.height) : { diff: NaN, grid: [] };
      diffs.push(own.diff);
      grids.push(own.grid);
      near[j * width + SHIFT_REACH] = own.diff;
      for (let k = 1; k <= SHIFT_REACH && !still; k++) {
        const back = sources.get(j - k);
        if (back) {
          near[j * width + SHIFT_REACH - k] = meanDiff(cut, back);
        }
        const before = cuts.get(j - k);
        if (src && before) {
          near[(j - k) * width + SHIFT_REACH + k] = meanDiff(before, src);
        }
      }
      cuts.set(j, cut);
      sources.set(j, src);
      cuts.delete(j - SHIFT_REACH);
      sources.delete(j - SHIFT_REACH);
    });
  } catch (e) {
    if (!(e instanceof SweepOutOfTime)) {
      throw e;
    }
  } finally {
    await reader?.return(undefined);
  }

  // What was scored: a sample the source had no frame for drops out.
  const scored = diffs.flatMap((diff, i) => (Number.isNaN(diff) ? [] : [{ at: samples[i].at, diff, i }]));
  if (scored.length === 0) {
    throw new Error(`Could not read "${asset.name}" over ${round3(from)}-${round3(to)}s.`);
  }
  const stats = sweepStats(scored.map((s) => s.diff));
  const worst: Stretch[] = worstStretches(scored, step, SWEEP_TARGET, MAX_STRETCHES).map((w) => {
    const peak = scored[w.peakIndex];
    const shift = still ? undefined : runShift(near, SHIFT_REACH, scored[w.first].i, scored[w.last].i, step);
    const block = blockAt(doc, peak.at);
    return {
      from: w.from,
      to: round3(Math.min(w.to, to)),
      diff: w.diff,
      peak: w.peak,
      at: peak.at,
      source: samples[peak.i].source,
      grid: grids[peak.i],
      ...(shift ? { shift: shift.shift } : {}),
      ...(block ? { block } : {}),
    };
  });
  const timing = still ? undefined : runShift(near, SHIFT_REACH, 0, diffs.length - 1, step);
  const onBlocks = scored.filter((s) => blockAt(doc, s.at)).length / scored.length;
  const frame = frameNote(doc, scorer.letterboxed);
  const reached = diffs.length < samples.length ? samples[diffs.length].at : undefined;
  return {
    mode: "sweep",
    from: samples[0].at,
    to: round3(Math.min(samples[samples.length - 1].at + step, to)),
    step: round3(step),
    offset: span.offset,
    sampled: scored.length,
    ...(reached !== undefined ? { coveredTo: reached } : {}),
    ...stats,
    target: SWEEP_TARGET,
    worst,
    ...(timing ? { timing } : {}),
    ...(onBlocks > 0 ? { onBlocks: Math.round(onBlocks * 100) / 100 } : {}),
    ...(frame ? { frame } : {}),
  };
}
