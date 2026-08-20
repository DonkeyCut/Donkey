import { describe, expect, test } from "bun:test";
import { createGradeTransform } from "./gradeMath";
import { colorStatsFromImageData, matchGrade } from "./gradeMatch";

/** A synthetic frame with tonal and color variety. */
function testFrame(): Uint8ClampedArray {
  const w = 64;
  const h = 64;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = Math.round((x / (w - 1)) * 255);
      data[o + 1] = Math.round((y / (h - 1)) * 255);
      data[o + 2] = Math.round(((x + y) / (w + h - 2)) * 200 + 20);
      data[o + 3] = 255;
    }
  }
  return data;
}

function graded(data: Uint8ClampedArray, f: (v: number, c: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round(f(data[i + c], c))));
    out[i + 3] = data[i + 3];
  }
  return out;
}

describe("matchGrade", () => {
  test("a frame matched to itself is neutral", () => {
    const stats = colorStatsFromImageData(testFrame())!;
    expect(matchGrade(stats, stats)).toBeUndefined();
  });

  test("recovers a known channel shift within tolerance", () => {
    const src = testFrame();
    // Warm the reference: red up, blue down — a temperature-like cast.
    const ref = graded(src, (v, c) => (c === 0 ? v * 1.18 : c === 2 ? v * 0.85 : v));
    const srcStats = colorStatsFromImageData(src)!;
    const refStats = colorStatsFromImageData(ref)!;
    const grade = matchGrade(srcStats, refStats);
    expect(grade !== undefined).toBe(true);
    const transform = createGradeTransform(grade)!;
    // Apply the match and compare channel means against the reference.
    let mr = 0;
    let mg = 0;
    let mb = 0;
    let n = 0;
    for (let i = 0; i < src.length; i += 4) {
      const [r, g, b] = transform(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255);
      mr += r * 255;
      mg += g * 255;
      mb += b * 255;
      n++;
    }
    mr /= n;
    mg /= n;
    mb /= n;
    expect(Math.abs(mr - refStats.meanR)).toBeLessThan(10);
    expect(Math.abs(mg - refStats.meanG)).toBeLessThan(10);
    expect(Math.abs(mb - refStats.meanB)).toBeLessThan(10);
  });

  test("matched curves reach both ends of the range", () => {
    const src = testFrame();
    const ref = graded(src, (v, c) => (c === 0 ? v * 1.18 : c === 2 ? v * 0.85 : v));
    const grade = matchGrade(colorStatsFromImageData(src)!, colorStatsFromImageData(ref)!)!;
    // The spline holds flat past its end points, so a curve stopping at the
    // p2/p98 probes would flatten the darkest and brightest pixels.
    for (const ch of ["r", "g", "b"] as const) {
      const pts = grade.curves?.[ch];
      if (!pts) continue;
      expect(pts[0][0]).toBe(0);
      expect(pts[pts.length - 1][0]).toBe(255);
      for (let i = 1; i < pts.length; i++) {
        expect(pts[i][0]).toBeGreaterThan(pts[i - 1][0]);
        expect(pts[i][1]).toBeGreaterThanOrEqual(pts[i - 1][1]);
      }
    }
  });

  test("stats expose warmth and saturation for the assistant", () => {
    const stats = colorStatsFromImageData(testFrame())!;
    expect(stats.meanSat).toBeGreaterThan(0);
    expect(stats.warmth).toBeGreaterThan(0);
    expect(stats.luma.length).toBe(7);
  });
});
