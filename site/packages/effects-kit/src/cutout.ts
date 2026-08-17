/**
 * Cutout finishing: the canvas work that turns a matted picture into a
 * sticker. Where the alpha came from — an on-device segmenter, a hosted vision
 * model, a hand-drawn selection — is the host's business; everything here just
 * shapes pixels, so any host with a canvas can reuse it.
 */

import { kitCanvas } from "./surface";

/** Die-cut outline radius as a share of the sticker's long side. */
export const OUTLINE_SHARE = 0.03;

/** Number of stamps around the circle that make the outline read as smooth. */
const OUTLINE_STAMPS = 24;

/**
 * Knock out a plain backdrop.
 *
 * A generated sticker arrives on a plain studio background, and no segmenter
 * is needed to see it: the border tells you the colour, and the subject is
 * whatever the colour does not reach. The fill spreads inward from the edges,
 * so a patch of backdrop-coloured pixels *inside* the subject — a white shirt
 * against a white sweep — is kept rather than punched out.
 *
 * Each pixel is judged against the backdrop colour beside it, carried along by
 * the fill, so a backdrop that drifts across the frame stays backdrop the whole
 * way. An image generator paints a "solid" sweep with a gradient and a little
 * noise in it, and one global colour would call the far corner a subject.
 * Drifting is bounded: a pixel far enough from the border colour is a subject
 * however smoothly it was reached, so a soft shadow cannot leak into the cat.
 *
 * Returns per-pixel coverage (1 keeps, 0 drops, between the two for the soft
 * edge), or null when the picture is not one of these: a chaotic border, or a
 * fill that swallows nearly everything, means the guess was wrong and a real
 * matte should answer instead.
 */
export interface FlatBackdropOptions {
  /** Colour distance from the neighbouring backdrop that is still backdrop
   * (0-255, per channel). Default: scaled to how much the border itself
   * varies. */
  near?: number;
  /** Distance past which a pixel is certainly subject; between the two the
   * edge fades, which is what keeps the cutout from looking cut with pinking
   * shears. */
  far?: number;
  /** How far the fill may drift from the border colour in total. */
  maxDrift?: number;
  /** How much the border may vary and still count as a backdrop at all. */
  borderSpread?: number;
}

export function flatBackdropAlpha(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  opts: FlatBackdropOptions = {}
): Float32Array | null {
  if (w < 4 || h < 4) return null;

  // The backdrop colour: the median of the border ring, which shrugs off a
  // subject that runs off one edge.
  const border: number[][] = [];
  const at = (x: number, y: number) => (y * w + x) * 4;
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) border.push([data[at(x, y)], data[at(x, y) + 1], data[at(x, y) + 2]]);
  }
  for (let y = 1; y < h - 1; y++) {
    for (const x of [0, w - 1]) border.push([data[at(x, y)], data[at(x, y) + 1], data[at(x, y) + 2]]);
  }
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };
  const gap = (p: number[], r: number, g: number, b: number) =>
    Math.max(Math.abs(p[0] - r), Math.abs(p[1] - g), Math.abs(p[2] - b));
  const bg = [0, 1, 2].map((c) => median(border.map((p) => p[c])));

  // How ragged the border is, as its own typical departure from that median.
  // Half the ring can sit on a gradient's dark end without being ragged, so
  // the median of the departures answers where a share-of-pixels count would
  // call a smooth sweep chaotic.
  const ragged = median(border.map((p) => gap(p, bg[0], bg[1], bg[2])));
  // A photographed wall wanders pixel to pixel; a rendered backdrop does not.
  if (ragged > (opts.borderSpread ?? 24)) return null;

  const near = opts.near ?? Math.max(10, Math.min(30, ragged * 2 + 8));
  const far = opts.far ?? near + 18;
  const maxDrift = opts.maxDrift ?? Math.max(72, far * 2);

  const alpha = new Float32Array(w * h).fill(1);
  const seen = new Uint8Array(w * h);
  // The backdrop colour beside each filled pixel, carried inward so a drifting
  // sweep is measured against itself.
  const ref = new Uint8Array(w * h * 3);
  const stack: number[] = [];

  /** Take pixel `i` against a backdrop colour, and spread from it when it is
   * wholly backdrop. An edge pixel keeps its part-coverage and spreads no
   * further, so a soft rim cannot walk the fill into the subject. */
  const take = (i: number, r: number, g: number, b: number) => {
    if (seen[i]) return;
    seen[i] = 1;
    const p = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    if (gap(p, bg[0], bg[1], bg[2]) > maxDrift) return; // too far from where it started
    const d = gap(p, r, g, b);
    if (d >= far) return; // subject: the fill stops here
    if (d > near) {
      alpha[i] = (d - near) / (far - near);
      return;
    }
    alpha[i] = 0;
    ref[i * 3] = p[0];
    ref[i * 3 + 1] = p[1];
    ref[i * 3 + 2] = p[2];
    stack.push(i);
  };

  for (let x = 0; x < w; x++) {
    take(x, bg[0], bg[1], bg[2]);
    take((h - 1) * w + x, bg[0], bg[1], bg[2]);
  }
  for (let y = 0; y < h; y++) {
    take(y * w, bg[0], bg[1], bg[2]);
    take(y * w + w - 1, bg[0], bg[1], bg[2]);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const r = ref[i * 3];
    const g = ref[i * 3 + 1];
    const b = ref[i * 3 + 2];
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) take(i - 1, r, g, b);
    if (x < w - 1) take(i + 1, r, g, b);
    if (y > 0) take(i - w, r, g, b);
    if (y < h - 1) take(i + w, r, g, b);
  }

  let dropped = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] < 0.5) dropped++;
  const share = dropped / alpha.length;
  // Too little and there was no backdrop to speak of; too much and the
  // subject went with it.
  if (share < 0.08 || share > 0.94) return null;
  return alpha;
}

/** Apply `flatBackdropAlpha` to a canvas in place. False when the picture has
 * no flat backdrop to knock out — the caller falls through to a real matte. */
export function removeFlatBackdrop(
  canvas: HTMLCanvasElement,
  opts?: FlatBackdropOptions
): boolean {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { width: w, height: h } = canvas;
  const image = ctx.getImageData(0, 0, w, h);
  const alpha = flatBackdropAlpha(image.data, w, h, opts);
  if (!alpha) return false;
  for (let i = 0; i < alpha.length; i++) {
    image.data[i * 4 + 3] = Math.round(image.data[i * 4 + 3] * alpha[i]);
  }
  ctx.putImageData(image, 0, 0);
  return true;
}

/** Square min/max filters, run as two 1D passes. A square structuring element
 * separates, so an r-pixel erode costs two scans rather than r². */
function boxFilter(src: Uint8Array, w: number, h: number, r: number, want: 0 | 1): Uint8Array {
  const pick = (a: number, b: number) => (want === 1 ? (a > b ? a : b) : a < b ? a : b);
  const mid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = src[y * w + x];
      for (let d = -r; d <= r; d++) {
        const nx = x + d;
        if (nx >= 0 && nx < w) v = pick(v, src[y * w + nx]);
      }
      mid[y * w + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = mid[y * w + x];
      for (let d = -r; d <= r; d++) {
        const ny = y + d;
        if (ny >= 0 && ny < h) v = pick(v, mid[ny * w + x]);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Keep the sticker and drop what is loitering around it.
 *
 * A generator asked for a die-cut sticker draws one — and then sketches stray
 * strokes and specks around it, which a backdrop knockout rightly keeps: they
 * are not the backdrop colour. They are, though, the only marks not part of
 * the sticker's one solid body.
 *
 * Eroding the matte first is what makes that separable. Hairline strokes are
 * thinner than the erosion radius, so they vanish or pull away from the body,
 * and the body — a filled silhouette with its outline around it — survives.
 * The largest surviving region is the sticker; dilating it back and taking it
 * against the original alpha restores the true edge without ever adding a
 * pixel the matte had not already kept.
 *
 * A picture whose subject is genuinely several pieces would lose all but the
 * biggest, so this is the sticker pipeline's step rather than every matte's.
 */
export function keepLargestSubject(
  canvas: HTMLCanvasElement,
  opts: { radius?: number } = {}
): boolean {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { width: w, height: h } = canvas;
  if (w < 8 || h < 8) return false;
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  // Thin enough to leave the sticker's body untouched, thick enough to bite
  // through a sketch line.
  const r = Math.max(1, opts.radius ?? Math.round(Math.min(w, h) * 0.006));

  const solid = new Uint8Array(w * h);
  let solidCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] > 127) {
      solid[i] = 1;
      solidCount++;
    }
  }
  if (solidCount === 0) return false;

  const eroded = boxFilter(solid, w, h, r, 0);

  // Largest connected region of what survived the erosion, 4-connectivity —
  // a diagonal thread of pixels is exactly the kind of join worth breaking.
  const seen = new Uint8Array(w * h);
  let best: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!eroded[start] || seen[start]) continue;
    const region: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      region.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      const push = (j: number) => {
        if (!seen[j] && eroded[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      };
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    if (region.length > best.length) best = region;
  }
  // Erosion ate everything: the matte is all thin work, and there is no body
  // to tell the strays apart from.
  if (best.length === 0) return false;

  const body = new Uint8Array(w * h);
  for (const i of best) body[i] = 1;
  const keep = boxFilter(body, w, h, r, 1);

  let dropped = 0;
  for (let i = 0; i < w * h; i++) {
    if (solid[i] && !keep[i]) dropped++;
    if (!keep[i]) data[i * 4 + 3] = 0;
  }
  if (dropped === 0) return false;
  ctx.putImageData(image, 0, 0);
  return true;
}

/** A blank canvas and its 2D context, set up for pixel reads. */
export function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = kitCanvas(w, h);
  return [c, c.getContext("2d", { willReadFrequently: true })!];
}

/**
 * Scale every pixel's alpha by `alphaAt`, which reads a pixel index and
 * answers how much of the subject is there (0 = background, 1 = solid).
 * Returns whether enough survived to be a subject at all, so a caller can
 * treat "the matte found nothing" as its own outcome rather than shipping a
 * blank sticker.
 */
export function applyAlpha(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  alphaAt: (i: number) => number
): boolean {
  const data = ctx.getImageData(0, 0, w, h);
  let kept = 0;
  for (let i = 0; i < w * h; i++) {
    const a = alphaAt(i);
    data.data[i * 4 + 3] = Math.round(data.data[i * 4 + 3] * a);
    if (a > 0.5) kept++;
  }
  ctx.putImageData(data, 0, 0);
  return kept > w * h * 0.005;
}

/** Crop a canvas to its non-transparent content plus a small margin. Returns
 * the canvas untouched when nothing is left to crop to. */
export function cropToContent(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w,
    y0 = h,
    x1 = 0,
    y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) return canvas;
  const margin = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04) + 2;
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(w - 1, x1 + margin);
  y1 = Math.min(h - 1, y1 + margin);
  const [out, octx] = canvasOf(x1 - x0 + 1, y1 - y0 + 1);
  octx.drawImage(canvas, -x0, -y0);
  return out;
}

/** The classic die-cut look: the cutout's white silhouette stamped at radial
 * offsets beneath it, so a smooth outline hugs the shape. */
export function withOutline(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const r = Math.max(3, Math.round(Math.max(canvas.width, canvas.height) * OUTLINE_SHARE));
  const [out, ctx] = canvasOf(canvas.width + r * 2, canvas.height + r * 2);
  // A white-filled silhouette of the cutout.
  const [sil, sctx] = canvasOf(canvas.width, canvas.height);
  sctx.drawImage(canvas, 0, 0);
  sctx.globalCompositeOperation = "source-in";
  sctx.fillStyle = "#FFFFFF";
  sctx.fillRect(0, 0, sil.width, sil.height);
  for (let k = 0; k < OUTLINE_STAMPS; k++) {
    const a = (k / OUTLINE_STAMPS) * Math.PI * 2;
    ctx.drawImage(sil, r + Math.cos(a) * r, r + Math.sin(a) * r);
  }
  ctx.drawImage(canvas, r, r);
  return out;
}
