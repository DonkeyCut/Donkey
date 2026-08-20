/**
 * Reference matching: read color statistics off two frames and compute the
 * grade that carries one onto the other. The match is per-channel quantile
 * mapping compiled into tone-curve control points — the same curves the
 * panel edits — plus a saturation delta, so the result is an ordinary
 * ColorGrade the user (or the assistant) can refine afterward.
 */

import { type ColorGrade, type CurvePoint, GRADE_MAX, normalizeGrade } from "./colorGrade";

/** Quantile probes used by stats and matching. */
export const STAT_QUANTILES = [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98] as const;

export interface ColorStats {
  /** Per-channel values 0..255 at each STAT_QUANTILES probe. */
  r: number[];
  g: number[];
  b: number[];
  luma: number[];
  /** Channel means 0..255. */
  meanR: number;
  meanG: number;
  meanB: number;
  /** Mean HSL saturation 0..1. */
  meanSat: number;
  /** Red/blue mean ratio in the midtones; >1 reads warm, <1 reads cool. */
  warmth: number;
}

export function colorStatsFromImageData(data: Uint8ClampedArray): ColorStats | undefined {
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  let count = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSat = 0;
  let midR = 0;
  let midB = 0;
  let mids = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[0][r]++;
    hist[1][g]++;
    hist[2][b]++;
    hist[3][Math.min(255, Math.round(luma))]++;
    sumR += r;
    sumG += g;
    sumB += b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l2 = max + min;
    sumSat += max === min ? 0 : (max - min) / (l2 <= 255 ? l2 : 510 - l2);
    if (luma >= 16 && luma <= 240) {
      midR += r;
      midB += b;
      mids++;
    }
    count++;
  }
  if (!count) return undefined;
  const quantiles = (h: Float64Array) =>
    STAT_QUANTILES.map((p) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += h[v];
        if (acc >= count * p) return v;
      }
      return 255;
    });
  return {
    r: quantiles(hist[0]),
    g: quantiles(hist[1]),
    b: quantiles(hist[2]),
    luma: quantiles(hist[3]),
    meanR: sumR / count,
    meanG: sumG / count,
    meanB: sumB / count,
    meanSat: sumSat / count,
    warmth: mids ? midR / Math.max(1, midB) : 1,
  };
}

function quantileCurve(src: number[], ref: number[]): CurvePoint[] | undefined {
  const pts: CurvePoint[] = [];
  let lastX = -1;
  for (let i = 0; i < src.length; i++) {
    const x = Math.round(src[i]);
    const y = Math.round(ref[i]);
    if (x <= lastX) continue;
    pts.push([x, y]);
    lastX = x;
  }
  // Monotone outputs keep the compiled spline monotone.
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1];
  }
  if (pts.length < 2 || pts.every(([x, y]) => Math.abs(x - y) <= 2)) return undefined;
  // The spline holds flat outside its end points, so a curve that stops at the
  // p2/p98 probes would crush everything darker and brighter into those two
  // values. Carry the end segments' slopes out to 0 and 255 instead, keeping
  // the shadow and specular separation the reference has.
  const [x0, y0] = pts[0];
  const [x1, y1] = pts[1];
  const [xa, ya] = pts[pts.length - 2];
  const [xb, yb] = pts[pts.length - 1];
  if (xb < 255) {
    const slope = (yb - ya) / Math.max(1, xb - xa);
    pts.push([255, Math.round(Math.min(255, Math.max(yb, yb + slope * (255 - xb))))]);
  }
  if (x0 > 0) {
    const slope = (y1 - y0) / Math.max(1, x1 - x0);
    pts.unshift([0, Math.round(Math.max(0, Math.min(y0, y0 - slope * x0)))]);
  }
  return pts;
}

/**
 * Compute the grade that moves `source` toward `reference`: per-channel
 * quantile curves plus a saturation delta. Returns undefined when the frames
 * already agree.
 */
export function matchGrade(source: ColorStats, reference: ColorStats): ColorGrade | undefined {
  const grade: ColorGrade = {};
  const r = quantileCurve(source.r, reference.r);
  const g = quantileCurve(source.g, reference.g);
  const b = quantileCurve(source.b, reference.b);
  if (r || g || b) {
    grade.curves = {};
    if (r) grade.curves.r = r;
    if (g) grade.curves.g = g;
    if (b) grade.curves.b = b;
  }
  if (source.meanSat > 0.01) {
    const delta = Math.round((reference.meanSat / source.meanSat - 1) * GRADE_MAX);
    if (Math.abs(delta) >= 2) {
      grade.saturation = Math.max(-GRADE_MAX, Math.min(GRADE_MAX, delta));
    }
  }
  return normalizeGrade(grade);
}
