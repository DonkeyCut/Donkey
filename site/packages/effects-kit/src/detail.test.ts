import { describe, expect, test } from "bun:test";
import { applyDetail, detailActive, detailGain, detailRadius, gaussianBlur } from "./detail";

/** A w×h RGBA frame from a luma function, grey. */
function frame(w: number, h: number, f: (x: number, y: number) => number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(f(x, y) * 255)));
      const o = (y * w + x) * 4;
      px[o] = v;
      px[o + 1] = v;
      px[o + 2] = v;
      px[o + 3] = 255;
    }
  return px;
}

describe("settings", () => {
  test("gain scales with the slider and radii scale with the frame", () => {
    expect(detailGain("sharpen", 0)).toBe(0);
    expect(detailGain("sharpen", 50)).toBe(1.5);
    expect(detailGain("clarity", 25)).toBeCloseTo(0.75, 9);
    expect(detailRadius("sharpen", 1080)).toBe(1);
    expect(detailRadius("sharpen", 2160)).toBe(2);
    expect(detailRadius("clarity", 1080)).toBe(24);
    expect(detailRadius("clarity", 540)).toBe(12);
    expect(detailActive(undefined)).toBe(false);
    expect(detailActive({ sharpen: 0 })).toBe(false);
    expect(detailActive({ clarity: 1 })).toBe(true);
  });
});

describe("gaussianBlur", () => {
  test("keeps a flat plane and smooths a step", () => {
    const w = 16;
    const h = 4;
    const flat = new Float32Array(w * h).fill(0.4);
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    gaussianBlur(flat, w, h, 1, tmp, out);
    for (const v of out) expect(Math.abs(v - 0.4)).toBeLessThan(1e-6);
    const step = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) step[i] = i % w < 8 ? 0 : 1;
    gaussianBlur(step, w, h, 1, tmp, out);
    expect(out[7]).toBeGreaterThan(0);
    expect(out[8]).toBeLessThan(1);
    expect(out[0]).toBeLessThan(1e-3);
    expect(out[15]).toBeGreaterThan(1 - 1e-3);
  });
});

describe("applyDetail", () => {
  test("zero settings leave pixels alone and a flat frame stays flat", () => {
    const px = frame(32, 32, () => 0.5);
    const before = [...px];
    applyDetail(px, 32, 32, {});
    expect([...px]).toEqual(before);
    applyDetail(px, 32, 32, { sharpen: 50, clarity: 50 });
    expect([...px]).toEqual(before);
  });

  test("sharpen steepens an edge without moving the flat field", () => {
    const w = 64;
    const h = 64;
    const px = frame(w, h, (x) => (x < 32 ? 0.3 : 0.7));
    applyDetail(px, w, h, { sharpen: 50 });
    const at = (x: number) => px[(32 * w + x) * 4];
    // Overshoot on each side of the edge, the field far away untouched.
    expect(at(31)).toBeLessThan(Math.round(0.3 * 255));
    expect(at(32)).toBeGreaterThan(Math.round(0.7 * 255));
    expect(at(4)).toBe(Math.round(0.3 * 255));
    expect(at(60)).toBe(Math.round(0.7 * 255));
  });

  test("clarity lifts a soft feature and keeps a hard edge nearly free of halo", () => {
    const w = 256;
    const h = 256;
    // A flat field with a soft bump wider than the clarity window and a
    // four-pixel spike inside it.
    const px = frame(w, h, (x) => 0.5 + 0.15 * Math.exp(-((x - 100) ** 2) / 200) + (x >= 180 && x < 184 ? 0.25 : 0));
    const before = [...px];
    applyDetail(px, w, h, { clarity: 50 });
    const row = (x: number) => px[(128 * w + x) * 4];
    const was = (x: number) => before[(128 * w + x) * 4];
    expect(row(100)).toBeGreaterThan(was(100));
    expect(row(40)).toBe(was(40));
    expect(row(181)).toBeGreaterThan(was(181));
    // A hard step: the guided base follows the edge, so the overshoot beside
    // it stays under a third of what an unsharp mask at the same gain leaves.
    const step = frame(w, h, (x) => (x < 128 ? 0.3 : 0.7));
    applyDetail(step, w, h, { clarity: 50 });
    const at = (x: number) => step[(128 * w + x) * 4];
    const halo = Math.max(Math.round(0.3 * 255) - at(127), at(128) - Math.round(0.7 * 255));
    expect(halo).toBeGreaterThan(0);
    expect(halo).toBeLessThan((detailGain("clarity", 50) * 0.4 * 255) / 3);
  });

  test("detail lands on every channel equally, keeping hue", () => {
    const w = 64;
    const h = 64;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const dark = x < 32;
        px[o] = dark ? 60 : 180;
        px[o + 1] = dark ? 40 : 120;
        px[o + 2] = dark ? 20 : 60;
        px[o + 3] = 255;
      }
    const before = [...px];
    applyDetail(px, w, h, { sharpen: 30 });
    const o = (32 * w + 31) * 4;
    const dr = px[o] - before[o];
    const dg = px[o + 1] - before[o + 1];
    const db = px[o + 2] - before[o + 2];
    expect(dr).not.toBe(0);
    expect(Math.abs(dr - dg)).toBeLessThanOrEqual(1);
    expect(Math.abs(dg - db)).toBeLessThanOrEqual(1);
    expect(px[o + 3]).toBe(255);
  });
});
