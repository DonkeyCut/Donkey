import { type RgbFrame, SIGNATURE_SIZE } from "./types";

/** The pixel comparisons behind frame selection. All math runs on three
 * fixed views of a SIGNATURE_SIZE² frame:
 *  - fine: the pixels themselves (packed RGB) — local detail
 *  - g16 / g32: per-cell channel means — whole-frame structure
 * Comparisons use the max channel difference, so hues with equal luma still
 * read as different. */

const S = SIGNATURE_SIZE;

export interface FrameSig {
  fine: Uint8Array; // S*S*3 packed RGB
  g16: Float32Array; // 16*16*3 cell means
  g32: Float32Array; // 32*32*3 cell means
}

function meanGrid(fine: Uint8Array, grid: number): Float32Array {
  const cell = S / grid;
  const out = new Float32Array(grid * grid * 3);
  const norm = 1 / (cell * cell);
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = gy * cell; y < (gy + 1) * cell; y++) {
        let i = (y * S + gx * cell) * 3;
        for (let x = 0; x < cell; x++) {
          r += fine[i++];
          g += fine[i++];
          b += fine[i++];
        }
      }
      const o = (gy * grid + gx) * 3;
      out[o] = r * norm;
      out[o + 1] = g * norm;
      out[o + 2] = b * norm;
    }
  }
  return out;
}

export function frameSig(f: RgbFrame): FrameSig {
  if (f.width !== S || f.height !== S)
    throw new Error(`Selector frames must be ${S}×${S} (got ${f.width}×${f.height}).`);
  let fine: Uint8Array;
  if (f.channels === 3) {
    fine = Uint8Array.from(f.data); // copy — the caller may reuse its buffer
  } else {
    fine = new Uint8Array(S * S * 3);
    for (let p = 0, i = 0, o = 0; p < S * S; p++, i += 4, o += 3) {
      fine[o] = f.data[i];
      fine[o + 1] = f.data[i + 1];
      fine[o + 2] = f.data[i + 2];
    }
  }
  return { fine, g16: meanGrid(fine, 16), g32: meanGrid(fine, 32) };
}

/** % of grid cells whose max channel differs by more than tol. */
export function diffCellPct(a: Float32Array, b: Float32Array, tol: number): number {
  const cells = a.length / 3;
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2])
    );
    if (d > tol) changed++;
  }
  return (100 * changed) / cells;
}

/** Count of grid cells whose max channel differs by more than tol. */
export function hardCellCount(a: Float32Array, b: Float32Array, tol: number): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2])
    );
    if (d > tol) n++;
  }
  return n;
}

/** True when pixel (x,y) of cur differs by more than tol from every ref pixel
 * within ±1 — the shift tolerance lets jitter, weave, and grain re-match, so
 * only genuinely new pixels count. */
function shiftChanged(ref: Uint8Array, cur: Uint8Array, x: number, y: number, tol: number): boolean {
  const ci = (y * S + x) * 3;
  const r = cur[ci];
  const g = cur[ci + 1];
  const b = cur[ci + 2];
  for (let dy = -1; dy <= 1; dy++) {
    const sy = Math.min(S - 1, Math.max(0, y + dy));
    for (let dx = -1; dx <= 1; dx++) {
      const sx = Math.min(S - 1, Math.max(0, x + dx));
      const ri = (sy * S + sx) * 3;
      const d = Math.max(
        Math.abs(ref[ri] - r),
        Math.abs(ref[ri + 1] - g),
        Math.abs(ref[ri + 2] - b)
      );
      if (d <= tol) return false;
    }
  }
  return true;
}

export const SETTLED_GRID = 16;

/** Per-cell % of pixels that hold a settled new state: changed (beyond tol,
 * shift-tolerant) vs EVERY kept frame in the window, and — when a next frame
 * exists — no longer changing toward it. A caption that just landed scores
 * high in its cells; motion mid-flight scores zero because the next frame
 * moves it again. Returns SETTLED_GRID² cell percentages. */
export function settledCellScores(
  cur: Uint8Array,
  keptWindow: Uint8Array[],
  next: Uint8Array | null,
  tol: number
): Float32Array {
  const grid = SETTLED_GRID;
  const cell = S / grid;
  const counts = new Float32Array(grid * grid);
  for (let y = 0; y < S; y++) {
    const gy = Math.floor(y / cell);
    for (let x = 0; x < S; x++) {
      let changed = true;
      for (const kf of keptWindow) {
        if (!shiftChanged(kf, cur, x, y, tol)) {
          changed = false;
          break;
        }
      }
      if (changed && next !== null && shiftChanged(next, cur, x, y, tol)) changed = false;
      if (changed) counts[gy * grid + Math.floor(x / cell)]++;
    }
  }
  const norm = 100 / (cell * cell);
  for (let i = 0; i < counts.length; i++) counts[i] *= norm;
  return counts;
}
