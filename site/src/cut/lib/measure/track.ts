/** Where an element of one colour sits in a frame: the connected piece of that
 * colour a seed points at (a card, a bar, a sticker), or the box around every
 * pixel of it inside a region (the ink of a line of type, whose letters are
 * separate pieces). Pure pixel math; sourceMeasure.ts runs it per frame. */

import { clipRect, type PixelRect, type Pixels, type Rgb } from "./color";

/** Pieces smaller than this many pixels are compression noise and grain. */
const MIN_PIECE = 4;
/** A piece clear of the seed is still taken when its centre sits within this
 * many seed sizes of the seed's — an element that moved since the last frame. */
const REACH = 2;

interface Piece {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
}

/** The pieces of `target` colour (within `tol` on every channel) inside
 * `area`, 8-connected, as pixel boxes with their sizes. */
function piecesOf(px: Pixels, target: Rgb, tol: number, area: PixelRect): Piece[] {
  const r = clipRect(px, area);
  const w = r.w;
  const h = r.h;

  // Union-find over the mask, one row at a time.
  const parent = new Int32Array(w * h).fill(-1);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((r.y + y) * px.width + r.x + x) * 4;
      const near =
        Math.abs(px.data[i] - target[0]) <= tol &&
        Math.abs(px.data[i + 1] - target[1]) <= tol &&
        Math.abs(px.data[i + 2] - target[2]) <= tol;
      if (!near) continue;
      const p = y * w + x;
      parent[p] = p;
      if (x > 0 && parent[p - 1] >= 0) join(p, p - 1);
      if (y === 0) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < w && parent[p - w + dx] >= 0) join(p, p - w + dx);
      }
    }
  }

  // Each root's bounding box, back in frame pixels.
  const boxes = new Map<number, Piece>();
  for (let p = 0; p < w * h; p++) {
    if (parent[p] < 0) continue;
    const root = find(p);
    const x = r.x + (p % w);
    const y = r.y + Math.floor(p / w);
    const b = boxes.get(root);
    if (!b) {
      boxes.set(root, { x0: x, y0: y, x1: x + 1, y1: y + 1, count: 1 });
      continue;
    }
    b.x0 = Math.min(b.x0, x);
    b.y0 = Math.min(b.y0, y);
    b.x1 = Math.max(b.x1, x + 1);
    b.y1 = Math.max(b.y1, y + 1);
    b.count++;
  }
  return [...boxes.values()].filter((b) => b.count >= MIN_PIECE);
}

const rectOf = (b: Piece): PixelRect => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });

/** The box around every piece of `target` inside `area` — the ink of a line
 * of type — or null when there is none. */
export function inkBox(px: Pixels, target: Rgb, tol: number, area: PixelRect): PixelRect | null {
  const pieces = piecesOf(px, target, tol, area);
  if (pieces.length === 0) return null;
  return rectOf({
    x0: Math.min(...pieces.map((b) => b.x0)),
    y0: Math.min(...pieces.map((b) => b.y0)),
    x1: Math.max(...pieces.map((b) => b.x1)),
    y1: Math.max(...pieces.map((b) => b.y1)),
    count: 0,
  });
}

/** The one piece of `target` inside `area` that `near` points at: the one
 * overlapping it most, else the closest within REACH of its size; null when
 * the element is not in this frame. */
export function shapeBox(px: Pixels, target: Rgb, tol: number, area: PixelRect, near: PixelRect): PixelRect | null {
  const pieces = piecesOf(px, target, tol, area);
  const overlap = (b: Piece) =>
    Math.max(0, Math.min(b.x1, near.x + near.w) - Math.max(b.x0, near.x)) *
    Math.max(0, Math.min(b.y1, near.y + near.h) - Math.max(b.y0, near.y));
  let best: Piece | null = null;
  let bestOverlap = 0;
  for (const b of pieces) {
    const o = overlap(b);
    if (o > bestOverlap) {
      bestOverlap = o;
      best = b;
    }
  }
  if (best) return rectOf(best);

  // Nothing under the seed: the closest piece, if it is within reach.
  const cx = near.x + near.w / 2;
  const cy = near.y + near.h / 2;
  const reach = REACH * Math.max(near.w, near.h, 1);
  let bestD = Infinity;
  for (const b of pieces) {
    const d = Math.hypot((b.x0 + b.x1) / 2 - cx, (b.y0 + b.y1) / 2 - cy);
    if (d <= reach && d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best ? rectOf(best) : null;
}
