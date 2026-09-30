/**
 * Sharpen and clarity: the two spatial controls, on luma only. Both add
 * back detail — the difference between the picture and a smoothed base —
 * with a gain. Sharpen's base is a Gaussian blur about a pixel wide, so it
 * lifts fine edges; clarity's base is a guided filter over a wide window,
 * edge-preserving, so it lifts local contrast without haloing the edges
 * (He, Sun and Tang, "Guided Image Filtering", the detail-enhancement use).
 * Radii scale with frame height so a setting reads the same at every
 * resolution. This is the CPU reference; the GPU and ffmpeg paths follow
 * the same radii and gains.
 */

import { guidedFilterRefine } from "./guidedFilter";
import { GRADE_MAX } from "./colorGrade";

/** Gaussian sigma of the sharpen base, as a fraction of frame height (one
 * pixel at 1080p). */
export const SHARPEN_SIGMA_FRAC = 1 / 1080;
/** Window radius of the clarity base, as a fraction of frame height. */
export const CLARITY_RADIUS_FRAC = 24 / 1080;
/** Edge threshold of the clarity guided filter, in squared luma. */
export const CLARITY_EPS = 0.01;
/** Detail gain at a full slider. */
export const SHARPEN_GAIN_AT_MAX = 1.5;
export const CLARITY_GAIN_AT_MAX = 1.5;

export function detailRadius(kind: "sharpen" | "clarity", frameHeight: number): number {
  return kind === "sharpen"
    ? Math.max(0.5, frameHeight * SHARPEN_SIGMA_FRAC)
    : Math.max(1, Math.round(frameHeight * CLARITY_RADIUS_FRAC));
}

export function detailGain(kind: "sharpen" | "clarity", slider: number): number {
  const t = Math.max(0, Math.min(GRADE_MAX, slider || 0)) / GRADE_MAX;
  return t * (kind === "sharpen" ? SHARPEN_GAIN_AT_MAX : CLARITY_GAIN_AT_MAX);
}

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Separable Gaussian blur of a plane into `out` through `tmp`. */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number, tmp: Float32Array, out: Float32Array): void {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        acc += src[row + xx] * k[i + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        acc += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = acc;
    }
  }
}

export interface DetailSettings {
  sharpen?: number; // 0..50
  clarity?: number; // 0..50
}

/** True when the settings change any pixel. */
export function detailActive(d: DetailSettings | undefined | null): boolean {
  return !!d && (detailGain("sharpen", d.sharpen || 0) > 0 || detailGain("clarity", d.clarity || 0) > 0);
}

/**
 * Apply sharpen and clarity to RGBA pixels in place. Both details are taken
 * from the same input luma and added together, so the two controls do not
 * feed each other; the luma change lands on every channel equally, so hue
 * and saturation hold. Alpha passes through.
 */
export function applyDetail(px: Uint8ClampedArray, w: number, h: number, d: DetailSettings): void {
  const ks = detailGain("sharpen", d.sharpen || 0);
  const kc = detailGain("clarity", d.clarity || 0);
  if (!ks && !kc) return;
  const n = w * h;
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    luma[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
  }
  const delta = new Float32Array(n);
  if (ks) {
    const tmp = new Float32Array(n);
    const base = new Float32Array(n);
    gaussianBlur(luma, w, h, detailRadius("sharpen", h), tmp, base);
    for (let i = 0; i < n; i++) delta[i] += ks * (luma[i] - base[i]);
  }
  if (kc) {
    const base = new Float32Array(luma);
    guidedFilterRefine(base, luma, w, h, detailRadius("clarity", h), CLARITY_EPS);
    for (let i = 0; i < n; i++) delta[i] += kc * (luma[i] - base[i]);
  }
  for (let i = 0; i < n; i++) {
    const dv = delta[i] * 255;
    if (!dv) continue;
    const o = i * 4;
    px[o] = Math.max(0, Math.min(255, Math.round(px[o] + dv)));
    px[o + 1] = Math.max(0, Math.min(255, Math.round(px[o + 1] + dv)));
    px[o + 2] = Math.max(0, Math.min(255, Math.round(px[o + 2] + dv)));
  }
}
