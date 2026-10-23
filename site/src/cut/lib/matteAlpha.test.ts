import { describe, expect, test } from "bun:test";
import { MATTE_FPS } from "@donkeycut/effects-kit";
import { matteReadTime, matteStamp } from "./matteAlpha";

describe("matte frame lookup", () => {
  // A 30 fps cut puts every other frame on a 15 fps matte frame's edge, and
  // the preview and the export reach that time through different arithmetic.
  const edge = 4 / MATTE_FPS;

  test("a time on a matte frame's edge reads that frame from either side of float error", () => {
    expect(matteStamp("m", edge - 1e-9)).toBe(matteStamp("m", edge + 1e-9));
    expect(matteReadTime(edge - 1e-9, 10)).toBeCloseTo(4.5 / MATTE_FPS, 9);
    expect(matteReadTime(edge + 1e-9, 10)).toBeCloseTo(4.5 / MATTE_FPS, 9);
  });

  test("a time inside a matte frame reads that frame's middle", () => {
    expect(matteReadTime(4.4 / MATTE_FPS, 10)).toBeCloseTo(4.5 / MATTE_FPS, 9);
    expect(matteReadTime(0, 10)).toBeCloseTo(0.5 / MATTE_FPS, 9);
  });

  test("the last frame's read stays inside the matte", () => {
    expect(matteReadTime(0.299, 0.3)).toBeLessThan(0.3);
  });
});
