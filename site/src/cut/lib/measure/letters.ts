/** How a line of type comes in letter by letter: each letter's column read
 * frame by frame — when it shows, where it starts, when it lands, how solid
 * it is on the way — and what the whole entrance comes to as one per-letter
 * edge (order, length, hand-off, distance, ease, fade). Also which side of
 * other ink the letters pass: in front of a line they cross, or behind it.
 * Pure pixel math over a picture's frames; sourceMeasure.ts reads them. */

import { easeAt, EASE_IDS, type EaseId } from "@donkeycut/effects-kit";
import type { PixelRect, Pixels, Rgb } from "./color";

export interface LetterFrame extends Pixels {
  t: number;
}

/** A pixel counts as the letter's ink when it sits at least this far from the
 * ground toward the letter's colour: a soft fade's early frames and a motion
 * blur's tail both still read. */
const INK_MIX = 0.2;
/** …and strays no further than this off the line between the two colours. */
const INK_OFF = 60;
/** A pixel this far toward the letter's colour counts toward its mass. */
const MASS_MIX = 0.06;
/** The reaches tried, as multiples of the distance past the picture's edge. */
const REACHES = [1, 1.25, 1.5, 2, 3];
/** The softest defocus tried, px of the picture as read. */
const SOFT_MAX = 20;
/** A frame names the far end's defocus while this much of it is left. */
const SOFT_LEFT = 0.15;
/** A defocus under this, design px, reads as sharp. */
const SOFT_MIN = 2;
/** Rows either side of its measured place a frame's letter is matched at. */
const SOFT_SHIFT = 6;
/** Frames per letter matched for its softness and opacity. */
const SOFT_FRAMES = 6;
/** The shortest and longest one-letter move the fit tries, seconds. */
const FIT_MIN = 0.1;
const FIT_MAX = 3;
/** The ground is never a colour this close to the letters'. */
const GROUND_CLEAR = 80;
/** A row of a letter's column holds ink when this many of its pixels do. */
const ROW_INK = 2;
/** A letter is at rest within this many pixels of where it settles. */
const REST_PX = 1.5;
/** A moving letter's ink runs up to this many times its height: its streak. */
const TALL = 1.6;
/** Other ink a letter's box must cross, summed over frames, to call a side. */
const PASS_MIN = 30;
/** How far, px, a stroke of other ink stands off its surroundings. */
const MARK = 6;
/** Share of the crossed ink a letter's colour must take to be in front. */
const FRONT_SHARE = 0.15;
/** A letter rolls on a reel when this many of its frames show two characters
 * in its column at once. */
const REEL_FRAMES = 2;
/** A run this share of the letter's rest height or more is a whole character
 * on the reel; a shorter one is cut by the band. */
const REEL_WHOLE = 0.85;
/** A reel character whose strongest pixels reach this share of the letter's
 * colour is solid, not faded. */
const REEL_SOLID = 0.85;

export interface LetterTiming {
  char: string;
  /** Its place among the line's letters, counted from 0, spaces skipped. */
  index: number;
  /** When it first shows, when its move starts (a letter coming in from past
   * the picture's edge started before it showed), and when it lands. */
  shows: number | null;
  starts: number | null;
  lands: number | null;
  /** Where it first shows, design px from rest (+ is below or right). */
  from: number | null;
  /** Its opacity on the first frame it fully shows, 0..1. */
  alpha: number | null;
  /** How soft it is on that frame, design px of defocus. */
  soft: number | null;
  ease: EaseId | null;
  error: number | null;
}

export interface LetterPass {
  /** The other ink's colour and box (pixels of the picture). */
  color: Rgb;
  box: PixelRect;
  /** The letters' side of it: they cover it, or it covers them. */
  letters: "front" | "behind";
  pixels: number;
}

export interface LetterRead {
  letters: LetterTiming[];
  /** The whole entrance as one per-letter edge, when every letter came in. */
  edge: {
    /** Letter indices in the order their moves start. */
    sequence: number[];
    /** When each of them starts, as a share of the hand-off: 0 the first, 1
     * the last — a reference's letters seldom go evenly spaced. */
    sequenceAt: number[];
    seconds: number;
    stagger: number;
    /** The first letter's move starts here: where the title's ramp begins. */
    start: number;
    /** One letter's move, the median. */
    move: number;
    distance: number;
    direction: "down" | "up" | "none";
    ease: EaseId | null;
    /** false: solid all the way; a share of the move: it fades up over that
     * much of it; true: over the whole move. */
    fade: boolean | number;
    /** Defocus at the far end, design px, clearing on the move's curve. */
    blur: number;
    /** The letters roll in on a slot reel: which way it turns (read off how
     * each letter arrives at its slot, since a fast spin aliases between
     * frames), how far apart its characters sit and how far its band reaches
     * either side of the line's middle (design px), how far each lands past
     * its slot (design px) and the share of its move spent settling back. */
    reel?: { dir: "up" | "down"; pitch: number; band: number; overshoot: number; settle: number | null };
    /** The letters appear where they stand, no move: typed, one character's
     * turn every seconds ÷ characters, the spaces taking theirs. */
    typed?: boolean;
  } | null;
  passes: LetterPass[];
}

const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const at = (px: Pixels, x: number, y: number): Rgb => {
  const i = (y * px.width + x) * 4;
  return [px.data[i], px.data[i + 1], px.data[i + 2]];
};
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** The colour most of `rect` is, the letters' own colour aside: the ground.
 * Quantized so a flat fill wins; a seed close around solid letters over a
 * gradient holds more of the letters' colour than of any one shade of it. */
function groundOf(px: Pixels, rect: PixelRect, ink: Rgb): Rgb {
  const counts = new Map<number, { n: number; sum: [number, number, number] }>();
  const step = Math.max(1, Math.floor((rect.w * rect.h) / 4000));
  let k = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (k++ % step) continue;
      const c = at(px, x, y);
      if (dist(c, ink) < GROUND_CLEAR) continue;
      const key = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
      const e = counts.get(key) ?? { n: 0, sum: [0, 0, 0] };
      e.n++;
      e.sum[0] += c[0];
      e.sum[1] += c[1];
      e.sum[2] += c[2];
      counts.set(key, e);
    }
  let best = { n: 0, sum: [0, 0, 0] as [number, number, number] };
  for (const e of counts.values()) if (e.n > best.n) best = e;
  return best.sum.map((v) => v / Math.max(1, best.n)) as Rgb;
}

/** How far `c` sits from `ground` toward `ink`, 0..1, or -1 when it is off
 * the line between them — some other colour. */
function mixOf(c: Rgb, ground: Rgb, ink: Rgb): number {
  const d = [ink[0] - ground[0], ink[1] - ground[1], ink[2] - ground[2]];
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  if (len2 < 1) return -1;
  const v = [c[0] - ground[0], c[1] - ground[1], c[2] - ground[2]];
  const m = (v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) / len2;
  const off = Math.hypot(v[0] - m * d[0], v[1] - m * d[1], v[2] - m * d[2]);
  return off > INK_OFF ? -1 : Math.max(0, Math.min(1, m));
}

/** The letter's ink in one column: its rows' box (the run holding the most
 * ink, with the pieces of it within `tall` rows) and its mass, the sum of
 * every pixel's share of the letter's colour — a blur spreads it over more
 * rows and keeps it, a fade thins it. Null when it is not there. */
function columnInk(px: Pixels, x0: number, x1: number, ink: Rgb, tall = 0): { y0: number; y1: number; mass: number } | null {
  const ground = groundOf(px, { x: x0, y: 0, w: x1 - x0, h: px.height }, ink);
  if (dist(ground, ink) < 30) return null;
  const rows: number[] = [];
  const mass: number[] = [];
  for (let y = 0; y < px.height; y++) {
    let n = 0;
    let m = 0;
    for (let x = x0; x < x1; x++) {
      const v = mixOf(at(px, x, y), ground, ink);
      if (v >= INK_MIX) n++;
      if (v >= MASS_MIX) m += v;
    }
    rows.push(n);
    mass.push(m);
  }
  // Runs of inked rows, a one-row gap bridged (a letter's crossbar gap).
  const runs: { y0: number; y1: number; total: number }[] = [];
  let y = 0;
  while (y < rows.length) {
    if (rows[y] < ROW_INK) {
      y++;
      continue;
    }
    let e = y;
    let total = 0;
    while (e < rows.length && (rows[e] >= ROW_INK || (e + 1 < rows.length && rows[e + 1] >= ROW_INK))) total += rows[e++];
    runs.push({ y0: y, y1: e, total });
    y = e;
  }
  let best = runs.reduce<(typeof runs)[number] | null>((b, r) => (!b || r.total > b.total ? r : b), null);
  if (!best || best.total < 6) return null;
  // Something drawn over the letter cuts it in two: the runs either side
  // that still fit inside one letter's height are the same letter.
  if (tall)
    for (const r of [...runs].sort((a, b) => Math.abs(a.y0 - best!.y0) - Math.abs(b.y0 - best!.y0))) {
      const y0 = Math.min(best.y0, r.y0);
      const y1 = Math.max(best.y1, r.y1);
      if (r !== best && y1 - y0 <= tall) best = { y0, y1, total: best.total + r.total };
    }
  // The blur's faint tails, however long, carry mass too: the column's own.
  const sum = mass.reduce((a, m) => a + m, 0);
  return { y0: best.y0, y1: best.y1, mass: sum };
}

/** Every run of inked rows in one column, a one-row gap bridged, with the
 * strongest share of the letter's colour any of its pixels reach: the
 * characters a reel shows there at once. */
function columnRuns(px: Pixels, x0: number, x1: number, ink: Rgb): { y0: number; y1: number; peak: number }[] {
  const ground = groundOf(px, { x: x0, y: 0, w: x1 - x0, h: px.height }, ink);
  if (dist(ground, ink) < 30) return [];
  const rows: number[] = [];
  const peaks: number[] = [];
  for (let y = 0; y < px.height; y++) {
    let n = 0;
    let peak = 0;
    for (let x = x0; x < x1; x++) {
      const v = mixOf(at(px, x, y), ground, ink);
      if (v >= INK_MIX) n++;
      peak = Math.max(peak, v);
    }
    rows.push(n);
    peaks.push(peak);
  }
  const runs: { y0: number; y1: number; peak: number }[] = [];
  let y = 0;
  while (y < rows.length) {
    if (rows[y] < ROW_INK) {
      y++;
      continue;
    }
    let e = y;
    let peak = 0;
    while (e < rows.length && (rows[e] >= ROW_INK || (e + 1 < rows.length && rows[e + 1] >= ROW_INK))) peak = Math.max(peak, peaks[e++]);
    // A sliver of a few rows is a character's edge leaving the band.
    if (e - y >= 3) runs.push({ y0: y, y1: e, peak });
    y = e;
  }
  return runs;
}

/** The letters' columns on the settled frame: runs of columns holding ink,
 * left to right — a letter's pieces (an i's dot) share one. */
function columnsOf(px: Pixels, region: PixelRect, ink: Rgb, count: number): { x0: number; x1: number; y0: number; y1: number }[] {
  const ground = groundOf(px, region, ink);
  const inked = (x: number, y: number) => mixOf(at(px, x, y), ground, ink) >= 0.5;
  // Each column of the region: how many of its pixels are ink, and where.
  const xs = Array.from({ length: Math.max(0, region.w) }, (_, k) => {
    const x = region.x + k;
    let n = 0;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let y = region.y; y < region.y + region.h; y++)
      if (inked(x, y)) {
        n++;
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y + 1);
      }
    return { n, y0, y1 };
  });
  const span = (k0: number, k1: number) => ({
    x0: region.x + k0,
    x1: region.x + k1,
    y0: Math.min(
      ...xs
        .slice(k0, k1)
        .filter((c) => c.n)
        .map((c) => c.y0),
    ),
    y1: Math.max(
      ...xs
        .slice(k0, k1)
        .filter((c) => c.n)
        .map((c) => c.y1),
    ),
  });
  let runs: [number, number][] = [];
  for (let k = 0; k < xs.length; k++) {
    if (!xs[k].n) continue;
    let e = k;
    while (e < xs.length && xs[e].n) e++;
    runs.push([k, e]);
    k = e;
  }
  // A sliver is noise, not a letter.
  const wide = median(runs.map(([k0, k1]) => k1 - k0));
  runs = runs.filter(([k0, k1]) => k1 - k0 >= Math.max(2, wide * 0.15));
  // Letters set tight touch: split the widest run at its thinnest column, away
  // from its edges, until there are as many as the line has letters.
  while (runs.length > 0 && runs.length < count) {
    const at = runs.reduce((w, r, i) => (r[1] - r[0] > runs[w][1] - runs[w][0] ? i : w), 0);
    const [k0, k1] = runs[at];
    if (k1 - k0 < 4) break;
    let cut = -1;
    for (let k = k0 + Math.ceil((k1 - k0) * 0.2); k < k1 - Math.ceil((k1 - k0) * 0.2); k++) if (cut < 0 || xs[k].n < xs[cut].n) cut = k;
    if (cut < 0) break;
    runs.splice(at, 1, [k0, cut], [cut + 1, k1]);
  }
  return runs.map(([k0, k1]) => span(k0, k1));
}

/** Each ease sampled once, read back between samples: the fit asks for
 * millions of points, and solving a bezier for each is the slow part. */
const CURVE_STEPS = 1024;
const curves = new Map<EaseId, Float64Array>();
function curveOf(ease: EaseId): Float64Array {
  let c = curves.get(ease);
  if (!c) {
    c = new Float64Array(CURVE_STEPS + 1);
    for (let k = 0; k <= CURVE_STEPS; k++) c[k] = easeAt(ease, k / CURVE_STEPS);
    curves.set(ease, c);
  }
  return c;
}

/** One letter's frames as the fit reads them: where it was (px from rest)
 * on each frame it showed, and the frames before that it did not. */
interface Track {
  seen: { t: number; v: number }[];
  hidden: number[];
  /** How far from rest it is wholly past the picture's edge, px. */
  edge: number;
  /** Rest height, px: a miss is capped at half of it, so a frame where
   * something else crossed the column cannot drag the fit. */
  h: number;
}

/** The squared miss of a letter moving `d` px (signed: − comes from above)
 * on `ease` from t0 over `secs`, against its frames. */
function missOf(tr: Track, d: number, ease: EaseId, t0: number, secs: number): number {
  const cap = (tr.h / 2) ** 2;
  const curve = curveOf(ease);
  const pos = (t: number) => {
    const p = (t - t0) / secs;
    if (p <= 0) return d;
    if (p >= 1) return 0;
    const f = p * CURVE_STEPS;
    const k = Math.floor(f);
    return d * (1 - (curve[k] + (curve[k + 1] - curve[k]) * (f - k)));
  };
  let sq = 0;
  for (const p of tr.seen) sq += Math.min(cap, (pos(p.t) - p.v) ** 2);
  // Before it showed it was out of the picture, past its edge.
  for (const t of tr.hidden) {
    const short = tr.edge - 1 - Math.abs(pos(t));
    if (short > 0) sq += Math.min(cap, short * short);
  }
  return sq;
}

/** The best start and length for one letter on one distance and ease:
 * a coarse grid, then a fine one around its best. No move starts before
 * `earliest`, the source's first frame: a title cannot start before it, and
 * a letter come in from past the edge fits a longer, earlier move from
 * further off just as well. */
function fitTrack(tr: Track, d: number, ease: EaseId, step: number, earliest: number): { t0: number; secs: number; sq: number } {
  const shows = tr.seen[0].t;
  let best = { t0: shows, secs: 0.5, sq: Infinity };
  const search = (secsLo: number, secsHi: number, dSecs: number, t0Of: (secs: number) => [number, number], dT: number) => {
    for (let secs = secsLo; secs <= secsHi + 1e-9; secs += dSecs) {
      if (secs < FIT_MIN) continue;
      const [lo, hi] = t0Of(secs);
      for (let t0 = Math.max(earliest, lo); t0 <= hi + 1e-9; t0 += dT) {
        const sq = missOf(tr, d, ease, t0, secs);
        if (sq < best.sq) best = { t0, secs, sq };
      }
    }
  };
  search(FIT_MIN, FIT_MAX, 0.05, (secs) => [shows - secs, shows], step);
  const c = best;
  search(c.secs - 0.05, c.secs + 0.05, 0.005, () => [c.t0 - step, c.t0 + step], step / 8);
  return best;
}

/** A letter at rest: its share of its colour, pixel by pixel, on the last
 * frame, and where it sits. */
interface Sprite {
  data: Float32Array;
  w: number;
  h: number;
  x0: number;
  y0: number;
  /** The sprite blurred at each defocus tried, padded by the blur's reach. */
  blurred: Map<number, Float32Array>;
}

/** A sprite defocused by `sigma` px, worked out once per sprite. */
function blurredSprite(sprite: Sprite, sigma: number): Float32Array {
  const hit = sprite.blurred.get(sigma);
  if (hit) return hit;
  const r = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: 2 * r + 1 }, (_, k) => (sigma > 0 ? Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)) : 1));
  const ksum = kernel.reduce((a, b) => a + b, 0);
  // The sprite padded by the blur's reach, blurred one way then the other.
  const w = sprite.w + 2 * r;
  const h = sprite.h + 2 * r;
  const rowPass = new Float32Array(w * h);
  for (let y = 0; y < sprite.h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) {
        const sx = x - r + k;
        if (sx >= 0 && sx < sprite.w) v += sprite.data[y * sprite.w + sx] * kernel[k + r];
      }
      rowPass[(y + r) * w + x] = v / ksum;
    }
  const blurred = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) {
        const sy = y + k;
        if (sy >= 0 && sy < h) v += rowPass[sy * w + x] * kernel[k + r];
      }
      blurred[y * w + x] = v / ksum;
    }
  sprite.blurred.set(sigma, blurred);
  return blurred;
}

/** One frame of a letter matched against its own rest pose: the defocus
 * (px) and opacity that, laid at `offset` px from rest, best make that
 * frame's column. Each try blurs the rest pose, places it and scales it. */
function softnessOf(px: Pixels, sprite: Sprite, offset: number, ink: Rgb): { sigma: number; alpha: number } {
  const ground = groundOf(
    px,
    {
      x: sprite.x0,
      y: 0,
      w: sprite.w,
      h: px.height,
    },
    ink,
  );
  // The frame's column as shares of the letter's colour, read once; -1 where
  // some other colour is (a line the letter crosses), which says nothing.
  const obsAll = new Float32Array(sprite.w * px.height);
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < sprite.w; x++) obsAll[y * sprite.w + x] = mixOf(at(px, sprite.x0 + x, y), ground, ink);
  const obs = (x: number, y: number) => (y < 0 || y >= px.height ? 0 : obsAll[y * sprite.w + x]);
  // Every try is scored over the same rows — the letter plus the softest
  // blur's reach — so a wider blur is not charged for more of the frame.
  const reach = Math.ceil(SOFT_MAX * 3);
  let best = { sigma: 0, alpha: 1, err: Infinity };
  for (let shift = -SOFT_SHIFT; shift <= SOFT_SHIFT; shift++) {
    const base = Math.round(sprite.y0 + offset) + shift;
    let oo = 0;
    for (let y = base - reach; y < base + sprite.h + reach; y++) for (let x = 0; x < sprite.w; x++) oo += Math.max(0, obs(x, y)) ** 2;
    for (let sigma = 0; sigma <= SOFT_MAX; sigma += 0.5) {
      const r = Math.ceil(sigma * 3);
      const w = sprite.w + 2 * r;
      const h = sprite.h + 2 * r;
      const blurred = blurredSprite(sprite, sigma);
      // The column only: the blur spilling past it is a neighbour's to read.
      let sb = 0;
      let bb = 0;
      for (let y = 0; y < h; y++)
        for (let x = r; x < r + sprite.w; x++) {
          const o = obs(x - r, base - r + y);
          if (o < 0) continue;
          const b = blurred[y * w + x];
          sb += o * b;
          bb += b * b;
        }
      if (bb <= 0) continue;
      const alpha = Math.max(0, Math.min(1, sb / bb));
      const err = oo - 2 * alpha * sb + alpha * alpha * bb;
      if (err < best.err) best = { sigma, alpha, err };
    }
  }
  return { sigma: best.sigma, alpha: best.alpha };
}

/** Read how `text`'s letters come in over `frames` (the picture's frames in
 * order, the last with every letter at rest), the line sitting inside
 * `region` on that last frame in `ink`. `unit` is design px per pixel. Each
 * letter's frames are fitted with a move from past the picture's edge (or
 * further) on one of the editor's eases, one distance and ease for the line,
 * so the edge it hands back plays the same frames. */
export function readLetters(
  frames: LetterFrame[],
  opts: { text: string; region: PixelRect; ink: Rgb; unit: number; earliest?: number },
): LetterRead {
  const chars = [...opts.text].filter((c) => c.trim());
  const last = frames[frames.length - 1];
  // Whole pixels inside the frame: a frame box lands on fractions of one.
  const x0 = Math.max(0, Math.floor(opts.region.x));
  const y0 = Math.max(0, Math.floor(opts.region.y));
  const region = {
    x: x0,
    y: y0,
    w: Math.max(0, Math.min(last.width, Math.ceil(opts.region.x + opts.region.w)) - x0),
    h: Math.max(0, Math.min(last.height, Math.ceil(opts.region.y + opts.region.h)) - y0),
  };
  const cols = columnsOf(last, region, opts.ink, chars.length);
  if (cols.length !== chars.length)
    throw new Error(
      `Found ${cols.length} letter${cols.length === 1 ? "" : "s"} of that colour in the region on the last frame, and "${opts.text}" has ${chars.length}. ` +
        "Pass `to` at a moment every letter has landed and none has left, and a seed close around the line.",
    );
  const step = frames.length > 1 ? median(frames.slice(1).map((f, i) => f.t - frames[i].t)) : 1 / 30;

  // Letters rolling in on a slot reel show two characters in a column at
  // once; that is read as a reel, not fitted as a move.
  const reel = readReel(frames, cols, chars, opts.ink, opts.unit);
  if (reel) return { ...reel, passes: [] };

  // Each letter's frames: where it shows, and how solid.
  const reads = cols.map((c) => {
    const rest = columnInk(last, c.x0, c.x1, opts.ink);
    const restMid = rest ? (rest.y0 + rest.y1) / 2 : (c.y0 + c.y1) / 2;
    const restH = rest ? rest.y1 - rest.y0 : c.y1 - c.y0;
    const series = frames.map((f) => {
      const k = columnInk(f, c.x0, c.x1, opts.ink, restH * TALL);
      if (!k) return null;
      // A letter cut by the picture's edge is placed by its far side.
      const cut = k.y0 <= 0 || k.y1 >= f.height;
      const offset =
        k.y0 <= 0 ? k.y1 - (restMid + restH / 2) : k.y1 >= f.height ? k.y0 - (restMid - restH / 2) : (k.y0 + k.y1) / 2 - restMid;
      return { offset, mass: k.mass, cut };
    });
    const first = series.findIndex((s) => s !== null);
    // The letter at rest, its share of its colour pixel by pixel: what each
    // frame is matched against for how soft and how solid it is.
    const ground = groundOf(
      last,
      {
        x: c.x0,
        y: 0,
        w: c.x1 - c.x0,
        h: last.height,
      },
      opts.ink,
    );
    const y0 = Math.max(0, Math.floor(restMid - restH / 2) - 1);
    const sh = Math.min(last.height - y0, Math.ceil(restH) + 2);
    const sprite: Sprite = {
      data: new Float32Array((c.x1 - c.x0) * sh),
      w: c.x1 - c.x0,
      h: sh,
      x0: c.x0,
      y0,
      blurred: new Map(),
    };
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sprite.w; x++) sprite.data[y * sprite.w + x] = Math.max(0, mixOf(at(last, c.x0 + x, y0 + y), ground, opts.ink));
    return {
      first,
      series,
      sprite,
      above: restMid + restH / 2,
      below: last.height - (restMid - restH / 2),
      h: restH,
    };
  });
  const shown = reads.filter((r) => r.first >= 0);
  const firstOffsets = shown.map((r) => r.series[r.first]!.offset);
  const down = median(firstOffsets) < 0;
  const travels = median(firstOffsets.map(Math.abs)) > REST_PX * 2;
  const tracks: (Track | null)[] = reads.map((r) =>
    r.first < 0
      ? null
      : {
          seen: r.series.flatMap((s, i) => (i >= r.first && s ? [{ t: frames[i].t, v: s.offset }] : [])),
          hidden: frames.slice(0, r.first).map((f) => f.t),
          edge: down ? r.above : r.below,
          h: r.h,
        },
  );

  // One distance and one ease for the whole line: the pair whose best fits
  // miss least, letter for letter.
  const sign = down ? -1 : 1;
  const edgePx = median(tracks.filter((t): t is Track => t !== null).map((t) => t.edge));
  let pick: {
    d: number;
    ease: EaseId;
    fits: ({ t0: number; secs: number; sq: number } | null)[];
    sq: number;
  } | null = null;
  if (travels && tracks.every((t) => t !== null))
    for (const k of REACHES)
      for (const ease of EASE_IDS) {
        const d = sign * edgePx * k;
        const fits = tracks.map((t) => fitTrack(t!, d, ease, step, opts.earliest ?? 0));
        const sq = fits.reduce((a, f) => a + f.sq, 0);
        // A longer reach has to fit clearly better to win over the edge.
        if (!pick || sq < pick.sq * 0.97) pick = { d, ease, fits, sq };
      }

  // How soft and how solid each letter is on its way in, at a few frames of
  // its move: its defocus fitted on the move's curve, its opacity against
  // the share of the move it has made (a fade rises with it).
  const looks = reads.map((r, index) => {
    const fit = pick?.fits[index];
    const along = (t: number) => (fit ? (t - fit.t0) / fit.secs : 0);
    const moving = r.series.flatMap((s, i) => {
      const p = along(frames[i].t);
      return s && !s.cut && p > 0.02 && p < 0.9 ? [i] : [];
    });
    const picked =
      moving.length <= SOFT_FRAMES
        ? moving
        : Array.from({ length: SOFT_FRAMES }, (_, k) => moving[Math.round((k * (moving.length - 1)) / (SOFT_FRAMES - 1))]);
    const out = picked.map((i) => ({
      p: along(frames[i].t),
      ...softnessOf(frames[i], r.sprite, r.series[i]!.offset, opts.ink),
    }));
    return out;
  });

  const letters: LetterTiming[] = reads.map((r, index) => {
    const fit = pick?.fits[index];
    const tr = tracks[index];
    const shows = r.first >= 0 ? frames[r.first].t : null;
    const look = looks[index][0];
    return {
      char: chars[index],
      index,
      shows,
      starts: fit ? fit.t0 : shows,
      lands: fit ? fit.t0 + fit.secs : shows,
      from: pick ? pick.d * opts.unit : r.first >= 0 ? r.series[r.first]!.offset * opts.unit : null,
      alpha: look ? look.alpha : null,
      soft: look ? look.sigma * opts.unit : null,
      ease: pick ? pick.ease : null,
      error: fit && tr ? Math.sqrt(fit.sq / Math.max(1, tr.seen.length + tr.hidden.length)) / Math.max(1, Math.abs(pick!.d)) : null,
    };
  });

  let edge: LetterRead["edge"] = null;
  if (pick) {
    const order = [...letters].sort((a, b) => a.starts! - b.starts! || a.index - b.index);
    const start = order[0].starts!;
    const span = order[order.length - 1].starts! - start;
    const move = median(pick.fits.map((f) => f!.secs));
    const seconds = span + move;
    // Defocus B at the far end clears as B × (1 − ease(p)), so each frame
    // still well short of sharp names a B — their median, as a frame where a
    // neighbour's fall crossed the column misreads and is outvoted.
    const all = looks.flat();
    const named = all.flatMap((l) => {
      const left = 1 - easeAt(pick!.ease, l.p);
      return left > SOFT_LEFT ? [l.sigma / left] : [];
    });
    const blur = named.length > 0 ? median(named) * opts.unit : 0;
    // How long the fade runs: opacity min(1, p / k) over the share k of the
    // move that misses the frames least — 0 is solid, 1 the whole move.
    let fade: boolean | number = true;
    let fadeMiss = Infinity;
    for (let k = 0; k <= 1 + 1e-9; k += 0.05) {
      const miss = all.reduce((a, l) => a + (l.alpha - (k > 0 ? Math.min(1, l.p / k) : 1)) ** 2, 0);
      if (miss < fadeMiss - 1e-9) {
        fadeMiss = miss;
        fade = k < 0.05 ? false : k > 0.95 ? true : Math.round(k * 100) / 100;
      }
    }
    edge = {
      sequence: order.map((l) => l.index),
      sequenceAt: order.map((l) => (span > 0 ? (l.starts! - start) / span : 0)),
      seconds,
      stagger: seconds > 0 ? span / seconds : 0,
      start,
      move,
      distance: Math.abs(pick.d) * opts.unit,
      direction: down ? "down" : "up",
      ease: pick.ease,
      fade,
      blur: blur < SOFT_MIN ? 0 : blur,
    };
  }

  // Letters that appear where they stand were typed: the typed share passes
  // glyph g of n at start + seconds × g / n (the spaces take turns too), and
  // each shows on the frame after.
  if (!edge && !travels && letters.every((l) => l.shows !== null)) {
    const glyphs: number[] = [];
    [...opts.text].forEach((c, gi) => {
      if (c.trim()) glyphs.push(gi);
    });
    const n = [...opts.text].length;
    const xs = glyphs;
    const ys = letters.map((l) => l.shows!);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const slope = sxx > 0 ? xs.reduce((a, x, k) => a + (x - mx) * (ys[k] - my), 0) / sxx : 0;
    const start = my - slope * mx - step / 2;
    const seconds = Math.max(step, slope * n);
    edge = {
      sequence: letters.map((l) => l.index),
      sequenceAt: letters.map((_, k) => (letters.length > 1 ? k / (letters.length - 1) : 0)),
      seconds,
      stagger: 0,
      start,
      move: 0,
      distance: 0,
      direction: "none",
      ease: null,
      fade: false,
      blur: 0,
      typed: true,
    };
  }

  return { letters, edge, passes: passesOf(frames, cols, opts.ink) };
}

/** How a line rolls in on a slot reel, or null when its letters do not: on
 * enough of their frames, two characters show in one column at once. */
function readReel(
  frames: LetterFrame[],
  cols: { x0: number; x1: number; y0: number; y1: number }[],
  chars: string[],
  ink: Rgb,
  unit: number,
): Omit<LetterRead, "passes"> | null {
  const last = frames[frames.length - 1];
  const per = cols.map((c) => {
    const rest = columnInk(last, c.x0, c.x1, ink);
    const mid = rest ? (rest.y0 + rest.y1) / 2 : (c.y0 + c.y1) / 2;
    const h = rest ? rest.y1 - rest.y0 : c.y1 - c.y0;
    return { mid, h, runs: frames.map((f) => columnRuns(f, c.x0, c.x1, ink)) };
  });
  // Two characters in sight reach further than one letter can, even one cut
  // in two by a line drawn over it or streaking along its fall.
  const twoInSight = (p: (typeof per)[number], runs: { y0: number; y1: number }[]) =>
    runs.length >= 2 && Math.max(...runs.map((r) => r.y1)) - Math.min(...runs.map((r) => r.y0)) > p.h * TALL;
  const rolls = per.filter((p) => p.runs.filter((r) => twoInSight(p, r)).length >= REEL_FRAMES).length;
  if (rolls < Math.ceil(cols.length / 2)) return null;

  const reads = per.map((p) => {
    const whole = (r: { y0: number; y1: number }) => r.y1 - r.y0 >= p.h * REEL_WHOLE;
    // Where the run nearest the slot sits, px from rest (+ below); one cut by
    // the band is placed by its uncut side.
    const offsetOf = (r: { y0: number; y1: number }) =>
      whole(r) ? (r.y0 + r.y1) / 2 - p.mid : r.y0 < p.mid - p.h / 2 ? r.y1 - (p.mid + p.h / 2) : r.y0 - (p.mid - p.h / 2);
    const nearest = (runs: { y0: number; y1: number }[]) =>
      runs.reduce<{ y0: number; y1: number } | null>((b, r) => (!b || Math.abs(offsetOf(r)) < Math.abs(offsetOf(b)) ? r : b), null);
    const shows = p.runs.findIndex((r) => r.length > 0);
    const multi = p.runs.flatMap((r, i) => (twoInSight(p, r) ? [i] : []));
    // The spacing: a whole character's top to the next one's top, or a whole
    // character's bottom to the one above's bottom (a band cuts the far side).
    const pitches: number[] = [];
    const peaks: number[] = [];
    for (const i of multi) {
      const runs = [...p.runs[i]].sort((a, b) => a.y0 - b.y0);
      for (let k = 1; k < runs.length; k++) {
        const a = runs[k - 1];
        const b = runs[k];
        const d = whole(a) ? b.y0 - a.y0 : whole(b) ? b.y1 - a.y1 : 0;
        if (d >= p.h) pitches.push(d);
      }
      for (const r of runs) if (whole(r)) peaks.push(r.peak);
    }
    // The band: as far from the slot as any character ever shows.
    let band = p.h / 2;
    for (const runs of p.runs) for (const r of runs) band = Math.max(band, p.mid - r.y0, r.y1 - p.mid);
    // The landing: which side the character nearest its slot arrives from on
    // the last frame with two in sight, then how far past it runs and when
    // it is still.
    const lastMulti = multi.length ? multi[multi.length - 1] : shows;
    const near = lastMulti >= 0 ? nearest(p.runs[lastMulti]) : null;
    const dir: "up" | "down" = near && offsetOf(near) < 0 ? "down" : "up";
    const sign = dir === "down" ? 1 : -1;
    let peak = 0;
    let peakAt = lastMulti;
    const after: { i: number; o: number }[] = [];
    for (let i = Math.max(0, lastMulti + 1); i < frames.length; i++) {
      const r = nearest(p.runs[i]);
      if (!r) continue;
      const o = offsetOf(r);
      after.push({ i, o });
      if (sign * o > peak) {
        peak = sign * o;
        peakAt = i;
      }
    }
    const overshoot = peak > REST_PX * 2 ? peak : 0;
    const showsT = shows >= 0 ? frames[shows].t : null;
    // Settling back glides in and out, so it is halfway home halfway
    // through: that crossing, between frames, times it better than the
    // moment it looks still.
    let landsT: number | null = null;
    if (overshoot) {
      const k = after.findIndex((a) => a.i > peakAt && sign * a.o <= overshoot / 2);
      if (k > 0) {
        const a = after[k - 1];
        const b = after[k];
        const half = frames[a.i].t + ((sign * a.o - overshoot / 2) / Math.max(1e-6, sign * (a.o - b.o))) * (frames[b.i].t - frames[a.i].t);
        landsT = frames[peakAt].t + 2 * (half - frames[peakAt].t);
      }
    }
    if (landsT === null) {
      const still = after.find((a, k) => a.i > lastMulti && after.slice(k).every((b) => Math.abs(b.o) <= REST_PX * 2));
      landsT = still ? frames[still.i].t : showsT;
    }
    const settle =
      overshoot && showsT !== null && landsT !== null && landsT > showsT ? (landsT - frames[peakAt].t) / (landsT - showsT) : null;
    return { showsT, landsT, pitches, peaks, band, dir, overshoot, settle };
  });

  const letters: LetterTiming[] = reads.map((r, index) => ({
    char: chars[index],
    index,
    shows: r.showsT,
    starts: r.showsT,
    lands: r.landsT,
    from: null,
    alpha: r.peaks.length ? Math.min(1, median(r.peaks)) : null,
    soft: null,
    ease: null,
    error: null,
  }));
  if (letters.some((l) => l.shows === null || l.lands === null)) return { letters, edge: null };
  const order = [...letters].sort((a, b) => a.starts! - b.starts! || a.index - b.index);
  const first = order[0].starts!;
  const span = order[order.length - 1].starts! - first;
  const move = median(letters.map((l) => l.lands! - l.starts!));
  const seconds = span + move;
  // A reel first shows on the frame after its turn begins.
  const step = frames.length > 1 ? median(frames.slice(1).map((f, i) => f.t - frames[i].t)) : 1 / 30;
  const start = first - step / 2;
  const downs = reads.filter((r) => r.dir === "down").length;
  const settles = reads.flatMap((r) => (r.settle !== null ? [r.settle] : []));
  const peaks = reads.flatMap((r) => r.peaks);
  return {
    letters,
    edge: {
      sequence: order.map((l) => l.index),
      sequenceAt: order.map((l) => (span > 0 ? (l.starts! - first) / span : 0)),
      seconds,
      stagger: seconds > 0 ? span / seconds : 0,
      start,
      move,
      distance: 0,
      direction: "none",
      ease: null,
      fade: peaks.length > 0 && median(peaks) >= REEL_SOLID ? false : true,
      blur: 0,
      reel: {
        dir: downs * 2 >= reads.length ? "down" : "up",
        pitch: median(reads.flatMap((r) => r.pitches)) * unit,
        band: median(reads.map((r) => r.band)) * unit,
        overshoot: median(reads.map((r) => r.overshoot)) * unit,
        settle: settles.length ? median(settles) : null,
      },
    },
  };
}
/** Which side of other ink the moving letters pass. The other ink is read off
 * the last frame inside the letters' columns, above and below the line; on
 * each frame a moving letter's box covers some of it, and each covered pixel
 * reads as the letter's colour (the letter in front) or not (behind). */
function passesOf(frames: LetterFrame[], cols: { x0: number; x1: number; y0: number; y1: number }[], ink: Rgb): LetterPass[] {
  const last = frames[frames.length - 1];
  const ground = groundOf(last, { x: 0, y: 0, w: last.width, h: last.height }, ink);
  // Other ink: neither ground nor the letters' colour, in the letters' columns.
  const other = new Uint8Array(last.width * last.height);
  let box: PixelRect | null = null;
  const colour = [0, 0, 0];
  let n = 0;
  for (const c of cols)
    for (let y = 0; y < last.height; y++)
      for (let x = c.x0; x < c.x1; x++) {
        const p = at(last, x, y);
        if (dist(p, ground) < 60 || dist(p, ink) < 60 || mixOf(p, ground, ink) >= 0) continue;
        // Ink is a stroke: it stands off what lies a little way to either
        // side or above and below, where a gradient's far shades do not.
        const off = [
          [x - MARK, y],
          [x + MARK, y],
          [x, y - MARK],
          [x, y + MARK],
        ].filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < last.width && ny < last.height && dist(p, at(last, nx, ny)) > 60).length;
        if (off < 2) continue;
        other[y * last.width + x] = 1;
        colour[0] += p[0];
        colour[1] += p[1];
        colour[2] += p[2];
        n++;
        box = box
          ? {
              x: Math.min(box.x, x),
              y: Math.min(box.y, y),
              w: Math.max(box.x + box.w, x + 1) - Math.min(box.x, x),
              h: Math.max(box.y + box.h, y + 1) - Math.min(box.y, y),
            }
          : { x, y, w: 1, h: 1 };
      }
  if (!box || n < PASS_MIN) return [];
  const otherColour = colour.map((v) => v / n) as Rgb;
  let front = 0;
  let behind = 0;
  for (const f of frames.slice(0, -1))
    for (const c of cols) {
      const k = columnInk(f, c.x0, c.x1, ink, (c.y1 - c.y0) * TALL);
      if (!k) continue;
      // A letter at rest covers the same ink on every frame: only moving ones tell.
      if (Math.abs(k.y0 - c.y0) <= REST_PX) continue;
      for (let y = k.y0; y < k.y1; y++)
        for (let x = c.x0; x < c.x1; x++) {
          if (!other[y * f.width + x]) continue;
          const p = at(f, x, y);
          if (dist(p, ink) < dist(p, otherColour) && dist(p, ink) < 90) front++;
          else if (dist(p, otherColour) < 90) behind++;
        }
    }
  if (front + behind < PASS_MIN) return [];
  return [
    {
      color: otherColour.map(Math.round) as Rgb,
      box,
      // In front, the letters' strokes take a good share of what their boxes
      // cross; behind, the other ink shows through all of it.
      letters: front / (front + behind) > FRONT_SHARE ? "front" : "behind",
      pixels: front + behind,
    },
  ];
}
