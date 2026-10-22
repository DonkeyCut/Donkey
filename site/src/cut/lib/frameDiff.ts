// How far a replica's frame is from the frame it copies, as numbers a model
// can act on. A picture of the two side by side shows that something is off;
// a score says how much, a grid says where, and a sweep of scores says when.
// Every score reads frames at the same small size, so a 4 in one call and a
// 4 in the next mean the same thing.

/** How compare_to_source reads: a few moments as pictures with their scores,
 * or a sweep of scores over a span with no pictures. */
export const COMPARE_MODES = ["moments", "sweep"] as const;

/** The most moments one picture call reads: two frames drawn and one picture
 * composed each, small enough to keep the reply readable. */
export const MAX_COMPARE = 8;

/** The score a replica aims for: under it, two frames read as the same
 * picture to the eye. */
export const SWEEP_TARGET = 5;

/** Long side of the frame a score reads. Small enough to sweep a cut frame by
 * frame, large enough that a title or a shape still moves the number. */
export const SCORE_LONG_SIDE = 96;

/** The grid's split per side: 4×4 cells, row 0 at the top. */
const GRID = 4;

/** How much better a neighbouring source frame has to match before the
 * difference is called timing: under three quarters of the moment's own
 * score, and at least this many points under it. */
const SHIFT_RATIO = 0.75;
const SHIFT_MIN_GAIN = 1;

/** A run of bad samples survives one good sample in its middle. */
const STRETCH_GAP = 1;

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Mean absolute difference over R, G and B, 0 (identical) to 255. */
export function meanDiff(cut: Uint8ClampedArray, source: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < cut.length; i += 4) {
    sum += Math.abs(cut[i] - source[i]) + Math.abs(cut[i + 1] - source[i + 1]) + Math.abs(cut[i + 2] - source[i + 2]);
  }
  return cut.length > 0 ? sum / ((cut.length / 4) * 3) : 0;
}

/** The score and where it comes from: `grid[row][col]` is each cell's own
 * mean difference, rounded, so a title in the wrong place reads as two hot
 * cells and a wrong background as a warm grid. */
export function diffPixels(
  cut: Uint8ClampedArray,
  source: Uint8ClampedArray,
  width: number,
  height: number
): { diff: number; grid: number[][] } {
  const sums = new Float64Array(GRID * GRID);
  const counts = new Float64Array(GRID * GRID);
  let total = 0;

  // One pass: every pixel adds to the total and to its cell.
  for (let y = 0; y < height; y++) {
    const row = Math.min(GRID - 1, Math.floor((y * GRID) / height));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const d =
        Math.abs(cut[i] - source[i]) + Math.abs(cut[i + 1] - source[i + 1]) + Math.abs(cut[i + 2] - source[i + 2]);
      const cell = row * GRID + Math.min(GRID - 1, Math.floor((x * GRID) / width));
      sums[cell] += d;
      counts[cell] += 3;
      total += d;
    }
  }
  const grid = Array.from({ length: GRID }, (_, r) =>
    Array.from({ length: GRID }, (_, c) => {
      const cell = r * GRID + c;
      return counts[cell] > 0 ? Math.round(sums[cell] / counts[cell]) : 0;
    })
  );
  return { diff: width * height > 0 ? total / (width * height * 3) : 0, grid };
}

/** The neighbouring source frame that matches clearly better than the moment
 * itself, if one does. `shift` is how far from the moment that frame sits, so
 * a positive shift means the cut shows early what the source shows later. */
export function bestShift(
  base: number,
  candidates: { shift: number; diff: number }[]
): { shift: number; diff: number } | undefined {
  let best: { shift: number; diff: number } | undefined;
  for (const c of candidates) {
    if (!best || c.diff < best.diff) {
      best = c;
    }
  }
  if (!best || best.diff >= base * SHIFT_RATIO || base - best.diff < SHIFT_MIN_GAIN) {
    return undefined;
  }
  return best;
}

/**
 * Whether a run of sweep samples matches the source better a few steps away.
 * `near` holds, per sample, its cut frame scored against the source sample k
 * steps off for k in -reach..reach (NaN where there is none), so a stretch
 * whose move lands a frame late reads as one shift for the whole stretch.
 */
export function runShift(
  near: Float32Array,
  reach: number,
  first: number,
  last: number,
  step: number
): { shift: number; diff: number } | undefined {
  const width = reach * 2 + 1;

  // The run's mean score at each offset, over the samples that have one.
  const meanAt = (k: number) => {
    let sum = 0;
    let n = 0;
    for (let i = first; i <= last; i++) {
      const v = near[i * width + k + reach];
      if (Number.isNaN(v)) {
        continue;
      }
      sum += v;
      n++;
    }
    return n > 0 ? sum / n : NaN;
  };
  const base = meanAt(0);
  const candidates: { shift: number; diff: number }[] = [];
  for (let k = -reach; k <= reach; k++) {
    const diff = meanAt(k);
    if (k === 0 || Number.isNaN(diff)) {
      continue;
    }
    candidates.push({ shift: Math.round(k * step * 1000) / 1000, diff: round1(diff) });
  }
  return Number.isNaN(base) ? undefined : bestShift(base, candidates);
}

/** Nearest-rank quantile of an ascending list. */
const quantile = (sorted: number[], p: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))];

/** The shape of a sweep's scores: the typical frame, the bad tail, the worst. */
export function sweepStats(scores: number[]): { median: number; p95: number; max: number } {
  const sorted = [...scores].sort((a, b) => a - b);
  return {
    median: round1(quantile(sorted, 0.5)),
    p95: round1(quantile(sorted, 0.95)),
    max: round1(sorted[sorted.length - 1] ?? 0),
  };
}

/**
 * The stretches of a sweep most worth a look, worst first.
 *
 * A sample is bad when it is over the target and at least as bad as the
 * median, so a cut that is off by the same amount everywhere reads as one
 * long stretch and a mostly good cut points at its outliers. Neighbouring bad
 * samples join into one stretch, and stretches rank by how far over the floor
 * they run in total: one frame far off and a long run a little off both
 * surface. `to` is the end of the last bad sample's step.
 */
export function worstStretches(
  samples: { at: number; diff: number }[],
  step: number,
  target: number,
  limit: number
): {
  from: number;
  to: number;
  diff: number;
  peak: number;
  peakAt: number;
  peakIndex: number;
  first: number;
  last: number;
  weight: number;
}[] {
  const median = quantile(samples.map((s) => s.diff).sort((a, b) => a - b), 0.5) ?? 0;
  const floor = Math.max(target, median);
  const bad = (d: number) => d > target && d >= median;

  // Runs of bad samples, bridging gaps of up to STRETCH_GAP good ones.
  const runs: { first: number; last: number }[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (!bad(samples[i].diff)) {
      continue;
    }
    const open = runs[runs.length - 1];
    if (open && i - open.last <= STRETCH_GAP + 1) {
      open.last = i;
      continue;
    }
    runs.push({ first: i, last: i });
  }

  // Each run measured over every sample inside it, the bridged ones too.
  const stretches = runs.map(({ first, last }) => {
    let sum = 0;
    let weight = 0;
    let peakIndex = first;
    for (let i = first; i <= last; i++) {
      sum += samples[i].diff;
      weight += Math.max(0, samples[i].diff - floor);
      if (samples[i].diff > samples[peakIndex].diff) {
        peakIndex = i;
      }
    }
    return {
      from: samples[first].at,
      to: samples[last].at + step,
      diff: round1(sum / (last - first + 1)),
      peak: round1(samples[peakIndex].diff),
      peakAt: samples[peakIndex].at,
      peakIndex,
      first,
      last,
      weight,
    };
  });
  return stretches.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

export type Edge = "top" | "bottom" | "left" | "right";

/**
 * The edges of a frame a difference runs the whole length of while its
 * middle matches: a border, a band or a letterbox one picture has and the
 * other lacks. Thin bars move a frame's mean little, so this reads the grid:
 * every cell along the edge over the target, and the middle cells under a
 * third of that edge's least. `diff` is the mean over those edges' cells.
 */
export function edgeBand(grid: number[][], target: number): { edges: Edge[]; diff: number } | null {
  const n = grid.length;
  if (n < 3 || grid.some((row) => row.length !== n)) return null;
  const middle: number[] = [];
  for (let r = 1; r < n - 1; r++) for (let c = 1; c < n - 1; c++) middle.push(grid[r][c]);
  const calm = middle.reduce((a, b) => a + b, 0) / middle.length;
  const lines: [Edge, number[]][] = [
    ["top", grid[0]],
    ["bottom", grid[n - 1]],
    ["left", grid.map((row) => row[0])],
    ["right", grid.map((row) => row[n - 1])],
  ];
  const hot = lines.filter(([, cells]) => Math.min(...cells) > target && calm * 3 <= Math.min(...cells));
  if (hot.length === 0) return null;
  const cells = hot.flatMap(([, c]) => c);
  return { edges: hot.map(([e]) => e), diff: round1(cells.reduce((a, b) => a + b, 0) / cells.length) };
}
