/** Hard-cut detection over every frame of a span: each frame is reduced to a
 * grid of cell means, scored by how much of the grid changed since the frame
 * before, and a cut is a score that stands out against the frames around it.
 * Pure data in, pure data out; sourceMeasure.ts feeds it decoded frames. */

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
  const { MIN_CHANGE, SPIKE, NEIGHBOURS } = CUT_TUNING;
  const cuts: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!(s >= MIN_CHANGE)) {
      continue;
    }

    // The neighbours on both sides that have a score of their own.
    const around: number[] = [];
    for (let j = Math.max(0, i - NEIGHBOURS); j <= Math.min(scores.length - 1, i + NEIGHBOURS); j++) {
      if (j !== i && Number.isFinite(scores[j])) {
        around.push(scores[j]);
      }
    }
    around.sort((a, b) => a - b);
    const median = around.length === 0 ? 0 : around[Math.floor((around.length - 1) / 2)];
    if (s >= SPIKE * median) {
      cuts.push(i);
    }
  }
  return cuts;
}
