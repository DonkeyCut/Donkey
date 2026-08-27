/**
 * Guided filter: sharpen a soft matte against the picture it belongs to.
 *
 * A tracked mask comes back blocky — model resolution, video compression —
 * while the real edge lives in the source pixels. The guided filter slides
 * the matte toward that edge: inside a window, the output is a local linear
 * function of the guide (the source luma), so the matte snaps to picture
 * edges and stays smooth across flat regions. Pure math on Float32 planes;
 * every renderer that refines a matte runs this one implementation.
 */

/** Scratch planes, reused across frames: the refine runs per baked frame,
 * synchronously, and reallocating a dozen frame-sized planes each time is
 * pure GC pressure. Every plane is fully overwritten before it is read, so a
 * reused one never leaks the previous frame. */
function planeCache() {
  let size = -1;
  let list: Float32Array[] = [];
  return (n: number, count: number): Float32Array[] => {
    if (size !== n || list.length < count) {
      size = n;
      list = Array.from({ length: count }, () => new Float32Array(n));
    }
    return list;
  };
}
const refinePlanes = planeCache();
const framePlanes = planeCache();

/** Box blur `src` into `out` (radius `r`, running sums per axis), through the
 * caller's `tmp` plane. */
function boxBlur(src: Float32Array, w: number, h: number, r: number, tmp: Float32Array, out: Float32Array): void {
  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (r * 2 + 1);
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  // Vertical pass.
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (r * 2 + 1);
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

/**
 * Refine `matte` (0..1) against `guide` (0..1 luma, same dimensions), in
 * place. `radius` is the window in pixels at the matte's own resolution;
 * `eps` is the edge threshold — smaller hugs edges harder.
 */
export function guidedFilterRefine(
  matte: Float32Array,
  guide: Float32Array,
  w: number,
  h: number,
  radius = 8,
  eps = 1e-3
): void {
  const n = w * h;
  const [tmp, meanI, meanP, cross, sq, meanIP, meanII, a, b, meanA, meanB] = refinePlanes(n, 11);
  boxBlur(guide, w, h, radius, tmp, meanI);
  boxBlur(matte, w, h, radius, tmp, meanP);
  for (let i = 0; i < n; i++) {
    cross[i] = guide[i] * matte[i];
    sq[i] = guide[i] * guide[i];
  }
  boxBlur(cross, w, h, radius, tmp, meanIP);
  boxBlur(sq, w, h, radius, tmp, meanII);
  for (let i = 0; i < n; i++) {
    const varI = meanII[i] - meanI[i] * meanI[i];
    const covIP = meanIP[i] - meanI[i] * meanP[i];
    a[i] = covIP / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  boxBlur(a, w, h, radius, tmp, meanA);
  boxBlur(b, w, h, radius, tmp, meanB);
  for (let i = 0; i < n; i++) {
    matte[i] = Math.min(1, Math.max(0, meanA[i] * guide[i] + meanB[i]));
  }
}

/**
 * Refine a matte held as RGBA pixel buffers: the matte's red channel against
 * the picture's BT.709 luma. Writes the refined coverage back into the
 * matte's RGB (white × coverage) and alpha.
 */
export function refineMatteAgainstFrame(
  mattePx: Uint8ClampedArray,
  framePx: Uint8ClampedArray,
  w: number,
  h: number,
  radius = 8,
  eps = 1e-3
): void {
  const n = w * h;
  const [matte, guide] = framePlanes(n, 2);
  for (let i = 0; i < n; i++) {
    matte[i] = mattePx[i * 4] / 255;
    guide[i] =
      (0.2126 * framePx[i * 4] + 0.7152 * framePx[i * 4 + 1] + 0.0722 * framePx[i * 4 + 2]) / 255;
  }
  guidedFilterRefine(matte, guide, w, h, radius, eps);
  for (let i = 0; i < n; i++) {
    const v = Math.round(matte[i] * 255);
    mattePx[i * 4] = v;
    mattePx[i * 4 + 1] = v;
    mattePx[i * 4 + 2] = v;
    mattePx[i * 4 + 3] = 255;
  }
}
