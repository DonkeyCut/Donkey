/** Colour reads of a region of a frame: its median colour, how far the region
 * strays from it, and the few colours it is made of. Pure pixel math on RGBA
 * data; sourceMeasure.ts hands it decoded frames. */

/** An RGBA frame, as ImageData carries it. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A rectangle in pixels: left, top, width, height. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Rgb = [number, number, number];

/** Pixels a dominant-colour pass looks at, at most: a whole 1080p frame
 * strided down to this many still finds every colour that covers a percent. */
const CLUSTER_SAMPLES = 20_000;
const CLUSTER_ROUNDS = 10;
/** Dominant colours below this share of the region are noise: edges, grain. */
const MIN_SHARE = 0.01;

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0").toUpperCase();
export const hexOf = (r: number, g: number, b: number): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** "#RRGGBB", "RRGGBB" or "#RGB" as channels; null for anything else. */
export function parseHex(raw: string): Rgb | null {
  const s = raw.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return [0, 1, 2].map((i) => parseInt(s[i] + s[i], 16)) as Rgb;
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as Rgb;
  }
  return null;
}

/** The rectangle clipped to the frame, at least one pixel. */
export function clipRect(px: Pixels, r: PixelRect): PixelRect {
  const x0 = Math.max(0, Math.min(px.width - 1, Math.floor(r.x)));
  const y0 = Math.max(0, Math.min(px.height - 1, Math.floor(r.y)));
  const x1 = Math.max(x0 + 1, Math.min(px.width, Math.ceil(r.x + r.w)));
  const y1 = Math.max(y0 + 1, Math.min(px.height, Math.ceil(r.y + r.h)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The colour of a region: the per-channel median as hex, `spread` — the
 * mean of each pixel's largest channel distance from that median, 0..255 —
 * and with `k` ≥ 2 the k colours it is made of, largest share first. */
export function regionColor(
  px: Pixels,
  rect: PixelRect,
  k = 1
): { hex: string; spread: number; dominant?: { hex: string; share: number }[] } {
  const r = clipRect(px, rect);

  // Per-channel histograms give an exact median in one pass.
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * px.width + x) * 4;
      hist[0][px.data[i]]++;
      hist[1][px.data[i + 1]]++;
      hist[2][px.data[i + 2]]++;
    }
  }
  const n = r.w * r.h;
  const median = hist.map((h) => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += h[v];
      if (seen * 2 >= n) return v;
    }
    return 255;
  }) as Rgb;

  // How far the region strays from its median, on average.
  let dev = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * px.width + x) * 4;
      dev += Math.max(
        Math.abs(px.data[i] - median[0]),
        Math.abs(px.data[i + 1] - median[1]),
        Math.abs(px.data[i + 2] - median[2])
      );
    }
  }
  const out = { hex: hexOf(...median), spread: Math.round(dev / n) };
  if (k < 2) return out;
  return { ...out, dominant: dominantColors(px, r, k) };
}

/** The k colours a region is made of, by k-means over a strided sample, each
 * with its share of the region. Seeded deterministically — the most common
 * coarse colour first, then each next seed the pixel farthest from the
 * seeds so far — so one region always reads the same. */
function dominantColors(px: Pixels, r: PixelRect, k: number): { hex: string; share: number }[] {
  const stride = Math.max(1, Math.floor(Math.sqrt((r.w * r.h) / CLUSTER_SAMPLES)));
  const pts: number[] = [];
  for (let y = r.y; y < r.y + r.h; y += stride) {
    for (let x = r.x; x < r.x + r.w; x += stride) {
      const i = (y * px.width + x) * 4;
      pts.push(px.data[i], px.data[i + 1], px.data[i + 2]);
    }
  }
  const count = pts.length / 3;
  const dist = (p: number, c: number[]) =>
    (pts[p * 3] - c[0]) ** 2 + (pts[p * 3 + 1] - c[1]) ** 2 + (pts[p * 3 + 2] - c[2]) ** 2;

  // Seeds: the most common 4-bit colour, then farthest-point picks.
  const coarse = new Map<number, number>();
  let top = 0;
  let topKey = -1;
  for (let p = 0; p < count; p++) {
    const key = ((pts[p * 3] >> 4) << 8) | ((pts[p * 3 + 1] >> 4) << 4) | (pts[p * 3 + 2] >> 4);
    const c = (coarse.get(key) ?? 0) + 1;
    coarse.set(key, c);
    if (c > top) {
      top = c;
      topKey = key;
    }
  }
  const first = (() => {
    for (let p = 0; p < count; p++) {
      const key = ((pts[p * 3] >> 4) << 8) | ((pts[p * 3 + 1] >> 4) << 4) | (pts[p * 3 + 2] >> 4);
      if (key === topKey) return p;
    }
    return 0;
  })();
  const centers: number[][] = [[pts[first * 3], pts[first * 3 + 1], pts[first * 3 + 2]]];
  while (centers.length < k) {
    let far = -1;
    let farD = 0;
    for (let p = 0; p < count; p++) {
      const d = Math.min(...centers.map((c) => dist(p, c)));
      if (d > farD) {
        farD = d;
        far = p;
      }
    }
    // Fewer distinct colours than asked for: stop at what is there.
    if (far < 0) break;
    centers.push([pts[far * 3], pts[far * 3 + 1], pts[far * 3 + 2]]);
  }

  // Lloyd rounds.
  const label = new Uint8Array(count);
  for (let round = 0; round < CLUSTER_ROUNDS; round++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let p = 0; p < count; p++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dist(p, centers[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      label[p] = best;
      const s = sums[best];
      s[0] += pts[p * 3];
      s[1] += pts[p * 3 + 1];
      s[2] += pts[p * 3 + 2];
      s[3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      const s = sums[c];
      if (s[3] > 0) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    }
  }

  const sizes = centers.map(() => 0);
  for (let p = 0; p < count; p++) sizes[label[p]]++;
  return centers
    .map((c, i) => ({ hex: hexOf(c[0], c[1], c[2]), share: Math.round((sizes[i] / count) * 100) / 100 }))
    .filter((c) => c.share >= MIN_SHARE)
    .sort((a, b) => b.share - a.share);
}
