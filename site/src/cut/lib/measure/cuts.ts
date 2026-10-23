/** Hard-cut detection over every frame of a span: each frame is reduced to a
 * grid of cell means, scored by how much of the grid changed since the frame
 * before, and a cut is a score that stands out against the frames around it.
 * Pure data in, pure data out; sourceMeasure.ts feeds it decoded frames. */

import { easeAt, EASE_IDS, type EaseId } from "@donkeycut/effects-kit";
import { diffCellPct } from "../watch/signatures";
import type { Pixels } from "./color";

export const CUT_TUNING = {
  /** Cells per side of the grid each frame is reduced to. */
  GRID: 16,
  /** Per-channel change for a cell to count as changed (the watch selector's). */
  CELL_TOL: 25,
  /** % of cells that must change for a frame to be a cut at all. */
  MIN_CHANGE: 8,
  /** A cut's change is at least this many times its neighbours' median. */
  SPIKE: 3,
  /** Frames either side a cut is judged against. */
  NEIGHBOURS: 3,
  /** Mean-luma step (0..255) of a frame that flashes or blacks out the whole
   * picture at once: a cut however busy the frames around it are, since
   * motion moves things around the frame and leaves its brightness be. */
  FLASH_LUMA: 60,
  /** Per-channel step a flat fill takes when it cuts to a near colour (a dark
   * green to a slightly lighter one): under CELL_TOL, over grain. */
  FAINT_TOL: 6,
  /** % of cells that must take that faint step together to make a cut. */
  FAINT_ALL: 90,
  /** Cells per side of the finer grid changes inside a shot are read on: a
   * word or a small shape covers a few of its cells. */
  FINE_GRID: 32,
  /** % of the fine grid a change inside a shot covers at least. */
  CHANGE_MIN: 0.3,
  /** Frames back a frame is held against to find a change too gradual for
   * any one frame to show: a fade of faint type over half a second. */
  SLOW_SPAN: 15,
  /** The share of a gradual change's total move that marks its first frame,
   * and the share that marks its last. */
  SLOW_START: 0.05,
  SLOW_END: 0.95,
  /** % of the fine grid a flicker frame changes from the frame before. */
  FLICKER_MIN: 2,
  /** A flicker frame sits at most this share of that change away from the
   * frame two or three back: it returns to a look it just left. */
  FLICKER_ECHO: 0.6,
  /** Flicker frames a run holds at least; one held frame may part two. */
  FLICKER_RUN: 3,
  /** Mean-luma step (0..255) a frame of a whole-picture fade takes at least. */
  FADE_STEP: 0.5,
  /** Frames a fade's run of steps holds at least. */
  FADE_RUN: 4,
  /** Mean-luma move (0..255) a fade makes in all. */
  FADE_LUMA: 20,
  /** Per-channel RMS (0..255) a frame strays at most from the clear picture
   * pulled toward the tone. */
  FADE_FIT: 6,
};

/** Per-cell channel means of an RGBA frame on a GRID×GRID grid. */
export function gridMeans(px: Pixels, grid = CUT_TUNING.GRID): Float32Array {
  const out = new Float32Array(grid * grid * 3);
  const counts = new Uint32Array(grid * grid);
  for (let y = 0; y < px.height; y++) {
    const gy = Math.min(grid - 1, Math.floor((y * grid) / px.height));
    for (let x = 0; x < px.width; x++) {
      const cell = gy * grid + Math.min(grid - 1, Math.floor((x * grid) / px.width));
      const i = (y * px.width + x) * 4;
      out[cell * 3] += px.data[i];
      out[cell * 3 + 1] += px.data[i + 1];
      out[cell * 3 + 2] += px.data[i + 2];
      counts[cell]++;
    }
  }
  for (let c = 0; c < counts.length; c++) {
    const n = Math.max(1, counts[c]);
    out[c * 3] /= n;
    out[c * 3 + 1] /= n;
    out[c * 3 + 2] /= n;
  }
  return out;
}

/** % of the grid that changed between two frames. */
export const changePct = (a: Float32Array, b: Float32Array): number => diffCellPct(a, b, CUT_TUNING.CELL_TOL);

/** The indices of the frames that open a new shot, given each frame's change
 * from the one before (index 0 has none: NaN). A cut is a frame whose change
 * clears the floor and towers over the median of its neighbours, so a pan —
 * the same large change every frame — is not one, and a one-frame shot keeps
 * both of its cuts because one high neighbour never moves the median. */
export function pickCuts(scores: number[]): number[] {
  const { MIN_CHANGE, SPIKE } = CUT_TUNING;
  const cuts: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!(s >= MIN_CHANGE)) {
      continue;
    }
    if (s >= SPIKE * neighbourMedian(scores, i)) {
      cuts.push(i);
    }
  }
  return cuts;
}

/** A box as centre and size, fractions of the scanned picture. */
export interface ChangeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One frame reduced for scoring: the cut grid and the finer change grid. */
export interface FrameGrids {
  coarse: Float32Array;
  fine: Float32Array;
}

/** What a frame changed from the one before: `pct` of the cut grid past the
 * hard tolerance, `faint` of it past the faint one, `fine` of the fine grid
 * past the hard tolerance, and the box around those fine cells. */
export interface FrameStep {
  pct: number;
  faint: number;
  fine: number;
  box: ChangeBox | null;
  /** How far the whole picture's mean luma moved, 0..255. */
  luma?: number;
}

/** A change inside a shot: from frame `frame` for `frames` frames, the most
 * of the picture it changed in one frame (`change`, %) and where. */
export interface ShotChange {
  frame: number;
  frames: number;
  change: number;
  box: ChangeBox;
  /** The change flips back and forth frame by frame over its run. */
  flicker?: true;
}

/** The whole picture fading into a tone or out of it, as the flash effect's
 * fade plays it: from fractional frame `frame` for `frames` frames along
 * `ease`, to `amount` of the tone (1 = the tone alone). */
export interface PictureFade {
  frame: number;
  frames: number;
  fade: "to" | "from";
  tone: "black" | "white";
  amount: number;
  ease: EaseId;
}

export const gridsOf = (px: Pixels): FrameGrids => ({
  coarse: gridMeans(px),
  fine: gridMeans(px, CUT_TUNING.FINE_GRID),
});

/** The fine cells that changed between two frames, and the box around them. */
function fineChange(a: Float32Array, b: Float32Array): { pct: number; box: ChangeBox | null } {
  const grid = CUT_TUNING.FINE_GRID;
  let n = 0;
  let x0 = grid;
  let x1 = -1;
  let y0 = grid;
  let y1 = -1;
  for (let c = 0; c < grid * grid; c++) {
    const i = c * 3;
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d <= CUT_TUNING.CELL_TOL) {
      continue;
    }
    n++;
    const gx = c % grid;
    const gy = Math.floor(c / grid);
    x0 = Math.min(x0, gx);
    x1 = Math.max(x1, gx);
    y0 = Math.min(y0, gy);
    y1 = Math.max(y1, gy);
  }
  if (n === 0) {
    return { pct: 0, box: null };
  }
  const box = { x: (x0 + x1 + 1) / 2 / grid, y: (y0 + y1 + 1) / 2 / grid, w: (x1 - x0 + 1) / grid, h: (y1 - y0 + 1) / grid };
  return { pct: (100 * n) / (grid * grid), box };
}

/** A grid's mean luma (Rec. 709 weights), 0..255. */
function meanLuma(g: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < g.length; i += 3) sum += 0.2126 * g[i] + 0.7152 * g[i + 1] + 0.0722 * g[i + 2];
  return sum / Math.max(1, g.length / 3);
}

/** How `next` differs from `prev` on both grids. */
export function frameStep(prev: FrameGrids, next: FrameGrids): FrameStep {
  const fine = fineChange(prev.fine, next.fine);
  return {
    pct: changePct(prev.coarse, next.coarse),
    faint: diffCellPct(prev.coarse, next.coarse, CUT_TUNING.FAINT_TOL),
    fine: fine.pct,
    box: fine.box,
    luma: Math.abs(meanLuma(next.coarse) - meanLuma(prev.coarse)),
  };
}

/** The median of the scores within NEIGHBOURS of `i`, skipping `i`, frames
 * with no score, and any index `skip` holds. */
function neighbourMedian(scores: number[], i: number, skip?: Set<number>): number {
  const around: number[] = [];
  for (let j = Math.max(0, i - CUT_TUNING.NEIGHBOURS); j <= Math.min(scores.length - 1, i + CUT_TUNING.NEIGHBOURS); j++) {
    if (j !== i && Number.isFinite(scores[j]) && !skip?.has(j)) {
      around.push(scores[j]);
    }
  }
  around.sort((a, b) => a - b);
  return around.length === 0 ? 0 : around[Math.floor((around.length - 1) / 2)];
}

/** The frames that open a shot and the changes inside shots, from each
 * frame's step (index 0 has none: NaN fields), and each frame's fine grid
 * when the gradual changes are wanted too (gradualChanges).
 * A cut is a hard spike (pickCuts) or a faint step taken by the whole
 * picture at once over still frames — a flat card cut to a near colour. A
 * crossfade takes that step every frame, so its neighbours rule it out.
 * A change is a spike on the fine grid in a frame that is no cut — a word
 * appearing, a word swapping fill for outline, a small shape popping in.
 * Changes on consecutive frames are one change that runs those frames: a
 * fade-in over three frames reads as one change of three. */
export function pickShotEdges(
  steps: FrameStep[],
  fines?: ArrayLike<number>[]
): { cuts: number[]; changes: ShotChange[]; fades: PictureFade[] } {
  const { FAINT_ALL, SPIKE, CHANGE_MIN, MIN_CHANGE, FLASH_LUMA } = CUT_TUNING;
  const hard = pickCuts(steps.map((s) => s.pct));
  const faintScores = steps.map((s) => s.faint);

  // The faint cuts and the flashes, beside the hard ones.
  const cutSet = new Set(hard);
  steps.forEach((s, i) => {
    if (s.pct >= MIN_CHANGE && (s.luma ?? 0) >= FLASH_LUMA) cutSet.add(i);
  });
  for (let i = 0; i < steps.length; i++) {
    if (cutSet.has(i) || !(faintScores[i] >= FAINT_ALL)) {
      continue;
    }
    if (neighbourMedian(faintScores, i) * SPIKE <= FAINT_ALL) {
      cutSet.add(i);
    }
  }
  const cuts = [...cutSet].sort((a, b) => a - b);

  // The changes: fine spikes away from the cuts, runs merged.
  const fineScores = steps.map((s) => s.fine);
  const changes: ShotChange[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (cutSet.has(i) || !(s.fine >= CHANGE_MIN) || !s.box) {
      continue;
    }
    if (s.fine < SPIKE * neighbourMedian(fineScores, i, cutSet)) {
      continue;
    }
    const last = changes[changes.length - 1];
    if (last && last.frame + last.frames === i) {
      last.frames++;
      last.change = Math.max(last.change, s.fine);
      last.box = unionBox(last.box, s.box);
      continue;
    }
    changes.push({ frame: i, frames: 1, change: s.fine, box: s.box });
  }
  if (!fines) {
    return { cuts, changes, fades: [] };
  }
  // A whole-picture fade moves every cell every frame: its frames are no
  // cuts and no changes, whatever their steps.
  const fades = pictureFades(fines);
  const fading = (i: number) => fades.some((f) => i > Math.floor(f.frame) && i <= Math.ceil(f.frame + f.frames));
  const kept = cuts.filter((i) => !fading(i));
  const overlaps = (a: ShotChange, b: ShotChange) => a.frame < b.frame + b.frames && b.frame < a.frame + a.frames;
  const flicks = flickers(fines);
  const slow = gradualChanges(fines, kept).filter((g) => !changes.some((c) => overlaps(g, c)));
  const rest = [...changes, ...slow].filter((c) => !flicks.some((f) => overlaps(c, f)));
  const inside = (c: ShotChange) => Array.from({ length: c.frames }, (_, k) => c.frame + k).some(fading);
  return {
    cuts: kept,
    changes: [...rest, ...flicks].filter((c) => !inside(c)).sort((a, b) => a.frame - b.frame),
    fades,
  };
}

/** How far frame `x` is pulled from the clear picture `c` toward `tone`
 * (0..255 on every channel), by least squares, and how far it strays from
 * that pull (per-channel RMS). */
function pullOf(c: ArrayLike<number>, x: ArrayLike<number>, tone: number): { f: number; miss: number } {
  let dot = 0;
  let norm = 0;
  for (let i = 0; i < c.length; i++) {
    dot += (x[i] - c[i]) * (tone - c[i]);
    norm += (tone - c[i]) ** 2;
  }
  const f = norm > 0 ? dot / norm : 0;
  let err = 0;
  for (let i = 0; i < c.length; i++) err += (x[i] - c[i] - f * (tone - c[i])) ** 2;
  return { f, miss: Math.sqrt(err / Math.max(1, c.length)) };
}

/** Whole-picture fades into black or white or out of them: runs of frames
 * whose mean luma steps the same way every frame, each frame the clear
 * picture pulled toward the tone. A fade into the tone is held against the
 * frame before the run, a fade out of it against the frame the run lands
 * on; the one that fits is the fade. Its start, length, ease and amount are
 * fitted to every frame's pull. */
export function pictureFades(fines: ArrayLike<number>[]): PictureFade[] {
  const { FADE_STEP, FADE_RUN, FADE_LUMA, FADE_FIT } = CUT_TUNING;
  const luma = fines.map((g) => meanLuma(g as Float32Array));
  const out: PictureFade[] = [];
  for (let a = 1; a < fines.length; a++) {
    const sign = Math.sign(luma[a] - luma[a - 1]);
    if (!(Math.abs(luma[a] - luma[a - 1]) >= FADE_STEP)) continue;
    let b = a;
    while (b + 1 < fines.length && Math.sign(luma[b + 1] - luma[b]) === sign && Math.abs(luma[b + 1] - luma[b]) >= FADE_STEP) b++;
    const run = b - a + 1;
    const moved = Math.abs(luma[b] - luma[a - 1]);
    const next = b;
    if (run < FADE_RUN || moved < FADE_LUMA) {
      a = next;
      continue;
    }
    // Darkening is into black or out of white, brightening into white or
    // out of black: each held against its clear frame.
    const ways: { fade: "to" | "from"; tone: number; clear: number }[] =
      sign < 0
        ? [
            { fade: "to", tone: 0, clear: a - 1 },
            { fade: "from", tone: 255, clear: b },
          ]
        : [
            { fade: "to", tone: 255, clear: a - 1 },
            { fade: "from", tone: 0, clear: b },
          ];
    const read = ways.map((w) => {
      const pulls = new Map<number, number>();
      let worst = 0;
      for (let i = a - 1; i <= b; i++) {
        const p = pullOf(fines[w.clear], fines[i], w.tone);
        pulls.set(i, p.f);
        worst = Math.max(worst, p.miss);
      }
      // The still frames either side that hold the same picture join the
      // fit, so a curve that settles slowly is timed whole.
      for (const [from, step] of [
        [a - 2, -1],
        [b + 1, 1],
      ] as const) {
        for (let i = from, n = 0; i >= 0 && i < fines.length && n < FADE_RUN; i += step, n++) {
          const p = pullOf(fines[w.clear], fines[i], w.tone);
          if (p.miss > FADE_FIT) break;
          pulls.set(i, p.f);
        }
      }
      return { ...w, pulls, worst };
    });
    const best = read.filter((r) => r.worst <= FADE_FIT).sort((x, y) => x.worst - y.worst)[0];
    if (best) {
      const fit = fitFade(best.pulls, best.fade, a - 1, b);
      if (fit) out.push({ ...fit, fade: best.fade, tone: best.tone === 0 ? "black" : "white" });
    }
    a = next;
  }
  return out;
}

/** What a fade pays for stopping short of the tone, against the squared
 * misses of its frames' pulls: enough to settle a tie, never a frame held
 * short of it. */
const FADE_FULL = 0.01;

/** The start, length, ease and amount whose curve best runs through each
 * frame's pull: rising into the tone, falling out of it. */
function fitFade(
  pulls: Map<number, number>,
  fade: "to" | "from",
  first: number,
  last: number
): Omit<PictureFade, "fade" | "tone"> | null {
  // An ease that sets off slowly steps under FADE_STEP at first, so the
  // fade may start on any of the still frames joined in front of the run.
  const frames = [...pulls.keys()];
  const end = Math.max(...frames);
  const lead = Math.min(...frames);
  let best: Omit<PictureFade, "fade" | "tone"> | null = null;
  let bestErr = Infinity;
  for (const ease of EASE_IDS) {
    for (let s = lead - 0.5; s <= first + 1.0001; s += 0.1) {
      for (let n = Math.max(1, last - s - 4); n <= end - s + 4; n += 0.1) {
        // The amount that fits this curve best, by least squares.
        let fg = 0;
        let gg = 0;
        const shape = (i: number) => {
          const e = easeAt(ease, (i - s) / n);
          return fade === "to" ? e : 1 - e;
        };
        for (const [i, f] of pulls) {
          const g = shape(i);
          fg += f * g;
          gg += g * g;
        }
        if (gg <= 0) continue;
        const amount = Math.min(1, Math.max(0, fg / gg));
        let err = 0;
        for (const [i, f] of pulls) err += (f - amount * shape(i)) ** 2;
        // Frames that never show the fade land can't tell how far it goes —
        // a power curve stopped short reads the same as a shorter one gone
        // all the way — so it goes all the way unless the frames say otherwise.
        err += FADE_FULL * (1 - amount) ** 2;
        if (err < bestErr - 1e-9) {
          bestErr = err;
          best = { frame: s, frames: n, amount, ease };
        }
      }
    }
  }
  return best;
}

/** Runs of frames that flip back and forth — a strobe, a cutout flashing to
 * its negative — each frame changed from the one before and back to a look
 * two or three frames old. Every such frame matches its neighbours' change,
 * so no one of them stands out as a change of its own. A shake that returns
 * to rest echoes once; a run takes FLICKER_RUN. The run opens on the frame
 * after the first look it returns to. */
export function flickers(fines: ArrayLike<number>[]): ShotChange[] {
  const { FLICKER_MIN, FLICKER_ECHO, FLICKER_RUN } = CUT_TUNING;
  const cells = fines.length > 0 ? fines[0].length / 3 : 0;
  const hits: { i: number; echo: number; moved: number[] }[] = [];
  for (let i = 2; i < fines.length; i++) {
    const moved = cellsApart(fines[i - 1], fines[i]);
    const step = (100 * moved.length) / cells;
    if (step < FLICKER_MIN) {
      continue;
    }
    const back = [2, 3].find((k) => i - k >= 0 && (100 * cellsApart(fines[i - k], fines[i]).length) / cells <= step * FLICKER_ECHO);
    if (back) {
      hits.push({ i, echo: i - back, moved });
    }
  }
  const out: ShotChange[] = [];
  let run: typeof hits = [];
  const close = () => {
    if (run.length >= FLICKER_RUN) {
      const frame = run[0].echo + 1;
      const moved = [...new Set(run.flatMap((h) => h.moved))];
      const change = Math.max(...run.map((h) => (100 * h.moved.length) / cells));
      out.push({ frame, frames: run[run.length - 1].i - frame + 1, change, box: boxOfCells(moved), flicker: true });
    }
    run = [];
  };
  for (const h of hits) {
    if (run.length > 0 && h.i - run[run.length - 1].i > 2) {
      close();
    }
    run.push(h);
  }
  close();
  return out;
}

/** The fine cells that differ between two grids past the hard tolerance. */
function cellsApart(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let c = 0; c < a.length / 3; c++) {
    const i = c * 3;
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > CUT_TUNING.CELL_TOL) {
      out.push(c);
    }
  }
  return out;
}

/** The box around a set of fine cells. */
function boxOfCells(cells: number[]): ChangeBox {
  const grid = CUT_TUNING.FINE_GRID;
  const xs = cells.map((c) => c % grid);
  const ys = cells.map((c) => Math.floor(c / grid));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x: (x0 + x1 + 1) / 2 / grid, y: (y0 + y1 + 1) / 2 / grid, w: (x1 - x0 + 1) / grid, h: (y1 - y0 + 1) / grid };
}

/** Changes too gradual for any one frame to show — faint type fading in or
 * out over many frames, each step under the hard tolerance. Each frame is
 * held against the one SLOW_SPAN back inside its shot; frames that differ
 * from it on a few cells, where the shot's typical frame differs on far
 * fewer (footage that moves throughout differs everywhere), are a change.
 * Its first and last frames are where the cells it moved are SLOW_START and
 * SLOW_END of the way from where they were to where they settle. */
export function gradualChanges(fines: ArrayLike<number>[], cuts: number[]): ShotChange[] {
  const { SLOW_SPAN, CHANGE_MIN, SPIKE, SLOW_START, SLOW_END } = CUT_TUNING;
  const cells = fines.length > 0 ? fines[0].length / 3 : 0;
  const bounds = [0, ...cuts, fines.length];
  const out: ShotChange[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [s, e] = [bounds[k], bounds[k + 1]];
    if (e - s < 3) {
      continue;
    }
    const back = (i: number) => Math.max(s, i - SLOW_SPAN);
    const pct = new Map<number, number>();
    for (let i = s + 1; i < e; i++) {
      pct.set(i, (100 * cellsApart(fines[i], fines[back(i)]).length) / cells);
    }
    const sorted = [...pct.values()].sort((a, b) => a - b);
    const floor = sorted[Math.floor((sorted.length - 1) / 4)];
    const hit = (i: number) => (pct.get(i) ?? 0) >= Math.max(CHANGE_MIN, SPIKE * floor);
    for (let i = s + 1; i < e; i++) {
      if (!hit(i)) {
        continue;
      }
      let r1 = i;
      while (r1 + 1 < e && hit(r1 + 1)) {
        r1++;
      }
      const pre = back(i);
      const moved = cellsApart(fines[pre], fines[r1]);
      i = r1;
      if (moved.length === 0) {
        continue;
      }
      // How far along the moved cells are, 0 at `pre` and 1 at `r1`.
      const a = fines[pre];
      const z = fines[r1];
      let norm = 0;
      for (const c of moved) for (let ch = 0; ch < 3; ch++) norm += (z[c * 3 + ch] - a[c * 3 + ch]) ** 2;
      const along = (f: ArrayLike<number>) => {
        let dot = 0;
        for (const c of moved) for (let ch = 0; ch < 3; ch++) dot += (f[c * 3 + ch] - a[c * 3 + ch]) * (z[c * 3 + ch] - a[c * 3 + ch]);
        return dot / norm;
      };
      let first = -1;
      let last = r1;
      for (let j = pre + 1; j <= r1; j++) {
        const p = along(fines[j]);
        if (first < 0 && p > SLOW_START) {
          first = j;
        }
        if (first >= 0 && p >= SLOW_END) {
          last = j;
          break;
        }
      }
      if (first < 0) {
        continue;
      }
      out.push({ frame: first, frames: last - first + 1, change: (100 * moved.length) / cells, box: boxOfCells(moved) });
    }
  }
  return out;
}

/** The box around two boxes. */
function unionBox(a: ChangeBox, b: ChangeBox): ChangeBox {
  const l = Math.min(a.x - a.w / 2, b.x - b.w / 2);
  const r = Math.max(a.x + a.w / 2, b.x + b.w / 2);
  const t = Math.min(a.y - a.h / 2, b.y - b.h / 2);
  const btm = Math.max(a.y + a.h / 2, b.y + b.h / 2);
  return { x: (l + r) / 2, y: (t + btm) / 2, w: r - l, h: btm - t };
}

/** Cuts, changes and fades over a run of frames held in memory. */
export function scoreFrames(frames: Pixels[]): { cuts: number[]; changes: ShotChange[]; fades: PictureFade[] } {
  const grids = frames.map(gridsOf);
  const none: FrameStep = { pct: NaN, faint: NaN, fine: NaN, box: null };
  return pickShotEdges(
    grids.map((g, i) => (i === 0 ? none : frameStep(grids[i - 1], g))),
    grids.map((g) => g.fine)
  );
}
