import { renderProjectFrames } from "./exportRender";
import { FULL_FRAME, isFullFrame } from "./measure/picture";
import type { FrameBox } from "./measure/sourceMeasure";
import { bestShift, diffPixels, edgeBand, inkColor, inkOff, meanDiff, type Ink, runShift, SCORE_LONG_SIDE, SWEEP_TARGET, sweepStats, worstStretches, type Edge } from "./frameDiff";
import { hexOf } from "./measure/color";
import { composeComparison, makeStillFrame } from "./media";
import type { WrappedCanvas } from "mediabunny";
import { framesAt, type FrameSize } from "./mediaRead";
import { createRasterCanvas, decodeRasterImageUrl, rasterCanvasToDataUrl, type RasterSurface } from "./raster";
import type { ExportDoc } from "./renderSnapshot";
import { clipLen } from "./store";
import { textBoxSize } from "./textFit";
import { DEFAULT_BACKGROUND, frameOf, isTextOverlay, type MediaAsset, type TextOverlay } from "./types";
import { poseAt } from "@donkeycut/effects-kit";

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

/** Readers a source frame is tried on — the one that failed, then fresh ones
 * on software decoding — before the frame is given up. */
const READ_TRIES = 3;

/** Frames given up in a row before the source counts as unreadable from there. */
const READ_LOST_RUN = 3;

/** The breath before a fresh reader, per try: a decoder lost to contention
 * comes back once the contention passes. */
const READ_RETRY_MS = 100;

/** How far a title's ink may sit from the source's (inkOff) before the sweep
 * counts the frame: a white label where the source's is black reads near 230,
 * pale cyan letters washed to white near 65, the same label a shade off or a
 * little thinner under 30. */
const INK_TOLERANCE = 48;

/** Frames a title has to be off on before the sweep names it, so a single
 * frame of a move caught mid-way does not. */
const MIN_TITLE_FRAMES = 2;

/** The shortest box a title is read in, px at the sweep's size: type smaller
 * than this is a few pixels of strokes on either side, and their colour comes
 * and goes with the decode. */
const MIN_TITLE_PX = 8;

/** The most titles one sweep names. */
const MAX_TITLES = 8;

/** Aspect ratios this close draw edge to edge; anything further letterboxes
 * or fills, as the call asks. */
const ASPECT_SLACK = 0.01;

/** How a source of another shape sits in the cut's frame to be scored:
 * letterboxed whole over the background, or filling it, centre-cropped. */
export type SourceFit = "letterbox" | "fill";

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

/** `area` of a `w`×`h` frame, in its pixels. */
function areaPx(area: FrameBox, w: number, h: number) {
  return { x: (area.x - area.w / 2) * w, y: (area.y - area.h / 2) * h, w: area.w * w, h: area.h * h };
}

/** A source frame's picture box as a JPEG for the side-by-side: the frame
 * itself when the box is the whole of it. */
async function pictureUrl(area: FrameBox, source: CanvasImageSource, w: number, h: number): Promise<string> {
  if (isFullFrame(area)) {
    return rasterCanvasToDataUrl(source as RasterSurface, "image/jpeg", 0.82);
  }
  const r = areaPx(area, w, h);
  const canvas = createRasterCanvas(Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h)));
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error("No 2d context to crop the source's picture on.");
  }
  ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
  try {
    return await rasterCanvasToDataUrl(canvas, "image/jpeg", 0.82);
  } finally {
    canvas.width = 0;
  }
}

/** The read height that gives the source's picture box `height` rows. */
const readHeight = (area: FrameBox, height: number) => Math.round(height / area.h);

/**
 * Reads any frame down to the score's size, in the cut's shape. Only the
 * source's picture box is read — the part of its frame the cut copies. A
 * picture of another shape is letterboxed into the cut's frame over its
 * background, the way a clip of that shape would sit on the timeline — or,
 * with `fit` "fill", scaled to cover it and centre-cropped, the way a
 * full-bleed replica in another shape fills its frame — and the scorer
 * remembers it did so the result can say so.
 */
function makeScorer(doc: ExportDoc, area: FrameBox, fit: SourceFit, longSide = SCORE_LONG_SIDE) {
  const size = sizeOf(doc, longSide);
  const canvas = createRasterCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error("No 2d context to score frames on.");
  }
  ctx.imageSmoothingQuality = "high";
  let reshaped: { w: number; h: number } | undefined;
  return {
    // Held here so the surface lives as long as its context: a server
    // canvas's context keeps only a weak hold on it.
    canvas,
    size,
    get reshaped() {
      return reshaped;
    },
    /** A source frame, read inside its picture box. */
    pixels(source: CanvasImageSource, fw: number, fh: number): Uint8ClampedArray {
      return draw(source, areaPx(area, fw, fh));
    },
    /** One of the cut's own frames, read whole. */
    cut(source: CanvasImageSource, fw: number, fh: number): Uint8ClampedArray {
      return draw(source, { x: 0, y: 0, w: fw, h: fh });
    },
  };

  function draw(source: CanvasImageSource, r: { x: number; y: number; w: number; h: number }): Uint8ClampedArray {
    ctx!.fillStyle = doc.background ?? DEFAULT_BACKGROUND;
    ctx!.fillRect(0, 0, size.width, size.height);
    if (Math.abs(r.w / r.h / (size.width / size.height) - 1) <= ASPECT_SLACK) {
      ctx!.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, size.width, size.height);
    } else {
      reshaped = { w: r.w, h: r.h };
      const k = (fit === "fill" ? Math.max : Math.min)(size.width / r.w, size.height / r.h);
      const dw = r.w * k;
      const dh = r.h * k;
      ctx!.drawImage(source, r.x, r.y, r.w, r.h, (size.width - dw) / 2, (size.height - dh) / 2, dw, dh);
    }
    return ctx!.getImageData(0, 0, size.width, size.height).data;
  }
}

/** The line a result carries when the source was letterboxed or filled to
 * score it. */
function frameNote(
  doc: ExportDoc,
  shape: { w: number; h: number } | undefined,
  area: FrameBox,
  fit: SourceFit
): string | undefined {
  if (!shape) {
    return undefined;
  }
  const shapes = `The source's ${isFullFrame(area) ? "frame" : "picture box"} is ${round1(shape.w / shape.h)}:1 and the cut's is ${doc.aspect}`;
  if (fit === "fill") {
    return (
      `${shapes}, so scores read the source scaled to fill the cut's frame, centre-cropped. ` +
      "What the crop cuts off is not checked, and type and shapes read here blown up with the crop: check colour fields with this, but size type and shapes from fit \"letterbox\", which keeps them in proportion to the frame."
    );
  }
  return (
    `${shapes}, so scores read the source letterboxed into the cut's frame over its background. ` +
    "Bars the cut does not have count as difference; set_aspect to the source's shape when the copy should match it. " +
    'In another shape, size type and shapes from this read, and pass fit "fill" only to check full-bleed colour edge to edge.'
  );
}

/** A still source's one frame, as the scorer reads it, and its picture box
 * as the side-by-side shows it. */
async function stillPixels(asset: MediaAsset, scorer: ReturnType<typeof makeScorer>, area: FrameBox) {
  const still = await makeStillFrame(asset.url, "read");
  const img = await decodeRasterImageUrl(still.frames[0].image);
  if (!img) {
    throw new Error(`Could not read "${asset.name}".`);
  }
  const image = isFullFrame(area)
    ? still.frames[0].image
    : await pictureUrl(area, img.source, img.width, img.height);
  return { image, pixels: scorer.pixels(img.source, img.width, img.height) };
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
  total: number,
  area: FrameBox = FULL_FRAME,
  fit: SourceFit = "letterbox"
): Promise<{ images: string[]; checked: Checked[]; frame?: string }> {
  const size = sizeOf(doc, COMPARE_LONG_SIDE);
  const scorer = makeScorer(doc, area, fit);
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
  const lost: LostFrame[] = [];
  if (asset.type === "image") {
    const still = await stillPixels(asset, scorer, area);
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
    // the comparison is for. Asking for both dimensions squashes it. The
    // height is its picture box's, so a picture inside a bigger frame is
    // read at the size the cut's frame is.
    let seen = 0;
    for await (const c of steadyFrames(asset, times, { height: readHeight(area, size.height) }, lost)) {
      const k = key(times[seen++]);
      if (!c) {
        continue;
      }
      pixels.set(k, scorer.pixels(c.canvas, c.canvas.width, c.canvas.height));
      if (centers.has(k)) {
        pictures.set(k, await pictureUrl(area, c.canvas, c.canvas.width, c.canvas.height));
      }
    }
  }
  for (const m of wanted) {
    if (!pictures.has(key(m.sourceAt))) {
      const why = lost.find((l) => key(l.source) === key(m.sourceAt));
      throw new Error(
        `Could not read "${asset.name}" at ${Math.round(m.sourceAt * 100) / 100}s` +
          (why ? `: ${why.error} ${READ_TRIES} fresh decoders, the last in software, failed on that frame.` : ".")
      );
    }
  }

  // One prepared painter for every moment: preparing stamps every title
  // and may bring up the segmenter, and the document does not change
  // between them. Each frame is scored before the next overwrites it.
  const pairs: { t: number; sourceAt: number; source: string; cut: string }[] = [];
  const checked: Checked[] = [];
  await renderProjectFrames(doc, wanted.map((m) => m.at), size, (a) => a.url, async (canvas, at) => {
    const m = wanted[pairs.length];
    const cut = scorer.cut(canvas, canvas.width, canvas.height);
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
  const frame = frameNote(doc, scorer.reshaped, area, fit);
  return { images, checked, ...(frame ? { frame } : {}) };
}

/** A source frame the read gave up on: its second and what the decoder said. */
type LostFrame = { source: number; error: string };

/** The source stopped decoding: READ_LOST_RUN frames in a row failed fresh
 * readers, the first of them at `source` seconds, the `index`th time asked. */
class SourceReadError extends Error {
  constructor(
    readonly asset: MediaAsset,
    readonly source: number,
    readonly index: number,
    readonly count: number,
    readonly reason: string
  ) {
    super(
      `"${asset.name}" stopped decoding at ${round3(source)}s (frame ${index + 1} of ${count} read, ${READ_LOST_RUN} in a row failing ` +
        `${READ_TRIES} fresh decoders each, the last in software): ${reason}`
    );
    this.name = "SourceReadError";
  }
}

/** What a failed read said, in the decoder's own words. */
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "the decoder failed";

/**
 * The source's frames at `times`, one per time and in order, in one decode
 * pass that outlives its decoder. A hardware decoder dies mid-read for reasons
 * that pass — contention for the machine's decode sessions over a long
 * session — and says only "Decoding error.", so a read that fails opens a
 * fresh reader on software decoding at the frame it failed on and goes on
 * from there. A frame that fails READ_TRIES readers is given up — null in its
 * place and named in `lost` — and READ_LOST_RUN given up in a row end the
 * read with a SourceReadError naming the first.
 */
async function* steadyFrames(
  asset: MediaAsset,
  times: number[],
  size: FrameSize,
  lost: LostFrame[]
): AsyncGenerator<WrappedCanvas | null> {
  let next = 0;
  let software = false;
  let tries = 0;
  let run: { index: number; reason: string } | null = null;
  while (next < times.length) {
    const reader = framesAt(asset.url, times.slice(next), size, software ? { software: true } : undefined);
    try {
      for (;;) {
        const step = await reader.next();
        if (step.done) {
          return;
        }
        next++;
        tries = 0;
        run = null;
        yield step.value;
      }
    } catch (e) {
      tries++;
      software = true;
      if (tries >= READ_TRIES) {
        const reason = reasonOf(e);
        run ??= { index: next, reason };
        if (next - run.index + 1 >= READ_LOST_RUN) {
          throw new SourceReadError(asset, times[run.index], run.index, times.length, run.reason);
        }
        lost.push({ source: round3(times[next]), error: reason });
        next++;
        tries = 0;
        yield null;
      } else {
        await new Promise((r) => setTimeout(r, READ_RETRY_MS * tries));
      }
    } finally {
      await reader.return(undefined).catch(() => {});
    }
  }
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

export type TitleInk = {
  id: string;
  text: string;
  /** The span the title's letters were off over, and on how many frames. */
  from: number;
  to: number;
  frames: number;
  /** Its worst frame, and the letters' colour there on each side: null
   * where that side shows none. */
  at: number;
  source: number;
  ink: string | null;
  sourceInk: string | null;
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
  /** Stretches whose difference runs along whole edges of the frame while
   * the middle matches — a border or band one side lacks — under target too. */
  edges?: (Omit<Stretch, "shift"> & { edges: Edge[] })[];
  /** Titles whose letters read another colour than the source's under them,
   * each read once at the sample nearest its middle. */
  titles?: TitleInk[];
  timing?: { shift: number; diff: number };
  onBlocks?: number;
  frame?: string;
  /** Source frames no fresh decoder read, left out of the scores. */
  lost?: LostFrame[];
  /** Why the sweep ended at `coveredTo` short of its span, when the source
   * stopped decoding there. */
  stopped?: string;
};

/**
 * The sweep: the cut scored against the source at every step of a span, with
 * the source read at a constant offset, and no pictures. The source is read
 * first, in one pass down to the score's size, and its decoder let go before
 * the cut renders, so no decoder sits open through the render; each cut frame
 * is then scored against the source samples SHIFT_REACH steps either side, so
 * a stretch that is right but late says how late.
 */
export async function sweepSource(
  doc: ExportDoc,
  asset: MediaAsset,
  span: { from: number; to: number; step?: number; offset: number },
  total: number,
  area: FrameBox = FULL_FRAME,
  fit: SourceFit = "letterbox"
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
  const scorer = makeScorer(doc, area, fit);
  // Titles read at the render's own size, where letters still have cores,
  // on every sample they are up for: the source's letters as it is decoded,
  // the cut's as it renders.
  const reads = titleReads(doc, samples);
  const fine = reads.size > 0 ? makeScorer(doc, area, fit, SWEEP_LONG_SIDE) : null;
  const sourceInks = new Map<number, (Ink | null)[]>();
  const readInks = (j: number, px: Uint8ClampedArray, f: NonNullable<typeof fine>) =>
    (reads.get(j) ?? []).map((o) => {
      const box = titleBox(doc, o, samples[j].at, f.size);
      return box.h < MIN_TITLE_PX ? null : inkColor(px, f.size.width, f.size.height, box);
    });
  const offs = new Map<string, { o: TextOverlay; hits: { j: number; off: number; ink: Ink; sourceInk: Ink }[] }>();
  const width = SHIFT_REACH * 2 + 1;
  const started = performance.now();
  const outOfTime = (j: number) => j > 0 && performance.now() - started > SWEEP_BUDGET_MS;

  // The source side, read whole before the render: a still answers every
  // sample with its one frame; a video is one decode pass. A frame no decoder
  // reads is null and drops out; a source that stops decoding ends the sweep
  // at the first frame it lost.
  const lost: LostFrame[] = [];
  let stopped: SourceReadError | undefined;
  const sources: (Uint8ClampedArray | null)[] = [];
  const still = asset.type === "image" ? (await stillPixels(asset, scorer, area)).pixels : null;
  if (still) {
    sources.push(...samples.map(() => still));
    if (fine) {
      const px = (await stillPixels(asset, fine, area)).pixels;
      for (const j of reads.keys()) sourceInks.set(j, readInks(j, px, fine));
    }
  } else {
    try {
      for await (const c of steadyFrames(asset, samples.map((s) => s.source), { height: readHeight(area, size.height) }, lost)) {
        if (outOfTime(sources.length)) {
          break;
        }
        if (c && fine && reads.has(sources.length)) {
          sourceInks.set(sources.length, readInks(sources.length, fine.pixels(c.canvas, c.canvas.width, c.canvas.height), fine));
        }
        sources.push(c ? scorer.pixels(c.canvas, c.canvas.width, c.canvas.height) : null);
      }
    } catch (e) {
      if (!(e instanceof SourceReadError)) {
        throw e;
      }
      stopped = e;
      sources.length = Math.min(sources.length, e.index);
    }
  }

  const near = new Float32Array(sources.length * width).fill(NaN);
  const diffs: number[] = [];
  const grids: number[][][] = [];
  const cuts = new Map<number, Uint8ClampedArray>();
  try {
    await renderProjectFrames(doc, samples.slice(0, sources.length).map((s) => s.at), size, (a) => a.url, async (canvas) => {
      const j = diffs.length;
      if (outOfTime(j)) {
        throw new SweepOutOfTime();
      }
      const src = sources[j];
      const cut = scorer.cut(canvas, canvas.width, canvas.height);

      // The sample's own score, then the timing read: this cut frame against
      // the source samples before it, and the cut frames before it against
      // this source sample. Only the last SHIFT_REACH cut frames are kept.
      const own = src ? diffPixels(cut, src, scorer.size.width, scorer.size.height) : { diff: NaN, grid: [] };
      diffs.push(own.diff);
      grids.push(own.grid);
      near[j * width + SHIFT_REACH] = own.diff;
      for (let k = 1; k <= SHIFT_REACH && !still; k++) {
        const back = j - k >= 0 ? sources[j - k] : null;
        if (back) {
          near[j * width + SHIFT_REACH - k] = meanDiff(cut, back);
        }
        const before = cuts.get(j - k);
        if (src && before) {
          near[(j - k) * width + SHIFT_REACH + k] = meanDiff(before, src);
        }
      }
      cuts.set(j, cut);
      cuts.delete(j - SHIFT_REACH);

      const theirs = sourceInks.get(j);
      if (fine && theirs) {
        const ours = readInks(j, fine.cut(canvas, canvas.width, canvas.height), fine);
        (reads.get(j) ?? []).forEach((o, k) => {
          const ink = ours[k];
          const sourceInk = theirs[k];
          const off = ink && sourceInk ? inkOff(ink, sourceInk) : null;
          if (off !== null && off > INK_TOLERANCE) {
            const rec = offs.get(o.id) ?? { o, hits: [] };
            rec.hits.push({ j, off, ink: ink!, sourceInk: sourceInk! });
            offs.set(o.id, rec);
          }
        });
      }
    });
  } catch (e) {
    if (!(e instanceof SweepOutOfTime)) {
      throw e;
    }
  }

  // What was scored: a sample the source had no frame for drops out.
  const scored = diffs.flatMap((diff, i) => (Number.isNaN(diff) ? [] : [{ at: samples[i].at, diff, i }]));
  if (scored.length === 0) {
    throw new Error(`Could not read "${asset.name}" over ${round3(from)}-${round3(to)}s${stopped ? `: ${stopped.message}` : "."}`);
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
  // Thin bars barely move a frame's mean, so they are read off the grids.
  const bands = scored.map((sc) => edgeBand(grids[sc.i], SWEEP_TARGET));
  const edges = worstStretches(
    scored.map((sc, k) => ({ at: sc.at, diff: bands[k]?.diff ?? 0 })),
    step,
    SWEEP_TARGET,
    MAX_STRETCHES
  ).map((w) => {
    const peak = scored[w.peakIndex];
    const block = blockAt(doc, peak.at);
    return {
      from: w.from,
      to: round3(Math.min(w.to, to)),
      diff: w.diff,
      peak: w.peak,
      at: peak.at,
      source: samples[peak.i].source,
      edges: bands[w.peakIndex]?.edges ?? [],
      grid: grids[peak.i],
      ...(block ? { block } : {}),
    };
  });
  const timing = still ? undefined : runShift(near, SHIFT_REACH, 0, diffs.length - 1, step);
  const hex = (c: Ink["ink"]) => (c ? hexOf(...c) : null);
  const titles: TitleInk[] = [...offs.values()]
    .filter((r) => r.hits.length >= MIN_TITLE_FRAMES)
    .sort((a, b) => b.hits.length - a.hits.length)
    .slice(0, MAX_TITLES)
    .map(({ o, hits }) => {
      const worst = hits.reduce((a, b) => (b.off > a.off ? b : a));
      return {
        id: o.id,
        text: o.text,
        from: samples[hits[0].j].at,
        to: round3(Math.min(samples[hits[hits.length - 1].j].at + step, to)),
        frames: hits.length,
        at: samples[worst.j].at,
        source: samples[worst.j].source,
        ink: hex(worst.ink.ink),
        sourceInk: hex(worst.sourceInk.ink),
      };
    });
  const onBlocks = scored.filter((s) => blockAt(doc, s.at)).length / scored.length;
  const frame = frameNote(doc, scorer.reshaped, area, fit);
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
    ...(edges.length > 0 ? { edges } : {}),
    ...(titles.length > 0 ? { titles } : {}),
    ...(timing ? { timing } : {}),
    ...(onBlocks > 0 ? { onBlocks: Math.round(onBlocks * 100) / 100 } : {}),
    ...(frame ? { frame } : {}),
    ...(lost.length > 0 ? { lost } : {}),
    ...(stopped ? { stopped: `${stopped.message} Cut ${samples[stopped.index].at}s.` } : {}),
  };
}

/** The titles up at each sample, by the sample's index: a title faded under
 * half is left out there. */
function titleReads(doc: ExportDoc, samples: { at: number }[]): Map<number, TextOverlay[]> {
  const titles = doc.overlays.filter((o): o is TextOverlay => isTextOverlay(o) && !o.hidden && !!o.text.trim());
  const reads = new Map<number, TextOverlay[]>();
  samples.forEach(({ at }, j) => {
    const up = titles.filter((o) => at >= o.start && at < o.end && poseAt(o, at - o.start).opacity >= 0.5);
    if (up.length > 0) reads.set(j, up);
  });
  return reads;
}

/** Where a title sits in a frame of `size` at timeline second `at`. */
function titleBox(doc: ExportDoc, o: TextOverlay, at: number, size: { width: number; height: number }) {
  const design = frameOf(doc.aspect);
  const pose = poseAt(o, at - o.start);
  const box = textBoxSize(o, design.w, design.h);
  const k = (size.width / design.w) * pose.scale;
  const w = box.width * k;
  const h = box.height * k;
  return { x: pose.x * size.width - w / 2, y: pose.y * size.height - h / 2, w, h };
}
