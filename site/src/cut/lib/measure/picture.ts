/** Where a source's picture sits inside its frame. A reference is often a
 * recording of something else — a phone filming an editing app, a letterboxed
 * film — and only part of its frame is the picture being copied: the part
 * that changes over time. Bars, buttons and app chrome hold still. Frames
 * sampled across the source are reduced to a mask of the pixels that moved,
 * and the picture is the box of the largest connected stretch of them.
 * Pure data in, pure data out; sourceMeasure.ts feeds it decoded frames. */

import type { Pixels } from "./color";
import type { FrameBox } from "./sourceMeasure";

export const PICTURE_TUNING = {
  /** Luma range across the samples for a pixel to count as moving. */
  RANGE_MIN: 32,
  /** Samples a moving pixel changed in, each by STEP_MIN from the one before,
   * so a button that toggles once stays chrome. */
  MOVES_MIN: 2,
  STEP_MIN: 16,
  /** Pixels per side of the cells the connected stretch is found on. */
  CELL: 4,
  /** Share of a cell's pixels that must move for the cell to count. */
  CELL_SHARE: 0.25,
  /** Share of a row or column that must move for it to stay inside the box,
   * so a thin line touching the picture is trimmed off it. */
  EDGE_SHARE: 0.3,
  /** An edge this close to the frame's edge, as a fraction, is the frame's. */
  EDGE_SNAP: 0.015,
  /** The smallest picture, as a share of the frame. */
  AREA_MIN: 0.05,
  /** Fewer samples than this cannot show what changes. */
  SAMPLES_MIN: 3,
};

/** The whole frame as a box. */
export const FULL_FRAME: FrameBox = { x: 0.5, y: 0.5, w: 1, h: 1 };

export interface PictureFind {
  box: FrameBox;
  /** The box is the whole frame: nothing around the picture. */
  full: boolean;
  /** Share of the box's pixels that moved: near 1 is a busy picture, a low
   * share a picture that held still most of the time. */
  active: number;
}

/** A box given in `area`'s own fractions, as fractions of the whole frame. */
export const intoArea = (area: FrameBox, b: FrameBox): FrameBox => ({
  x: area.x - area.w / 2 + b.x * area.w,
  y: area.y - area.h / 2 + b.y * area.h,
  w: b.w * area.w,
  h: b.h * area.h,
});

/** A box on the whole frame, as fractions of `area`. */
export const areaOf = (area: FrameBox, b: FrameBox): FrameBox => ({
  x: (b.x - (area.x - area.w / 2)) / area.w,
  y: (b.y - (area.y - area.h / 2)) / area.h,
  w: b.w / area.w,
  h: b.h / area.h,
});

/** Whether a box is the whole frame. */
export const isFullFrame = (b: FrameBox): boolean =>
  Math.abs(b.x - 0.5) < 1e-6 && Math.abs(b.y - 0.5) < 1e-6 && b.w >= 1 - 1e-6 && b.h >= 1 - 1e-6;

/** The pixels that moved across `frames`, all of one size: 1 where moving. */
function movingMask(frames: Pixels[]): Uint8Array {
  const { RANGE_MIN, MOVES_MIN, STEP_MIN } = PICTURE_TUNING;
  const n = frames[0].width * frames[0].height;
  const lo = new Uint8Array(n).fill(255);
  const hi = new Uint8Array(n);
  const prev = new Uint8Array(n);
  const moves = new Uint16Array(n);
  frames.forEach((f, k) => {
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const l = (f.data[i] * 77 + f.data[i + 1] * 150 + f.data[i + 2] * 29) >> 8;
      if (l < lo[p]) {
        lo[p] = l;
      }
      if (l > hi[p]) {
        hi[p] = l;
      }
      if (k > 0 && Math.abs(l - prev[p]) >= STEP_MIN) {
        moves[p]++;
      }
      prev[p] = l;
    }
  });
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    mask[p] = hi[p] - lo[p] >= RANGE_MIN && moves[p] >= MOVES_MIN ? 1 : 0;
  }
  return mask;
}

/** The cells of the largest 8-connected stretch of moving cells, as a cell
 * box, or null when no cell moved. */
function largestStretch(cells: Uint8Array, cw: number, ch: number) {
  const seen = new Uint8Array(cells.length);
  let best: { x0: number; y0: number; x1: number; y1: number; size: number } | null = null;
  const stack: number[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) {
      continue;
    }

    // Flood the stretch this cell opens, keeping its bounds and size.
    const run = { x0: cw, y0: ch, x1: -1, y1: -1, size: 0 };
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const c = stack.pop()!;
      const cx = c % cw;
      const cy = (c - cx) / cw;
      run.size++;
      run.x0 = Math.min(run.x0, cx);
      run.x1 = Math.max(run.x1, cx);
      run.y0 = Math.min(run.y0, cy);
      run.y1 = Math.max(run.y1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) {
            continue;
          }
          const nc = ny * cw + nx;
          if (cells[nc] && !seen[nc]) {
            seen[nc] = 1;
            stack.push(nc);
          }
        }
      }
    }
    if (!best || run.size > best.size) {
      best = run;
    }
  }
  return best;
}

/**
 * The box a source's picture fills, from frames sampled across it. The
 * largest connected stretch of moving cells is the picture; its box is then
 * trimmed row by row and column by column to where the picture's own pixels
 * move, so its edges land on pixels. Null when too little moved to tell.
 */
export function findPictureBox(frames: Pixels[]): PictureFind | null {
  const { CELL, CELL_SHARE, EDGE_SHARE, EDGE_SNAP, AREA_MIN, SAMPLES_MIN } = PICTURE_TUNING;
  if (frames.length < SAMPLES_MIN) {
    return null;
  }
  const W = frames[0].width;
  const H = frames[0].height;
  const mask = movingMask(frames);

  // The mask on a coarse grid, so noise inside the picture never splits it.
  const cw = Math.ceil(W / CELL);
  const ch = Math.ceil(H / CELL);
  const counts = new Uint16Array(cw * ch);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      counts[Math.floor(y / CELL) * cw + Math.floor(x / CELL)] += mask[y * W + x];
    }
  }
  const cells = new Uint8Array(cw * ch);
  for (let c = 0; c < cells.length; c++) {
    cells[c] = counts[c] >= CELL * CELL * CELL_SHARE ? 1 : 0;
  }
  const stretch = largestStretch(cells, cw, ch);
  if (!stretch) {
    return null;
  }

  // The stretch's box in pixels, a cell wider each side, then trimmed from
  // each edge while the row (or column) is mostly still.
  let x0 = Math.max(0, (stretch.x0 - 1) * CELL);
  let x1 = Math.min(W, (stretch.x1 + 2) * CELL);
  let y0 = Math.max(0, (stretch.y0 - 1) * CELL);
  let y1 = Math.min(H, (stretch.y1 + 2) * CELL);
  const rowShare = (y: number) => {
    let n = 0;
    for (let x = x0; x < x1; x++) n += mask[y * W + x];
    return n / Math.max(1, x1 - x0);
  };
  const colShare = (x: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++) n += mask[y * W + x];
    return n / Math.max(1, y1 - y0);
  };
  while (y0 < y1 && rowShare(y0) < EDGE_SHARE) y0++;
  while (y1 > y0 && rowShare(y1 - 1) < EDGE_SHARE) y1--;
  while (x0 < x1 && colShare(x0) < EDGE_SHARE) x0++;
  while (x1 > x0 && colShare(x1 - 1) < EDGE_SHARE) x1--;
  if ((x1 - x0) * (y1 - y0) < W * H * AREA_MIN) {
    return null;
  }

  // Edges within a hair of the frame's are the frame's.
  if (x0 <= W * EDGE_SNAP) x0 = 0;
  if (y0 <= H * EDGE_SNAP) y0 = 0;
  if (x1 >= W * (1 - EDGE_SNAP)) x1 = W;
  if (y1 >= H * (1 - EDGE_SNAP)) y1 = H;
  let moving = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) moving += mask[y * W + x];
  }
  const active = Math.round((moving / ((x1 - x0) * (y1 - y0))) * 100) / 100;
  const full = x0 === 0 && y0 === 0 && x1 === W && y1 === H;
  if (full) {
    return { box: { ...FULL_FRAME }, full, active };
  }
  return {
    box: { x: (x0 + x1) / 2 / W, y: (y0 + y1) / 2 / H, w: (x1 - x0) / W, h: (y1 - y0) / H },
    full,
    active,
  };
}
