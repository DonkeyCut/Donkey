/**
 * Smart select's mask math, two tiers. The tap-to-select model handles what
 * it is built for — objects: its confidence mask is gated by the confidence
 * at the stroke itself and by connectivity to it, so the object-centric
 * model's bleed into the salient subject stays out of a pick. Where the
 * model refuses to anchor — backdrops, walls, sky, anything it will not call
 * an object — the pick falls to a geodesic color wand: distance from the
 * stroke accumulates color change along the cheapest path, so a smooth
 * region costs its total drift while a real boundary is a cost cliff, and
 * the selection snaps there. The wand is the interactive-rate shape of the
 * classic scribble segmentation energy (color model + contrast-aware cut).
 */

/** Floor confidence for a pixel to count as picked at all. */
export const TOUCH_FLOOR = 0.35;
/** How far below the stroke's own confidence a pixel may sit and still join
 * the pick. */
export const TOUCH_MARGIN = 0.3;

type Point = { x: number; y: number };

/** Index of the mask pixel under a frame-fraction point. */
const at = (p: Point, mw: number, mh: number) =>
  Math.min(mh - 1, Math.max(0, Math.round(p.y * mh))) * mw +
  Math.min(mw - 1, Math.max(0, Math.round(p.x * mw)));

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * The picked region's alpha bytes (0..255, one per mask pixel), or null when
 * the model puts no confidence on the touched spot itself — the stroke landed
 * on something the model refuses to call an object, and the caller falls
 * through to the color wand. Points are frame fractions.
 *
 * The stroke's first point alone decides which tier answers: it never moves
 * while a drag grows, so the preview stays with one tier for the whole
 * stroke. The median over the stroke then sets the confidence floor, which
 * keeps one stray sample grazing model bleed from widening the pick.
 */
export function touchAlpha(
  conf: Float32Array,
  mw: number,
  mh: number,
  points: Point[]
): Uint8ClampedArray | null {
  if (points.length === 0) return null;
  if (conf[at(points[0], mw, mh)] <= TOUCH_FLOOR) return null;
  const seedConf = Math.max(TOUCH_FLOOR, median(points.map((p) => conf[at(p, mw, mh)])));
  const floor = Math.max(TOUCH_FLOOR, seedConf - TOUCH_MARGIN);
  const alpha = new Uint8ClampedArray(mw * mh);
  let kept = 0;
  const ramp = (c: number) => Math.min(255, Math.round((c - floor) * 4 * 255));
  // Flood from the stroke over above-floor pixels; 4-connected.
  const seen = new Uint8Array(mw * mh);
  const queue: number[] = [];
  const visit = (i: number) => {
    if (!seen[i] && conf[i] > floor) {
      seen[i] = 1;
      queue.push(i);
    }
  };
  for (const p of points) visit(at(p, mw, mh));
  while (queue.length) {
    const i = queue.pop()!;
    alpha[i] = ramp(conf[i]);
    if (alpha[i] > 128) kept++;
    const x = i % mw;
    if (x > 0) visit(i - 1);
    if (x < mw - 1) visit(i + 1);
    if (i >= mw) visit(i - mw);
    if (i < mw * (mh - 1)) visit(i + mw);
  }
  return kept > 0 ? alpha : null;
}

/** Color distance (L1 mean, 0..255) within which a pixel counts as one of
 * the stroke's own tones. */
export const WAND_TONE = 26;
/** How far past the tones a pixel may sit and still be selectable when the
 * pick flows through it — soft shadows, grain, antialiased slivers. */
const WAND_NEAR = 22;
/** Off-tone cost budget a path may spend bridging thin foreign runs — a
 * groove, a seam, a highlight line — before the pick stops. */
const WAND_BARRIER = 64;
/** Chamfer sweeps; two settle straight paths, the third the wiggly ones. */
const WAND_PASSES = 3;

/** The stroke's color signatures: its sampled colors, greedily merged so
 * near-identical samples collapse into one representative. */
function signatures(rgba: Uint8ClampedArray, seeds: number[]): number[][] {
  const sig: number[][] = [];
  for (const i of seeds) {
    const c = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    const near = sig.some(
      (s) => Math.abs(s[0] - c[0]) + Math.abs(s[1] - c[1]) + Math.abs(s[2] - c[2]) < 36
    );
    if (!near) sig.push(c);
    if (sig.length >= 16) break;
  }
  return sig;
}

/** Per-frame scratch a caller may hand `wandAlpha`: the tone field is the
 * wand's heavy pass and depends only on the picture and the stroke's
 * signature set, so across the pointer moves of one stroke it is usually
 * reusable as-is. */
export interface WandScratch {
  key?: string;
  tone?: Float32Array;
}

/**
 * The color wand, shaped like SIOX's foreground select: the stroke's colors
 * cluster into signatures, every pixel scores by its distance to the nearest
 * signature, and the pick grows from the stroke over on-signature pixels.
 * Growth carries a small budget for off-signature cost, so thin foreign runs
 * — grooves, seams, texture lines — are bridged and their far side joins,
 * while a real subject boundary is wide and costly enough to stop at.
 * Scribbling over more tones adds signatures and widens the pick with it.
 */
export function wandAlpha(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  points: Point[],
  scratch?: WandScratch
): Uint8ClampedArray | null {
  if (points.length === 0) return null;
  const seeds = points.map((p) => at(p, w, h));
  const sig = signatures(rgba, seeds);
  // Distance from each pixel's color to the nearest signature — cached in
  // the scratch while the signature set holds.
  const key = `${w}x${h}|${sig.map((s) => s.join(",")).join(";")}`;
  let tone = scratch?.key === key ? scratch.tone : undefined;
  if (!tone) {
    tone = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = rgba[i * 4];
      const g = rgba[i * 4 + 1];
      const b = rgba[i * 4 + 2];
      let best = Infinity;
      for (const s of sig) {
        const d = (Math.abs(s[0] - r) + Math.abs(s[1] - g) + Math.abs(s[2] - b)) / 3;
        if (d < best) best = d;
      }
      tone[i] = best;
    }
    if (scratch) {
      scratch.key = key;
      scratch.tone = tone;
    }
  }
  // Geodesic growth from the stroke: entering an on-signature pixel is free,
  // an off-signature pixel charges its excess, and the accumulated charge
  // along the cheapest 8-connected path is capped by the bridge budget.
  const cost = (i: number) => Math.max(0, tone[i] - WAND_TONE);
  const dist = new Float32Array(w * h).fill(Infinity);
  for (const i of seeds) dist[i] = 0;
  for (let pass = 0; pass < WAND_PASSES; pass++) {
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let d = dist[i];
        const c = cost(i);
        if (x > 0) d = Math.min(d, dist[i - 1] + c);
        if (y > 0) {
          d = Math.min(d, dist[i - w] + c);
          if (x > 0) d = Math.min(d, dist[i - w - 1] + c);
          if (x < w - 1) d = Math.min(d, dist[i - w + 1] + c);
        }
        if (d < dist[i]) {
          dist[i] = d;
          changed = true;
        }
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let d = dist[i];
        const c = cost(i);
        if (x < w - 1) d = Math.min(d, dist[i + 1] + c);
        if (y < h - 1) {
          d = Math.min(d, dist[i + w] + c);
          if (x < w - 1) d = Math.min(d, dist[i + w + 1] + c);
          if (x > 0) d = Math.min(d, dist[i + w - 1] + c);
        }
        if (d < dist[i]) {
          dist[i] = d;
          changed = true;
        }
      }
    }
    // Straight paths settle in one pass, wiggly ones in two or three; once a
    // pass moves nothing the field is final.
    if (!changed) break;
  }
  const alpha = new Uint8ClampedArray(w * h);
  const core = WAND_BARRIER * 0.6;
  for (let i = 0; i < w * h; i++) {
    if (tone[i] > WAND_TONE + WAND_NEAR) continue;
    const d = dist[i];
    if (d <= core) alpha[i] = 255;
    else if (d < WAND_BARRIER)
      alpha[i] = Math.round(255 * (1 - (d - core) / (WAND_BARRIER - core)));
  }
  return alpha;
}
