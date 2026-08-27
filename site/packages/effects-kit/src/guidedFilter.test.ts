import { describe, expect, test } from "bun:test";
import { guidedFilterRefine, refineMatteAgainstFrame } from "./guidedFilter";

const W = 32;
const H = 16;

/** A vertical step: dark left half, bright right half. */
function stepGuide(): Float32Array {
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = x < W / 2 ? 0.1 : 0.9;
  return g;
}

/** A matte ramping softly across the same edge. */
function softMatte(): Float32Array {
  const m = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) m[y * W + x] = Math.min(1, Math.max(0, (x - W / 2 + 4) / 8));
  return m;
}

describe("guided filter", () => {
  test("a soft matte edge snaps toward the guide's step", () => {
    const m = softMatte();
    const before = { dark: m[8 * W + 13], bright: m[8 * W + 18] };
    guidedFilterRefine(m, stepGuide(), W, H, 4, 1e-4);
    // On the guide's dark side coverage drops; on the bright side it rises.
    expect(m[8 * W + 13]).toBeLessThan(before.dark);
    expect(m[8 * W + 18]).toBeGreaterThan(before.bright);
  });

  test("solid regions stay solid", () => {
    const m = new Float32Array(W * H).fill(1);
    guidedFilterRefine(m, stepGuide(), W, H, 4, 1e-3);
    for (let i = 0; i < m.length; i++) expect(m[i]).toBeGreaterThan(0.95);
  });

  test("the RGBA wrapper writes gray coverage with full alpha", () => {
    const matte = new Uint8ClampedArray(W * H * 4);
    const framePx = new Uint8ClampedArray(W * H * 4);
    const g = stepGuide();
    const m = softMatte();
    for (let i = 0; i < W * H; i++) {
      const mv = Math.round(m[i] * 255);
      matte[i * 4] = mv;
      matte[i * 4 + 1] = mv;
      matte[i * 4 + 2] = mv;
      matte[i * 4 + 3] = 255;
      const gv = Math.round(g[i] * 255);
      framePx[i * 4] = gv;
      framePx[i * 4 + 1] = gv;
      framePx[i * 4 + 2] = gv;
      framePx[i * 4 + 3] = 255;
    }
    refineMatteAgainstFrame(matte, framePx, W, H, 4, 1e-4);
    for (let i = 0; i < W * H; i++) {
      expect(matte[i * 4]).toBe(matte[i * 4 + 1]);
      expect(matte[i * 4 + 1]).toBe(matte[i * 4 + 2]);
      expect(matte[i * 4 + 3]).toBe(255);
    }
  });
});
