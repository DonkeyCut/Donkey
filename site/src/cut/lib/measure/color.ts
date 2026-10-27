/** Colour reads of a region of a frame: its median colour, how far the region
 * strays from it, the few colours it is made of, and the stripes it is laid in. Pure pixel math on RGBA
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

/** Stripes are read off the middle of a region at most this many pixels a
 * side: a few dozen lines, and the angle and period searches stay cheap. */
const STRIPE_SIDE = 160;
/** Bin width along the stripes' normal for the angle search, pixels. */
const STRIPE_BIN = 0.5;
/** The fewest whole periods the read must hold, so the longest period read is
 * a third of the side. */
const STRIPE_PERIODS = 3;
/** Period steps: fine where a step of 0.02 px still moves the fold, then a
 * fixed share of the period. */
const STRIPE_STEP = 0.02;
const STRIPE_STEP_SHARE = 0.005;
/** Phase bins a period folds into. */
const STRIPE_PHASES = 16;
/** Share of the region's luminance variance the folded period must explain:
 * stripes are most of what varies; type, an edge or grain isn't. */
const STRIPE_SHARE = 0.35;
/** Least luminance swing between line and gap, 0..255 — under it the lines
 * are too faint to lay. */
const STRIPE_CONTRAST = 4;

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

/** Parallel lines a region is laid in, as add_shape's stripe pattern takes
 * them: `angle` the lines' direction in degrees clockwise from vertical,
 * -90..90; `width` and `gap` in px at 1080; `line` and `ground` their colours. */
export interface Stripes {
  angle: number;
  width: number;
  gap: number;
  line: string;
  ground: string;
}

/** The stripes a region is laid in, or null when it isn't. `unit` is design
 * px at 1080 per frame pixel. The angle is the one whose profile across the
 * lines swings widest; the period the shortest that folds the pixels onto
 * one line about as well as the best does (twice the period folds just as
 * well); the line is whichever of the brighter and darker phases covers
 * less of the period. */
export function regionStripes(px: Pixels, rect: PixelRect, unit: number): Stripes | null {
  const r = clipRect(px, rect);
  const w = Math.min(STRIPE_SIDE, r.w);
  const h = Math.min(STRIPE_SIDE, r.h);
  if (Math.min(w, h) < 4 * STRIPE_PERIODS) return null;
  const x0 = r.x + Math.floor((r.w - w) / 2);
  const y0 = r.y + Math.floor((r.h - h) / 2);
  const n = w * h;
  const lum = new Float32Array(n);
  let mean = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * px.width + x0 + x) * 4;
      const v = 0.2126 * px.data[i] + 0.7152 * px.data[i + 1] + 0.0722 * px.data[i + 2];
      lum[y * w + x] = v;
      mean += v;
    }
  }
  mean /= n;
  let pixVar = 0;
  for (let k = 0; k < n; k++) {
    lum[k] -= mean;
    pixVar += lum[k] * lum[k];
  }
  pixVar /= n;
  // A square wave of the least contrast varies by a quarter of its swing squared.
  if (pixVar < (STRIPE_CONTRAST * STRIPE_CONTRAST) / 4) return null;

  // The angle: the normal whose binned profile varies most.
  const reach = Math.ceil(Math.hypot(w, h) / STRIPE_BIN) + 2;
  const sum = new Float64Array(reach * 2);
  const cnt = new Uint32Array(reach * 2);
  const profileVar = (deg: number) => {
    const c = Math.cos((deg * Math.PI) / 180) / STRIPE_BIN;
    const s = Math.sin((deg * Math.PI) / 180) / STRIPE_BIN;
    sum.fill(0);
    cnt.fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const b = Math.floor(x * c + y * s) + reach;
        sum[b] += lum[y * w + x];
        cnt[b]++;
      }
    }
    let v = 0;
    let bins = 0;
    for (let b = 0; b < reach * 2; b++) {
      if (cnt[b] < Math.min(w, h) / 2) continue;
      v += (sum[b] / cnt[b]) ** 2;
      bins++;
    }
    return bins ? v / bins : 0;
  };
  let theta = 0;
  let best = -1;
  for (let d = -90; d < 90; d++) {
    const v = profileVar(d);
    if (v > best) [theta, best] = [d, v];
  }
  for (let d = theta - 1; d <= theta + 1; d += 0.25) {
    const v = profileVar(d);
    if (v > best) [theta, best] = [d, v];
  }

  // The period: fold each pixel by its place along the normal.
  const c0 = Math.cos((theta * Math.PI) / 180);
  const s0 = Math.sin((theta * Math.PI) / 180);
  const along = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) along[y * w + x] = x * c0 + y * s0;
  const phSum = new Float64Array(STRIPE_PHASES);
  const phCnt = new Uint32Array(STRIPE_PHASES);
  const fold = (period: number) => {
    phSum.fill(0);
    phCnt.fill(0);
    for (let k = 0; k < n; k++) {
      const q = along[k] / period;
      const b = Math.min(STRIPE_PHASES - 1, Math.floor((q - Math.floor(q)) * STRIPE_PHASES));
      phSum[b] += lum[k];
      phCnt[b]++;
    }
  };
  // A fold's swing, kept only as far as neighbouring phases agree: on a pixel
  // grid a period's fraction (10 px folded at 10/4.5) sorts the same pixels
  // into the same bins out of order and swings just as wide, but only the
  // true period lays one line in one run of phases.
  const foldVar = (period: number) => {
    fold(period);
    let v = 0;
    let step = 0;
    for (let b = 0; b < STRIPE_PHASES; b++) {
      const m = phSum[b] / Math.max(1, phCnt[b]);
      const next = phSum[(b + 1) % STRIPE_PHASES] / Math.max(1, phCnt[(b + 1) % STRIPE_PHASES]);
      v += m * m;
      step += (m - next) ** 2;
    }
    if (v === 0) return 0;
    return (v / STRIPE_PHASES) * Math.max(0, 1 - step / (2 * v));
  };
  const tries: { period: number; v: number }[] = [];
  for (let p = 2; p <= Math.min(w, h) / STRIPE_PERIODS; p += Math.max(STRIPE_STEP, p * STRIPE_STEP_SHARE)) {
    tries.push({ period: p, v: foldVar(p) });
  }
  if (tries.length === 0) return null;
  const top = Math.max(...tries.map((t) => t.v));
  if (top < STRIPE_SHARE * pixVar) return null;
  let at = tries.findIndex((t) => t.v >= 0.8 * top);
  while (at + 1 < tries.length && tries[at + 1].v >= tries[at].v) at++;
  const period = tries[at].period;

  // Line and ground: split the period's phases at the middle of their swing.
  fold(period);
  const phMean = Array.from(phSum, (v, b) => v / Math.max(1, phCnt[b]));
  const hi = Math.max(...phMean);
  const lo = Math.min(...phMean);
  if (hi - lo < STRIPE_CONTRAST) return null;
  const bright = phMean.map((v) => v > (hi + lo) / 2);
  const lineBright = bright.filter(Boolean).length <= STRIPE_PHASES / 2;
  // Colours from the phases clear of an edge, where no pixel mixes the two.
  const core = (b: number) =>
    bright[(b + STRIPE_PHASES - 1) % STRIPE_PHASES] === bright[b] && bright[(b + 1) % STRIPE_PHASES] === bright[b];
  const ink = [0, 0, 0, 0];
  const ground = [0, 0, 0, 0];
  const all = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = along[y * w + x] / period;
      const b = Math.min(STRIPE_PHASES - 1, Math.floor((q - Math.floor(q)) * STRIPE_PHASES));
      const i = ((y0 + y) * px.width + x0 + x) * 4;
      all[0] += px.data[i];
      all[1] += px.data[i + 1];
      all[2] += px.data[i + 2];
      if (!core(b)) continue;
      const t = bright[b] === lineBright ? ink : ground;
      t[0] += px.data[i];
      t[1] += px.data[i + 1];
      t[2] += px.data[i + 2];
      t[3]++;
    }
  }
  if (ink[3] === 0 || ground[3] === 0) return null;
  const inkRgb = ink.slice(0, 3).map((v) => v / ink[3]);
  const groundRgb = ground.slice(0, 3).map((v) => v / ground[3]);
  // The line's share of the period: how far the region's mean sits from the
  // ground towards the line, so lines thinner than a phase still measure.
  let num = 0;
  let den = 0;
  for (let ch = 0; ch < 3; ch++) {
    const d = inkRgb[ch] - groundRgb[ch];
    num += (all[ch] / n - groundRgb[ch]) * d;
    den += d * d;
  }
  const lineShare = Math.max(0, Math.min(1, num / den));
  const angle = theta <= -90 ? theta + 180 : theta;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    angle: Math.round(angle),
    width: r1(period * lineShare * unit),
    gap: r1(period * (1 - lineShare) * unit),
    line: hexOf(inkRgb[0], inkRgb[1], inkRgb[2]),
    ground: hexOf(groundRgb[0], groundRgb[1], groundRgb[2]),
  };
}
